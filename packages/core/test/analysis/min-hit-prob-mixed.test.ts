import { describe, expect, it } from "vitest";

import { buildAllocationBetComboKey, buildComboOddsKey } from "../../src/ev/combo-bet-allocation.js";
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
import { buildMixedCandidates } from "../../src/analysis/mixed-candidates.js";
import { buildAllocationForRows } from "../../src/analysis/recompute-allocation.js";

/**
 * 的中確率の下限(Issue #470)の、混在配分・複勝のみのフォールバック・配分の記録への配線の検査。
 *
 * 8頭立て・全馬の複勝圏内確率が 0.375(合計3)のレースでは、同時分布が対称なので的中確率が決まる:
 * 単勝 1/8=0.125・ワイド 0.107・三連複 1/56=0.0179・複勝 0.375(入力の adjustedProb)。
 * ワイド・三連複のオッズを高くしてEVプラスにする。下限 0.05 で三連複だけが外れる。
 */

function row(umaban: number, adjustedProb: number, placeOddsMin: number): AnalysisRow {
  return {
    umaban,
    wakuban: ((umaban - 1) % 8) + 1,
    horseName: `${umaban}番`,
    prior: adjustedProb,
    adjustedProb,
    placeOddsMin,
    winOdds: 10,
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

function combos(umabans: readonly number[], k: number, odds: number): Record<string, number> {
  const out: Record<string, number> = {};
  const rec = (start: number, cur: number[]): void => {
    if (cur.length === k) {
      out[buildComboOddsKey(cur)] = odds;
      return;
    }
    for (let i = start; i < umabans.length; i++) rec(i + 1, [...cur, umabans[i]!]);
  };
  rec(0, []);
  return out;
}

const NUMS = [1, 2, 3, 4, 5, 6, 7, 8];
const EVEN_ROWS = NUMS.map((n) => row(n, 0.375, 3));

const MIXED_RACE: MixedCandidateBuildInput = {
  oddsStatus: "result",
  rows: EVEN_ROWS,
  wideCombo: combos(NUMS, 2, 20),
  // 馬番1を含む三連複だけ低いオッズ(58倍。EV=58/56=1.036でプラスだが妙味が薄く、下限なしでも賭け金が付かない)
  trioCombo: Object.fromEntries(Object.entries(combos(NUMS, 3, 200)).map(([k, v]) => [k, k.startsWith("01") ? 58 : v])),
};

function settings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
    minHitProb: 0,
    ...overrides,
  };
}

function mixedResult(o: ReturnType<typeof buildMixedRaceAllocationWithOutcome>) {
  if (o.view.kind !== "mixed") throw new Error(`mixedでない: ${o.view.kind}`);
  return o.view.result;
}

describe("混在配分: 下限 minHitProb(Issue #470)", () => {
  it("前提: 下限なしでは、確率の低い三連複(0.0179)にも賭け金が付く", () => {
    const base = mixedResult(buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings()));
    expect(base.allocations.filter((a) => a.betType === "trio" && a.stake > 0).length).toBeGreaterThan(0);
  });

  it("下限0.05: 三連複は全て外れ、外れた件数は三連複の56件(ワイド・複勝・単勝は候補に残る)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings({ minHitProb: 0.05, recordMissed: true }));
    const r = mixedResult(outcome);
    const types = new Set(r.allocations.map((a) => a.betType));
    expect(types.has("trio")).toBe(false);
    expect(types.has("wide")).toBe(true);
    expect(r.belowFloor.length).toBe(56);
    expect(outcome.belowFloor?.count).toBe(56);
    expect(r.minHitProb).toBe(0.05);
  });

  it("外さなかった場合の賭け金は、下限0の配分での同じ買い目の賭け金に一致し、賭け金が付いたものだけを記録する", () => {
    const base = mixedResult(buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings()));
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings({ minHitProb: 0.05, recordMissed: true }));
    const missed = outcome.belowFloor!.missed!;
    expect(missed.length).toBeGreaterThan(0); // 前提: 記録が出ている(空振りでない)
    expect(missed.length).toBeLessThan(56); // 前提: 賭け金0の候補(馬番1を含む低オッズの組)は記録に入らない(絞られている)
    const baseStake = new Map(base.allocations.map((a) => [buildAllocationBetComboKey(a.betType, a.umabans), a.stake]));
    for (const m of missed) {
      expect(m.betType).toBe("trio");
      expect(m.wouldStake).toBeGreaterThan(0);
      expect(m.wouldStake).toBe(baseStake.get(m.comboKey));
      expect(m.hitProb).toBeCloseTo(1 / 56, 10);
      expect(m.odds).toBe(200);
      expect(m.ev).toBeCloseTo(200 / 56, 10);
      expect(m.comboKey.startsWith("01")).toBe(false);
    }
    // 下限0で賭け金が付いた三連複は、全て記録されている(漏れが無い)
    const baseTrioStaked = base.allocations.filter((a) => a.betType === "trio" && a.stake > 0).length;
    expect(missed.length).toBe(baseTrioStaked);
  });

  it("recordMissed を指定しないと、2回目の配分は呼ばれず missed は null(件数は出る)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings({ minHitProb: 0.05 }));
    expect(outcome.belowFloor).toEqual({ count: 56, missed: null });
  });

  it("下限なし(0)では missed も null で、外れた件数は0(記録なしと『外れなし』は件数で区別できる)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings({ recordMissed: true }));
    expect(outcome.belowFloor).toEqual({ count: 0, missed: null });
  });

  it("外れた候補はあるが、外さなくても賭け金が付かなかった場合は、missed が空配列([])になる", () => {
    // ケリー係数0(賭けない設定)にして、下限を外しても全て0円になる状況を作る。
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings({ minHitProb: 0.05, recordMissed: true, kellyFraction: 0 }));
    const missed = outcome.belowFloor!.missed;
    expect(outcome.belowFloor!.count).toBe(56); // 前提: 外れている
    expect(missed).toEqual([]);
  });

  it("全候補が下限で外れたら、route は mixed のまま見送り(below-min-hit-prob)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings({ minHitProb: 0.5 }));
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.outcome.skipReasonCode).toBe("below-min-hit-prob");
    expect(mixedResult(outcome).allocations).toEqual([]);
  });

  it("組合せが全部外れても、複勝・単勝が残れば混在経路のまま(フォールバックの判定は下限の前の候補数)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, settings({ minHitProb: 0.2 }));
    expect(outcome.outcome.route).toBe("mixed");
    const types = new Set(mixedResult(outcome).allocations.map((a) => a.betType));
    expect(types.has("wide")).toBe(false);
    expect(types.has("trio")).toBe(false);
    expect(types.has("place")).toBe(true);
  });
});

describe("複勝のみのフォールバック: 下限 minHitProb(Issue #470)", () => {
  const probs = [0.55, 0.03, 0.05, 0.6, 0.5, 0.5, 0.4, 0.37];
  const odds = [2.5, 60, 25, 1.2, 1.3, 1.1, 1.4, 1.2];
  const rows = NUMS.map((n, i) => row(n, probs[i]!, odds[i]!));
  const race: MixedCandidateBuildInput = { oddsStatus: "result", rows };

  it("組合せオッズを取得しない設定では、複勝のみの配分に下限が効き、外さなかった場合の賭け金が記録される", () => {
    const base = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false }));
    expect(base.outcome.route).toBe("place-only"); // 前提
    if (base.view.kind !== "computed") throw new Error("computed でない");
    const baseStake2 = base.view.result.allocations.find((a) => a.umaban === 2)!.stake;
    expect(baseStake2).toBeGreaterThan(0); // 前提: 下限なしでは2番にも賭け金が付く

    const o = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false, minHitProb: 0.05, recordMissed: true }));
    if (o.view.kind !== "computed") throw new Error("computed でない");
    expect(o.view.result.allocations.find((a) => a.umaban === 2)!.stake).toBe(0);
    expect(o.belowFloor!.count).toBe(1);
    expect(o.belowFloor!.missed).toEqual([
      { betType: "place", comboKey: "02", hitProb: 0.03, odds: 60, ev: 0.03 * 60, wouldStake: baseStake2 },
    ]);
  });
});

describe("配分の記録(buildAllocationRecord)への下限の配線(Issue #470)", () => {
  it("meta に下限・外れた件数・外した買い目が出る。bets は従来どおり stake>0 の行だけ", () => {
    const s = settings({ minHitProb: 0.05, recordMissed: true });
    const outcome = buildMixedRaceAllocationWithOutcome(MIXED_RACE, s);
    const rec = buildAllocationRecord(outcome, s, "result");
    expect(rec.meta.minHitProb).toBe(0.05);
    expect(rec.meta.belowFloorCount).toBe(56);
    expect(rec.meta.missed).toEqual(outcome.belowFloor!.missed);
    expect(rec.meta.missed!.length).toBeGreaterThan(0);
    expect(rec.bets.length).toBeGreaterThan(0);
    expect(rec.bets.every((b) => b.stake > 0)).toBe(true);
    expect(rec.bets.some((b) => b.betType === "trio")).toBe(false);
  });

  it("配分の計算に到達しない経路(unset)でも下限は設定のエコーとして出るが、件数・記録は null", () => {
    const s = settings({ bankroll: 0, minHitProb: 0.05, recordMissed: true });
    const rec = buildAllocationRecord(buildMixedRaceAllocationWithOutcome(MIXED_RACE, s), s, "result");
    expect(rec.meta.route).toBe("unset");
    expect(rec.meta.minHitProb).toBe(0.05);
    expect(rec.meta.belowFloorCount).toBeNull();
    expect(rec.meta.missed).toBeNull();
  });

  it("例外時の無効の記録にも、下限の設定は出る", () => {
    const rec = buildInvalidAllocationRecordForException(settings({ minHitProb: 0.05 }), "result");
    expect(rec.meta.minHitProb).toBe(0.05);
    expect(rec.meta.belowFloorCount).toBeNull();
    expect(rec.meta.missed).toBeNull();
  });

  it("toMixedAllocationSettings: 下限は設定から通り、recordMissed は第3引数で決まる(省略は false)", () => {
    const a: AnalysisAllocationSettings = {
      bankroll: 1,
      perRaceCap: 1,
      kellyFraction: 0.5,
      minHitProb: 0.07,
      includeComboOdds: true,
      includeWideInAllocation: true,
      includeTrioInAllocation: true,
      includeQuinellaInAllocation: true,
      includeExactaInAllocation: true,
      includeTrifectaInAllocation: true,
      includeBracketQuinellaInAllocation: true,
    };
    expect(toMixedAllocationSettings(a, 1).minHitProb).toBe(0.07);
    expect(toMixedAllocationSettings(a, 1).recordMissed).toBeUndefined(); // 省略は『記録しない』
    expect(toMixedAllocationSettings(a, 1, true).recordMissed).toBe(true);
  });

  it("buildAllocationForRows: recordMissed を渡した分析では missed が出て、渡さない再計算では null", () => {
    const allocationSettings: AnalysisAllocationSettings = {
      bankroll: 1_000_000,
      perRaceCap: 100_000,
      kellyFraction: 0.5,
      minHitProb: 0.05,
      includeComboOdds: true,
      includeWideInAllocation: true,
      includeTrioInAllocation: true,
      includeQuinellaInAllocation: true,
      includeExactaInAllocation: true,
      includeTrifectaInAllocation: true,
      includeBracketQuinellaInAllocation: true,
    };
    const input = {
      rows: EVEN_ROWS,
      raceId: "202603020211",
      odds: {
        oddsStatus: "result" as const,
        win: {},
        place: {},
        wideCombo: MIXED_RACE.wideCombo,
        trioCombo: MIXED_RACE.trioCombo,
      } as never,
      allocationSettings,
    };
    const analysis = buildAllocationForRows({ ...input, recordMissed: true });
    const recompute = buildAllocationForRows(input);
    expect(analysis.allocation.meta.belowFloorCount).toBe(56);
    expect(analysis.allocation.meta.missed!.length).toBeGreaterThan(0);
    expect(recompute.allocation.meta.belowFloorCount).toBe(56);
    expect(recompute.allocation.meta.missed).toBeNull();
    // 賭け金が付く買い目は、記録の有無に関わらず同じ
    expect(recompute.allocation.bets).toEqual(analysis.allocation.bets);
    expect(buildAllocationBetComboKey("place", [1])).toBe("01");
  });
});

describe("複勝の的中確率は adjustedProb そのもので判定する(浮動小数点の割り戻しで境界がずれない。Issue #470)", () => {
  // adjustedProb=0.05・複勝オッズ20.6: ev=adjustedProb×odds を odds で割り戻すと 0.05 を僅かに割る(0.049999999999999996)。
  const FLOOR = 0.05;
  const lowRows = [
    row(1, 0.05, 20.6), // ちょうど下限。EVプラス(1.03)
    row(2, 0.03, 60), // 下限未満。EVプラス(1.8)
    ...[3, 4, 5, 6, 7, 8].map((n) => row(n, 2.92 / 6, 1.1)), // EVマイナス(候補外)
  ];
  // 組合せの候補が1件はある状態にして、混在経路(route=mixed)へ入れる(ワイド 3-4 だけ高オッズ)
  const race: MixedCandidateBuildInput = { oddsStatus: "result", rows: lowRows, wideCombo: { [buildComboOddsKey([3, 4])]: 100 } };
  const withFloor = settings({ minHitProb: FLOOR, recordMissed: true });

  it("前提: 割り戻した値は下限を割る(この境界で ev/odds へのフォールバックなら外れてしまう)", () => {
    expect((0.05 * 20.6) / 20.6).toBeLessThan(FLOOR);
    expect(lowRows[0]!.ev).toBeGreaterThan(1);
  });

  it("混在経路でも、adjustedProb がちょうど下限の複勝は残る(belowFloor にも入らない)。下限未満の 2 番は外れる", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(race, withFloor);
    expect(outcome.outcome.route).toBe("mixed"); // 前提
    const r = mixedResult(outcome);
    const placeUmabans = r.allocations.filter((a) => a.betType === "place").map((a) => a.umabans[0]);
    expect(placeUmabans).toContain(1);
    expect(placeUmabans).not.toContain(2);
    expect(r.belowFloor.filter((b) => b.betType === "place").map((b) => b.umabans[0])).toEqual([2]);
  });

  it("複勝のみ経路と同じ結論になる(同じ入力で、残る・外れる馬が一致する)", () => {
    const placeOnly = buildMixedRaceAllocationWithOutcome({ ...race, wideCombo: undefined }, settings({ minHitProb: FLOOR, includeComboOdds: false }));
    if (placeOnly.view.kind !== "computed") throw new Error("computed でない");
    expect(placeOnly.view.result.allocations.find((a) => a.umaban === 1)!.excludedReason).toBeNull();
    expect(placeOnly.view.result.allocations.find((a) => a.umaban === 2)!.excludedReason).not.toBeNull();
  });

  it("belowFloor と missed の hitProb は adjustedProb と toBe で一致する(割り戻した値ではない)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(race, withFloor);
    const r = mixedResult(outcome);
    const below = r.belowFloor.find((b) => b.betType === "place")!;
    expect(below.hitProb).toBe(0.03);
    const missed = outcome.belowFloor!.missed!.filter((m) => m.betType === "place");
    expect(missed.length).toBe(1); // 前提: 2番は下限を外せば賭け金が付く
    expect(missed[0]!.comboKey).toBe("02");
    expect(missed[0]!.hitProb).toBe(0.03);
  });
});

describe("複勝のみ経路: 外さなくても賭け金が付かない候補は missed に入らない(wouldStake > 0 の絞り込み。Issue #470)", () => {
  // 2番(0.03・60倍・EV1.8)は賭け金が付く。3番(0.02・52倍・EV1.04)は妙味が薄く、下限を外しても賭け金は0円。
  const probs = [0.55, 0.03, 0.02, 0.6, 0.5, 0.5, 0.4, 0.4];
  const odds = [2.5, 60, 52, 1.2, 1.3, 1.1, 1.4, 1.2];
  const race: MixedCandidateBuildInput = { oddsStatus: "result", rows: NUMS.map((n, i) => row(n, probs[i]!, odds[i]!)) };
  const base = settings({ includeComboOdds: false, bankroll: 30_000, perRaceCap: 20_000 });

  it("前提: 下限なしで、2番には賭け金が付き、3番は賭け金0(EVプラスで候補にはなる)", () => {
    const o = buildMixedRaceAllocationWithOutcome(race, base);
    if (o.view.kind !== "computed") throw new Error("computed でない");
    const byU = new Map(o.view.result.allocations.map((a) => [a.umaban, a]));
    expect(byU.get(2)!.stake).toBeGreaterThan(0);
    expect(byU.get(3)!.excludedReason).toBeNull();
    expect(byU.get(3)!.stake).toBe(0);
  });

  it("下限0.05: 外れた件数は2件(2番・3番)だが、missed は賭け金が付く2番だけ", () => {
    const o = buildMixedRaceAllocationWithOutcome(race, { ...base, minHitProb: 0.05, recordMissed: true });
    expect(o.belowFloor!.count).toBe(2);
    expect(o.belowFloor!.missed!.map((m) => m.comboKey)).toEqual(["02"]);
    expect(o.belowFloor!.missed![0]!.wouldStake).toBeGreaterThan(0);
  });
});

describe("本番の候補構築は、全ての候補に hitProb を運ばせる(省略に頼るのは手組みの候補だけ。Issue #470)", () => {
  it("複勝・単勝・ワイド・三連複の全候補が hitProb を持ち、複勝は adjustedProb と一致する", () => {
    const { candidates } = buildMixedCandidates(MIXED_RACE, { evConfig: { threshold: 1.0 } });
    expect(new Set(candidates.map((c) => c.betType))).toEqual(new Set(["place", "win", "wide", "trio"])); // 前提: 4券種とも候補が出ている
    for (const c of candidates) {
      expect(c.hitProb, `${c.betType}:${c.umabans.join(",")}`).toBeDefined();
    }
    for (const c of candidates.filter((x) => x.betType === "place")) {
      expect(c.hitProb).toBe(0.375);
    }
  });
});
