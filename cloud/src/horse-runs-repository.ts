/**
 * 各馬の戦績の D1 への保存・状態の読み出し(Issue #256 段階A。migration 0014 の表 `horse_runs`・`horse_run_saves`)。
 *
 * ## 1 回の保存(`saveRace`)の D1 への問い合わせ(Workers Free の 1 呼び出し 50 の内側。`batch` は使わず、文の数で数える)
 *  1. 保存済みの行の読み(`horse_id IN (…)`。{@link HORSE_READ_CHUNK} 頭ごと。通常 1 文。バインド変数は馬の数)。
 *  2. race_results の確認(新規行があるときだけ 1 文。`json_each` で 1 バインド。失敗は握って「引けなかった」にする=保存は続ける)。
 *  3. 行の書き込み(新規・上書きそれぞれ、あるときだけ。{@link RUNS_WRITE_CHUNK} 行ごと。`INSERT … SELECT … FROM json_each(?)`)。
 *     行の中身は JSON の配列 1 個をバインドする(1 行ずつバインドすると、D1 の 1 文あたり 100 変数の上限に 33 行ほどで当たるため)。
 *     新規は `ON CONFLICT DO NOTHING`(別の DO が先に書いていても壊れない)、上書きは `DO UPDATE`(行が持つ初見時刻を書く。通常の上書きは保存済みの値を持つので据え置き、
 *     結果ページ由来の行を置き換えるときだけ保存時刻。`source` も行の値で書く = 戦績 API の保存では NULL に戻る)。
 *  4. 集計の記録(`horse_run_saves` に 1 行)。
 * 重複だけの再送は 1・4 の 2 文で、行の書き込みは 0(D1 の `rows_written` を食わない)。
 *
 * 失敗は投げる。**呼び出し側(RaceDay の計算ステップ)が握って警告にする**(分析は止めない)。
 *
 * ## 出どころ(Issue #552〈#549-B1〉。migration 0032 の `source` 列)
 * NULL = 戦績 API、`'result'` = 過去の結果ページから変換した行。戦績 API を正とする。
 *  - 戦績 API の保存({@link D1HorseRunsStore.saveRace})は、保存済みの全行を `source` つきで読み、結果ページ由来の行を「置き換えた」として上書きする(`horse-runs.ts`)。
 *  - 結果ページ由来の行を書く関数({@link writeResultRuns}・{@link rewriteResultRuns}。後続の #549-B2・B3 が使う)は、戦績 API の行に触れない。
 *  - 診断の表(`table`)と `cells` は戦績 API 由来の行(`source IS NULL`)だけを数え、結果ページ由来の行は `resultRows` に別出しする。
 */

import type { HorseRunsPlan, HorseRunsStore, PlanInput, PlannedRun, SaveStats, StoredRun } from "./horse-runs";
import { SOURCE_RESULT, jstDay, planHorseRunsSave, summarizeSave } from "./horse-runs";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type HorseRunsDb = Pick<D1Database, "prepare">;

/** 保存済みの行を読むときの、1 文あたりの馬の数(1 馬 1 バインド変数。D1 の上限 100 の内側)。 */
export const HORSE_READ_CHUNK = 90;

/** 行の書き込みの、1 文あたりの行数(1 行 約 250〜350 バイトで、JSON 1 個のバインドが約 120KB。D1 の 1 値 2MB の内側)。 */
export const RUNS_WRITE_CHUNK = 500;

const READ_SQL_HEAD = "SELECT horse_id AS horseId, race_key AS raceKey, parser_version AS parserVersion, first_seen_at AS firstSeenAt, data, source FROM horse_runs WHERE horse_id IN ";

const WRITE_SQL_HEAD =
  "INSERT INTO horse_runs (horse_id, race_key, parser_version, first_seen_at, data, source) " +
  "SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]') " +
  "FROM json_each(?) WHERE true ON CONFLICT (horse_id, race_key) DO ";
/** 新規(戦績 API の行も、結果ページ由来の行も)。鍵が重なる行は書かない = 戦績 API の行に触れない。 */
const INSERT_SQL = `${WRITE_SQL_HEAD}NOTHING`;
/** 戦績 API の保存の上書き。初見時刻と source は行の値で書く(通常の上書きは保存済みの初見時刻・NULL なので変わらない。結果ページ由来の置き換えは保存時刻・NULL)。 */
const UPDATE_SQL = `${WRITE_SQL_HEAD}UPDATE SET parser_version = excluded.parser_version, data = excluded.data, first_seen_at = excluded.first_seen_at, source = excluded.source`;
/**
 * 結果ページ由来の行の書き直し: 結果ページ由来で、版が古い行だけ。戦績 API の行・同じ版以上の行・初見時刻・`source` は変えない。
 * 鍵が無い行は書かない(INSERT ではなく UPDATE ... FROM なので、新規の挿入にならない)。
 */
const REWRITE_RESULT_SQL =
  "UPDATE horse_runs SET parser_version = v.parser_version, data = v.data FROM (" +
  "SELECT json_extract(value, '$[0]') AS horse_id, json_extract(value, '$[1]') AS race_key, json_extract(value, '$[2]') AS parser_version, json_extract(value, '$[4]') AS data FROM json_each(?)" +
  `) AS v WHERE horse_runs.horse_id = v.horse_id AND horse_runs.race_key = v.race_key AND horse_runs.source = '${SOURCE_RESULT}' AND horse_runs.parser_version < v.parser_version`;

const IN_RESULTS_SQL = "SELECT DISTINCT race_id AS raceId FROM race_results WHERE race_id IN (SELECT value FROM json_each(?))";

const SAVE_LOG_SQL =
  "INSERT INTO horse_run_saves (saved_at, race_id, stats_json) VALUES (?, ?, ?) ON CONFLICT (saved_at, race_id) DO UPDATE SET stats_json = excluded.stats_json";

/** 書き込む行を、JSON の配列(各要素は `[馬 ID, 鍵, 版数, 初見時刻, タプルの JSON 文字列, 出どころ]`)にする。タプルは文字列のまま入れる(SQLite の JSON 整形で文字が変わらない)。 */
function encodeRows(rows: readonly PlannedRun[]): string {
  return JSON.stringify(rows.map((r) => [r.horseId, r.raceKey, r.parserVersion, r.firstSeenAt, r.data, r.source ?? null]));
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export class D1HorseRunsStore implements HorseRunsStore {
  private readonly db: HorseRunsDb;

  constructor(options: { readonly db: HorseRunsDb }) {
    this.db = options.db;
  }

  async saveRace(input: PlanInput): Promise<SaveStats> {
    if (input.horses.length === 0) {
      return summarizeSave(planHorseRunsSave(input, []), new Set(), 0);
    }
    const stored = await this.readStored(input.horses.map((h) => h.horseId));
    const plan = planHorseRunsSave(input, stored);
    const inResults = await this.readInResults(plan);
    const rowsWrittenRuns = (await writeRows(this.db, INSERT_SQL, plan.inserts)) + (await writeRows(this.db, UPDATE_SQL, plan.updates));
    const stats = summarizeSave(plan, inResults, rowsWrittenRuns);
    await this.db.prepare(SAVE_LOG_SQL).bind(stats.savedAt, stats.raceId, JSON.stringify(stats)).run();
    return stats;
  }

  private async readStored(horseIds: readonly string[]): Promise<StoredRun[]> {
    const out: StoredRun[] = [];
    for (const chunk of chunks([...new Set(horseIds)], HORSE_READ_CHUNK)) {
      const placeholders = `(${chunk.map(() => "?").join(", ")})`;
      const { results } = await this.db.prepare(`${READ_SQL_HEAD}${placeholders}`).bind(...chunk).all<StoredRun>();
      out.push(...results);
    }
    return out;
  }

  /** 新規行のレース ID のうち race_results にあるもの。引けなかったら null(保存は続ける)。新規行が無ければ引かない。 */
  private async readInResults(plan: HorseRunsPlan): Promise<ReadonlySet<string> | null> {
    if (plan.newKeys.length === 0) {
      return new Set();
    }
    try {
      const { results } = await this.db.prepare(IN_RESULTS_SQL).bind(JSON.stringify(plan.newKeys)).all<{ raceId: string }>();
      return new Set(results.map((r) => r.raceId));
    } catch {
      return null;
    }
  }
}

/** 行を書き、D1 が報告した rows_written の合計を返す。 */
async function writeRows(db: HorseRunsDb, sql: string, rows: readonly PlannedRun[]): Promise<number> {
  let written = 0;
  for (const chunk of chunks(rows, RUNS_WRITE_CHUNK)) {
    const result = await db.prepare(sql).bind(encodeRows(chunk)).run();
    written += result.meta.rows_written ?? 0;
  }
  return written;
}

// ---- 結果ページ由来の行(Issue #552〈#549-B1〉。後続の #549-B2・B3 が使う) ----

/**
 * 結果ページ由来の1行(書く側が渡す)。`source = 'result'` で書かれる。
 * `parserVersion` は**呼び出し側が渡す値をそのまま保存する**(意味は変換の側〈#549-B2〉が決める。この関数は意味を決めない)。
 * ただし戦績 API の保存は、保存済みの版が現行の `HORSE_RUN_PARSER_VERSION` より**新しい**行(結果ページ由来でも)には触れないので、
 * 現行より大きい値を渡すと、戦績 API の保存による置き換えを受けなくなる。版の付け方はこれを踏まえて決めること。
 */
export interface ResultRunRow {
  readonly horseId: string;
  readonly raceKey: string;
  readonly parserVersion: number;
  /** 初めて保存した時刻(エポックミリ秒)。戦績 API が置き換えるときに保存時刻へ更新される。 */
  readonly firstSeenAt: number;
  /** タプルの JSON 文字列(`encodeHorseRun` の出力)。 */
  readonly data: string;
}

function asResultRows(rows: readonly ResultRunRow[]): PlannedRun[] {
  return rows.map((r) => ({ ...r, source: SOURCE_RESULT }));
}

/**
 * 結果ページ由来の行を新規に書く(`ON CONFLICT DO NOTHING`)。鍵 (馬 ID, 鍵) が既にある行は書かない
 * = **戦績 API の行に触れない**(結果ページ由来の行どうしの重なりも書かない)。D1 の `rows_written` の合計を返す。
 * 500 行({@link RUNS_WRITE_CHUNK})ごとに 1 文。0 行なら文を発行しない。失敗は投げる。
 */
export async function writeResultRuns(db: HorseRunsDb, rows: readonly ResultRunRow[]): Promise<number> {
  return writeRows(db, INSERT_SQL, asResultRows(rows));
}

/**
 * 変換の版が上がったとき、結果ページ由来の行だけを書き直す(`source = 'result' AND parser_version < 渡した版`)。
 * 戦績 API の行・同じ版以上の結果ページ由来の行・鍵が無い行は書かない。`data` と `parser_version` だけを更新し、初見時刻と `source` は変えない。
 * D1 の `rows_written` の合計を返す。
 */
export async function rewriteResultRuns(db: HorseRunsDb, rows: readonly ResultRunRow[]): Promise<number> {
  return writeRows(db, REWRITE_RESULT_SQL, asResultRows(rows));
}

// ---- 状態の読み出し(管理者用の診断 `GET /api/horse-runs`。読み取りだけ) ----

/** 診断の対象期間(日数)の上限と既定。 */
export const STATUS_DAYS_MAX = 60;
export const STATUS_DAYS_DEFAULT = 14;

/** 保存の記録を読む件数の上限(1 日 36 レース × 60 日 = 2,160 の内側)。 */
const SAVES_LIMIT = 5000;

/** 数えるスカラー値の集計(`aggregateSaves` の出力)。 */
export interface SaveTotals {
  readonly saves: number;
  readonly horses: number;
  readonly horsesFirstSeen: number;
  readonly horsesZeroNew: number;
  readonly horsesNewAllInResults: number;
  readonly horsesNewSomeNotInResults: number;
  readonly rowsOffered: number;
  readonly rowsNew: number;
  readonly rowsDupSameDay: number;
  readonly rowsDupEarlier: number;
  readonly rowsFilled: number;
  readonly rowsChanged: number;
  readonly rowsReparsed: number;
  readonly rowsStoredNewer: number;
  readonly rowsNoKey: number;
  readonly rowsDupInInput: number;
  readonly rowsWrittenRuns: number;
  /** 結果ページ由来の行を戦績 API が置き換えた行数(Issue #552)。この項目が無い古い記録は 0 として足す。 */
  readonly rowsReplacedFromResult: number;
  readonly newByKind: { readonly central: number; readonly nar: number; readonly overseas: number };
  /** race_results を引けなかった保存の数(内訳の分母から外れる)。 */
  readonly savesWithoutResultsLookup: number;
  /**
   * 初見でない馬のうち、新規行がすべて取り込み済みのレースの割合(段階 D の判断材料)。分母は
   * 「新規あり(すべて取り込み済み + 一部未取り込み)」で、新規 0 行の馬と初見の馬は含まない。分母が 0 なら null。
   */
  readonly shareNewAllInResults: number | null;
  /** 初見でない馬のうち、新規 0 行の馬の割合(この取得が保存済みの行で足りていた分=段階 C で省ける)。分母は初見でない馬。0 なら null。 */
  readonly shareZeroNew: number | null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** 保存の記録を足し合わせる(純関数)。 */
export function aggregateSaves(list: readonly SaveStats[]): SaveTotals {
  const t = {
    saves: list.length,
    horses: 0,
    horsesFirstSeen: 0,
    horsesZeroNew: 0,
    horsesNewAllInResults: 0,
    horsesNewSomeNotInResults: 0,
    rowsOffered: 0,
    rowsNew: 0,
    rowsDupSameDay: 0,
    rowsDupEarlier: 0,
    rowsFilled: 0,
    rowsChanged: 0,
    rowsReparsed: 0,
    rowsStoredNewer: 0,
    rowsNoKey: 0,
    rowsDupInInput: 0,
    rowsWrittenRuns: 0,
    rowsReplacedFromResult: 0,
    newByKind: { central: 0, nar: 0, overseas: 0 },
    savesWithoutResultsLookup: 0,
  };
  for (const s of list) {
    t.horses += s.horses;
    t.horsesFirstSeen += s.horsesFirstSeen;
    t.horsesZeroNew += s.horsesZeroNew;
    t.horsesNewAllInResults += s.horsesNewAllInResults;
    t.horsesNewSomeNotInResults += s.horsesNewSomeNotInResults;
    t.rowsOffered += s.rowsOffered;
    t.rowsNew += s.rowsNew;
    t.rowsDupSameDay += s.rowsDupSameDay;
    t.rowsDupEarlier += s.rowsDupEarlier;
    t.rowsFilled += s.rowsFilled;
    t.rowsChanged += s.rowsChanged;
    t.rowsReparsed += s.rowsReparsed;
    t.rowsStoredNewer += s.rowsStoredNewer;
    t.rowsNoKey += s.rowsNoKey;
    t.rowsDupInInput += s.rowsDupInInput;
    t.rowsWrittenRuns += s.rowsWrittenRuns;
    t.rowsReplacedFromResult += s.rowsReplacedFromResult ?? 0;
    t.newByKind.central += s.newByKind.central;
    t.newByKind.nar += s.newByKind.nar;
    t.newByKind.overseas += s.newByKind.overseas;
    if (!s.inResultsKnown) {
      t.savesWithoutResultsLookup += 1;
    }
  }
  return {
    ...t,
    shareNewAllInResults: ratio(t.horsesNewAllInResults, t.horsesNewAllInResults + t.horsesNewSomeNotInResults),
    shareZeroNew: ratio(t.horsesZeroNew, t.horses - t.horsesFirstSeen),
  };
}

/** 結果ページ由来の行(`source = 'result'`)の件数など(Issue #552)。`table` と同じ見方だが、初見時刻は持たない。 */
export interface ResultRowsStatus {
  readonly rows: number;
  readonly horses: number;
  readonly byParserVersion: Readonly<Record<string, number>>;
  /** 走った日('YYYY/MM/DD')の最小・最大。 */
  readonly runDateMin: string | null;
  readonly runDateMax: string | null;
}

export interface HorseRunsStatus {
  /** **戦績 API 由来の行(`source IS NULL`)だけ**の集計(Issue #552。結果ページ由来の行は {@link HorseRunsStatus.resultRows})。 */
  readonly table: {
    readonly rows: number;
    readonly horses: number;
    /** 開催区分('中央'・'地方'・'海外'。タプルの区分)別の行数。 */
    readonly byKind: Readonly<Record<string, number>>;
    readonly byParserVersion: Readonly<Record<string, number>>;
    /** 走った日('YYYY/MM/DD')の最小・最大。 */
    readonly runDateMin: string | null;
    readonly runDateMax: string | null;
    /** 初めて保存した時刻(エポックミリ秒)の最小・最大。 */
    readonly firstSeenMin: number | null;
    readonly firstSeenMax: number | null;
  };
  readonly saves: {
    readonly sinceMs: number;
    readonly days: number;
    /** 読めなかった(JSON として壊れている)記録の数。 */
    readonly unreadable: number;
    /** 期間内のすべての保存。 */
    readonly all: SaveTotals;
    /**
     * 開催日より前に保存したものだけ(事前の取得)。**段階 D・E の判断はこちらで行う**: 開催日以降に手動で再分析すると、戦績にそのレース自身が入るため。
     * 判定は `JST の保存日 < 開催日`。
     */
    readonly beforeRaceDay: SaveTotals;
    /** 保存した JST 日ごと(昇順)。 */
    readonly daily: ReadonlyArray<{ readonly day: string; readonly saves: number; readonly horses: number; readonly horsesFirstSeen: number; readonly rowsNew: number; readonly rowsWrittenRuns: number }>;
  };
  /** 結果ページ由来の行(`source = 'result'`)の件数(Issue #552)。`table`・`cells` には入らない。結果ページ由来の行が無ければ 0 件。 */
  readonly resultRows: ResultRowsStatus;
  /** `cells=1` のときだけ。戦績 API 由来の中央の走を、騎手 × 競馬場 × 芝ダ × 距離帯(200m)のセルに分けた走数の分布(段階 E の判断材料)。 */
  readonly cells?: { readonly cells: number; readonly runs: number; readonly n10: number; readonly n30: number; readonly n100: number };
  /** 段階Aの限界(診断の読み手に伝える固定文)。 */
  readonly note: string;
}

export const STATUS_NOTE =
  "段階A: 保存は事前分析(morning)の計算ステップだけ。手動の発走前だけの分析(事前分析を経ない)の戦績は貯まらない。読み出し・集計は段階Aに無い(この診断だけ)。" +
  "table・cells・saves は戦績 API 由来の行だけの集計で、過去の結果ページから変換した行(source = 'result')は含まない。その件数は resultRows に別に出す。";

export interface StatusOptions {
  /** 保存の記録を読む期間の始点(エポックミリ秒)。 */
  readonly sinceMs: number;
  readonly days: number;
  /** true のときだけ、セルの分布を数える(horse_runs の全件走査)。 */
  readonly cells: boolean;
}

/** 状態を読む(読み取りだけ。失敗は投げる)。 */
export async function readHorseRunsStatus(db: HorseRunsDb, options: StatusOptions): Promise<HorseRunsStatus> {
  // 全件走査は 2 本のまま(出どころごとに GROUP BY して、1 回の走査で戦績 API 由来と結果ページ由来を分ける)。出どころが NULL・'result' 以外の行は、どちらにも数えない。
  const totals = await db
    .prepare(
      "SELECT source, COUNT(*) AS rows, COUNT(DISTINCT horse_id) AS horses, MIN(first_seen_at) AS firstSeenMin, MAX(first_seen_at) AS firstSeenMax, " +
        "MIN(json_extract(data, '$[0]')) AS runDateMin, MAX(json_extract(data, '$[0]')) AS runDateMax FROM horse_runs GROUP BY source",
    )
    .all<{ source: string | null; rows: number; horses: number; firstSeenMin: number | null; firstSeenMax: number | null; runDateMin: string | null; runDateMax: string | null }>();
  const groups = await db
    .prepare("SELECT source, parser_version AS version, json_extract(data, '$[6]') AS kind, COUNT(*) AS n FROM horse_runs GROUP BY source, parser_version, json_extract(data, '$[6]')")
    .all<{ source: string | null; version: number; kind: string | null; n: number }>();
  const total = totals.results.find((r) => r.source === null);
  const resultTotal = totals.results.find((r) => r.source === SOURCE_RESULT);
  const byKind: Record<string, number> = {};
  const byParserVersion: Record<string, number> = {};
  const resultByParserVersion: Record<string, number> = {};
  for (const g of groups.results) {
    if (g.source === SOURCE_RESULT) {
      resultByParserVersion[String(g.version)] = (resultByParserVersion[String(g.version)] ?? 0) + g.n;
    } else if (g.source === null) {
      const kind = g.kind ?? "不明";
      byKind[kind] = (byKind[kind] ?? 0) + g.n;
      byParserVersion[String(g.version)] = (byParserVersion[String(g.version)] ?? 0) + g.n;
    }
  }
  const savedRows = await db
    .prepare("SELECT stats_json AS statsJson FROM horse_run_saves WHERE saved_at >= ? ORDER BY saved_at LIMIT ?")
    .bind(options.sinceMs, SAVES_LIMIT)
    .all<{ statsJson: string }>();
  const list: SaveStats[] = [];
  let unreadable = 0;
  for (const row of savedRows.results) {
    try {
      const parsed = JSON.parse(row.statsJson) as SaveStats;
      if (parsed === null || typeof parsed !== "object" || parsed.v !== 1) {
        unreadable += 1;
      } else {
        list.push(parsed);
      }
    } catch {
      unreadable += 1;
    }
  }
  const before = list.filter((s) => jstDay(s.savedAt) < s.kaisaiDate);
  const dailyMap = new Map<string, { saves: number; horses: number; horsesFirstSeen: number; rowsNew: number; rowsWrittenRuns: number }>();
  for (const s of list) {
    const day = jstDay(s.savedAt);
    const d = dailyMap.get(day) ?? { saves: 0, horses: 0, horsesFirstSeen: 0, rowsNew: 0, rowsWrittenRuns: 0 };
    d.saves += 1;
    d.horses += s.horses;
    d.horsesFirstSeen += s.horsesFirstSeen;
    d.rowsNew += s.rowsNew;
    d.rowsWrittenRuns += s.rowsWrittenRuns;
    dailyMap.set(day, d);
  }
  const status: HorseRunsStatus = {
    table: {
      rows: total?.rows ?? 0,
      horses: total?.horses ?? 0,
      byKind,
      byParserVersion,
      runDateMin: total?.runDateMin ?? null,
      runDateMax: total?.runDateMax ?? null,
      firstSeenMin: total?.firstSeenMin ?? null,
      firstSeenMax: total?.firstSeenMax ?? null,
    },
    saves: {
      sinceMs: options.sinceMs,
      days: options.days,
      unreadable,
      all: aggregateSaves(list),
      beforeRaceDay: aggregateSaves(before),
      daily: [...dailyMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, d]) => ({ day, ...d })),
    },
    resultRows: {
      rows: resultTotal?.rows ?? 0,
      horses: resultTotal?.horses ?? 0,
      byParserVersion: resultByParserVersion,
      runDateMin: resultTotal?.runDateMin ?? null,
      runDateMax: resultTotal?.runDateMax ?? null,
    },
    note: STATUS_NOTE,
  };
  if (!options.cells) {
    return status;
  }
  const cells = await db
    .prepare(
      "SELECT COUNT(*) AS cells, COALESCE(SUM(n), 0) AS runs, COALESCE(SUM(n >= 10), 0) AS n10, COALESCE(SUM(n >= 30), 0) AS n30, COALESCE(SUM(n >= 100), 0) AS n100 FROM (" +
        "SELECT COUNT(*) AS n FROM horse_runs WHERE source IS NULL AND json_extract(data, '$[6]') = '中央' AND json_extract(data, '$[14]') IS NOT NULL " +
        "AND json_extract(data, '$[1]') IS NOT NULL AND json_extract(data, '$[16]') IS NOT NULL AND json_extract(data, '$[17]') IS NOT NULL " +
        "GROUP BY json_extract(data, '$[1][1]'), json_extract(data, '$[16]'), CAST(json_extract(data, '$[17]') AS INTEGER) / 200, json_extract(data, '$[14]'))",
    )
    .first<{ cells: number; runs: number; n10: number; n30: number; n100: number }>();
  return { ...status, cells: { cells: cells?.cells ?? 0, runs: cells?.runs ?? 0, n10: cells?.n10 ?? 0, n30: cells?.n30 ?? 0, n100: cells?.n100 ?? 0 } };
}
