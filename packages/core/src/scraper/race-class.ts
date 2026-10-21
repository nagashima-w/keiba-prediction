/**
 * レースのクラスを、出馬表・結果ページの `.RaceData02` の span から読む純関数(Issue #426〈#389 の案 B〉)。
 *
 * 外部に依存しない(`node:zlib` なども import しない)。出馬表のパーサ(`parse-shutuba.ts`)と結果ページ(`parse-race-class.ts`)が使う。
 * 負担重量の種別・牝馬限定を読む `race-condition.ts` と同じ形で、**推測しない**(読めない・曖昧は undefined)。
 *
 * ## 中央
 * クラスは独立した span(`サラ系３歳` の次の `オープン` など)。各 span を **NFKC 正規化(全角数字を半角に)・空白除去**したうえで、{@link CENTRAL_RACE_CLASSES} と
 * **完全一致**するものを拾う(位置には依存しない。部分一致にすると「オープン特別」などを拾う)。異なるクラスが 2 種類以上出たら曖昧として読まない。値は正準ラベル(半角数字)。
 * - 「オープン」は重賞・リステッド・OP を区別しない(区別はグレードのアイコン番号。今回は読まない)。
 * - 旧表記(`500万下` など)は語彙に入れない(2019 年に廃止。2026 年の分析には出ない)。
 *
 * ## 地方
 * クラスは独立した span ではなく、年齢条件の span の後半(`サラ系一般 C1`・`サラ系３歳 C1`・`サラ系４歳以上 A2B1`・`サラ系４歳以上 4上`)。
 * 「サラ系／アラブ系／混合 + 年齢条件 + 空白 + 区分」の形の span の**区分(空白区切りの最後のトークン)を生のまま**持つ。語彙は固定しない
 * (A・B1〜B4・C1〜C4・A2B1 などの複合・「3歳」「4上」のような年齢限定の表記が混ざる。どう分けるかは読む側〈#389-c〉の仕事)。
 * 区分の無い span(ばんえいの `混合５歳以上 ` など)は読めない。自由文の疑いのある長いトークン({@link NAR_CLASS_MAX_LENGTH} 文字超)も読まない。
 */

import type { RaceIdVenueKind } from "./ids.js";

/** 中央のクラスの正準ラベル(半角数字)。`RaceData02` の span は全角数字だが、NFKC 正規化して照合する。 */
export const CENTRAL_RACE_CLASSES = ["新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン"] as const;

export type CentralRaceClass = (typeof CENTRAL_RACE_CLASSES)[number];

/** 地方の区分のトークンの最大文字数(これを超えるものは自由文の疑いで読まない)。 */
export const NAR_CLASS_MAX_LENGTH = 20;

/** 地方の年齢条件の span(`サラ系一般 C1`)。区分は 2 番目の捕捉。 */
const NAR_CLASS_SPAN = /^(?:サラ系|アラブ系|混合)\S*\s+(\S+)$/;

/** 空白(全角・nbsp を含む)を除いた、NFKC 正規化後の文字列にする。 */
function compactNfkc(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "");
}

function readCentral(spanTexts: readonly string[]): CentralRaceClass | undefined {
  const found = new Set<CentralRaceClass>();
  for (const text of spanTexts.map(compactNfkc)) {
    const hit = CENTRAL_RACE_CLASSES.find((c) => c === text);
    if (hit !== undefined) {
      found.add(hit);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

function readNar(spanTexts: readonly string[]): string | undefined {
  const found = new Set<string>();
  for (const text of spanTexts) {
    const token = NAR_CLASS_SPAN.exec(text.trim())?.[1];
    if (token !== undefined && Array.from(token).length <= NAR_CLASS_MAX_LENGTH) {
      found.add(token);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * `.RaceData02` の中の span の文字列から、レースのクラスを読む。読めない・曖昧なときは undefined。
 * @param kind 中央か地方か(`venueKindOfRaceId`)。中央の語彙は地方では、地方の区分は中央では読まない。
 */
export function readRaceClass(spanTexts: readonly string[], kind: RaceIdVenueKind): string | undefined {
  return kind === "central" ? readCentral(spanTexts) : readNar(spanTexts);
}
