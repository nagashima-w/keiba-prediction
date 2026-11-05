/**
 * 検証が読む表へ書く経路の batch の最後に足す「レースの変更の印」(Issue #624。#616 の段階 1。migration 0037 の `verify_race_mark`)。
 *
 * 印は、そのレースの行を 1 行 upsert する: `seq` は表の最大値 + 行番号(1 回の文で複数のレースを書くとき、レースごとに別の値)、`kaisai_date` はそのレースの分析の最小の開催日
 * (分析がまだ無いレースは NULL。結果が分析より先に来ても文は失敗しない)。既にあるレースは UPDATE で `seq` が新しくなる。
 * D1 の batch は 1 つのトランザクションで直列に動くので、`MAX(seq)` は他の書き込みと衝突しない(`MAX` は uncorrelated な副問い合わせなので、文の中で 1 回だけ評価される)。
 * 読む側(開催日ごとの差分の再計算)は段階 3。この段階では書くだけ。
 *
 * 経路は 8 つ: `saveAnalysis`・`saveResult`・`saveWinOdds`・`saveScratched`・`saveWinPayout`・`saveRaceClass`(`result-repository.ts`)・検証の DO の `commitStartTimes`・`saveClose`。
 * 新しい経路を足したら、ここの文を batch の最後に足す(`cloud/test/verify-write-guard.test.ts` が書き手のファイルと呼び出し箇所の数を固定している)。
 */
import type { AnalysisDb } from "./analysis-repository";

/** upsert の後半(行ごとの衝突は、開催日と seq を新しい値にする)。 */
const UPSERT_TAIL = "ON CONFLICT(race_id) DO UPDATE SET kaisai_date = excluded.kaisai_date, seq = excluded.seq";

/** 印の 1 文の本体。`?1` は JSON 配列のレース ID(重複は最後の行番号が残る)。`WHERE true` は `INSERT … SELECT … ON CONFLICT` の構文の曖昧さを避ける(SQLite の仕様)。 */
const MARK_SELECT = (source: string): string =>
  `INSERT INTO verify_race_mark (race_id, kaisai_date, seq)
SELECT r.race_id, (SELECT MIN(kaisai_date) FROM analyses WHERE race_id = r.race_id), (SELECT COALESCE(MAX(seq), 0) FROM verify_race_mark) + r.n
FROM (${source}) r WHERE true
${UPSERT_TAIL}`;

/** レース ID(JSON 配列を `?1` に束縛)を指定して印を付ける文。 */
export const MARK_VERIFY_RACES_SQL = MARK_SELECT("SELECT value AS race_id, ROW_NUMBER() OVER (ORDER BY value) AS n FROM json_each(?1)");

/** 分析 ID(JSON 配列を `?1` に束縛)から、分析のレースを引いて(重複を除いて)印を付ける文。存在しない分析 ID は無視される。 */
export const MARK_VERIFY_BY_ANALYSIS_IDS_SQL = MARK_SELECT(
  "SELECT race_id, ROW_NUMBER() OVER (ORDER BY race_id) AS n FROM (SELECT DISTINCT race_id FROM analyses WHERE id IN (SELECT value FROM json_each(?1)))",
);

/** 1 レースの印の文(batch の最後に足す)。 */
export function verifyRaceMarkStatement(db: Pick<AnalysisDb, "prepare">, raceId: string): D1PreparedStatement {
  return db.prepare(MARK_VERIFY_RACES_SQL).bind(JSON.stringify([raceId]));
}

/** 分析 ID から引いたレースの印の文(batch の最後に足す。複数のレースは別の seq になる)。 */
export function verifyRaceMarkByAnalysisIdsStatement(db: Pick<AnalysisDb, "prepare">, analysisIds: readonly number[]): D1PreparedStatement {
  return db.prepare(MARK_VERIFY_BY_ANALYSIS_IDS_SQL).bind(JSON.stringify(analysisIds));
}
