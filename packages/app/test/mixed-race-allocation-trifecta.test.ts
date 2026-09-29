/**
 * mixed-race-allocation-trifecta.test.ts — 三連単(trifecta)を配分の券種選択・D-2フォールバック
 * 規則(`shared/mixed-race-allocation.ts`)へ接続する配線のテスト(Issue #139・#25-E3b)。
 *
 * `mixed-race-allocation-exacta.test.ts`(馬単版・Issue #125)と同じ構造を踏襲する。
 *
 * ## 経緯(#138→#139)
 * #138(#25-E3a)では`includeTrifectaInAllocation`という設定項目だけを配管し、
 * `resolveMixedBetTypes`・`isComboBetTypesOff`・`comboCandidateCount`のいずれも
 * この設定を参照しない状態を意図的に保っていた(`trifecta-allocation-setting-wiring.test.ts`が
 * 当時この「未接続」を固定していた)。本ファイルは#139でその接続を行ったことを、
 * 実際の計算結果(betType='trifecta'の出現・fallbackReasonの値)で直接固定する。
 *
 * ## 三連単特有の追加確認(exacta版との相違点)
 * 三連単は着順(1着・2着・3着)が意味を持つ券種であり、`umabans`の並びはそのまま保持される
 * (昇順ではない。`buildTrifectaCandidates`のJSDoc参照)。本ファイルは接続の配線だけでなく、
 * 混在配分の結果に現れる三連単候補の`umabans`が並びを保持していることも確認する
 * (AC3〈保存キー〉の手前、候補構築の時点での確認)。
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
// テストヘルパー(mixed-race-allocation-exacta.test.tsの流儀を踏襲)
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
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function allCandidateRows(n: number): AnalysisRow[] {
  return umabansOf(n).map((umaban) => row({ umaban }));
}

/** items(昇順)から要素数kの組合せ(順不同)をすべて列挙する(テスト専用)。 */
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

/** items(昇順)から要素数kの順列(並びが異なれば別要素)をすべて列挙する(テスト専用)。 */
function permutations<T>(items: readonly T[], k: number): T[][] {
  const results: T[][] = [];
  const used = new Array(items.length).fill(false);
  const current: T[] = [];
  const backtrack = (): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(items[i]!);
      backtrack();
      current.pop();
      used[i] = false;
    }
  };
  backtrack();
  return results;
}

/**
 * n頭(昇順)から順序付きの全3つ組(a,b,cすべて異なる)を列挙し、一律のオッズ値を割り当てた
 * Recordを作る(三連単専用。Issue #139)。`buildAllocationBetComboKey("trifecta", triple)`
 * (唯一のゲートウェイ)でキー化するため、キー生成ロジック自体は複製しない。
 */
function fullOrderedTriplesOddsRecord(umabans: readonly number[], odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const triple of permutations(umabans, 3)) {
    record[buildAllocationBetComboKey("trifecta", triple)] = odds;
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

function fullOrderedPairsOddsRecord(umabans: readonly number[], odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const pair of combinations(umabans, 2)) {
    const [a, b] = pair as [number, number];
    record[buildAllocationBetComboKey("exacta", [a, b])] = odds;
    record[buildAllocationBetComboKey("exacta", [b, a])] = odds;
  }
  return record;
}

/** n=8頭・三連単オッズのみを用意した(ワイド・3連複・馬連・馬単オッズは無い)フィクスチャ。 */
function trifectaOnlyRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    trifectaCombo: fullOrderedTriplesOddsRecord(umabans, 3000),
  });
}

/** n=8頭・ワイド・3連複・馬連・馬単・三連単すべてのオッズを用意した「混在経路に入る」標準フィクスチャ。 */
function fullComboRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullUnorderedOddsRecord(umabans, 2, 30000),
    trioCombo: fullUnorderedOddsRecord(umabans, 3, 90000),
    quinellaCombo: fullUnorderedOddsRecord(umabans, 2, 3000),
    exactaCombo: fullOrderedPairsOddsRecord(umabans, 3000),
    trifectaCombo: fullOrderedTriplesOddsRecord(umabans, 3000),
  });
}

// ============================================================================
// AC1: resolveMixedBetTypesがincludeTrifectaInAllocationを参照し、betType='trifecta'を
// 混在配分の結果に実際に含めること
// ============================================================================

describe("resolveMixedBetTypes配線(AC1・Issue #139): includeTrifectaInAllocationの値で結果が実際に変わること", () => {
  it("includeTrifectaInAllocation=true・三連単オッズありなら、betType='trifecta'の配分行が現れること", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeTrifectaInAllocation: true }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const trifectaAllocations = view.result.allocations.filter((a) => a.betType === "trifecta");
    // 前提固定(空振り防止): 三連単配分行が実際に1件以上存在すること。
    expect(trifectaAllocations.length).toBeGreaterThan(0);
    for (const a of trifectaAllocations) {
      expect(a.umabans).toHaveLength(3);
    }
  });

  it("includeTrifectaInAllocation=false・三連単オッズありでも、betType='trifecta'の配分行が一切現れないこと", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeTrifectaInAllocation: false }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const trifectaAllocations = view.result.allocations.filter((a) => a.betType === "trifecta");
    expect(trifectaAllocations).toEqual([]);
    // diagnostics側もnot-requestedになること(候補ビルダー自体が呼ばれていないことの確認)。
    expect(view.diagnostics.trifecta.kind).toBe("not-requested");
  });

  it("includeTrifectaInAllocation=true・三連単オッズありなら、diagnostics.trifectaがkind='built'になること", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeTrifectaInAllocation: true }));
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.diagnostics.trifecta.kind).toBe("built");
  });

  it("三連単配分行のumabansは着順の並びを保持し、昇順に並べ替えられないこと(並びが昇順でない候補が実際に存在すること)", () => {
    const view = buildMixedRaceAllocation(fullComboRace(8), settings({ includeTrifectaInAllocation: true }));
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const trifectaAllocations = view.result.allocations.filter((a) => a.betType === "trifecta");
    // 前提固定(空振り防止): 昇順でない([umabans[0], umabans[1], umabans[2]]が昇順ではない)
    // 三連単配分行が実際に存在すること。全件が偶然昇順だと本itの主張(並べ替えない)を検出できない。
    const hasNonAscendingTriple = trifectaAllocations.some(
      (a) => !(a.umabans[0]! < a.umabans[1]! && a.umabans[1]! < a.umabans[2]!),
    );
    expect(hasNonAscendingTriple).toBe(true);
  });
});

// ============================================================================
// AC2: D-2フォールバック規則(条件②・条件③)が三連単を数えること
// ============================================================================

describe("D-2フォールバック規則(AC2・Issue #139): 条件②・条件③が三連単を数えること", () => {
  it("ワイド・3連複・馬連・馬単OFF + 三連単ON + 三連単候補あり → mixed(place-onlyに落ちないこと。条件②が三連単ONを見落とさない)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      trifectaOnlyRace(8),
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: false,
        includeTrifectaInAllocation: true,
        includeBracketQuinellaInAllocation: false,
      }),
    );
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const trifectaAllocations = outcome.view.result.allocations.filter((a) => a.betType === "trifecta");
    // 前提固定(空振り防止): 実際に三連単候補が配分に採用されていること。
    expect(trifectaAllocations.length).toBeGreaterThan(0);
  });

  it("ワイド・3連複・馬連・馬単・三連単すべてOFF → 条件②(combo-bet-types-off)でplace-onlyへ落ちること", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      fullComboRace(8),
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: false,
        includeTrifectaInAllocation: false,
        includeBracketQuinellaInAllocation: false,
      }),
    );
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(outcome.view.kind).not.toBe("mixed");
  });

  it("ワイド・3連複・馬連・馬単OFF + 三連単ON だが三連単オッズ自体が無い(候補0件) → 条件②は成立せず条件③(no-combo-candidates)でplace-onlyへ落ちること(5項目のうち1つでもONだと条件②は成立しない)", () => {
    // wideCombo/trioCombo/quinellaCombo/exactaCombo/trifectaComboをいずれも渡さない(候補0件)。
    // includeTrifectaInAllocation=trueにしてもオッズが無いため三連単候補も0件になり、
    // isComboBetTypesOff(条件②)はtrifectaがtrueのため成立せず、条件③側に落ちることを確認する。
    const race = raceInput({ rows: allCandidateRows(8) });
    const outcome = buildMixedRaceAllocationWithOutcome(
      race,
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: false,
        includeTrifectaInAllocation: true,
        includeBracketQuinellaInAllocation: false,
      }),
    );
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("no-combo-candidates");
  });

  it("ワイド・3連複・馬連・馬単の候補合計が0件だが三連単候補があるとき → mixed(条件③が三連単の候補を数える)", () => {
    // wideCombo/trioCombo/quinellaCombo/exactaComboを一切渡さない(未取得=候補0件)。trifectaComboのみ用意する。
    const race = raceInput({
      rows: allCandidateRows(8),
      trifectaCombo: fullOrderedTriplesOddsRecord(umabansOf(8), 3000),
    });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const trifectaAllocations = outcome.view.result.allocations.filter((a) => a.betType === "trifecta");
    expect(trifectaAllocations.length).toBeGreaterThan(0);
  });

  it("ワイド・3連複・馬連・馬単・三連単いずれも候補0件(オッズ未提供) → 条件③(no-combo-candidates)でplace-onlyへ落ちること", () => {
    const race = raceInput({ rows: allCandidateRows(8) });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("no-combo-candidates");
    expect(outcome.view.kind).not.toBe("mixed");
  });

  it("(対照)ワイド・3連複・馬連・馬単・三連単すべて候補ありなら通常どおりmixedになること(過剰なガードが発動していないことの確認)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(fullComboRace(8), settings());
    expect(outcome.outcome.route).toBe("mixed");
  });
});
