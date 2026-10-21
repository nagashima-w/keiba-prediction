import { describe, expect, it } from "vitest";
import type {
  RaceComboPayoutsReadResult,
  RaceResultEntry,
  StoredAllocationSummary,
  StoredAnalysis,
  StoredAnalysisHorse,
  VerifyDataSource,
} from "../../src/ev/analysis-store-types.js";
import {
  collectProposedBetEvents,
  computeVerifyReport,
  DEFAULT_VERIFY_CONFIG,
  type ProposedBetEvent,
  type ProposedBetTypeSummary,
} from "../../src/ev/verify.js";

/**
 * Issue #384: 配分ベースの回収率(proposedBet)を、買い目 1 件ずつの「判定の事象」として取り出す `collectProposedBetEvents`。
 * 人気帯・条件ごとの内訳(cloud)が、本体の集計と**同じ判定**(的中・外れ・返還・判定不能)を使うための窓口。
 * 判定の規則を cloud 側で作り直さない(ずれる)ので、事象は `computeProposedBetReport` の中の判定から出す。
 *
 * 守ること:
 *  (1) 券種ごとに、事象の件数・賭け金・払戻・返還・判定不能の合計が `proposedBet` の券種別の要約とビット一致する(同じ加算順)。
 *  (2) 事象を取り出しても、`computeVerifyReport` の出力は変わらない(引数を省略した呼び出しと同じ)。
 *  (3) 未知の券種の行は事象に出ない(`unknownBetType` に数える行で、判定していない)。
 */

const RACE_A = "202606030801";
const RACE_B = "202606030802";

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] };
}

function analysis(id: number, raceId: string): StoredAnalysis {
  return {
    id, raceId, analyzedAt: "2026-06-06T01:00:00.000Z", horses: [horse(1), horse(2), horse(3)], evEstimated: false, promptVersion: "v1", additionalInstruction: null,
    kaisaiDate: "20260606", model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: "20260606", promptLookaheadGuarded: true,
  };
}

/** A レース: 1 着 = 1 番(複勝 150・単勝 400)、2 着 = 2 番(複勝 200)、3 着 = 3 番(複勝 120)、5 番は取消。 */
const RESULT_A: RaceResultEntry[] = [
  { umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 400, scratched: false },
  { umaban: 2, finishPosition: 2, placePayout: 200, winPayout: null, scratched: false },
  { umaban: 3, finishPosition: 3, placePayout: 120, winPayout: null, scratched: false },
  { umaban: 4, finishPosition: 4, placePayout: null, winPayout: null, scratched: false },
  { umaban: 5, finishPosition: null, placePayout: null, winPayout: null, scratched: true },
];
/** B レース: 複勝の払戻が 1 件も無い(未取込)。組合せ券は取込印も無い。 */
const RESULT_B: RaceResultEntry[] = [
  { umaban: 1, finishPosition: 1, placePayout: null, winPayout: null, scratched: false },
  { umaban: 2, finishPosition: 2, placePayout: null, winPayout: null, scratched: false },
];

const ALLOCATIONS: Record<number, StoredAllocationSummary> = {
  1: {
    route: "mixed",
    skipReasonCode: null,
    bets: [
      { betType: "place", comboKey: "01", stake: 300 }, // 的中(150 円/100 円)
      { betType: "place", comboKey: "04", stake: 200 }, // 外れ
      { betType: "place", comboKey: "05", stake: 100 }, // 取消 → 返還
      { betType: "win", comboKey: "01", stake: 500 }, // 的中(400)
      { betType: "win", comboKey: "02", stake: 100 }, // 外れ
      { betType: "wide", comboKey: "0102", stake: 100 }, // 的中(500)
      { betType: "wide", comboKey: "0203", stake: 200 }, // 外れ(払戻表に無い)
      { betType: "trio", comboKey: "010203", stake: 100 }, // 的中(2000)
      { betType: "quinella", comboKey: "0105", stake: 100 }, // 取消の馬を含む → 返還
      { betType: "exacta", comboKey: "0102", stake: 100 }, // 取込印はあるが払戻 0 行 → 判定不能
      { betType: "bracketQuinella", comboKey: "0102", stake: 100 }, // 枠番が無いレースなので返還にならず、払戻表に無い → 外れ
      { betType: "mystery", comboKey: "0102", stake: 100 }, // 未知の券種
    ],
  },
  2: {
    route: "place-only",
    skipReasonCode: null,
    bets: [
      { betType: "place", comboKey: "01", stake: 100 }, // 複勝の払戻が未取込 → 判定不能
      { betType: "wide", comboKey: "0102", stake: 100 }, // 取込印なし → 判定不能
    ],
  },
};

function source(): VerifyDataSource {
  const analyses = [analysis(1, RACE_A), analysis(2, RACE_B)];
  const results: Record<string, RaceResultEntry[]> = { [RACE_A]: RESULT_A, [RACE_B]: RESULT_B };
  const payouts: Record<string, RaceComboPayoutsReadResult> = {
    [`${RACE_A}:wide`]: { state: "imported", payouts: [{ comboKey: "0102", payout: 500 }] },
    [`${RACE_A}:trio`]: { state: "imported", payouts: [{ comboKey: "010203", payout: 2000 }] },
    [`${RACE_A}:quinella`]: { state: "imported", payouts: [{ comboKey: "0102", payout: 800 }] },
    [`${RACE_A}:exacta`]: { state: "imported", payouts: [] },
    [`${RACE_A}:bracketQuinella`]: { state: "imported", payouts: [{ comboKey: "0101", payout: 300 }] },
  };
  return {
    listAnalyses: () => analyses,
    getResult: (raceId) => results[raceId],
    getComboPayouts: (raceId, betType) => payouts[`${raceId}:${betType}`] ?? { state: "not_imported" },
    getAllocationForVerify: (id) => ALLOCATIONS[id],
  };
}

const KNOWN_TYPES = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;

function ofType(events: readonly ProposedBetEvent[], betType: string): ProposedBetEvent[] {
  return events.filter((e) => e.betType === betType);
}

describe("collectProposedBetEvents(買い目ごとの判定の事象)", () => {
  it("入力が退化していない: 的中・外れ・返還・判定不能がすべて 1 件以上ある", () => {
    const events = collectProposedBetEvents(source(), DEFAULT_VERIFY_CONFIG);
    for (const outcome of ["hit", "miss", "refund", "unjudged"] as const) {
      expect(events.filter((e) => e.outcome === outcome).length, `${outcome} が 1 件以上`).toBeGreaterThan(0);
    }
  });

  it("券種ごとの判定: 的中は払戻 = 100 円あたりの払戻 × 賭け金 / 100、外れ・判定不能は 0、返還は賭け金そのもの", () => {
    const events = collectProposedBetEvents(source(), DEFAULT_VERIFY_CONFIG);
    const pick = (betType: string, comboKey: string, analysisId = 1): ProposedBetEvent => {
      const found = events.filter((e) => e.analysisId === analysisId && e.betType === betType && e.comboKey === comboKey);
      expect(found).toHaveLength(1);
      return found[0]!;
    };
    expect(pick("place", "01")).toMatchObject({ outcome: "hit", stake: 300, payout: 450, raceId: RACE_A });
    expect(pick("place", "04")).toMatchObject({ outcome: "miss", stake: 200, payout: 0 });
    expect(pick("place", "05")).toMatchObject({ outcome: "refund", stake: 100, payout: 100 });
    expect(pick("win", "01")).toMatchObject({ outcome: "hit", stake: 500, payout: 2000 });
    expect(pick("win", "02")).toMatchObject({ outcome: "miss", payout: 0 });
    expect(pick("wide", "0102")).toMatchObject({ outcome: "hit", stake: 100, payout: 500 });
    expect(pick("wide", "0203")).toMatchObject({ outcome: "miss", stake: 200, payout: 0 });
    expect(pick("trio", "010203")).toMatchObject({ outcome: "hit", payout: 2000 });
    expect(pick("quinella", "0105")).toMatchObject({ outcome: "refund", stake: 100, payout: 100 });
    expect(pick("exacta", "0102")).toMatchObject({ outcome: "unjudged", payout: 0 });
    expect(pick("bracketQuinella", "0102")).toMatchObject({ outcome: "miss", payout: 0 });
    expect(pick("place", "01", 2)).toMatchObject({ outcome: "unjudged", stake: 100, payout: 0, raceId: RACE_B });
    expect(pick("wide", "0102", 2)).toMatchObject({ outcome: "unjudged", payout: 0 });
  });

  it("未知の券種の行は事象に出ない(unknownBetType に数える行で、判定していない)", () => {
    const report = computeVerifyReport(source(), DEFAULT_VERIFY_CONFIG).proposedBet;
    expect(report.unknownBetType.count).toBe(1);
    const events = collectProposedBetEvents(source(), DEFAULT_VERIFY_CONFIG);
    expect(events.some((e) => e.betType === "mystery")).toBe(false);
    expect(events).toHaveLength(13);
  });

  for (const betType of KNOWN_TYPES) {
    it(`券種 ${betType}: 事象の合計が proposedBet の要約と一致する(件数・賭け金・払戻・返還・判定不能)`, () => {
      const report = computeVerifyReport(source(), DEFAULT_VERIFY_CONFIG).proposedBet;
      const summary: ProposedBetTypeSummary = report[betType];
      const events = ofType(collectProposedBetEvents(source(), DEFAULT_VERIFY_CONFIG), betType);
      const judged = events.filter((e) => e.outcome !== "unjudged");
      expect(judged.length).toBe(summary.betCount);
      expect(judged.reduce((s, e) => s + e.stake, 0)).toBe(summary.totalStake);
      expect(judged.reduce((s, e) => s + e.payout, 0)).toBe(summary.totalReturn);
      expect(events.filter((e) => e.outcome === "refund").length).toBe(summary.refundedCount);
      expect(events.filter((e) => e.outcome === "refund").reduce((s, e) => s + e.stake, 0)).toBe(summary.refundedStake);
      expect(events.filter((e) => e.outcome === "unjudged").length).toBe(summary.unjudgedCount);
    });
  }

  it("このフィクスチャで要約の件数が 0 でない券種は 7 つ(trifecta だけ 0。上の券種別の一致が空振りでないことの前提)", () => {
    const report = computeVerifyReport(source(), DEFAULT_VERIFY_CONFIG).proposedBet;
    const nonEmpty = KNOWN_TYPES.filter((t) => report[t].betCount + report[t].unjudgedCount > 0);
    expect(nonEmpty).toEqual(["place", "win", "wide", "trio", "quinella", "exacta", "bracketQuinella"]);
  });

  it("母集団に入らない分析(結果なし・見送り)の買い目は事象に出ない", () => {
    const base = source();
    const noResult: VerifyDataSource = { ...base, getResult: (raceId) => (raceId === RACE_B ? undefined : base.getResult(raceId)) };
    const events = collectProposedBetEvents(noResult, DEFAULT_VERIFY_CONFIG);
    expect(events.filter((e) => e.analysisId === 2)).toHaveLength(0);
    expect(events.filter((e) => e.analysisId === 1).length).toBeGreaterThan(0);
    const skipped: VerifyDataSource = { ...base, getAllocationForVerify: (id) => (id === 2 ? { route: "place-only", skipReasonCode: "no-positive-ev", bets: [] } : ALLOCATIONS[id]) };
    expect(collectProposedBetEvents(skipped, DEFAULT_VERIFY_CONFIG).filter((e) => e.analysisId === 2)).toHaveLength(0);
  });

  it("事象を取り出しても computeVerifyReport の出力は変わらない(2 回呼んで同一)", () => {
    const before = JSON.stringify(computeVerifyReport(source(), DEFAULT_VERIFY_CONFIG));
    collectProposedBetEvents(source(), DEFAULT_VERIFY_CONFIG);
    expect(JSON.stringify(computeVerifyReport(source(), DEFAULT_VERIFY_CONFIG))).toBe(before);
  });
});

/**
 * 組合せ払戻の取得回数(Issue #433〈#398 R-7 のレビューの記録〉)。`computeProposedBetReport` の `comboPayoutsOf` は、レース×券種ごとに `getComboPayouts` を 1 回だけ引く
 * (同じレースに買い目が複数あっても、同じレースの分析が複数あっても、無駄な読み出しをしない)。値は引いたものをそのまま返す(別のレース・別の券種の値を返さない)。
 */
describe("組合せ払戻のキャッシュ(レース×券種ごとに getComboPayouts を 1 回)", () => {
  // 既定(latest)は同一レースの最新 1 件しか数えないので、同じレースの 2 つの分析を両方使うために全分析を集計する設定にする。
  const ALL_ANALYSES = { ...DEFAULT_VERIFY_CONFIG, includeAllAnalyses: true };
  function countingSource(): { readonly source: VerifyDataSource; readonly calls: string[] } {
    // 同じレース A に 2 つの分析(買い目が複数。ワイド 3 本・3連複 2 本)、別のレース B に 1 つの分析(ワイド 1 本)。
    const analyses = [analysis(1, RACE_A), { ...analysis(2, RACE_A), analyzedAt: "2026-06-06T02:00:00.000Z" }, analysis(3, RACE_B)];
    const results: Record<string, RaceResultEntry[]> = { [RACE_A]: RESULT_A, [RACE_B]: RESULT_B };
    const payouts: Record<string, RaceComboPayoutsReadResult> = {
      [`${RACE_A}:wide`]: { state: "imported", payouts: [{ comboKey: "0102", payout: 500 }] },
      [`${RACE_A}:trio`]: { state: "imported", payouts: [{ comboKey: "010203", payout: 2000 }] },
      [`${RACE_B}:wide`]: { state: "imported", payouts: [{ comboKey: "0102", payout: 900 }] },
    };
    const allocations: Record<number, StoredAllocationSummary> = {
      1: { route: "mixed", skipReasonCode: null, bets: [{ betType: "wide", comboKey: "0102", stake: 100 }, { betType: "wide", comboKey: "0203", stake: 100 }, { betType: "wide", comboKey: "0103", stake: 100 }, { betType: "trio", comboKey: "010203", stake: 100 }, { betType: "trio", comboKey: "010204", stake: 100 }] },
      2: { route: "mixed", skipReasonCode: null, bets: [{ betType: "wide", comboKey: "0102", stake: 200 }, { betType: "trio", comboKey: "010203", stake: 200 }] },
      3: { route: "mixed", skipReasonCode: null, bets: [{ betType: "wide", comboKey: "0102", stake: 100 }] },
    };
    const calls: string[] = [];
    return {
      calls,
      source: {
        listAnalyses: () => analyses,
        getResult: (raceId) => results[raceId],
        getComboPayouts: (raceId, betType) => {
          calls.push(`${raceId}:${betType}`);
          return payouts[`${raceId}:${betType}`] ?? { state: "not_imported" };
        },
        getAllocationForVerify: (id) => allocations[id],
      },
    };
  }

  it("レース A のワイド(分析 2 つ・買い目 4 本)・3連複(買い目 3 本)とレース B のワイドは、それぞれ 1 回だけ引く(合計 3 回)", () => {
    const { source: src, calls } = countingSource();
    const report = computeVerifyReport(src, ALL_ANALYSES).proposedBet;
    // 前提: 買い目が実際に判定されている(キャッシュ以前に、取得が起きている)
    expect(report.population.allocated).toBe(3);
    expect(report.wide.betCount).toBe(5); // 的中: A(分析 1)の 1 本・A(分析 2)の 1 本・B の 1 本 / 外れ: A(分析 1)の 2 本(0203・0103)
    expect(report.trio.betCount).toBe(3);
    expect([...calls].sort()).toEqual([`${RACE_A}:trio`, `${RACE_A}:wide`, `${RACE_B}:wide`]);
  });

  it("キャッシュした値は、別のレース・別の券種に使い回されない(各買い目は自分のレース・券種の払戻で判定される)", () => {
    const { source: src } = countingSource();
    const events = collectProposedBetEvents(src, ALL_ANALYSES);
    const pick = (analysisId: number, betType: string, comboKey: string): ProposedBetEvent => {
      const found = events.filter((e) => e.analysisId === analysisId && e.betType === betType && e.comboKey === comboKey);
      expect(found).toHaveLength(1);
      return found[0]!;
    };
    expect(pick(1, "wide", "0102")).toMatchObject({ outcome: "hit", payout: 500 });
    expect(pick(2, "wide", "0102")).toMatchObject({ outcome: "hit", payout: 1000 }); // 賭け金 200 円 × 500 / 100(同じレースの払戻を使い回す)
    expect(pick(3, "wide", "0102")).toMatchObject({ outcome: "hit", payout: 900 }); // 別のレースの払戻(A のキャッシュを使わない)
    expect(pick(1, "trio", "010203")).toMatchObject({ outcome: "hit", payout: 2000 });
    expect(pick(1, "trio", "010204")).toMatchObject({ outcome: "miss", payout: 0 });
  });
});
