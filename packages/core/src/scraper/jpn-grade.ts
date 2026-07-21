/**
 * 交流重賞(Jpn1/2/3)判定・絞り込みの純関数。
 *
 * 地方(NAR)のレース一覧には中央馬も出走できる「交流重賞」があり、grade表記が
 * "Jpn1"/"Jpn2"/"Jpn3"(まれにローマ数字)になる。中央の数値クラス→gradeマッピングや
 * 地方重賞("重賞")・OP・Lとの区別は行わず、あくまでJpn表記のみを対象とする
 * (中央の数値クラス→gradeマッピングは本関数のスコープ外)。
 */

import { PATTERNS } from "./selectors.js";
import type { RaceListEntry } from "./types.js";

/**
 * grade文字列が交流重賞(Jpn1/2/3)かどうかを判定する。
 * 前後の空白は許容するが、全角数字("Jpn１")は不受理とする。
 *
 * @param grade RaceListEntry.grade(未定義・空文字はfalse)
 */
export function isJpnGrade(grade?: string): boolean {
  if (grade === undefined) {
    return false;
  }
  return PATTERNS.jpnGrade.test(grade.trim());
}

/**
 * レース一覧からJpn(交流重賞)のみを抽出する。
 * grade が undefined の行(通常戦・重賞・OP等を含む)はすべて除外される。
 *
 * @param entries レース一覧(parseRaceList の戻り値等)
 */
export function filterJpnOnlyEntries(
  entries: RaceListEntry[],
): RaceListEntry[] {
  return entries.filter((entry) => isJpnGrade(entry.grade));
}
