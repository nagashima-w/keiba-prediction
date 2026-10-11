/**
 * #156(#41-B)匿名のケース ID(`case-NN`)。サブエージェントに見せるファイル名から、
 * レース ID(日付・会場を含む)を伏せるための決定的なシャッフル。
 * 対応表(`index.json`)はサブエージェントの見える場所には置かない。
 */

/** ケース ID の割り当てに使うシード(取得前の計画 §匿名 ID で固定)。 */
export const CASE_ID_SEED = 20261002;

/** 決定論的な擬似乱数 mulberry32(core の実装は内部のため、ここに同じ式を持つ)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * レース ID に `case-01`〜`case-NN` を割り当てる。入力の並びに依らない(昇順に整列してから
 * シード付きの Fisher–Yates で並べ替える)。
 */
export function assignCaseIds(raceIds: readonly string[], seed: number = CASE_ID_SEED): Map<string, string> {
  const sorted = [...new Set(raceIds)].sort();
  const rand = mulberry32(seed);
  const order = [...sorted];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const width = Math.max(2, String(order.length).length);
  return new Map(order.map((raceId, i) => [raceId, `case-${String(i + 1).padStart(width, "0")}`]));
}
