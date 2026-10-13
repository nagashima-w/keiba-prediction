import { describe, expect, it } from "vitest";
import type { StoredAllocation, StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";

/**
 * Issue #296: `GET /api/analyses/{id}` の `combos`(組合せの券種ごとの行)。スナップショット(R2 の詳細)と D1 の配分から作る。
 * 詳細が present でないとき・組合せの記録が無いときは null(キーは常にある)。行以外のもの(オッズの写像・診断の中身)は返さない。
 */

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

function result(snapshot: unknown, status: DetailStatus = "present"): AnalysisDetailResult {
  const analysis = {
    id: 7,
    raceId: "202645101012",
    analyzedAt: "2026-10-13T08:00:00.000Z",
    horses: [horse(1), horse(2), horse(3)],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: "20261013",
    model: null,
    rawResponse: null,
    raceSnapshot: snapshot,
    historyCutoffDate: null,
  } as StoredAnalysis;
  return { analysis, detail: status, llmNote: null, llmCalls: null };
}

const ALLOCATION: StoredAllocation = {
  route: "mixed",
  unavailableReason: null,
  fallbackReason: null,
  skipReasonCode: null,
  bankroll: 10000,
  perRaceCap: 300,
  kellyFraction: 0.5,
  evThreshold: 1,
  includeComboOdds: true,
  includeWide: true,
  includeTrio: true,
  includeQuinella: true,
  includeExacta: true,
  includeTrifecta: true,
  includeBracketQuinella: true,
  betUnit: 100,
  oddsStatus: "middle",
  bets: [{ betType: "win", comboKey: "04", stake: 100, odds: 5, ev: 1.2 }],
};

const TRIFECTA_OUTCOME = {
  state: "available",
  diagnostics: { betType: "trifecta", requestCount: 3, expectedComboCount: 6, obtainedComboCount: 6, missingComboCount: 0, axisUmabans: [1, 2, 3], attempts: [{ axis: 1, state: "available", comboCount: 2 }], numericConflictCount: 0, nullWinConflictCount: 0, conflictSamples: [] },
};
const COMBO_SECRET = "COMBO-SECRET-eeee";
const SNAPSHOT = {
  race: { raceName: "川崎テスト" },
  horses: [{ umaban: 1, name: "アルファ" }],
  trifectaCombo: { "010203": 12.3, "010302": 15.5, "020103": 20, "020301": 30, "030102": 40, "030201": 50 },
  comboOdds: { trifecta: TRIFECTA_OUTCOME },
  comboStats: { trifecta: { positive: 2, judged: 6 } },
  secretField: COMBO_SECRET,
};

describe("buildAnalysisView の combos(Issue #296)", () => {
  it("スナップショットと配分から、券種ごとの行を返す(キーは lines だけ。オッズの写像・診断の中身は返さない)", () => {
    const view = buildAnalysisView(result(SNAPSHOT), ALLOCATION);
    expect(view.combos).toEqual({ lines: ["三連単: オッズ 6 点取得・EV プラス 2 点・配分 0 点(他の買い目が優先、または 100 円未満)"] });
    expect(Object.keys(view.combos!)).toEqual(["lines"]);
    expect(JSON.stringify(view)).not.toContain(COMBO_SECRET);
    expect(JSON.stringify(view)).not.toContain("010203");
  });

  it("配分の記録が無くても(undefined)取得の行は出る", () => {
    expect(buildAnalysisView(result(SNAPSHOT), undefined).combos).toEqual({ lines: ["三連単: オッズ 6 点取得"] });
  });

  it("組合せの記録が無い(comboOdds なし・スナップショットなし・不正)は null で、キーは常にある", () => {
    for (const snap of [{ race: {}, horses: [] }, null, "x"]) {
      const view = buildAnalysisView(result(snap), ALLOCATION);
      expect("combos" in view).toBe(true);
      expect(view.combos).toBeNull();
    }
  });

  it("詳細が present でないとき(none・missing)は、スナップショットがあっても使わない(null)", () => {
    for (const status of ["none", "missing"] as const) {
      expect(buildAnalysisView(result(SNAPSHOT, status), ALLOCATION).combos, status).toBeNull();
    }
  });
});
