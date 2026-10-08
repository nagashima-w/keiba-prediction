/**
 * クラウド版のレース結果ストア(Issue #207〈#182-A〉。親は #182)。**結果は D1 だけ**(R2 は使わない)。
 *
 * **まだ production からは呼ばれない**(`worker.ts`・`race-day-do.ts` のどこからも import されていない。呼び出しは #208〈翌朝の cron・バックフィル・手動の取り込み〉と
 * #209〈当日傾向〉)。このモジュールの責務は「D1 への書き込み・読み出し」だけで、netkeiba への取得・いつ取り込むかは持たない。
 *
 * ## 保存の形は exe と同じ(#167〈exe の DB を D1 へ移す〉との統合のため)
 * 表は migration 0001 にある exe の最終スキーマのまま(`race_results`・`race_result_meta`・`race_combo_payouts`・`race_combo_payout_imports`)。**migration は足さない**。
 * SQL の文・束縛値の変換・復元(`toStoredPassing`・`toStoredCourseType` ほか)は core の codec(`analysis-store-codec.ts`)が持ち、exe の `AnalysisStore` と共有する。
 * 同じ入力から、exe の `AnalysisStore.saveResult` と同じ4表になることは、共有 golden(`packages/core/test/golden/race-result-contract.json`)で固定している
 * (exe 側: core の `race-result-contract.test.ts`。D1 側: `cloud/test/result-repository.test.ts`)。
 *
 * ## 書き込み(saveResult)
 * **1 回の `batch`**(D1 の batch は 1 つのトランザクション。exe の `db.transaction` と同じく、途中で失敗すれば全てロールバックされる)に、**最大 5 文**:
 *   ① 馬ごとの UPSERT(`race_results`。`json_each` で全馬を 1 文) ② 面の UPSERT(`race_result_meta`。面があるときだけ)
 *   ③ 組合せ払戻の DELETE(書く券種を `json_each` で 1 文) ④ 組合せ払戻の INSERT(`json_each` で全券種・全行を 1 文。払戻の行が 1 つも無いときは省く) ⑤ 取込マーカー(`json_each` で 1 文)
 * 文の数は馬・券種・払戻の行数に依らず一定(18 頭・全 6 券種でも 5 文)。**1 文のバインドの上限(100)を超えない**(馬を 1 行ずつ束縛すると 18 頭 × 7 列 = 126 で超える。
 * 各文の束縛値は `race_id` と JSON 文字列の 2 個以内)。D1 の Free は 1 回の呼び出しあたり 50 クエリが上限(この repo の docs の記述)なので、文を増やさない設計にしている。
 *
 * 券種ごとの意味は exe と同じ(core の `planComboWrites`): `state:"undetermined"`・券種の省略・`comboPayouts` の省略は、その券種の行・マーカーに触れない。
 * `state:"parsed"` は既存の行を DELETE してから INSERT し直し(組数が減っても孤児行を残さない)、マーカーを書く。`payouts:[]` はマーカーだけ(「未発売」と「未取込」を区別する)。
 * 同じ馬番の再保存は UPSERT(2 回目に無い馬は据え置き)。馬も面も組合せも無い入力は、D1 に何も発行しない。
 *
 * ## 読み出し
 * - `getRaceResultDetails(raceIds)`: 当日傾向(`runAnalysis` の `getRaceResultDetails`)に渡す。**1 回の batch(馬・面の 2 文)**で、レース数に依らない(ID は `json_each` で 1 バインド)。
 *   結果の行が 1 件も無いレースは Map に入れない(exe の `getRaceResultDetail` が undefined を返すのと同じ。面の行だけがあっても結果なし)。
 * - `listUnimportedRaces({ from, to, limit })`: 分析済み(`analyses` に行がある)なのに結果が無い(`race_results` に**行が 1 件も無い**)レース。バックフィル(#208)の対象の特定に使う。
 *   判定は必ず `NOT EXISTS`(行の有無)。全頭が中止・除外(着順が全て NULL)のレースは行があるので「取り込み済み」とみなす(`COUNT(finish_position)` で判定すると誤る)。
 *
 * ## 既知の差分(exe の SQLite との違い。【記録】。`test/result-repository.test.ts` が固定している)
 * - 値は JSON 文字列を経由して D1 に入る(馬・組合せ)。NaN・Infinity は NULL になる(exe の better-sqlite3 は REAL で束縛する)。実データ(着順・払戻・上がり3F〈小数 1 桁〉)では差は出ない。
 *   17 桁の浮動小数の往復はローカルの D1 で一致を確かめた(本番の SQLite のビルドでの確認は最初の実保存)。
 */

import {
  comboPayoutParams,
  DELETE_COMBO_PAYOUTS_SQL,
  INSERT_COMBO_PAYOUT_SQL,
  MARK_COMBO_IMPORTED_SQL,
  planComboWrites,
  raceResultParams,
  SELECT_RESULT_DETAIL_SQL,
  SELECT_RESULT_META_SQL,
  toRaceResultDetail,
  UPSERT_RACE_RESULT_META_SQL,
  UPSERT_RACE_RESULT_SQL,
  type ResultDetailRow,
} from "../../packages/core/src/ev/analysis-store-codec.js";
import type { RaceComboPayoutsSaveInput, RaceResultDetail, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import type { CourseType } from "../../packages/core/src/scraper/types.js";

/** D1 のうち、ストアが使う部分だけ(テストで記録つきの転送を渡せる)。 */
export type ResultDb = Pick<D1Database, "prepare" | "batch">;

/** `listUnimportedRaces` の limit の上限(1 回の依頼で返す件数の歯止め。`analysis-repository.ts` の一覧の上限と同じ値)。 */
export const UNIMPORTED_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// SQL(core の codec の文から導く。列の並びを重複して持たない。形が想定と違えば読み込み時に落ちる)
// ---------------------------------------------------------------------------

/**
 * codec の `INSERT INTO t (a, b, c) VALUES (?, ?, ?) [ON CONFLICT …]` から、`json_each` で複数行を 1 文で入れる文を導く。
 * **先頭の列(race_id)は定数の `?`**、残りの列は JSON の配列の要素 `$[0]`・`$[1]`…。束縛値は 2 個(先頭の定数・行の配列の JSON 文字列)。
 * `INSERT … SELECT … ON CONFLICT` は構文が曖昧になるため、SELECT に `WHERE true` を付ける(SQLite の仕様)。句(ON CONFLICT …)はそのまま保つ。
 * @throws 想定の形でない(INSERT … VALUES でない・列と `?` の数が合わない)
 */
export function jsonEachInsertSelectSql(codecInsertSql: string): string {
  const m = /^\s*INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*([\s\S]*)$/.exec(codecInsertSql);
  if (m === null) {
    throw new Error("codec の INSERT 文の形が想定と違います(INSERT INTO t (…) VALUES (…) でない)");
  }
  const columns = m[2]!.split(",").map((c) => c.trim());
  const placeholders = m[3]!.split(",").map((c) => c.trim());
  if (columns.length !== placeholders.length || placeholders.some((p) => p !== "?")) {
    throw new Error("codec の INSERT 文の形が想定と違います(列の数と ? の数が合わない)");
  }
  const picks = columns.slice(1).map((_, i) => `json_extract(value,'$[${i}]')`);
  const tail = m[4]!.trim();
  return `INSERT INTO ${m[1]} (${columns.join(", ")}) SELECT ?, ${picks.join(", ")} FROM json_each(?) WHERE true${tail === "" ? "" : ` ${tail}`}`;
}

/**
 * codec の `DELETE … WHERE race_id = ? AND bet_type = ?` の `bet_type = ?` を、`json_each` の `IN` に置き換える(複数の券種を 1 文で消す。束縛値は race_id と券種の配列の JSON)。
 * @throws `bet_type = ?` を含まない
 */
export function jsonEachDeleteSql(codecDeleteSql: string): string {
  const replaced = codecDeleteSql.replace("bet_type = ?", "bet_type IN (SELECT value FROM json_each(?))");
  if (replaced === codecDeleteSql) {
    throw new Error("codec の DELETE 文の形が想定と違います(bet_type = ? が無い)");
  }
  return replaced;
}

const UPSERT_RESULTS_JSON_SQL = jsonEachInsertSelectSql(UPSERT_RACE_RESULT_SQL);
const DELETE_COMBOS_JSON_SQL = jsonEachDeleteSql(DELETE_COMBO_PAYOUTS_SQL);
const INSERT_COMBOS_JSON_SQL = jsonEachInsertSelectSql(INSERT_COMBO_PAYOUT_SQL);
const MARK_IMPORTED_JSON_SQL = jsonEachInsertSelectSql(MARK_COMBO_IMPORTED_SQL);

/** codec の復元の文(1 レース)に race_id を足し、`WHERE race_id IN (json_each)` にして複数レースを 1 文で読む。 */
function toManyRacesSql(codecSelectSql: string, orderBy: string | null): string {
  const selected = codecSelectSql.replace(/^(\s*SELECT\s+)/, "$1race_id AS raceId, ");
  const filtered = selected.replace("WHERE race_id = ?", "WHERE race_id IN (SELECT value FROM json_each(?))");
  const ordered = orderBy === null ? filtered : filtered.replace(/ORDER BY umaban\s*$/, orderBy);
  if (selected === codecSelectSql || filtered === selected || (orderBy !== null && ordered === filtered)) {
    throw new Error("codec の SELECT 文の形が想定と違います");
  }
  return ordered;
}

const SELECT_DETAILS_JSON_SQL = toManyRacesSql(SELECT_RESULT_DETAIL_SQL, "ORDER BY race_id, umaban");
const SELECT_METAS_JSON_SQL = toManyRacesSql(SELECT_RESULT_META_SQL, null);

/**
 * 分析済み(analyses に行がある)だが結果未取込(race_results に行が 1 件も無い)のレース。開催日 `kaisai_date`(YYYYMMDD)が `[from, to]`(両端を含む)のものだけ
 * (`idx_analyses_kaisai_date`。開催日が NULL の分析は窓の比較に入らないので含まれない)。
 * 並びは (開催日, レースID) の昇順(古い日から消化できる)。同じレースを複数回分析していても 1 件(`GROUP BY race_id`。開催日が分かれていれば最小)。
 * 束縛値は `[from, to, limit]`。
 */
export const LIST_UNIMPORTED_SQL = `SELECT a.race_id AS raceId, MIN(a.kaisai_date) AS firstDate
           FROM analyses a
           WHERE a.kaisai_date >= ? AND a.kaisai_date <= ?
             AND NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
           GROUP BY a.race_id
           ORDER BY firstDate, a.race_id
           LIMIT ?`;

/**
 * {@link LIST_UNIMPORTED_SQL} と**同じ判定・同じ並びの基準**(分析済み・結果の行が 1 件も無い・`GROUP BY race_id` で最小の開催日)を、窓の全日にわたって **1 クエリ**で引く版(Issue #208 AC-C)。
 * 手動の取り込み(最大 31 日)で、日ごとに D1 を引くと 31 クエリになるため(D1 の 1 回の呼び出しあたり 50 クエリの制約・DO RPC の数え方が未確定)。
 *  - `ROW_NUMBER() OVER (PARTITION BY firstDate ORDER BY raceId)` が日ごとの上限(古い日が新しい日を押しのけない)
 *  - `DENSE_RANK() OVER (ORDER BY firstDate DESC)` が日数の上限(**未取込のある日だけ**を、新しい日から数える。内側が未取込だけに絞っているため、取り込み済みの日・開催の無い日は数えない)
 *  - 並びは **新しい日が先**、同じ日は レースID 昇順。`LIMIT` が合計の上限(古い日が切られる)
 * 束縛値は `[from, to, perDay, maxDays, total]` の 5 個。
 */
export const LIST_UNIMPORTED_BY_DAY_SQL = `SELECT raceId, firstDate FROM (
             SELECT raceId, firstDate,
                    ROW_NUMBER() OVER (PARTITION BY firstDate ORDER BY raceId) AS rn,
                    DENSE_RANK() OVER (ORDER BY firstDate DESC) AS dayRank
             FROM (
               SELECT a.race_id AS raceId, MIN(a.kaisai_date) AS firstDate
               FROM analyses a
               WHERE a.kaisai_date >= ? AND a.kaisai_date <= ?
                 AND NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
               GROUP BY a.race_id
             )
           )
           WHERE rn <= ? AND dayRank <= ?
           ORDER BY firstDate DESC, raceId
           LIMIT ?`;

/** {@link LIST_UNIMPORTED_BY_DAY_SQL} の日数の上限の最大(手動の取り込みの範囲の上限 31 日と同じ)。 */
export const UNIMPORTED_BY_DAY_MAX_DAYS = 31;

// ---------------------------------------------------------------------------
// 保存の文の組み立て
// ---------------------------------------------------------------------------

/**
 * 1 レースの結果を書く D1 の文(1 回の batch に渡す)。最大 5 文で、馬・券種・払戻の行数によらず一定(上の説明)。
 * 何も書くものが無い(馬も面も組合せも無い)ときは空配列。D1 には何も発行しない(`prepare().bind()` を組み立てるだけ)。
 * テストが「文の数・束縛値の数」を直接調べるために export している。
 */
export function buildSaveResultStatements(
  db: ResultDb,
  raceId: string,
  results: readonly RaceResultEntry[],
  courseType?: CourseType | null,
  comboPayouts?: RaceComboPayoutsSaveInput,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (results.length > 0) {
    // 先頭の race_id を除いた束縛値の並びは codec のもの(exe と同じ)。
    statements.push(db.prepare(UPSERT_RESULTS_JSON_SQL).bind(raceId, JSON.stringify(results.map((r) => raceResultParams(raceId, r).slice(1)))));
  }
  if (courseType !== undefined && courseType !== null) {
    statements.push(db.prepare(UPSERT_RACE_RESULT_META_SQL).bind(raceId, courseType));
  }
  const plans = planComboWrites(comboPayouts);
  if (plans.length > 0) {
    statements.push(db.prepare(DELETE_COMBOS_JSON_SQL).bind(raceId, JSON.stringify(plans.map((p) => p.betType))));
    const rows = plans.flatMap((p) => p.payouts.map((entry) => comboPayoutParams(raceId, p.betType, entry).slice(1)));
    if (rows.length > 0) {
      statements.push(db.prepare(INSERT_COMBOS_JSON_SQL).bind(raceId, JSON.stringify(rows)));
    }
    statements.push(db.prepare(MARK_IMPORTED_JSON_SQL).bind(raceId, JSON.stringify(plans.map((p) => [p.betType]))));
  }
  return statements;
}

// ---------------------------------------------------------------------------
// ストア
// ---------------------------------------------------------------------------

export interface UnimportedRace {
  readonly raceId: string;
  /** 開催日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
}

export interface ListUnimportedOptions {
  /** 開催日の下限(YYYYMMDD。含む)。 */
  readonly from: string;
  /** 開催日の上限(YYYYMMDD。含む)。`from` 以上。 */
  readonly to: string;
  /** 件数。1〜{@link UNIMPORTED_MAX_LIMIT} の整数。 */
  readonly limit: number;
}

export interface ListUnimportedByDayOptions {
  /** 開催日の下限(YYYYMMDD。含む)。 */
  readonly from: string;
  /** 開催日の上限(YYYYMMDD。含む)。`from` 以上。 */
  readonly to: string;
  /** 1 日あたりの件数。1〜{@link UNIMPORTED_MAX_LIMIT} の整数。 */
  readonly perDay: number;
  /** 未取込のある日を、新しい日から数えて取る日数。1〜{@link UNIMPORTED_BY_DAY_MAX_DAYS} の整数。 */
  readonly maxDays: number;
  /** 合計の件数。1〜{@link UNIMPORTED_MAX_LIMIT} の整数。 */
  readonly total: number;
}

export interface ResultRepository {
  saveResult(raceId: string, results: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
  getRaceResultDetails(raceIds: readonly string[]): Promise<Map<string, RaceResultDetail>>;
  listUnimportedRaces(options: ListUnimportedOptions): Promise<UnimportedRace[]>;
  listUnimportedRacesByDay(options: ListUnimportedByDayOptions): Promise<UnimportedRace[]>;
}

export interface D1ResultStoreOptions {
  readonly db: ResultDb;
}

const YYYYMMDD = /^\d{8}$/;

export class D1ResultStore implements ResultRepository {
  private readonly db: ResultDb;

  constructor(options: D1ResultStoreOptions) {
    this.db = options.db;
  }

  /**
   * レース後の実着順・複勝/単勝の確定払戻・通過順・上がり3F・面・組合せ払戻を保存する(core の `ImportResultDeps.saveResult` に差し込める形。
   * exe の `AnalysisStore.saveResult` と同じ引数・同じ意味。上のクラス説明の「書き込み」を参照)。失敗(D1 の例外・PRIMARY KEY 違反)は reject し、何も書かれない。
   */
  async saveResult(
    raceId: string,
    results: readonly RaceResultEntry[],
    courseType?: CourseType | null,
    comboPayouts?: RaceComboPayoutsSaveInput,
  ): Promise<void> {
    const statements = buildSaveResultStatements(this.db, raceId, results, courseType, comboPayouts);
    if (statements.length === 0) {
      return;
    }
    await this.db.batch(statements);
  }

  /**
   * 指定したレースの結果詳細(着順・通過順・上がり3F・面)。`runAnalysis` の `getRaceResultDetails`(当日傾向)に、そのまま渡せる形。
   * 結果の行が無いレースは Map に入れない。ids が空なら D1 に何も発行しない。同じ id が重なっていても 1 件として扱う(Map のキーの並びは ids の初出の順)。
   */
  async getRaceResultDetails(raceIds: readonly string[]): Promise<Map<string, RaceResultDetail>> {
    const unique = [...new Set(raceIds)];
    const out = new Map<string, RaceResultDetail>();
    if (unique.length === 0) {
      return out;
    }
    const json = JSON.stringify(unique);
    const [horseResult, metaResult] = await this.db.batch([
      this.db.prepare(SELECT_DETAILS_JSON_SQL).bind(json),
      this.db.prepare(SELECT_METAS_JSON_SQL).bind(json),
    ]);
    const horsesByRace = new Map<string, ResultDetailRow[]>();
    for (const row of (horseResult?.results ?? []) as Array<ResultDetailRow & { raceId: string }>) {
      const rows = horsesByRace.get(row.raceId) ?? [];
      rows.push(row);
      horsesByRace.set(row.raceId, rows);
    }
    const courseByRace = new Map<string, string | null>();
    for (const row of (metaResult?.results ?? []) as Array<{ raceId: string; courseType: string | null }>) {
      courseByRace.set(row.raceId, row.courseType);
    }
    for (const id of unique) {
      const rows = horsesByRace.get(id);
      if (rows === undefined) {
        continue;
      }
      out.set(id, toRaceResultDetail(rows, courseByRace.get(id) ?? null));
    }
    return out;
  }

  /**
   * 分析済み・結果未取込のレースを、開催日 `[from, to]` の中で、(開催日, レースID) の昇順に最大 `limit` 件(上の {@link LIST_UNIMPORTED_SQL})。
   * @throws RangeError from・to が YYYYMMDD の8桁でない・from > to・limit が 1〜{@link UNIMPORTED_MAX_LIMIT} の整数でない(D1 には発行しない)
   */
  async listUnimportedRaces(options: ListUnimportedOptions): Promise<UnimportedRace[]> {
    const { from, to, limit } = options;
    if (typeof from !== "string" || typeof to !== "string" || !YYYYMMDD.test(from) || !YYYYMMDD.test(to)) {
      throw new RangeError("from・to は YYYYMMDD の8桁の文字列でなければなりません");
    }
    if (from > to) {
      throw new RangeError("from は to 以前でなければなりません");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > UNIMPORTED_MAX_LIMIT) {
      throw new RangeError(`limit は 1〜${UNIMPORTED_MAX_LIMIT} の整数でなければなりません`);
    }
    const { results } = await this.db.prepare(LIST_UNIMPORTED_SQL).bind(from, to, limit).all<{ raceId: string; firstDate: string }>();
    return results.map((r) => ({ raceId: r.raceId, kaisaiDate: r.firstDate }));
  }

  /**
   * 分析済み・結果未取込のレースを、窓 `[from, to]` の全日にわたって **1 クエリ**で列挙する(Issue #208。上の {@link LIST_UNIMPORTED_BY_DAY_SQL})。
   * 新しい日が先・1 日 `perDay` 件・未取込のある日を新しい順に `maxDays` 日・合計 `total` 件。
   * @throws RangeError from・to が YYYYMMDD の8桁でない・from > to・perDay・total が 1〜{@link UNIMPORTED_MAX_LIMIT} の整数でない・maxDays が 1〜{@link UNIMPORTED_BY_DAY_MAX_DAYS} の整数でない(D1 には発行しない)
   */
  async listUnimportedRacesByDay(options: ListUnimportedByDayOptions): Promise<UnimportedRace[]> {
    const { from, to, perDay, maxDays, total } = options;
    if (typeof from !== "string" || typeof to !== "string" || !YYYYMMDD.test(from) || !YYYYMMDD.test(to)) {
      throw new RangeError("from・to は YYYYMMDD の8桁の文字列でなければなりません");
    }
    if (from > to) {
      throw new RangeError("from は to 以前でなければなりません");
    }
    for (const [name, value] of [["perDay", perDay], ["total", total]] as const) {
      if (!Number.isInteger(value) || value < 1 || value > UNIMPORTED_MAX_LIMIT) {
        throw new RangeError(`${name} は 1〜${UNIMPORTED_MAX_LIMIT} の整数でなければなりません`);
      }
    }
    if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > UNIMPORTED_BY_DAY_MAX_DAYS) {
      throw new RangeError(`maxDays は 1〜${UNIMPORTED_BY_DAY_MAX_DAYS} の整数でなければなりません`);
    }
    const { results } = await this.db.prepare(LIST_UNIMPORTED_BY_DAY_SQL).bind(from, to, perDay, maxDays, total).all<{ raceId: string; firstDate: string }>();
    return results.map((r) => ({ raceId: r.raceId, kaisaiDate: r.firstDate }));
  }
}
