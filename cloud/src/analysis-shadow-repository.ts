/**
 * 統計モデルの並走(影の計算。Issue #649 段階 2・3)の D1 への書き込み(migration 0040 の 2 表: `analysis_shadow_horses`・`analysis_shadow_probs`)。
 *
 * **分析の保存の batch には入れない。** 分析の保存(`D1AnalysisStore.saveAnalysis`)が成功して id が決まったあとに、別の呼び出しで書く。
 * 影の書き込みが失敗しても(表が無い・D1 の一時的な失敗)、分析の保存は成功のまま(呼び出し側が握って警告にする)。2 文は 1 つの batch(同じトランザクション)で、馬の行だけ残ることはない。
 * 値は `json_each` で束縛する(`docs/db-sql-rules.md` の決まり 5)。1 文あたり 1 つの束縛値(JSON の配列)。
 *
 * 買い目・配分・EV・画面・LLM のどれにも使わない。読む側は結果の比較(別 Issue)で、ここでは持たない。
 */
import type { ShadowRecord } from "../../packages/core/src/ev/stat-shadow-record";

export type ShadowDb = Pick<D1Database, "prepare" | "batch">;

/** 馬ごとの行(8 列)。`json_each` の配列の要素は [馬番, オッズ, q, 休み明け, 芝ダ替わり, 逃げ, 人気薄の大敗続き]。 */
export const INSERT_SHADOW_HORSES_SQL = `INSERT INTO analysis_shadow_horses (analysis_id, umaban, input_win_odds, market_q, flag_long_rest, flag_surface_change, flag_front_runner, flag_longshot_slump)
  SELECT ?, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]'), json_extract(value,'$[6]') FROM json_each(?)`;

/** 確率の行(6 列)。要素は [馬番, モデル, 勝率, 2着内率, 3着内率]。 */
export const INSERT_SHADOW_PROBS_SQL = `INSERT INTO analysis_shadow_probs (analysis_id, umaban, model, win_prob, top2_prob, top3_prob)
  SELECT ?, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]') FROM json_each(?)`;

/** 書く行の数(見積もり・テスト用)。 */
export function shadowRowCount(shadow: ShadowRecord): number {
  return shadow.horses.length + shadow.probs.length;
}

/** 保存用の文(馬の行・確率の行の順。空の側は文を作らない)。 */
export function buildShadowStatements(db: ShadowDb, analysisId: number, shadow: ShadowRecord): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (shadow.horses.length > 0) {
    const rows = shadow.horses.map((h) => [h.umaban, h.inputWinOdds, h.marketQ, h.flagLongRest, h.flagSurfaceChange, h.flagFrontRunner, h.flagLongshotSlump]);
    statements.push(db.prepare(INSERT_SHADOW_HORSES_SQL).bind(analysisId, JSON.stringify(rows)));
  }
  if (shadow.probs.length > 0) {
    const rows = shadow.probs.map((p) => [p.umaban, p.model, p.winProb, p.top2Prob, p.top3Prob]);
    statements.push(db.prepare(INSERT_SHADOW_PROBS_SQL).bind(analysisId, JSON.stringify(rows)));
  }
  return statements;
}

/** 影の記録を書く。例外は投げ直す(呼び出し側が握る)。 */
export async function saveShadow(db: ShadowDb, analysisId: number, shadow: ShadowRecord): Promise<number> {
  const statements = buildShadowStatements(db, analysisId, shadow);
  if (statements.length === 0) {
    return 0;
  }
  await db.batch(statements);
  return shadowRowCount(shadow);
}
