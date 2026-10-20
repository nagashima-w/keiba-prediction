/**
 * レースの条件(負担重量の種別・牝馬限定)を、出馬表の `.RaceData02` の span から読む純関数(Issue #421 段階 1)。
 *
 * 外部に依存しない(`node:zlib` なども import しない)。出馬表のパーサ(`parse-shutuba.ts`)が使う。
 * 前走の条件(新聞形式の API。段階 1 の b)でも、牝馬限定の判定はここの {@link isFilliesOnlyCondition} を共有する。
 *
 * 読み方の方針:
 *  - 種別は span の文字列と**完全一致**で拾う(部分一致にすると、条件の span ではない「…ハンデ戦」に当たる)。位置には依存しない
 *    (条件記号の span は有無が変わるため)。
 *  - 種別が見つからない・異なる種別が 2 種類以上出た(曖昧)ときは、種別を付けない(推測しない)。
 *  - 牝馬限定は、いずれかの span が「牝」を含むか(`牝[指]`・`(国際)牝(指)`。実フィクスチャで確認)。
 */

/** 負担重量の種別。中央の出馬表・結果の `.RaceData02` に、このうち 1 つが入る。 */
export const WEIGHT_TYPES = ["ハンデ", "別定", "定量", "馬齢"] as const;

export type WeightType = (typeof WEIGHT_TYPES)[number];

/** 条件の文字列(出馬表の条件の span、または API の `kigou`)が牝馬限定を示すか。 */
export function isFilliesOnlyCondition(text: string): boolean {
  return text.includes("牝");
}

/** {@link readRaceConditions} の結果。`filliesOnly` は常に確定値、`weightType` は読めたときだけキーを持つ。 */
export interface RaceConditions {
  readonly weightType?: WeightType;
  readonly filliesOnly: boolean;
}

/** 空白(全角を含む)を除いた span の文字列にする。 */
function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * `.RaceData02` の中の span の文字列から、レースの条件を読む。
 * 呼び出し側が `.RaceData02` を見つけたときだけ呼ぶ(見つからないときは条件のキーを一切付けない)。
 */
export function readRaceConditions(spanTexts: readonly string[]): RaceConditions {
  const texts = spanTexts.map(compact);
  const found = new Set<WeightType>();
  for (const text of texts) {
    const hit = WEIGHT_TYPES.find((w) => w === text);
    if (hit !== undefined) {
      found.add(hit);
    }
  }
  const only = found.size === 1 ? [...found][0] : undefined;
  return {
    ...(only !== undefined ? { weightType: only } : {}),
    filliesOnly: texts.some(isFilliesOnlyCondition),
  };
}
