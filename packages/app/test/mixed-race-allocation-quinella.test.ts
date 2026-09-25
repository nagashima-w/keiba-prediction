/**
 * mixed-race-allocation-quinella.test.ts — 馬連(quinella)を配分の券種選択・D-2フォールバック規則
 * (`shared/mixed-race-allocation.ts`)へ接続する配線のテスト(Issue #117・#24-D3b-2)。
 *
 * `mixed-race-allocation-win.test.ts`(win版)と同じ構造を踏襲する。
 *
 * ## 経緯(#115→#117)
 * #115(#24-D3a)では`includeQuinellaInAllocation`という設定項目だけを配管し、
 * `resolveMixedBetTypes`・`isComboBetTypesOff`・`comboCandidateCount`のいずれも
 * この設定を参照しない状態を意図的に保っていた(`quinella-allocation-setting-wiring.test.ts`が
 * 当時この「未接続」を固定していた)。本ファイルは#117でその接続を行ったことを、
 * 実際の計算結果(betType='quinella'の出現・fallbackReasonの値)で直接固定する。
 */

import { describe, expect, it } from "vitest";

import { buildComboOddsKey } from "@keiba/core/ev/combo-bet-allocation";

import type { AnalysisRow } from "../src/shared/analysis-types.js";
import type { MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

// ============================================================================
// テストヘルパー(mixed-race-allocation-win.test.tsの流儀を踏襲)
// ============================================================================

function row(overrides: Partial<AnalysisRow> & { umaban: number }): AnalysisRow {
  return {
    umaban: overrides.umaban,
    wakuban: overrides.wakuban ?? 90,
    horseName: `${overrides.umaban}番`,
    prior: overrides.prior === undefined ? 0.3 : overrides.prior,
    adjustedProb: overrides.adjustedProb ?? 0.5,
    placeOddsMin: overrides.placeOddsMin === undefined ? 3 : overrides.placeOddsMin,
    winOdds: overrides.winOdds === undefined ? 1000 : overrides.winOdds,
    ev: overrides.ev === undefined ? 1.5 : overrides.ev,
    isPositive: overrides.isPositive ?? true,
    reason: null,
    careerRunCount: overrides.careerRunCount === undefined ? 999 : overrides.careerRunCount,
    mark: null,
    evEstimated: overrides.evEstimated ?? false,
    conditionChangeTags: [],
  };
}

function raceInput(
  overrides: Partial<MixedCandidateBuildInput> & { rows: readonly AnalysisRow[] },
): MixedCandidateBuildInput {
  return { oddsStatus: "result", ...overrides };
}

function settings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    ...overrides,
  };
}

function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function allCandidateRows(n: number): AnalysisRow[] {
  return umabansOf(n).map((umaban) => row({ umaban }));
}

function combinations<T>(items: readonly T[], k: number): T[][] {
  const results: T[][] = [];
  if (k <= 0 || k > items.length) {
    return results;
  }
  const current: T[] = [];
  const backtrack = (start: number): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      backtrack(i + 1);
      current.pop();
    }
  };
  backtrack(0);
  return results;
}

function fullOddsRecord(umabans: readonly number[], comboSize: number, odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildComboOddsKey(combo)] = odds;
  }
  return record;
}

/** n=8頭・馬連オッズのみを用意した(ワイド・3連複オッズは無い)フィクスチャ。 */
function quinellaOnlyRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    quinellaCombo: fullOddsRecord(umabans, 2, 3000),
  });
}

/** n=8頭・ワイド・3連複・馬連すべてのオッズを用意した「混在経路に入る」標準フィクスチャ。 */
function fullComboRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullOddsRecord(umabans, 2, 30000),
    trioCombo: fullOddsRecord(umabans, 3, 90000),
    quinellaCombo: fullOddsRecord(umabans, 2, 3000),
  });
}

// ============================================================================
// AC-1: resolveMixedBetTypesがincludeQuinellaInAllocationを参照し、betType='quinella'を
// 混在配分の結果に実際に含めること
// ============================================================================

describe("resolveMixedBetTypes配線(AC-1・Issue #117): includeQuinellaInAllocationの値で結果が実際に変わること", () => {
  it("includeQuinellaInAllocation=true・馬連オッズありなら、betType='quinella'の配分行が現れること", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeQuinellaInAllocation: true }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const quinellaAllocations = view.result.allocations.filter((a) => a.betType === "quinella");
    // 前提固定(空振り防止): 馬連配分行が実際に1件以上存在すること。
    expect(quinellaAllocations.length).toBeGreaterThan(0);
    for (const a of quinellaAllocations) {
      expect(a.umabans).toHaveLength(2);
    }
  });

  it("includeQuinellaInAllocation=false・馬連オッズありでも、betType='quinella'の配分行が一切現れないこと", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeQuinellaInAllocation: false }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const quinellaAllocations = view.result.allocations.filter((a) => a.betType === "quinella");
    expect(quinellaAllocations).toEqual([]);
    // diagnostics側もnot-requestedになること(候補ビルダー自体が呼ばれていないことの確認)。
    expect(view.diagnostics.quinella.kind).toBe("not-requested");
  });

  it("includeQuinellaInAllocation=true・馬連オッズありなら、diagnostics.quinellaがkind='built'になること", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeQuinellaInAllocation: true }));
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.diagnostics.quinella.kind).toBe("built");
  });
});

// ============================================================================
// AC-2: D-2フォールバック規則(条件②・条件③)が馬連を数えること
// ============================================================================

describe("D-2フォールバック規則(AC-2・Issue #117): 条件②・条件③が馬連を数えること", () => {
  it("ワイド・3連複OFF + 馬連ON + 馬連候補あり → mixed(place-onlyに落ちないこと。条件②が馬連ONを見落とさない)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      quinellaOnlyRace(8),
      settings({ includeWideInAllocation: false, includeTrioInAllocation: false, includeQuinellaInAllocation: true }),
    );
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const quinellaAllocations = outcome.view.result.allocations.filter((a) => a.betType === "quinella");
    // 前提固定(空振り防止): 実際に馬連候補が配分に採用されていること。
    expect(quinellaAllocations.length).toBeGreaterThan(0);
  });

  it("ワイド・3連複・馬連すべてOFF → 条件②(combo-bet-types-off)でplace-onlyへ落ちること", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      fullComboRace(8),
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
      }),
    );
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(outcome.view.kind).not.toBe("mixed");
  });

  it("ワイド・3連複の候補合計が0件だが馬連候補があるとき → mixed(条件③が馬連の候補を数える)", () => {
    // wideCombo/trioComboを一切渡さない(未取得=候補0件)。quinellaComboのみ用意する。
    const race = raceInput({ rows: allCandidateRows(8), quinellaCombo: fullOddsRecord(umabansOf(8), 2, 3000) });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const quinellaAllocations = outcome.view.result.allocations.filter((a) => a.betType === "quinella");
    expect(quinellaAllocations.length).toBeGreaterThan(0);
  });

  it("ワイド・3連複・馬連いずれも候補0件(オッズ未提供) → 条件③(no-combo-candidates)でplace-onlyへ落ちること", () => {
    const race = raceInput({ rows: allCandidateRows(8) });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("no-combo-candidates");
    expect(outcome.view.kind).not.toBe("mixed");
  });

  it("(対照)ワイド・3連複・馬連すべて候補ありなら通常どおりmixedになること(過剰なガードが発動していないことの確認)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(fullComboRace(8), settings());
    expect(outcome.outcome.route).toBe("mixed");
  });
});
