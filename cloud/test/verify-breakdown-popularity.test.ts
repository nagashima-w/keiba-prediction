import { describe, expect, it } from "vitest";
import { collectProposedBetEvents, computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types.js";
import {
  BREAKDOWN_BOOTSTRAP_ITERATIONS,
  BREAKDOWN_REFERENCE_MIN_RACES,
  bootstrapRatioIntervals,
  buildBetExtras,
  buildPopularityStats,
  computeVerifyBreakdowns,
  popularityBandIndex,
  popularityRanks,
  renderPopularitySections,
  WIN_PLACE_GAP_MIN,
  type BandStat,
  type GroupStat,
  type PopularityStats,
} from "../src/verify-breakdown";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyBetRow, type VerifyReadRows, type VerifyResultRow } from "../src/verify-read";

/**
 * Issue #384: 検証画面の「人気帯ごとの期待値と回収率」。買い目の券種に合わせた人気で分け(ユーザーの決定 2026-10-19)、帯ごとに
 * 「提案時の期待値(賭け金加重)」と「実際の回収率」、「予想した的中数(ev ÷ odds の和)」と「実際の的中数」を並べる。
 *  - 複勝・ワイド: 分析時の複勝オッズ下限の順位(確定時の複勝オッズは D1 に無い)
 *  - 単勝・馬連・馬単・3連複・3連単: 確定時の単勝人気(`race_results.ninki`。購入時には分からない値)
 *  - 組合せは構成馬のうち最も人気薄の馬で分ける。枠連は馬の人気に直せないので対象外
 * 加えて「単複の人気のずれ」(確定の単勝人気 − 分析時の複勝順位)の内訳を出す。
 * 買い目の判定(的中・外れ・返還・判定不能)は core の `collectProposedBetEvents` に任せ、ここでは作り直さない。
 */

const RACE = "202606030811";
const NAR_RACE = "202644071411";

// ---------------------------------------------------------------------------
// 人気の順位と帯
// ---------------------------------------------------------------------------

function horseOf(umaban: number, placeOddsMin: number | null): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.2, placeOddsMin, ev: null, isPositive: false, contributions: null, mark: null, reason: null, highlights: [], concerns: [] };
}

describe("popularityRanks(分析時の複勝オッズ下限の順位)", () => {
  it("オッズの小さい順に 1 位から。同点は小さい方の順位を共有し、次の順位は飛ぶ", () => {
    const ranks = popularityRanks([horseOf(1, 2.5), horseOf(2, 1.2), horseOf(3, 1.2), horseOf(4, 3.0), horseOf(5, 2.5)]);
    expect([...ranks.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, 3], [2, 1], [3, 1], [4, 5], [5, 3]]);
  });

  it("オッズが無い(null)・0 以下・有限でない馬は順位を持たない(他の馬の順位にも数えない)", () => {
    const ranks = popularityRanks([horseOf(1, null), horseOf(2, 0), horseOf(3, -1), horseOf(4, Number.NaN), horseOf(5, 2.0), horseOf(6, 3.0)]);
    expect([...ranks.entries()].sort((a, b) => a[0] - b[0])).toEqual([[5, 1], [6, 2]]);
  });
});

describe("popularityBandIndex(4 帯: 1〜3 / 4〜6 / 7〜9 / 10 以下)", () => {
  const cases: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [2, 0], [3, 0],
    [4, 1], [5, 1], [6, 1],
    [7, 2], [8, 2], [9, 2],
    [10, 3], [11, 3], [18, 3],
  ];
  it.each(cases)("%i 番人気は帯 %i", (rank, band) => {
    expect(popularityBandIndex(rank)).toBe(band);
  });
});

// ---------------------------------------------------------------------------
// ブートストラップ
// ---------------------------------------------------------------------------

describe("bootstrapRatioIntervals(レース単位のクラスタ・ブートストラップ)", () => {
  it("反復回数は 1000(ユーザー指定)", () => {
    expect(BREAKDOWN_BOOTSTRAP_ITERATIONS).toBe(1000);
  });

  it("2 クラスタ(払戻 0 と 300、賭け金 100 ずつ): 再標本の比は {0, 1.5, 3} だけで、2.5%・97.5% 点はそれぞれ 0 と 3", () => {
    const result = bootstrapRatioIntervals([
      { x1: 0, y1: 100, x2: 0, y2: 1 },
      { x1: 300, y1: 100, x2: 0, y2: 1 },
    ]);
    // 点推定は 1.5。区間が点推定と同じ(退化)でないことを先に固定する。
    expect(result.first).toEqual({ lower: 0, upper: 3 });
  });

  it("全クラスタが同じ比なら区間は点に潰れる(退化の入力でも落ちない)", () => {
    const same = Array.from({ length: 5 }, () => ({ x1: 200, y1: 100, x2: 1, y2: 2 }));
    expect(bootstrapRatioIntervals(same)).toEqual({ first: { lower: 2, upper: 2 }, second: { lower: 0.5, upper: 0.5 } });
  });

  it("クラスタが 1 つ以下なら区間なし(再標本しても同じ値しか出ない)", () => {
    expect(bootstrapRatioIntervals([{ x1: 1, y1: 1, x2: 1, y2: 1 }])).toEqual({ first: null, second: null });
    expect(bootstrapRatioIntervals([])).toEqual({ first: null, second: null });
  });

  it("分母の合計が 0 の側は区間なし", () => {
    const result = bootstrapRatioIntervals([
      { x1: 100, y1: 100, x2: 0, y2: 0 },
      { x1: 0, y1: 100, x2: 0, y2: 0 },
    ]);
    expect(result.first).not.toBeNull();
    expect(result.second).toBeNull();
  });

  it("同じ入力なら同じ結果(固定シード)。下限 ≤ 点推定 ≤ 上限", () => {
    const clusters = Array.from({ length: 40 }, (_, i) => ({ x1: i % 7 === 0 ? 100 * (i % 5 + 2) : 0, y1: 100, x2: i % 7 === 0 ? 1 : 0, y2: 0.2 }));
    const a = bootstrapRatioIntervals(clusters);
    const b = bootstrapRatioIntervals(clusters);
    expect(a).toEqual(b);
    const point = clusters.reduce((s, c) => s + c.x1, 0) / clusters.reduce((s, c) => s + c.y1, 0);
    expect(a.first!.upper).toBeGreaterThan(a.first!.lower);
    expect(a.first!.lower).toBeLessThanOrEqual(point);
    expect(point).toBeLessThanOrEqual(a.first!.upper);
  });
});

// ---------------------------------------------------------------------------
// 見本: 10 頭立ての 1 レース(分析時の複勝オッズ下限の順位 = 馬番。確定の単勝人気は 4 番と 9 番を入れ替えた並び)
// ---------------------------------------------------------------------------

function analysisRow(id: number, raceId: string): VerifyAnalysisRow {
  return {
    id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
  };
}

function horseRows(analysisId: number, count: number): VerifyReadRows["horses"] {
  // 複勝オッズ下限は 1.5, 2.0, 2.5, …(馬番が大きいほど人気薄 → 分析時の順位 = 馬番)。
  return Array.from({ length: count }, (_, i) => ({
    analysisId, umaban: i + 1, prior: 0.3, adjusted_prob: 0.3, place_odds_min: 1.5 + 0.5 * i, ev: 1, is_positive: 1,
    contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null,
  }));
}

/** 確定の単勝人気(馬番 → 人気)。4 番は 9 番人気(分析時の複勝順位 4 位より人気薄)、9 番は 4 番人気(複勝順位 9 位より人気)。 */
const NINKI: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 3, 4: 9, 5: 5, 6: 6, 7: 7, 8: 8, 9: 4, 10: 10 };

function resultRows(raceId: string): VerifyResultRow[] {
  return Array.from({ length: 10 }, (_, i) => {
    const umaban = i + 1;
    const finish = umaban === 1 ? 1 : umaban === 2 ? 2 : umaban === 3 ? 3 : umaban + 3;
    return { raceId, umaban, finishPosition: finish, placePayout: finish <= 3 ? 100 + 50 * finish : null, winPayout: finish === 1 ? 350 : null, ninki: NINKI[umaban]! };
  });
}

const bet = (analysisId: number, betType: string, comboKey: string, stake: number, odds: number | null, ev: number | null): VerifyBetRow => ({ analysisId, betType, comboKey, stake, odds, ev });

/**
 * 見本の買い目(A レース。1 着 = 1 番、2 着 = 2 番、3 着 = 3 番。複勝の払戻は 1 着 150・2 着 200・3 着 250、単勝は 1 着が 350):
 *  複勝(分析時の順位 = 馬番): 01(帯 1・的中 300×1.5=450・ev 1.2・odds 2)、02(帯 1・的中 100×2.0=200・ev 1.0・odds 2.5)、04(帯 2・外れ 200・ev 1.5・odds 3)、10(帯 4・外れ 100・ev 2.0・odds 4)、11(順位なし → 人気不明・外れ 100)
 *  単勝(確定の人気): 01(1 番人気 → 帯 1・的中 100×3.5=350・ev 1.1・odds 5.5)、07(7 番人気 → 帯 3・外れ・ev 1.3・odds 13)、04(9 番人気 → 帯 3・外れ・ev 1.5・odds 12)、09(4 番人気 → 帯 2・外れ・ev 1.2・odds 6)
 *  ワイド(分析時の順位の最大): 0102(最大 2 位 → 帯 1・的中 払戻 500 × 2 = 1,000・ev 1.2・odds 4)、0407(最大 7 位 → 帯 3・外れ・ev 1.4・odds 7)
 *  馬連(確定の人気の最大): 0103(最大 3 番人気 → 帯 1・的中 900・ev 1.5・odds 9)、0409(最大 9 番人気 → 帯 3・外れ・ev 1.3・odds 15)
 *  3連複 010210(払戻表が空 = 判定不能 → どの行にも入らない)、枠連 0102(払戻表には 0505 だけ → 外れ。馬の人気に直せない → 対象外)
 * 単複の人気のずれ(確定の単勝人気 − 分析時の複勝順位。4 番は +5、9 番は −5、ほかは 0): 04 を含む買い目(複勝 04・単勝 04・ワイド 0407)は「単勝は人気薄」、単勝 09 は「複勝は人気薄」、馬連 0409 は両方、
 *  複勝 11 は単勝人気なし → 人気不明、残り 7 点はずれが小さい。
 */
function sampleRows(): VerifyReadRows {
  const bets: VerifyBetRow[] = [
    bet(1, "place", "01", 300, 2, 1.2),
    bet(1, "place", "02", 100, 2.5, 1.0),
    bet(1, "place", "04", 200, 3, 1.5),
    bet(1, "place", "10", 100, 4, 2.0),
    bet(1, "place", "11", 100, 2, 1.0),
    bet(1, "win", "01", 100, 5.5, 1.1),
    bet(1, "win", "07", 100, 13, 1.3),
    bet(1, "win", "04", 100, 12, 1.5),
    bet(1, "win", "09", 100, 6, 1.2),
    bet(1, "wide", "0102", 200, 4, 1.2),
    bet(1, "wide", "0407", 100, 7, 1.4),
    bet(1, "quinella", "0103", 100, 9, 1.5),
    bet(1, "quinella", "0409", 100, 15, 1.3),
    bet(1, "trio", "010210", 100, 20, 2.0),
    bet(1, "bracketQuinella", "0102", 100, 5, 1.0),
  ];
  return {
    analyses: [analysisRow(1, RACE)],
    horses: horseRows(1, 10),
    allocationMeta: [{ analysisId: 1, route: "mixed", skipReasonCode: null }],
    bets,
    results: resultRows(RACE),
    comboPayouts: [
      { raceId: RACE, betType: "wide", comboKey: "0102", payout: 500 },
      { raceId: RACE, betType: "quinella", comboKey: "0103", payout: 900 },
      { raceId: RACE, betType: "bracketQuinella", comboKey: "0505", payout: 300 },
    ],
    comboImports: [
      { raceId: RACE, betType: "wide" },
      { raceId: RACE, betType: "quinella" },
      { raceId: RACE, betType: "trio" },
      { raceId: RACE, betType: "bracketQuinella" },
    ],
  };
}

function statsOf(rows: VerifyReadRows) {
  const source = buildVerifySource(rows);
  const events = collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG);
  return { source, events, stats: buildPopularityStats(source, events, buildBetExtras(rows.bets)) };
}

type GroupKey = GroupStat["key"];
const group = (stats: PopularityStats, key: GroupKey): GroupStat => stats.groups.find((g) => g.key === key)!;
const band = (g: GroupStat, i: number): BandStat => g.bands[i]!;
const gapRow = (stats: PopularityStats, key: PopularityStats["gap"][number]["key"]): BandStat => stats.gap.find((g) => g.key === key)!.stat;

describe("buildPopularityStats(券種に合わせた人気での帯ごとの集計)", () => {
  it("見本が退化していない: 判定不能が 1 点(3連複)あり、グループは複勝・単勝・ワイド・組合せの順で、基準は分析時 / 確定 / 分析時 / 確定", () => {
    const { events, stats } = statsOf(sampleRows());
    expect(events.filter((e) => e.outcome === "unjudged")).toHaveLength(1);
    expect(stats.groups.map((g) => [g.key, g.basis])).toEqual([["place", "analysis"], ["win", "final"], ["wide", "analysis"], ["combo", "final"]]);
    expect(group(stats, "place").bands.map((b) => b.bets)).toEqual([2, 1, 0, 1]);
    expect(group(stats, "place").unknown.bets).toBe(1);
  });

  it("複勝(分析時の順位): 帯 1(01・02) は賭け金 400・払戻 650・予想の期待値は賭け金加重 1.15・予想した的中数 1.0(0.6 + 0.4)・実際の的中数 2", () => {
    const b = band(group(statsOf(sampleRows()).stats, "place"), 0);
    expect(b).toMatchObject({ bets: 2, races: 1, stake: 400, payout: 650, hits: 2, evBets: 2 });
    expect(b.recovery).toBeCloseTo(1.625, 12);
    expect(b.meanEv).toBeCloseTo(1.15, 12);
    expect(b.expectedHits).toBeCloseTo(1.0, 12);
    expect(b.hitRatio).toBeCloseTo(2.0, 12);
  });

  it("複勝: 帯 2(04)・帯 4(10)・人気不明(11) は外れ。帯 3 は買い目なしで回収率・期待値は null", () => {
    const place = group(statsOf(sampleRows()).stats, "place");
    expect(band(place, 1)).toMatchObject({ bets: 1, stake: 200, payout: 0, hits: 0, recovery: 0 });
    expect(band(place, 1).meanEv).toBeCloseTo(1.5, 12);
    expect(band(place, 1).expectedHits).toBeCloseTo(0.5, 12);
    expect(band(place, 2)).toMatchObject({ bets: 0, stake: 0, payout: 0, recovery: null, meanEv: null, hitRatio: null });
    expect(band(place, 3)).toMatchObject({ bets: 1, stake: 100, payout: 0 });
    expect(place.unknown).toMatchObject({ bets: 1, stake: 100, payout: 0 });
  });

  it("単勝(確定の人気): 04 は 9 番人気なので帯 3(分析時の複勝順位の 4 位ではない)。01 は帯 1 で的中、09 は 4 番人気で帯 2", () => {
    const win = group(statsOf(sampleRows()).stats, "win");
    expect(band(win, 0)).toMatchObject({ bets: 1, stake: 100, payout: 350, hits: 1, recovery: 3.5 });
    expect(band(win, 0).expectedHits).toBeCloseTo(0.2, 12);
    expect(band(win, 1)).toMatchObject({ bets: 1, stake: 100, payout: 0, hits: 0 });
    expect(band(win, 1).expectedHits).toBeCloseTo(0.2, 12);
    expect(band(win, 2)).toMatchObject({ bets: 2, stake: 200, payout: 0, hits: 0 });
    expect(band(win, 2).meanEv).toBeCloseTo(1.4, 12);
    expect(band(win, 2).expectedHits).toBeCloseTo(0.1 + 0.125, 12);
    expect(band(win, 3).bets + win.unknown.bets).toBe(0);
  });

  it("ワイド(分析時の順位の最大): 0102 は帯 1(的中 1,000)、0407 は帯 3", () => {
    const wide = group(statsOf(sampleRows()).stats, "wide");
    expect(band(wide, 0)).toMatchObject({ bets: 1, stake: 200, payout: 1000, hits: 1 });
    expect(band(wide, 0).expectedHits).toBeCloseTo(0.3, 12);
    expect(band(wide, 2)).toMatchObject({ bets: 1, stake: 100, payout: 0, hits: 0 });
    expect(wide.excluded).toBeNull();
  });

  it("組合せ(馬連・馬単・3連複・3連単。確定の人気の最大): 0103 は帯 1、0409 は 9 番人気を含むので帯 3。判定不能(3連複)は入らず、枠連は対象外として件数と賭け金だけを持つ", () => {
    const combo = group(statsOf(sampleRows()).stats, "combo");
    expect(band(combo, 0)).toMatchObject({ bets: 1, stake: 100, payout: 900, hits: 1 });
    expect(band(combo, 0).expectedHits).toBeCloseTo(1.5 / 9, 12);
    expect(band(combo, 2)).toMatchObject({ bets: 1, stake: 100, payout: 0, hits: 0 });
    expect(band(combo, 2).meanEv).toBeCloseTo(1.3, 12);
    expect(band(combo, 1).bets + band(combo, 3).bets + combo.unknown.bets).toBe(0);
    expect(combo.excluded).toEqual({ bets: 1, stake: 100 });
  });

  it("複勝・ワイドの帯は確定の人気に依らず、単勝・組合せの帯は分析時の複勝オッズに依らない", () => {
    const rows = sampleRows();
    const reversedNinki = rows.results.map((r) => ({ ...r, ninki: 11 - (r.ninki ?? 0) }));
    const a = statsOf({ ...rows, results: reversedNinki }).stats;
    const base = statsOf(rows).stats;
    for (const key of ["place", "wide"] as const) {
      expect(group(a, key).bands.map((b) => b.bets), key).toEqual(group(base, key).bands.map((b) => b.bets));
    }
    expect(group(a, "win").bands.map((b) => b.bets)).not.toEqual(group(base, "win").bands.map((b) => b.bets));
    const reversedOdds = rows.horses.map((h) => ({ ...h, place_odds_min: 20 - h.umaban }));
    const b = statsOf({ ...rows, horses: reversedOdds }).stats;
    for (const key of ["win", "combo"] as const) {
      expect(group(b, key).bands.map((x) => x.bets), key).toEqual(group(base, key).bands.map((x) => x.bets));
    }
    expect(group(b, "place").bands.map((x) => x.bets)).not.toEqual(group(base, "place").bands.map((x) => x.bets));
  });

  it("確定の人気(ninki)が NULL の馬を含む買い目は、単勝・組合せでは人気不明。ワイドは分析時の順位なので影響を受けない", () => {
    const rows = sampleRows();
    const results = rows.results.map((r) => (r.umaban === 7 ? { ...r, ninki: null } : r));
    const stats = statsOf({ ...rows, results }).stats;
    expect(group(stats, "win").unknown.bets).toBe(1);
    expect(band(group(stats, "win"), 2).bets).toBe(1);
    expect(band(group(stats, "wide"), 2).bets).toBe(1);
  });

  it("odds・ev が欠損(null)の買い目は、期待値と予想した的中数の計算(分子も分母も)から外し、その点数を evMissing に数える。回収率には含める", () => {
    const rows = sampleRows();
    const patched: VerifyReadRows = { ...rows, bets: rows.bets.map((b) => (b.betType === "place" && b.comboKey === "02" ? { ...b, odds: null, ev: null } : b)) };
    const b = band(group(statsOf(patched).stats, "place"), 0);
    // 的中数は予想と比べられる買い目(ev・odds がある)の的中だけ数える。02 は的中だが比べられないので 1。
    expect(b).toMatchObject({ bets: 2, stake: 400, payout: 650, hits: 1, evBets: 1, evMissing: 1 });
    expect(b.recovery).toBeCloseTo(1.625, 12);
    expect(b.meanEv).toBeCloseTo(1.2, 12);
    expect(b.expectedHits).toBeCloseTo(0.6, 12);
    expect(b.hitRatio).toBeCloseTo(1 / 0.6, 12);
  });

  it("返還(取消馬への買い目)は賭け金・払戻に含めて回収率に効くが、的中数にも予想した的中数にも数えない。複勝の帯は分析時の順位のまま(結果を見て変えない)", () => {
    const rows = sampleRows();
    const results = rows.results.map((r) => (r.umaban === 2 ? { ...r, finishPosition: null, placePayout: null, scratched: 1 } : r));
    const b = band(group(statsOf({ ...rows, results }).stats, "place"), 0);
    // 02 は返還(払戻 = 賭け金 100)。01 は的中 450。02 の順位は分析時の 2 位のままなので、帯 1 に入る。
    expect(b).toMatchObject({ bets: 2, stake: 400, payout: 550, hits: 1, evBets: 2 });
    expect(b.expectedHits).toBeCloseTo(0.6, 12);
    expect(b.meanEv).toBeCloseTo(1.15, 12);
  });

  it("帯・人気不明・対象外の合計が、本体の proposedBet の券種別の要約と一致する(複勝 / 単勝 / ワイド / 馬連〜3連単。枠連は対象外の分)", () => {
    const { source, stats } = statsOf(sampleRows());
    const report = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG).proposedBet;
    const sum = (g: GroupStat) => {
      const all = [...g.bands, g.unknown];
      return { bets: all.reduce((s, b) => s + b.bets, 0), stake: all.reduce((s, b) => s + b.stake, 0), payout: all.reduce((s, b) => s + b.payout, 0) };
    };
    const pick = (...types: Array<"place" | "win" | "wide" | "trio" | "quinella" | "exacta" | "trifecta">) => ({
      bets: types.reduce((s, t) => s + report[t].betCount, 0),
      stake: types.reduce((s, t) => s + report[t].totalStake, 0),
      payout: types.reduce((s, t) => s + report[t].totalReturn, 0),
    });
    expect(sum(group(stats, "place"))).toEqual(pick("place"));
    expect(sum(group(stats, "win"))).toEqual(pick("win"));
    expect(sum(group(stats, "wide"))).toEqual(pick("wide"));
    expect(sum(group(stats, "combo"))).toEqual(pick("trio", "quinella", "exacta", "trifecta"));
    expect(group(stats, "combo").excluded).toEqual({ bets: report.bracketQuinella.betCount, stake: report.bracketQuinella.totalStake });
    // 空振りでない: どの合計も 0 でない。
    for (const key of ["place", "win", "wide", "combo"] as const) {
      expect(sum(group(stats, key)).bets, key).toBeGreaterThan(0);
    }
  });

  it("同じレースの複数の買い目は 1 レースと数える(races はクラスタの数)。複数のレースなら足し上がる", () => {
    const rows = sampleRows();
    const withSecond: VerifyReadRows = {
      ...rows,
      analyses: [...rows.analyses, analysisRow(2, "202606030812")],
      horses: [...rows.horses, ...horseRows(2, 10)],
      allocationMeta: [...rows.allocationMeta, { analysisId: 2, route: "place-only", skipReasonCode: null }],
      bets: [...rows.bets, bet(2, "place", "01", 100, 2, 1.2)],
      results: [...rows.results, ...resultRows("202606030812")],
    };
    const b = band(group(statsOf(withSecond).stats, "place"), 0);
    expect(b.bets).toBe(3);
    expect(b.races).toBe(2);
  });
});

describe("単複の人気のずれ(確定の単勝人気 − 分析時の複勝順位)", () => {
  it("差の区切りは 4(単勝人気 − 複勝順位 ≥ 4 を「単勝は人気薄・複勝は売れている」、≤ −4 を逆向きとする。置き値)", () => {
    expect(WIN_PLACE_GAP_MIN).toBe(4);
  });

  it("行は 5 つ(単勝は人気薄 / 複勝は人気薄 / 両方 / ずれが小さい / 人気不明)。見本は 5 行とも買い目がある", () => {
    const { stats } = statsOf(sampleRows());
    expect(stats.gap.map((g) => g.key)).toEqual(["winLonger", "placeLonger", "both", "small", "unknown"]);
    expect(stats.gap.map((g) => g.stat.bets)).toEqual([3, 1, 1, 7, 1]);
  });

  it("単勝は人気薄・複勝は売れている(04 を含む複勝 04・単勝 04・ワイド 0407): 賭け金 400・払戻 0・予想の期待値 1.475・予想した的中数 0.825", () => {
    const b = gapRow(statsOf(sampleRows()).stats, "winLonger");
    expect(b).toMatchObject({ bets: 3, stake: 400, payout: 0, hits: 0, recovery: 0 });
    expect(b.meanEv).toBeCloseTo(1.475, 12);
    expect(b.expectedHits).toBeCloseTo(0.5 + 0.125 + 0.2, 12);
    expect(b.hitRatio).toBe(0);
  });

  it("複勝は人気薄・単勝は売れている(単勝 09)、両方の向きを含む(馬連 0409)", () => {
    const { stats } = statsOf(sampleRows());
    expect(gapRow(stats, "placeLonger")).toMatchObject({ bets: 1, stake: 100, payout: 0 });
    expect(gapRow(stats, "both")).toMatchObject({ bets: 1, stake: 100, payout: 0 });
  });

  it("ずれが小さい 7 点: 賭け金 1,000・払戻 2,900・的中 5・予想の期待値 1.29。人気不明(複勝 11)は 1 点", () => {
    const { stats } = statsOf(sampleRows());
    const small = gapRow(stats, "small");
    expect(small).toMatchObject({ bets: 7, stake: 1000, payout: 2900, hits: 5, evBets: 7 });
    expect(small.meanEv).toBeCloseTo(1.29, 12);
    expect(gapRow(stats, "unknown")).toMatchObject({ bets: 1, stake: 100 });
  });

  it("境界: 差がちょうど 4 は「ずれあり」、3 は「ずれが小さい」", () => {
    const rows = sampleRows();
    // 04 の確定人気を 8 番人気(差 +4)にする(8 番は 9 番に)。
    const at4 = rows.results.map((r) => (r.umaban === 4 ? { ...r, ninki: 8 } : r.umaban === 8 ? { ...r, ninki: 9 } : r));
    const four = statsOf({ ...rows, results: at4 }).stats;
    expect(gapRow(four, "winLonger").bets).toBe(3);
    // 差 +3(7 番人気)にする(7 番は 9 番に)。
    const at3 = rows.results.map((r) => (r.umaban === 4 ? { ...r, ninki: 7 } : r.umaban === 7 ? { ...r, ninki: 9 } : r));
    const three = statsOf({ ...rows, results: at3 }).stats;
    expect(gapRow(three, "winLonger").bets).toBe(0);
  });

  it("確定の人気か分析時の順位のどちらかが無い馬を含む買い目は人気不明(複数の脚のうち 1 頭でも欠ければ)", () => {
    const rows = sampleRows();
    const results = rows.results.map((r) => (r.umaban === 7 ? { ...r, ninki: null } : r));
    const stats = statsOf({ ...rows, results }).stats;
    // 単勝 07 と、07 を含むワイド 0407(04 は +5 だが 07 が欠ける)が人気不明に移る。
    expect(gapRow(stats, "unknown").bets).toBe(3);
    expect(gapRow(stats, "winLonger").bets).toBe(2);
  });

  it("全行の合計が、人気不明を含めて本体の proposedBet の(枠連を除く)全券種の合計と一致する", () => {
    const { source, stats } = statsOf(sampleRows());
    const report = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG).proposedBet;
    const types = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta"] as const;
    expect(stats.gap.reduce((s, g) => s + g.stat.bets, 0)).toBe(types.reduce((s, t) => s + report[t].betCount, 0));
    expect(stats.gap.reduce((s, g) => s + g.stat.stake, 0)).toBe(types.reduce((s, t) => s + report[t].totalStake, 0));
    expect(stats.gap.reduce((s, g) => s + g.stat.payout, 0)).toBe(types.reduce((s, t) => s + report[t].totalReturn, 0));
  });
});

// ---------------------------------------------------------------------------
// 表示用の節
// ---------------------------------------------------------------------------

const EMPTY_STAT: BandStat = { bets: 0, races: 0, stake: 0, payout: 0, hits: 0, evBets: 0, evMissing: 0, meanEv: null, expectedHits: 0, recovery: null, hitRatio: null, recoveryInterval: null, hitRatioInterval: null };
/** `races` レース・1 レース 1 点・賭け金 100 円の帯(区間なし)。 */
const statOf = (races: number): BandStat => ({ bets: races, races, stake: races * 100, payout: races * 90, hits: 1, evBets: races, evMissing: 0, meanEv: 1.1, expectedHits: 2, recovery: 0.9, hitRatio: 0.5, recoveryInterval: null, hitRatioInterval: null });
const oneGroup = (stat: BandStat): PopularityStats => ({
  groups: [{ key: "place", basis: "analysis", bands: [stat, EMPTY_STAT, EMPTY_STAT, EMPTY_STAT], unknown: EMPTY_STAT, excluded: null }],
  gap: [],
});

describe("renderPopularitySections(サーバが組み立てる表示用の節)", () => {
  const sections = () => renderPopularitySections(statsOf(sampleRows()).stats);

  it("節は 5 つ(複勝・単勝・ワイド・組合せ・単複のずれ)。説明と注記は空でない", () => {
    const s = sections();
    expect(s.map((x) => x.heading)).toEqual([
      "人気帯ごとの期待値と回収率(複勝)",
      "人気帯ごとの期待値と回収率(単勝)",
      "人気帯ごとの期待値と回収率(ワイド)",
      "人気帯ごとの期待値と回収率(馬連・馬単・3連複・3連単)",
      "単勝人気と複勝順位のずれ",
    ]);
    for (const x of s) {
      expect(x.description.length).toBeGreaterThan(20);
      expect(x.note.length).toBeGreaterThan(20);
    }
  });

  it("複勝・ワイドの説明は分析時の複勝オッズ下限の順位であることと単勝人気とは一致しないこと、注記は下限オッズで回収率が上振れすることを述べる", () => {
    const s = sections();
    for (const i of [0, 2]) {
      expect(s[i]!.description).toContain("分析時の複勝オッズ下限の順位");
      expect(s[i]!.description).toContain("単勝の人気とは一致しない");
      expect(s[i]!.note).toContain("下限");
      expect(s[i]!.note).toContain("上振れ");
    }
    expect(s[2]!.description).toContain("最も人気薄");
  });

  it("単勝・組合せの説明は確定時の単勝人気を使うことと、結果を振り返る集計で購入時には分からない値であることを述べる", () => {
    const s = sections();
    for (const i of [1, 3, 4]) {
      expect(s[i]!.description).toContain("確定時の単勝人気");
      expect(s[i]!.description).toContain("結果を振り返る集計で、購入時には分からない値");
    }
    expect(s[3]!.description).toContain("最も人気薄");
  });

  it("複勝の行: 帯 4 つ + 人気不明。帯 1 の項目が、件数・予想の期待値・回収率・差・的中数・比の順に文字列で並ぶ", () => {
    const place = sections()[0]!;
    expect(place.rows.map((r) => r.label)).toEqual(["1〜3番人気", "4〜6番人気", "7〜9番人気", "10番人気以下", "人気不明"]);
    expect(place.rows[0]!.cells).toEqual([
      { name: "件数(レース)", value: "2点(1R)" },
      { name: "予想した期待値", value: "115.0%" },
      { name: "実際の回収率", value: "162.5%" },
      { name: "差(実績−予想)", value: "+47.5pt" },
      { name: "的中数(実/予想)", value: "2/1.0" },
      { name: "的中数の比", value: "2.00" },
      { name: "注意", value: "参考(30レース未満)" },
    ]);
  });

  it("買い目のない帯は件数だけを出す。人気不明の行は買い目があるときだけ出す。組合せは構成馬の最低人気で分け、枠連は対象外の行に件数だけを出す", () => {
    const s = sections();
    expect(s[0]!.rows[2]!.cells).toEqual([{ name: "件数(レース)", value: "0点(0R)" }]);
    expect(s[1]!.rows.map((r) => r.label)).toEqual(["1〜3番人気", "4〜6番人気", "7〜9番人気", "10番人気以下"]);
    expect(s[3]!.rows.map((r) => r.label)).toEqual(["最低人気 1〜3番人気", "最低人気 4〜6番人気", "最低人気 7〜9番人気", "最低人気 10番人気以下", "枠連(馬の人気に直せないため対象外)"]);
    expect(s[3]!.rows[4]!.cells).toEqual([{ name: "件数(レース)", value: "1点" }]);
  });

  it("枠連が無い組合せの節には、対象外の行を出さない", () => {
    const rows = sampleRows();
    const noBracket: VerifyReadRows = { ...rows, bets: rows.bets.filter((b) => b.betType !== "bracketQuinella") };
    const combo = renderPopularitySections(statsOf(noBracket).stats)[3]!;
    expect(combo.rows.map((r) => r.label)).toEqual(["最低人気 1〜3番人気", "最低人気 4〜6番人気", "最低人気 7〜9番人気", "最低人気 10番人気以下"]);
  });

  it("単複のずれの節: 行の見出しに区切り(4)が入り、「両方」「人気不明」は買い目があるときだけ出す", () => {
    const gap = sections()[4]!;
    expect(gap.rows.map((r) => r.label)).toEqual(["単勝は人気薄・複勝は売れている(差4以上)", "複勝は人気薄・単勝は売れている(差4以上)", "両方の向きの馬を含む", "ずれが小さい(差3以下)", "人気不明"]);
    const rows = sampleRows();
    const noMixed: VerifyReadRows = { ...rows, bets: rows.bets.filter((b) => !(b.betType === "quinella" && b.comboKey === "0409") && !(b.betType === "place" && b.comboKey === "11")) };
    const trimmed = renderPopularitySections(statsOf(noMixed).stats)[4]!;
    expect(trimmed.rows.map((r) => r.label)).toEqual(["単勝は人気薄・複勝は売れている(差4以上)", "複勝は人気薄・単勝は売れている(差4以上)", "ずれが小さい(差3以下)"]);
  });

  it("「参考」の印は 30 レース未満の行だけ(境界: 29 レースは付き、30 レースは付かない)", () => {
    expect(BREAKDOWN_REFERENCE_MIN_RACES).toBe(30);
    const render = (races: number) => renderPopularitySections(oneGroup(statOf(races)))[0]!.rows[0]!.cells;
    expect(render(29).some((c) => c.name === "注意")).toBe(true);
    expect(render(30).some((c) => c.name === "注意")).toBe(false);
  });

  it("95%区間があれば、回収率と的中数の比の値に括弧で添える", () => {
    const stat: BandStat = { ...statOf(35), recovery: 0.9, hitRatio: 10 / 12, recoveryInterval: { lower: 0.55, upper: 1.4 }, hitRatioInterval: { lower: 0.5, upper: 1.25 } };
    const cells = renderPopularitySections(oneGroup(stat))[0]!.rows[0]!.cells;
    expect(cells.find((c) => c.name === "実際の回収率")!.value).toBe("90.0%(55.0〜140.0%)");
    expect(cells.find((c) => c.name === "的中数の比")!.value).toBe("0.83(0.50〜1.25)");
    expect(cells.some((c) => c.name === "注意")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 区分ごとの集計
// ---------------------------------------------------------------------------

describe("computeVerifyBreakdowns(区分 all・central・nar)", () => {
  function twoVenueRows(): VerifyReadRows {
    const base = sampleRows();
    return {
      ...base,
      analyses: [...base.analyses, analysisRow(2, NAR_RACE)],
      horses: [...base.horses, ...horseRows(2, 10)],
      allocationMeta: [...base.allocationMeta, { analysisId: 2, route: "place-only", skipReasonCode: null }],
      bets: [...base.bets, bet(2, "place", "01", 100, 2, 1.2), bet(2, "place", "04", 100, 3, 1.5)],
      results: [...base.results, ...resultRows(NAR_RACE)],
    };
  }
  const placeBets = (b: ReturnType<typeof computeVerifyBreakdowns>["all"]) => b!.stats.groups.find((g) => g.key === "place")!.bands.map((x) => x.bets);

  it("central は中央のレースだけ、nar は地方のレースだけ。all はその合計(帯・ずれの行ごとの件数・賭け金・払戻・レース数とも)", () => {
    const rows = twoVenueRows();
    const out = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    expect(placeBets(out.central)).toEqual([2, 1, 0, 1]);
    expect(placeBets(out.nar)).toEqual([1, 1, 0, 0]);
    expect(placeBets(out.all)).toEqual([3, 2, 0, 1]);
    for (const key of ["place", "win", "wide", "combo"] as const) {
      for (let i = 0; i < 4; i += 1) {
        for (const field of ["bets", "stake", "payout", "races"] as const) {
          const pick = (v: "all" | "central" | "nar") => out[v]!.stats.groups.find((g) => g.key === key)!.bands[i]![field];
          expect(pick("all"), `${key} 帯 ${i} の ${field}`).toBe(pick("central") + pick("nar"));
        }
      }
    }
    for (const key of ["winLonger", "small", "unknown"] as const) {
      for (const field of ["bets", "stake", "payout"] as const) {
        const pick = (v: "all" | "central" | "nar") => out[v]!.stats.gap.find((g) => g.key === key)!.stat[field];
        expect(pick("all"), `ずれ ${key} の ${field}`).toBe(pick("central") + pick("nar"));
      }
    }
    // 地方の複勝 04 は確定人気 9 番(差 +5)で「単勝は人気薄」の行に入る = 地方の分が空振りでない。
    expect(out.nar!.stats.gap.find((g) => g.key === "winLonger")!.stat.bets).toBe(1);
  });

  it("★区分 central・nar の内訳は、同じ区分の本体 computeVerifyReport(..., \"central\" | \"nar\").proposedBet と、券種ごとの件数・賭け金・払戻が一致する(Issue #433〈#384 のレビューの記録〉。all = central + nar と all = 本体だけでは、区分の絞りの取り違えを検出できない)", () => {
    // 中央・地方の 2 レース(twoVenueRows)に、本体が母集団から外す分析を足す。足さないと、内訳が「最新の 1 件」「先読みの除外」を本体とそろえているかが検査できない。
    //  - 分析 3: 中央の同じレースの古い分析(最新選択で外れる。買い目は賭け金が大きく、混ざれば合計が変わる)
    //  - 分析 4: 地方の別のレースで、戦績の絞りの印が無い(先読みリークの疑いとして除外される)
    const two = twoVenueRows();
    const NAR_RACE_2 = "202644071412";
    const rows: VerifyReadRows = {
      ...two,
      analyses: [...two.analyses, { ...analysisRow(3, RACE), analyzedAt: "2026-07-05T03:00:00.000Z" }, { ...analysisRow(4, NAR_RACE_2), historyCutoffDate: null }],
      horses: [...two.horses, ...horseRows(3, 10), ...horseRows(4, 10)],
      allocationMeta: [...two.allocationMeta, { analysisId: 3, route: "place-only", skipReasonCode: null }, { analysisId: 4, route: "place-only", skipReasonCode: null }],
      bets: [...two.bets, bet(3, "place", "01", 900, 2, 1.2), bet(4, "place", "01", 500, 2, 1.2)],
      results: [...two.results, ...resultRows(NAR_RACE_2)],
    };
    const source = buildVerifySource(rows);
    const out = computeVerifyBreakdowns(source, rows.bets);
    // 前提: 足した 2 つの分析は、本体の母集団から外れている(外れていなければ、この検査は足した分析の意味を持たない)
    const centralReport = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central");
    const narReport = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "nar");
    expect(centralReport.proposedBet.population.allocated).toBe(1); // 分析 1 だけ(分析 3 は最新でない)
    expect(narReport.proposedBet.population.allocated).toBe(1); // 分析 2 だけ(分析 4 は先読みの疑い)
    expect(computeVerifyReport(source, { ...PRODUCTION_VERIFY_CONFIG, includeAllAnalyses: true, excludeLookaheadSuspects: false }, "all").proposedBet.population.allocated).toBe(4); // 設定を外せば 4 つとも入る=外す設定が結果を変える
    type Totals = { bets: number; stake: number; payout: number };
    const sumGroup = (stats: PopularityStats, key: GroupKey): Totals => {
      const g = group(stats, key);
      const all = [...g.bands, g.unknown];
      return { bets: all.reduce((s, b) => s + b.bets, 0), stake: all.reduce((s, b) => s + b.stake, 0), payout: all.reduce((s, b) => s + b.payout, 0) };
    };
    const totalsOf = (report: ReturnType<typeof computeVerifyReport>["proposedBet"], ...types: Array<"place" | "win" | "wide" | "trio" | "quinella" | "exacta" | "trifecta">): Totals => ({
      bets: types.reduce((s, t) => s + report[t].betCount, 0),
      stake: types.reduce((s, t) => s + report[t].totalStake, 0),
      payout: types.reduce((s, t) => s + report[t].totalReturn, 0),
    });
    const placeAllTotals = sumGroup(out.all!.stats, "place");
    const placeTotalsByVenue: Record<"central" | "nar", Totals> = { central: { bets: 0, stake: 0, payout: 0 }, nar: { bets: 0, stake: 0, payout: 0 } };
    for (const venue of ["central", "nar"] as const) {
      const report = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, venue).proposedBet;
      const stats = out[venue]!.stats;
      expect(sumGroup(stats, "place"), `${venue} の複勝`).toEqual(totalsOf(report, "place"));
      expect(sumGroup(stats, "win"), `${venue} の単勝`).toEqual(totalsOf(report, "win"));
      expect(sumGroup(stats, "wide"), `${venue} のワイド`).toEqual(totalsOf(report, "wide"));
      expect(sumGroup(stats, "combo"), `${venue} の組合せ`).toEqual(totalsOf(report, "trio", "quinella", "exacta", "trifecta"));
      expect(group(stats, "combo").excluded, `${venue} の枠連(対象外)`).toEqual({ bets: report.bracketQuinella.betCount, stake: report.bracketQuinella.totalStake });
      // 単複の人気のずれの行の合計(人気不明を含む)は、枠連を除く全券種の合計と一致する
      const gapSum = stats.gap.reduce((s, g) => ({ bets: s.bets + g.stat.bets, stake: s.stake + g.stat.stake, payout: s.payout + g.stat.payout }), { bets: 0, stake: 0, payout: 0 });
      expect(gapSum, `${venue} のずれの行の合計`).toEqual(totalsOf(report, "place", "win", "wide", "trio", "quinella", "exacta", "trifecta"));
      placeTotalsByVenue[venue] = sumGroup(stats, "place");
    }
    // 空振り防止: 区分ごとに値が違い(central と nar を取り違えても、区分を絞らなくても、等しくならない)、どちらの区分にも買い目がある
    expect(placeTotalsByVenue.nar.bets).toBeGreaterThan(0);
    expect(placeTotalsByVenue.central.bets).toBeGreaterThan(placeTotalsByVenue.nar.bets);
    expect(placeTotalsByVenue.central).not.toEqual(placeTotalsByVenue.nar);
    expect(placeTotalsByVenue.central).not.toEqual(placeAllTotals);
    expect(placeTotalsByVenue.nar).not.toEqual(placeAllTotals);
    expect(computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "nar").proposedBet.win.betCount).toBe(0); // 地方には単勝の買い目が無い(中央の単勝を引き込んでいない)
    expect(computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central").proposedBet.win.betCount).toBeGreaterThan(0);
  });

  it("買い目が 1 つも無い区分は null(節を出さない)", () => {
    const rows = sampleRows();
    const out = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    expect(out.nar).toBeNull();
    expect(out.central).not.toBeNull();
    expect(out.all).not.toBeNull();
  });

  it("応答の節は、人気帯の 5 つに条件別の 3 つ(開催区分・競馬場・頭数。条件別の中身は verify-breakdown-conditions.test.ts)が続く。同じ入力なら同じ結果(固定シード)", () => {
    const rows = twoVenueRows();
    const a = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    const b = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    expect(a.all!.sections).toHaveLength(8);
    expect(a.all!.sections.slice(0, 5).map((s) => s.heading)).toEqual(renderPopularitySections(a.all!.stats).map((s) => s.heading));
    expect(JSON.stringify(a.all!.sections)).toBe(JSON.stringify(b.all!.sections));
  });

  it("ev・odds が読み取り行に無い(旧いテストの固定データ)でも落ちず、期待値と的中数の比は出さない(回収率は出す)", () => {
    const rows = sampleRows();
    const stripped = rows.bets.map(({ analysisId, betType, comboKey, stake }) => ({ analysisId, betType, comboKey, stake }));
    const out = computeVerifyBreakdowns(buildVerifySource({ ...rows, bets: stripped }), stripped);
    const place = out.all!.stats.groups.find((g) => g.key === "place")!.bands[0]!;
    expect(place.recovery).toBeCloseTo(1.625, 12);
    expect(place.meanEv).toBeNull();
    expect(place.hitRatio).toBeNull();
    expect(place.evMissing).toBe(2);
  });
});
