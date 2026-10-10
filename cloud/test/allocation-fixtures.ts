import type { AnalysisAllocationMetaRecord, AnalysisAllocationRecord, AnalysisBetRecord } from "../../packages/core/src/ev/analysis-store-types";

/** Issue #230: 配分の記録(保存する `AnalysisRecord.allocation`)のテスト用の組み立て。既定は「複勝・組合せが混在して配分できた」状態(route=mixed・見送りなし)。 */
export function allocationMeta(over: Partial<AnalysisAllocationMetaRecord> = {}): AnalysisAllocationMetaRecord {
  return {
    route: "mixed",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    comboOddsWide: null,
    comboOddsTrio: null,
    bankroll: 10000,
    perRaceCap: 3000,
    kellyFraction: 0.25,
    evThreshold: 1,
    includeComboOdds: true,
    includeWide: true,
    includeTrio: true,
    includeQuinella: true,
    includeExacta: true,
    includeTrifecta: true,
    includeBracketQuinella: true,
    betUnit: 100,
    greedySteps: 20,
    candidateCap: 100,
    modelId: null,
    modelApproximate: null,
    oddsStatus: "result",
    ...over,
  };
}

export function betRecord(betType: string, comboKey: string, stake: number, over: Partial<AnalysisBetRecord> = {}): AnalysisBetRecord {
  return { betType, comboKey, stake, odds: 3.5, ev: 1.2, ...over };
}

export function allocationRecord(metaOver: Partial<AnalysisAllocationMetaRecord> = {}, bets: readonly AnalysisBetRecord[] = []): AnalysisAllocationRecord {
  return { meta: allocationMeta(metaOver), bets };
}
