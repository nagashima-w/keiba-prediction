/**
 * 想定単勝オッズと実際の単勝オッズの表示(Issue #247)。**依存を持たない純モジュール**: Worker(Discord の通知)と、ブラウザのクライアント(馬ごとのカード)の両方が import する
 * (`recovery-format.ts` と同じ。丸め・「1000倍超」・ラベル・強調の判定を、web と Discord で別々に持たない)。
 *
 *  - 数値は小数第1位に丸める。丸めた値が 1000 を超えるときは「1000倍超」。欠損・非有限は「-」。
 *  - 実際のオッズのラベルは、分析時点のオッズの状態で出し分ける(result=確定=「実際」・middle=発売中=「実際(暫定)」・yoso=発売前=「実際(予想)」。
 *    発売前の単勝オッズは予想値で、確定した値ではない)。
 *  - 強調は**文字だけ**(色に頼らない)。「実際が想定を上回る」かを、**表示する丸めた値どうし**で比べる(「8.5倍 / 8.5倍 ↑」を作らない)。
 *    「1000倍超」は同じ値として扱う。価値判断の語(妙味・お得)は使わない: 想定は払戻率込みなので、実際が想定を上回っても EV>1 とは限らない。
 */

/** 表示する上限(これを超える値は「1000倍超」)。 */
export const WIN_ODDS_DISPLAY_MAX = 1000;

/** 強調の文言(実際のオッズが想定より高いとき)。 */
export const ACTUAL_HIGHER_MARK = "↑想定より高い";

/** 馬のカードの「想定」のラベル(推定した目安であることを示す)。 */
export const FAIR_WIN_ODDS_LABEL = "想定(目安)";

/**
 * 想定単勝オッズの説明文(馬ごとの評価の見出しの下に1回出す)。払戻率 80% は中央・地方とも(地方も JRA と同じと仮定した概算。Issue #247 の利用者の決定)。
 */
export const WIN_ODDS_NOTE =
  "単勝の想定は、3着内率から推定した勝率で払戻率80%(地方も80%と仮定した概算)を割った目安で、AIが勝率を直接判断した値ではありません。想定は払戻率込みなので、実際が想定を上回ってもEVが1を超えるとは限りません。";

/** 丸めた値(小数第1位)。表示と強調の比較が同じ値を使う。非有限・欠損は null。1000 を超える値は、比較のため 1000 より大きい 1 つの値にまとめる。 */
function roundedOf(odds: number | null): number | null {
  if (odds === null || !Number.isFinite(odds)) {
    return null;
  }
  const rounded = Number(odds.toFixed(1));
  return rounded > WIN_ODDS_DISPLAY_MAX ? WIN_ODDS_DISPLAY_MAX + 0.1 : rounded;
}

/** 単勝オッズの表示(「8.5倍」「1000倍超」「-」)。 */
export function formatWinOdds(odds: number | null): string {
  const rounded = roundedOf(odds);
  if (rounded === null) {
    return "-";
  }
  return rounded > WIN_ODDS_DISPLAY_MAX ? `${WIN_ODDS_DISPLAY_MAX}倍超` : `${rounded.toFixed(1)}倍`;
}

/** 実際の単勝オッズのラベル。オッズの状態(result / middle / yoso)で出し分ける。null・未知の状態は「実際」。 */
export function actualWinOddsLabel(oddsStatus: string | null | undefined): string {
  switch (oddsStatus) {
    case "middle":
      return "実際(暫定)";
    case "yoso":
      return "実際(予想)";
    default:
      return "実際";
  }
}

/** 想定と実際の1頭ぶんの表示。 */
export interface WinOddsLine {
  /** 想定(「8.5倍」。欠損は「-」)。 */
  readonly fair: string;
  /** 実際(「12.3倍」。欠損は「-」)。 */
  readonly actual: string;
  /** 実際のラベル(「実際」「実際(暫定)」「実際(予想)」)。 */
  readonly actualLabel: string;
  /** 実際が想定より高いか(丸めた値どうしで比べる。どちらかが欠損なら false)。 */
  readonly higher: boolean;
}

export function buildWinOddsLine(fairWinOdds: number | null, winOdds: number | null, oddsStatus: string | null | undefined): WinOddsLine {
  const fair = roundedOf(fairWinOdds);
  const actual = roundedOf(winOdds);
  return {
    fair: formatWinOdds(fairWinOdds),
    actual: formatWinOdds(winOdds),
    actualLabel: actualWinOddsLabel(oddsStatus),
    higher: fair !== null && actual !== null && actual > fair,
  };
}
