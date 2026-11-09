/**
 * クラウド版のレース結果ストア(Issue #207〈#182-A〉。親は #182)。**結果は D1 だけ**(R2 は使わない)。
 *
 * **まだ production からは呼ばれない**(`worker.ts`・`race-day-do.ts` のどこからも import されていない。呼び出しは #208〈翌日以降の cron・バックフィル・手動の取り込み〉と
 * #209〈当日傾向〉)。このモジュールの責務は「D1 への書き込み・読み出し」だけで、netkeiba への取得・いつ取り込むかは持たない。
 *
 * ## 保存の形は exe と同じ(#167〈exe の DB を D1 へ移す〉との統合のため)
 * 表は migration 0001 にある exe の最終スキーマのまま(`race_results`・`race_result_meta`・`race_combo_payouts`・`race_combo_payout_imports`)。
 * **例外が3つ**: (1) Issue #259 の migration 0011 が、`race_results` に **D1 専用の列 `win_odds`・`ninki`**〈確定の単勝オッズ・人気〉を足した。exe の codec・移行の形式・共有 golden は変えず、この列は下の `FILL_WIN_ODDS_SQL` だけが書く。
 * (2) `race_results.scratched`(migration 0013。Issue #72。取消・除外の記録。D1 専用で exe には無い)。馬ごとの UPSERT にだけこの列を足す
 * ({@link withScratchedColumn}。codec の文は変えない)。取消・除外の馬は 1、印のない馬は 0。移行で入れた行(`MIGRATED_RESULTS_SQL`。exe の列だけ)は触れない = NULL(記録なし)。
 * (3) `race_results.wakuban`(migration 0016。Issue #269。結果ページの各馬の枠番〈1〜8〉。枠連の買い目の返還の判定が読む。D1 専用)。{@link withWakubanColumn} が、同じ UPSERT に足す。枠番の無い馬は NULL。移行で入れた行は触れない = NULL。
 * SQL の文・束縛値の変換・復元(`toStoredPassing`・`toStoredCourseType` ほか)は core の codec(`analysis-store-codec.ts`)が持ち、exe の `AnalysisStore` と共有する。
 * 同じ入力から、exe の `AnalysisStore.saveResult` と同じ4表になることは、共有 golden(`packages/core/test/golden/race-result-contract.json`)で固定している
 * (exe 側: core の `race-result-contract.test.ts`。D1 側: `cloud/test/result-repository.integration.test.ts`)。
 *
 * ## 書き込み(saveResult)
 * **1 回の `batch`**(D1 の batch は 1 つのトランザクション。exe の `db.transaction` と同じく、途中で失敗すれば全てロールバックされる)に、**最大 6 文**
 * (Issue #259: オッズか人気を持つ馬がいるときだけ、①の直後に確定の単勝オッズ・人気の UPDATE が 1 文入る。持つ馬がいなければ従来どおり最大 5 文。枠番〈Issue #269〉は①の束縛値に足すだけで、文は増えない):
 *   ① 馬ごとの UPSERT(`race_results`。`json_each` で全馬を 1 文) ② 面の UPSERT(`race_result_meta`。面があるときだけ)
 *   ③ 組合せ払戻の DELETE(書く券種を `json_each` で 1 文) ④ 組合せ払戻の INSERT(`json_each` で全券種・全行を 1 文。払戻の行が 1 つも無いときは省く) ⑤ 取込マーカー(`json_each` で 1 文)
 * 文の数は馬・券種・払戻の行数に依らず一定(18 頭・全 6 券種でも、オッズ・人気が無ければ 5 文、あれば 6 文)。**1 文のバインドの上限(100)を超えない**(馬を 1 行ずつ束縛すると 18 頭 × 7 列 = 126 で超える。
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
 * ## 既知の差分(exe の SQLite との違い。【記録】。`test/result-repository.integration.test.ts` が固定している)
 * - 値は JSON 文字列を経由して D1 に入る(馬・組合せ)。NaN・Infinity は NULL になる(exe の better-sqlite3 は REAL で束縛する)。実データ(着順・払戻・上がり3F〈小数 1 桁〉)では差は出ない。
 *   17 桁の浮動小数の往復はローカルの D1 で一致を確かめた(本番の SQLite のビルドでの確認は最初の実保存)。
 */

import { kaisaiDateFromNarRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import { verifyRaceMarkStatement } from "./verify-race-mark";
import { RECOMPUTE_RACES_SQL, RECONCILE_RACE_BACKFILL_SQL, RECONCILE_RECENT_RACE_BACKFILL_SQL, settleRaceBackfillSql } from "./race-backfill-state";
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
import { finiteOrNull } from "../../packages/core/src/common/guards.js";

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

/**
 * {@link withScratchedColumn} の文に、D1 専用の `wakuban` 列(migration 0016。Issue #269)を足した文。枠連の買い目の返還の判定が読む枠番。
 * 列と `?` と `DO UPDATE SET` の1項目を、`scratched` の直後に足す(束縛値の並びは `... , scratched, wakuban`)。文の形が想定と違えば
 * (置換が効かなければ)読み込み時に落ちる。
 * @throws 想定の形でない
 */
export function withWakubanColumn(upsertWithScratchedSql: string): string {
  const withColumn = upsertWithScratchedSql.replace("last3f, scratched)", "last3f, scratched, wakuban)");
  const withPlaceholder = withColumn.replace(/VALUES \(((?:\?, )*\?)\)/, "VALUES ($1, ?)");
  const withUpdate = withPlaceholder.replace("scratched = excluded.scratched", "scratched = excluded.scratched,\n         wakuban = excluded.wakuban");
  if (withColumn === upsertWithScratchedSql || withPlaceholder === withColumn || withUpdate === withPlaceholder) {
    throw new Error("race_results の UPSERT 文(scratched つき)の形が想定と違います");
  }
  return withUpdate;
}

const UPSERT_RESULTS_JSON_SQL = jsonEachInsertSelectSql(withWakubanColumn(withScratchedColumn(UPSERT_RACE_RESULT_SQL)));
const DELETE_COMBOS_JSON_SQL = jsonEachDeleteSql(DELETE_COMBO_PAYOUTS_SQL);
const INSERT_COMBOS_JSON_SQL = jsonEachInsertSelectSql(INSERT_COMBO_PAYOUT_SQL);
const MARK_IMPORTED_JSON_SQL = jsonEachInsertSelectSql(MARK_COMBO_IMPORTED_SQL);

/**
 * 補完の UPDATE 3 文が共有する、束縛した JSON(`?1`。馬番をキーにしたオブジェクト)から、その行の馬番の値を引く式(Issue #615)。
 * 以前は `UPDATE … FROM (SELECT … FROM json_each(?)) j WHERE umaban = j.u` で、実行計画が「`race_results` を外側、`json_each` を内側」になり、
 * 外側の全行 × 内側の全要素(馬の数の 2 乗。14 頭で 239 行)を読んでいた。この形は `race_results` を `race_id` の索引で 1 回引き、行ごとに JSON から値を引く(14 頭で 15 行)。
 * 入力に無い馬番は `json_extract` が NULL を返し、WHERE の `IS NOT NULL` で落ちる(触らない)。
 */
const JSON_BY_UMABAN = `json_extract(?1, '$."' || umaban || '"')`;
const JSON_VALUE = JSON_BY_UMABAN;
const JSON_ODDS = `json_extract(${JSON_BY_UMABAN}, '$[0]')`;
const JSON_NINKI = `json_extract(${JSON_BY_UMABAN}, '$[1]')`;

/** `[馬番, 値]` の並びを、補完の UPDATE が引く「馬番をキーにしたオブジェクト」にする(Issue #615)。同じ馬番が重複したら**後勝ち**(旧い SQL では不定だった。呼び出し元は 1 頭 1 行で作る)。 */
function byUmaban(pairs: ReadonlyArray<readonly [number, unknown]>): Record<string, unknown> {
  return Object.fromEntries(pairs.map(([umaban, value]) => [String(umaban), value]));
}

/**
 * 確定の単勝オッズ・人気を埋める文(Issue #259。migration 0011 の D1 専用の列。束縛値は `[JSON, race_id]` の 2 個。JSON は馬番をキーにしたオブジェクトで、値は `[winOdds, ninki]`。Issue #615)。
 * **NULL の列だけを埋める**: 入力が non-null で、保存済みの列が NULL の馬の、その列だけ(`COALESCE` で、既に値のある列は残す)。したがって
 *  - 冪等(2 回目は WHERE に当たる行が無く、書き込みは 0 行。別の値を渡しても上書きしない)
 *  - 他の列(着順・払戻・通過順・上がり)には触れない
 *  - 結果の行が無い馬番・レースには行を作らない(UPDATE だけ)
 * 新規の取り込み(`saveResult` の 6 文目)と、過去分の補完(`saveWinOdds`)が**同じこの 1 文**を使う(経路を 1 つにして、冪等性の検査を 1 か所にする)。
 * 馬ごとの UPSERT(codec の文)は、この 2 列を SET に含めない: 再取り込みで、保存済みのオッズが消えない。
 */
export const FILL_WIN_ODDS_SQL = `UPDATE race_results SET win_odds = COALESCE(win_odds, ${JSON_ODDS}), ninki = COALESCE(ninki, ${JSON_NINKI})
           WHERE race_id = ?2
             AND ((win_odds IS NULL AND ${JSON_ODDS} IS NOT NULL) OR (ninki IS NULL AND ${JSON_NINKI} IS NOT NULL))`;

/**
 * 取消・除外の記録(`scratched`)を、保存済みの行の NULL に限って埋める文(Issue #270。#72 の残り。束縛値は `[JSON, race_id]` の 2 個。JSON は馬番をキーにしたオブジェクトで、値は scratched(Issue #615)で、scratched は取消・除外が 1・それ以外が 0)。
 * 対象は **`scratched IS NULL` かつ `finish_position IS NULL` の行だけ**(`scratched` を記録する前に取り込んだ行のうち、取消か中止か判別できない行。着順のある馬は取消でありえないので書かない):
 *  - 冪等(2 回目は WHERE に当たる行が無く、書き込みは 0 行。別の値を渡しても、記録済みの 0/1 を上書きしない)
 *  - 他の列(着順・払戻・通過順・上がり・オッズ・人気)には触れない
 *  - 結果の行が無い馬番・レースには行を作らない(UPDATE だけ)
 * 新規の取り込みは `saveResult` の UPSERT が scratched を書く(全頭に 0/1)ので、この文を使うのは過去分の補完(`saveScratched`)だけ。
 */
export const FILL_SCRATCHED_SQL = `UPDATE race_results SET scratched = ${JSON_VALUE}
           WHERE race_id = ?2 AND scratched IS NULL AND finish_position IS NULL AND ${JSON_VALUE} IS NOT NULL`;

/**
 * 単勝の確定払戻(`win_payout`)を、保存済みの行の NULL に限って埋める文(Issue #556。束縛値は `[JSON, race_id]` の 2 個。JSON は馬番をキーにしたオブジェクトで、値は winPayout。Issue #615)。
 * 対象は **`win_payout IS NULL` の行で、入力の払戻が non-null のものだけ**(単勝の払戻の保存は #100〈2026-09-23〉から。それより前に取り込んだ約 1,140 レースは全馬が NULL):
 *  - 冪等(2 回目は WHERE に当たる行が無く、書き込みは 0 行。別の値を渡しても、保存済みの払戻を上書きしない)
 *  - 他の列(着順・複勝払戻・通過順・上がり・オッズ・人気・scratched)・組合せ払戻には触れない
 *  - 結果の行が無い馬番・レースには行を作らない(UPDATE だけ)
 *  - 同着(1 着が 2 頭)は、入力に両馬の払戻があれば、両方の行に別々の額を書く
 * 新規の取り込みは `saveResult` の UPSERT が `win_payout` を書くので、この文を使うのは過去分の補完(`saveWinPayout`)だけ。
 */
export const FILL_WIN_PAYOUT_SQL = `UPDATE race_results SET win_payout = ${JSON_VALUE}
           WHERE race_id = ?2 AND win_payout IS NULL AND ${JSON_VALUE} IS NOT NULL`;

/**
 * 結果の補完の段階 4 の列挙(単勝の払戻の補完)。Issue #597 から**レース単位の状態の表 `race_backfill`**(migration 0035。導出は `race-backfill-state.ts`)の部分索引から読む
 * (以前は `analyses` の全部を毎回読んでいた)。対象 = `st4 = 1`(未完了。済み・諦め〈2〉と条件が偽〈0〉は含まない)で、開催日が `to` 以下(NULL は含まない)。
 * 並びは**開催日の新しい順 → 同じ日は race_id 昇順**で、`limit` 件まで日をまたいで返す(Issue #598 の 1 晩ぶんの待ち行列。以前は「最も新しい日を 1 日だけ」の版もあった)。
 * 除外するレース ID(その晩に試したもの。JSON 1 つ)は `NOT IN (SELECT value FROM json_each(?))`。済み・諦めは D1 の状態(2)にあるので、除外の JSON には入れない。
 * 束縛値は `[to, excludeJson, limit]`。索引は `(stN, kaisai_date DESC, race_id) WHERE stN > 0`。**`stN > 0` を式にも書く**(SQLite は `stN = 1` だけでは部分索引を使わない)。
 * 読み取りは、返す件数と除外の JSON の要素数に比例する(分析の行数 N に依らない。`test/result-backfill-state.integration.test.ts` が `EXPLAIN QUERY PLAN` と `meta.rows_read` で固定)。
 */
export const LIST_PAYOUT_BACKFILL_SQL = `SELECT race_id AS raceId, kaisai_date AS firstDate FROM race_backfill
           WHERE st4 > 0 AND st4 = 1 AND kaisai_date <= ?
             AND race_id NOT IN (SELECT value FROM json_each(?))
           ORDER BY kaisai_date DESC, race_id
           LIMIT ?`;


/**
 * 段階 4 の残りの数(Issue #597 から `race_backfill` の部分索引を読む。対象 = 結果があり、全馬の `win_payout` が NULL のレース)。`dated` = 対象(`st4 = 1`)で開催日が `to` 以前のレース、`undated` = 対象で開催日が NULL のレース
 * (日単位の DO の宛先が決まらないので補完できない。数だけ見せる)。済み・諦め(`st4 = 2`)は D1 の状態にあるので、除外の JSON は取らない。
 * `stillNull` = 対象のうち**済み・諦め**(`st4 = 2`)のレース(取得済み、または諦めたのに、まだ条件が真=ページに無い・語彙に無い・書き込みの失敗の目安)。束縛値は `[to]`。
 */
export const COUNT_PAYOUT_BACKFILL_SQL = `SELECT COALESCE(SUM(CASE WHEN kaisai_date IS NOT NULL AND kaisai_date <= ? THEN 1 ELSE 0 END), 0) AS dated,
                  COALESCE(SUM(CASE WHEN kaisai_date IS NULL THEN 1 ELSE 0 END), 0) AS undated,
                  (SELECT COUNT(*) FROM race_backfill WHERE st4 > 0 AND st4 = 2) AS stillNull
           FROM race_backfill WHERE st4 > 0 AND st4 = 1`;


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
 * 結果の補完の段階 1 の列挙(結果の取り込み。結果の行が 1 件も無いレース)。Issue #597 から**レース単位の状態の表 `race_backfill`**(migration 0035。導出は `race-backfill-state.ts`)の部分索引から読む
 * (以前は `analyses` の全部を毎回読んでいた)。対象 = `st1 = 1`(未完了。済み・諦め〈2〉と条件が偽〈0〉は含まない)で、開催日が `to` 以下(NULL は含まない)。
 * 並びは**開催日の新しい順 → 同じ日は race_id 昇順**で、`limit` 件まで日をまたいで返す(Issue #598 の 1 晩ぶんの待ち行列。以前は「最も新しい日を 1 日だけ」の版もあった)。
 * 除外するレース ID(その晩に試したもの。JSON 1 つ)は `NOT IN (SELECT value FROM json_each(?))`。済み・諦めは D1 の状態(2)にあるので、除外の JSON には入れない。
 * 束縛値は `[to, excludeJson, limit]`。索引は `(stN, kaisai_date DESC, race_id) WHERE stN > 0`。**`stN > 0` を式にも書く**(SQLite は `stN = 1` だけでは部分索引を使わない)。
 * 読み取りは、返す件数と除外の JSON の要素数に比例する(分析の行数 N に依らない。`test/result-backfill-state.integration.test.ts` が `EXPLAIN QUERY PLAN` と `meta.rows_read` で固定)。
 */
export const LIST_BACKFILL_SQL = `SELECT race_id AS raceId, kaisai_date AS firstDate FROM race_backfill
           WHERE st1 > 0 AND st1 = 1 AND kaisai_date <= ?
             AND race_id NOT IN (SELECT value FROM json_each(?))
           ORDER BY kaisai_date DESC, race_id
           LIMIT ?`;


/**
 * 段階 1 の残りの数(Issue #597 から `race_backfill` の部分索引を読む。対象 = 結果の行が 1 件も無いレース)。`dated` = 対象(`st1 = 1`)で開催日が `to` 以前のレース、`undated` = 対象で開催日が NULL のレース
 * (日単位の DO の宛先が決まらないので補完できない。数だけ見せる)。済み・諦め(`st1 = 2`)は D1 の状態にあるので、除外の JSON は取らない。
 * 束縛値は `[to]`。
 */
export const COUNT_BACKFILL_SQL = `SELECT COALESCE(SUM(CASE WHEN kaisai_date IS NOT NULL AND kaisai_date <= ? THEN 1 ELSE 0 END), 0) AS dated,
                  COALESCE(SUM(CASE WHEN kaisai_date IS NULL THEN 1 ELSE 0 END), 0) AS undated
           FROM race_backfill WHERE st1 > 0 AND st1 = 1`;


/**
 * 結果の補完の段階 2 の列挙(単勝オッズ・scratched の補完)。Issue #597 から**レース単位の状態の表 `race_backfill`**(migration 0035。導出は `race-backfill-state.ts`)の部分索引から読む
 * (以前は `analyses` の全部を毎回読んでいた)。対象 = `st2 = 1`(未完了。済み・諦め〈2〉と条件が偽〈0〉は含まない)で、開催日が `to` 以下(NULL は含まない)。
 * 並びは**開催日の新しい順 → 同じ日は race_id 昇順**で、`limit` 件まで日をまたいで返す(Issue #598 の 1 晩ぶんの待ち行列。以前は「最も新しい日を 1 日だけ」の版もあった)。
 * 除外するレース ID(その晩に試したもの。JSON 1 つ)は `NOT IN (SELECT value FROM json_each(?))`。済み・諦めは D1 の状態(2)にあるので、除外の JSON には入れない。
 * 束縛値は `[to, excludeJson, limit]`。索引は `(stN, kaisai_date DESC, race_id) WHERE stN > 0`。**`stN > 0` を式にも書く**(SQLite は `stN = 1` だけでは部分索引を使わない)。
 * 読み取りは、返す件数と除外の JSON の要素数に比例する(分析の行数 N に依らない。`test/result-backfill-state.integration.test.ts` が `EXPLAIN QUERY PLAN` と `meta.rows_read` で固定)。
 */
export const LIST_WIN_ODDS_BACKFILL_SQL = `SELECT race_id AS raceId, kaisai_date AS firstDate FROM race_backfill
           WHERE st2 > 0 AND st2 = 1 AND kaisai_date <= ?
             AND race_id NOT IN (SELECT value FROM json_each(?))
           ORDER BY kaisai_date DESC, race_id
           LIMIT ?`;


/**
 * 段階 2 の残りの数(Issue #597 から `race_backfill` の部分索引を読む。対象 = 結果があり、オッズが全頭 NULL または scratched が欠けるレース)。`dated` = 対象(`st2 = 1`)で開催日が `to` 以前のレース、`undated` = 対象で開催日が NULL のレース
 * (日単位の DO の宛先が決まらないので補完できない。数だけ見せる)。済み・諦め(`st2 = 2`)は D1 の状態にあるので、除外の JSON は取らない。
 * `scratchedMissing`(Issue #270)= `dated` のうち scratched が欠ける行があるレース(オッズも欠けているレースを含む。本番の件数を後から確かめる観測値)。束縛値は `[to, to]`。
 */
export const COUNT_WIN_ODDS_BACKFILL_SQL = `SELECT COALESCE(SUM(CASE WHEN kaisai_date IS NOT NULL AND kaisai_date <= ? THEN 1 ELSE 0 END), 0) AS dated,
                  COALESCE(SUM(CASE WHEN kaisai_date IS NULL THEN 1 ELSE 0 END), 0) AS undated,
                  COALESCE(SUM(CASE WHEN kaisai_date IS NOT NULL AND kaisai_date <= ? AND sm = 1 THEN 1 ELSE 0 END), 0) AS scratchedMissing
           FROM race_backfill WHERE st2 > 0 AND st2 = 1`;



/**
 * 結果の補完の段階 3 の列挙(レースのクラスの補完)。Issue #597 から**レース単位の状態の表 `race_backfill`**(migration 0035。導出は `race-backfill-state.ts`)の部分索引から読む
 * (以前は `analyses` の全部を毎回読んでいた)。対象 = `st3 = 1`(未完了。済み・諦め〈2〉と条件が偽〈0〉は含まない)で、開催日が `to` 以下(NULL は含まない)。
 * 並びは**開催日の新しい順 → 同じ日は race_id 昇順**で、`limit` 件まで日をまたいで返す(Issue #598 の 1 晩ぶんの待ち行列。以前は「最も新しい日を 1 日だけ」の版もあった)。
 * 除外するレース ID(その晩に試したもの。JSON 1 つ)は `NOT IN (SELECT value FROM json_each(?))`。済み・諦めは D1 の状態(2)にあるので、除外の JSON には入れない。
 * 束縛値は `[to, excludeJson, limit]`。索引は `(stN, kaisai_date DESC, race_id) WHERE stN > 0`。**`stN > 0` を式にも書く**(SQLite は `stN = 1` だけでは部分索引を使わない)。
 * 読み取りは、返す件数と除外の JSON の要素数に比例する(分析の行数 N に依らない。`test/result-backfill-state.integration.test.ts` が `EXPLAIN QUERY PLAN` と `meta.rows_read` で固定)。
 */
export const LIST_CLASS_BACKFILL_SQL = `SELECT race_id AS raceId, kaisai_date AS firstDate FROM race_backfill
           WHERE st3 > 0 AND st3 = 1 AND kaisai_date <= ?
             AND race_id NOT IN (SELECT value FROM json_each(?))
           ORDER BY kaisai_date DESC, race_id
           LIMIT ?`;


/**
 * 段階 3 の残りの数(Issue #597 から `race_backfill` の部分索引を読む。対象 = 結果があり、クラスが NULL の分析の行があるレース)。`dated` = 対象(`st3 = 1`)で開催日が `to` 以前のレース、`undated` = 対象で開催日が NULL のレース
 * (日単位の DO の宛先が決まらないので補完できない。数だけ見せる)。済み・諦め(`st3 = 2`)は D1 の状態にあるので、除外の JSON は取らない。
 * `stillNull` = 対象のうち**済み・諦め**(`st3 = 2`)のレース(取得済み、または諦めたのに、まだ条件が真=ページに無い・語彙に無い・書き込みの失敗の目安)。束縛値は `[to]`。
 */
export const COUNT_CLASS_BACKFILL_SQL = `SELECT COALESCE(SUM(CASE WHEN kaisai_date IS NOT NULL AND kaisai_date <= ? THEN 1 ELSE 0 END), 0) AS dated,
                  COALESCE(SUM(CASE WHEN kaisai_date IS NULL THEN 1 ELSE 0 END), 0) AS undated,
                  (SELECT COUNT(*) FROM race_backfill WHERE st3 > 0 AND st3 = 2) AS stillNull
           FROM race_backfill WHERE st3 > 0 AND st3 = 1`;


/** 保存済みのクラスの分布の上位の件数(状態の応答の大きさの歯止め)。 */
/** {@link D1ResultStore.settleBackfill} の 1 文あたりのレース ID の数(束縛する JSON の大きさの歯止め。1 件約 16 バイトで約 8KB)。 */
export const SETTLE_IDS_PER_STATEMENT = 500;
/** {@link D1ResultStore.settleBackfill} の 1 回の batch の文の数(D1 の 1 回の呼び出しあたりの文の数の制約に収める)。 */
export const SETTLE_BATCH_STATEMENTS = 20;

export const CLASS_DISTRIBUTION_LIMIT = 40;

/**
 * 保存済みのクラスの分布(Issue #426-b。語彙に無い表記の発見・#389-c の地方の軸の材料)。クラスの値ごとのレース数(同じレースの複数の分析は 1 レース)。NULL は含めない。
 * レース数の降順・同数は値の昇順(決定的)。上位 {@link CLASS_DISTRIBUTION_LIMIT} 件。値は出馬表・結果ページの固定の語彙(中央)か区分のトークン(地方。20 文字以内)で、利用者の入力は入らない。
 */
export const CLASS_DISTRIBUTION_SQL = `SELECT race_class AS value, COUNT(DISTINCT race_id) AS races
           FROM analyses WHERE race_class IS NOT NULL
           GROUP BY race_class ORDER BY races DESC, value ASC LIMIT ${CLASS_DISTRIBUTION_LIMIT}`;


// ---------------------------------------------------------------------------
// 保存の文の組み立て
// ---------------------------------------------------------------------------

/** 枠番として書ける値(1〜8 の整数)ならそのまま、そうでなければ null(未記録の NULL にする。範囲外の値を書かない)。 */
function validWakuban(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8 ? value : null;
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
  return db.prepare(FILL_WIN_ODDS_SQL).bind(JSON.stringify(byUmaban(rows.map(([u, o, n]) => [u, [o, n]]))), raceId);
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
  return db.prepare(FILL_SCRATCHED_SQL).bind(JSON.stringify(byUmaban(results.map((r) => [r.umaban, r.scratched === true ? 1 : 0]))), raceId);
}

/**
 * 単勝の払戻を埋める文({@link FILL_WIN_PAYOUT_SQL})。有限の払戻を持つ馬が 1 頭もいなければ null(D1 に何も発行しない)。
 * D1 には何も発行しない(`prepare().bind()` を組み立てるだけ)。テストが「文の数・束縛値の数」を調べるために export している。
 */
export function buildWinPayoutStatement(db: ResultDb, raceId: string, results: readonly RaceResultEntry[]): D1PreparedStatement | null {
  const rows = results.map((r) => [r.umaban, finiteOrNull(r.winPayout)] as const).filter(([, payout]) => payout !== null);
  if (rows.length === 0) {
    return null;
  }
  return db.prepare(FILL_WIN_PAYOUT_SQL).bind(JSON.stringify(byUmaban(rows)), raceId);
}

/** 補完の状態(race_backfill)の作り直しの 1 文(1 レース。Issue #597)。書き込みの batch の最後に足す。 */
export function recomputeRaceBackfillStatement(db: ResultDb, raceId: string): D1PreparedStatement {
  return db.prepare(RECOMPUTE_RACES_SQL).bind(JSON.stringify([raceId]));
}

/**
 * 1 レースの結果を書く D1 の文(1 回の batch に渡す)。最大 6 文(オッズ・人気を持つ馬がいなければ最大 5 文)で、馬・券種・払戻の行数によらず一定(上の説明)。
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
    // 先頭の race_id を除いた束縛値の並びは codec のもの(exe と同じ)に、D1 専用の scratched(取消・除外は 1、印のない馬は 0。Issue #72)と wakuban(枠番。無ければ NULL。Issue #269)を末尾に足す。
    statements.push(
      db.prepare(UPSERT_RESULTS_JSON_SQL).bind(raceId, JSON.stringify(results.map((r) => [...raceResultParams(raceId, r).slice(1), r.scratched === true ? 1 : 0, validWakuban(r.wakuban)]))),
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
  /** 除外するレース ID(その晩に試したもの)。済み・諦めは D1 の状態(`race_backfill`)にあるので入れない。 */
  readonly exclude: readonly string[];
  /** 件数。1〜{@link UNIMPORTED_MAX_LIMIT} の整数。日をまたいで、開催日の新しい順 → race_id 昇順に返す。 */
  readonly limit: number;
}

export interface CountBackfillOptions {
  readonly to: string;
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

/** {@link COUNT_CLASS_BACKFILL_SQL} の結果(段階 3。Issue #426-b)。 */
export interface ClassBackfillCounts extends BackfillCounts {
  /** 対象のうち除外 ID に入っているレース(取得済みなのにまだクラスが NULL)。 */
  readonly stillNull: number;
}

/** {@link COUNT_PAYOUT_BACKFILL_SQL} の結果(段階 4。Issue #556)。 */
export interface PayoutBackfillCounts extends BackfillCounts {
  /** 対象のうち除外 ID に入っているレース(取得済み・諦めたのに、まだ全馬の単勝の払戻が NULL)。 */
  readonly stillNull: number;
}

/** {@link CLASS_DISTRIBUTION_SQL} の 1 行。 */
export interface ClassDistributionRow {
  readonly value: string;
  readonly races: number;
}

export interface ResultRepository {
  saveResult(raceId: string, results: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
  /** 確定の単勝オッズ・人気だけを、NULL の列に限って埋める(Issue #259。過去分の補完)。他の列・組合せ払戻には触れない。 */
  saveWinOdds(raceId: string, results: readonly RaceResultEntry[]): Promise<WinOddsOutcome>;
  /** 取消・除外の記録(`scratched`)だけを、着順が NULL で scratched が NULL の行に限って埋める(Issue #270。#72 の残り)。他の列・組合せ払戻には触れない。 */
  saveScratched(raceId: string, results: readonly RaceResultEntry[]): Promise<ScratchedOutcome>;
  /**
   * 単勝の確定払戻(`win_payout`)だけを、保存済みの結果の NULL の行に限って埋める(Issue #556。過去分の補完)。既にある払戻・着順・複勝払戻・オッズ・組合せ払戻は上書きしない。
   * 同着(1 着が 2 頭)は、両馬に別々の払戻を書く。
   */
  saveWinPayout(raceId: string, results: readonly RaceResultEntry[]): Promise<WinPayoutOutcome>;
  /**
   * レースのクラス(結果ページの `RaceData02` から読んだ値。Issue #426)を、そのレースの分析(`analyses`)の行のうち `race_class` が NULL のものに書く。入っている値は上書きしない(先着)。
   * クラスが無い(null・undefined・空文字)なら D1 に何も発行しない。結果の表(`race_results` ほか)には触れない。
   */
  saveRaceClass(raceId: string, raceClass: string | null | undefined): Promise<RaceClassOutcome>;
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

/** {@link D1ResultStore.saveWinPayout} の結果。`rowsWritten` は D1 が報告した `meta.rows_written`(書くものが無ければ 0)。 */
export interface WinPayoutOutcome {
  readonly rowsWritten: number;
}

/** {@link D1ResultStore.saveRaceClass} の結果。`rowsWritten` は D1 が報告した `meta.rows_written`(書くものが無ければ 0)。 */
export interface RaceClassOutcome {
  readonly rowsWritten: number;
}

/**
 * レースのクラスを書く文(migration 0024。Issue #426)。そのレースの分析の行のうち `race_class` が NULL のものだけ(入っている値は上書きしない=先着。2 回目は 0 行)。
 * 検証の DO の補完(`verify-store.ts` の `COALESCE`)と対になる: どちらが先に入っても、先に入った値を NULL や別の値で消さない。束縛値は `[クラス, race_id]`。
 */
export const SAVE_RACE_CLASS_SQL = "UPDATE analyses SET race_class = ? WHERE race_id = ? AND race_class IS NULL";

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
    // 補完の状態(race_backfill。Issue #597)の作り直しを batch の最後に 1 文。結果の行を書くとき(馬の行がある)だけ。面・組合せ払戻だけの保存は状態の条件に触れない。
    // 検証の差分のための、レースの変更の印(Issue #624)は、書く文があるときは(結果が空で組合せ払戻だけのときも)最後に 1 文。
    await this.db.batch([...statements, ...(results.length > 0 ? [recomputeRaceBackfillStatement(this.db, raceId)] : []), verifyRaceMarkStatement(this.db, raceId)]);
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
    const [result] = await this.db.batch([statement, recomputeRaceBackfillStatement(this.db, raceId), verifyRaceMarkStatement(this.db, raceId)]); // 状態の作り直し(Issue #597)と、検証の差分のための変更の印(Issue #624)を最後に
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
    const [result] = await this.db.batch([statement, recomputeRaceBackfillStatement(this.db, raceId), verifyRaceMarkStatement(this.db, raceId)]); // 状態の作り直し(Issue #597)と、検証の差分のための変更の印(Issue #624)を最後に
    return { rowsWritten: result?.meta.rows_written ?? 0 };
  }

  /**
   * 単勝の確定払戻**だけ**を、保存済みの結果の `win_payout` が NULL の行に埋める(Issue #556。結果の補完が結果ページを取り直したときに、`saveScratched` の直後に呼ぶ。{@link FILL_WIN_PAYOUT_SQL} の 1 文)。
   * `saveResult` と違い、他の列・面・組合せ払戻には**一切触れない**。冪等: 2 回目は何も書かない(`rowsWritten` は 0)。有限の払戻を持つ馬が無ければ D1 に何も発行しない。失敗は reject する。
   */
  async saveWinPayout(raceId: string, results: readonly RaceResultEntry[]): Promise<WinPayoutOutcome> {
    const statement = buildWinPayoutStatement(this.db, raceId, results);
    if (statement === null) {
      return { rowsWritten: 0 };
    }
    const [result] = await this.db.batch([statement, recomputeRaceBackfillStatement(this.db, raceId), verifyRaceMarkStatement(this.db, raceId)]); // 状態の作り直し(Issue #597)と、検証の差分のための変更の印(Issue #624)を最後に
    return { rowsWritten: result?.meta.rows_written ?? 0 };
  }

  /**
   * レースのクラスを、そのレースの分析の行のうち `race_class` が NULL のものに書く(Issue #426。{@link SAVE_RACE_CLASS_SQL} の 1 文)。結果の取り込みが、結果ページを読んだあとに呼ぶ。
   * 結果の表には**一切触れない**。冪等: 2 回目は何も書かない(`rowsWritten` は 0)。クラスが無い(null・undefined・空文字)なら D1 に何も発行しない。失敗は reject する
   * (呼び出し側の結果の取り込みが握って警告にする=結果の保存は成功させる)。
   */
  async saveRaceClass(raceId: string, raceClass: string | null | undefined): Promise<RaceClassOutcome> {
    if (typeof raceClass !== "string" || raceClass === "") {
      return { rowsWritten: 0 };
    }
    const [result] = await this.db.batch([this.db.prepare(SAVE_RACE_CLASS_SQL).bind(raceClass, raceId), recomputeRaceBackfillStatement(this.db, raceId), verifyRaceMarkStatement(this.db, raceId)]); // 状態の作り直し(Issue #597)と、検証の差分のための変更の印(Issue #624)を最後に
    return { rowsWritten: result?.meta.rows_written ?? 0 };
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
   * @throws RangeError to が YYYYMMDD の8桁でない
   */
  async countWinOddsBackfill(options: CountBackfillOptions): Promise<WinOddsBackfillCounts> {
    const { to } = options;
    checkBackfillInput(to, []);
    const row = await this.db.prepare(COUNT_WIN_ODDS_BACKFILL_SQL).bind(to, to).first<{ dated: number; undated: number; scratchedMissing: number }>();
    return { dated: row?.dated ?? 0, undated: row?.undated ?? 0, scratchedMissing: row?.scratchedMissing ?? 0 };
  }

  /**
   * 結果の補完の段階 3(Issue #426-b。上の {@link LIST_CLASS_BACKFILL_SQL})の列挙。
   * @throws RangeError to が YYYYMMDD の8桁でない・limit が 1〜{@link UNIMPORTED_MAX_LIMIT} の整数でない・exclude が文字列の配列でない(D1 には発行しない)
   */
  async listClassBackfillRaces(options: ListBackfillOptions): Promise<UnimportedRace[]> {
    const { to, exclude, limit } = options;
    checkBackfillInput(to, exclude);
    if (!Number.isInteger(limit) || limit < 1 || limit > UNIMPORTED_MAX_LIMIT) {
      throw new RangeError(`limit は 1〜${UNIMPORTED_MAX_LIMIT} の整数でなければなりません`);
    }
    const { results } = await this.db.prepare(LIST_CLASS_BACKFILL_SQL).bind(to, JSON.stringify(exclude), limit).all<{ raceId: string; firstDate: string }>();
    return results.map((r) => ({ raceId: r.raceId, kaisaiDate: r.firstDate }));
  }

  /**
   * 結果の補完の段階 3 の残りの数(Issue #426-b。上の {@link COUNT_CLASS_BACKFILL_SQL})。
   * @throws RangeError to が YYYYMMDD の8桁でない
   */
  async countClassBackfill(options: CountBackfillOptions): Promise<ClassBackfillCounts> {
    const { to } = options;
    checkBackfillInput(to, []);
    const row = await this.db.prepare(COUNT_CLASS_BACKFILL_SQL).bind(to).first<{ dated: number; undated: number; stillNull: number }>();
    return { dated: row?.dated ?? 0, undated: row?.undated ?? 0, stillNull: row?.stillNull ?? 0 };
  }

  /**
   * 結果の補完の段階 4(Issue #556。上の {@link LIST_PAYOUT_BACKFILL_SQL})の列挙。
   * @throws RangeError to が YYYYMMDD の8桁でない・limit が 1〜{@link UNIMPORTED_MAX_LIMIT} の整数でない・exclude が文字列の配列でない(D1 には発行しない)
   */
  async listPayoutBackfillRaces(options: ListBackfillOptions): Promise<UnimportedRace[]> {
    const { to, exclude, limit } = options;
    checkBackfillInput(to, exclude);
    if (!Number.isInteger(limit) || limit < 1 || limit > UNIMPORTED_MAX_LIMIT) {
      throw new RangeError(`limit は 1〜${UNIMPORTED_MAX_LIMIT} の整数でなければなりません`);
    }
    const { results } = await this.db.prepare(LIST_PAYOUT_BACKFILL_SQL).bind(to, JSON.stringify(exclude), limit).all<{ raceId: string; firstDate: string }>();
    return results.map((r) => ({ raceId: r.raceId, kaisaiDate: r.firstDate }));
  }

  /**
   * 結果の補完の段階 4 の残りの数(Issue #556。上の {@link COUNT_PAYOUT_BACKFILL_SQL})。
   * @throws RangeError to が YYYYMMDD の8桁でない
   */
  async countPayoutBackfill(options: CountBackfillOptions): Promise<PayoutBackfillCounts> {
    const { to } = options;
    checkBackfillInput(to, []);
    const row = await this.db.prepare(COUNT_PAYOUT_BACKFILL_SQL).bind(to).first<{ dated: number; undated: number; stillNull: number }>();
    return { dated: row?.dated ?? 0, undated: row?.undated ?? 0, stillNull: row?.stillNull ?? 0 };
  }

  /**
   * 済み・諦めを D1 の状態に写す(Issue #597。補完の DO の記録を `race_backfill` に反映する)。`stages` の各段階について、対象(状態 1)のレースを済み・諦め(2)にする。
   * 条件が偽(0)のレースは変えない。冪等。1 回の batch の文の数は {@link SETTLE_BATCH_STATEMENTS} 以下に分け、1 文のレース ID は {@link SETTLE_IDS_PER_STATEMENT} 件以下に分ける。
   * @returns 実際に 2 にした行数(段階ごと)
   */
  async settleBackfill(stages: ReadonlyArray<{ readonly stage: 1 | 2 | 3 | 4; readonly raceIds: readonly string[] }>): Promise<Record<1 | 2 | 3 | 4, number>> {
    const changed: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const statements: Array<{ stage: 1 | 2 | 3 | 4; statement: D1PreparedStatement }> = [];
    for (const { stage, raceIds } of stages) {
      for (let i = 0; i < raceIds.length; i += SETTLE_IDS_PER_STATEMENT) {
        statements.push({ stage, statement: this.db.prepare(settleRaceBackfillSql(stage)).bind(JSON.stringify(raceIds.slice(i, i + SETTLE_IDS_PER_STATEMENT))) });
      }
    }
    for (let i = 0; i < statements.length; i += SETTLE_BATCH_STATEMENTS) {
      const part = statements.slice(i, i + SETTLE_BATCH_STATEMENTS);
      const results = await this.db.batch(part.map((p) => p.statement));
      part.forEach((p, k) => {
        changed[p.stage] += results[k]?.meta.changes ?? 0;
      });
    }
    return changed;
  }

  /**
   * 整合検査(Issue #597。{@link RECONCILE_RACE_BACKFILL_SQL}): 全レースの状態を作り直し、食い違う行を直す。分析の全走査(O(N))が 1 回。
   * `sinceKaisaiDate`(YYYYMMDD)を渡すと、その日以降の開催日の分析を持つレースだけを作り直す(Issue #614。{@link RECONCILE_RECENT_RACE_BACKFILL_SQL})。省略は全件。
   * @returns 直した行数(0 でなければ、書き込みの経路のどこかが状態の作り直しを呼んでいない兆し)
   */
  async reconcileBackfillState(sinceKaisaiDate?: string): Promise<number> {
    const stmt = sinceKaisaiDate === undefined ? this.db.prepare(RECONCILE_RACE_BACKFILL_SQL) : this.db.prepare(RECONCILE_RECENT_RACE_BACKFILL_SQL).bind(sinceKaisaiDate);
    const [result] = await this.db.batch([stmt]);
    return result?.meta.changes ?? 0;
  }

  /**
   * 開催日(`kaisai_date`)が NULL の分析に開催日を入れる(Issue #630。補完の DO が 1 晩 1 回呼ぶ)。
   * 決め方: 地方はレース ID の日付({@link kaisaiDateFromNarRaceId})、中央は過去の結果の目録 `race_archive.race_date`(`YYYY-MM-DD`)から `-` を除いたもの。
   * 決められない分析(中央で目録に無い・日付の書式が違う)は NULL のまま残し、`undecided`(分析の数)に数える。
   * 書くのは `kaisai_date IS NULL` の行だけ。入れたレースは同じ batch で補完の状態と検証の変更の印を作り直す(開催日が入ると補完の一覧に新しく出る)。
   * 読みは `kaisai_date IS NULL` の索引の探索だけ。NULL が 0 件なら目録も読まず、書き込みも流さない。
   * @returns races: 入れたレース数 / analyses: 入れた分析の数 / undecided: 決められずに残した分析の数
   */
  async fillNullKaisaiDates(): Promise<{ races: number; analyses: number; undecided: number }> {
    const { results: nulls } = await this.db.prepare("SELECT id, race_id FROM analyses WHERE kaisai_date IS NULL").all<{ id: number; race_id: string }>();
    if (nulls.length === 0) {
      return { races: 0, analyses: 0, undecided: 0 };
    }
    const centralIds = [...new Set(nulls.filter((n) => venueKindOfRaceId(n.race_id as never) !== "nar").map((n) => n.race_id))];
    const archived = new Map<string, string>();
    if (centralIds.length > 0) {
      const { results } = await this.db
        .prepare("SELECT race_id, race_date FROM race_archive WHERE race_id IN (SELECT value FROM json_each(?1))")
        .bind(JSON.stringify(centralIds))
        .all<{ race_id: string; race_date: string }>();
      for (const r of results) {
        archived.set(r.race_id, r.race_date);
      }
    }
    const decided = new Map<string, string>();
    const perRaceAnalyses = new Map<string, number>();
    let undecided = 0;
    for (const n of nulls) {
      const date = decideKaisaiDate(n.race_id, archived);
      if (date === null) {
        undecided += 1;
        continue;
      }
      decided.set(n.race_id, date);
      perRaceAnalyses.set(n.race_id, (perRaceAnalyses.get(n.race_id) ?? 0) + 1);
    }
    const raceIds = [...decided.keys()];
    for (let i = 0; i < raceIds.length; i += FILL_KAISAI_BATCH_RACES) {
      const statements: D1PreparedStatement[] = [];
      for (const raceId of raceIds.slice(i, i + FILL_KAISAI_BATCH_RACES)) {
        statements.push(
          this.db.prepare("UPDATE analyses SET kaisai_date = ?1 WHERE race_id = ?2 AND kaisai_date IS NULL").bind(decided.get(raceId)!, raceId),
          recomputeRaceBackfillStatement(this.db, raceId),
          verifyRaceMarkStatement(this.db, raceId),
        );
      }
      await this.db.batch(statements);
    }
    return { races: raceIds.length, analyses: [...perRaceAnalyses.values()].reduce((a, b) => a + b, 0), undecided };
  }

  /** 保存済みのクラスの分布(Issue #426-b。上の {@link CLASS_DISTRIBUTION_SQL})。 */
  async classDistribution(): Promise<ClassDistributionRow[]> {
    const { results } = await this.db.prepare(CLASS_DISTRIBUTION_SQL).all<ClassDistributionRow>();
    return results.map((r) => ({ value: r.value, races: r.races }));
  }

  /**
   * 結果の補完の残りの数(Issue #217。上の {@link COUNT_BACKFILL_SQL})。
   * @throws RangeError to が YYYYMMDD の8桁でない
   */
  async countBackfill(options: CountBackfillOptions): Promise<BackfillCounts> {
    const { to } = options;
    checkBackfillInput(to, []);
    const row = await this.db.prepare(COUNT_BACKFILL_SQL).bind(to).first<{ dated: number; undated: number }>();
    return { dated: row?.dated ?? 0, undated: row?.undated ?? 0 };
  }
}

/** {@link D1ResultStore.fillNullKaisaiDates} の 1 回の batch に入れるレース数(1 レース 3 文)。 */
const FILL_KAISAI_BATCH_RACES = 50;

/** 開催日を決める(決められなければ null)。結果は `YYYYMMDD` の 8 桁の数字に限る。 */
function decideKaisaiDate(raceId: string, archived: ReadonlyMap<string, string>): string | null {
  if (venueKindOfRaceId(raceId as never) === "nar") {
    return kaisaiDateFromNarRaceId(raceId);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(archived.get(raceId) ?? "");
  return m === null ? null : `${m[1]}${m[2]}${m[3]}`;
}
