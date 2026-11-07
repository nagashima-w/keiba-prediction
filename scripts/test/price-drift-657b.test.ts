import { describe, expect, it } from "vitest";
import { marketWinProbs, marketTop3Probs, wilson, bandDropFlags, weightBand } from "../../docs/investigations/price-drift-657/drift-b.js";

describe("marketWinProbs", () => {
  it("1/オッズを正規化して合計 1", () => {
    const q = marketWinProbs([2, 4, 4]);
    expect(q.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(q[0]).toBeCloseTo(0.5, 12);
    expect(q[1]).toBeCloseTo(0.25, 12);
  });
});

describe("marketTop3Probs", () => {
  it("合計が 3 で、勝率の順序を保ち、各値は勝率以上 1 以下", () => {
    const q = marketWinProbs([2, 3, 5, 8, 12, 20, 30, 50]);
    const t = marketTop3Probs(q);
    expect(t).not.toBeNull();
    expect(t!.reduce((a, b) => a + b, 0)).toBeCloseTo(3, 6);
    t!.forEach((v, i) => { expect(v).toBeGreaterThanOrEqual(q[i]!); expect(v).toBeLessThanOrEqual(1); });
    expect(t![0]).toBeGreaterThan(t![7]!);
  });
  it("3 頭以下は null(3 着内が全頭か意味を持たない)", () => {
    expect(marketTop3Probs(marketWinProbs([2, 3, 5]))).toBeNull();
  });
});

describe("wilson", () => {
  it("0/N と N/N も [0,1] に収まり、点推定を含む", () => {
    const a = wilson(0, 30), b = wilson(30, 30), c = wilson(6, 30);
    expect(a[0]).toBe(0); expect(b[1]).toBe(1);
    expect(c[0]).toBeLessThan(0.2); expect(c[1]).toBeGreaterThan(0.2);
    expect(c[0]).toBeCloseTo(0.0954, 3); // 6/30 の 95% Wilson 下限
    expect(c[1]).toBeCloseTo(0.3731, 3);
  });
});

describe("bandDropFlags", () => {
  it("帯ごとに ln 比の下位 10% を立てる(同順位は含めない)", () => {
    const hs = Array.from({ length: 20 }, (_, i) => ({ ninki: 1, ratio: 0.5 + i * 0.1 }));
    const f = bandDropFlags(hs);
    expect(f.filter(Boolean).length).toBe(2); // 20 頭の 10% = 2 頭
    expect(f[0]).toBe(true); expect(f[1]).toBe(true); expect(f[2]).toBe(false);
  });
  it("帯が違えば別に数える(7- 帯に比が大きい馬だけでも各帯から立つ)", () => {
    const hs = [...Array.from({ length: 10 }, (_, i) => ({ ninki: 1, ratio: 0.5 + i * 0.01 })), ...Array.from({ length: 10 }, (_, i) => ({ ninki: 9, ratio: 2 + i * 0.01 }))];
    const f = bandDropFlags(hs);
    expect(f.slice(0, 10).filter(Boolean).length).toBe(1);
    expect(f.slice(10).filter(Boolean).length).toBe(1);
  });
});

describe("weightBand", () => {
  it.each([[null, "不明"], [430, "-439"], [440, "440-479"], [479, "440-479"], [480, "480-519"], [520, "520-"]])("%s", (w, exp) => {
    expect(weightBand(w)).toBe(exp);
  });
});
