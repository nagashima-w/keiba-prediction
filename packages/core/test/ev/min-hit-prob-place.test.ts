import { describe, expect, it } from "vitest";
import {
  allocateBets,
  DEFAULT_BET_ALLOCATION_CONFIG,
  type AllocationHorse,
  type BetAllocationConfig,
} from "../../src/ev/bet-allocation.js";

/** 候補馬(EVプラス・オッズあり)。 */
function horse(umaban: number, placeProb: number, placeOddsMin: number): AllocationHorse {
  const ev = placeProb * placeOddsMin;
  return { umaban, placeProb, placeOddsMin, ev, isPositive: ev > 1 };
}

/**
 * 8頭立て(確率の合計は3.0)。
 * - 1番: 本命(p=0.55・2.5倍・EV1.375)
 * - 2番: 大穴(p=0.03・60倍・EV1.8)。EVはプラスだが的中確率が低い
 * - 3番: ちょうど下限0.05(p=0.05・25倍・EV1.25)
 * - 5〜8番: EVマイナス(候補外)
 */
const HORSES: readonly AllocationHorse[] = [
  horse(1, 0.55, 2.5),
  horse(2, 0.03, 60),
  horse(3, 0.05, 25),
  horse(4, 0.6, 1.2),
  horse(5, 0.5, 1.3),
  horse(6, 0.5, 1.1),
  horse(7, 0.4, 1.4),
  horse(8, 0.37, 1.2),
];

function config(overrides: Partial<BetAllocationConfig>): BetAllocationConfig {
  return { ...DEFAULT_BET_ALLOCATION_CONFIG, bankroll: 1_000_000, perRaceCap: 100_000, ...overrides };
}

describe("allocateBets: 的中確率の下限 minHitProb(Issue #470)", () => {
  it("前提: 下限なしでは、確率の低い2番にも賭け金が付く(下限の効果を検出できる状況である)", () => {
    const result = allocateBets(HORSES, 3, config({}));
    const h2 = result.allocations.find((a) => a.umaban === 2)!;
    expect(h2.stake).toBeGreaterThan(0);
    expect(result.minHitProb).toBe(0);
    expect(result.belowFloor).toEqual([]);
  });

  it("下限を省略した結果と、下限0を明示した結果は完全に一致する(既存の挙動を変えない)", () => {
    const omitted = allocateBets(HORSES, 3, config({}));
    const zero = allocateBets(HORSES, 3, config({ minHitProb: 0 }));
    expect(zero).toEqual(omitted);
  });

  it("下限0.05: 確率0.03の2番は候補から外れ、賭け金0・候補外の理由が付く", () => {
    const result = allocateBets(HORSES, 3, config({ minHitProb: 0.05 }));
    const h2 = result.allocations.find((a) => a.umaban === 2)!;
    expect(h2.stake).toBe(0);
    expect(h2.continuousFraction).toBe(0);
    expect(h2.excludedReason).toBe("的中確率が下限未満のため対象外");
    expect(result.minHitProb).toBe(0.05);
  });

  it("境界: ちょうど下限(0.05)の3番は残る(未満だけを外す)。外れる直前の値との対比も確かめる", () => {
    const atFloor = allocateBets(HORSES, 3, config({ minHitProb: 0.05 }));
    const h3 = atFloor.allocations.find((a) => a.umaban === 3)!;
    expect(h3.excludedReason).toBeNull();
    // 下限を0.0500001に上げると、3番も外れる(境界の両側を確かめる)
    const above = allocateBets(HORSES, 3, config({ minHitProb: 0.0500001 }));
    expect(above.allocations.find((a) => a.umaban === 3)!.excludedReason).toBe("的中確率が下限未満のため対象外");
  });

  it("外れた候補の一覧に、確率・オッズ・EVが入る。candidateCount+excludedCountは全頭に一致する", () => {
    const result = allocateBets(HORSES, 3, config({ minHitProb: 0.05 }));
    expect(result.belowFloor).toEqual([
      { betType: "place", umabans: [2], hitProb: 0.03, odds: 60, ev: 0.03 * 60 },
    ]);
    expect(result.diagnostics.candidateCount + result.diagnostics.excludedCount).toBe(HORSES.length);
    expect(result.diagnostics.candidateCount).toBe(2);
  });

  it("下限を上げても、本命(1番)は候補のまま残り、見送りにはならない", () => {
    const result = allocateBets(HORSES, 3, config({ minHitProb: 0.05 }));
    expect(result.isSkip).toBe(false);
    expect(result.allocations.find((a) => a.umaban === 1)!.stake).toBeGreaterThan(0);
  });

  it("EVプラスの候補が下限で全部外れたら、見送りの理由は below-min-hit-prob(no-candidates ではない)", () => {
    const onlyLong = [horse(1, 0.03, 60), ...HORSES.slice(3)];
    const baseline = allocateBets(onlyLong, 3, config({}));
    expect(baseline.diagnostics.candidateCount).toBe(1); // 前提: 下限なしでは候補がある
    const result = allocateBets(onlyLong, 3, config({ minHitProb: 0.05 }));
    expect(result.diagnostics.candidateCount).toBe(0);
    expect(result.isSkip).toBe(true);
    expect(result.skipReasonCode).toBe("below-min-hit-prob");
    expect(result.skipReason).toBe("EVプラスの馬はいますが、的中確率が下限に満たないため見送りです");
  });

  it("EVプラスの候補が元から無いときは、下限があっても no-candidates のまま", () => {
    const none = HORSES.filter((h) => !h.isPositive);
    const result = allocateBets(none, 3, config({ minHitProb: 0.05 }));
    expect(none.length).toBeGreaterThan(0);
    expect(result.belowFloor).toEqual([]);
    expect(result.skipReasonCode).toBe("no-candidates");
  });

  it.each([
    { raw: Number.NaN, resolved: 0 },
    { raw: -0.1, resolved: 0 },
    { raw: Number.POSITIVE_INFINITY, resolved: 0 },
    { raw: 2, resolved: 1 },
  ])("不正な下限($raw)は $resolved に解決され、サイレントに壊れない", ({ raw, resolved }) => {
    const result = allocateBets(HORSES, 3, config({ minHitProb: raw }));
    expect(result.minHitProb).toBe(resolved);
    expect(Number.isFinite(result.totalStake)).toBe(true);
  });
});
