import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../src/common/random.js";

/**
 * Issue #397(R-5): 決定論的な擬似乱数 mulberry32。core の確率の質の測定(再標本)と cloud の検証の内訳(ブートストラップ)が、同じ式を別々に持っていた。
 * 期待値は、統合前の式(`probability-quality-metrics.ts` の旧版)をそのまま実行して得た(統合前に Node で実行した)。
 */
describe("mulberry32", () => {
  const first5: ReadonlyArray<readonly [number, readonly number[]]> = [
    [0, [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086]],
    [42, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423]],
    [20261002, [0.06315100961364806, 0.41732687992043793, 0.2204791926778853, 0.3959570473525673, 0.28196659847162664]],
    [-1, [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489]],
  ];
  for (const [seed, expected] of first5) {
    it(`シード ${seed} の最初の 5 個が固定されている`, () => {
      const rand = mulberry32(seed);
      expect(expected.map(() => rand())).toEqual(expected);
    });
  }

  it("同じシードなら同じ列、別のシードなら別の列", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const seqA = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(seqA);
    expect(Array.from({ length: 20 }, () => c())).not.toEqual(seqA);
  });

  it("0 以上 1 未満", () => {
    const rand = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
