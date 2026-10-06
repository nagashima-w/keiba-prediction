/**
 * クラウド版の分析履歴ストア(Issue #175・#172-b。親は #169)。**要約は D1、大きな列は R2**(方式 A。#169 の合意)。
 *
 * 呼び出し元に依存しない: コンストラクタは `{ db, bucket }` だけを受け取る(Worker からでも Durable Object からでも使える。
 * #164 が保存を呼ぶ場所は、重い配分を行う DO の想定)。R2 には `get` と `put` しか使わない(**LIST・HEAD は使わない**。Class A の操作を増やさない。
 * 型 {@link AnalysisBucket} が `get`・`put` だけを許す)。
 *
 * ## 書き込み(saveAnalysis)
 * 1. 詳細(大きな列 3 つ)を JSON → gzip(level 1)にする(**D1 に書く前**。JSON にできない値はここで例外になり、何も書かれない)
 * 2. D1 に **1 回の `batch`** で書く(配分ありなら 5 文、配分なしなら 3 文。馬・買い目の数によらず一定):
 *    ① analyses の INSERT(core の codec の文と束縛値。大きな列は NULL) ② `detail_key` の UPDATE ③ 馬(`json_each`) ④ 配分メタ ⑤ 買い目(`json_each`)
 *    子の行は `(SELECT max(id) FROM analyses)` で、①で採番された id に紐づける。
 * 3. R2 に `analyses/{id}.json.gz` を put(**D1 が先、R2 が後**)。失敗したら最大 2 回まで同じキーに再試行する(冪等)。
 *    それでも失敗したら `detail_key` を NULL に戻し、**throw せず** `detail: "failed"` を返す(要約は残る)。
 *
 * ### `(SELECT max(id) FROM analyses)` に依存してよい理由(事実と推論を分ける)
 * - **確認済みの事実**(ローカルの workerd。`test/analysis-repository.test.ts` の AC-b3b): 20 件の保存を `Promise.all` で同時に走らせても、
 *   子の行の取り違えは 0 件。対照として、同じ文を batch を使わず 1 文ずつ並行に実行すると、失敗か取り違えが起きる(検査が空振りでない)。
 * - **推論**(公式ドキュメントでの確認は未了。本番の D1 では未検証): D1 の batch は 1 つのトランザクションで、SQLite は書き込みトランザクションを
 *   直列に処理するので、batch の途中に他の保存は割り込めない。この推論が本番で崩れたら、保存ごとの一意のトークンで子の行を引く設計
 *   (`detail_key` の索引が要る。migration 0003)へ切り替える。**最初の本番の実保存で確かめる。**
 *
 * ## 読み出し
 * - `getAnalysisDetail`: D1(2 文の batch)+ R2 の get 1 回。R2 に無い・壊れている・別のレースのものなら `detail: "missing"`(クラッシュしない)。
 *   `detail_key` が NULL なら `detail: "none"`(R2 に触れない)。**大きな列が null なのは「詳細が無い」のであって「LLM 未使用」とは限らない**
 *   (戻り値の `detail` で区別する)。
 * - `listAnalysisSummaries`: D1 だけ。**2 文の batch**(分析・馬)で、N+1 にしない。大きな列は読まない。新しい順(id の降順)に limit 件(既定 50・上限 200)。
 *   Free の D1 は読み取り 500 万行/日なので、**全件読みの口は作らない**。
 *
 * ## 既知の差分(exe の SQLite との違い。【記録】。`test/analysis-repository.test.ts` が固定している)
 * - Infinity・NaN は NULL、-0 は 0 になる(D1 の bind も同じ)。NOT NULL の列(prior など)に NaN を渡すと、制約違反で保存全体が失敗する。
 * - 孤立サロゲートは元に戻らない(U+FFFD に置き換わる)。
 */

import {
  allocationBetParams,
  allocationMetaParams,
  analysisParams,
  horseParams,
  INSERT_ALLOCATION_BET_SQL,
  INSERT_ALLOCATION_META_SQL,
  INSERT_ANALYSIS_HORSE_SQL,
  INSERT_ANALYSIS_SQL,
  SELECT_ALLOCATION_BETS_SQL,
  SELECT_ALLOCATION_META_SQL,
  SELECT_ANALYSIS_HORSES_SQL,
  toStoredAllocation,
  toStoredAnalysis,
  type AllocationMetaRow,
  type AnalysisRow,
  type HorseRow,
} from "../../packages/core/src/ev/analysis-store-codec.js";
import type {
  AnalysisRecord,
  StoredAllocation,
  StoredAllocationBetDetail,
  StoredAnalysis,
  StoredAnalysisHorse,
} from "../../packages/core/src/ev/analysis-store-types.js";
import { contributionsOf, decodeDetail, DETAIL_KEY_SQL, detailKeyOf, encodeDetail } from "./analysis-detail";

/** D1 のうち、ストアが使う部分だけ(テストで記録つきの転送・偽物を渡せる)。 */
export type AnalysisDb = Pick<D1Database, "prepare" | "batch">;
/** R2 のうち、ストアが使う部分だけ。**get と put だけ**(LIST・HEAD・delete は型で使えない)。 */
export type AnalysisBucket = Pick<R2Bucket, "get" | "put">;

/** 一覧の limit の既定と上限(Free の D1 の読み取り 500 万行/日を、一覧の1回で食い潰さないため)。 */
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
/** R2 の put の再試行の回数(初回に加えて)。 */
export const DETAIL_PUT_RETRIES = 2;

export interface SaveResult {
  readonly id: number;
  /** `stored`: R2 に詳細を書いた。`failed`: R2 への書き込みに失敗した(要約だけが残り、`detail_key` は NULL)。#173 で `skipped` を足す。 */
  readonly detail: "stored" | "failed";
}

export type DetailStatus = "present" | "missing" | "none";

export interface AnalysisDetailResult {
  /** 大きな列(rawResponse・raceSnapshot・馬の contributions)は、`detail` が `present` のときだけ入る(それ以外は null)。 */
  readonly analysis: StoredAnalysis;
  readonly detail: DetailStatus;
}

export type AnalysisSummaryHorse = Omit<StoredAnalysisHorse, "contributions">;

/** 一覧の1件。`StoredAnalysis` から大きな列(rawResponse・raceSnapshot・馬の contributions)を除いたもの + R2 に詳細があるか。 */
export interface AnalysisSummary extends Omit<StoredAnalysis, "horses" | "rawResponse" | "raceSnapshot"> {
  readonly horses: readonly AnalysisSummaryHorse[];
  /** `detail_key` が NULL でない(R2 に詳細があるはず)。実在の確認は R2 に触れないので、していない。 */
  readonly hasDetail: boolean;
}

export interface AnalysisListFilter {
  readonly raceId?: string;
  /** 開催日(YYYYMMDD。保存時の `kaisaiDate` と同じ形)。 */
  readonly kaisaiDate?: string;
  /** 件数。既定 {@link LIST_DEFAULT_LIMIT}・1〜{@link LIST_MAX_LIMIT} の整数(範囲外は RangeError)。 */
  readonly limit?: number;
}

export interface AnalysisRepository {
  saveAnalysis(record: AnalysisRecord): Promise<SaveResult>;
  listAnalysisSummaries(filter?: AnalysisListFilter): Promise<AnalysisSummary[]>;
  getAnalysisDetail(analysisId: number): Promise<AnalysisDetailResult | undefined>;
  getStoredAllocation(analysisId: number): Promise<StoredAllocation | undefined>;
  listAnalyzedRaceIdsByPromptVersion(version: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// SQL(core の codec の文から導く。列の並びを重複して持たない)
// ---------------------------------------------------------------------------

/** 直前の INSERT(① analyses)で採番された id。batch は 1 つのトランザクションなので、途中に他の保存は割り込まない(上の説明)。 */
const NEW_ID = "(SELECT max(id) FROM analyses)";

/**
 * codec の `INSERT INTO t (analysis_id, a, b, …) VALUES (?, …)` から、`json_each` で複数行を 1 文で入れる文を導く
 * (analysis_id は {@link NEW_ID}、残りの列は JSON の配列の要素 `$[0]`・`$[1]`…)。列の並びは codec のものをそのまま使う。
 * 束縛値は 1 つ(行の配列の JSON 文字列)。
 */
export function jsonEachInsertSql(codecInsertSql: string): string {
  const m = /^\s*INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES/.exec(codecInsertSql);
  const columns = m?.[2]?.split(",").map((c) => c.trim());
  if (m === null || columns === undefined || columns[0] !== "analysis_id") {
    throw new Error("codec の INSERT 文の形が想定と違います(先頭の列が analysis_id でない)");
  }
  const picks = columns.slice(1).map((_, i) => `json_extract(value,'$[${i}]')`);
  return `INSERT INTO ${m[1]} (${columns.join(", ")}) SELECT ${NEW_ID}, ${picks.join(", ")} FROM json_each(?)`;
}

/** codec の INSERT 文(1 行用)の先頭の `?`(analysis_id)を {@link NEW_ID} に置き換える(残りの束縛値の並びは変わらない)。 */
export function withNewIdSql(codecInsertSql: string): string {
  const replaced = codecInsertSql.replace(/VALUES\s*\(\s*\?/, `VALUES (${NEW_ID}`);
  if (replaced === codecInsertSql) {
    throw new Error("codec の INSERT 文の形が想定と違います(VALUES の先頭の ? が無い)");
  }
  return replaced;
}

const INSERT_HORSES_SQL = jsonEachInsertSql(INSERT_ANALYSIS_HORSE_SQL);
const INSERT_BETS_SQL = jsonEachInsertSql(INSERT_ALLOCATION_BET_SQL);
const INSERT_META_SQL = withNewIdSql(INSERT_ALLOCATION_META_SQL);
const UPDATE_DETAIL_KEY_SQL = `UPDATE analyses SET detail_key = ${DETAIL_KEY_SQL} WHERE id = ${NEW_ID}`;
const CLEAR_DETAIL_KEY_SQL = "UPDATE analyses SET detail_key = NULL WHERE id = ?";

/** 要約の列(大きな列は読まず、NULL で埋めて `AnalysisRow` の形にする)。 */
const SUMMARY_COLUMNS = `id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated,
       prompt_version AS promptVersion, additional_instruction AS additionalInstruction,
       kaisai_date AS kaisaiDate, model, NULL AS rawResponse, NULL AS raceSnapshotJson,
       history_cutoff_date AS historyCutoffDate, prompt_lookahead_guarded AS promptLookaheadGuarded,
       detail_key IS NOT NULL AS hasDetail`;

const SELECT_ONE_SQL = `SELECT ${SUMMARY_COLUMNS}, detail_key AS detailKey FROM analyses WHERE id = ?`;

const SELECT_RACE_IDS_BY_VERSION_SQL = `SELECT DISTINCT race_id AS raceId
           FROM analyses
           WHERE prompt_version = ?
           ORDER BY race_id`;

/** 一覧の絞り込み(固定の断片だけを連結する。利用者の入力は SQL に入れず、すべて bind する)。 */
function listStatements(db: AnalysisDb, filter: AnalysisListFilter, limit: number): D1PreparedStatement[] {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filter.raceId !== undefined) {
    conditions.push("race_id = ?");
    binds.push(filter.raceId);
  }
  if (filter.kaisaiDate !== undefined) {
    conditions.push("kaisai_date = ?");
    binds.push(filter.kaisaiDate);
  }
  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  const analysesSql = `SELECT ${SUMMARY_COLUMNS} FROM analyses${where} ORDER BY id DESC LIMIT ?`;
  const horsesSql = `SELECT analysis_id AS analysisId, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive,
       NULL AS contributions_json, mark, reason
  FROM analysis_horses
  WHERE analysis_id IN (SELECT id FROM analyses${where} ORDER BY id DESC LIMIT ?)
  ORDER BY analysis_id DESC, umaban`;
  return [db.prepare(analysesSql).bind(...binds, limit), db.prepare(horsesSql).bind(...binds, limit)];
}

/**
 * 1 件の分析を書く D1 の文(1 回の batch に渡す)。配分ありなら 5 文、なしなら 3 文(馬・買い目の数によらず一定)。
 * 大きな列(raw_response・race_snapshot_json・馬の contributions_json)は NULL で書く(R2 へ)。
 * テストが「batch を使わず逐次実行したときの対照」にも使うため export している。
 */
export function buildSaveStatements(db: AnalysisDb, rec: AnalysisRecord): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db.prepare(INSERT_ANALYSIS_SQL).bind(...analysisParams({ ...rec, rawResponse: null, raceSnapshot: null })),
    db.prepare(UPDATE_DETAIL_KEY_SQL),
    // 馬: 1 文・bind 1 個(JSON の配列)。analysis_id(先頭)を除いた束縛値の並びは codec のもの。contributions は R2 なので null。
    db.prepare(INSERT_HORSES_SQL).bind(JSON.stringify(rec.horses.map((h) => horseParams(0, { ...h, contributions: null }).slice(1)))),
  ];
  if (rec.allocation !== undefined) {
    statements.push(db.prepare(INSERT_META_SQL).bind(...allocationMetaParams(0, rec.allocation.meta).slice(1)));
    statements.push(db.prepare(INSERT_BETS_SQL).bind(JSON.stringify(rec.allocation.bets.map((b) => allocationBetParams(0, b).slice(1)))));
  }
  return statements;
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return LIST_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
    throw new RangeError(`limit は 1〜${LIST_MAX_LIMIT} の整数でなければなりません`);
  }
  return limit;
}

// ---------------------------------------------------------------------------
// ストア
// ---------------------------------------------------------------------------

export interface D1AnalysisStoreOptions {
  readonly db: AnalysisDb;
  readonly bucket: AnalysisBucket;
}

export class D1AnalysisStore implements AnalysisRepository {
  private readonly db: AnalysisDb;
  private readonly bucket: AnalysisBucket;

  constructor(options: D1AnalysisStoreOptions) {
    this.db = options.db;
    this.bucket = options.bucket;
  }

  async saveAnalysis(record: AnalysisRecord): Promise<SaveResult> {
    // D1 に書く前に、詳細を符号化する(JSON にできない値はここで例外になり、何も書かれない)。
    const body = encodeDetail(record);
    const results = await this.db.batch(buildSaveStatements(this.db, record));
    const id = results[0]?.meta.last_row_id;
    if (typeof id !== "number" || !(id > 0)) {
      throw new Error("analyses の採番 id を取得できませんでした");
    }
    const key = detailKeyOf(id);
    for (let attempt = 0; attempt <= DETAIL_PUT_RETRIES; attempt += 1) {
      try {
        await this.bucket.put(key, body, { httpMetadata: { contentType: "application/gzip" } });
        return { id, detail: "stored" };
      } catch {
        // 同じキー・同じ本文で再試行する(冪等)。
      }
    }
    try {
      await this.db.prepare(CLEAR_DETAIL_KEY_SQL).bind(id).run();
    } catch {
      // detail_key が残っても、読み出し側は R2 に無いオブジェクトを「詳細なし」として扱う。保存は失敗にしない。
    }
    return { id, detail: "failed" };
  }

  async listAnalysisSummaries(filter: AnalysisListFilter = {}): Promise<AnalysisSummary[]> {
    const limit = validateLimit(filter.limit);
    const [analyses, horses] = await this.db.batch<unknown>(listStatements(this.db, filter, limit));
    const horsesByAnalysis = new Map<number, HorseRow[]>();
    for (const row of (horses?.results ?? []) as Array<HorseRow & { analysisId: number }>) {
      const list = horsesByAnalysis.get(row.analysisId);
      if (list === undefined) {
        horsesByAnalysis.set(row.analysisId, [row]);
      } else {
        list.push(row);
      }
    }
    return ((analyses?.results ?? []) as Array<AnalysisRow & { hasDetail: number }>).map((row) => {
      const { rawResponse: _raw, raceSnapshot: _snapshot, horses: stored, ...rest } = toStoredAnalysis(row, horsesByAnalysis.get(row.id) ?? []);
      return { ...rest, horses: stored.map(({ contributions: _c, ...horse }) => horse), hasDetail: row.hasDetail === 1 };
    });
  }

  async getAnalysisDetail(analysisId: number): Promise<AnalysisDetailResult | undefined> {
    const [analyses, horses] = await this.db.batch<unknown>([
      this.db.prepare(SELECT_ONE_SQL).bind(analysisId),
      this.db.prepare(SELECT_ANALYSIS_HORSES_SQL).bind(analysisId),
    ]);
    const row = analyses?.results[0] as (AnalysisRow & { detailKey: string | null }) | undefined;
    if (row === undefined) {
      return undefined;
    }
    const horseRows = (horses?.results ?? []) as HorseRow[];
    if (row.detailKey === null) {
      return { analysis: toStoredAnalysis(row, horseRows), detail: "none" };
    }
    const payload = await this.readDetail(row.detailKey, row.raceId);
    if (payload === null) {
      return { analysis: toStoredAnalysis(row, horseRows), detail: "missing" };
    }
    const merged: AnalysisRow = {
      ...row,
      rawResponse: payload.rawResponse,
      raceSnapshotJson: payload.raceSnapshot === null ? null : JSON.stringify(payload.raceSnapshot),
    };
    const mergedHorses = horseRows.map((h): HorseRow => {
      const c = contributionsOf(payload, h.umaban);
      return { ...h, contributions_json: c === null ? null : JSON.stringify(c) };
    });
    return { analysis: toStoredAnalysis(merged, mergedHorses), detail: "present" };
  }

  /** R2 から詳細を読む。無い・壊れている・別のレースのもの・get の失敗は、すべて null(例外を投げない)。 */
  private async readDetail(key: string, expectedRaceId: string) {
    try {
      const object = await this.bucket.get(key);
      if (object === null) {
        return null;
      }
      const payload = decodeDetail(new Uint8Array(await object.arrayBuffer()));
      return payload !== null && payload.raceId === expectedRaceId ? payload : null;
    } catch {
      return null;
    }
  }

  async getStoredAllocation(analysisId: number): Promise<StoredAllocation | undefined> {
    const [meta, bets] = await this.db.batch<unknown>([
      this.db.prepare(SELECT_ALLOCATION_META_SQL).bind(analysisId),
      this.db.prepare(SELECT_ALLOCATION_BETS_SQL).bind(analysisId),
    ]);
    const metaRow = meta?.results[0] as AllocationMetaRow | undefined;
    if (metaRow === undefined) {
      return undefined;
    }
    return toStoredAllocation(metaRow, (bets?.results ?? []) as StoredAllocationBetDetail[]);
  }

  async listAnalyzedRaceIdsByPromptVersion(version: string): Promise<string[]> {
    const { results } = await this.db.prepare(SELECT_RACE_IDS_BY_VERSION_SQL).bind(version).all<{ raceId: string }>();
    return results.map((r) => r.raceId);
  }
}
