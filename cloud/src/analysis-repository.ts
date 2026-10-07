/**
 * クラウド版の分析履歴ストア(Issue #175・#172-b。親は #169)。**要約は D1、大きな列は R2**(方式 A。#169 の合意)。
 *
 * 呼び出し元に依存しない: コンストラクタは `{ db, bucket }` だけを受け取る(Worker からでも Durable Object からでも使える。
 * #164 が保存を呼ぶ場所は、重い配分を行う DO の想定)。R2 には `get` と `put` しか使わない(**LIST・HEAD は使わない**。Class A の操作を増やさない。
 * 型 {@link AnalysisBucket} が `get`・`put` だけを許す)。
 *
 * ## 書き込み(saveAnalysis)
 * 1. 詳細(大きな列 3 つ)を JSON → gzip(level 1)にする(**D1 に書く前**。JSON にできない値はここで例外になり、何も書かれない)
 * 2. **R2 の操作回数の柵を確かめる**(Issue #173): 今月の回数を D1 の `r2_ops` から 1 回読む。Class A(PUT)が柵(無料枠の 10%)に達していたら、
 *    R2 に書かず、D1 に**要約だけ**を保存して `detail: "skipped"` を返す(PUT 0 回・カウンタは増やさない・`detail_key` は NULL)。
 * 3. D1 に **1 回の `batch`** で書く(配分ありなら 6 文、配分なしなら 4 文。馬・買い目の数によらず一定):
 *    ⓪ `r2_ops` の Class A を +1(**最初の文**。batch が失敗したらカウンタも増えない) ① analyses の INSERT(core の codec の文と束縛値。大きな列は NULL)
 *    ② `detail_key` の UPDATE ③ 馬(`json_each`) ④ 配分メタ ⑤ 買い目(`json_each`)
 *    子の行は `(SELECT max(id) FROM analyses)` で、①で採番された id に紐づける。柵でスキップするときは ⓪② を除く(配分ありで 4 文・なしで 2 文)。
 * 4. R2 に `analyses/{id}.json.gz` を put(**D1 が先、R2 が後**)。失敗したら最大 2 回まで同じキーに再試行する(冪等)。
 *    それでも失敗したら `detail_key` を NULL に戻し、**throw せず** `detail: "failed"` を返す(要約は残る)。
 *    カウンタは batch と一緒にコミット済みなので +1 のまま(再試行は数えない。1 回の保存を 1 回と数える)。
 *
 * 5. **理由(`llmNote`。Issue #194)・LLM 呼び出しの記録(`llmCalls`。Issue #197 段2)**: どちらかがあるときだけ、`llm_note`・`llm_calls_json` の UPDATE を**1文**足す(配分ありで 7 文・なしで 5 文。どちらも無ければ上のとおり)。core の codec の INSERT は変えない。
 *
 * ### 柵の限界
 * - 回数の確認(②)と +1(③)は別の呼び出しなので、同時に保存が走ると、柵を同時実行数ぶんだけ超えうる(柵は無料枠の 10% で、100 倍以上の余裕がある)。
 * - PUT の再試行を数えないので、最大 3 倍の過少申告になりうる(それでも柵の 3 倍 = 無料枠の 30%)。
 * - 月は UTC の yyyymm(`r2-fence.ts` の `monthKey`)。時計は `now` で注入できる。
 *
 * ### `(SELECT max(id) FROM analyses)` に依存してよい理由(事実と推論を分ける)
 * - **確認済みの事実**(ローカルの workerd。`test/analysis-repository.test.ts` の AC-b3b): 20 件の保存を `Promise.all` で同時に走らせても、
 *   子の行の取り違えは 0 件。対照として、同じ文を batch を使わず 1 文ずつ並行に実行すると、失敗か取り違えが起きる(検査が空振りでない)。
 * - **推論**(公式ドキュメントでの確認は未了。本番の D1 では未検証): D1 の batch は 1 つのトランザクションで、SQLite は書き込みトランザクションを
 *   直列に処理するので、batch の途中に他の保存は割り込めない。この推論が本番で崩れたら、保存ごとの一意のトークンで子の行を引く設計
 *   (`detail_key` の索引が要る。次の空き番号の migration〈0004 以降〉)へ切り替える。**最初の本番の実保存で確かめる。**
 *
 * ## 読み出し
 * - `getAnalysisDetail`: D1(3 文の batch。分析・馬・今月の R2 の回数)+ R2 の get 1 回。R2 に無い・壊れている・別のレースのものなら `detail: "missing"`(クラッシュしない)。
 *   `detail_key` が NULL なら `detail: "none"`(R2 に触れない)。**大きな列が null なのは「詳細が無い」のであって「LLM 未使用」とは限らない**
 *   (戻り値の `detail` で区別する)。**Class B(GET)が柵に達していたら、R2 を引かず `missing`**(詳細の表示だけを拒否する。要約は出す)。
 *   読み出しの試行は Class B に +1 する(**best-effort**: 失敗しても読み出しを妨げない。R2 への要求が発生した試行は、get が失敗しても数える)。
 * - `listAnalysisSummaries`: D1 だけ。**2 文の batch**(分析・馬)で、N+1 にしない。大きな列は読まない。新しい順(id の降順)に limit 件(既定 50・上限 200)。
 *   Free の D1 は読み取り 500 万行/日なので、**全件読みの口は作らない**。
 * - `getR2Usage`: 今月の Class A・B の回数と、柵の上限・許可の状態(画面〈#165〉と通知〈#166〉への接続は、それぞれの Issue)。
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
import type { AnalysisSaveExtra, RecentAnalysis } from "./analysis-save-extra";
import { parseLlmCalls, serializeLlmCalls, type LlmCallRecord } from "./llm-calls";
export type { AnalysisSaveExtra, RecentAnalysis };
import { contributionsOf, decodeDetail, DETAIL_KEY_SQL, detailKeyOf, encodeDetail } from "./analysis-detail";
import { isReadAllowed, isWriteAllowed, monthKey, R2_FENCE_LIMITS, type R2Usage } from "./r2-fence";

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
  /**
   * `stored`: R2 に詳細を書いた。`failed`: R2 への書き込みに失敗した(要約だけが残り、`detail_key` は NULL)。
   * `skipped`: R2 の操作回数の柵(Class A が無料枠の 10%)に達していたので、R2 に書かなかった(D1 に要約だけを保存。`detail_key` は NULL。Issue #173)。
   */
  readonly detail: "stored" | "failed" | "skipped";
}

export type DetailStatus = "present" | "missing" | "none";

export interface AnalysisDetailResult {
  /** 大きな列(rawResponse・raceSnapshot・馬の contributions)は、`detail` が `present` のときだけ入る(それ以外は null)。 */
  readonly analysis: StoredAnalysis;
  readonly detail: DetailStatus;
  /** LLM が使われなかった・一部しか使われなかった理由(固定文言。D1 の `llm_note`。無ければ null)。詳細(R2)の状態に依らない。 */
  readonly llmNote: string | null;
  /** LLM を呼んだ1回ごとの記録(D1 の `llm_calls_json`。Issue #197 段2。記録なし・壊れた値は null)。詳細(R2)の状態に依らない。一覧(要約)には載せない。 */
  readonly llmCalls: readonly LlmCallRecord[] | null;
}

/** 一覧の馬は、大きな列(contributions)と、強調材料・懸念事項(Issue #197。詳細の画面だけが使うので、一覧では読まない)を持たない。 */
export type AnalysisSummaryHorse = Omit<StoredAnalysisHorse, "contributions" | "highlights" | "concerns">;

/** 一覧の1件。`StoredAnalysis` から大きな列(rawResponse・raceSnapshot・馬の contributions)を除いたもの + R2 に詳細があるか。 */
export interface AnalysisSummary extends Omit<StoredAnalysis, "horses" | "rawResponse" | "raceSnapshot"> {
  readonly horses: readonly AnalysisSummaryHorse[];
  /** LLM が使われなかった・一部しか使われなかった理由(固定文言。D1 の `llm_note`。無ければ null)。 */
  readonly llmNote: string | null;
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

/** `getR2Usage` の戻り値。 */
export interface R2UsageReport extends R2Usage {
  /** 月(UTC の yyyymm)。 */
  readonly ym: number;
  /** 柵の上限(この回数に達したら止める)。 */
  readonly limits: { readonly classA: number; readonly classB: number };
  readonly writeAllowed: boolean;
  readonly readAllowed: boolean;
}

export interface AnalysisRepository {
  saveAnalysis(record: AnalysisRecord, extra?: AnalysisSaveExtra): Promise<SaveResult>;
  listAnalysisSummaries(filter?: AnalysisListFilter): Promise<AnalysisSummary[]>;
  getAnalysisDetail(analysisId: number): Promise<AnalysisDetailResult | undefined>;
  getStoredAllocation(analysisId: number): Promise<StoredAllocation | undefined>;
  listAnalyzedRaceIdsByPromptVersion(version: string): Promise<string[]>;
  listRecentForRace(raceId: string, fromIso: string, toIso: string): Promise<RecentAnalysis[]>;
  /** 今月の R2 の操作回数(Class A・B)と、柵の状態(Issue #173)。 */
  getR2Usage(): Promise<R2UsageReport>;
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
/** 理由(固定文言。Issue #194)。core の codec の INSERT(exe と共有)には列を足さず、理由があるときだけ、直後に UPDATE する(`detail_key` の UPDATE と同じ形)。 */
const UPDATE_LLM_NOTE_SQL = `UPDATE analyses SET llm_note = ? WHERE id = ${NEW_ID}`;
/** LLM 呼び出しの記録(Issue #197 段2)。理由と同じ形で、記録があるときだけ UPDATE する。理由と記録の両方があるときは、1文にまとめる(文の数を増やさない)。 */
const UPDATE_LLM_CALLS_SQL = `UPDATE analyses SET llm_calls_json = ? WHERE id = ${NEW_ID}`;
const UPDATE_LLM_NOTE_AND_CALLS_SQL = `UPDATE analyses SET llm_note = ?, llm_calls_json = ? WHERE id = ${NEW_ID}`;
const CLEAR_DETAIL_KEY_SQL = "UPDATE analyses SET detail_key = NULL WHERE id = ?";

/** 今月の R2 の操作回数(柵の判定のための読み取り。書き込み行を増やさない)。 */
const SELECT_R2_USAGE_SQL = "SELECT class_a AS classA, class_b AS classB FROM r2_ops WHERE ym = ?";
/** Class A(書き込み)の +1。保存の batch の最初の文(月の行が無ければ作る)。 */
const COUNT_WRITE_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 1, 0) ON CONFLICT(ym) DO UPDATE SET class_a = class_a + 1";
/** Class B(読み出し)の +1。best-effort で単独に実行する。 */
const COUNT_READ_SQL = "INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, 0, 1) ON CONFLICT(ym) DO UPDATE SET class_b = class_b + 1";

/** 要約の列(大きな列は読まず、NULL で埋めて `AnalysisRow` の形にする)。 */
const SUMMARY_COLUMNS = `id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated,
       prompt_version AS promptVersion, additional_instruction AS additionalInstruction,
       kaisai_date AS kaisaiDate, model, NULL AS rawResponse, NULL AS raceSnapshotJson,
       history_cutoff_date AS historyCutoffDate, prompt_lookahead_guarded AS promptLookaheadGuarded,
       detail_key IS NOT NULL AS hasDetail, llm_note AS llmNote`;

const SELECT_ONE_SQL = `SELECT ${SUMMARY_COLUMNS}, detail_key AS detailKey, llm_calls_json AS llmCallsJson FROM analyses WHERE id = ?`;

/**
 * 同じレースの、分析時刻が `[from, to]`(両端を含む。ISO 8601 の UTC 文字列。`analyzed_at` は `toISOString()` の固定長 24 文字なので、文字列の大小が時刻の大小と一致する)の分析。
 * 発走前の自動実行が、手動の分析との重複を確かめる(Issue #204)ための軽い読み取り(`idx_analyses_race`。馬・買い目・大きな列は読まない)。
 */
const SELECT_RECENT_FOR_RACE_SQL = `SELECT id, analyzed_at AS analyzedAt, prompt_version AS promptVersion, model
           FROM analyses
           WHERE race_id = ? AND analyzed_at >= ? AND analyzed_at <= ?
           ORDER BY analyzed_at, id`;

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
       NULL AS contributions_json, mark, reason, NULL AS highlights_json, NULL AS concerns_json
  FROM analysis_horses
  WHERE analysis_id IN (SELECT id FROM analyses${where} ORDER BY id DESC LIMIT ?)
  ORDER BY analysis_id DESC, umaban`;
  return [db.prepare(analysesSql).bind(...binds, limit), db.prepare(horsesSql).bind(...binds, limit)];
}

/**
 * 1 件の分析を書く D1 の文(1 回の batch に渡す)。馬・買い目の数によらず一定の文数。
 * 大きな列(raw_response・race_snapshot_json・馬の contributions_json)は NULL で書く(R2 へ)。
 *
 * - `ym` が数(UTC の yyyymm): 通常の保存。**最初の文が `r2_ops` の Class A の +1**(batch が失敗したらカウンタも増えない)で、続けて
 *   analyses の INSERT・`detail_key` の UPDATE・馬・[配分メタ・買い目]。配分ありなら 6 文、なしなら 4 文。analyses の INSERT は `[1]`({@link analysesInsertIndex})。
 * - `ym` が null: R2 の柵を超えたときの保存(R2 に書かない)。カウンタも `detail_key` の UPDATE も無い。配分ありなら 4 文、なしなら 2 文。analyses の INSERT は `[0]`。
 *
 * **理由(`llmNote`。Issue #194)か LLM 呼び出しの記録(`llmCallsJson`。Issue #197 段2。{@link serializeLlmCalls} の JSON 文字列)があるときだけ**、
 * `llm_note`・`llm_calls_json` の UPDATE を**1文**足す(analyses の INSERT〈と `detail_key` の UPDATE〉の直後。馬・配分メタ・買い目の前。理由だけ・記録だけ・両方で SQL の列が変わるだけで、文は1つ)。
 * どちらも無い(省略・null)は文を足さない(文の数・並びは上のとおり)。INSERT の位置({@link analysesInsertIndex})は変わらない。
 *
 * テストが「batch を使わず逐次実行したときの対照」にも使うため export している。
 */
export function buildSaveStatements(db: AnalysisDb, rec: AnalysisRecord, ym: number | null, llmNote: string | null = null, llmCallsJson: string | null = null): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (ym !== null) {
    statements.push(db.prepare(COUNT_WRITE_SQL).bind(ym));
  }
  statements.push(db.prepare(INSERT_ANALYSIS_SQL).bind(...analysisParams({ ...rec, rawResponse: null, raceSnapshot: null })));
  if (ym !== null) {
    statements.push(db.prepare(UPDATE_DETAIL_KEY_SQL));
  }
  if (llmNote !== null && llmCallsJson !== null) {
    statements.push(db.prepare(UPDATE_LLM_NOTE_AND_CALLS_SQL).bind(llmNote, llmCallsJson));
  } else if (llmNote !== null) {
    statements.push(db.prepare(UPDATE_LLM_NOTE_SQL).bind(llmNote));
  } else if (llmCallsJson !== null) {
    statements.push(db.prepare(UPDATE_LLM_CALLS_SQL).bind(llmCallsJson));
  }
  // 馬: 1 文・bind 1 個(JSON の配列)。analysis_id(先頭)を除いた束縛値の並びは codec のもの。contributions は R2 なので null。
  statements.push(db.prepare(INSERT_HORSES_SQL).bind(JSON.stringify(rec.horses.map((h) => horseParams(0, { ...h, contributions: null }).slice(1)))));
  if (rec.allocation !== undefined) {
    statements.push(db.prepare(INSERT_META_SQL).bind(...allocationMetaParams(0, rec.allocation.meta).slice(1)));
    statements.push(db.prepare(INSERT_BETS_SQL).bind(JSON.stringify(rec.allocation.bets.map((b) => allocationBetParams(0, b).slice(1)))));
  }
  return statements;
}

/** {@link buildSaveStatements} の結果の中で、analyses の INSERT(採番された id を返す文)の位置。 */
export function analysesInsertIndex(ym: number | null): number {
  return ym === null ? 0 : 1;
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
  /** 時計(R2 の操作回数の月の区切り〈UTC の yyyymm〉に使う)。既定は現在時刻。テストで注入する。 */
  readonly now?: () => Date;
}

export class D1AnalysisStore implements AnalysisRepository {
  private readonly db: AnalysisDb;
  private readonly bucket: AnalysisBucket;
  private readonly now: () => Date;

  constructor(options: D1AnalysisStoreOptions) {
    this.db = options.db;
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
  }

  /** 今月の R2 の操作回数(行が無ければ 0)。 */
  private async readUsage(ym: number): Promise<R2Usage> {
    const row = await this.db.prepare(SELECT_R2_USAGE_SQL).bind(ym).first<R2Usage>();
    return row ?? { classA: 0, classB: 0 };
  }

  /**
   * 保存した分析の子の行(馬・買い目)の件数(1クエリ)。子の行は `(SELECT max(id) FROM analyses)` で親に紐づけているので、最初の実保存で、
   * 正しい親 id に紐づいたかを確かめるために使う(Issue #178。#175 の申し送り)。
   */
  async countChildren(analysisId: number): Promise<{ readonly horses: number; readonly bets: number }> {
    const row = await this.db
      .prepare("SELECT (SELECT COUNT(*) FROM analysis_horses WHERE analysis_id = ?) AS horses, (SELECT COUNT(*) FROM analysis_bets WHERE analysis_id = ?) AS bets")
      .bind(analysisId, analysisId)
      .first<{ horses: number; bets: number }>();
    return { horses: row?.horses ?? 0, bets: row?.bets ?? 0 };
  }

  async saveAnalysis(record: AnalysisRecord, extra: AnalysisSaveExtra = { llmNote: null }): Promise<SaveResult> {
    // D1 に書く前に、詳細を符号化する(JSON にできない値はここで例外になり、何も書かれない)。
    const body = encodeDetail(record);
    // R2 の操作回数の柵(Class A)。達していたら、R2 に書かず D1 に要約だけを保存する(カウンタは増やさない)。
    const ym = monthKey(this.now());
    const writeYm = isWriteAllowed(await this.readUsage(ym)) ? ym : null;
    const results = await this.db.batch(buildSaveStatements(this.db, record, writeYm, extra.llmNote, serializeLlmCalls(extra.llmCalls)));
    const id = results[analysesInsertIndex(writeYm)]?.meta.last_row_id;
    if (typeof id !== "number" || !(id > 0)) {
      throw new Error("analyses の採番 id を取得できませんでした");
    }
    if (writeYm === null) {
      return { id, detail: "skipped" };
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
    return ((analyses?.results ?? []) as Array<AnalysisRow & { hasDetail: number; llmNote: string | null }>).map((row) => {
      const { rawResponse: _raw, raceSnapshot: _snapshot, horses: stored, ...rest } = toStoredAnalysis(row, horsesByAnalysis.get(row.id) ?? []);
      return { ...rest, horses: stored.map(({ contributions: _c, highlights: _h, concerns: _n, ...horse }) => horse), hasDetail: row.hasDetail === 1, llmNote: row.llmNote ?? null };
    });
  }

  async getAnalysisDetail(analysisId: number): Promise<AnalysisDetailResult | undefined> {
    const ym = monthKey(this.now());
    const [analyses, horses, usageRows] = await this.db.batch<unknown>([
      this.db.prepare(SELECT_ONE_SQL).bind(analysisId),
      this.db.prepare(SELECT_ANALYSIS_HORSES_SQL).bind(analysisId),
      this.db.prepare(SELECT_R2_USAGE_SQL).bind(ym),
    ]);
    const row = analyses?.results[0] as (AnalysisRow & { detailKey: string | null; llmNote: string | null; llmCallsJson: string | null }) | undefined;
    if (row === undefined) {
      return undefined;
    }
    const horseRows = (horses?.results ?? []) as HorseRow[];
    const llmNote = row.llmNote ?? null;
    const llmCalls = parseLlmCalls(row.llmCallsJson);
    if (row.detailKey === null) {
      return { analysis: toStoredAnalysis(row, horseRows), detail: "none", llmNote, llmCalls };
    }
    // R2 の操作回数の柵(Class B)。達していたら R2 を引かず、詳細の表示だけを拒否する(要約は出す。カウンタは増やさない)。
    const usage = (usageRows?.results[0] as R2Usage | undefined) ?? { classA: 0, classB: 0 };
    if (!isReadAllowed(usage)) {
      return { analysis: toStoredAnalysis(row, horseRows), detail: "missing", llmNote, llmCalls };
    }
    const payload = await this.readDetail(row.detailKey, row.raceId);
    await this.countRead(ym);
    if (payload === null) {
      return { analysis: toStoredAnalysis(row, horseRows), detail: "missing", llmNote, llmCalls };
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
    return { analysis: toStoredAnalysis(merged, mergedHorses), detail: "present", llmNote, llmCalls };
  }

  /** Class B(読み出し)を +1 する。**best-effort**: 失敗しても読み出しを妨げない(例外を握りつぶす)。 */
  private async countRead(ym: number): Promise<void> {
    try {
      await this.db.prepare(COUNT_READ_SQL).bind(ym).run();
    } catch {
      // カウントできなくても、詳細は返す。
    }
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

  /** 同じレースの、分析時刻が `[fromIso, toIso]`(両端を含む)の分析の要約(id・分析時刻・prompt_version・model だけ)。 */
  async listRecentForRace(raceId: string, fromIso: string, toIso: string): Promise<RecentAnalysis[]> {
    const { results } = await this.db.prepare(SELECT_RECENT_FOR_RACE_SQL).bind(raceId, fromIso, toIso).all<RecentAnalysis>();
    return results.map((r) => ({ id: r.id, analyzedAt: r.analyzedAt, promptVersion: r.promptVersion ?? null, model: r.model ?? null }));
  }

  async listAnalyzedRaceIdsByPromptVersion(version: string): Promise<string[]> {
    const { results } = await this.db.prepare(SELECT_RACE_IDS_BY_VERSION_SQL).bind(version).all<{ raceId: string }>();
    return results.map((r) => r.raceId);
  }

  async getR2Usage(): Promise<R2UsageReport> {
    const ym = monthKey(this.now());
    const usage = await this.readUsage(ym);
    return { ym, ...usage, limits: R2_FENCE_LIMITS, writeAllowed: isWriteAllowed(usage), readAllowed: isReadAllowed(usage) };
  }
}
