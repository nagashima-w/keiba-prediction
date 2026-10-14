/**
 * 中央競馬のグレードアイコンの番号(`Icon_GradeType{N}`)→グレードラベルの対応表(Issue #250)。
 *
 * 中央の一覧・出馬表のグレードは画像アイコン方式で、内テキストが空のため、クラス名の番号から読む。
 * **表に載せるのは、netkeiba 自身の出馬表 `<title>`(例: 「毎日王冠(G2) 出馬表」)と、同じページの
 * `h1.RaceName` 内のクラス番号を突き合わせて実測した番号だけ**(2026-10-10)。実測していない番号は
 * 推測で埋めず、undefined(グレードなし=表示しない)にする。
 *
 * 実測した対応(title の括弧内 ⇔ 番号):
 *   G1=1・G2=2・G3=3・JG1=10・JG2=11・JG3=12(以上が表の中身)、
 *   OP=5・L=15・3勝クラス=16・2勝クラス=17・1勝クラス=18(以上は重賞ではないので表に載せない=undefined)。
 * 番号 13 はグレードではない別のアイコン(RaceName 内にグレードの隣に並ぶ。表に無いので無視される)。
 * 未測定の番号は 4・6〜9・14。
 *
 * 障害の title は「JG1」と書かれるが、表示は JRA 公式の「J・G1」にする(ユーザー指定)。
 * 地方はこの表を使わない(クラス番号がテキストと 1 対 1 でない: Jpn1=19・Jpn2=20・重賞=4。テキストをそのまま使う)。
 */

import { PATTERNS } from "./selectors.js";

/** 実測した、重賞の番号→ラベル。 */
const CENTRAL_GRADE_LABELS: ReadonlyMap<number, string> = new Map([
  [1, "G1"],
  [2, "G2"],
  [3, "G3"],
  [10, "J・G1"],
  [11, "J・G2"],
  [12, "J・G3"],
]);

/**
 * 中央のグレードアイコンの番号をグレードラベルにする。表に無い番号(重賞ではない・未測定・範囲外・不正値)は undefined。
 */
export function centralGradeLabel(classNumber: number): string | undefined {
  return CENTRAL_GRADE_LABELS.get(classNumber);
}

/**
 * 複数のグレードアイコンの class 属性値(例: `Icon_GradeType Icon_GradeType13 Icon_GradePos01`)から、
 * 表にある最初のグレードを返す。番号の無い・表に無い(重賞ではない・未測定の)アイコンは飛ばす。
 * 一覧(レース名の横のアイコン)と出馬表(`h1.RaceName` 内のアイコン)が共有する。
 */
export function centralGradeFromClassNames(classNames: readonly string[]): string | undefined {
  for (const className of classNames) {
    const digits = PATTERNS.gradeTypeNumber.exec(className)?.[1];
    if (digits === undefined) {
      continue;
    }
    const label = centralGradeLabel(Number(digits));
    if (label !== undefined) {
      return label;
    }
  }
  return undefined;
}
