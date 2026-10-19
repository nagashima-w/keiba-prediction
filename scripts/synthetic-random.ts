/**
 * 実測スクリプト(`measure-verify.ts`・`measure-prior-export.ts`)が合成データを作るときの、固定の種の乱数と小数の置き換え。
 * Issue #394(移行機能の廃止)で、`measure-migration-import.ts` から移した(関数の本体は変えていない)。
 */

/** 固定の種の乱数(mulberry32)。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 小数(`1.234`)の値を、同じ桁数の別の値にする(圧縮率が、同じ値の繰り返しで実物より良くならないように)。 */
export function perturbDecimals(text: string, rand: () => number): string {
  return text.replace(/\d+\.\d+/g, (m) => {
    const decimals = m.length - m.indexOf(".") - 1;
    return (rand() * 10).toFixed(decimals);
  });
}
