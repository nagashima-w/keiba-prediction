import { describe, expect, it } from "vitest";
import {
  allocateBets,
  DEFAULT_BET_ALLOCATION_CONFIG,
  type AllocationHorse,
  type BetAllocationConfig,
} from "../../src/ev/bet-allocation.js";
import { resolveMaxBets } from "../../src/ev/allocation-primitives.js";

/**
 * 複勝の点数の上限 maxBets(Issue #533。複勝だけの経路 `allocateBets`)。
 * 固定する性質: (1) 上限を超えて買わない (2) 上限なし(未指定・0)は今とビット単位で同じ
 * (3) 上限が効かないレースでは上限なしと同じ (4) 上限の中で残りの買い目と配分を選び直す(後から削らない)。
 */

function horse(umaban: number, placeProb: number, placeOddsMin: number): AllocationHorse {
  const ev = placeProb * placeOddsMin;
  return { umaban, placeProb, placeOddsMin, ev, isPositive: ev > 1 };
}

/** 10頭立て。1〜5番がEVプラス(確率とオッズを高めに置き、貪欲が5点とも正にする)。6〜10番はEVマイナス。 */
const HORSES: readonly AllocationHorse[] = [
  horse(1, 0.5, 3.0),
  horse(2, 0.45, 3.4),
  horse(3, 0.4, 3.6),
  horse(4, 0.35, 4.2),
  horse(5, 0.3, 5.0),
  horse(6, 0.3, 1.5),
  horse(7, 0.25, 1.6),
  horse(8, 0.2, 1.7),
  horse(9, 0.15, 1.8),
  horse(10, 0.1, 1.9),
];

function config(overrides: Partial<BetAllocationConfig>): BetAllocationConfig {
  return { ...DEFAULT_BET_ALLOCATION_CONFIG, bankroll: 1_000_000, perRaceCap: 100_000, ...overrides };
}

const betCountOf = (r: ReturnType<typeof allocateBets>): number => r.allocations.filter((a) => a.stake > 0).length;
const positiveFractionCountOf = (r: ReturnType<typeof allocateBets>): number => r.allocations.filter((a) => a.continuousFraction > 0).length;

describe("allocateBets: 複勝の点数の上限 maxBets(Issue #533)", () => {
  it("前提: 上限なしでは、賭け金の付く買い目が3点より多い(上限の効果を検出できる状況である)", () => {
    const free = allocateBets(HORSES, 3, config({}));
    expect(betCountOf(free)).toBeGreaterThan(3);
  });

  for (const max of [1, 2, 3]) {
    it(`上限${max}: 賭け金の付く買い目も、正の連続配分を持つ買い目も、${max}点を超えない。残った買い目に予算を回し直す`, () => {
      const free = allocateBets(HORSES, 3, config({}));
      const limited = allocateBets(HORSES, 3, config({ maxBets: max }));
      expect(betCountOf(limited)).toBeLessThanOrEqual(max);
      expect(positiveFractionCountOf(limited)).toBe(max);
      expect(betCountOf(limited)).toBeGreaterThanOrEqual(1);
      // 後から削るのではなく選び直す: 残った買い目の連続配分は、上限なしのときの同じ買い目より大きい(予算を回している)。
      const kept = limited.allocations.filter((a) => a.continuousFraction > 0);
      const sumLimited = kept.reduce((acc, a) => acc + a.continuousFraction, 0);
      const sumFreeOfKept = kept.reduce((acc, a) => acc + free.allocations.find((f) => f.umaban === a.umaban)!.continuousFraction, 0);
      expect(sumLimited).toBeGreaterThan(sumFreeOfKept);
      // 上限を超えた分は外れている(上限なしでは買い目が増えていた)
      expect(betCountOf(free)).toBeGreaterThan(betCountOf(limited));
    });
  }

  it("上限なし: 省略・0・非有限・負は、上限を渡さない結果とビット単位で一致する", () => {
    const base = allocateBets(HORSES, 3, config({}));
    expect(allocateBets(HORSES, 3, config({ maxBets: 0 }))).toEqual(base);
    expect(allocateBets(HORSES, 3, config({ maxBets: -1 }))).toEqual(base);
    expect(allocateBets(HORSES, 3, config({ maxBets: Number.NaN }))).toEqual(base);
    expect(allocateBets(HORSES, 3, config({ maxBets: Number.POSITIVE_INFINITY }))).toEqual(base);
  });

  it("上限が効かない: 上限なしの買い目数と同じ、またはそれ以上の上限は、上限なしと一致する", () => {
    const base = allocateBets(HORSES, 3, config({}));
    const n = positiveFractionCountOf(base);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(allocateBets(HORSES, 3, config({ maxBets: n }))).toEqual(base);
    expect(allocateBets(HORSES, 3, config({ maxBets: n + 5 }))).toEqual(base);
    expect(allocateBets(HORSES, 3, config({ maxBets: 18 }))).toEqual(base);
  });

  it("非整数の上限は切り捨てる(2.9 は 2 と同じ)", () => {
    expect(allocateBets(HORSES, 3, config({ maxBets: 2.9 }))).toEqual(allocateBets(HORSES, 3, config({ maxBets: 2 })));
  });

  it("丸めで新しい買い目は生まれない: 1レース上限が小さく最低額ロジックが働く場合も、買い目は上限以内", () => {
    const tiny = allocateBets(HORSES, 3, config({ bankroll: 3_000, perRaceCap: 300, maxBets: 2 }));
    expect(betCountOf(tiny)).toBeLessThanOrEqual(2);
    expect(betCountOf(tiny)).toBeGreaterThanOrEqual(1);
  });

  it("候補外の馬は0円のまま全頭が含まれる(出力の形は変わらない)", () => {
    const limited = allocateBets(HORSES, 3, config({ maxBets: 2 }));
    expect(limited.allocations.map((a) => a.umaban)).toEqual(HORSES.map((h) => h.umaban));
  });
});

describe("resolveMaxBets(点数の上限の解決・Issue #533)", () => {
  const table: readonly [string, number | undefined, number][] = [
    ["省略", undefined, 0],
    ["0 は上限なし", 0, 0],
    ["負", -3, 0],
    ["1 未満の小数", 0.9, 0],
    ["NaN", Number.NaN, 0],
    ["Infinity", Number.POSITIVE_INFINITY, 0],
    ["1", 1, 1],
    ["2", 2, 2],
    ["非整数は切り捨て", 2.9, 2],
    ["18", 18, 18],
  ];
  for (const [label, raw, expected] of table) {
    it(`${label} → ${expected}`, () => {
      expect(resolveMaxBets(raw)).toBe(expected);
    });
  }
});
