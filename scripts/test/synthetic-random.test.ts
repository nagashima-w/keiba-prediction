import { describe, expect, it } from "vitest";
import { perturbDecimals, seededRandom } from "../synthetic-random.js";

/**
 * Issue #394: `measure-migration-import.test.ts` にあった perturbDecimals の検査を、そのまま移した(import 先だけ変えた)。
 * seededRandom の検査(同じ種は同じ列・違う種は違う列。`measure-d1-size.test.ts` と同じ観点)は、移した関数が同じ性質を保つことの確認として足した。
 */

describe("seededRandom(固定の種の乱数)", () => {
  it("同じ種なら同じ列、種が違えば違う列。値は [0, 1) に入る", () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    const c = seededRandom(2);
    const as = Array.from({ length: 5 }, () => a());
    const bs = Array.from({ length: 5 }, () => b());
    const cs = Array.from({ length: 5 }, () => c());
    expect(as).toEqual(bs);
    expect(as).not.toEqual(cs);
    expect(as.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe("perturbDecimals(小数の値を、同じ桁数の別の値にする)", () => {
  it("桁数は変えず、値は変わる。整数・文字列は触らない", () => {
    const text = '{"a":1.2345,"b":[0.5,12.25],"n":7,"s":"x"}';
    const out = perturbDecimals(text, seededRandom(1));
    expect(out).not.toBe(text);
    expect(out.replace(/\d+\.\d+/g, "N")).toBe(text.replace(/\d+\.\d+/g, "N"));
    expect([...out.matchAll(/\d+\.(\d+)/g)].map((m) => m[1]!.length)).toEqual([4, 1, 2]);
    expect(JSON.parse(out)).toMatchObject({ n: 7, s: "x" });
  });
});
