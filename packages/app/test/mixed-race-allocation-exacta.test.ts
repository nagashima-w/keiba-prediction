/**
 * mixed-race-allocation-exacta.test.ts — 馬単(exacta)を配分の券種選択・D-2フォールバック規則
 * (`shared/mixed-race-allocation.ts`)へ接続する配線のテスト(Issue #125・#24-E3b)。
 *
 * `mixed-race-allocation-quinella.test.ts`(馬連版・Issue #117)と同じ構造を踏襲する。
 *
 * ## 経緯(#124→#125)
 * #124(#24-E3a)では`includeExactaInAllocation`という設定項目だけを配管し、
 * `resolveMixedBetTypes`・`isComboBetTypesOff`・`comboCandidateCount`のいずれも
 * この設定を参照しない状態を意図的に保っていた(`exacta-allocation-setting-wiring.test.ts`が
 * 当時この「未接続」を固定していた)。本ファイルは#125でその接続を行ったことを、
 * 実際の計算結果(betType='exacta'の出現・fallbackReasonの値)で直接固定する。
 *
 * ## 馬単特有の追加確認(quinella版との相違点)
 * 馬単は着順が意味を持つ券種であり、`umabans`の並びは[1着,2着]をそのまま保持する
 * (昇順ではない。`buildExactaCandidates`のJSDoc参照)。本ファイルは接続の配線だけでなく、
 * 混在配分の結果に現れる馬単候補の`umabans`が並びを保持していることも確認する
 * (AC-5〈保存キー〉の手前、候補構築の時点での確認)。
 */

import { describe, expect, it } from "vitest";

import { buildAllocationBetComboKey } from "@keiba/core/ev/combo-bet-allocation";

import type { AnalysisRow } from "../src/shared/analysis-types.js";
import type { MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

// ============================================================================
// テストヘルパー(mixed-race-allocation-quinella.test.tsの流儀を踏襲)
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
    includeExactaInAllocation: true,
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

/**
 * n頭(昇順)から順序付きの全ペア(a≠b)を列挙し、一律のオッズ値を割り当てたRecordを作る
 * (core `orderedPairsOfUmabans`〈非export〉と同じ列挙をテスト側で独立に再現する。
 * `buildAllocationBetComboKey("exacta", pair)`〈本タスクでcoreに追加した唯一のゲートウェイ〉で
 * キー化するため、キー生成ロジック自体は複製しない)。
 */
function fullOrderedOddsRecord(umabans: readonly number[], odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const pair of combinations(umabans, 2)) {
    const [a, b] = pair as [number, number];
    record[buildAllocationBetComboKey("exacta", [a, b])] = odds;
    record[buildAllocationBetComboKey("exacta", [b, a])] = odds;
  }
  return record;
}

function fullUnorderedOddsRecord(umabans: readonly number[], comboSize: number, odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildAllocationBetComboKey("wide", combo)] = odds;
  }
  return record;
}

/** n=8頭・馬単オッズのみを用意した(ワイド・3連複・馬連オッズは無い)フィクスチャ。 */
function exactaOnlyRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    exactaCombo: fullOrderedOddsRecord(umabans, 3000),
  });
}

/** n=8頭・ワイド・3連複・馬連・馬単すべてのオッズを用意した「混在経路に入る」標準フィクスチャ。 */
function fullComboRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullUnorderedOddsRecord(umabans, 2, 30000),
    trioCombo: fullUnorderedOddsRecord(umabans, 3, 90000),
    quinellaCombo: fullUnorderedOddsRecord(umabans, 2, 3000),
    exactaCombo: fullOrderedOddsRecord(umabans, 3000),
  });
}

// ============================================================================
// AC-1: resolveMixedBetTypesがincludeExactaInAllocationを参照し、betType='exacta'を
// 混在配分の結果に実際に含めること
// ============================================================================

describe("resolveMixedBetTypes配線(AC-1・Issue #125): includeExactaInAllocationの値で結果が実際に変わること", () => {
  it("includeExactaInAllocation=true・馬単オッズありなら、betType='exacta'の配分行が現れること", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeExactaInAllocation: true }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const exactaAllocations = view.result.allocations.filter((a) => a.betType === "exacta");
    // 前提固定(空振り防止): 馬単配分行が実際に1件以上存在すること。
    expect(exactaAllocations.length).toBeGreaterThan(0);
    for (const a of exactaAllocations) {
      expect(a.umabans).toHaveLength(2);
    }
  });

  it("includeExactaInAllocation=false・馬単オッズありでも、betType='exacta'の配分行が一切現れないこと", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeExactaInAllocation: false }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const exactaAllocations = view.result.allocations.filter((a) => a.betType === "exacta");
    expect(exactaAllocations).toEqual([]);
    // diagnostics側もnot-requestedになること(候補ビルダー自体が呼ばれていないことの確認)。
    expect(view.diagnostics.exacta.kind).toBe("not-requested");
  });

  it("includeExactaInAllocation=true・馬単オッズありなら、diagnostics.exactaがkind='built'になること", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeExactaInAllocation: true }));
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.diagnostics.exacta.kind).toBe("built");
  });

  it("馬単配分行のumabansは着順の並びを保持し、昇順に並べ替えられないこと(逆順の2組が両方候補になりうる。#123ゲートコメントが殺す変異そのもの)", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeExactaInAllocation: true }));
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const exactaAllocations = view.result.allocations.filter((a) => a.betType === "exacta");
    // 前提固定(空振り防止): 昇順でない([umabans[0] > umabans[1]]の)馬単配分行が
    // 実際に存在すること。全件が偶然昇順だと本itの主張(並べ替えない)を検出できない。
    const hasDescendingPair = exactaAllocations.some((a) => a.umabans[0]! > a.umabans[1]!);
    expect(hasDescendingPair).toBe(true);
  });
});

// ============================================================================
// AC-2: D-2フォールバック規則(条件②・条件③)が馬単を数えること
// ============================================================================

describe("D-2フォールバック規則(AC-2・Issue #125): 条件②・条件③が馬単を数えること", () => {
  it("ワイド・3連複・馬連OFF + 馬単ON + 馬単候補あり → mixed(place-onlyに落ちないこと。条件②が馬単ONを見落とさない)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      exactaOnlyRace(8),
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: true,
      }),
    );
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const exactaAllocations = outcome.view.result.allocations.filter((a) => a.betType === "exacta");
    // 前提固定(空振り防止): 実際に馬単候補が配分に採用されていること。
    expect(exactaAllocations.length).toBeGreaterThan(0);
  });

  it("ワイド・3連複・馬連・馬単すべてOFF → 条件②(combo-bet-types-off)でplace-onlyへ落ちること", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      fullComboRace(8),
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: false,
      }),
    );
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(outcome.view.kind).not.toBe("mixed");
  });

  it("ワイド・3連複・馬連OFF + 馬単ON だが馬単オッズ自体が無い(候補0件) → 条件②は成立せず条件③(no-combo-candidates)でplace-onlyへ落ちること(#124で見つかった罠: 4項目のうち1つでもONだと条件②は成立しない)", () => {
    // wideCombo/trioCombo/quinellaCombo/exactaComboをいずれも渡さない(候補0件)。
    // includeExactaInAllocation=trueにしてもオッズが無いため馬単候補も0件になり、
    // isComboBetTypesOff(条件②)はexactaがtrueのため成立せず、条件③側に落ちることを確認する。
    const race = raceInput({ rows: allCandidateRows(8) });
    const outcome = buildMixedRaceAllocationWithOutcome(
      race,
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: true,
      }),
    );
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("no-combo-candidates");
  });

  it("ワイド・3連複・馬連の候補合計が0件だが馬単候補があるとき → mixed(条件③が馬単の候補を数える)", () => {
    // wideCombo/trioCombo/quinellaComboを一切渡さない(未取得=候補0件)。exactaComboのみ用意する。
    const race = raceInput({ rows: allCandidateRows(8), exactaCombo: fullOrderedOddsRecord(umabansOf(8), 3000) });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const exactaAllocations = outcome.view.result.allocations.filter((a) => a.betType === "exacta");
    expect(exactaAllocations.length).toBeGreaterThan(0);
  });

  it("ワイド・3連複・馬連・馬単いずれも候補0件(オッズ未提供) → 条件③(no-combo-candidates)でplace-onlyへ落ちること", () => {
    const race = raceInput({ rows: allCandidateRows(8) });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("no-combo-candidates");
    expect(outcome.view.kind).not.toBe("mixed");
  });

  it("(対照)ワイド・3連複・馬連・馬単すべて候補ありなら通常どおりmixedになること(過剰なガードが発動していないことの確認)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(fullComboRace(8), settings());
    expect(outcome.outcome.route).toBe("mixed");
  });
});
