import { describe, expect, it } from "vitest";

import { buildComboOddsKey } from "../../src/ev/combo-bet-allocation.js";
import {
  buildAllocationRecord,
  buildInvalidAllocationRecordForException,
  toMixedAllocationSettings,
  type AnalysisAllocationSettings,
} from "../../src/analysis/allocation-record.js";
import type { AnalysisRow } from "../../src/analysis/analysis-types.js";
import type { MixedCandidateBuildInput } from "../../src/analysis/mixed-candidates.js";
import {
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../../src/analysis/mixed-race-allocation.js";
import { buildRaceAllocation } from "../../src/analysis/race-allocation.js";
import { buildAllocationForRows } from "../../src/analysis/recompute-allocation.js";

/**
 * 単勝・複勝の点数の上限(Issue #533)の、設定 → 配分 → 配分の記録までの配線の検査。
 *
 * 9頭立ての実データ風の人気の分布で、単勝・複勝とも複数頭がEVプラスになり、上限がなければ何点も買う。
 * (全馬が同じ確率の対称な場は、単勝を全頭買うと確実に儲かる裁定になって複勝が選ばれないので使わない。)
 */

function row(umaban: number, adjustedProb: number, placeOddsMin: number, winOdds: number): AnalysisRow {
  return {
    umaban,
    wakuban: ((umaban - 1) % 8) + 1,
    horseName: `${umaban}番`,
    prior: adjustedProb,
    adjustedProb,
    placeOddsMin,
    winOdds,
    ev: adjustedProb * placeOddsMin,
    isPositive: adjustedProb * placeOddsMin > 1,
    reason: null,
    highlights: [],
    concerns: [],
    careerRunCount: 999,
    mark: null,
    evEstimated: false,
    conditionChangeTags: [],
  };
}

/** 9頭立て(複勝圏内確率の合計は3.00)。市場オッズは人気薄ほど割高で、単勝・複勝とも複数頭がEVプラスになる。 */
const PLACE_PROBS = [0.6, 0.52, 0.46, 0.38, 0.32, 0.26, 0.2, 0.15, 0.11];
const PLACE_ODDS = [1.4, 1.6, 2.0, 2.4, 3.2, 4.0, 5.5, 8, 11].map((v) => v * 1.15);
const WIN_ODDS = [3.2, 5, 6, 9, 12, 18, 25, 40, 60];
const ROWS = PLACE_PROBS.map((p, i) => row(i + 1, p, PLACE_ODDS[i]!, WIN_ODDS[i]!));

/** 8-9番のワイドだけ高オッズ(EVプラス)。組合せの候補が1件はあるので、混在経路(route=mixed)に入る。 */
const RACE: MixedCandidateBuildInput = { oddsStatus: "result", rows: ROWS, wideCombo: { [buildComboOddsKey([8, 9])]: 200 } };

function settings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: false,
    includeQuinellaInAllocation: false,
    includeExactaInAllocation: false,
    includeTrifectaInAllocation: false,
    includeBracketQuinellaInAllocation: false,
    minHitProb: 0,
    maxWinBets: 0,
    maxPlaceBets: 0,
    ...overrides,
  };
}

function mixedResult(o: ReturnType<typeof buildMixedRaceAllocationWithOutcome>) {
  if (o.view.kind !== "mixed") throw new Error(`mixedでない: ${o.view.kind}`);
  return o.view.result;
}
const buys = (r: ReturnType<typeof mixedResult>, betType: string): number =>
  r.allocations.filter((a) => a.betType === betType && a.stake > 0).length;

describe("混在配分: 単勝・複勝の点数の上限(Issue #533)", () => {
  const free = mixedResult(buildMixedRaceAllocationWithOutcome(RACE, settings()));

  it("前提: 上限なしでは、単勝・複勝とも3点より多く、ワイドも1点以上、賭け金が付く", () => {
    expect(buys(free, "win")).toBeGreaterThan(3);
    expect(buys(free, "place")).toBeGreaterThan(3);
    expect(buys(free, "wide")).toBeGreaterThanOrEqual(1);
  });

  it("単勝2点・複勝2点: それぞれ2点を超えて買わない。ワイドは上限の対象外で買い続ける", () => {
    const r = mixedResult(buildMixedRaceAllocationWithOutcome(RACE, settings({ maxWinBets: 2, maxPlaceBets: 2 })));
    expect(buys(r, "win")).toBeLessThanOrEqual(2);
    expect(buys(r, "place")).toBeLessThanOrEqual(2);
    expect(buys(r, "win")).toBeGreaterThanOrEqual(1);
    expect(buys(r, "place")).toBeGreaterThanOrEqual(1);
    expect(buys(r, "wide")).toBeGreaterThanOrEqual(1);
  });

  it("単勝だけ・複勝だけの上限は、それぞれ別々に数える", () => {
    const winOnly = mixedResult(buildMixedRaceAllocationWithOutcome(RACE, settings({ maxWinBets: 1 })));
    expect(buys(winOnly, "win")).toBe(1);
    expect(buys(winOnly, "place")).toBeGreaterThan(3);
    const placeOnly = mixedResult(buildMixedRaceAllocationWithOutcome(RACE, settings({ maxPlaceBets: 1 })));
    expect(buys(placeOnly, "place")).toBe(1);
    expect(buys(placeOnly, "win")).toBeGreaterThan(3);
  });

  it("上限0は上限なし: 上限を渡さない結果とビット単位で一致する。効かない上限(18)も同じ", () => {
    expect(mixedResult(buildMixedRaceAllocationWithOutcome(RACE, settings({ maxWinBets: 0, maxPlaceBets: 0 })))).toEqual(free);
    expect(mixedResult(buildMixedRaceAllocationWithOutcome(RACE, settings({ maxWinBets: 18, maxPlaceBets: 18 })))).toEqual(free);
  });

  it("下限で外した買い目の記録(recordMissed)でも、反事実の配分に同じ上限が効く", () => {
    const limited = settings({ minHitProb: 0.2, maxWinBets: 2, maxPlaceBets: 2, recordMissed: true });
    const outcome = buildMixedRaceAllocationWithOutcome(RACE, limited);
    const r = mixedResult(outcome);
    // 前提: 単勝の人気薄(的中確率が下限0.2未満)が外れ、記録が出ている(空振りでない)
    expect(r.belowFloor.filter((b) => b.betType === "win").length).toBeGreaterThanOrEqual(1);
    const missed = outcome.belowFloor!.missed!;
    const missedWin = missed.filter((m) => m.betType === "win");
    expect(missedWin.length).toBeGreaterThan(0);
    // 外さなかった場合の単勝の買い目も、上限(2点)以内
    expect(missedWin.length).toBeLessThanOrEqual(2);
  });
});

describe("複勝だけの経路(D-2フォールバック): 複勝の点数の上限(Issue #533)", () => {
  const placeOnlyRace: MixedCandidateBuildInput = { oddsStatus: "result", rows: ROWS };
  const noCombo = (o: Partial<MixedAllocationSettings>) => settings({ includeComboOdds: false, ...o });

  it("前提: 組合せオッズを取得しない設定では route=place-only で、上限なしなら複勝が3点より多く買われる", () => {
    const o = buildMixedRaceAllocationWithOutcome(placeOnlyRace, noCombo({}));
    expect(o.outcome.route).toBe("place-only");
    if (o.view.kind !== "computed") throw new Error("computedでない");
    expect(o.view.result.betCount).toBeGreaterThan(3);
  });

  it("複勝2点: 2点を超えて買わない。単勝の上限は複勝だけの経路に影響しない", () => {
    const o = buildMixedRaceAllocationWithOutcome(placeOnlyRace, noCombo({ maxPlaceBets: 2, maxWinBets: 1 }));
    expect(o.outcome.route).toBe("place-only");
    if (o.view.kind !== "computed") throw new Error("computedでない");
    expect(o.view.result.betCount).toBeLessThanOrEqual(2);
    expect(o.view.result.betCount).toBe(2);
    // 単勝の上限だけ(複勝は上限なし)なら、複勝だけの経路は上限なしと同じ
    const winOnly = buildMixedRaceAllocationWithOutcome(placeOnlyRace, noCombo({ maxWinBets: 1 }));
    const base = buildMixedRaceAllocationWithOutcome(placeOnlyRace, noCombo({}));
    expect(winOnly.view).toEqual(base.view);
  });

  it("組合せの候補が0件のフォールバック(no-combo-candidates)でも複勝の上限が効く", () => {
    // 組合せオッズは取得しているが、ワイドの候補が1件も EV プラスにならない(オッズ1.0)
    const race: MixedCandidateBuildInput = { oddsStatus: "result", rows: ROWS, wideCombo: { [buildComboOddsKey([8, 9])]: 1.0 } };
    const o = buildMixedRaceAllocationWithOutcome(race, settings({ maxPlaceBets: 2 }));
    expect(o.outcome.fallbackReason).toBe("no-combo-candidates");
    if (o.view.kind !== "computed") throw new Error("computedでない");
    expect(o.view.result.betCount).toBe(2);
  });

  it("下限で外した複勝の記録(recordMissed)でも、反事実の配分に複勝の上限が効く(Issue #535-A。上限を外す変異を殺す)", () => {
    const floor = 0.3;
    const withFloor = noCombo({ minHitProb: floor, maxPlaceBets: 2, recordMissed: true });
    const o = buildMixedRaceAllocationWithOutcome(placeOnlyRace, withFloor);
    // 前提(空振り防止): 複勝だけの経路で、下限 0.3 未満の複勝(6〜9番)が外れ、記録が付く
    expect(o.outcome.route).toBe("place-only");
    expect(o.belowFloor?.count).toBe(4);
    const missed = o.belowFloor?.missed;
    expect(missed).not.toBeNull();
    // 上限ありの反事実(minHitProb=0・maxPlaceBets=2)と上限なしの反事実は、外れた馬の賭け金が違う(差が0でない)
    const stakes = (maxPlaceBets: number): Map<number, number> => {
      const cf = buildMixedRaceAllocationWithOutcome(placeOnlyRace, noCombo({ minHitProb: 0, maxPlaceBets }));
      if (cf.view.kind !== "computed") throw new Error("computedでない");
      return new Map(cf.view.result.allocations.map((a) => [a.umaban, a.stake]));
    };
    const limitedStakes = stakes(2);
    const freeStakes = stakes(0);
    const below = [6, 7, 8, 9];
    const pick = (m: Map<number, number>): number[][] => below.map((u) => [u, m.get(u) ?? 0]).filter(([, st]) => st! > 0) as number[][];
    expect(pick(freeStakes)).not.toEqual(pick(limitedStakes));
    expect(pick(freeStakes).length).toBeGreaterThan(2);
    // 記録は上限ありの反事実に一致する: 2点だけ(上限なしなら4点になる)
    expect(missed!.map((m) => [Number(m.comboKey), m.wouldStake])).toEqual(pick(limitedStakes));
    expect(missed!.map((m) => [m.comboKey, m.wouldStake])).toEqual([["08", 24000], ["09", 17500]]);
  });

  it("buildRaceAllocation: maxPlaceBets を省略した呼び出しは、0を明示した呼び出しと一致する(既存の呼び出しを壊さない)", () => {
    const base = { bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5 };
    const omitted = buildRaceAllocation({ oddsStatus: "result", rows: ROWS }, base);
    const zero = buildRaceAllocation({ oddsStatus: "result", rows: ROWS }, { ...base, maxPlaceBets: 0 });
    expect(zero).toEqual(omitted);
    const two = buildRaceAllocation({ oddsStatus: "result", rows: ROWS }, { ...base, maxPlaceBets: 2 });
    if (two.kind !== "computed") throw new Error("computedでない");
    expect(two.result.betCount).toBe(2);
  });
});

describe("配分の記録: 使った上限を残す(Issue #533)", () => {
  const allocationSettings: AnalysisAllocationSettings = {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    minHitProb: 0,
    maxWinBets: 2,
    maxPlaceBets: 3,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: false,
    includeQuinellaInAllocation: false,
    includeExactaInAllocation: false,
    includeTrifectaInAllocation: false,
    includeBracketQuinellaInAllocation: false,
  };

  it("toMixedAllocationSettings: 上限が混在配分の設定にそのまま渡る", () => {
    const m = toMixedAllocationSettings(allocationSettings, 1.0);
    expect(m.maxWinBets).toBe(2);
    expect(m.maxPlaceBets).toBe(3);
  });

  it("buildAllocationForRows: 買い目は単勝2点以内・複勝3点以内で、メタ行に使った上限が入る", () => {
    const { allocation } = buildAllocationForRows({
      rows: ROWS,
      raceId: "202603020211",
      odds: { oddsStatus: "result" as const, win: {}, place: {}, wideCombo: RACE.wideCombo } as never,
      allocationSettings,
    });
    expect(allocation.meta.route).toBe("mixed");
    expect(allocation.bets.filter((b) => b.betType === "win").length).toBeLessThanOrEqual(2);
    expect(allocation.bets.filter((b) => b.betType === "win").length).toBeGreaterThanOrEqual(1);
    expect(allocation.bets.filter((b) => b.betType === "place").length).toBeLessThanOrEqual(3);
    expect(allocation.bets.filter((b) => b.betType === "place").length).toBe(3);
    expect(allocation.meta.maxWinBets).toBe(2);
    expect(allocation.meta.maxPlaceBets).toBe(3);
  });

  it("配分に到達しない経路(未設定)と、例外のフォールバックの記録にも、使った上限が入る", () => {
    const unset = buildAllocationRecord(
      buildMixedRaceAllocationWithOutcome(RACE, settings({ bankroll: 0, maxWinBets: 2, maxPlaceBets: 2 })),
      settings({ bankroll: 0, maxWinBets: 2, maxPlaceBets: 2 }),
      "result",
    );
    expect(unset.meta.route).toBe("unset");
    expect(unset.meta.maxWinBets).toBe(2);
    expect(unset.meta.maxPlaceBets).toBe(2);
    const invalid = buildInvalidAllocationRecordForException(settings({ maxWinBets: 2, maxPlaceBets: 2 }), "result");
    expect(invalid.meta.maxWinBets).toBe(2);
    expect(invalid.meta.maxPlaceBets).toBe(2);
  });
});
