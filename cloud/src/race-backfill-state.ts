/**
 * 結果の補完の「レース単位の状態の表」`race_backfill`(migration 0034。Issue #597)の、状態の導出の SQL。
 *
 * 補完の列挙・件数の SQL は、以前は `analyses` の全部を毎回読んでいた(読み取りが分析の行数 N に比例)。ここでは、レースごとの小さな表に**段階ごとの状態**を持ち、
 * 未完了の行だけの部分索引から読む。状態の導出(条件)は**この 1 か所**にあり、次の 3 つが同じ式を使う(migration の初期投入はこの式の文字列をそのまま持ち、テストが一致を固定する):
 *  - 書き込みの batch の最後の 1 文({@link RECOMPUTE_RACES_SQL}・{@link RECOMPUTE_BY_ANALYSIS_IDS_SQL}): 書いたレースの状態を作り直す
 *  - 整合検査({@link RECONCILE_RACE_BACKFILL_SQL}): 全レースを作り直し、食い違いを直す(補完の 1 晩 1 回)
 *  - migration 0034 の初期投入
 *
 * ## 列
 * `kaisai_date` = そのレースの分析の最小の開催日(全部 NULL なら NULL=補完の対象外)/ `sm` = 着順が NULL で scratched が NULL の行がある(段階 2 の観測値 `scratchedMissing`)/
 * `st1`〜`st4` = 段階 1〜4 の状態: **0** = 条件が偽(対象でない)/ **1** = 対象(未完了)/ **2** = 条件は真のままだが、済み・諦め(DO の記録を D1 に写したもの。列挙しない。`stillNull` の数)。
 *  - 段階 1: 結果の行が 1 件も無い
 *  - 段階 2: 結果があり、(`win_odds` が全頭 NULL、または scratched が欠ける行がある)
 *  - 段階 3: 結果があり、そのレースの分析の行に `race_class` が NULL のものがある
 *  - 段階 4: 結果があり、全馬の `win_payout` が NULL
 * 状態の作り直しは、条件が偽なら 0、真なら(旧状態が 2 なら 2、それ以外は 1)。済み・諦め(2)は、条件が真の間は保たれ、偽になれば 0 に戻る。
 *
 * ## 旧い SQL との差(同値でない点)
 * 旧い列挙・件数の SQL の「最小の開催日」は条件に当たる分析の行だけの最小(段階 3 は `race_class` が NULL の行の最小)だった。ここでは**そのレースの分析の全部の最小**。
 * 同じレースの分析で開催日が食い違うことはまれ(中央は ID が日付を決める)で、食い違っても最小は同じ日になるのが普通。
 */

const HAS_RESULTS = "EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id)";
const NO_WIN_ODDS = "NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.win_odds IS NOT NULL)";
const SCRATCHED_MISSING = "EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.finish_position IS NULL AND r.scratched IS NULL)";
const NO_WIN_PAYOUT = "NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.win_payout IS NOT NULL)";

/**
 * 状態の導出の SELECT(分析の `where` で絞ったレースごとに 1 行。列は `race_id`・`kaisai_date`・`sm`・`st1`〜`st4`。値は 0/1)。
 * `where` は空文字か `WHERE …`。migration 0034 は `where` が空のものをそのまま持つ。
 */
export function raceBackfillStateSelect(where: string): string {
  return `SELECT a.race_id AS race_id, MIN(a.kaisai_date) AS kaisai_date,
             CASE WHEN ${SCRATCHED_MISSING} THEN 1 ELSE 0 END AS sm,
             CASE WHEN NOT ${HAS_RESULTS} THEN 1 ELSE 0 END AS st1,
             CASE WHEN ${HAS_RESULTS} AND (${NO_WIN_ODDS} OR ${SCRATCHED_MISSING}) THEN 1 ELSE 0 END AS st2,
             CASE WHEN ${HAS_RESULTS} AND MAX(CASE WHEN a.race_class IS NULL THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS st3,
             CASE WHEN ${HAS_RESULTS} AND ${NO_WIN_PAYOUT} THEN 1 ELSE 0 END AS st4
      FROM analyses a ${where}
      GROUP BY a.race_id`;
}

/** 作り直した状態(`excluded`)と旧状態(`race_backfill`)から、新しい段階の状態を作る式(0 → 0、旧 2 → 2、それ以外 → 1)。 */
const newState = (n: number): string => `CASE WHEN excluded.st${n} = 0 THEN 0 WHEN race_backfill.st${n} = 2 THEN 2 ELSE 1 END`;

/** 状態の作り直しの UPSERT(`select` の結果を表に反映する。何も変わらない行は書かない)。 */
function upsertState(select: string): string {
  return `INSERT INTO race_backfill (race_id, kaisai_date, sm, st1, st2, st3, st4)
      SELECT race_id, kaisai_date, sm, st1, st2, st3, st4 FROM (${select}) WHERE true
      ON CONFLICT(race_id) DO UPDATE SET
        kaisai_date = excluded.kaisai_date, sm = excluded.sm,
        st1 = ${newState(1)}, st2 = ${newState(2)}, st3 = ${newState(3)}, st4 = ${newState(4)}
      WHERE race_backfill.kaisai_date IS NOT excluded.kaisai_date OR race_backfill.sm IS NOT excluded.sm
         OR race_backfill.st1 IS NOT (${newState(1)}) OR race_backfill.st2 IS NOT (${newState(2)})
         OR race_backfill.st3 IS NOT (${newState(3)}) OR race_backfill.st4 IS NOT (${newState(4)})`;
}

/**
 * 書き込みの batch の最後に足す 1 文(race_id の JSON 配列 1 つを束縛。1 レースなら `[raceId]`)。そのレースの分析・結果の行だけを読む(馬の行は多くとも約 18)。
 * 状態が変わらなければ書かない。分析の行が無いレース(結果だけがあるレース)には行を作らない。
 */
export const RECOMPUTE_RACES_SQL = upsertState(raceBackfillStateSelect("WHERE a.race_id IN (SELECT value FROM json_each(?))"));

/** 検証の DO の書き込み(`analyses.id` で更新する)用。分析の id の JSON 配列を束縛し、その分析のレースの状態を作り直す。 */
export const RECOMPUTE_BY_ANALYSIS_IDS_SQL = upsertState(
  raceBackfillStateSelect("WHERE a.race_id IN (SELECT race_id FROM analyses WHERE id IN (SELECT value FROM json_each(?)))"),
);

/**
 * 整合検査: 全レースの状態を作り直し、表と食い違う行を直す(補完の 1 晩 1 回。分析の全走査=O(N) が 1 晩 1 回)。束縛値なし。
 * 直した行数(`meta.changes`)が 0 でなければ、書き込みの経路のどこかが再計算を呼んでいない兆し。
 */
export const RECONCILE_RACE_BACKFILL_SQL = upsertState(raceBackfillStateSelect(""));

/** 済み・諦めを写す文(段階 `stage` の対象〈状態 1〉を 2 にする)。レース ID の JSON 配列を束縛する。 */
export function settleRaceBackfillSql(stage: 1 | 2 | 3 | 4): string {
  return `UPDATE race_backfill SET st${stage} = 2 WHERE st${stage} = 1 AND race_id IN (SELECT value FROM json_each(?))`;
}
