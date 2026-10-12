/**
 * 日報の「もしも」(Issue #272)の表示。**依存を持たない純モジュール**: Worker(LLM のプロンプト・Discord の日報)と、ブラウザのクライアント(日報の画面)の両方が import する
 * (`recovery-format.ts`・`expected-format.ts` と同じ位置づけ)。型の名前と、型 1 つ分の成績の文を、サーバとクライアントで食い違わせない。
 */
import { formatRecoveryPercent } from "./recovery-format";

/** 型の id と表示名(並び順 = 画面・プロンプトの並び)。型の定義(必要な印・券種)は `daily-report-whatif.ts` の `MARK_TEMPLATES`。 */
export const TEMPLATE_LABELS: readonly (readonly [id: string, label: string])[] = [
  ["win", "◎単勝"],
  ["place", "◎複勝"],
  ["wide", "◎-〇ワイド"],
  ["quinella", "◎-〇馬連"],
  ["trio", "◎〇▲の3連複"],
];

/** 型の表示名。未知の id は id のまま(黙って落とさない)。 */
export function templateLabel(id: string): string {
  return TEMPLATE_LABELS.find(([key]) => key === id)?.[1] ?? id;
}

export interface TemplateStatLike {
  readonly betCount: number;
  readonly hitCount: number;
  readonly stake: number;
  readonly payout: number;
  readonly unjudgedCount: number;
  readonly inapplicableCount: number;
}

/**
 * 型 1 つ分の成績の文。判定できたレースが無ければ回収率を出さない(賭け金 0)。判定不能・対象外は、あるときだけ添える(成績には含めない)。
 * 例: `判定できた 38 レース中 7 的中・賭け金 3,800円・払戻 3,150円・回収率 82.9%(判定不能 2 レース・対象外 5 レース)`
 */
export function formatTemplateStat(s: TemplateStatLike, yen: (n: number) => string): string {
  const head = s.betCount === 0 ? "判定できたレースなし" : `判定できた ${s.betCount} レース中 ${s.hitCount} 的中・賭け金 ${yen(s.stake)}・払戻 ${yen(s.payout)}・回収率 ${formatRecoveryPercent(s.payout / s.stake)}`;
  const rest = [s.unjudgedCount > 0 ? `判定不能 ${s.unjudgedCount} レース` : null, s.inapplicableCount > 0 ? `対象外 ${s.inapplicableCount} レース` : null].filter((t): t is string => t !== null);
  return rest.length === 0 ? head : `${head}(${rest.join("・")})`;
}
