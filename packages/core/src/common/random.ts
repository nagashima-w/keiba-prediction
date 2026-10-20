/**
 * 決定論的な擬似乱数(Issue #397・R-5)。**import を持たない純モジュール**。クライアントの束には入れない(使わない)。
 * 以前は core の確率の質の測定(再標本)と cloud の検証の内訳(ブートストラップ)が、同じ式を別々に持っていた。
 */

/** 決定論的な擬似乱数 mulberry32(0 以上 1 未満)。同じシードなら同じ列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
