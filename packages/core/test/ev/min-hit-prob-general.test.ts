import { describe, expect, it } from "vitest";
import {
  allocateGeneralBets,
  buildComboCandidates,
  buildExactaCandidates,
  buildQuinellaCandidates,
  buildTrifectaCandidates,
  buildWinCandidates,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type AllocationCandidate,
  type GeneralBetAllocationConfig,
} from "../../src/ev/combo-bet-allocation.js";
import {
  ALL_SKIP_REASON_CODES,
  determineSkipReasonCode,
  isBelowMinHitProb,
  resolveMinHitProb,
} from "../../src/ev/allocation-primitives.js";
import { buildComboOddsKey, buildOrderedComboOddsKey } from "../../src/scraper/combo-odds-key.js";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";

/** n頭・均等な複勝圏内確率の出走馬。 */
function evenHorses(n: number, topFinishCount: number): JointModelHorse[] {
  return Array.from({ length: n }, (_, i) => ({ umaban: i + 1, placeProb: topFinishCount / n }));
}

function candidate(
  betType: AllocationCandidate["betType"],
  umabans: number[],
  odds: number,
  ev: number,
  hitProb?: number,
): AllocationCandidate {
  return { betType, umabans, odds, ev, isPositive: true, ...(hitProb === undefined ? {} : { hitProb }) };
}

function config(overrides: Partial<GeneralBetAllocationConfig>): GeneralBetAllocationConfig {
  return { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 1_000_000, perRaceCap: 100_000, ...overrides };
}

const HORSES = evenHorses(8, 3);

/**
 * 候補(8頭立て)。同時分布では全て妙味が大きいので、下限がなければ賭け金が付く。
 * - A: ワイド [1,2] hitProb=0.30(ev/oddsも0.30)
 * - B: 複勝 [3] hitProb=0.02(低い。ev/odds も 0.02)
 * - C: ワイド [4,5] hitProb=0.05(ちょうど下限)
 * - D: 三連複 [6,7,8] hitProb 無し・ev/odds=0.03(hitProb が無いときは ev/odds で判定する)
 * - E: ワイド [1,3] hitProb=0.20 だが ev/odds=0.01(hitProb があればそちらを使う)
 */
const A = candidate("wide", [1, 2], 4, 1.2, 0.3);
const B = candidate("place", [3], 80, 1.6, 0.02);
const C = candidate("wide", [4, 5], 30, 1.5, 0.05);
const D = candidate("trio", [6, 7, 8], 100, 3, undefined);
const E = candidate("wide", [1, 3], 100, 1, 0.2);
const ALL = [A, B, C, D, E];

describe("allocateGeneralBets: 的中確率の下限 minHitProb(Issue #470)", () => {
  it("前提: 下限なしでは、確率の低い B・D にも賭け金が付く(下限の効果を検出できる)", () => {
    const result = allocateGeneralBets(HORSES, 3, ALL, config({}));
    const stakeOf = (c: AllocationCandidate): number =>
      result.allocations.find((a) => a.betType === c.betType && a.umabans.join() === c.umabans.join())!.stake;
    expect(stakeOf(B)).toBeGreaterThan(0);
    expect(stakeOf(D)).toBeGreaterThan(0);
    expect(result.minHitProb).toBe(0);
    expect(result.belowFloor).toEqual([]);
  });

  it("下限を省略した結果と、下限0を明示した結果は完全に一致する", () => {
    expect(allocateGeneralBets(HORSES, 3, ALL, config({ minHitProb: 0 }))).toEqual(
      allocateGeneralBets(HORSES, 3, ALL, config({})),
    );
  });

  it("下限0.05: B(0.02)・D(ev/odds=0.03)は外れ、ちょうど下限のC(0.05)と、hitProbが高いEは残る", () => {
    const result = allocateGeneralBets(HORSES, 3, ALL, config({ minHitProb: 0.05 }));
    const keys = result.allocations.map((a) => `${a.betType}:${a.umabans.join(",")}`);
    expect(keys).toEqual(["wide:1,2", "wide:1,3", "wide:4,5"]);
    expect(result.minHitProb).toBe(0.05);
    expect(result.belowFloor).toEqual([
      { betType: "place", umabans: [3], hitProb: 0.02, odds: 80, ev: 1.6 },
      { betType: "trio", umabans: [6, 7, 8], hitProb: 3 / 100, odds: 100, ev: 3 },
    ]);
  });

  it("診断: inputCandidateCountは下限の前の件数のまま、candidateCountは下限の後の件数になる", () => {
    const result = allocateGeneralBets(HORSES, 3, ALL, config({ minHitProb: 0.05 }));
    expect(result.diagnostics.inputCandidateCount).toBe(5);
    expect(result.diagnostics.candidateCount).toBe(3);
    expect(result.belowFloor.length).toBe(2);
  });

  it("全候補が下限で外れたら、見送り理由は below-min-hit-prob で、買い目の行は無い", () => {
    const result = allocateGeneralBets(HORSES, 3, [B, D], config({ minHitProb: 0.05 }));
    expect(result.allocations).toEqual([]);
    expect(result.belowFloor.length).toBe(2);
    expect(result.isSkip).toBe(true);
    expect(result.skipReasonCode).toBe("below-min-hit-prob");
    expect(result.skipReason).toBe("EVプラスの買い目はありますが、的中確率が下限に満たないため見送りです");
  });

  it("EVプラスの候補が元から無いときは、下限があっても no-candidates のまま", () => {
    const result = allocateGeneralBets(HORSES, 3, [], config({ minHitProb: 0.05 }));
    expect(result.skipReasonCode).toBe("no-candidates");
  });

  it("isPositiveでない候補は、下限未満でも外れた候補に数えない(EVプラスでないので元から対象外)", () => {
    const notPositive: AllocationCandidate = { ...B, isPositive: false };
    const result = allocateGeneralBets(HORSES, 3, [A, notPositive], config({ minHitProb: 0.05 }));
    expect(result.belowFloor).toEqual([]);
  });

  it.each([
    { label: "NaN", hitProb: Number.NaN },
    { label: "負", hitProb: -0.1 },
    { label: "1超", hitProb: 1.5 },
  ])("不正な hitProb($label)の候補は契約違反として例外になる(黙って通さない)", ({ hitProb }) => {
    expect(() => allocateGeneralBets(HORSES, 3, [candidate("wide", [1, 2], 4, 1.2, hitProb)], config({}))).toThrow();
  });
});

describe("候補ビルダーが hitProb を運ぶ(Issue #470)", () => {
  const horses = evenHorses(6, 3);
  /** 全ての組に高いオッズを付ける(EVプラスの候補が必ず出る)。 */
  function oddsMap(keys: string[]): Map<string, number | null> {
    return new Map(keys.map((k) => [k, 500]));
  }
  function perms(items: number[], k: number): number[][] {
    if (k === 0) return [[]];
    return items.flatMap((x) => perms(items.filter((y) => y !== x), k - 1).map((rest) => [x, ...rest]));
  }
  function combs(items: number[], k: number): number[][] {
    if (k === 0) return [[]];
    return items.flatMap((x, i) => combs(items.slice(i + 1), k - 1).map((rest) => [x, ...rest]));
  }
  const nums = horses.map((h) => h.umaban);

  const cases: { label: string; build: () => readonly AllocationCandidate[] }[] = [
    { label: "ワイド", build: () => buildComboCandidates(horses, 3, "wide", oddsMap(combs(nums, 2).map(buildComboOddsKey))).candidates },
    { label: "三連複", build: () => buildComboCandidates(horses, 3, "trio", oddsMap(combs(nums, 3).map(buildComboOddsKey))).candidates },
    { label: "馬連", build: () => buildQuinellaCandidates(horses, 3, oddsMap(combs(nums, 2).map(buildComboOddsKey))).candidates },
    { label: "馬単", build: () => buildExactaCandidates(horses, 3, oddsMap(perms(nums, 2).map(buildOrderedComboOddsKey))).candidates },
    { label: "三連単", build: () => buildTrifectaCandidates(horses, 3, oddsMap(perms(nums, 3).map(buildOrderedComboOddsKey))).candidates },
    { label: "単勝", build: () => buildWinCandidates(horses, 3, new Map(nums.map((n) => [n, 500]))).candidates },
  ];

  it.each(cases)("$label: 全ての候補が hitProb を持ち、ev = hitProb × odds に一致する", ({ build }) => {
    const candidates = build();
    expect(candidates.length).toBeGreaterThan(0); // 前提: 候補が出ている(空振りでない)
    for (const c of candidates) {
      expect(c.hitProb).toBeDefined();
      expect(c.hitProb!).toBeGreaterThan(0);
      expect(c.hitProb!).toBeLessThanOrEqual(1);
      expect(Math.abs(c.hitProb! * c.odds - c.ev)).toBeLessThan(1e-9);
    }
  });
});

describe("allocation-primitives: 下限まわり(Issue #470)", () => {
  it("SkipReasonCode の全メンバーは7つで、below-min-hit-prob を含む", () => {
    expect([...ALL_SKIP_REASON_CODES].sort()).toEqual(
      ["bankroll-unset", "below-min-hit-prob", "cap-too-small", "cap-unset", "kelly-zero", "no-candidates", "no-edge"].sort(),
    );
  });

  it.each([
    // [bankroll, cap, effCap, unit, kellyTarget, kelly, candidates, belowFloor, 期待]
    { args: [0, 1000, 1000, 100, 0, 0.5, 0, 3], expected: "bankroll-unset" },
    { args: [1000, 0, 0, 100, 0, 0.5, 0, 3], expected: "cap-unset" },
    { args: [1000, 50, 0, 100, 0, 0.5, 0, 3], expected: "cap-too-small" },
    { args: [1000, 1000, 1000, 100, 0, 0, 0, 3], expected: "kelly-zero" },
    { args: [1000, 1000, 1000, 100, 0, 0.5, 0, 3], expected: "below-min-hit-prob" },
    { args: [1000, 1000, 1000, 100, 0, 0.5, 0, 0], expected: "no-candidates" },
    { args: [1000, 1000, 1000, 100, 0, 0.5, 2, 3], expected: "no-edge" },
  ])("見送り理由の優先順位: $expected", ({ args, expected }) => {
    const [b, c, e, u, k, f, n, bf] = args as [number, number, number, number, number, number, number, number];
    expect(determineSkipReasonCode(b, c, e, u, k, f, n, bf)).toBe(expected);
  });

  it("belowFloorCount を省略すると従来の判定(no-candidates)になる", () => {
    expect(determineSkipReasonCode(1000, 1000, 1000, 100, 0, 0.5, 0)).toBe("no-candidates");
  });

  it.each([
    { raw: undefined, expected: 0 },
    { raw: 0, expected: 0 },
    { raw: 0.05, expected: 0.05 },
    { raw: 1, expected: 1 },
    { raw: 1.5, expected: 1 },
    { raw: -0.2, expected: 0 },
    { raw: Number.NaN, expected: 0 },
    { raw: Number.POSITIVE_INFINITY, expected: 0 },
  ])("resolveMinHitProb($raw) = $expected", ({ raw, expected }) => {
    expect(resolveMinHitProb(raw)).toBe(expected);
  });

  it.each([
    { hit: 0.0499, floor: 0.05, below: true },
    { hit: 0.05, floor: 0.05, below: false },
    { hit: 0.0501, floor: 0.05, below: false },
    { hit: 0, floor: 0, below: false },
  ])("isBelowMinHitProb($hit, $floor) = $below", ({ hit, floor, below }) => {
    expect(isBelowMinHitProb(hit, floor)).toBe(below);
  });
});
