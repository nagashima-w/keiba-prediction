import { describe, expect, it } from "vitest";
import { computeMarketImpliedPlaceProbabilities } from "../../packages/core/src/ev/probability-quality-metrics.js";
import {
  aggregateLlm,
  marketImpliedLowerBound,
  LLM_AGGREGATE_BOOTSTRAP,
  LLM_AGGREGATE_PERMUTATION,
} from "../probability-quality-41-llm/aggregate.js";
import {
  LLM_OBSERVATION_SCHEMA_VERSION,
  type LlmHorseRecord,
  type LlmRaceRecord,
} from "../probability-quality-41-llm/records.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type HorseObservation,
  type RaceObservationOk,
} from "../probability-quality-41/observation.js";

/**
 * #156(#41-B)の集計(オフライン)。#41 の観測 JSON(prior・結果・オッズ)と段階3の出力(LLM 補正後)から、
 * prior と LLM 補正後を**同じレース集合の対**で比べる。合成データで、手計算との一致・集合の絞り込み・
 * 整合性の検証・方向性の記述統計(市場に寄ったか)を確かめる。実サイトへのリクエストは含まない。
 */

const ODDS8 = [1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0, 15.0];

function obsHorse(umaban: number, prior: number, outcome: 0 | 1, oddsMin: number | null): HorseObservation {
  return {
    umaban,
    horseName: `H${umaban}`,
    prior,
    placeOddsMin: oddsMin,
    placeOddsMax: oddsMin,
    finish: { kind: "順位", value: outcome === 1 ? 1 : 9 },
    outcome,
    resultsFetched: true,
    usedRunCount: 5,
  };
}

function okRace(
  raceId: string,
  region: "central" | "nar",
  horses: readonly HorseObservation[],
  over: Partial<RaceObservationOk> = {},
): RaceObservationOk {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    status: "ok",
    raceId,
    region,
    requestedDate: "20260926",
    kaisaiDate: "20260926",
    venueCode: raceId.slice(4, 6),
    raceNumber: 1,
    raceName: raceId,
    listedEntryCount: horses.length,
    courseType: "芝",
    distance: 1600,
    runnerCount: horses.length,
    placedCount: horses.filter((h) => h.outcome === 1).length,
    oddsStatus: region === "central" ? "result" : "middle",
    horses,
    scratched: [],
    conditions: {
      priorSource: "prior-only",
      dateApproximate: false,
      leakFilter: { cutoffDate: "2026/09/26", totalResultCount: 0, removedCount: 0, removedByCutoffCount: 0, removedByInvalidDateCount: 0 },
      placeOddsKind: "placeOddsMinLowerBound",
    },
    warnings: [],
    resultsFailedHorseCount: 0,
    fetchedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function record(
  raceId: string,
  obs: RaceObservationOk,
  adjusted: (h: HorseObservation) => number,
  over: Partial<LlmRaceRecord> = {},
): LlmRaceRecord {
  const horses: LlmHorseRecord[] = obs.horses.map((h) => ({
    umaban: h.umaban,
    prior: h.prior,
    adjustedProb: adjusted(h),
    clipped: false,
    usedPrior: false,
    mark: null,
  }));
  return {
    schemaVersion: LLM_OBSERVATION_SCHEMA_VERSION,
    raceId,
    caseId: `case-${raceId.slice(-2)}`,
    promptVersion: "2026-07-28.2",
    maxAdjust: 0.1,
    promptSha256: "x",
    responseSha256: ["y"],
    attempts: 1,
    retryCount: 0,
    fallback: false,
    fallbackReason: null,
    marksDropped: false,
    truncated: false,
    horses,
    ...over,
  };
}

const PRIOR_A = [0.6, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.3];
const OCC_A: Array<0 | 1> = [1, 1, 0, 1, 0, 0, 0, 0];
const PRIOR_B = [0.2, 0.4, 0.5, 0.3, 0.4, 0.3, 0.3, 0.3];
const OCC_B: Array<0 | 1> = [0, 1, 1, 1, 0, 0, 0, 0];
/** 6頭(市場比較から外れる)。 */
const PRIOR_S = [0.7, 0.6, 0.5, 0.4, 0.4, 0.4];
const OCC_S: Array<0 | 1> = [1, 0, 1, 1, 0, 0];

function mk(prior: readonly number[], occ: readonly (0 | 1)[], odds: ReadonlyArray<number | null>): HorseObservation[] {
  return prior.map((p, i) => obsHorse(i + 1, p, occ[i]!, odds[i]!));
}

const OBS_C1 = okRace("202606040801", "central", mk(PRIOR_A, OCC_A, ODDS8));
const OBS_C2 = okRace("202606040802", "central", mk(PRIOR_B, OCC_B, ODDS8.map((o) => o * 1.1)));
const OBS_C3 = okRace("202606040803", "central", mk(PRIOR_S, OCC_S, [1.5, 2, 3, 4, 6, 8]));
const OBS_N1 = okRace("202630093001", "nar", mk(PRIOR_A, OCC_A, ODDS8));
const OBS_N2 = okRace("202630093002", "nar", mk(PRIOR_B, OCC_B, ODDS8.map((o) => o * 1.2)));

/** LLM は prior の上位に +0.05、下位に -0.05 動かす(手計算しやすい合成の補正)。 */
const bump = (h: HorseObservation) => h.prior + (h.umaban <= 2 ? 0.05 : -0.02);

const ALL_OBS = [OBS_C1, OBS_C2, OBS_C3, OBS_N1, OBS_N2];
function allRecords(adjust: (h: HorseObservation) => number = bump): LlmRaceRecord[] {
  return ALL_OBS.map((o) => record(o.raceId, o, adjust));
}

const sq = (probs: readonly number[], occ: readonly number[]) =>
  probs.reduce((s, p, i) => s + (p - occ[i]!) ** 2, 0);

describe("aggregateLlm: 条件の同梱", () => {
  it("ブートストラップ・並べ替えの反復回数とシードは #41 と同じ値(取得前の計画で固定)", () => {
    expect(LLM_AGGREGATE_BOOTSTRAP).toEqual({ iterations: 10000, seed: 20261001 });
    expect(LLM_AGGREGATE_PERMUTATION).toEqual({ iterations: 1000, seed: 20261001 });
    const r = aggregateLlm(ALL_OBS, allRecords());
    expect(r.conditions.bootstrap).toEqual(LLM_AGGREGATE_BOOTSTRAP);
    expect(r.conditions.permutation).toEqual(LLM_AGGREGATE_PERMUTATION);
    expect(r.conditions.promptVersion).toBe("2026-07-28.2");
    expect(r.conditions.maxAdjust).toBe(0.1);
  });
});

describe("aggregateLlm: 中央と地方は別々に集計する(混ぜない)", () => {
  const r = aggregateLlm(ALL_OBS, allRecords());

  it("中央3レース(馬22頭)・地方2レース(馬16頭)", () => {
    expect(r.central.raceCount).toBe(3);
    expect(r.central.observationCount).toBe(22);
    expect(r.nar.raceCount).toBe(2);
    expect(r.nar.observationCount).toBe(16);
  });

  it("prior と LLM の Brier は、それぞれの地域の全観測の二乗誤差の平均(手計算)", () => {
    const priorBs = (sq(PRIOR_A, OCC_A) + sq(PRIOR_B, OCC_B) + sq(PRIOR_S, OCC_S)) / 22;
    expect(r.central.series.prior.model.brier.value!).toBeCloseTo(priorBs, 12);
    const llm = (o: HorseObservation) => bump(o);
    const llmSse = [OBS_C1, OBS_C2, OBS_C3].reduce(
      (s, o) => s + o.horses.reduce((t, h) => t + (llm(h) - h.outcome) ** 2, 0),
      0,
    );
    expect(r.central.series.llm.model.brier.value!).toBeCloseTo(llmSse / 22, 12);
    expect(r.central.series.prior.conditions.priorSource).toBe("prior-only");
    expect(r.central.series.llm.conditions.priorSource).toBe("llm-adjusted");
  });

  it("全レースの対の差は LLM − prior(手計算と一致し、0 ではない)", () => {
    const priorBs = r.central.series.prior.model.brier.value!;
    const llmBs = r.central.series.llm.model.brier.value!;
    expect(Math.abs(llmBs - priorBs)).toBeGreaterThan(1e-4);
    const d = r.central.paired.allRaces;
    expect(d.conditions.modelSource).toBe("llm-adjusted");
    expect(d.conditions.referenceSource).toBe("prior-only");
    expect(d.brierDifference.value!).toBeCloseTo(llmBs - priorBs, 12);
    expect(d.raceCount).toBe(3);
  });

  it("市場比較可能な集合(8頭以上・確定オッズ)は中央2レース・地方2レースで、頭数6のレースは対の比較からも外す", () => {
    expect(r.central.paired.marketEligible).not.toBeNull();
    expect(r.central.paired.marketEligible!.raceCount).toBe(2);
    expect(r.central.paired.marketEligible!.observationCount).toBe(16);
    expect(r.central.marketEligibleRaceIds).toEqual(["202606040801", "202606040802"]);
    expect(r.nar.paired.marketEligible!.raceCount).toBe(2);
    // 対市場の比較集合(core が数える)と同じレース数。
    expect(r.central.series.prior.marketComparison.lowerBound.eligibleRaceCount).toBe(2);
    expect(r.central.series.llm.marketComparison.lowerBound.eligibleRaceCount).toBe(2);
  });

  it("市場比較可能集合の対の差は、その2レースだけの手計算と一致する", () => {
    const sel = [OBS_C1, OBS_C2];
    const priorSse = sel.reduce((s, o) => s + o.horses.reduce((t, h) => t + (h.prior - h.outcome) ** 2, 0), 0);
    const llmSse = sel.reduce((s, o) => s + o.horses.reduce((t, h) => t + (bump(h) - h.outcome) ** 2, 0), 0);
    expect(r.central.paired.marketEligible!.brierDifference.value!).toBeCloseTo((llmSse - priorSse) / 16, 12);
  });

  it("オッズが確定でないレースは市場比較可能集合に入らない(地方 middle は確定扱い、中央 middle は外す)", () => {
    const notFinal = okRace("202606040802", "central", mk(PRIOR_B, OCC_B, ODDS8), { oddsStatus: "middle" });
    const obs = [OBS_C1, notFinal, OBS_C3];
    const res = aggregateLlm(obs, obs.map((o) => record(o.raceId, o, bump)));
    expect(res.central.marketEligibleRaceIds).toEqual(["202606040801"]);
    expect(res.central.paired.allRaces.raceCount).toBe(3);
  });
});

describe("aggregateLlm: fallback したレースの感度(主表は production どおり補正後=prior のまま残す)", () => {
  it("fallback のレースは主表に残り(補正後=prior)、感度の集合からは外れる", () => {
    const recs = allRecords().map((rec) =>
      rec.raceId === "202606040802"
        ? { ...rec, fallback: true, fallbackReason: "x", horses: rec.horses.map((h) => ({ ...h, adjustedProb: h.prior, usedPrior: true })) }
        : rec,
    );
    const r = aggregateLlm(ALL_OBS, recs);
    expect(r.central.raceCount).toBe(3);
    expect(r.central.llmRun.fallbackRaceIds).toEqual(["202606040802"]);
    expect(r.central.sensitivityExcludingFallback.excludedRaceIds).toEqual(["202606040802"]);
    expect(r.central.sensitivityExcludingFallback.paired.raceCount).toBe(2);
    expect(r.central.sensitivityExcludingFallback.llm.raceCount).toBe(2);
    expect(r.central.sensitivityExcludingFallback.prior.raceCount).toBe(2);
    // 補正量の統計: 主表には fallback レースの馬(補正 0・prior 採用)が入り、fallback を除いた値を併記する。
    const adj = r.central.adjustment;
    const adjKept = r.central.adjustmentExcludingFallback;
    expect(adj.horseCount).toBe(22);
    expect(adjKept.horseCount).toBe(14);
    expect(adj.usedPriorHorseCount).toBe(8);
    expect(adjKept.usedPriorHorseCount).toBe(0);
    // 前提: 除く前後で |δ| の平均が違う(fallback の馬の δ=0 が平均を下げている)。
    expect(adjKept.meanAbsDelta!).toBeGreaterThan(adj.meanAbsDelta! + 1e-4);
    // 主表: fallback のレースは LLM = prior なので、そのレースだけの差は 0。
    const priorSseR2 = OBS_C2.horses.reduce((t, h) => t + (h.prior - h.outcome) ** 2, 0);
    expect(priorSseR2).toBeGreaterThan(0);
    expect(r.central.paired.allRaces.observationCount).toBe(22);
  });

  it("fallback がなければ感度の除外は空で、主表と同じレース数", () => {
    const r = aggregateLlm(ALL_OBS, allRecords());
    expect(r.central.sensitivityExcludingFallback.excludedRaceIds).toEqual([]);
    expect(r.central.sensitivityExcludingFallback.paired.raceCount).toBe(3);
  });
});

describe("aggregateLlm: LLM の実行の要約と補正量の記述統計", () => {
  it("クリップ・prior 採用の馬数、リトライ・印救済・切り詰めのレースを数える", () => {
    const recs = allRecords().map((rec) => {
      if (rec.raceId === "202606040801") {
        return {
          ...rec,
          retryCount: 1,
          attempts: 2,
          marksDropped: true,
          horses: rec.horses.map((h) => (h.umaban === 1 ? { ...h, clipped: true } : h.umaban === 2 ? { ...h, usedPrior: true } : h)),
        };
      }
      return rec;
    });
    const r = aggregateLlm(ALL_OBS, recs);
    expect(r.central.llmRun.retriedRaceIds).toEqual(["202606040801"]);
    expect(r.central.llmRun.marksDroppedRaceIds).toEqual(["202606040801"]);
    expect(r.central.llmRun.truncatedRaceIds).toEqual([]);
    expect(r.central.adjustment.clippedHorseCount).toBe(1);
    expect(r.central.adjustment.usedPriorHorseCount).toBe(1);
    expect(r.nar.adjustment.clippedHorseCount).toBe(0);
  });

  it("補正量 δ = 補正後 − prior の平均・絶対値の平均・最大を出す(手計算)", () => {
    const r = aggregateLlm(ALL_OBS, allRecords());
    // 中央22頭: 各レースの馬番1・2が +0.05(3レース×2=6頭)、残り16頭が -0.02。
    const meanDelta = (6 * 0.05 + 16 * -0.02) / 22;
    const meanAbs = (6 * 0.05 + 16 * 0.02) / 22;
    expect(r.central.adjustment.meanDelta).toBeCloseTo(meanDelta, 12);
    expect(r.central.adjustment.meanAbsDelta).toBeCloseTo(meanAbs, 12);
    expect(r.central.adjustment.maxAbsDelta).toBeCloseTo(0.05, 12);
    expect(r.central.adjustment.horseCount).toBe(22);
  });

  it("結果別の平均補正量: 3着以内の馬と圏外の馬で分けて出す(補正の向きが結果と合ったか)", () => {
    const r = aggregateLlm(ALL_OBS, allRecords());
    const placed = [OBS_C1, OBS_C2, OBS_C3].flatMap((o) => o.horses.filter((h) => h.outcome === 1));
    const notPlaced = [OBS_C1, OBS_C2, OBS_C3].flatMap((o) => o.horses.filter((h) => h.outcome === 0));
    const mean = (hs: HorseObservation[]) => hs.reduce((s, h) => s + (bump(h) - h.prior), 0) / hs.length;
    expect(r.central.adjustment.placedHorseCount).toBe(placed.length);
    expect(r.central.adjustment.notPlacedHorseCount).toBe(notPlaced.length);
    expect(placed.length + notPlaced.length).toBe(22);
    expect(r.central.adjustment.meanDeltaPlaced).toBeCloseTo(mean(placed), 12);
    expect(r.central.adjustment.meanDeltaNotPlaced).toBeCloseTo(mean(notPlaced), 12);
    expect(r.central.adjustment.meanDeltaPlaced!).not.toBeCloseTo(r.central.adjustment.meanDeltaNotPlaced!, 3);
  });

  it("レースごとの Σ補正後確率と目標 min(3, 頭数) との差の要約(中央3レース)", () => {
    const r = aggregateLlm(ALL_OBS, allRecords());
    const dev = (o: RaceObservationOk) => o.horses.reduce((s, h) => s + bump(h), 0) - Math.min(3, o.horses.length);
    const devs = [dev(OBS_C1), dev(OBS_C2), dev(OBS_C3)].sort((a, b) => a - b);
    expect(r.central.adjustment.sumDeviation.n).toBe(3);
    expect(r.central.adjustment.sumDeviation.min).toBeCloseTo(devs[0]!, 12);
    expect(r.central.adjustment.sumDeviation.max).toBeCloseTo(devs[2]!, 12);
    expect(r.central.adjustment.sumDeviation.median).toBeCloseTo(devs[1]!, 12);
  });
});

describe("aggregateLlm: 方向性(LLM の補正が市場に寄ったか)", () => {
  const market = (o: RaceObservationOk) => marketImpliedLowerBound(o.horses.map((h) => ({ umaban: h.umaban, placeOddsMin: h.placeOddsMin })))!;

  it("LLM が prior から市場へ「ちょうど半分」寄せた合成: 傾き0.5・符号一致100%・市場までの距離は半分", () => {
    const half = (o: RaceObservationOk) => {
      const m = market(o);
      return (h: HorseObservation) => h.prior + 0.5 * (m.get(h.umaban)! - h.prior);
    };
    const recs = ALL_OBS.map((o) => record(o.raceId, o, half(o)));
    const r = aggregateLlm(ALL_OBS, recs);
    const tm = r.central.towardMarket;
    expect(tm.raceCount).toBe(2);
    expect(tm.horseCount).toBe(16);
    expect(tm.pooledSlope!).toBeCloseTo(0.5, 10);
    expect(tm.pooledCorrelation!).toBeCloseTo(1, 10);
    expect(tm.signAgreement.total).toBeGreaterThan(8); // 前提: 比較できる馬が十分いる
    expect(tm.signAgreement.agree).toBe(tm.signAgreement.total);
    expect(tm.meanAbsDistanceLlmToMarket!).toBeCloseTo(tm.meanAbsDistancePriorToMarket! * 0.5, 10);
    expect(tm.meanAbsDistancePriorToMarket!).toBeGreaterThan(0.01); // 空振り防止
    expect(tm.perRaceCorrelation.n).toBe(2);
    expect(tm.perRaceCorrelation.median!).toBeCloseTo(1, 10);
  });

  it("LLM が市場の反対側へ動かした合成: 傾きは負・符号一致は0・市場までの距離は増える", () => {
    const away = (o: RaceObservationOk) => {
      const m = market(o);
      return (h: HorseObservation) => h.prior - 0.3 * (m.get(h.umaban)! - h.prior);
    };
    const recs = ALL_OBS.map((o) => record(o.raceId, o, away(o)));
    const tm = aggregateLlm(ALL_OBS, recs).central.towardMarket;
    expect(tm.pooledSlope!).toBeCloseTo(-0.3, 10);
    expect(tm.signAgreement.agree).toBe(0);
    expect(tm.signAgreement.total).toBeGreaterThan(8);
    expect(tm.meanAbsDistanceLlmToMarket!).toBeGreaterThan(tm.meanAbsDistancePriorToMarket!);
  });

  it("補正が全馬 0 のとき、傾きは 0(動かなかった)・相関は null(補正の分散が0で定義できない)・符号一致の対象は0", () => {
    const recs = ALL_OBS.map((o) => record(o.raceId, o, (h) => h.prior));
    const tm = aggregateLlm(ALL_OBS, recs).central.towardMarket;
    expect(tm.pooledSlope).toBe(0);
    expect(tm.pooledCorrelation).toBeNull();
    expect(tm.perRaceCorrelation.n).toBe(0);
    expect(tm.perRaceCorrelation.nullCount).toBe(2);
    expect(tm.signAgreement.total).toBe(0);
    expect(tm.meanAbsDistanceLlmToMarket!).toBeCloseTo(tm.meanAbsDistancePriorToMarket!, 12);
  });

  it("対象は市場比較可能な集合だけ(頭数6のレースは含めない)", () => {
    const tm = aggregateLlm(ALL_OBS, allRecords()).central.towardMarket;
    expect(tm.raceCount).toBe(2);
    expect(tm.horseCount).toBe(16);
  });

  it("marketImpliedLowerBound は core の市場含意確率(下限・Σ=3 正規化)と一致する", () => {
    const horses = ODDS8.map((o, i) => ({ umaban: i + 1, placeOddsMin: o }));
    const mine = marketImpliedLowerBound(horses)!;
    const core = computeMarketImpliedPlaceProbabilities(horses);
    expect(core.values).not.toBeNull();
    for (const h of horses) {
      expect(mine.get(h.umaban)!).toBeCloseTo(core.values!.get(h.umaban)!, 12);
    }
    expect(marketImpliedLowerBound([{ umaban: 1, placeOddsMin: null }, { umaban: 2, placeOddsMin: 2 }])).toBeNull();
  });
});

describe("aggregateLlm: 整合性の検証(食い違えば失敗する)", () => {
  it("観測のあるレースの LLM 記録が無ければ失敗する(集合が違う対を作らない)", () => {
    expect(() => aggregateLlm(ALL_OBS, allRecords().slice(1))).toThrow(/202606040801.*LLM/);
  });

  it("観測の無いレースの LLM 記録があれば失敗する", () => {
    const extra = record("202606040899", OBS_C1, bump);
    expect(() => aggregateLlm(ALL_OBS, [...allRecords(), extra])).toThrow(/202606040899/);
  });

  it("prior が観測と食い違えば失敗する", () => {
    const recs = allRecords();
    recs[0] = { ...recs[0]!, horses: recs[0]!.horses.map((h) => (h.umaban === 3 ? { ...h, prior: h.prior + 0.01 } : h)) };
    expect(() => aggregateLlm(ALL_OBS, recs)).toThrow(/prior.*食い違/);
  });

  it("馬番の集合が観測と違えば失敗する", () => {
    const recs = allRecords();
    recs[0] = { ...recs[0]!, horses: recs[0]!.horses.slice(1) };
    expect(() => aggregateLlm(ALL_OBS, recs)).toThrow(/馬番/);
  });

  it("LLM 記録のスキーマ版が違えば失敗する", () => {
    const recs = allRecords();
    recs[0] = { ...recs[0]!, schemaVersion: 99 as unknown as typeof LLM_OBSERVATION_SCHEMA_VERSION };
    expect(() => aggregateLlm(ALL_OBS, recs)).toThrow(/schemaVersion/);
  });

  it("LLM 記録のプロンプト版・maxAdjust が条件と違えば失敗する(版の違う記録を混ぜない)", () => {
    const recs = allRecords();
    recs[0] = { ...recs[0]!, promptVersion: "2026-01-01.1" };
    expect(() => aggregateLlm(ALL_OBS, recs)).toThrow(/promptVersion/);
    const recs2 = allRecords();
    recs2[1] = { ...recs2[1]!, maxAdjust: 0.15 };
    expect(() => aggregateLlm(ALL_OBS, recs2)).toThrow(/maxAdjust/);
  });

  it("LLM 記録のプロンプト版・maxAdjust が条件と違えば失敗する(版の違う記録を混ぜない)", () => {
    const recs = allRecords();
    recs[0] = { ...recs[0]!, promptVersion: "2026-01-01.1" };
    expect(() => aggregateLlm(ALL_OBS, recs)).toThrow(/promptVersion/);
    const recs2 = allRecords();
    recs2[1] = { ...recs2[1]!, maxAdjust: 0.15 };
    expect(() => aggregateLlm(ALL_OBS, recs2)).toThrow(/maxAdjust/);
  });

  it("観測の除外レース(status: excluded)は対象にしない(記録が無くても失敗しない)", () => {
    const excluded = { ...OBS_C1, raceId: "202606040888", status: "excluded" as const, reason: "scrape-error", detail: "x" } as unknown as import("../probability-quality-41/observation.js").RaceObservation;
    const r = aggregateLlm([...ALL_OBS, excluded], allRecords());
    expect(r.central.raceCount).toBe(3);
  });
});
