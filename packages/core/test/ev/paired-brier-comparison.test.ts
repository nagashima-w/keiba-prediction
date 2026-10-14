import { describe, expect, it } from "vitest";
import {
  buildBrierQualityReport,
  buildPairedBrierComparison,
  type BrierQualityInputHorse,
  type PairedBrierComparisonInput,
  type PairedBrierInputHorse,
} from "../../src/ev/probability-quality.js";

/**
 * buildPairedBrierComparison — 同じ馬集合の2つの確率列(model と reference)の Brier 差・分解・
 * レース単位ブートストラップ(#156「#41-B: LLM 補正込みの確率の質」)。
 * 用途: 「LLM 補正後(model)」対「prior(reference)」を、同じレース・同じ馬の対で比べる。
 * 差は model − reference(正なら model が悪い)で、`buildBrierQualityReport` の対市場の
 * Brier 差(model − market)と同じ向き・同じブートストラップ実装。
 */

const BOOTSTRAP = { iterations: 2000, seed: 7 } as const;

const OCC8 = [true, true, false, true, false, false, false, false];
const ODDS8 = [1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0, 15.0];

function pairedRace(
  raceId: string,
  modelProbs: readonly number[],
  referenceProbs: readonly number[],
  occurred: readonly boolean[],
): PairedBrierInputHorse[] {
  return modelProbs.map((p, i) => ({
    raceId,
    umaban: i + 1,
    modelProb: p,
    referenceProb: referenceProbs[i]!,
    occurred: occurred[i]!,
  }));
}

function input(
  horses: readonly PairedBrierInputHorse[],
  over: Partial<PairedBrierComparisonInput> = {},
): PairedBrierComparisonInput {
  return {
    horses,
    modelSource: "llm-adjusted",
    referenceSource: "prior-only",
    bootstrap: BOOTSTRAP,
    ...over,
  };
}

/** 手計算用: 二乗誤差の平均(実装とは別に書いた独立の式)。 */
function squaredErrorMean(probs: readonly number[], occ: readonly boolean[]): number {
  let s = 0;
  probs.forEach((p, i) => {
    s += (p - (occ[i]! ? 1 : 0)) ** 2;
  });
  return s / probs.length;
}

const REF_A = [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3];
const MODEL_A = [0.7, 0.55, 0.3, 0.35, 0.25, 0.2, 0.2, 0.25];
const REF_B = [0.2, 0.4, 0.5, 0.3, 0.4, 0.3, 0.3, 0.3];
const MODEL_B = [0.25, 0.5, 0.45, 0.3, 0.3, 0.25, 0.25, 0.25];
const OCC_B = [false, true, true, true, false, false, false, false];

function twoRaces(): PairedBrierInputHorse[] {
  return [
    ...pairedRace("R1", MODEL_A, REF_A, OCC8),
    ...pairedRace("R2", MODEL_B, REF_B, OCC_B),
  ];
}

describe("buildPairedBrierComparison: 計測条件の同梱", () => {
  it("どの2系列を比べたか(model/reference の出所)とブートストラップ条件を結果に同梱する", () => {
    const r = buildPairedBrierComparison(input(twoRaces()));
    expect(r.conditions.modelSource).toBe("llm-adjusted");
    expect(r.conditions.referenceSource).toBe("prior-only");
    expect(r.conditions.bootstrap).toEqual(BOOTSTRAP);
    expect(r.raceCount).toBe(2);
    expect(r.observationCount).toBe(16);
  });

  it("系列の出所の申告は入力どおりに転記される(固定値ではない)", () => {
    const r = buildPairedBrierComparison(
      input(twoRaces(), { modelSource: "prior-only", referenceSource: "llm-adjusted" }),
    );
    expect(r.conditions.modelSource).toBe("prior-only");
    expect(r.conditions.referenceSource).toBe("llm-adjusted");
  });
});

describe("buildPairedBrierComparison: Brier と差の値(手計算との一致)", () => {
  const all = twoRaces();
  const r = buildPairedBrierComparison(input(all));
  const modelBs = squaredErrorMean([...MODEL_A, ...MODEL_B], [...OCC8, ...OCC_B]);
  const refBs = squaredErrorMean([...REF_A, ...REF_B], [...OCC8, ...OCC_B]);

  it("model と reference の Brier は、それぞれの全観測の二乗誤差の平均", () => {
    expect(r.modelBrier.value).toBeCloseTo(modelBs, 12);
    expect(r.referenceBrier.value).toBeCloseTo(refBs, 12);
  });

  it("前提: 2系列の Brier は異なる(差が0でない)ので、以降の差の検証が自明に成立しない", () => {
    expect(Math.abs(modelBs - refBs)).toBeGreaterThan(1e-3);
  });

  it("差の点推定は model − reference(正なら model が悪い)", () => {
    expect(r.brierDifference.value).not.toBeNull();
    expect(r.brierDifference.value!).toBeCloseTo(modelBs - refBs, 12);
  });

  it("skill は 1 − BS_model / BS_reference", () => {
    expect(r.brierSkillVsReference.value).not.toBeNull();
    expect(r.brierSkillVsReference.value!).toBeCloseTo(1 - modelBs / refBs, 12);
  });

  it("model が良ければ差は負・skill は正、悪ければ差は正・skill は負(入れ替えで符号が反転する)", () => {
    const swapped = buildPairedBrierComparison(
      input(all.map((h) => ({ ...h, modelProb: h.referenceProb, referenceProb: h.modelProb }))),
    );
    expect(Math.sign(swapped.brierDifference.value!)).toBe(-Math.sign(r.brierDifference.value!));
    expect(Math.sign(swapped.brierSkillVsReference.value!)).toBe(
      -Math.sign(r.brierSkillVsReference.value!),
    );
    expect(swapped.brierDifference.value!).toBeCloseTo(-r.brierDifference.value!, 12);
  });

  it("区間は点推定を挟み、下限 ≤ 上限(反復回数とシードを同梱する)", () => {
    const d = r.brierDifference;
    expect(d.lower).not.toBeNull();
    expect(d.upper).not.toBeNull();
    expect(d.lower!).toBeLessThanOrEqual(d.upper!);
    expect(d.iterations).toBe(BOOTSTRAP.iterations);
    expect(d.seed).toBe(BOOTSTRAP.seed);
    expect(d.raceCount).toBe(2);
  });

  it("同じシード・同じ入力なら完全に同じ結果(決定論的)", () => {
    expect(buildPairedBrierComparison(input(all))).toEqual(r);
  });

  it("入力の馬の並び順に依らない(レースごとにまとめて同じ値)", () => {
    const shuffled = [...all].reverse();
    const r2 = buildPairedBrierComparison(input(shuffled));
    expect(r2.modelBrier.value!).toBeCloseTo(r.modelBrier.value!, 12);
    expect(r2.brierDifference.value!).toBeCloseTo(r.brierDifference.value!, 12);
  });

  it("Murphy 分解を model・reference それぞれに同梱する(Brier と一致)", () => {
    expect(r.modelDecomposition.decomposition).not.toBeNull();
    expect(r.referenceDecomposition.decomposition).not.toBeNull();
    expect(r.modelDecomposition.decomposition!.brier).toBeCloseTo(modelBs, 12);
    expect(r.referenceDecomposition.decomposition!.brier).toBeCloseTo(refBs, 12);
  });
});

describe("buildPairedBrierComparison: 同じ系列同士", () => {
  it("model と reference が同一なら、差は厳密に 0・区間も 0・skill は 0", () => {
    const same = [
      ...pairedRace("R1", MODEL_A, MODEL_A, OCC8),
      ...pairedRace("R2", MODEL_B, MODEL_B, OCC_B),
    ];
    const r = buildPairedBrierComparison(input(same));
    // 前提: Brier 自体は 0 でない(0 と 0 の比較で自明に一致しているのではない)。
    expect(r.modelBrier.value!).toBeGreaterThan(0.05);
    expect(r.brierDifference.value).toBe(0);
    expect(r.brierDifference.lower).toBe(0);
    expect(r.brierDifference.upper).toBe(0);
    expect(r.brierSkillVsReference.value).toBe(0);
  });
});

describe("buildPairedBrierComparison: 既存の対市場比較と同じ実装・同じ向き", () => {
  it("reference に市場含意確率を入れると、buildBrierQualityReport の対市場の Brier 差と値・区間が一致する", () => {
    const oddsB = [1.8, 2.5, 2.8, 3.5, 7.0, 9.0, 12.0, 20.0];
    const invSum = (o: readonly number[]) => o.reduce((s, v) => s + 1 / v, 0);
    const market = (o: readonly number[]) => o.map((v) => ((1 / v) / invSum(o)) * 3);
    const marketA = market(ODDS8);
    const marketB = market(oddsB);
    // 前提: 市場確率が [0,1] に収まっている(市場比較から外れない)。
    expect(Math.max(...marketA, ...marketB)).toBeLessThanOrEqual(1);

    const quality: BrierQualityInputHorse[] = [
      ...MODEL_A.map((p, i) => ({
        raceId: "R1", umaban: i + 1, modelProb: p, occurred: OCC8[i]!,
        placeOddsMin: ODDS8[i]!, placeOddsMax: ODDS8[i]!,
      })),
      ...MODEL_B.map((p, i) => ({
        raceId: "R2", umaban: i + 1, modelProb: p, occurred: OCC_B[i]!,
        placeOddsMin: oddsB[i]!, placeOddsMax: oddsB[i]!,
      })),
    ];
    const ref = buildBrierQualityReport({
      horses: quality,
      priorSource: "llm-adjusted",
      bootstrap: BOOTSTRAP,
      permutation: { iterations: 10, seed: 1 },
    }).marketComparison.lowerBound;
    expect(ref.eligibleRaceCount).toBe(2);
    expect(ref.brierDifference.value).not.toBeNull();
    expect(ref.brierDifference.value!).not.toBe(0);

    const paired = buildPairedBrierComparison(
      input([
        ...pairedRace("R1", MODEL_A, marketA, OCC8),
        ...pairedRace("R2", MODEL_B, marketB, OCC_B),
      ]),
    );
    expect(paired.brierDifference).toEqual(ref.brierDifference);
    expect(paired.modelBrier).toEqual(ref.modelBrier);
    expect(paired.referenceBrier.value!).toBeCloseTo(ref.marketBrier.value!, 12);
  });
});

describe("buildPairedBrierComparison: 異常入力(黙ってクリップしない)", () => {
  it("model の確率が範囲外なら、model の Brier・差・skill は理由付き null(reference の Brier は出る)", () => {
    const bad = twoRaces();
    bad[0] = { ...bad[0]!, modelProb: 1.2 };
    const r = buildPairedBrierComparison(input(bad));
    expect(r.modelBrier.value).toBeNull();
    expect(r.modelBrier.reason).not.toBeNull();
    expect(r.brierDifference.value).toBeNull();
    expect(r.brierDifference.lower).toBeNull();
    expect(r.brierDifference.reason).not.toBeNull();
    expect(r.brierSkillVsReference.value).toBeNull();
    expect(r.referenceBrier.value).not.toBeNull();
  });

  it("reference の確率が NaN なら、reference の Brier・差・skill は理由付き null", () => {
    const bad = twoRaces();
    bad[3] = { ...bad[3]!, referenceProb: Number.NaN };
    const r = buildPairedBrierComparison(input(bad));
    expect(r.referenceBrier.value).toBeNull();
    expect(r.brierDifference.value).toBeNull();
    expect(r.brierDifference.reason).not.toBeNull();
    expect(r.brierSkillVsReference.value).toBeNull();
    expect(r.modelBrier.value).not.toBeNull();
  });

  it("レースが1件だけなら Brier は出るが、差の区間は定義できず理由付き null", () => {
    const r = buildPairedBrierComparison(input(pairedRace("R1", MODEL_A, REF_A, OCC8)));
    expect(r.raceCount).toBe(1);
    expect(r.modelBrier.value).not.toBeNull();
    expect(r.brierDifference.value).toBeNull();
    expect(r.brierDifference.reason).toContain("2件未満");
  });

  it("馬が0頭でも例外を投げず、すべて理由付き null", () => {
    const r = buildPairedBrierComparison(input([]));
    expect(r.raceCount).toBe(0);
    expect(r.observationCount).toBe(0);
    expect(r.modelBrier.value).toBeNull();
    expect(r.referenceBrier.value).toBeNull();
    expect(r.brierDifference.value).toBeNull();
    expect(r.brierSkillVsReference.value).toBeNull();
  });
});
