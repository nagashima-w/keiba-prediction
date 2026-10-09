import { describe, expect, it } from "vitest";
import {
  bootstrapBrierDifferenceByRace,
  brierSkillScore,
  withinRacePermutationResolution,
  computeBrierDecomposition,
  computeBrierScore,
  type BrierObservation,
  type RaceSquaredErrorPair,
} from "../../src/ev/probability-quality-metrics.js";
import { binIndexFor, DEFAULT_QUALITY_BIN_COUNT } from "../../src/ev/calibration-bins.js";
import { AnalysisStore } from "../../src/ev/analysis-store.js";
import { computeVerifyReport, DEFAULT_VERIFY_CONFIG } from "../../src/ev/verify.js";

/**
 * 二値事象(3着以内に入ったか)の Brier スコアと Murphy 分解(#41「#35-1b」)。
 *
 * 帯の切り方は検証画面のキャリブレーションと共有(`calibration-bins.ts`。同じ帯数を渡せば同じ帯になる)。
 * 既定の帯数は10(`DEFAULT_QUALITY_BIN_COUNT`。検証画面の既定は20で、別。#37)。帯で丸めた分解は
 * `BS = REL − RES + UNC` が**近似でしか成り立たない**ため、残差(帯内分散の項と帯内共分散の項)を
 * REL/RES/UNC とは**独立に**算出し、恒等式
 * `BS = REL − RES + UNC + (帯内分散 − 2×帯内共分散)` が残差込みで一致することを固定する
 * (BS から逆算した残差では恒等式テストが循環して何も守れない)。
 */

/** 期待値の手計算は各テストの直前コメントに書く(実装の出力を写していない)。 */
function obs(probability: number, occurred: boolean): BrierObservation {
  return { probability, occurred };
}

/** 決定論的な擬似乱数(mulberry32)。テストデータ生成用。 */
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

describe("computeBrierScore: (確率−結果)² の平均", () => {
  it("手計算: [0.8→的中, 0.3→外れ] は (0.04+0.09)/2=0.065", () => {
    const r = computeBrierScore([obs(0.8, true), obs(0.3, false)]);
    expect(r.reason).toBeNull();
    expect(r.value).toBeCloseTo(0.065, 12);
  });

  it("完全予測(1.0→的中・0.0→外れ)は0", () => {
    expect(computeBrierScore([obs(1, true), obs(0, false)]).value).toBe(0);
  });

  it("完全に外れた確信(1.0→外れ・0.0→的中)は1", () => {
    expect(computeBrierScore([obs(1, false), obs(0, true)]).value).toBe(1);
  });

  const invalid: ReadonlyArray<{ readonly name: string; readonly input: readonly BrierObservation[] }> = [
    { name: "空入力", input: [] },
    { name: "NaN", input: [obs(0.5, true), obs(Number.NaN, false)] },
    { name: "Infinity", input: [obs(Number.POSITIVE_INFINITY, true)] },
    { name: "負の確率", input: [obs(-0.01, true)] },
    { name: "1を超える確率", input: [obs(1.0000001, true)] },
  ];
  it.each(invalid)("$name は reason 付きの null(もっともらしい数値を返さない)", ({ input }) => {
    const r = computeBrierScore(input);
    expect(r.value).toBeNull();
    expect(typeof r.reason).toBe("string");
    expect((r.reason as string).length).toBeGreaterThan(0);
  });

  it("確率ちょうど 0 と 1 は範囲内として受理する(境界)", () => {
    expect(computeBrierScore([obs(0, false), obs(1, true)]).reason).toBeNull();
  });
});

describe("brierSkillScore: 1 − BS_model / BS_reference", () => {
  const table: ReadonlyArray<{
    readonly name: string;
    readonly model: number;
    readonly reference: number;
    readonly expected: number | null;
  }> = [
    { name: "基準より2割良い(0.20 vs 0.25)は +0.2", model: 0.2, reference: 0.25, expected: 0.2 },
    { name: "基準と同じは 0", model: 0.25, reference: 0.25, expected: 0 },
    { name: "基準より悪い(0.30 vs 0.25)は −0.2", model: 0.3, reference: 0.25, expected: -0.2 },
    { name: "完全予測(0 vs 0.25)は 1", model: 0, reference: 0.25, expected: 1 },
    { name: "基準が0はゼロ除算で null", model: 0.1, reference: 0, expected: null },
    { name: "NaN は null", model: Number.NaN, reference: 0.25, expected: null },
    { name: "負の基準は null", model: 0.1, reference: -0.1, expected: null },
  ];
  it.each(table)("$name", ({ model, reference, expected }) => {
    const r = brierSkillScore(model, reference);
    if (expected === null) {
      expect(r.value).toBeNull();
      expect(typeof r.reason).toBe("string");
    } else {
      expect(r.reason).toBeNull();
      expect(r.value).toBeCloseTo(expected, 12);
    }
  });
});

describe("computeBrierDecomposition: 退化・境界ケースの手計算", () => {
  it("完全予測(1.0→的中×2・0.0→外れ×2): BS=0・REL=0・RES=UNC=0.25・残差0", () => {
    // ō=0.5 → UNC=0.25。帯9(p̄=1,ō_k=1)・帯0(p̄=0,ō_k=0)で REL=0。RES=½(1−.5)²+½(0−.5)²=0.25。
    const r = computeBrierDecomposition([obs(1, true), obs(1, true), obs(0, false), obs(0, false)]);
    expect(r.reason).toBeNull();
    const d = r.decomposition!;
    expect(d.n).toBe(4);
    expect(d.brier).toBe(0);
    expect(d.baseRate).toBe(0.5);
    expect(d.reliability).toBe(0);
    expect(d.resolution).toBeCloseTo(0.25, 12);
    expect(d.uncertainty).toBeCloseTo(0.25, 12);
    expect(d.withinBinResidual).toBe(0);
  });

  it("全外れ(1.0を予測して全て不発): BS=1・REL=1・RES=0・UNC=0", () => {
    const d = computeBrierDecomposition([obs(1, false), obs(1, false)]).decomposition!;
    expect(d.brier).toBe(1);
    expect(d.baseRate).toBe(0);
    expect(d.reliability).toBe(1);
    expect(d.resolution).toBe(0);
    expect(d.uncertainty).toBe(0);
    expect(d.withinBinResidual).toBe(0);
  });

  it("全的中(0.5を予測して全て的中): BS=REL=0.25・RES=UNC=0", () => {
    // 帯5: p̄=0.5, ō_k=1 → REL=0.25。ō=1 → UNC=0, RES=0。
    const d = computeBrierDecomposition([obs(0.5, true), obs(0.5, true)]).decomposition!;
    expect(d.brier).toBeCloseTo(0.25, 12);
    expect(d.reliability).toBeCloseTo(0.25, 12);
    expect(d.resolution).toBe(0);
    expect(d.uncertainty).toBe(0);
  });

  it("一定予測 p=0.3 が事実の率(3/10)と一致: BS=UNC=0.21・REL=0・RES=0(識別力なしだが較正は完全)", () => {
    // BS=(3×0.49+7×0.09)/10=0.21。ō=0.3 → UNC=0.3×0.7=0.21。p̄=ō → REL=0。単一帯 → RES=0。
    const input: BrierObservation[] = [];
    for (let i = 0; i < 10; i++) {
      input.push(obs(0.3, i < 3));
    }
    const d = computeBrierDecomposition(input).decomposition!;
    expect(d.brier).toBeCloseTo(0.21, 12);
    expect(d.uncertainty).toBeCloseTo(0.21, 12);
    expect(d.reliability).toBeCloseTo(0, 12);
    expect(d.resolution).toBe(0);
    expect(d.withinBinResidual).toBeCloseTo(0, 12);
  });

  it("一定予測 p=0.5 で事実の率が 1/4: BS=0.25・REL=0.0625(較正ずれ)・UNC=0.1875・RES=0", () => {
    // ō=0.25。BS=(0.25×4)/4=0.25(1件的中(0.25)+3件外れ(0.25)=1.0/4)。REL=(0.5−0.25)²=0.0625。
    const d = computeBrierDecomposition([
      obs(0.5, true),
      obs(0.5, false),
      obs(0.5, false),
      obs(0.5, false),
    ]).decomposition!;
    expect(d.brier).toBeCloseTo(0.25, 12);
    expect(d.reliability).toBeCloseTo(0.0625, 12);
    expect(d.uncertainty).toBeCloseTo(0.1875, 12);
    expect(d.resolution).toBe(0);
  });

  it("帯内に散らばりがある場合の残差を手計算と照合する(0.1 と 0.19 はともに第2帯)", () => {
    // 手計算: BS=((0.1−0)²+(0.19−1)²)/2=(0.01+0.6561)/2=0.33305。p̄=0.145, ō=0.5。
    // REL=(0.145−0.5)²=0.126025。RES=0(単一帯)。UNC=0.25。
    // 帯内分散=((−0.045)²+0.045²)/2=0.002025。帯内共分散=((−0.045)(−0.5)+(0.045)(0.5))/2=0.0225。
    // 残差=0.002025−2×0.0225=−0.042975。REL−RES+UNC+残差=0.126025+0.25−0.042975=0.33305(一致)。
    const d = computeBrierDecomposition([obs(0.1, false), obs(0.19, true)]).decomposition!;
    expect(binIndexFor(0.1, 10)).toBe(binIndexFor(0.19, 10)); // 前提: 同じ帯
    expect(d.brier).toBeCloseTo(0.33305, 12);
    expect(d.reliability).toBeCloseTo(0.126025, 12);
    expect(d.resolution).toBe(0);
    expect(d.uncertainty).toBeCloseTo(0.25, 12);
    expect(d.withinBinVariance).toBeCloseTo(0.002025, 12);
    expect(d.withinBinCovariance).toBeCloseTo(0.0225, 12);
    expect(d.withinBinResidual).toBeCloseTo(-0.042975, 12);
    // 帯内共分散は負にも正にもなりうる量なので「分散の項」とは別名で持つ(残差が分散だけでない証拠)。
    expect(d.withinBinResidual).not.toBeCloseTo(d.withinBinVariance, 6);
  });

  it("帯の境界: 0.1 ちょうどは第2帯、0.0999 は先頭帯、1.0 は最終帯に入る", () => {
    const d = computeBrierDecomposition([obs(0.0999, false), obs(0.1, false), obs(1, true)]).decomposition!;
    expect(d.bins).toHaveLength(10);
    expect(d.bins[0]!.count).toBe(1);
    expect(d.bins[1]!.count).toBe(1);
    expect(d.bins[9]!.count).toBe(1);
    expect(d.bins.reduce((s, b) => s + b.count, 0)).toBe(3);
  });

  it("空の帯は件数0・平均予測と実績率が null(0 を返して的中率0%と誤読させない)", () => {
    const d = computeBrierDecomposition([obs(0.5, true)]).decomposition!;
    const empty = d.bins[0]!;
    expect(empty.count).toBe(0);
    expect(empty.meanForecast).toBeNull();
    expect(empty.observedRate).toBeNull();
    expect(d.bins[5]!.count).toBe(1);
    expect(d.bins[5]!.meanForecast).toBe(0.5);
    expect(d.bins[5]!.observedRate).toBe(1);
  });

  it("各帯の境界は検証画面のキャリブレーション帯と同じ(下限=index/10)", () => {
    const d = computeBrierDecomposition([obs(0.5, true)]).decomposition!;
    for (let i = 0; i < 10; i++) {
      expect(d.bins[i]!.lowerBound).toBe(i / 10);
      expect(d.bins[i]!.upperBound).toBe((i + 1) / 10);
    }
  });

  it("帯数を省略すると既定は10帯(DEFAULT_QUALITY_BIN_COUNT。検証画面の既定20とは別。#37)", () => {
    const d = computeBrierDecomposition([obs(0.5, true)]).decomposition!;
    expect(DEFAULT_QUALITY_BIN_COUNT).toBe(10);
    expect(DEFAULT_VERIFY_CONFIG.calibrationBins).not.toBe(DEFAULT_QUALITY_BIN_COUNT); // 前提: 2つの既定は別
    expect(d.bins).toHaveLength(10);
  });

  it("帯数を引数で変えられる(5帯なら 0.2 は第2帯)", () => {
    const d = computeBrierDecomposition([obs(0.2, true)], 5).decomposition!;
    expect(d.bins).toHaveLength(5);
    expect(d.bins[1]!.count).toBe(1);
  });
});

describe("computeBrierDecomposition: 不正入力は reason 付き null", () => {
  const table: ReadonlyArray<{ readonly name: string; readonly input: readonly BrierObservation[] }> = [
    { name: "空入力", input: [] },
    { name: "NaN を1件含む", input: [obs(0.2, true), obs(Number.NaN, false)] },
    { name: "Infinity を含む", input: [obs(Number.POSITIVE_INFINITY, false)] },
    { name: "負の確率を含む", input: [obs(-0.0001, false)] },
    { name: "1 を超える確率を含む(クリップしない)", input: [obs(1.0001, true)] },
  ];
  it.each(table)("$name", ({ input }) => {
    const r = computeBrierDecomposition(input);
    expect(r.decomposition).toBeNull();
    expect(typeof r.reason).toBe("string");
    expect((r.reason as string).length).toBeGreaterThan(0);
  });

  it("帯数が正の整数でないと null", () => {
    expect(computeBrierDecomposition([obs(0.5, true)], 0).decomposition).toBeNull();
    expect(computeBrierDecomposition([obs(0.5, true)], 2.5).decomposition).toBeNull();
  });
});

describe("computeBrierDecomposition: 恒等式 BS = REL − RES + UNC + 残差(残差は独立に算出)", () => {
  /** 予測に弱い識別力がある擬似データ(帯内にも散らばるよう連続値)。 */
  function synthetic(n: number, seed: number, signal: number): BrierObservation[] {
    const rand = mulberry32(seed);
    const out: BrierObservation[] = [];
    for (let i = 0; i < n; i++) {
      const latent = rand();
      // 予測は latent の周りに散らす。実際の的中確率は signal の強さで latent に依存する。
      const p = Math.min(0.95, Math.max(0.02, 0.05 + 0.5 * latent + 0.05 * rand()));
      const trueRate = signal * latent * 0.8 + (1 - signal) * 0.3;
      out.push(obs(p, rand() < trueRate));
    }
    return out;
  }

  const cases: ReadonlyArray<{ readonly name: string; readonly input: readonly BrierObservation[] }> = [
    { name: "識別力あり n=400", input: synthetic(400, 11, 1) },
    { name: "識別力なし n=400", input: synthetic(400, 22, 0) },
    { name: "中間 n=60(小標本)", input: synthetic(60, 33, 0.5) },
  ];

  it.each(cases)("$name: 恒等式が残差込みで機械精度に一致する", ({ input }) => {
    const d = computeBrierDecomposition(input).decomposition!;
    // 前提(空振り防止): 複数帯が埋まっており、残差が自明に0でない。
    expect(d.bins.filter((b) => b.count > 0).length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(d.withinBinResidual)).toBeGreaterThan(1e-5);
    expect(d.withinBinVariance).toBeGreaterThan(0);
    // 残差が REL/RES/UNC と独立に作られていること: 残差=分散−2×共分散(BS からの逆算ではない)。
    expect(d.withinBinResidual).toBeCloseTo(d.withinBinVariance - 2 * d.withinBinCovariance, 14);
    // 恒等式。
    const recomposed = d.reliability - d.resolution + d.uncertainty + d.withinBinResidual;
    expect(Math.abs(d.brier - recomposed)).toBeLessThan(1e-12);
  });

  it("残差を無視した近似 REL−RES+UNC は BS から有意にずれる(残差の項が必要な理由)", () => {
    const d = computeBrierDecomposition(synthetic(400, 11, 1)).decomposition!;
    const approx = d.reliability - d.resolution + d.uncertainty;
    expect(Math.abs(d.brier - approx)).toBeGreaterThan(1e-5);
  });

  it("brier は computeBrierScore と同じ値(分解経由でも直接平均でも同じ)", () => {
    const input = synthetic(150, 44, 0.7);
    expect(computeBrierDecomposition(input).decomposition!.brier).toBeCloseTo(
      computeBrierScore(input).value!,
      14,
    );
  });
});

describe("bootstrapBrierDifferenceByRace: レース単位の再標本化(固定シード)", () => {
  /** 1レース分: 頭数 count、モデルと市場の二乗誤差の合計。 */
  function pair(count: number, modelSse: number, marketSse: number): RaceSquaredErrorPair {
    return { count, modelSse, marketSse };
  }
  const OPTIONS = { iterations: 10000, seed: 20261001 } as const;

  it("同じ入力・同じシードなら完全に同じ結果(決定論的)", () => {
    const pairs = [pair(10, 2.0, 1.5), pair(12, 2.2, 2.4), pair(9, 1.8, 1.7), pair(11, 2.5, 2.0)];
    const a = bootstrapBrierDifferenceByRace(pairs, OPTIONS);
    const b = bootstrapBrierDifferenceByRace(pairs, OPTIONS);
    expect(a).toEqual(b);
    expect(a.reason).toBeNull();
  });

  it("観測値(全レース合算の BS 差)を点推定として返す", () => {
    // Σ model=2.0+2.2=4.2, Σ market=1.5+2.4=3.9, 頭数計 22 → (4.2−3.9)/22。
    const r = bootstrapBrierDifferenceByRace([pair(10, 2.0, 1.5), pair(12, 2.2, 2.4)], OPTIONS);
    expect(r.value).toBeCloseTo(0.3 / 22, 12);
  });

  it("2レース(差が +1.0 と −1.0)の区間は、再標本 AA/AB/BB の極値 ±0.1 に一致する", () => {
    // 同頭数10のレースA: モデル−市場=+1.0、レースB: −1.0。
    // 再標本 (A,A)→(+2.0/20=+0.1)、(B,B)→−0.1、(A,B)(B,A)→0。極値は各 1/4 の確率で現れるため
    // 10000回なら 2.5%/97.5% 点は ±0.1 ちょうど(シードに依らない)。
    const r = bootstrapBrierDifferenceByRace([pair(10, 2.0, 1.0), pair(10, 1.0, 2.0)], OPTIONS);
    expect(r.value).toBeCloseTo(0, 12);
    expect(r.lower).toBeCloseTo(-0.1, 12);
    expect(r.upper).toBeCloseTo(0.1, 12);
  });

  it("4レースのうち1レースだけ差がある場合、区間の端は最大値ではなく 2.5%/97.5% 点になる", () => {
    // レースA(差 +1.0)を k 回引く確率は Bin(4,1/4)。統計量=k×1.0/40。
    // P(k=4)=0.39% < 2.5% < P(k≥3)=5.08% なので、97.5%点は k=3 の 0.075(最大値 0.1 ではない)。
    // 下側も対称に、差が −1.0 なら 2.5%点は −0.075(最小値 −0.1 ではない)。
    const upperCase = bootstrapBrierDifferenceByRace(
      [pair(10, 2.0, 1.0), pair(10, 1, 1), pair(10, 1, 1), pair(10, 1, 1)],
      OPTIONS,
    );
    expect(upperCase.value).toBeCloseTo(0.025, 12);
    expect(upperCase.upper).toBeCloseTo(0.075, 12);
    const lowerCase = bootstrapBrierDifferenceByRace(
      [pair(10, 1.0, 2.0), pair(10, 1, 1), pair(10, 1, 1), pair(10, 1, 1)],
      OPTIONS,
    );
    expect(lowerCase.lower).toBeCloseTo(-0.075, 12);
  });

  it("すべてのレースで同じ差なら区間は点に縮む(再標本化が差を作らない)", () => {
    const r = bootstrapBrierDifferenceByRace(
      [pair(10, 2.0, 1.0), pair(10, 2.0, 1.0), pair(10, 2.0, 1.0)],
      OPTIONS,
    );
    expect(r.lower).toBeCloseTo(0.1, 12);
    expect(r.upper).toBeCloseTo(0.1, 12);
  });

  it("全レースでモデルが悪い(差が正)なら、区間の下限も正になる", () => {
    const pairs = [pair(10, 3, 2), pair(11, 3.2, 2.1), pair(9, 2.7, 1.9), pair(12, 3.5, 2.2), pair(10, 3.1, 2.0)];
    const r = bootstrapBrierDifferenceByRace(pairs, OPTIONS);
    expect(r.lower!).toBeGreaterThan(0);
    expect(r.lower!).toBeLessThanOrEqual(r.value!);
    expect(r.upper!).toBeGreaterThanOrEqual(r.value!);
  });

  it("結果に反復回数とシードと標本レース数を載せる(条件抜きの区間を返さない)", () => {
    const r = bootstrapBrierDifferenceByRace([pair(10, 2, 1), pair(10, 1, 2)], OPTIONS);
    expect(r.iterations).toBe(10000);
    expect(r.seed).toBe(20261001);
    expect(r.raceCount).toBe(2);
  });

  it("シードが違っても区間は極値 ±0.1 の内側に収まる(再標本は2レースの組合せしか作れない)", () => {
    const pairs = [pair(10, 2.0, 1.0), pair(10, 1.0, 2.0)];
    const a = bootstrapBrierDifferenceByRace(pairs, { iterations: 200, seed: 1 });
    const b = bootstrapBrierDifferenceByRace(pairs, { iterations: 200, seed: 2 });
    expect(a.lower!).toBeGreaterThanOrEqual(-0.1 - 1e-12);
    expect(b.upper!).toBeLessThanOrEqual(0.1 + 1e-12);
  });

  const invalid: ReadonlyArray<{ readonly name: string; readonly pairs: readonly RaceSquaredErrorPair[]; readonly it?: number }> = [
    { name: "レースが0件", pairs: [] },
    { name: "レースが1件(再標本化しても変動しない)", pairs: [pair(10, 2, 1)] },
    { name: "頭数が0のレースを含む", pairs: [pair(10, 2, 1), pair(0, 0, 0)] },
    { name: "NaN を含む", pairs: [pair(10, Number.NaN, 1), pair(10, 1, 1)] },
    { name: "反復回数が0", pairs: [pair(10, 2, 1), pair(10, 1, 2)], it: 0 },
  ];
  it.each(invalid)("$name は reason 付き null", ({ pairs, it: iterations }) => {
    const r = bootstrapBrierDifferenceByRace(pairs, { iterations: iterations ?? 100, seed: 1 });
    expect(r.value).toBeNull();
    expect(typeof r.reason).toBe("string");
  });
});

describe("Murphy 分解の帯は、同じ帯数を渡せば検証画面のキャリブレーションと同じ集計になる(突合。#37)", () => {
  // 既定の帯数は用途ごとに分かれた(検証画面20・測定10)ので、帯数を明示して揃えた場合の一致を固定する。
  // 埋まる帯の数は入力(下の cases)と帯数から決まる(10帯なら7、20帯なら10。cases の確率を帯に写して数えた)。
  it.each([
    { binCount: 10, filledBins: 7 },
    { binCount: 20, filledBins: 10 },
  ])("境界値(0・0.05・0.1・0.3・0.7・0.9・1.0)を含む同じ入力で、$binCount帯の件数・実績率が一致する", ({ binCount, filledBins }) => {
    // 3着以内=着順3以下。境界の確率を意図的に混ぜる。
    const cases: ReadonlyArray<{ readonly prob: number; readonly finish: number }> = [
      { prob: 0, finish: 9 },
      { prob: 0.05, finish: 5 },
      { prob: 0.1, finish: 1 },
      { prob: 0.1, finish: 8 },
      { prob: 0.19, finish: 3 },
      { prob: 0.3, finish: 2 },
      { prob: 0.3, finish: 4 },
      { prob: 0.45, finish: 3 },
      { prob: 0.5, finish: 6 },
      { prob: 0.7, finish: 1 },
      { prob: 0.7, finish: 3 },
      { prob: 0.7, finish: 7 },
      { prob: 0.9, finish: 2 },
      { prob: 0.99, finish: 1 },
      { prob: 1.0, finish: 1 },
      { prob: 1.0, finish: 5 },
    ];
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      horses: cases.map((c, i) => ({
        umaban: i + 1,
        prior: c.prob,
        adjustedProb: c.prob,
        placeOddsMin: null,
        ev: null,
        isPositive: false,
        contributions: null,
        mark: null,
      })),
    });
    store.saveResult(
      "R1",
      cases.map((c, i) => ({ umaban: i + 1, finishPosition: c.finish })),
    );
    const verifyBins = computeVerifyReport(store, { ...DEFAULT_VERIFY_CONFIG, calibrationBins: binCount })
      .calibration;
    store.close();

    const decomposition = computeBrierDecomposition(
      cases.map((c) => obs(c.prob, c.finish <= 3)),
      binCount,
    ).decomposition!;

    // 前提(空振り防止): 件数の合計が一致し、複数の帯が埋まっている。
    expect(verifyBins.reduce((s, b) => s + b.predictedCount, 0)).toBe(cases.length);
    expect(verifyBins).toHaveLength(binCount);
    expect(decomposition.bins).toHaveLength(binCount);
    expect(decomposition.bins.filter((b) => b.count > 0).length).toBe(filledBins);
    for (let k = 0; k < binCount; k++) {
      expect(decomposition.bins[k]!.lowerBound).toBeCloseTo(verifyBins[k]!.lowerBound, 12);
      expect(decomposition.bins[k]!.upperBound).toBeCloseTo(verifyBins[k]!.upperBound, 12);
      expect(decomposition.bins[k]!.count).toBe(verifyBins[k]!.predictedCount);
      expect(decomposition.bins[k]!.observedRate).toBe(verifyBins[k]!.actualPlaceRate);
    }
  });
});

describe("withinRacePermutationResolution: レース内ラベル並べ替えによる resolution の参照値", () => {
  const OPTIONS = { iterations: 1000, seed: 20261001 } as const;

  it("同じ入力・同じシードなら完全に同じ結果(決定論的)", () => {
    const races = [
      [obs(0.9, true), obs(0.9, true), obs(0.1, false), obs(0.1, false)],
      [obs(0.6, true), obs(0.3, false), obs(0.3, false), obs(0.2, true)],
    ];
    expect(withinRacePermutationResolution(races, OPTIONS)).toEqual(
      withinRacePermutationResolution(races, OPTIONS),
    );
  });

  it("レース内の予測がすべて同じ値なら並べ替えても分解は変わらず、平均も95点も観測の resolution に一致する", () => {
    // レースA: 全馬 p=0.1・的中1/4。レースB: 全馬 p=0.9・的中3/4。帯の所属は並べ替えで動かない。
    // ō=0.5。帯1の実績率0.25・帯9の実績率0.75 → RES=½(0.25−0.5)²+½(0.75−0.5)²=0.0625。
    const races = [
      [obs(0.1, true), obs(0.1, false), obs(0.1, false), obs(0.1, false)],
      [obs(0.9, true), obs(0.9, true), obs(0.9, true), obs(0.9, false)],
    ];
    const observed = computeBrierDecomposition(races.flat()).decomposition!;
    expect(observed.resolution).toBeCloseTo(0.0625, 12); // 前提: 観測の resolution は0でない
    const r = withinRacePermutationResolution(races, OPTIONS);
    expect(r.reason).toBeNull();
    expect(r.mean).toBeCloseTo(0.0625, 12);
    expect(r.p95).toBeCloseTo(0.0625, 12);
  });

  it("レース内で予測が結果を完全に分けているとき、参照値の平均は観測の resolution より小さい", () => {
    // 1レース4頭 p=[0.9,0.9,0.1,0.1]、的中=[T,T,F,F]。観測 RES=0.25。
    // 並べ替え(2頭の的中を4頭に配る6通り): 両方が高帯(1/6)・両方が低帯(1/6)で RES=0.25、
    // 他の4/6は各帯の実績率が0.5で RES=0。→ 平均=1/3×0.25≒0.0833、95点=0.25。
    const races = [[obs(0.9, true), obs(0.9, true), obs(0.1, false), obs(0.1, false)]];
    const observed = computeBrierDecomposition(races.flat()).decomposition!;
    expect(observed.resolution).toBeCloseTo(0.25, 12);
    const r = withinRacePermutationResolution(races, OPTIONS);
    expect(r.mean!).toBeGreaterThan(0.0833 - 0.02);
    expect(r.mean!).toBeLessThan(0.0833 + 0.02);
    expect(r.mean!).toBeLessThan(observed.resolution);
    expect(r.p95).toBeCloseTo(0.25, 12);
  });

  it("結果に反復回数・シード・レース数を同梱する", () => {
    const r = withinRacePermutationResolution(
      [[obs(0.5, true), obs(0.5, false)]],
      { iterations: 50, seed: 9 },
    );
    expect(r.iterations).toBe(50);
    expect(r.seed).toBe(9);
    expect(r.raceCount).toBe(1);
  });

  const invalid: ReadonlyArray<{ readonly name: string; readonly races: readonly (readonly BrierObservation[])[]; readonly iterations?: number }> = [
    { name: "レースが0件", races: [] },
    { name: "観測が0件のレースを含む", races: [[obs(0.5, true)], []] },
    { name: "範囲外の確率を含む", races: [[obs(1.5, true), obs(0.2, false)]] },
    { name: "反復回数が0", races: [[obs(0.5, true), obs(0.5, false)]], iterations: 0 },
  ];
  it.each(invalid)("$name は reason 付き null", ({ races, iterations }) => {
    const r = withinRacePermutationResolution(races, { iterations: iterations ?? 10, seed: 1 });
    expect(r.mean).toBeNull();
    expect(typeof r.reason).toBe("string");
  });
});

describe("乱数の固定(シードを変えたら値が変わる)", () => {
  // 固定シードの再現性を値で固定する。閉形式の期待値が無いため、**コミット済みの実装
  // (mulberry32・200回/500回の再標本)を実行して得た値**を回帰値として置く(手計算ではない)。
  // 乱数の列が変わる変更(シードの加算・別の乱数への差し替え)は、ここで検出される。
  const races = [
    [obs(0.7, true), obs(0.5, true), obs(0.3, false), obs(0.2, false), obs(0.1, false)],
    [obs(0.6, false), obs(0.4, true), obs(0.35, true), obs(0.15, false), obs(0.1, false), obs(0.05, false)],
    [obs(0.55, true), obs(0.45, false), obs(0.25, false), obs(0.12, true)],
  ];

  it("resolution の参照値: シード 20261001 の平均は実行値 0.12725、シード 20261002 では 0.12375(別の値)", () => {
    const a = withinRacePermutationResolution(races, { iterations: 200, seed: 20261001 });
    const b = withinRacePermutationResolution(races, { iterations: 200, seed: 20261002 });
    expect(a.mean).toBeCloseTo(0.12725, 10);
    expect(b.mean).toBeCloseTo(0.12375, 10);
    expect(a.mean).not.toBe(b.mean);
  });

  const pairs: RaceSquaredErrorPair[] = [
    { count: 8, modelSse: 1.9, marketSse: 1.7 },
    { count: 10, modelSse: 2.1, marketSse: 2.4 },
    { count: 9, modelSse: 1.6, marketSse: 1.5 },
    { count: 12, modelSse: 2.8, marketSse: 2.2 },
    { count: 8, modelSse: 1.4, marketSse: 1.6 },
  ];

  it("ブートストラップ: シード 20261001 の区間は実行値 [-0.0195652…, 0.0362069…]、シード 20261002 では別の区間", () => {
    const a = bootstrapBrierDifferenceByRace(pairs, { iterations: 500, seed: 20261001 });
    const b = bootstrapBrierDifferenceByRace(pairs, { iterations: 500, seed: 20261002 });
    expect(a.lower).toBeCloseTo(-0.019565217391304342, 12);
    expect(a.upper).toBeCloseTo(0.03620689655172411, 12);
    expect(b.lower).toBeCloseTo(-0.02127659574468084, 12);
    expect(b.upper).toBeCloseTo(0.03703703703703702, 12);
    expect(a.value).toBe(b.value); // 点推定はシードに依らない
    expect(a.lower).not.toBe(b.lower);
  });
});
