import { describe, expect, it } from "vitest";
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { buildDayStats, buildRaceDigest, buildStatsFromRaces, DIGEST_MAX_HORSES, excludingTopRecoveryRate, mergeDayStats, REASON_MAX_CHARS, type DayStats } from "../src/daily-report-digest";

/** Issue #235: 日報の 1 レースのダイジェストと、1 日の統計(決定的に計算して LLM に渡す・画面にも出す)。 */

function horse(umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}

function view(raceId: string, horses: AnalysisViewHorse[], over: Partial<AnalysisView> = {}): AnalysisView {
  return {
    id: 10, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: "20261010", evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber: 11, raceName: "テストS", grade: null, startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result", placeBasis: "top3" },
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
    // Issue #264: 券種別に「見込みの的中数」(expectedBetCount・expectedHits)も持つ。この入力の買い目は odds 3・ev 1.1 なので、的中確率は 1.1 / 3。
    expect(s.byBetType).toStrictEqual({
      win: { betCount: 1, hitCount: 1, stake: 200, payout: 800, refundCount: 0, expectedBetCount: 1, expectedHits: 1.1 / 3, expectedBaseHits: 1 },
      place: { betCount: 1, hitCount: 0, stake: 100, payout: 0, refundCount: 0, expectedBetCount: 1, expectedHits: 1.1 / 3, expectedBaseHits: 0 },
    });
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

  // ---- Issue #264: 見込みの的中数・最大払戻の 1 点 ----

  /** 買い目ごとに odds・ev を指定できる 1 レース(結果あり。単勝 01 が 1 着で 400 円、複勝は 01 が 150 円)。 */
  function raceWith(n: number, rows: Array<[string, string, number, number | null, number | null]>, hasResult = true) {
    const v = view(raceId(n), [horse(1, { mark: "◎" })], { allocation: alloc(rows.map(([betType, comboKey, stake, odds, ev]) => ({ betType, comboKey, stake, odds: odds as number, ev: ev as number }))) });
    return buildRaceDigest(v, hasResult ? result([[1, 1, 400, 150], [2, 2, null, 200], [3, 3, null, 120]]) : undefined);
  }

  it("Issue #264 見込みの的中数: 判定できた買い目それぞれの的中確率(ev / odds)を足す。判定不能(結果なし)の買い目は見込みに入れない(分母を実際の判定とそろえる)", () => {
    const s = buildDayStats(digests());
    // 判定できた 2 点(R1 の単勝・複勝)だけ。R2 の判定不能の 1 点(odds 3・ev 1.1 で確率は導ける)は入れない
    expect(s.judgedBetCount).toBe(2);
    expect(s.unjudgedBetCount).toBe(1);
    expect(s.expectedBetCount).toBe(2);
    expect(s.expectedBaseHits).toBe(1); // 実際の的中(単勝 1 点。複勝ははずれ)。見込みと同じ 2 点の中で数える
    expect(s.expectedHits).toBeCloseTo((1.1 / 3) * 2, 12);
    expect(s.expectedHits).not.toBeCloseTo((1.1 / 3) * 3, 3); // 判定不能の 1 点を足していない
  });

  it("Issue #264 見込み: 確率を導けない買い目(ev か odds が無い・確率が 1 超)は、判定に数えても見込みには入れない(expectedBetCount が judgedBetCount より小さくなる)", () => {
    const d = raceWith(1, [["win", "01", 100, 4, 1.2], ["place", "01", 100, null, 1.1], ["place", "02", 100, 2, null], ["win", "02", 100, 2, 2.6]]);
    const s = buildDayStats([d]);
    expect(s.judgedBetCount).toBe(4); // 前提: 4 点とも判定できている(単勝・複勝は払戻の有無で判定する)
    expect(s.expectedBetCount).toBe(1); // 確率を導けるのは 1 点目だけ(odds が無い・ev が無い・確率が 1 超の 3 点は入れない)
    expect(s.expectedHits).toBeCloseTo(1.2 / 4, 12);
    // 実際の的中は 3 点(単勝 01・複勝 01・複勝 02)だが、見込みと比べる実際の数は、確率を導けた 1 点目(単勝 01)の的中だけ(分母をそろえる)
    expect(s.hitBetCount).toBe(3);
    expect(s.expectedBaseHits).toBe(1);
    expect(s.byBetType["place"]!.betCount).toBe(2);
    expect(s.byBetType["place"]!.expectedBaseHits).toBe(0);
    expect(s.byBetType["place"]!.expectedBetCount).toBe(0);
    expect(s.byBetType["place"]!.expectedHits).toBe(0);
  });

  it("Issue #264 券種別の見込み: 券種ごとに、見込みの点数と的中数を持つ。券種別の見込みの合計は全体の見込みに一致する", () => {
    const d1 = raceWith(1, [["win", "01", 100, 4, 1.2], ["win", "02", 100, 10, 0.5], ["place", "01", 100, 2, 1.0]]);
    const d2 = raceWith(2, [["win", "03", 100, 5, 1.5], ["place", "02", 100, 3, 0.9]]);
    const s = buildDayStats([d1, d2]);
    // 前提: 券種別に 2 種類以上、単勝は 3 点で確率が互いに違う
    expect(Object.keys(s.byBetType).sort()).toEqual(["place", "win"]);
    expect(s.byBetType["win"]!.betCount).toBe(3);
    expect(s.byBetType["win"]!.expectedBetCount).toBe(3);
    expect(s.byBetType["win"]!.expectedHits).toBeCloseTo(1.2 / 4 + 0.5 / 10 + 1.5 / 5, 12);
    expect(s.byBetType["place"]!.expectedBetCount).toBe(2);
    expect(s.byBetType["place"]!.expectedHits).toBeCloseTo(1.0 / 2 + 0.9 / 3, 12);
    const sumHits = Object.values(s.byBetType).reduce((a, t) => a + t.expectedHits, 0);
    const sumCount = Object.values(s.byBetType).reduce((a, t) => a + t.expectedBetCount, 0);
    expect(sumHits).toBeCloseTo(s.expectedHits, 12);
    expect(sumCount).toBe(s.expectedBetCount);
  });

  it("Issue #264 見込み: 買い目が無い日は 0(NaN・null にしない)", () => {
    const s = buildDayStats([digests()[2]!]);
    expect(s.judgedBetCount).toBe(0);
    expect(s.expectedBetCount).toBe(0);
    expect(s.expectedHits).toBe(0);
    expect(s.expectedBaseHits).toBe(0);
    expect(s.maxPayout).toBe(0);
    expect(s.maxPayoutStake).toBe(0);
  });

  it("Issue #264 最大払戻の 1 点: 判定できて的中した買い目のうち払戻が最大のものの払戻と賭け金を持つ。はずれ・判定不能・払戻の小さい的中は選ばない", () => {
    // 単勝 01(400 円 × 賭け金 100 → 払戻 400)・単勝 01 の賭け金違いは同じキーにならないので別レースに置く
    const small = raceWith(1, [["win", "01", 100, 4, 1.2]]); // 払戻 400(賭け金 100)
    const big = raceWith(2, [["win", "01", 300, 4, 1.2], ["place", "02", 500, 2, 1.0]]); // 単勝は 400 × 3 = 1200(賭け金 300)。複勝 02 は 200 × 5 = 1000
    const unjudged = raceWith(3, [["win", "01", 9000, 4, 1.2]], false); // 判定不能。払戻 0 扱いで選ばれない
    const s = buildDayStats([small, big, unjudged]);
    expect(s.maxPayout).toBe(1200);
    expect(s.maxPayoutStake).toBe(300);
    expect(buildDayStats([big, small, unjudged])).toMatchObject({ maxPayout: 1200, maxPayoutStake: 300 }); // 並びに依らない
  });

  it("Issue #264 最大払戻の 1 点を除いた回収率: (払戻 − 最大払戻) ÷ (賭け金 − その買い目の賭け金)。的中が無い・残りの賭け金が 0 のときは null", () => {
    const big = raceWith(1, [["win", "01", 300, 4, 1.2]]); // 払戻 1200
    const miss = raceWith(2, [["win", "02", 200, 4, 1.2]]); // はずれ
    const s = buildDayStats([big, miss]);
    expect(s.totalStake).toBe(500);
    expect(s.totalReturn).toBe(1200);
    expect(s.recoveryRate).toBeCloseTo(1200 / 500, 12); // 240%
    expect(excludingTopRecoveryRate(s)).toBe(0); // 最大の 1 点を除くと 0 ÷ 200 = 0%(回収率が 1 点に依存している)
    expect(buildDayStats([miss]).maxPayout).toBe(0);
    expect(excludingTopRecoveryRate(buildDayStats([miss]))).toBeNull(); // 的中が無い
    expect(excludingTopRecoveryRate(buildDayStats([big]))).toBeNull(); // 除くと賭け金が 0
    expect(excludingTopRecoveryRate(buildDayStats([]))).toBeNull();
    // 2 点的中: 小さい方が残る
    const small = raceWith(3, [["win", "01", 100, 4, 1.2]]); // 払戻 400
    expect(excludingTopRecoveryRate(buildDayStats([big, small, miss]))).toBeCloseTo(400 / 300, 12);
  });

  describe("mergeDayStats(Issue #264: 直前 27 日 + その日 = 28 日累計を作る足し算。月報〈#265〉でも使う)", () => {
    const closeStats = (a: DayStats, b: DayStats): void => {
      const { expectedHits: ah, byBetType: abt, ...restA } = a;
      const { expectedHits: bh, byBetType: bbt, ...restB } = b;
      expect(restA).toEqual(restB);
      expect(ah).toBeCloseTo(bh, 12);
      expect(Object.keys(abt).sort()).toEqual(Object.keys(bbt).sort());
      for (const k of Object.keys(abt)) {
        const { expectedHits: x, ...ra } = abt[k]!;
        const { expectedHits: y, ...rb } = bbt[k]!;
        expect(ra).toEqual(rb);
        expect(x).toBeCloseTo(y, 12);
      }
    };

    it("2 つの日の統計を足すと、その 2 日のレースをまとめて数えた統計に一致する(件数・賭け金・払戻・券種別・印別・最大払戻・見込み)", () => {
      const day1 = [raceWith(1, [["win", "01", 300, 4, 1.2], ["place", "01", 100, 2, 1.0]]), raceWith(2, [["win", "02", 200, 5, 1.1]], false)];
      const day2 = [raceWith(3, [["win", "01", 100, 4, 1.2], ["wide", "0102", 100, 6, 1.1]]), digests()[2]!];
      const merged = mergeDayStats(buildDayStats(day1), buildDayStats(day2));
      const whole = buildDayStats([...day1, ...day2]);
      // 前提: 両方に中身がある(片方が空だと足し算を確かめられない)
      expect(buildDayStats(day1).judgedBetCount).toBeGreaterThan(0);
      expect(buildDayStats(day2).judgedBetCount).toBeGreaterThan(0);
      expect(buildDayStats(day1).byMark.length).toBeGreaterThan(0);
      closeStats(merged, whole);
      // 回収率は足した賭け金・払戻から作り直す(率の平均ではない)
      expect(merged.recoveryRate).toBeCloseTo(merged.totalReturn / merged.totalStake, 12);
    });

    it("最大払戻は大きい方を採り、賭け金もその買い目のものを持つ。払戻が同じなら賭け金の大きい方(足す順に依らない)", () => {
      const a = buildDayStats([raceWith(1, [["win", "01", 100, 4, 1.2]])]); // 400・賭け金 100
      const b = buildDayStats([raceWith(2, [["win", "01", 300, 4, 1.2]])]); // 1200・賭け金 300
      expect(mergeDayStats(a, b)).toMatchObject({ maxPayout: 1200, maxPayoutStake: 300 });
      expect(mergeDayStats(b, a)).toMatchObject({ maxPayout: 1200, maxPayoutStake: 300 });
      const tieA: DayStats = { ...a, maxPayout: 500, maxPayoutStake: 100 };
      const tieB: DayStats = { ...a, maxPayout: 500, maxPayoutStake: 250 };
      expect(mergeDayStats(tieA, tieB).maxPayoutStake).toBe(250);
      expect(mergeDayStats(tieB, tieA).maxPayoutStake).toBe(250);
    });

    it("空の統計との足し算は、相手を変えない(単位元)。賭け金が 0 の合計の回収率は null", () => {
      const a = buildDayStats(digests());
      closeStats(mergeDayStats(a, buildDayStats([])), a);
      closeStats(mergeDayStats(buildDayStats([]), a), a);
      expect(mergeDayStats(buildDayStats([]), buildDayStats([])).recoveryRate).toBeNull();
    });

    it("印別は印の順(◎〇▲△☆注)に並べ直す。どちらかにしか無い券種・印も落とさない", () => {
      const r1 = buildRaceDigest(view(raceId(1), [horse(1, { mark: "☆" })], { allocation: alloc(bets([["win", "01", 100]])) }), result([[1, 1, 400, 150]]));
      const r2 = buildRaceDigest(view(raceId(2), [horse(1, { mark: "◎" })], { allocation: alloc(bets([["place", "01", 100]])) }), result([[1, 2, null, 150]]));
      const merged = mergeDayStats(buildDayStats([r1]), buildDayStats([r2]));
      expect(merged.byMark.map((m) => m.mark)).toEqual(["◎", "☆"]);
      expect(Object.keys(merged.byBetType).sort()).toEqual(["place", "win"]);
    });
  });

  it("buildStatsFromRaces は buildDayStats と同じ集計の本体(D1 の行から作る期間の統計と、日報の 1 日の統計が同じ関数を通る)", () => {
    const ds = digests();
    const viaRaces = buildStatsFromRaces(ds.map((d) => ({ hasResult: d.hasResult, llmUsed: d.llmUsed, bets: d.bets, templates: d.templates, marks: d.horses.flatMap((h) => (h.mark === null ? [] : [{ mark: h.mark, finishPosition: h.finishPosition }])) })));
    expect(viaRaces).toStrictEqual(buildDayStats(ds));
  });

  it("レースが 0 件でも落ちない", () => {
    const s = buildDayStats([]);
    expect(s).toMatchObject({ raceCount: 0, resultRaceCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null, byMark: [], byBetType: {} });
  });
});

describe("Issue #272: ダイジェストの定型の結果(templates)と統計の whatIf", () => {
  const alloc = (b: Array<[string, string, number]>): NonNullable<AnalysisView["allocation"]> => ({
    route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1,
    includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok",
    bets: b.map(([betType, comboKey, stake]) => ({ betType, comboKey, stake, odds: 5, ev: 1.1 })),
  });
  const marked = (): AnalysisViewHorse[] => [horse(1, { mark: "◎" }), horse(2, { mark: "〇" }), horse(3, { mark: "▲" }), horse(4, { mark: "△" }), horse(5)];
  const FULL = result([[1, 1, 450, 150], [2, 2, null, 210], [3, 3, null, 320], [4, 4, null, null]], {
    wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }] },
    quinella: { imported: true, payouts: [{ comboKey: "0102", payout: 1200 }] },
    trio: { imported: true, payouts: [{ comboKey: "010203", payout: 5000 }] },
  });

  it("印・結果・実際の買い目から 5 型の結果を作る。実際に買っていた組合せ(ワイド 1-2)は bought、買っていない 3 連複は bought なし", () => {
    const d = buildRaceDigest(view("202605030801", marked(), { allocation: alloc([["wide", "0102", 200]]) }), FULL);
    expect(d.templates!.map((t) => [t.id, t.status, t.payout, t.bought ?? false])).toEqual([
      ["win", "hit", 450, false], ["place", "hit", 150, false], ["wide", "hit", 800, true], ["quinella", "hit", 1200, false], ["trio", "hit", 5000, false],
    ]);
  });

  it("印が無いレースは 5 型とも対象外、結果が無いレースは 5 型とも判定不能(どちらも 5 件を持つ)", () => {
    const noMark = buildRaceDigest(view("202605030802", [horse(1), horse(2)]), FULL);
    expect(noMark.templates!.map((t) => t.status)).toEqual(Array(5).fill("inapplicable"));
    const noResult = buildRaceDigest(view("202605030803", marked()), undefined);
    expect(noResult.templates!.map((t) => t.status)).toEqual(Array(5).fill("unjudged"));
  });

  it("buildDayStats の whatIf は、ダイジェストの定型の結果の集計(型ごとの点数・的中・賭け金・払戻・判定不能・対象外)", () => {
    const hit = buildRaceDigest(view("202605030801", marked()), FULL);
    const noResult = buildRaceDigest(view("202605030803", marked()), undefined);
    const noMark = buildRaceDigest(view("202605030802", [horse(1)]), FULL);
    const w = buildDayStats([hit, noResult, noMark]).whatIf!;
    // 前提: 3 つの状態(判定できた・判定不能・対象外)がそれぞれ 1 レースずつ
    expect(w.win).toEqual({ betCount: 1, hitCount: 1, stake: 100, payout: 450, refundCount: 0, unjudgedCount: 1, inapplicableCount: 1 });
    expect(w.trio).toEqual({ betCount: 1, hitCount: 1, stake: 100, payout: 5000, refundCount: 0, unjudgedCount: 1, inapplicableCount: 1 });
  });

  it("templates を持たないダイジェスト(デプロイをまたいだ旧形のジョブ)が 1 つでもあれば whatIf は null(旧形でも落ちない)", () => {
    const fresh = buildRaceDigest(view("202605030801", marked()), FULL);
    const { templates: _templates, ...legacy } = { ...fresh, raceId: "202605030802" };
    const stats = buildDayStats([fresh, legacy]);
    expect(stats.whatIf).toBeNull();
    expect(stats.raceCount).toBe(2);
  });

  it("mergeDayStats は whatIf を足す。片方が null なら null", () => {
    const a = buildDayStats([buildRaceDigest(view("202605030801", marked()), FULL)]);
    const b = buildDayStats([buildRaceDigest(view("202605030802", marked()), undefined)]);
    expect(mergeDayStats(a, b).whatIf!.win).toEqual({ betCount: 1, hitCount: 1, stake: 100, payout: 450, refundCount: 0, unjudgedCount: 1, inapplicableCount: 0 });
    expect(mergeDayStats(a, { ...b, whatIf: null }).whatIf).toBeNull();
    expect(mergeDayStats({ ...a, whatIf: null }, b).whatIf).toBeNull();
  });
});
