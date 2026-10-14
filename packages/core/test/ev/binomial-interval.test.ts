import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_Z_95,
  judgeCalibration,
  MIN_COUNT_FOR_JUDGMENT,
  wilsonInterval,
} from "../../src/ev/binomial-interval.js";

/**
 * Issue #254: 件数から求める 2 項比率の信頼区間(Wilson スコア区間・95%)と、予測値との照合の判定。
 *
 * 期待値の出所(式の写経ではない):
 *  - n=10 の 0 件・5 件・1 件は、Wilson 区間(z=1.96)の教科書的な値(小数 4 桁で一致するか)。
 *  - n=20〜400 の p=0.3 の値は、Issue #254 の着手前調査で別スクリプト(`/tmp` のスクラッチ)で計算した値。
 *  - 被覆確率は、**正確な 2 項分布**から求めた「区間が真の p を含む確率」が 95% 前後になること(z や式の取り違えを検出する独立な検査)。
 */

/** 小数 1 桁のパーセントに丸める(表の値との照合用)。 */
const pct = (x: number): number => Math.round(x * 1000) / 10;

describe("wilsonInterval(Wilson スコア区間・95%)", () => {
  it("z は 95% の両側分位点 1.959964", () => {
    expect(CONFIDENCE_Z_95).toBe(1.959964);
  });

  it("件数 0 は区間なし(null)", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it.each([
    // [成功, 試行, 下限, 上限]
    [0, 10, 0, 0.2775],
    [5, 10, 0.2366, 0.7634],
    [1, 10, 0.0179, 0.4042],
  ] as const)("n=10 の教科書値: %i/%i → [%f, %f]", (k, n, lower, upper) => {
    const w = wilsonInterval(k, n)!;
    expect(w.lower).toBeCloseTo(lower, 4);
    expect(w.upper).toBeCloseTo(upper, 4);
  });

  it.each([
    // p=0.3 で、件数が増えるほど狭くなる(下限%, 上限%)
    [6, 20, 14.5, 51.9],
    [15, 50, 19.1, 43.8],
    [30, 100, 21.9, 39.6],
    [120, 400, 25.7, 34.7],
    [300, 1000, 27.2, 32.9],
  ] as const)("p=0.3 の表: %i/%i → [%f%%, %f%%]", (k, n, lower, upper) => {
    const w = wilsonInterval(k, n)!;
    expect(pct(w.lower)).toBe(lower);
    expect(pct(w.upper)).toBe(upper);
  });

  it.each([
    [0, 20, 0.0, 16.1],
    [20, 20, 83.9, 100.0],
    [1, 20, 0.9, 23.6],
  ] as const)("端(0 件・全件・1 件): %i/%i → [%f%%, %f%%]。0 や 100 に張り付いても幅が 0 に潰れない", (k, n, lower, upper) => {
    const w = wilsonInterval(k, n)!;
    expect(pct(w.lower)).toBe(lower);
    expect(pct(w.upper)).toBe(upper);
    expect(w.upper - w.lower).toBeGreaterThan(0.1);
  });

  it("全件の区間は [0,1] の中に収まり、下限は 0 以上・上限は 1 以下(Wald のようにはみ出さない)", () => {
    let checked = 0;
    for (const n of [1, 2, 5, 20, 100, 400]) {
      for (let k = 0; k <= n; k++) {
        const w = wilsonInterval(k, n)!;
        expect(w.lower).toBeGreaterThanOrEqual(0);
        expect(w.upper).toBeLessThanOrEqual(1);
        expect(w.lower).toBeLessThanOrEqual(k / n);
        expect(w.upper).toBeGreaterThanOrEqual(k / n);
        checked += 1;
      }
    }
    expect(checked).toBe(2 + 3 + 6 + 21 + 101 + 401); // 前提: 空振りでない(全組を走査した)
  });

  it("0 件のとき下限は丸め誤差で負にならず、ちょうど 0(クランプ)。n=7 は式の値が約 -2.8e-17 になる入力", () => {
    // 前提: クランプ前の式の値が負になる入力(n=7)。式を写して確かめる(クランプが空振りでないことの固定)
    const z2 = CONFIDENCE_Z_95 * CONFIDENCE_Z_95;
    const n = 7;
    const raw = z2 / (2 * n) / (1 + z2 / n) - (CONFIDENCE_Z_95 * Math.sqrt(z2 / (4 * n * n))) / (1 + z2 / n);
    expect(raw).toBeLessThan(0);
    expect(wilsonInterval(0, n)!.lower).toBe(0);
    // 全件のとき上限もちょうど 1(同様に丸め誤差で 1 を超えない)
    for (const m of [1, 3, 7, 20, 100]) {
      expect(wilsonInterval(m, m)!.upper).toBeLessThanOrEqual(1);
      expect(wilsonInterval(0, m)!.lower).toBeGreaterThanOrEqual(0);
    }
  });

  it("対称性: wilson(k, n) の下限 = 1 − wilson(n−k, n) の上限", () => {
    for (const [k, n] of [[3, 17], [30, 100], [1, 20]] as const) {
      const a = wilsonInterval(k, n)!;
      const b = wilsonInterval(n - k, n)!;
      expect(a.lower).toBeCloseTo(1 - b.upper, 12);
      expect(a.upper).toBeCloseTo(1 - b.lower, 12);
    }
  });

  it("同じ率で件数が増えると、幅は狭くなる(前提: 幅が 0 でない)", () => {
    const widths = [20, 50, 100, 400, 1000, 4000].map((n) => {
      const w = wilsonInterval(Math.round(0.3 * n), n)!;
      return w.upper - w.lower;
    });
    expect(widths[widths.length - 1]).toBeGreaterThan(0);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
    }
  });

  it("被覆確率(正確な 2 項分布): 真の p を区間が含む確率が 95% 前後(93〜97%)。z や式の取り違えを検出する", () => {
    const logGamma = (x: number): number => {
      const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
      let y = x;
      let t = x + 5.5;
      t -= (x + 0.5) * Math.log(t);
      let s = 1.000000000190015;
      for (const a of c) s += a / ++y;
      return -t + Math.log((2.5066282746310005 * s) / x);
    };
    const pmf = (n: number, k: number, p: number): number =>
      Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p));
    const coverage = (n: number, p: number): number => {
      let cover = 0;
      for (let k = 0; k <= n; k++) {
        const w = wilsonInterval(k, n)!;
        if (w.lower <= p && p <= w.upper) cover += pmf(n, k, p);
      }
      return cover;
    };
    // 前提(空振り防止): 全確率が 1 になる(pmf が正しい)
    let total = 0;
    for (let k = 0; k <= 100; k++) total += pmf(100, k, 0.3);
    expect(total).toBeCloseTo(1, 9);
    for (const [n, p] of [[100, 0.3], [400, 0.3], [100, 0.1], [400, 0.5], [1000, 0.2]] as const) {
      const c = coverage(n, p);
      expect(c, `n=${n} p=${p}`).toBeGreaterThan(0.93);
      expect(c, `n=${n} p=${p}`).toBeLessThan(0.97);
    }
  });

  it("不正な入力(負・成功が試行を超える・非整数・非有限)は例外", () => {
    expect(() => wilsonInterval(-1, 10)).toThrow();
    expect(() => wilsonInterval(11, 10)).toThrow();
    expect(() => wilsonInterval(1.5, 10)).toThrow();
    expect(() => wilsonInterval(1, Number.NaN)).toThrow();
    expect(() => wilsonInterval(1, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("judgeCalibration(予測値と区間の照合)", () => {
  it("判定に要る最小件数は 30", () => {
    expect(MIN_COUNT_FOR_JUDGMENT).toBe(30);
  });

  it("予測が区間の中なら consistent、上なら overpredicted(予測が高い=過信)、下なら underpredicted", () => {
    // 100 件中 30 件 → Wilson [21.9%, 39.6%]
    const base = { predicted: 100, placed: 30 };
    const inside = judgeCalibration({ ...base, meanPredictedProb: 0.3 });
    expect(inside.interval).not.toBeNull();
    expect(inside.verdict).toBe("consistent");
    expect(judgeCalibration({ ...base, meanPredictedProb: 0.41 }).verdict).toBe("overpredicted");
    expect(judgeCalibration({ ...base, meanPredictedProb: 0.2 }).verdict).toBe("underpredicted");
  });

  it("区間の境界ちょうどは『区間内』(下限・上限を含む)", () => {
    const w = wilsonInterval(30, 100)!;
    expect(judgeCalibration({ predicted: 100, placed: 30, meanPredictedProb: w.lower }).verdict).toBe("consistent");
    expect(judgeCalibration({ predicted: 100, placed: 30, meanPredictedProb: w.upper }).verdict).toBe("consistent");
    expect(judgeCalibration({ predicted: 100, placed: 30, meanPredictedProb: w.upper + 1e-9 }).verdict).toBe("overpredicted");
    expect(judgeCalibration({ predicted: 100, placed: 30, meanPredictedProb: w.lower - 1e-9 }).verdict).toBe("underpredicted");
  });

  it("全件が複勝圏で平均予測も 1.0(または 0 件で 0.0)なら、丸め誤差で区間の端を超えて『高い/低い』にならず consistent(予測−実績が 0 の行が判定だけ食い違わない)", () => {
    let checked = 0;
    for (const n of [30, 31, 50, 100, 400, 1000]) {
      const hi = wilsonInterval(n, n)!;
      const lo = wilsonInterval(0, n)!;
      // 前提(空振り防止): 区間の端が 1.0 / 0.0 に(ほぼ)一致しているが、浮動小数では厳密に一致するとは限らない入力を含む
      expect(1 - hi.upper).toBeLessThan(1e-9);
      expect(lo.lower).toBeLessThan(1e-9);
      expect(judgeCalibration({ predicted: n, placed: n, meanPredictedProb: 1 }).verdict).toBe("consistent");
      expect(judgeCalibration({ predicted: n, placed: 0, meanPredictedProb: 0 }).verdict).toBe("consistent");
      checked += 2;
    }
    expect(checked).toBe(12);
  });

  it("30 件未満は区間は出すが判定は insufficient。予測が区間の外でも判定しない(29 件と 30 件の境界)", () => {
    // 29 件中 0 件で予測 0.5: 30 件ならはっきり overpredicted になる入力
    const at29 = judgeCalibration({ predicted: 29, placed: 0, meanPredictedProb: 0.5 });
    expect(at29.interval).not.toBeNull();
    expect(at29.verdict).toBe("insufficient");
    const at30 = judgeCalibration({ predicted: 30, placed: 0, meanPredictedProb: 0.5 });
    expect(at30.verdict).toBe("overpredicted"); // 対照: 同じ形で 30 件なら判定が出る
  });

  it("0 件は区間も判定もなし(null)", () => {
    expect(judgeCalibration({ predicted: 0, placed: 0, meanPredictedProb: null })).toEqual({ interval: null, verdict: null });
  });

  it("件数が足りていて平均予測値が無い(null)なら、区間は出すが判定は null(偽の判定を作らない)", () => {
    const r = judgeCalibration({ predicted: 100, placed: 30, meanPredictedProb: null });
    expect(r.interval).not.toBeNull();
    expect(r.verdict).toBeNull();
  });
});

describe("モジュールの性質", () => {
  it("import を 1 つも持たない(ブラウザのクライアントが直接取り込む。node:・node_modules・バレルを引き込まない)", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/ev/binomial-interval.ts", import.meta.url)), "utf-8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(code.length).toBeGreaterThan(500); // 前提: コメントを除いても本体が残っている(空の文字列を検査していない)
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bfrom\s+["']/);
  });
});
