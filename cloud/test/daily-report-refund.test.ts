import { describe, expect, it } from "vitest";
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { buildDayStats, buildRaceDigest, mergeDayStats } from "../src/daily-report-digest";
import { buildWhatIfStats, evaluateTemplates, mergeWhatIfStats, pickNearMisses } from "../src/daily-report-whatif";

/**
 * Issue #278: 日報の集計(ダイジェスト・1 日の統計・券種別・期待値・「もしも」)に、返還(取消・除外の馬への買い目)を載せる。
 * 規則: 返還は「判定できた」側(点数・賭け金・払戻に含む。払戻 = 賭け金)で、的中数には入れない。見込みの的中数(確率のある買い目)には入れない。
 */

function horse(umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}

const alloc = (rows: Array<[string, string, number, number, number]>): NonNullable<AnalysisView["allocation"]> => ({
  route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1,
  includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok",
  bets: rows.map(([betType, comboKey, stake, odds, ev]) => ({ betType, comboKey, stake, odds, ev })),
});

function view(raceId: string, horses: AnalysisViewHorse[], bets: Array<[string, string, number, number, number]> = []): AnalysisView {
  return {
    id: 10, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: "20261010", evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber: 11, raceName: "テストS", grade: null, startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result", placeBasis: "top3" },
    horses, allocation: bets.length === 0 ? null : alloc(bets), detail: "present",
  };
}

/** 馬の行: [馬番, 着順, 単勝払戻, 複勝払戻, scratched]。 */
const result = (rows: ReadonlyArray<[number, number | null, number | null, number | null, boolean?]>, combos: RaceResultData["combos"] = {}): RaceResultData => ({
  horses: rows.map(([umaban, finishPosition, winPayout, placePayout, scratched]) => ({ umaban, finishPosition, winPayout, placePayout, ...(scratched === undefined ? {} : { scratched }) })),
  combos,
});

// 5 番が取消。1 着 = 1 番(単勝 450 円/100 円)。
const RES = result([[1, 1, 450, 150, false], [2, 2, null, 210, false], [3, 3, null, 320, false], [4, 4, null, null, false], [5, null, null, null, true]], {
  wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }] },
});

describe("Issue #278: ダイジェスト・1 日の統計の返還", () => {
  // 買い目: 単勝 01 的中(300円 → 1,350円)・単勝 02 はずれ(200円)・単勝 05 返還(500円)・ワイド 0105 返還(100円)・ワイド 0203 はずれ(100円)
  const BETS: Array<[string, string, number, number, number]> = [
    ["win", "01", 300, 4.5, 1.35],
    ["win", "02", 200, 6, 1.2],
    ["win", "05", 500, 10, 1.5],
    ["wide", "0105", 100, 8, 1.6],
    ["wide", "0203", 100, 5, 1.1],
  ];
  const d = buildRaceDigest(view("202605030811", [horse(1, { mark: "◎" })], BETS), RES);

  it("前提(空振り防止): 的中・はずれ・返還がそれぞれ含まれる入力である", () => {
    expect(d.bets.map((b) => b.status)).toEqual(["hit", "miss", "refund", "refund", "miss"]);
  });

  it("返還は判定できた側: 点数・賭け金・払戻に含め(払戻 = 賭け金)、的中数には入れない。内訳の返還の点数・賭け金を持つ", () => {
    expect(d.judgedBetCount).toBe(5);
    expect(d.totalStake).toBe(300 + 200 + 500 + 100 + 100);
    expect(d.totalReturn).toBe(1350 + 500 + 100);
    expect(d.hitCount).toBe(1);
    expect(d.refundedBetCount).toBe(2);
    expect(d.refundedStake).toBe(600);
    expect(d.unjudgedBetCount).toBe(0);
  });

  it("1 日の統計: 判定できた点数・賭け金・払戻・回収率に返還を含め、内訳 refundedBetCount・refundedStake を持つ。的中数は返還を含まない", () => {
    const s = buildDayStats([d]);
    expect(s.judgedBetCount).toBe(5);
    expect(s.totalStake).toBe(1200);
    expect(s.totalReturn).toBe(1950);
    expect(s.recoveryRate).toBeCloseTo(1950 / 1200, 10);
    expect(s.hitBetCount).toBe(1);
    expect(s.refundedBetCount).toBe(2);
    expect(s.refundedStake).toBe(600);
  });

  it("券種別: 点数・賭け金・払戻に返還を含み、refundCount を持つ(単勝 1・ワイド 1)。券種別の返還の合計は全体と一致する", () => {
    const s = buildDayStats([d]);
    expect(s.byBetType["win"]).toMatchObject({ betCount: 3, hitCount: 1, stake: 1000, payout: 1850, refundCount: 1 });
    expect(s.byBetType["wide"]).toMatchObject({ betCount: 2, hitCount: 0, stake: 200, payout: 100, refundCount: 1 });
    expect(Object.values(s.byBetType).reduce((n, t) => n + t.refundCount, 0)).toBe(s.refundedBetCount);
  });

  it("見込みの的中数: 返還は確率のある買い目でも見込みに入れない(出走して的中する確率の対象外)。expectedBetCount は 5 − 返還 2 = 3", () => {
    const s = buildDayStats([d]);
    expect(s.expectedBetCount).toBe(3);
    // 単勝 01: 1.35/4.5 = 0.3、単勝 02: 1.2/6 = 0.2、ワイド 0203: 1.1/5 = 0.22(返還の 0105・05 は含めない)
    expect(s.expectedHits).toBeCloseTo(0.3 + 0.2 + 0.22, 10);
    expect(s.expectedBaseHits).toBe(1);
    expect(s.byBetType["win"]!.expectedBetCount).toBe(2);
    expect(s.byBetType["wide"]!.expectedBetCount).toBe(1);
  });

  it("最大払戻の 1 点は的中だけから選ぶ(返還の払戻 = 賭け金 500 円は選ばない)", () => {
    const s = buildDayStats([d]);
    expect(s.maxPayout).toBe(1350);
    expect(s.maxPayoutStake).toBe(300);
    // 返還だけの日は的中が無いので最大払戻 0
    const only = buildDayStats([buildRaceDigest(view("202605030812", [horse(5)], [["win", "05", 500, 10, 1.5]]), RES)]);
    expect(only.refundedBetCount).toBe(1);
    expect(only.maxPayout).toBe(0);
  });

  it("返還が無い日は refundedBetCount・refundedStake・券種別の refundCount が 0(NaN・undefined にしない)", () => {
    const s = buildDayStats([buildRaceDigest(view("202605030813", [horse(1)], [["win", "01", 300, 4.5, 1.35]]), RES)]);
    expect(s.refundedBetCount).toBe(0);
    expect(s.refundedStake).toBe(0);
    expect(s.byBetType["win"]!.refundCount).toBe(0);
  });

  it("結果が無いレース(取消かどうか分からない)の買い目は判定不能のまま、返還に数えない", () => {
    const noResult = buildRaceDigest(view("202605030814", [horse(1)], [["win", "05", 500, 10, 1.5]]), undefined);
    expect(noResult.bets[0]!.status).toBe("unjudged");
    expect(buildDayStats([noResult]).refundedBetCount).toBe(0);
  });

  it("mergeDayStats: 返還の点数・賭け金・券種別の refundCount を足す。内訳を持たない旧形の統計(デプロイをまたいだ job)とも落ちない(欠けた分は 0)", () => {
    const a = buildDayStats([d]);
    const merged = mergeDayStats(a, a);
    expect(merged.refundedBetCount).toBe(4);
    expect(merged.refundedStake).toBe(1200);
    expect(merged.byBetType["win"]!.refundCount).toBe(2);
    const { refundedBetCount: _c, refundedStake: _s, ...legacyTop } = a;
    const legacyByType = Object.fromEntries(Object.entries(a.byBetType).map(([k, v]) => { const { refundCount: _r, ...rest } = v; return [k, rest]; }));
    const legacy = { ...legacyTop, byBetType: legacyByType } as unknown as typeof a;
    const m2 = mergeDayStats(a, legacy);
    expect(m2.refundedBetCount).toBe(2);
    expect(m2.refundedStake).toBe(600);
    expect(m2.byBetType["win"]!.refundCount).toBe(1);
    expect(Number.isNaN(m2.refundedBetCount)).toBe(false);
  });
});

describe("Issue #278: 「もしも」の型の返還", () => {
  const marks = [{ mark: "◎", umaban: 5 }, { mark: "〇", umaban: 1 }, { mark: "▲", umaban: 2 }];

  it("◎が取消・除外のとき、◎を含む型(単勝・複勝・ワイド・馬連・3 連複)はすべて返還(払戻 100 円)。取込印が無い券種でも判定不能にしない", () => {
    const out = evaluateTemplates(marks, [], RES);
    expect(out.map((t) => [t.id, t.status, t.payout])).toEqual([["win", "refund", 100], ["place", "refund", 100], ["wide", "refund", 100], ["quinella", "refund", 100], ["trio", "refund", 100]]);
  });

  it("〇・▲が取消でも、その印を含む型だけが返還になる(◎だけの単勝・複勝は通常の判定)", () => {
    const out = evaluateTemplates([{ mark: "◎", umaban: 1 }, { mark: "〇", umaban: 5 }, { mark: "▲", umaban: 2 }], [], RES);
    expect(out.map((t) => [t.id, t.status])).toEqual([["win", "hit"], ["place", "hit"], ["wide", "refund"], ["quinella", "refund"], ["trio", "refund"]]);
  });

  it("集計: 返還は点数・賭け金・払戻(各 100 円)に含め、内訳 refundCount に数える。的中数には入れない", () => {
    const w = buildWhatIfStats([
      { templates: evaluateTemplates(marks, [], RES) },
      { templates: evaluateTemplates([{ mark: "◎", umaban: 1 }, { mark: "〇", umaban: 2 }, { mark: "▲", umaban: 3 }], [], RES) },
    ])!;
    expect(w["win"]).toEqual({ betCount: 2, hitCount: 1, stake: 200, payout: 550, unjudgedCount: 0, inapplicableCount: 0, refundCount: 1 });
    // 2 レース目は ◎1〇2 のワイド(0102。払戻 800 円)が的中。1 レース目(◎が取消)は返還
    expect(w["wide"]).toEqual({ betCount: 2, hitCount: 1, stake: 200, payout: 900, unjudgedCount: 0, inapplicableCount: 0, refundCount: 1 });
    // 2 レース目の馬連・3 連複は取込印が無く判定不能、1 レース目は返還(判定不能にしない)
    expect(w["trio"]).toEqual({ betCount: 1, hitCount: 0, stake: 100, payout: 100, unjudgedCount: 1, inapplicableCount: 0, refundCount: 1 });
  });

  it("mergeWhatIfStats: refundCount を足し、欠けた(旧形の)統計は 0 として扱う", () => {
    const a = buildWhatIfStats([{ templates: evaluateTemplates(marks, [], RES) }])!;
    const m = mergeWhatIfStats(a, a)!;
    expect(m["win"]!.refundCount).toBe(2);
    const legacy = Object.fromEntries(Object.entries(a).map(([k, v]) => { const { refundCount: _r, ...rest } = v; return [k, rest]; })) as unknown as typeof a;
    expect(mergeWhatIfStats(a, legacy)!["win"]!.refundCount).toBe(1);
  });

  it("惜しかったレース: 返還は的中ではないので選ばない", () => {
    const near = pickNearMisses([{ raceId: "R1", templates: evaluateTemplates(marks, [], RES) }])!;
    expect(near.total).toBe(0);
  });
});
