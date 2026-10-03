import { describe, expect, it } from "vitest";
import {
  buildBrierQualityReport,
  MIN_FIELD_SIZE_FOR_PLACE_MARKET,
  type BrierQualityInputHorse,
  type BrierQualityReportInput,
} from "../../src/ev/probability-quality.js";

/**
 * buildBrierQualityReport — 確率の質の公開エントリポイント(Brier・Murphy 分解・対市場比較)。
 * #41「#35-1b」。計測条件を必ず同梱し、市場との比較は「出走8頭以上かつ市場含意確率が正常」な
 * レースの対だけで行う(複勝の払戻対象が3着までになるのは8頭以上のため。5〜7頭は2着まで・
 * 4頭以下は発売なしで、Σ=3 に正規化した市場含意確率は「3着以内」と別の事象になる)。
 */

const BOOTSTRAP = { iterations: 2000, seed: 7 } as const;
const PERMUTATION = { iterations: 300, seed: 11 } as const;

/** 1レース分の入力を作る。oddsMin は馬番順。modelProb と occurred は同じ並び。 */
function race(
  raceId: string,
  modelProbs: readonly number[],
  occurred: readonly boolean[],
  oddsMin: ReadonlyArray<number | null>,
  oddsMax?: ReadonlyArray<number | null>,
): BrierQualityInputHorse[] {
  return modelProbs.map((p, i) => ({
    raceId,
    umaban: i + 1,
    modelProb: p,
    occurred: occurred[i]!,
    placeOddsMin: oddsMin[i]!,
    placeOddsMax: oddsMax === undefined ? oddsMin[i]! : oddsMax[i]!,
  }));
}

function input(horses: readonly BrierQualityInputHorse[]): BrierQualityReportInput {
  return { horses, priorSource: "prior-only", bootstrap: BOOTSTRAP, permutation: PERMUTATION };
}

/** 8頭の標準レース(3着以内が3頭)。 */
const ODDS8 = [1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0, 15.0];
const OCC8 = [true, true, false, true, false, false, false, false];

/** 手計算用: オッズ下限 → Σ=3 正規化した市場含意確率(実装とは別に書いた独立の式)。 */
function independentMarket(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const sum = inv.reduce((s, v) => s + v, 0);
  return inv.map((v) => (v / sum) * 3);
}

function squaredErrorMean(probs: readonly number[], occ: readonly boolean[]): number {
  let s = 0;
  probs.forEach((p, i) => {
    s += (p - (occ[i]! ? 1 : 0)) ** 2;
  });
  return s / probs.length;
}

describe("MIN_FIELD_SIZE_FOR_PLACE_MARKET", () => {
  it("複勝が3着まで払い戻される最小頭数の8", () => {
    expect(MIN_FIELD_SIZE_FOR_PLACE_MARKET).toBe(8);
  });
});

describe("buildBrierQualityReport: 計測条件の同梱", () => {
  it("priorSource・使用オッズの種別・頭数条件・ブートストラップ条件を結果に同梱する", () => {
    const horses = race("R1", [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3], OCC8, ODDS8);
    const r = buildBrierQualityReport(input(horses));
    expect(r.conditions.priorSource).toBe("prior-only");
    expect(r.conditions.minFieldSizeForMarket).toBe(8);
    expect(r.conditions.marketKinds).toEqual({
      lowerBound: "placeOddsMinLowerBound",
      midpoint: "placeOddsMidpoint",
    });
    expect(r.conditions.bootstrap).toEqual({ iterations: 2000, seed: 7 });
    expect(r.conditions.permutation).toEqual({ iterations: 300, seed: 11 });
    expect(r.marketComparison.lowerBound.marketKind).toBe("placeOddsMinLowerBound");
    expect(r.marketComparison.midpoint.marketKind).toBe("placeOddsMidpoint");
  });

  it("llm-adjusted の申告もそのまま同梱する(本モジュールは判別できない申告項目)", () => {
    const horses = race("R1", [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], OCC8, ODDS8);
    const r = buildBrierQualityReport({ ...input(horses), priorSource: "llm-adjusted" });
    expect(r.conditions.priorSource).toBe("llm-adjusted");
  });
});

describe("buildBrierQualityReport: モデル単独(全レース)", () => {
  it("頭数に関係なく全レースの観測で Brier と分解を出す(7頭のレースも含む)", () => {
    const r8 = race("R8", [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3], OCC8, ODDS8);
    const r7 = race(
      "R7",
      [0.5, 0.4, 0.4, 0.3, 0.2, 0.1, 0.1],
      [true, false, true, true, false, false, false],
      [1.5, 2, 3, 4, 6, 8, 10],
    );
    const r = buildBrierQualityReport(input([...r8, ...r7]));
    expect(r.raceCount).toBe(2);
    expect(r.observationCount).toBe(15);
    expect(r.model.decomposition.decomposition!.n).toBe(15);
    const expected = squaredErrorMean(
      [...r8, ...r7].map((h) => h.modelProb),
      [...r8, ...r7].map((h) => h.occurred),
    );
    expect(r.model.brier.value).toBeCloseTo(expected, 12);
    expect(r.model.decomposition.decomposition!.brier).toBeCloseTo(expected, 12);
  });

  it("気候値に対する skill = 1 − BS/UNC(分解の不確実性を基準にする)", () => {
    const horses = race("R1", [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3], OCC8, ODDS8);
    const r = buildBrierQualityReport(input(horses));
    const d = r.model.decomposition.decomposition!;
    expect(r.model.brierSkillVsClimatology.value).toBeCloseTo(1 - d.brier / d.uncertainty, 12);
  });

  it("resolution の参照値(レース内ラベル並べ替え)をモデル単独の結果に同梱する", () => {
    const horses = [
      ...race("A", [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3], OCC8, ODDS8),
      ...race("B", [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], [false, false, true, true, false, true, false, false], ODDS8),
    ];
    const r = buildBrierQualityReport(input(horses));
    expect(r.model.resolutionNull.reason).toBeNull();
    expect(r.model.resolutionNull.iterations).toBe(300);
    expect(r.model.resolutionNull.seed).toBe(11);
    expect(r.model.resolutionNull.raceCount).toBe(2);
    expect(r.model.resolutionNull.mean!).toBeGreaterThanOrEqual(0);
  });

  it("範囲外のモデル確率が混じると、黙って丸めず reason 付き null(分解も Brier も)", () => {
    const horses = race("R1", [1.2, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3], OCC8, ODDS8);
    const r = buildBrierQualityReport(input(horses));
    expect(r.model.brier.value).toBeNull();
    expect(r.model.decomposition.decomposition).toBeNull();
    expect(r.model.brierSkillVsClimatology.value).toBeNull();
    expect(typeof r.model.brierSkillVsClimatology.reason).toBe("string");
  });

  it("入力が0頭なら reason 付き null", () => {
    const r = buildBrierQualityReport(input([]));
    expect(r.raceCount).toBe(0);
    expect(r.model.brier.value).toBeNull();
    expect(r.marketComparison.lowerBound.eligibleRaceCount).toBe(0);
  });
});

describe("buildBrierQualityReport: 市場との比較(下限版)", () => {
  const modelA = [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3];
  const modelB = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
  const occB = [false, false, true, true, false, true, false, false];
  const oddsB = [3, 4, 5, 6, 7, 8, 9, 10];

  it("手計算: 市場の Brier は Σ=3 正規化した市場含意確率の二乗誤差平均と一致する", () => {
    const horses = [...race("A", modelA, OCC8, ODDS8), ...race("B", modelB, occB, oddsB)];
    const r = buildBrierQualityReport(input(horses));
    const cmp = r.marketComparison.lowerBound;
    expect(cmp.eligibleRaceCount).toBe(2);
    expect(cmp.eligibleObservationCount).toBe(16);
    const marketProbs = [...independentMarket(ODDS8), ...independentMarket(oddsB)];
    const occ = [...OCC8, ...occB];
    expect(cmp.marketBrier.value).toBeCloseTo(squaredErrorMean(marketProbs, occ), 12);
    expect(cmp.modelBrier.value).toBeCloseTo(squaredErrorMean([...modelA, ...modelB], occ), 12);
    expect(cmp.brierSkillVsMarket.value).toBeCloseTo(
      1 - cmp.modelBrier.value! / cmp.marketBrier.value!,
      12,
    );
  });

  it("7頭のレースは市場比較から除外される(モデル単独には入る)。除外レースIDを残す", () => {
    const r7 = race(
      "R7",
      [0.5, 0.4, 0.4, 0.3, 0.2, 0.1, 0.1],
      [true, false, true, true, false, false, false],
      [1.5, 2, 3, 4, 6, 8, 10],
    );
    const horses = [...race("A", modelA, OCC8, ODDS8), ...r7];
    const r = buildBrierQualityReport(input(horses));
    const cmp = r.marketComparison.lowerBound;
    expect(cmp.eligibleRaceCount).toBe(1);
    expect(cmp.excludedRaces.smallField).toEqual(["R7"]);
    expect(cmp.excludedRaces.marketUnavailable).toEqual([]);
    expect(cmp.excludedRaces.marketOutOfRange).toEqual([]);
    expect(r.model.decomposition.decomposition!.n).toBe(15);
  });

  it("ちょうど8頭は比較対象、7頭は対象外(境界)", () => {
    const eight = race("E8", modelA, OCC8, ODDS8);
    const seven = race("S7", modelA.slice(0, 7), OCC8.slice(0, 7), ODDS8.slice(0, 7));
    expect(buildBrierQualityReport(input(eight)).marketComparison.lowerBound.eligibleRaceCount).toBe(1);
    expect(buildBrierQualityReport(input(seven)).marketComparison.lowerBound.eligibleRaceCount).toBe(0);
  });

  it("複勝オッズ下限が1頭でも欠けるレースは、レース全体を市場比較から除外する(一部の馬だけ使わない)", () => {
    const missing = race("M", modelB, occB, [3, 4, 5, null, 7, 8, 9, 10]);
    const horses = [...race("A", modelA, OCC8, ODDS8), ...missing];
    const cmp = buildBrierQualityReport(input(horses)).marketComparison.lowerBound;
    expect(cmp.eligibleRaceCount).toBe(1);
    expect(cmp.excludedRaces.marketUnavailable).toEqual(["M"]);
  });

  it("市場含意確率が1を超えるレースは黙ってクリップせず除外し、モデル側の比較集合からも外す(対で比べる)", () => {
    // 下限1.0の1頭と下限50の7頭 → Σinv=1+7/50=1.14 → 先頭は 1/1.14×3≒2.63 で1超。
    const over = race("OVER", modelB, occB, [1.0, 50, 50, 50, 50, 50, 50, 50]);
    const horses = [...race("A", modelA, OCC8, ODDS8), ...over];
    const r = buildBrierQualityReport(input(horses));
    const cmp = r.marketComparison.lowerBound;
    expect(cmp.excludedRaces.marketOutOfRange).toEqual(["OVER"]);
    expect(cmp.eligibleRaceCount).toBe(1);
    // 空振り防止: 除外レースを含めた全体のモデル Brier と、比較集合のモデル Brier は別の値である。
    expect(Math.abs(r.model.brier.value! - cmp.modelBrier.value!)).toBeGreaterThan(1e-3);
    // 比較集合のモデル Brier は、残った1レース(A)だけの値。
    expect(cmp.modelBrier.value).toBeCloseTo(squaredErrorMean(modelA, OCC8), 12);
    expect(cmp.eligibleObservationCount).toBe(8);
  });

  it("比較できるレースが0件なら市場側・skill・差の区間はすべて reason 付き null", () => {
    const cmp = buildBrierQualityReport(input(race("S", [0.5, 0.5, 0.5], [true, true, true], [1.5, 2, 3])))
      .marketComparison.lowerBound;
    expect(cmp.eligibleRaceCount).toBe(0);
    expect(cmp.marketBrier.value).toBeNull();
    expect(cmp.brierSkillVsMarket.value).toBeNull();
    expect(cmp.brierDifference.value).toBeNull();
    expect(typeof cmp.brierDifference.reason).toBe("string");
  });

  it("レース単位ブートストラップ(model − market)の条件と点推定を返す", () => {
    const horses = [...race("A", modelA, OCC8, ODDS8), ...race("B", modelB, occB, oddsB)];
    const cmp = buildBrierQualityReport(input(horses)).marketComparison.lowerBound;
    expect(cmp.brierDifference.reason).toBeNull();
    expect(cmp.brierDifference.iterations).toBe(2000);
    expect(cmp.brierDifference.seed).toBe(7);
    expect(cmp.brierDifference.raceCount).toBe(2);
    expect(cmp.brierDifference.value).toBeCloseTo(cmp.modelBrier.value! - cmp.marketBrier.value!, 12);
  });

  it("市場側の分解も、モデルと同じ比較集合で返す", () => {
    const horses = [...race("A", modelA, OCC8, ODDS8), ...race("B", modelB, occB, oddsB)];
    const cmp = buildBrierQualityReport(input(horses)).marketComparison.lowerBound;
    expect(cmp.modelDecomposition.decomposition!.n).toBe(16);
    expect(cmp.marketDecomposition.decomposition!.n).toBe(16);
    expect(cmp.marketDecomposition.decomposition!.brier).toBeCloseTo(cmp.marketBrier.value!, 12);
  });
});

describe("buildBrierQualityReport: 市場との比較(中点版の感度)", () => {
  const modelA = [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3];
  const maxA = ODDS8.map((o) => o * 1.5);

  it("手計算: 中点 (下限+上限)/2 から Σ=3 正規化した確率で Brier を出す。下限版とは別の値", () => {
    const mid = ODDS8.map((o, i) => (o + maxA[i]!) / 2);
    const r = buildBrierQualityReport(input(race("A", modelA, OCC8, ODDS8, maxA)));
    expect(r.marketComparison.midpoint.marketBrier.value).toBeCloseTo(
      squaredErrorMean(independentMarket(mid), OCC8),
      12,
    );
    // 上限が下限の1.5倍で一様にスケールするため、Σ=3 正規化後は下限版と同じになる。
    // (一様スケールでは差が出ないという事実の確認。下の「人気薄ほど幅が広い」ケースで差が出ることを見る)
    expect(r.marketComparison.midpoint.marketBrier.value).toBeCloseTo(
      r.marketComparison.lowerBound.marketBrier.value!,
      12,
    );
  });

  it("人気薄ほど幅が広い場合(現実の形)は、中点版と下限版で市場の Brier が異なる", () => {
    const widths = [1.0, 1.05, 1.1, 1.2, 1.4, 1.7, 2.0, 2.5];
    const maxs = ODDS8.map((o, i) => o * widths[i]!);
    const r = buildBrierQualityReport(input(race("A", modelA, OCC8, ODDS8, maxs)));
    const lower = r.marketComparison.lowerBound.marketBrier.value!;
    const midpoint = r.marketComparison.midpoint.marketBrier.value!;
    expect(Math.abs(lower - midpoint)).toBeGreaterThan(1e-4);
  });

  it("上限が欠けるレースは中点版では除外されるが、下限版では比較対象に残る", () => {
    const r = buildBrierQualityReport(
      input(race("A", modelA, OCC8, ODDS8, [1.5, 2, 3, 4, 6, 8, 10, null])),
    );
    expect(r.marketComparison.lowerBound.eligibleRaceCount).toBe(1);
    expect(r.marketComparison.midpoint.eligibleRaceCount).toBe(0);
    expect(r.marketComparison.midpoint.excludedRaces.marketUnavailable).toEqual(["A"]);
  });
});

describe("buildBrierQualityReport: 確定オッズでないレース(oddsNotFinalRaceIds)", () => {
  const modelA = [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3];

  it("確定でないレースは市場比較から外し、『複勝オッズの欠損・不正』(marketUnavailable)には数えない(二重計上しない)", () => {
    // 複勝オッズ自体は揃っている(欠損ではない)ので、欠損として数えられてはならない。
    const horses = [...race("A", modelA, OCC8, ODDS8), ...race("N", modelA, OCC8, ODDS8)];
    const r = buildBrierQualityReport({ ...input(horses), oddsNotFinalRaceIds: ["N"] });
    for (const cmp of [r.marketComparison.lowerBound, r.marketComparison.midpoint]) {
      expect(cmp.excludedRaces.oddsNotFinal).toEqual(["N"]);
      expect(cmp.excludedRaces.marketUnavailable).toEqual([]);
      expect(cmp.eligibleRaceCount).toBe(1);
    }
    // モデル単独には入る。
    expect(r.model.decomposition.decomposition!.n).toBe(16);
  });

  it("指定しなければ従来どおり(oddsNotFinal は空)", () => {
    const r = buildBrierQualityReport(input(race("A", modelA, OCC8, ODDS8)));
    expect(r.marketComparison.lowerBound.excludedRaces.oddsNotFinal).toEqual([]);
    expect(r.marketComparison.lowerBound.eligibleRaceCount).toBe(1);
  });

  it("頭数が8未満なら smallField が優先(頭数は定義上の条件。同じレースを2つの理由で数えない)", () => {
    const seven = race("S", modelA.slice(0, 7), OCC8.slice(0, 7), ODDS8.slice(0, 7));
    const cmp = buildBrierQualityReport({ ...input(seven), oddsNotFinalRaceIds: ["S"] }).marketComparison.lowerBound;
    expect(cmp.excludedRaces.smallField).toEqual(["S"]);
    expect(cmp.excludedRaces.oddsNotFinal).toEqual([]);
  });

  it("確定でないレースの複勝オッズが欠けていても、理由は oddsNotFinal(オッズの中身を見ない)", () => {
    const horses = race("N", modelA, OCC8, [1.5, null, 3, 4, 6, 8, 10, 15]);
    const cmp = buildBrierQualityReport({ ...input(horses), oddsNotFinalRaceIds: ["N"] }).marketComparison.lowerBound;
    expect(cmp.excludedRaces.oddsNotFinal).toEqual(["N"]);
    expect(cmp.excludedRaces.marketUnavailable).toEqual([]);
  });
});
