/**
 * 想定複勝オッズと実際の複勝オッズ(下限〜上限の幅)の表示(Issue #253)。**依存を持たない純モジュール**: Worker(Discord の通知)と、ブラウザのクライアント(馬ごとのカード)の
 * 両方が import する(`win-odds-format.ts` の複勝版。丸め・「1000倍超」・ラベル・強調の判定を、web と Discord で別々に持たない)。
 *
 *  - 想定: 小数第1位に丸める。丸めた値が 1000 を超えるときは「1000倍超」。**生の値が 1.0 未満のときは「1.0倍未満」**(払戻率 80% なので、的中率が 80% を超えると 1.0 倍を割る。
 *    0.96 のように丸めると 1.0 になる値も「1.0倍未満」)。欠損・非有限は「-」。
 *  - 実際: 「1.5〜2.3倍」(下限〜上限)。丸めると同じ値なら「1.5倍」。**上限が無いとき**(上限を保存する前の過去の分析・取れなかった馬)は「1.5倍〜」。下限が無いとき(発売前の予想で
 *    複勝が未発売・未確定・詳細なし)は「-」。
 *  - 強調「↑想定より高い」(文字だけ。色に頼らない)は、**実際の下限**と想定を**表示する丸めた値どうし**で比べる(利用者の決定 2026-10-10)。想定が 1.0倍未満のときは比べない
 *    (実際の下限は必ず 1.0 以上で、比べても情報にならないため。利用者の決定 2026-10-11)。上限は比較に使わない。
 *    価値判断の語(妙味・お得)は使わない: 想定は払戻率込みなので、実際が想定を上回っても EV>1 とは限らない。
 *  - 出走 5〜7 頭(複勝は 2着まで)は見出しに「2着まで」を添える。出走 4 頭以下(複勝が発売されない)・判定不能は、想定も実際も「-」。
 */

import { actualWinOddsLabel, formatWinOdds, roundedOf } from "./win-odds-format";

/** 想定が 1.0 倍を下回るときの表示。 */
export const PLACE_UNDER_ONE_TEXT = "1.0倍未満";

/** 複勝の見出し(通常)。 */
export const PLACE_HEADING = "複勝";

/** 複勝の見出し(出走 5〜7 頭。複勝が 2着までのレース)。想定は 2着内率から出す。 */
export const PLACE_HEADING_TOP2 = "複勝(2着まで)";

/**
 * 想定複勝オッズの説明文(馬ごとの評価の見出しの下に、単勝の説明とは別の段落で1回出す)。払戻率 80% は中央・地方とも(地方も JRA と同じと仮定した概算。利用者の決定)。
 */
export const PLACE_ODDS_NOTE =
  "複勝の想定は、3着内率(出走5〜7頭のレースは複勝が2着までなので2着内率)から払戻率80%(地方も80%と仮定した概算)を割った目安で、AIが直接判断した値ではありません。実際の複勝オッズは一緒に3着内に入る他の馬で変わるため、下限〜上限の幅で出ます。「↑想定より高い」は実際の下限と想定を比べたもので、想定は払戻率込みなので、実際が想定を上回ってもEVが1を超えるとは限りません。";

/** 想定複勝オッズの表示(「2.0倍」「1.0倍未満」「1000倍超」「-」)。 */
export function formatFairPlaceOdds(odds: number | null): string {
  if (odds !== null && Number.isFinite(odds) && odds < 1) {
    return PLACE_UNDER_ONE_TEXT;
  }
  return formatWinOdds(odds);
}

/** 実際の複勝オッズの表示(「1.5〜2.3倍」「1.5倍」「1.5倍〜」「-」)。下限が無ければ「-」。 */
export function formatActualPlaceOdds(min: number | null, max: number | null): string {
  const rmin = roundedOf(min);
  if (rmin === null) {
    return "-";
  }
  const minText = formatWinOdds(min);
  const rmax = roundedOf(max);
  // 上限が無い・不正(下限より小さい)は、下限だけ(「1.5倍〜」)。
  if (rmax === null || rmax < rmin) {
    return `${minText}〜`;
  }
  // 丸めると同じ値(1000 超どうしも同じ)は1つだけ。
  if (rmax === rmin) {
    return minText;
  }
  // ここでは rmin < rmax。rmin が 1000 を超えることはない(超えれば rmax も同じ値にまとまり、上で返る)ので、minText は「…倍」で終わる。
  return `${minText.slice(0, -1)}〜${formatWinOdds(max)}`;
}

/** 想定と実際の1頭ぶんの表示。 */
export interface PlaceOddsLine {
  /** 見出し(「複勝」。5〜7頭は「複勝(2着まで)」)。 */
  readonly heading: string;
  /** 想定(「2.0倍」「1.0倍未満」。欠損は「-」)。 */
  readonly fair: string;
  /** 実際(「1.5〜2.3倍」「1.5倍〜」。欠損は「-」)。 */
  readonly actual: string;
  /** 実際のラベル(「実際」「実際(暫定)」「実際(予想)」)。 */
  readonly actualLabel: string;
  /** 実際の下限が想定より高いか(丸めた値どうしで比べる。どちらかが欠損、または想定が 1.0倍未満なら false)。 */
  readonly higher: boolean;
}

/**
 * @param fairPlaceOdds 想定複勝オッズ(丸め前)
 * @param actualMin 実際の複勝オッズの下限
 * @param actualMax 実際の複勝オッズの上限(過去の分析・取れなかったときは null)
 * @param oddsStatus 分析時点のオッズの状態(ラベルの出し分け)
 * @param basis 想定の基準(`"top3"`=3着内率、`"top2"`=2着内率〈5〜7頭〉、`null`=出さない〈4頭以下・判定不能〉)。null のときは、想定も実際も「-」にする
 */
export function buildPlaceOddsLine(
  fairPlaceOdds: number | null,
  actualMin: number | null,
  actualMax: number | null,
  oddsStatus: string | null | undefined,
  basis: "top3" | "top2" | null,
): PlaceOddsLine {
  const heading = basis === "top2" ? PLACE_HEADING_TOP2 : PLACE_HEADING;
  const actualLabel = actualWinOddsLabel(oddsStatus);
  if (basis === null) {
    return { heading, fair: "-", actual: "-", actualLabel, higher: false };
  }
  const fair = roundedOf(fairPlaceOdds);
  const min = roundedOf(actualMin);
  const underOne = fairPlaceOdds !== null && Number.isFinite(fairPlaceOdds) && fairPlaceOdds < 1;
  return {
    heading,
    fair: formatFairPlaceOdds(fairPlaceOdds),
    actual: formatActualPlaceOdds(actualMin, actualMax),
    actualLabel,
    higher: !underOne && fair !== null && min !== null && min > fair,
  };
}
