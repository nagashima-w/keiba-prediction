import { describe, expect, it } from "vitest";
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { buildDayStats, buildRaceDigest, DIGEST_MAX_HORSES, REASON_MAX_CHARS } from "../src/daily-report-digest";

/** Issue #235: 日報の 1 レースのダイジェストと、1 日の統計(決定的に計算して LLM に渡す・画面にも出す)。 */

function horse(umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, ...over };
}

function view(raceId: string, horses: AnalysisViewHorse[], over: Partial<AnalysisView> = {}): AnalysisView {
  return {
    id: 10, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: "20261010", evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber: 11, raceName: "テストS", startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result" },
    horses, allocation: null, detail: "present", ...over,
  };
}

const result = (rows: Array<[number, number | null, number | null, number | null]>, combos: RaceResultData["combos"] = {}): RaceResultData => ({
  horses: rows.map(([umaban, finishPosition, winPayout, placePayout]) => ({ umaban, finishPosition, winPayout, placePayout })),
  combos,
});

describe("buildRaceDigest", () => {
  const raceId = "202605030811";

  it("印のある馬と EV プラスの馬だけを、印の順(◎〇▲△☆注)→ 馬番の順に載せる。印も EV プラスも無い馬は載せない", () => {
    const v = view(raceId, [horse(1, { mark: "▲" }), horse(2), horse(3, { mark: "◎" }), horse(4, { isPositive: true }), horse(5, { mark: "〇" })]);
    const d = buildRaceDigest(v, undefined);
    expect(d.horses.map((h) => h.umaban)).toEqual([3, 5, 1, 4]);
    expect(d.horses.map((h) => h.mark)).toEqual(["◎", "〇", "▲", null]);
  });

  it("印も EV プラスも無いレースは、補正後の確率が高い上位 3 頭を載せる(馬の欄が空にならない)", () => {
    const v = view(raceId, [horse(1, { adjustedProb: 0.1 }), horse(2, { adjustedProb: 0.4 }), horse(3, { adjustedProb: 0.3 }), horse(4, { adjustedProb: 0.2 })]);
    expect(buildRaceDigest(v, undefined).horses.map((h) => h.umaban)).toEqual([2, 3, 4]);
  });

  it(`載せる馬は最大 ${DIGEST_MAX_HORSES} 頭`, () => {
    const v = view(raceId, Array.from({ length: 14 }, (_, i) => horse(i + 1, { isPositive: true })));
    expect(buildRaceDigest(v, undefined).horses).toHaveLength(DIGEST_MAX_HORSES);
  });

  it("根拠は REASON_MAX_CHARS 字に切り、強調材料・懸念事項は各 2 項目・40 字までにする", () => {
    const long = "あ".repeat(REASON_MAX_CHARS + 50);
    const v = view(raceId, [horse(1, { mark: "◎", reason: long, highlights: ["い".repeat(60), "b", "c"], concerns: ["x", "y", "z"] })]);
    const h = buildRaceDigest(v, undefined).horses[0]!;
    expect(h.reason!.length).toBe(REASON_MAX_CHARS);
    expect(h.reason!.endsWith("…")).toBe(true);
    expect(h.highlights).toHaveLength(2);
    expect(h.highlights[0]!.length).toBe(40);
    expect(h.concerns).toEqual(["x", "y"]);
  });

  it("結果があれば、1〜3 着(馬番・馬名・着順)と各馬の着順を載せる。着順は馬番で突き合わせる", () => {
    const v = view(raceId, [horse(1, { mark: "◎" }), horse(7, { mark: "〇" }), horse(9, { name: null, isPositive: true })]);
    const d = buildRaceDigest(v, result([[1, 3, null, 120], [7, 1, 480, 150], [9, 2, null, 200], [4, 4, null, null]]));
    expect(d.hasResult).toBe(true);
    expect(d.top3).toEqual([
      { umaban: 7, name: "馬7", finishPosition: 1 },
      { umaban: 9, name: null, finishPosition: 2 },
      { umaban: 1, name: "馬1", finishPosition: 3 },
    ]);
    expect(Object.fromEntries(d.horses.map((h) => [h.umaban, h.finishPosition]))).toEqual({ 1: 3, 7: 1, 9: 2 });
  });

  it("結果が無ければ hasResult=false・top3 は空・着順は null、買い目は判定不能で賭け金・払戻は 0 に数えない", () => {
    const v = view(raceId, [horse(1, { mark: "◎" })], {
      allocation: { route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok", bets: [{ betType: "win", comboKey: "01", stake: 300, odds: 4.5, ev: 1.2 }] },
    });
    const d = buildRaceDigest(v, undefined);
    expect(d.hasResult).toBe(false);
    expect(d.top3).toEqual([]);
    expect(d.horses[0]!.finishPosition).toBeNull();
    expect(d.bets).toHaveLength(1);
    expect(d.bets[0]!.status).toBe("unjudged");
    expect(d.totalStake).toBe(0);
    expect(d.totalReturn).toBe(0);
    expect(d.unjudgedStake).toBe(300);
  });

  it("買い目の結果から、判定できた賭け金・払戻・的中数を集計する(判定不能の賭け金は別に持つ)", () => {
    const v = view(raceId, [horse(1, { mark: "◎" })], {
      allocation: { route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok",
        bets: [
          { betType: "win", comboKey: "07", stake: 300, odds: 4.8, ev: 1.2 },
          { betType: "place", comboKey: "01", stake: 200, odds: 1.5, ev: 1.1 },
          { betType: "trio", comboKey: "010709", stake: 100, odds: 30, ev: 1.3 },
        ] },
    });
    const d = buildRaceDigest(v, result([[7, 1, 480, 150], [9, 2, null, 200], [1, 3, null, 120]]));
    expect(d.totalStake).toBe(500); // 単勝 + 複勝(3 連複は未取込で判定不能)
    expect(d.totalReturn).toBe(300 * 4.8 + 200 * 1.2); // 単勝 480 円 × 3 + 複勝 120 円 × 2
    expect(d.hitCount).toBe(2);
    expect(d.judgedBetCount).toBe(2);
    expect(d.unjudgedStake).toBe(100);
  });

  it("配分が無い(null)ときは買い目 0 件・allocationNote に理由は出さない。スキップの配分は理由コードを allocationNote に残す", () => {
    expect(buildRaceDigest(view(raceId, [horse(1)]), undefined).allocationNote).toBeNull();
    const skipped = view(raceId, [horse(1)], {
      allocation: { route: "mixed", skipReasonCode: "no-ev", unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: false, includeWide: false, includeTrio: false, includeQuinella: null, includeExacta: null, includeTrifecta: null, includeBracketQuinella: null, oddsStatus: "ok", bets: [] },
    });
    const d = buildRaceDigest(skipped, undefined);
    expect(d.bets).toEqual([]);
    expect(d.allocationNote).toBe("買い目なし(見送り: no-ev)");
  });

  it("LLM が効いていない分析(モデル null)は llmUsed=false", () => {
    expect(buildRaceDigest(view(raceId, [horse(1)], { model: null }), undefined).llmUsed).toBe(false);
    expect(buildRaceDigest(view(raceId, [horse(1)]), undefined).llmUsed).toBe(true);
  });
});

describe("buildDayStats", () => {
  const raceId = (n: number): string => `2026050308${String(n).padStart(2, "0")}`;
  const bets = (rows: Array<[string, string, number]>) => rows.map(([betType, comboKey, stake]) => ({ betType, comboKey, stake, odds: 3, ev: 1.1 }));
  const alloc = (b: ReturnType<typeof bets>): NonNullable<AnalysisView["allocation"]> => ({ route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok", bets: b });

  function digests() {
    // R1: 結果あり。◎が 1 着(単勝 400 円が 200 円的中 = 800 円)、〇が 5 着。
    const r1 = buildRaceDigest(view(raceId(1), [horse(1, { mark: "◎" }), horse(2, { mark: "〇" })], { allocation: alloc(bets([["win", "01", 200], ["place", "02", 100]])) }), result([[1, 1, 400, 150], [3, 2, null, 200], [4, 3, null, 120], [2, 5, null, null]]));
    // R2: 結果なし。買い目あり(判定不能)。
    const r2 = buildRaceDigest(view(raceId(2), [horse(5, { mark: "◎" })], { allocation: alloc(bets([["win", "05", 500]])) }), undefined);
    // R3: 結果あり・買い目なし。◎が 4 着。
    const r3 = buildRaceDigest(view(raceId(3), [horse(6, { mark: "◎", name: "馬6" })], { model: null }), result([[7, 1, 300, 110], [8, 2, null, 130], [9, 3, null, 140], [6, 4, null, null]]));
    return [r1, r2, r3];
  }

  it("レース数・結果ありの数・買い目のあるレース数・LLM が効いたレース数を数える", () => {
    const s = buildDayStats(digests());
    expect(s.raceCount).toBe(3);
    expect(s.resultRaceCount).toBe(2);
    expect(s.noResultRaceCount).toBe(1);
    expect(s.betRaceCount).toBe(2);
    expect(s.llmUsedRaceCount).toBe(2);
  });

  it("賭け金・払戻・回収率は判定できた買い目だけ。判定不能の賭け金と点数は別に持つ", () => {
    const s = buildDayStats(digests());
    expect(s.totalStake).toBe(300); // R1 の単勝 200 + 複勝 100
    expect(s.totalReturn).toBe(800); // 単勝 400 × 2。複勝 02 は 5 着ではずれ
    expect(s.recoveryRate).toBeCloseTo(800 / 300, 10);
    expect(s.judgedBetCount).toBe(2);
    expect(s.hitBetCount).toBe(1);
    expect(s.unjudgedBetCount).toBe(1);
    expect(s.unjudgedStake).toBe(500);
  });

  it("賭け金が 0 なら回収率は null(0 除算しない)", () => {
    const s = buildDayStats([digests()[2]!]);
    expect(s.totalStake).toBe(0);
    expect(s.recoveryRate).toBeNull();
  });

  it("券種別に、点数・的中数・賭け金・払戻を集計する(判定できた買い目だけ)", () => {
    const s = buildDayStats(digests());
    expect(s.byBetType).toStrictEqual({ win: { betCount: 1, hitCount: 1, stake: 200, payout: 800 }, place: { betCount: 1, hitCount: 0, stake: 100, payout: 0 } });
  });

  it("印別に、結果のあるレースの頭数・1 着・3 着内を数える(結果の無いレースは数えない)", () => {
    const s = buildDayStats(digests());
    expect(s.byMark).toEqual([
      { mark: "◎", count: 2, win: 1, top3: 1 }, // R1 の ◎ は 1 着、R3 の ◎ は 4 着。R2 は結果なしで数えない
      { mark: "〇", count: 1, win: 0, top3: 0 }, // R1 の 〇 は 5 着
    ]);
  });

  it("Issue #246 D1・D2・M3: 印別の 1 着・3 着内は、2・3 着・4 着以下の馬に印が付いたレースで数える(1 着だけの入力では win と top3 が同値で、判定の取り違えが見えない)", () => {
    // R1: ◎=1 着, 〇=2 着, ▲=3 着, △=4 着, ☆=5 着。R2: ◎=2 着, 〇=3 着, ▲=1 着。R3: 結果なし(印は数えない)
    const r1 = buildRaceDigest(
      view(raceId(1), [horse(1, { mark: "◎" }), horse(2, { mark: "〇" }), horse(3, { mark: "▲" }), horse(4, { mark: "△" }), horse(5, { mark: "☆" })]),
      result([[1, 1, 400, 150], [2, 2, null, 200], [3, 3, null, 120], [4, 4, null, null], [5, 5, null, null]]),
    );
    const r2 = buildRaceDigest(view(raceId(2), [horse(1, { mark: "◎" }), horse(2, { mark: "〇" }), horse(3, { mark: "▲" })]), result([[3, 1, 500, 160], [1, 2, null, 130], [2, 3, null, 140], [4, 4, null, null]]));
    const r3 = buildRaceDigest(view(raceId(3), [horse(1, { mark: "◎" })]), undefined);
    const byMark = buildDayStats([r1, r2, r3]).byMark;
    // 前提(空振り防止): 2 着・3 着の馬に印が付き、着順が実際に digest に載っている
    expect(r1.horses.map((h) => [h.mark, h.finishPosition])).toEqual([["◎", 1], ["〇", 2], ["▲", 3], ["△", 4], ["☆", 5]]);
    expect(r2.horses.map((h) => [h.mark, h.finishPosition])).toEqual([["◎", 2], ["〇", 3], ["▲", 1]]);
    expect(byMark).toEqual([
      { mark: "◎", count: 2, win: 1, top3: 2 }, // 1 着・2 着
      { mark: "〇", count: 2, win: 0, top3: 2 }, // 2 着・3 着: 1 着は 0 だが 3 着内は 2
      { mark: "▲", count: 2, win: 1, top3: 2 }, // 3 着・1 着
      { mark: "△", count: 1, win: 0, top3: 0 }, // 4 着: 3 着内に入らない(境界の外)
      { mark: "☆", count: 1, win: 0, top3: 0 },
    ]);
    // win と top3 が同値でない印がある(取り違えると変わる)
    expect(byMark.some((m) => m.win !== m.top3)).toBe(true);
    expect(byMark.filter((m) => m.top3 > m.win).length).toBeGreaterThanOrEqual(2);
  });

  it("レースが 0 件でも落ちない", () => {
    const s = buildDayStats([]);
    expect(s).toMatchObject({ raceCount: 0, resultRaceCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null, byMark: [], byBetType: {} });
  });
});
