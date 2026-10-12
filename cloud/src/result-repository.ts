/**
 * クラウド版のレース結果ストア(Issue #207〈#182-A〉。親は #182)。**結果は D1 だけ**(R2 は使わない)。
 *
 * **まだ production からは呼ばれない**(`worker.ts`・`race-day-do.ts` のどこからも import されていない。呼び出しは #208〈翌日以降の cron・バックフィル・手動の取り込み〉と
 * #209〈当日傾向〉)。このモジュールの責務は「D1 への書き込み・読み出し」だけで、netkeiba への取得・いつ取り込むかは持たない。
 *
 * ## 保存の形は exe と同じ(#167〈exe の DB を D1 へ移す〉との統合のため)
 * 表は migration 0001 にある exe の最終スキーマのまま(`race_results`・`race_result_meta`・`race_combo_payouts`・`race_combo_payout_imports`)。
 * **例外が2つ**: (1) Issue #259 の migration 0011 が、`race_results` に **D1 専用の列 `win_odds`・`ninki`**〈確定の単勝オッズ・人気〉を足した。exe の codec・移行の形式・共有 golden は変えず、この列は下の `FILL_WIN_ODDS_SQL` だけが書く。
 * (2) `race_results.scratched`(migration 0013。Issue #72。取消・除外の記録。D1 専用で exe には無い)。馬ごとの UPSERT にだけこの列を足す
 * ({@link withScratchedColumn}。codec の文は変えない)。取消・除外の馬は 1、印のない馬は 0。移行で入れた行(`MIGRATED_RESULTS_SQL`。exe の列だけ)は触れない = NULL(記録なし)。
 * SQL の文・束縛値の変換・復元(`toStoredPassing`・`toStoredCourseType` ほか)は core の codec(`analysis-store-codec.ts`)が持ち、exe の `AnalysisStore` と共有する。
 * 同じ入力から、exe の `AnalysisStore.saveResult` と同じ4表になることは、共有 golden(`packages/core/test/golden/race-result-contract.json`)で固定している
 * (exe 側: core の `race-result-contract.test.ts`。D1 側: `cloud/test/result-repository.test.ts`)。
 *
 * ## 書き込み(saveResult)
 * **1 回の `batch`**(D1 の batch は 1 つのトランザクション。exe の `db.transaction` と同じく、途中で失敗すれば全てロールバックされる)に、**最大 5 文**
 * (Issue #259: オッズか人気を持つ馬がいるときは、①の直後に確定の単勝オッズ・人気の UPDATE が 1 文入り、**最大 6 文**。持つ馬がいなければ従来どおり最大 5 文):
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
import { MIGRATION_TABLES, type MigrationTableName } from "../../packages/core/src/ev/cloud-migration-format";
import type { ResultImport } from "./migration-convert";
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

/**
 * codec の `race_results` の UPSERT に、D1 専用の `scratched` 列(migration 0013。Issue #72)を足した文。exe の `AnalysisStore` は
 * この列を持たない(保存しない)ので、codec の文は変えず、ここで列と `?` と `DO UPDATE SET` の1項目を足す。codec の文の形が
 * 想定と違えば(置換が効かなければ)読み込み時に落ちる。
 * @throws 想定の形でない
 */
export function withScratchedColumn(codecUpsertSql: string): string {
  const withColumn = codecUpsertSql.replace("last3f)", "last3f, scratched)");
  const withPlaceholder = withColumn.replace(/VALUES \(((?:\?, )*\?)\)/, "VALUES ($1, ?)");
  const withUpdate = withPlaceholder.replace("last3f = excluded.last3f", "last3f = excluded.last3f,\n         scratched = excluded.scratched");
  if (withColumn === codecUpsertSql || withPlaceholder === withColumn || withUpdate === withPlaceholder) {
    throw new Error("codec の race_results の UPSERT 文の形が想定と違います");
  }
  return withUpdate;
}

const UPSERT_RESULTS_JSON_SQL = jsonEachInsertSelectSql(withScratchedColumn(UPSERT_RACE_RESULT_SQL));
const DELETE_COMBOS_JSON_SQL = jsonEachDeleteSql(DELETE_COMBO_PAYOUTS_SQL);
const INSERT_COMBOS_JSON_SQL = jsonEachInsertSelectSql(INSERT_COMBO_PAYOUT_SQL);
const MARK_IMPORTED_JSON_SQL = jsonEachInsertSelectSql(MARK_COMBO_IMPORTED_SQL);

/**
 * 確定の単勝オッズ・人気を埋める文(Issue #259。migration 0011 の D1 専用の列。束縛値は `[行の配列の JSON, race_id]` の 2 個。行は `[umaban, winOdds, ninki]`)。
 * **NULL の列だけを埋める**: 入力が non-null で、保存済みの列が NULL の馬の、その列だけ(`COALESCE` で、既に値のある列は残す)。したがって
 *  - 冪等(2 回目は WHERE に当たる行が無く、書き込みは 0 行。別の値を渡しても上書きしない)
 *  - 他の列(着順・払戻・通過順・上がり)には触れない
 *  - 結果の行が無い馬番・レースには行を作らない(UPDATE だけ)
 * 新規の取り込み(`saveResult` の 6 文目)と、過去分の補完(`saveWinOdds`)が**同じこの 1 文**を使う(経路を 1 つにして、冪等性の検査を 1 か所にする)。
 * 馬ごとの UPSERT(codec の文)は、この 2 列を SET に含めない: 再取り込みで、保存済みのオッズが消えない。
 */
export const FILL_WIN_ODDS_SQL = `UPDATE race_results SET win_odds = COALESCE(race_results.win_odds, j.o), ninki = COALESCE(race_results.ninki, j.n)
           FROM (SELECT json_extract(value,'$[0]') AS u, json_extract(value,'$[1]') AS o, json_extract(value,'$[2]') AS n FROM json_each(?)) j
           WHERE race_results.race_id = ? AND race_results.umaban = j.u
             AND ((race_results.win_odds IS NULL AND j.o IS NOT NULL) OR (race_results.ninki IS NULL AND j.n IS NOT NULL))`;

/**
 * 取消・除外の記録(`scratched`)を、保存済みの行の NULL に限って埋める文(Issue #270。#72 の残り。束縛値は `[行の配列の JSON, race_id]` の 2 個。行は `[umaban, scratched]`で、scratched は取消・除外が 1・それ以外が 0)。
 * 対象は **`scratched IS NULL` かつ `finish_position IS NULL` の行だけ**(`scratched` を記録する前に取り込んだ行のうち、取消か中止か判別できない行。着順のある馬は取消でありえないので書かない):
 *  - 冪等(2 回目は WHERE に当たる行が無く、書き込みは 0 行。別の値を渡しても、記録済みの 0/1 を上書きしない)
 *  - 他の列(着順・払戻・通過順・上がり・オッズ・人気)には触れない
 *  - 結果の行が無い馬番・レースには行を作らない(UPDATE だけ)
 * 新規の取り込みは `saveResult` の UPSERT が scratched を書く(全頭に 0/1)ので、この文を使うのは過去分の補完(`saveScratched`)だけ。
 */
export const FILL_SCRATCHED_SQL = `UPDATE race_results SET scratched = j.s
           FROM (SELECT json_extract(value,'$[0]') AS u, json_extract(value,'$[1]') AS s FROM json_each(?)) j
           WHERE race_results.race_id = ? AND race_results.umaban = j.u
             AND race_results.scratched IS NULL AND race_results.finish_position IS NULL`;

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

/**
 * 結果の補完(Issue #217〈#167-C〉。`result-backfill-core.ts`)の列挙。判定は {@link LIST_UNIMPORTED_BY_DAY_SQL} と同じ(分析済み・`race_results` に行が 1 件も無い・`GROUP BY race_id` で最小の開催日)。
 * 違いは、窓の下限が無い(開催日が `to` 以下の全部。開催日が NULL の分析は `<=` の比較に入らない)・**未取込のある最も新しい日を 1 日だけ**(その日のレースID 昇順で `limit` 件)・
 * 除外するレース ID(永久に諦めたもの・その晩に試したもの)を JSON 配列 1 つで渡せる(`NOT IN (SELECT value FROM json_each(?))`。束縛は 1 つで、除外の数に依らない)。
 * 束縛値は `[to, excludeJson, limit]`。
 */
export const LIST_BACKFILL_SQL = `WITH u AS (
             SELECT a.race_id AS raceId, MIN(a.kaisai_date) AS firstDate
             FROM analyses a
             WHERE a.kaisai_date <= ?
               AND NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
               AND a.race_id NOT IN (SELECT value FROM json_each(?))
             GROUP BY a.race_id
           )
           SELECT raceId, firstDate FROM u
           WHERE firstDate = (SELECT MAX(firstDate) FROM u)
           ORDER BY raceId
           LIMIT ?`;

/**
 * 結果の補完の残りの数。`dated` = 未取込で開催日が `to` 以前のレース(除外を除く)、`undated` = 未取込で開催日がすべて NULL のレース(日単位の DO の宛先が決まらないので補完の対象外。数だけ見せる)。
 * `GROUP BY race_id` の最小の開催日が NULL なのは、そのレースの分析の開催日がすべて NULL のとき。束縛値は `[to, excludeJson]`。
 */
export const COUNT_BACKFILL_SQL = `WITH u AS (
             SELECT a.race_id AS raceId, MIN(a.kaisai_date) AS firstDate
             FROM analyses a
             WHERE NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
             GROUP BY a.race_id
           )
           SELECT COALESCE(SUM(CASE WHEN firstDate IS NOT NULL AND firstDate <= ? AND raceId NOT IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END), 0) AS dated,
                  COALESCE(SUM(CASE WHEN firstDate IS NULL THEN 1 ELSE 0 END), 0) AS undated
           FROM u`;

/**
 * 結果の補完の段階 2 で、scratched が欠けるレース(Issue #270 の (B))の条件: **着順が NULL で scratched が NULL の行が 1 つでもある**。
 * `scratched` を記録する前(migration 0013 より前)に取り込んだ行・exe から移した行のうち、取消か中止か判別できないもの。着順のある馬は取消でありえないので数えない。
 * 補完で埋まる(`saveScratched`)と、そのレースはこの条件から外れる。PK(race_id, umaban)の先頭で引くので、分析 1 行につき 1 レースの行だけを読む。
 */
const SCRATCHED_MISSING_EXISTS = `EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.finish_position IS NULL AND r.scratched IS NULL)`;

/**
 * 結果の補完の段階 2(Issue #259・#270)の列挙。**段階 1({@link LIST_BACKFILL_SQL})の逆**: 分析済みで、結果の行が**あり**、次の (A) または (B) に当たるレース。
 *  - (A)(Issue #259)確定の単勝オッズ(`win_odds`)が**1 頭も入っていない**。「1 頭も」にするのは、除外・取消の馬が NULL のまま残るレースを、毎晩列挙し直さないため(レース単位の判定)
 *  - (B)(Issue #270)着順が NULL で scratched が NULL の行がある({@link SCRATCHED_MISSING_EXISTS})。オッズが入っていても対象
 * 同じ取得 1 回で、両方を埋める(`winOddsOnly` の依頼。オッズ・人気は `saveWinOdds`、scratched は `saveScratched`)。それ以外(開催日が `to` 以下・`GROUP BY race_id` の最小の開催日・
 * 未取込のある最も新しい日を 1 日だけ・レースID 昇順・除外するレース ID を JSON 1 つで渡す)は段階 1 と同じ。束縛値は `[to, excludeJson, limit]`。
 */
export const LIST_WIN_ODDS_BACKFILL_SQL = `WITH u AS (
             SELECT a.race_id AS raceId, MIN(a.kaisai_date) AS firstDate
             FROM analyses a
             WHERE a.kaisai_date <= ?
               AND EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
               AND (NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.win_odds IS NOT NULL)
                    OR ${SCRATCHED_MISSING_EXISTS})
               AND a.race_id NOT IN (SELECT value FROM json_each(?))
             GROUP BY a.race_id
           )
           SELECT raceId, firstDate FROM u
           WHERE firstDate = (SELECT MAX(firstDate) FROM u)
           ORDER BY raceId
           LIMIT ?`;

/**
 * 段階 2 の残りの数({@link COUNT_BACKFILL_SQL} と同じ形)。`dated` = 対象((A) または (B))で開催日が `to` 以前のレース(除外を除く)、`undated` = 対象で開催日がすべて NULL のレース
 * (日単位の DO の宛先が決まらないので補完できない。数だけ見せる)、`scratchedMissing`(Issue #270)= `dated` のうち (B) に当たるレース(オッズも欠けているレースを含む。本番の件数を後から確かめる観測値)。
 * 束縛値は `[to, excludeJson, to, excludeJson]`(`dated` と `scratchedMissing` の分)。
 */
export const COUNT_WIN_ODDS_BACKFILL_SQL = `WITH u AS (
             SELECT a.race_id AS raceId, MIN(a.kaisai_date) AS firstDate, MAX(${SCRATCHED_MISSING_EXISTS}) AS scratchedMissing
             FROM analyses a
             WHERE EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)
               AND (NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.win_odds IS NOT NULL)
                    OR ${SCRATCHED_MISSING_EXISTS})
             GROUP BY a.race_id
           )
           SELECT COALESCE(SUM(CASE WHEN firstDate IS NOT NULL AND firstDate <= ? AND raceId NOT IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END), 0) AS dated,
                  COALESCE(SUM(CASE WHEN firstDate IS NULL THEN 1 ELSE 0 END), 0) AS undated,
                  COALESCE(SUM(CASE WHEN firstDate IS NOT NULL AND firstDate <= ? AND raceId NOT IN (SELECT value FROM json_each(?)) AND scratchedMissing = 1 THEN 1 ELSE 0 END), 0) AS scratchedMissing
           FROM u`;


// ---------------------------------------------------------------------------
// 移行(Issue #216・#167-B1): exe の結果を、既存の行を優先して入れる
// ---------------------------------------------------------------------------

/** 移行の表の列(race_id を先頭に持つ表)。列の並びは `MIGRATION_TABLES` の定義順で、codec の INSERT 文の列の並びと一致することをテストが固定している。 */
function migrationColumns(table: MigrationTableName): string[] {
  return MIGRATION_TABLES[table].columns.map((c) => c.name);
}

/** `json_each` の要素 `$[i]` を取り出す式(先頭の race_id は定数の `?` なので、`$[0]` は 2 列目)。 */
function picks(columnCount: number): string {
  return Array.from({ length: columnCount - 1 }, (_, i) => `json_extract(value,'$[${i}]')`).join(", ");
}

/**
 * 移行の結果の保存の文(束縛値は {@link buildMigratedResultStatements})。**既存の行を優先**(web が先に取り込んだものを上書きしない):
 *  - 馬(race_results): そのレースに 1 行でもあれば**表ごと**飛ばす(行ごとの部分的な和集合にしない。「結果が 1 件も無い」が未取込の判定なので、それに合わせる)
 *  - 面(race_result_meta): `INSERT OR IGNORE`
 *  - 組合せ払戻: その券種の取込記録が既にあれば飛ばす(記録より**先**に書くので、同じ batch の記録に妨げられない)。記録の無い券種の行は `OR IGNORE`
 *  - 取込記録: `INSERT OR IGNORE`
 * 既存の UPSERT・DELETE → INSERT(codec の文。再取込で上書きするためのもの)は使えない。
 */
const RESULT_COLUMNS = migrationColumns("race_results");
const COMBO_COLUMNS = migrationColumns("race_combo_payouts");
const MARKER_COLUMNS = migrationColumns("race_combo_payout_imports");
export const MIGRATED_RESULTS_SQL = `INSERT INTO race_results (${RESULT_COLUMNS.join(", ")}) SELECT ?, ${picks(RESULT_COLUMNS.length)} FROM json_each(?)
           WHERE NOT EXISTS (SELECT 1 FROM race_results WHERE race_id = ?)`;
export const MIGRATED_META_SQL = "INSERT OR IGNORE INTO race_result_meta (race_id, course_type) VALUES (?, ?)";
export const MIGRATED_COMBOS_SQL = `INSERT OR IGNORE INTO race_combo_payouts (${COMBO_COLUMNS.join(", ")}) SELECT ?, ${picks(COMBO_COLUMNS.length)} FROM json_each(?)
           WHERE NOT EXISTS (SELECT 1 FROM race_combo_payout_imports i WHERE i.race_id = ? AND i.bet_type = json_extract(value,'$[0]'))`;
export const MIGRATED_MARKERS_SQL = `INSERT OR IGNORE INTO race_combo_payout_imports (${MARKER_COLUMNS.join(", ")}) SELECT ?, ${picks(MARKER_COLUMNS.length)} FROM json_each(?)`;

/** 移行の結果 1 レースの文(最大 4 つ。馬・払戻の行数によらず一定)。書くものが無ければ空。 */
export function buildMigratedResultStatements(db: ResultDb, imp: ResultImport): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (imp.resultsJson !== null) {
    statements.push(db.prepare(MIGRATED_RESULTS_SQL).bind(imp.raceId, imp.resultsJson, imp.raceId));
  }
  if (imp.courseType !== null) {
    statements.push(db.prepare(MIGRATED_META_SQL).bind(imp.raceId, imp.courseType));
  }
  if (imp.comboRowsJson !== null) {
    statements.push(db.prepare(MIGRATED_COMBOS_SQL).bind(imp.raceId, imp.comboRowsJson, imp.raceId));
  }
  if (imp.markerRowsJson !== null) {
    statements.push(db.prepare(MIGRATED_MARKERS_SQL).bind(imp.raceId, imp.markerRowsJson));
  }
  return statements;
}

/** {@link D1ResultStore.saveMigratedResult} の結果。`queries` は D1 の問い合わせ数(batch は文数で数える)、`rowsWritten` は `meta.rows_written` の合計。 */
export interface MigratedResultOutcome {
  readonly rowsWritten: number;
  readonly queries: number;
}

// ---------------------------------------------------------------------------
// 保存の文の組み立て
// ---------------------------------------------------------------------------

/** 値が有限数ならそのまま、そうでなければ null(JSON に NaN・Infinity・undefined を載せない)。 */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 確定の単勝オッズ・人気を埋める文({@link FILL_WIN_ODDS_SQL})。オッズも人気も持つ馬が 1 頭もいなければ null(D1 に何も発行しない)。
 * D1 には何も発行しない(`prepare().bind()` を組み立てるだけ)。テストが「文の数・束縛値の数」を調べるために export している。
 */
export function buildWinOddsStatement(db: ResultDb, raceId: string, results: readonly RaceResultEntry[]): D1PreparedStatement | null {
  const rows = results
    .map((r) => [r.umaban, finiteOrNull(r.winOdds), finiteOrNull(r.ninki)] as const)
    .filter(([, odds, ninki]) => odds !== null || ninki !== null);
  if (rows.length === 0) {
    return null;
  }
  return db.prepare(FILL_WIN_ODDS_SQL).bind(JSON.stringify(rows), raceId);
}

/**
 * 取消・除外の記録を埋める文({@link FILL_SCRATCHED_SQL})。入力が空なら null(D1 に何も発行しない)。
 * 入力の各馬の `scratched` は、`true` なら 1、それ以外(印のない馬)は 0(`saveResult` の UPSERT と同じ値の作り方)。
 * D1 には何も発行しない(`prepare().bind()` を組み立てるだけ)。テストが「文の数・束縛値の数」を調べるために export している。
 */
export function buildScratchedStatement(db: ResultDb, raceId: string, results: readonly RaceResultEntry[]): D1PreparedStatement | null {
  if (results.length === 0) {
    return null;
  }
  const rows = results.map((r) => [r.umaban, r.scratched === true ? 1 : 0] as const);
  return db.prepare(FILL_SCRATCHED_SQL).bind(JSON.stringify(rows), raceId);
}

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
    // 先頭の race_id を除いた束縛値の並びは codec のもの(exe と同じ)に、D1 専用の scratched(取消・除外は 1、印のない馬は 0。Issue #72)を末尾に足す。
    statements.push(
      db.prepare(UPSERT_RESULTS_JSON_SQL).bind(raceId, JSON.stringify(results.map((r) => [...raceResultParams(raceId, r).slice(1), r.scratched === true ? 1 : 0]))),
    );
    // 確定の単勝オッズ・人気(Issue #259)。UPSERT の直後(同じ batch の順序)に、NULL の列だけを埋める。オッズを持つ馬がいなければ文を足さない(従来の文の数のまま)。
    const odds = buildWinOddsStatement(db, raceId, results);
    if (odds !== null) {
      statements.push(odds);
    }
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

export interface ListBackfillOptions {
  /** 開催日の上限(YYYYMMDD。含む)。 */
  readonly to: string;
  /** 除外するレース ID。 */
  readonly exclude: readonly string[];
  /** 件数。1〜{@link UNIMPORTED_MAX_LIMIT} の整数。 */
  readonly limit: number;
}

export interface CountBackfillOptions {
  readonly to: string;
  readonly exclude: readonly string[];
}

/** {@link COUNT_BACKFILL_SQL} の結果。 */
export interface BackfillCounts {
  readonly dated: number;
  readonly undated: number;
}

/** {@link COUNT_WIN_ODDS_BACKFILL_SQL} の結果(段階 2)。`scratchedMissing` は `dated` のうち、scratched が欠けて対象になるレースの数(Issue #270)。 */
export interface WinOddsBackfillCounts extends BackfillCounts {
  readonly scratchedMissing: number;
}

export interface ResultRepository {
  saveResult(raceId: string, results: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
  /** 確定の単勝オッズ・人気だけを、NULL の列に限って埋める(Issue #259。過去分の補完)。他の列・組合せ払戻には触れない。 */
  saveWinOdds(raceId: string, results: readonly RaceResultEntry[]): Promise<WinOddsOutcome>;
  /** 取消・除外の記録(`scratched`)だけを、着順が NULL で scratched が NULL の行に限って埋める(Issue #270。#72 の残り)。他の列・組合せ払戻には触れない。 */
  saveScratched(raceId: string, results: readonly RaceResultEntry[]): Promise<ScratchedOutcome>;
  getRaceResultDetails(raceIds: readonly string[]): Promise<Map<string, RaceResultDetail>>;
  listUnimportedRaces(options: ListUnimportedOptions): Promise<UnimportedRace[]>;
  listUnimportedRacesByDay(options: ListUnimportedByDayOptions): Promise<UnimportedRace[]>;
}

/** {@link D1ResultStore.saveWinOdds} の結果。`rowsWritten` は D1 が報告した `meta.rows_written`(書くものが無ければ 0)。 */
export interface WinOddsOutcome {
  readonly rowsWritten: number;
}

/** {@link D1ResultStore.saveScratched} の結果。`rowsWritten` は D1 が報告した `meta.rows_written`(書くものが無ければ 0)。 */
export interface ScratchedOutcome {
  readonly rowsWritten: number;
}

export interface D1ResultStoreOptions {
  readonly db: ResultDb;
}

const YYYYMMDD = /^\d{8}$/;

/** 補完の列挙・集計の入力の検査(to が YYYYMMDD・exclude が文字列の配列)。 */
function checkBackfillInput(to: unknown, exclude: unknown): void {
  if (typeof to !== "string" || !YYYYMMDD.test(to)) {
    throw new RangeError("to は YYYYMMDD の8桁の文字列でなければなりません");
  }
  if (!Array.isArray(exclude) || exclude.some((id) => typeof id !== "string")) {
    throw new RangeError("exclude は文字列の配列でなければなりません");
  }
}

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
   * 確定の単勝オッズ・人気**だけ**を、保存済みの結果の NULL の列に埋める(Issue #259。結果の補完の段階 2。{@link FILL_WIN_ODDS_SQL} の 1 文)。
   * `saveResult` と違い、着順・払戻・通過順・上がり・面・組合せ払戻には**一切触れない**(再取り込みで上書きしない)。冪等: 2 回目は何も書かない(`rowsWritten` は 0)。
   * 書くもの(オッズか人気を持つ馬)が無ければ D1 に何も発行しない。失敗は reject する。
   */
  async saveWinOdds(raceId: string, results: readonly RaceResultEntry[]): Promise<WinOddsOutcome> {
    const statement = buildWinOddsStatement(this.db, raceId, results);
    if (statement === null) {
      return { rowsWritten: 0 };
    }
    const [result] = await this.db.batch([statement]);
    return { rowsWritten: result?.meta.rows_written ?? 0 };
  }

  /**
   * 取消・除外の記録(`scratched`)**だけ**を、保存済みの結果の「着順が NULL で scratched が NULL」の行に埋める(Issue #270。#72 の残り。結果の補完の段階 2 が、結果ページを取り直したときに
   * `saveWinOdds` の直後に呼ぶ。{@link FILL_SCRATCHED_SQL} の 1 文)。`saveResult` と違い、他の列・面・組合せ払戻には**一切触れない**。冪等: 2 回目は何も書かない(`rowsWritten` は 0)。
   * 入力が空なら D1 に何も発行しない。失敗は reject する。
   */
  async saveScratched(raceId: string, results: readonly RaceResultEntry[]): Promise<ScratchedOutcome> {
    const statement = buildScratchedStatement(this.db, raceId, results);
    if (statement === null) {
      return { rowsWritten: 0 };
    }
    const [result] = await this.db.batch([statement]);
    return { rowsWritten: result?.meta.rows_written ?? 0 };
  }

  /**
   * exe から移した結果を、**既存の行を優先して**保存する(Issue #216。上の {@link MIGRATED_RESULTS_SQL})。1 回の batch(最大 4 文)。冪等(同じ内容を2回渡しても、2回目の `rowsWritten` は 0)。
   * 書くものが無いレースは D1 に何も発行しない。
   */
  async saveMigratedResult(imp: ResultImport): Promise<MigratedResultOutcome> {
    const statements = buildMigratedResultStatements(this.db, imp);
    if (statements.length === 0) {
      return { rowsWritten: 0, queries: 0 };
    }
    const results = await this.db.batch(statements);
    return { rowsWritten: results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0), queries: statements.length };
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

  /**
   * 結果の補完の列挙(Issue #217。上の {@link LIST_BACKFILL_SQL}): 未取込のある最も新しい日(`to` 以前)を、その日のぶんだけ。
   * @throws RangeError to が YYYYMMDD の8桁でない・limit が 1〜{@link UNIMPORTED_MAX_LIMIT} の整数でない・exclude が文字列の配列でない(D1 には発行しない)
   */
  async listBackfillRaces(options: ListBackfillOptions): Promise<UnimportedRace[]> {
    const { to, exclude, limit } = options;
    checkBackfillInput(to, exclude);
    if (!Number.isInteger(limit) || limit < 1 || limit > UNIMPORTED_MAX_LIMIT) {
      throw new RangeError(`limit は 1〜${UNIMPORTED_MAX_LIMIT} の整数でなければなりません`);
    }
    const { results } = await this.db.prepare(LIST_BACKFILL_SQL).bind(to, JSON.stringify(exclude), limit).all<{ raceId: string; firstDate: string }>();
    return results.map((r) => ({ raceId: r.raceId, kaisaiDate: r.firstDate }));
  }

  /**
   * 結果の補完の段階 2(Issue #259。上の {@link LIST_WIN_ODDS_BACKFILL_SQL})の列挙。
   * @throws RangeError to が YYYYMMDD の8桁でない・limit が 1〜{@link UNIMPORTED_MAX_LIMIT} の整数でない・exclude が文字列の配列でない(D1 には発行しない)
   */
  async listWinOddsBackfillRaces(options: ListBackfillOptions): Promise<UnimportedRace[]> {
    const { to, exclude, limit } = options;
    checkBackfillInput(to, exclude);
    if (!Number.isInteger(limit) || limit < 1 || limit > UNIMPORTED_MAX_LIMIT) {
      throw new RangeError(`limit は 1〜${UNIMPORTED_MAX_LIMIT} の整数でなければなりません`);
    }
    const { results } = await this.db.prepare(LIST_WIN_ODDS_BACKFILL_SQL).bind(to, JSON.stringify(exclude), limit).all<{ raceId: string; firstDate: string }>();
    return results.map((r) => ({ raceId: r.raceId, kaisaiDate: r.firstDate }));
  }

  /**
   * 結果の補完の段階 2 の残りの数(Issue #259。上の {@link COUNT_WIN_ODDS_BACKFILL_SQL})。
   * @throws RangeError to が YYYYMMDD の8桁でない・exclude が文字列の配列でない
   */
  async countWinOddsBackfill(options: CountBackfillOptions): Promise<WinOddsBackfillCounts> {
    const { to, exclude } = options;
    checkBackfillInput(to, exclude);
    const json = JSON.stringify(exclude);
    const row = await this.db.prepare(COUNT_WIN_ODDS_BACKFILL_SQL).bind(to, json, to, json).first<{ dated: number; undated: number; scratchedMissing: number }>();
    return { dated: row?.dated ?? 0, undated: row?.undated ?? 0, scratchedMissing: row?.scratchedMissing ?? 0 };
  }

  /**
   * 結果の補完の残りの数(Issue #217。上の {@link COUNT_BACKFILL_SQL})。
   * @throws RangeError to が YYYYMMDD の8桁でない・exclude が文字列の配列でない
   */
  async countBackfill(options: CountBackfillOptions): Promise<BackfillCounts> {
    const { to, exclude } = options;
    checkBackfillInput(to, exclude);
    const row = await this.db.prepare(COUNT_BACKFILL_SQL).bind(to, JSON.stringify(exclude)).first<{ dated: number; undated: number }>();
    return { dated: row?.dated ?? 0, undated: row?.undated ?? 0 };
  }
}
