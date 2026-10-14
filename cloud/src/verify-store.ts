/**
 * 検証の集計(Issue #219)の D1・R2 の読み書き。**呼び出し元に依存しない**(コンストラクタは `{ db, bucket, now }` だけ。検証の DO〈`VerifyReportDO`〉が使う)。
 * R2 には `get` だけを使う(LIST・HEAD・put は使わない。型 {@link VerifyBucket} が `get` だけを許す)。
 *
 * ## 発走時刻の写し(`analyses.start_time`。migration 0009)
 * 先読み疑いの判定(`classifyLookaheadSuspicion`)は `raceSnapshot.race.startTime` を読むが、スナップショットは R2 の詳細にしか無い。集計のたびに 2,000 件超の R2 を読めないので、
 * 発走時刻だけを D1 に写す。**保存の経路は変えず、検証の DO が遅延で埋める**(NULL の行を拾って R2 の詳細から取り出す)。印:
 *  - NULL = 未確認 / '' = 詳細はあるが発走時刻が無い / '?' = 確認できなかった(詳細が無い・壊れている・別のレースのもの) / 'HH:MM' = 値。
 *  - 詳細が R2 に無い行は、**ここでは '?' にせず `missing` として返す**(最終判定は呼び出し側〈`VerifyCore`〉が、その行を**初めて見てからの経過時間**で行う)。保存は D1 が先・R2 が後
 *    (移行の `saveMigratedAnalysis`・`repairDetail` も同じ)なので、「D1 に行があり R2 にまだ無い」瞬間がある。分析日時では判定できない(移行した分析の分析日時は exe の古い日時で、書いた直後でも古い)。
 *  - get の例外は、その行を NULL のまま(`failed`)にする。一過性の障害で '?' にしない。
 *  - 壊れた詳細・別のレースの詳細は新しくても '?' にする(R2 の put は原子的で、待っても直らない)。
 * **R2 の Class B(読み出し)は、取得を試みた回数を 1 回の batch でまとめて数える**(保留・失敗の取得も R2 への要求)。柵の判定(`isReadAllowed`)は呼び出し側(`VerifyCore`)が `readUsage` で行う。
 *
 * ## 集計用の読み(`readAll`)
 * 7 文を **1 回の batch**(D1 の batch は 1 つのトランザクション=表をまたいだ一貫した読み取り)で読む。SQL は `verify-read.ts`。D1 が返す `meta.rows_read` を合計して返す(Free の 500 万行/日の実測用)。
 *
 * ## 透かし(`readWatermark`)
 * 再計算の要否の判定用。各表の `MAX(id)` / `MAX(rowid)` を 1 クエリで読む(各 1 行しか読まない)。既存の行の更新(`race_results` の UPSERT)では rowid が変わらず検知できない
 * (呼び出し側が TTL で拾う)。
 */

import { decodeDetail } from "./analysis-detail";
import { extractStartTime } from "../../packages/core/src/ev/lookahead-suspicion.js";
import { monthKey, type R2Usage } from "./r2-fence";
import { START_TIME_ABSENT, START_TIME_LOST, VERIFY_READ_SQL, type VerifyReadRows } from "./verify-read";

export type VerifyDb = Pick<D1Database, "prepare" | "batch">;
/** R2 のうち使う部分。**get だけ**。 */
export type VerifyBucket = Pick<R2Bucket, "get">;

/** R2 の get の同時実行数。 */
const GET_CONCURRENCY = 6;

export interface Watermark {
  readonly analyses: number | null;
  readonly results: number | null;
  readonly comboPayouts: number | null;
  readonly comboImports: number | null;
}

export interface PendingRow {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly detailKey: string | null;
}

export interface PendingPage {
  readonly rows: PendingRow[];
  /** カーソルより後で start_time が NULL の分析の総数(limit に依らない)。 */
  readonly total: number;
}

export interface StartTimeResolution {
  readonly id: number;
  /** 'HH:MM' / ''(詳細はあるが時刻なし)/ '?'(確認できなかった)。 */
  readonly value: string;
}

export interface ResolveOutcome {
  readonly resolved: StartTimeResolution[];
  /** R2 に詳細が無かった行の id(NULL のまま。'?' にするかどうかは呼び出し側が、初めて見てからの経過時間で決める)。 */
  readonly missing: number[];
  /** get が例外になった行の id(NULL のまま)。 */
  readonly failed: number[];
  /** R2 の get を試みた回数(Class B に数える)。 */
  readonly gets: number;
}

export interface ReadAllResult {
  readonly rows: VerifyReadRows;
  /** D1 が報告した読み取り行数の合計(`meta.rows_read`)。 */
  readonly rowsRead: number;
  readonly counts: Readonly<Record<keyof VerifyReadRows, number>>;
}

const WATERMARK_SQL =
  "SELECT (SELECT MAX(id) FROM analyses) AS analyses, (SELECT MAX(rowid) FROM race_results) AS results, (SELECT MAX(rowid) FROM race_combo_payouts) AS comboPayouts, (SELECT MAX(rowid) FROM race_combo_payout_imports) AS comboImports";

/** 総数は窓関数(`COUNT(*) OVER ()`)で同じクエリから得る(`LIMIT` の前に全該当行を数える)。 */
const PENDING_SQL = `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt, detail_key AS detailKey, COUNT(*) OVER () AS total
  FROM analyses WHERE id > ? AND start_time IS NULL ORDER BY id LIMIT ?`;

/** JSON 配列 `[[id, value], …]` で複数行を 1 文で更新する。確認済みの値は上書きしない(`start_time IS NULL`)。 */
const COMMIT_SQL = `UPDATE analyses SET start_time = j.t
  FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS t FROM json_each(?)) AS j
  WHERE analyses.id = j.id AND analyses.start_time IS NULL`;

const COUNT_READS_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 0, ?) ON CONFLICT(ym) DO UPDATE SET class_b = class_b + ?";
const SELECT_R2_USAGE_SQL = "SELECT class_a AS classA, class_b AS classB FROM r2_ops WHERE ym = ?";

/** {@link VERIFY_READ_SQL} の表の順(batch の結果の並びと一致する)。 */
const READ_ORDER = ["analyses", "horses", "allocationMeta", "bets", "results", "comboPayouts", "comboImports"] as const;

export interface D1VerifyStoreOptions {
  readonly db: VerifyDb;
  readonly bucket: VerifyBucket;
  /** 時計(保留の判定と R2 の月の区切りに使う)。既定は現在時刻。テストで注入する。 */
  readonly now?: () => Date;
}

export class D1VerifyStore {
  private readonly db: VerifyDb;
  private readonly bucket: VerifyBucket;
  private readonly now: () => Date;

  constructor(options: D1VerifyStoreOptions) {
    this.db = options.db;
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
  }

  async readWatermark(): Promise<Watermark> {
    const row = await this.db.prepare(WATERMARK_SQL).first<Watermark>();
    return { analyses: row?.analyses ?? null, results: row?.results ?? null, comboPayouts: row?.comboPayouts ?? null, comboImports: row?.comboImports ?? null };
  }

  async listPending(cursor: number, limit: number): Promise<PendingPage> {
    const { results } = await this.db.prepare(PENDING_SQL).bind(cursor, limit).all<PendingRow & { total: number }>();
    return {
      rows: results.map((r) => ({ id: r.id, raceId: r.raceId, analyzedAt: r.analyzedAt, detailKey: r.detailKey })),
      total: results[0]?.total ?? 0,
    };
  }

  /** 今月(UTC)の R2 の操作回数(行が無ければ 0)。 */
  async readUsage(): Promise<R2Usage> {
    const row = await this.db.prepare(SELECT_R2_USAGE_SQL).bind(monthKey(this.now())).first<R2Usage>();
    return row ?? { classA: 0, classB: 0 };
  }

  /** 行ごとに、R2 の詳細から発走時刻の印を決める(D1 には書かない。書くのは {@link commitStartTimes})。 */
  async resolveStartTimes(rows: readonly PendingRow[]): Promise<ResolveOutcome> {
    const resolved: Array<StartTimeResolution | null> = new Array<StartTimeResolution | null>(rows.length).fill(null);
    const missing: number[] = [];
    const failed: number[] = [];
    let gets = 0;
    const one = async (index: number): Promise<"resolved" | "missing" | "failed"> => {
      const row = rows[index]!;
      if (row.detailKey === null) {
        resolved[index] = { id: row.id, value: START_TIME_LOST };
        return "resolved";
      }
      gets += 1;
      let bytes: Uint8Array | null;
      try {
        const object = await this.bucket.get(row.detailKey);
        bytes = object === null ? null : new Uint8Array(await object.arrayBuffer());
      } catch {
        return "failed";
      }
      if (bytes === null) {
        return "missing";
      }
      const payload = decodeDetail(bytes);
      if (payload === null || payload.raceId !== row.raceId) {
        resolved[index] = { id: row.id, value: START_TIME_LOST };
        return "resolved";
      }
      resolved[index] = { id: row.id, value: extractStartTime(payload.raceSnapshot) ?? START_TIME_ABSENT };
      return "resolved";
    };
    for (let start = 0; start < rows.length; start += GET_CONCURRENCY) {
      const indexes = Array.from({ length: Math.min(GET_CONCURRENCY, rows.length - start) }, (_, k) => start + k);
      const outcomes = await Promise.all(indexes.map(one));
      outcomes.forEach((outcome, k) => {
        if (outcome === "missing") missing.push(rows[indexes[k]!]!.id);
        if (outcome === "failed") failed.push(rows[indexes[k]!]!.id);
      });
    }
    return { resolved: resolved.filter((r): r is StartTimeResolution => r !== null), missing, failed, gets };
  }

  /**
   * 決めた印を D1 に書き、R2 の Class B を取得の回数ぶん数える。**1 回の batch(最大 2 文)**。NULL の行だけを更新する。
   * 書く行も取得も無ければ D1 に何も発行しない。書いた行数(`meta.rows_written` の合計)を返す。
   */
  async commitStartTimes(resolved: readonly StartTimeResolution[], gets: number): Promise<number> {
    const statements: D1PreparedStatement[] = [];
    if (resolved.length > 0) {
      statements.push(this.db.prepare(COMMIT_SQL).bind(JSON.stringify(resolved.map((r) => [r.id, r.value]))));
    }
    if (gets > 0) {
      const ym = monthKey(this.now());
      statements.push(this.db.prepare(COUNT_READS_SQL).bind(ym, gets, gets));
    }
    if (statements.length === 0) {
      return 0;
    }
    const results = await this.db.batch(statements);
    return results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0);
  }

  async readAll(): Promise<ReadAllResult> {
    const results = await this.db.batch<Record<string, unknown>>(READ_ORDER.map((name) => this.db.prepare(VERIFY_READ_SQL[name])));
    const rowsOf = (i: number): never => (results[i]?.results ?? []) as never;
    const rows = Object.fromEntries(READ_ORDER.map((name, i) => [name, rowsOf(i)])) as unknown as VerifyReadRows;
    const counts = Object.fromEntries(READ_ORDER.map((name) => [name, rows[name].length])) as Record<keyof VerifyReadRows, number>;
    const rowsRead = results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0);
    return { rows, rowsRead, counts };
  }
}
