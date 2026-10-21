import { describe, expect, it } from "vitest";
import { AnalysisStore, type AnalysisAllocationMetaRecord, type AnalysisHorseRecord } from "../support/analysis-store.js";
import type { VerifyDataSource } from "../../src/ev/analysis-store-types.js";
import { buildAllocationBetComboKey } from "../../src/ev/combo-bet-allocation.js";
import { toResultEntries } from "../../src/ev/result-import.js";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../src/ev/verify.js";
import { parseNarComboOdds } from "../../src/scraper/parse-nar-combo-odds.js";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #283: 地方の三連単の払戻・検証(回収率)が、中央と同じ経路で正しく動くことの通しテスト。
 *
 * 入力はどちらも**同じ地方レース 202654071210(高知10R・12頭)の実フィクスチャ**:
 *  - オッズ: `nar_odds_b8_jiku5_202654071210.html`(軸 5 = 1着固定。5→7→1 = 2600.9 倍、5→1→7 = 3212.9 倍)
 *  - 結果: `nar_result_202654071210.html`(確定払戻 三連単 5→7→1 = 260,090 円 / 100 円)
 * 買い目のキーは着順どおりの 6 桁(`buildAllocationBetComboKey`)。払戻の取り込み(`parseRaceResult` → `toResultEntries`)から
 * 保存・検証(`computeVerifyReport`。`venue: "nar"`)までを、モックではなく実際の関数で通す。
 */

const RACE = "202654071210";

function horse(umaban: number): AnalysisHorseRecord {
  return { umaban, prior: 0.5, adjustedProb: 0.5, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null };
}

function meta(): AnalysisAllocationMetaRecord {
  return {
    route: "mixed",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    comboOddsWide: null,
    comboOddsTrio: null,
    bankroll: 100000,
    perRaceCap: 10000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWide: true,
    includeTrio: true,
    includeQuinella: true,
    includeExacta: true,
    includeTrifecta: true,
    includeBracketQuinella: true,
    betUnit: 100,
    greedySteps: 1000,
    candidateCap: 2000,
    modelId: "conditional-bernoulli",
    modelApproximate: false,
    oddsStatus: "result",
  };
}

function savedStore(bets: ReadonlyArray<{ umabans: readonly number[]; stake: number; odds: number }>): AnalysisStore {
  const store = new AnalysisStore();
  store.saveAnalysis({
    raceId: RACE,
    analyzedAt: "2026-07-11T12:00:00.000Z", // 前日 21:00 JST(開催日の 00:00 JST より前 = 先読みリークの疑いなし)
    horses: [horse(1)],
    allocation: {
      meta: meta(),
      bets: bets.map((b) => ({ betType: "trifecta", comboKey: buildAllocationBetComboKey("trifecta", b.umabans), stake: b.stake, odds: b.odds, ev: 1.5 })),
    },
  });
  const result = parseRaceResult(loadFixture("nar_result_202654071210.html"));
  store.saveResult(RACE, toResultEntries(result), result.courseType, { trifecta: result.trifectaPayouts });
  return store;
}

function sourceOf(store: AnalysisStore): VerifyDataSource {
  return {
    listAnalyses: (filter) => store.listAnalyses(filter),
    getResult: (raceId) => store.getResult(raceId),
    getComboPayouts: (raceId, betType) => store.getComboPayouts(raceId, betType),
    getAllocationForVerify: (id) => store.getAllocationForVerify(id),
  };
}

describe("地方の三連単: オッズ → 買い目 → 確定払戻 → 回収率(Issue #283。地方の実フィクスチャ 202654071210)", () => {
  // 前提固定: オッズのフィクスチャが 5→7→1 を 2600.9 倍・5→1→7 を 3212.9 倍で持つ(確定払戻 260,090 円 = 2600.9 倍と一致)
  const odds = (() => {
    const parsed = parseNarComboOdds(loadFixture("nar_odds_b8_jiku5_202654071210.html"), "trifecta");
    if (parsed.state !== "available") throw new Error("オッズのフィクスチャが available でない");
    return parsed.odds;
  })();

  it("前提: 地方の結果ページから三連単の払戻 5→7→1 = 260,090 円が取れ、オッズのフィクスチャのキー\"050701\"は 2600.9(=260090÷100)で一致する", () => {
    const result = parseRaceResult(loadFixture("nar_result_202654071210.html"));
    expect(result.trifectaPayouts).toEqual({ state: "parsed", payouts: [{ umabans: [5, 7, 1], payout: 260090 }] });
    expect(odds.get("050701")?.oddsMin).toBe(2600.9);
    expect(odds.get("050107")?.oddsMin).toBe(3212.9);
  });

  it("的中(5→7→1)と逆順の外れ(5→1→7)の 2 買い目(各 500 円): 地方のレポートで三連単の賭け金 1,000 円・払戻 1,300,450 円(=260090×500/100)・回収率 1300.45 になり、判定不能は 0", () => {
    const store = savedStore([
      { umabans: [5, 7, 1], stake: 500, odds: odds.get("050701")!.oddsMin! },
      { umabans: [5, 1, 7], stake: 500, odds: odds.get("050107")!.oddsMin! },
    ]);
    const nar = computeVerifyReport(sourceOf(store), PRODUCTION_VERIFY_CONFIG, "nar").proposedBet.trifecta;
    store.close();
    expect(nar.betCount).toBe(2);
    expect(nar.totalStake).toBe(1000);
    expect(nar.totalReturn).toBe(1_300_450);
    expect(nar.recoveryRate).toBeCloseTo(1300.45, 5);
    expect(nar.unjudgedCount).toBe(0);
    expect(nar.refundedCount).toBe(0);
    // 一律 100 円の比較: 2 買い目 × 100 円 = 200 円、払戻は的中の 260,090 円
    expect(nar.flatStake).toBe(200);
    expect(nar.flatReturn).toBe(260090);
  });

  it("逆順だけの買い目(5→1→7)は外れ(順序どおりに判定する。集合で判定して的中にしない)", () => {
    const store = savedStore([{ umabans: [5, 1, 7], stake: 500, odds: 3212.9 }]);
    const nar = computeVerifyReport(sourceOf(store), PRODUCTION_VERIFY_CONFIG, "nar").proposedBet.trifecta;
    store.close();
    expect(nar.betCount).toBe(1);
    expect(nar.totalReturn).toBe(0);
    expect(nar.unjudgedCount).toBe(0);
  });

  it("地方の分析は、中央のレポートの三連単には入らない(会場の区分)。全体のレポートには入る", () => {
    const store = savedStore([{ umabans: [5, 7, 1], stake: 500, odds: 2600.9 }]);
    const central = computeVerifyReport(sourceOf(store), PRODUCTION_VERIFY_CONFIG, "central").proposedBet.trifecta;
    const all = computeVerifyReport(sourceOf(store), PRODUCTION_VERIFY_CONFIG, "all").proposedBet.trifecta;
    store.close();
    expect(central.betCount).toBe(0);
    expect(all.betCount).toBe(1);
    expect(all.totalReturn).toBe(1_300_450);
  });
});
