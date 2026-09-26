/**
 * mixed-race-allocation-win.test.ts — 単勝(win)を混在配分経路へ通す配線のテスト
 * (Issue #90・#23-B2・AC4)。
 *
 * `shared/mixed-race-allocation.ts` の `resolveMixedBetTypes` が `"win"` を常時積むこと
 * (A-2是正)と、D-7で確定した制限(ワイド・3連複が使えない設定・状況では、win候補が
 * あっても提案されずplace-onlyへ落ちること)を固定する。
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
// テストヘルパー(mixed-allocation-view.test.tsの流儀を踏襲)
// ============================================================================

/** テスト用のAnalysisRowを組み立てる補助関数。 */
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

/** テスト用のMixedCandidateBuildInputを組み立てる補助関数。 */
function raceInput(
  overrides: Partial<MixedCandidateBuildInput> & { rows: readonly AnalysisRow[] },
): MixedCandidateBuildInput {
  return { oddsStatus: "result", ...overrides };
}

/** テスト用のMixedAllocationSettingsを組み立てる補助関数。既定は混在経路に入る値。 */
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

/** n頭ぶんの馬番配列(1..n)。 */
function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** n頭立て・全馬EVプラス(複勝候補になる)行配列を作る(winOddsも既定でEVプラスになる値)。 */
function allCandidateRows(n: number): AnalysisRow[] {
  return umabansOf(n).map((umaban) => row({ umaban }));
}

/** items(昇順)から要素数kの組合せを列挙する(テスト専用)。 */
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

/** umabans(昇順)から comboSize の組合せをすべて列挙し、一律のオッズ値を割り当てたRecordを作る。 */
function fullOddsRecord(umabans: readonly number[], comboSize: number, odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildComboOddsKey(combo)] = odds;
  }
  return record;
}

// n=8頭・winOdds=1000(1着確率が低くてもEVプラスになりやすい)・ワイド/3連複オッズも用意した
// 「混在経路(kind='mixed')に入る」標準フィクスチャ。
function mixedRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullOddsRecord(umabans, 2, 30000),
    trioCombo: fullOddsRecord(umabans, 3, 90000),
  });
}

describe("resolveMixedBetTypes配線(A-2是正・AC4): buildMixedRaceAllocationの戻り値にbetType='win'が現れること", () => {
  it("既定設定(wide/trio対象ON・includeComboOdds ON)でwinの配分行が現れること", () => {
    const view = buildMixedRaceAllocation(mixedRace(8), settings());
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const winAllocations = view.result.allocations.filter((a) => a.betType === "win");
    // 前提固定(空振り防止): win配分行が実際に1件以上存在すること。
    expect(winAllocations.length).toBeGreaterThan(0);
    for (const a of winAllocations) {
      expect(a.umabans).toHaveLength(1);
    }
  });
});

describe("D-7フォールバック規則の制限(現状維持。win候補があってもワイド・3連複が使えないとplace-onlyへ落ち、win候補は丸ごと捨てられる)", () => {
  it("①includeComboOdds=OFF: win候補があってもplace-onlyへ落ち、win行は現れないこと", () => {
    const view = buildMixedRaceAllocation(mixedRace(8), settings({ includeComboOdds: false }));
    // D-2フォールバックにより既存の複勝専用経路(kind='computed'相当)へ落ちる。
    expect(view.kind).not.toBe("mixed");
    expect(view.kind).not.toBe("invalid");
    if ("result" in view && "allocations" in view.result) {
      expect((view.result.allocations as readonly { betType: string }[]).some((a) => a.betType === "win")).toBe(
        false,
      );
    }
  });

  it("②ワイド・3連複・馬連とも配分対象OFF: win候補があってもplace-onlyへ落ち、win行は現れず、fallbackReasonが'combo-bet-types-off'であること(Issue #117で馬連も条件②に加わったため、馬連も明示的にOFFにする。kindだけでは②③の区別がつかないためfallbackReasonまで確認する)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      mixedRace(8),
      settings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
      }),
    );
    expect(outcome.view.kind).not.toBe("mixed");
    expect(outcome.view.kind).not.toBe("invalid");
    expect(outcome.outcome.fallbackReason).toBe("combo-bet-types-off");
  });

  it("②'馬連込み: ワイド・3連複はOFFでも馬連がON・候補ありならcombo-bet-types-offにならずmixedになり、win行も現れること(Issue #117。条件②が馬連ONを見落とさないことの確認)", () => {
    const race: MixedCandidateBuildInput = {
      ...mixedRace(8),
      quinellaCombo: fullOddsRecord(umabansOf(8), 2, 3000),
    };
    const outcome = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ includeWideInAllocation: false, includeTrioInAllocation: false }),
    );
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const winAllocations = outcome.view.result.allocations.filter((a) => a.betType === "win");
    expect(winAllocations.length).toBeGreaterThan(0);
  });

  it("③ワイド・3連複・馬連の候補合計が0件(オッズ未提供): win候補があってもplace-onlyへ落ち、win行は現れず、fallbackReasonが'no-combo-candidates'であること", () => {
    // wideCombo/trioCombo/quinellaComboを一切渡さない(未取得) → 組合せ候補が0件になる。
    const race = raceInput({ rows: allCandidateRows(8) });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.view.kind).not.toBe("mixed");
    expect(outcome.view.kind).not.toBe("invalid");
    expect(outcome.outcome.fallbackReason).toBe("no-combo-candidates");
  });

  it("③'馬連込み: ワイド・3連複の候補は0件でも馬連に候補があればno-combo-candidatesにならずmixedになり、win行も現れること(Issue #117。条件③が馬連の候補を数えることの確認)", () => {
    const race = raceInput({
      rows: allCandidateRows(8),
      quinellaCombo: fullOddsRecord(umabansOf(8), 2, 3000),
    });
    const outcome = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.outcome.route).toBe("mixed");
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const winAllocations = outcome.view.result.allocations.filter((a) => a.betType === "win");
    expect(winAllocations.length).toBeGreaterThan(0);
  });

  it("(対照)①〜③のいずれにも該当しない場合はkind='mixed'になること(D-7が過剰に発動していないことの確認)", () => {
    const view = buildMixedRaceAllocation(mixedRace(8), settings());
    expect(view.kind).toBe("mixed");
  });
});
