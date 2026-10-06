import { describe, expect, it } from "vitest";
import { D1_FREE_DB_BYTES, seededRandom, yearsUntilFull } from "../measure-d1-size.js";

/**
 * Issue #171(#169-a): 容量の測定スクリプト(scripts/measure-d1-size.ts)の純関数の検査。
 * 測定そのもの(フィクスチャ・SQLite への保存)は、zlib のバージョン差で gzip 後の大きさが変わりうるため、テストでは固定しない。
 * 結果の値と N は docs/current-spec.md に記録してあり、`pnpm tsx scripts/measure-d1-size.ts` で再現できる。
 */
describe("yearsUntilFull(上限が埋まるまでの年数)", () => {
  it("上限 ÷ 1分析のバイト数 ÷ 年間件数(手計算: 500e6 / 6644 / 3500 = 21.5)", () => {
    expect(D1_FREE_DB_BYTES).toBe(500e6);
    expect(yearsUntilFull(6644, D1_FREE_DB_BYTES, 3500)).toBeCloseTo(21.5, 1);
    expect(yearsUntilFull(6644, D1_FREE_DB_BYTES, 20000)).toBeCloseTo(3.8, 1);
    expect(yearsUntilFull(144957, D1_FREE_DB_BYTES, 3500)).toBeCloseTo(0.99, 2);
  });

  it("1分析が大きいほど、年間件数が多いほど、短くなる(単調)", () => {
    expect(yearsUntilFull(2000, 500e6, 1000)).toBeGreaterThan(yearsUntilFull(4000, 500e6, 1000));
    expect(yearsUntilFull(2000, 500e6, 1000)).toBeGreaterThan(yearsUntilFull(2000, 500e6, 2000));
  });
});

describe("seededRandom(固定の種の乱数)", () => {
  it("同じ種なら同じ列を返し、種が違えば違う列を返す。値は [0, 1)", () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    const c = seededRandom(2);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    const seqC = Array.from({ length: 5 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of [...seqA, ...seqC]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBe(5);
  });
});
