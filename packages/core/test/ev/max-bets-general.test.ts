import { describe, expect, it } from "vitest";
import {
  allocateGeneralBets,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type AllocationBetType,
  type AllocationCandidate,
  type GeneralBetAllocationConfig,
  type GeneralBetAllocationResult,
} from "../../src/ev/combo-bet-allocation.js";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";

/**
 * 券種ごとの点数の上限 maxBetsByType(Issue #533。単勝 `win`・複勝 `place` を使う。組合せ券種は対象外)。
 * 固定する性質: (1) 券種ごとに上限を超えて買わない (2) 上限なし(未指定・空・0)は今とビット単位で同じ
 * (3) 上限が効かないレースでは上限なしと同じ (4) 上限のない券種は影響を受けない (5) 丸めで新しい買い目は生まれない。
 */

const HORSES: JointModelHorse[] = Array.from({ length: 8 }, (_, i) => ({ umaban: i + 1, placeProb: 3 / 8 }));

function cand(betType: AllocationBetType, umabans: number[], odds: number, hitProb: number): AllocationCandidate {
  return { betType, umabans, odds, ev: hitProb * odds, isPositive: true, hitProb };
}

/** 単勝5点(1/8 の確率にオッズ10〜14)・複勝5点(3/8 の確率にオッズ2.8〜3.4)・ワイド3点。すべてEVプラス。 */
const WIN_ODDS = [14, 13, 12, 11, 10];
const PLACE_ODDS = [3.4, 3.2, 3.0, 2.9, 2.8];
const CANDIDATES: AllocationCandidate[] = [
  ...WIN_ODDS.map((o, i) => cand("win", [i + 1], o, 1 / 8)),
  ...PLACE_ODDS.map((o, i) => cand("place", [i + 1], o, 3 / 8)),
  cand("wide", [1, 2], 12, 3 / 28),
  cand("wide", [3, 4], 12, 3 / 28),
  cand("wide", [5, 6], 12, 3 / 28),
];

function config(overrides: Partial<GeneralBetAllocationConfig>): GeneralBetAllocationConfig {
  return { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 1_000_000, perRaceCap: 100_000, ...overrides };
}

const buyCount = (r: GeneralBetAllocationResult, betType: AllocationBetType): number =>
  r.allocations.filter((a) => a.betType === betType && a.stake > 0).length;
const positiveCount = (r: GeneralBetAllocationResult, betType: AllocationBetType): number =>
  r.allocations.filter((a) => a.betType === betType && a.continuousFraction > 0).length;

describe("allocateGeneralBets: 券種ごとの点数の上限 maxBetsByType(Issue #533)", () => {
  const free = allocateGeneralBets(HORSES, 3, CANDIDATES, config({}));

  it("前提: 上限なしでは、単勝・複勝とも3点より多く賭け金が付く(上限の効果を検出できる状況である)", () => {
    expect(free.winOutcome.kind).toBe("determined");
    expect(buyCount(free, "win")).toBeGreaterThan(3);
    expect(buyCount(free, "place")).toBeGreaterThan(3);
    expect(buyCount(free, "wide")).toBeGreaterThanOrEqual(1);
  });

  for (const [winMax, placeMax] of [[2, 2], [1, 3], [3, 1]] as const) {
    it(`単勝${winMax}点・複勝${placeMax}点: それぞれの券種で上限を超えて買わない。選び直した結果、上限ちょうどまで使う`, () => {
      const r = allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: winMax, place: placeMax } }));
      expect(r.winOutcome.kind).toBe("determined");
      expect(buyCount(r, "win")).toBeLessThanOrEqual(winMax);
      expect(buyCount(r, "place")).toBeLessThanOrEqual(placeMax);
      expect(positiveCount(r, "win")).toBe(winMax);
      expect(positiveCount(r, "place")).toBe(placeMax);
      expect(r.betCount).toBeGreaterThanOrEqual(1);
    });
  }

  it("単勝だけに上限を付けても、複勝は上限なしのまま(券種ごとに別々に数える)。逆も同じ", () => {
    const winOnly = allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: 2 } }));
    expect(positiveCount(winOnly, "win")).toBe(2);
    expect(positiveCount(winOnly, "place")).toBeGreaterThan(2);
    const placeOnly = allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { place: 2 } }));
    expect(positiveCount(placeOnly, "place")).toBe(2);
    expect(positiveCount(placeOnly, "win")).toBeGreaterThan(2);
  });

  it("組合せ券種(ワイド)は群に入らない: 単勝・複勝の上限を付けても、ワイドは貪欲で選ばれ続ける", () => {
    const r = allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: 2, place: 2 } }));
    // 前提: 上限なしでワイドが選ばれている。群に入れていないので、上限をかけてもワイドは選ばれ続ける。
    expect(positiveCount(free, "wide")).toBeGreaterThanOrEqual(1);
    expect(positiveCount(r, "wide")).toBeGreaterThanOrEqual(1);
  });

  it("上限なし: 未指定・空オブジェクト・0・非有限・負は、上限を渡さない結果とビット単位で一致する", () => {
    expect(allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: {} }))).toEqual(free);
    expect(allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: 0, place: 0 } }))).toEqual(free);
    expect(allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: -1, place: Number.NaN } }))).toEqual(free);
    expect(allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: Number.POSITIVE_INFINITY } }))).toEqual(free);
  });

  it("上限が効かない: 上限なしの点数以上の上限は、上限なしとビット単位で一致する", () => {
    const winN = positiveCount(free, "win");
    const placeN = positiveCount(free, "place");
    expect(winN).toBeGreaterThanOrEqual(2);
    expect(placeN).toBeGreaterThanOrEqual(2);
    expect(allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: winN, place: placeN } }))).toEqual(free);
    expect(allocateGeneralBets(HORSES, 3, CANDIDATES, config({ maxBetsByType: { win: 18, place: 18 } }))).toEqual(free);
  });

  it("丸めで新しい買い目は生まれない: 少額で最低額ロジックが働く場合も、買い目は上限以内", () => {
    const tiny = allocateGeneralBets(HORSES, 3, CANDIDATES, config({ bankroll: 400, perRaceCap: 300, maxBetsByType: { win: 1, place: 1 } }));
    expect(tiny.minimumStakeApplied).toBe(true);
    expect(tiny.betCount).toBe(1);
    expect(buyCount(tiny, "win")).toBeLessThanOrEqual(1);
    expect(buyCount(tiny, "place")).toBeLessThanOrEqual(1);
  });

  it("的中確率の下限(minHitProb)と併用できる: 下限で外れた候補は上限の枠を使わない", () => {
    const withFloor = allocateGeneralBets(HORSES, 3, CANDIDATES, config({ minHitProb: 0.2, maxBetsByType: { place: 2 } }));
    // 単勝の的中確率は 1/8(0.125)で下限0.2に満たず全部外れる。複勝(0.375)は残り、上限2点まで使う。
    expect(withFloor.belowFloor.filter((b) => b.betType === "win")).toHaveLength(5);
    expect(positiveCount(withFloor, "win")).toBe(0);
    expect(positiveCount(withFloor, "place")).toBe(2);
  });

  it("下限で外した場合の反事実(下限0)も、同じ上限のもとで計算できる(上限は下限と独立)", () => {
    const a = allocateGeneralBets(HORSES, 3, CANDIDATES, config({ minHitProb: 0, maxBetsByType: { win: 2, place: 2 } }));
    expect(positiveCount(a, "win")).toBe(2);
    expect(positiveCount(a, "place")).toBe(2);
  });
});
