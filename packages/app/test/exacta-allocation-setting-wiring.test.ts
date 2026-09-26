/**
 * exacta-allocation-setting-wiring.test.ts — 設定「馬単を配分に含める」の配管
 * (#24-E3a・Issue #124)を固定するテスト。
 *
 * Issue #124(#24-E3a)の確定スコープ(オーケストレーター着手前ゲート合意 2026-09-26):
 * - `AppSettings.includeExactaInAllocation` を新設し、保存・IPC・`MixedAllocationSettings`・
 *   キャッシュキーまで配管する
 * - **候補ビルダー(`resolveMixedBetTypes`)・D-2フォールバック規則(`isComboBetTypesOff`)・
 *   条件③の候補数カウント(`comboCandidateCount`)は変更しない**(馬単の候補を実際に作るのは
 *   #24-E3b〈Issue #125〉の仕事。E3aで変えると配分の答えが変わりうる)
 * - **設定画面(`SettingsView.tsx`)にトグルを出さない**
 * - DB列(`analysis_allocation_meta.include_exacta`)の追加は#24-E3c(Issue #126)へ送る
 *   (`analysis_allocation_meta`の列一覧は#59で「固定・増減は停止条件」と凍結されており、
 *   読む人が実在するタスクで解除する。馬連〈#115→#118〉と同じ切り方)
 *
 * ## 「参照していないこと」の確認方法(#117の教訓を先取りする)
 *
 * 馬連の#115時点(D3a)では、この「未接続」を関数本体のソース走査(`not.toContain`)で
 * 固定していたが、Issue #117で「ソース走査の否定をソース走査の肯定に替えるのではなく、
 * 値で結果が実際に変わらないことを観測する形を優先する」という裁定が出た
 * (`quinella-allocation-setting-wiring.test.ts`の経緯コメント参照)。本ファイルは
 * 最初からその教訓を踏まえ、ソース走査を経由せず、`buildMixedRaceAllocation`の
 * 値比較(mixed経路・place-only経路それぞれでtrue/falseがビット一致すること)だけで
 * AC-4(未接続の固定)を保証する。
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

function row(overrides: Partial<AnalysisRow> & { umaban: number }): AnalysisRow {
  return {
    umaban: overrides.umaban,
    wakuban: overrides.wakuban ?? 90,
    horseName: `${overrides.umaban}番`,
    prior: overrides.prior === undefined ? 0.3 : overrides.prior,
    adjustedProb: overrides.adjustedProb ?? 0.5,
    placeOddsMin: overrides.placeOddsMin === undefined ? 3 : overrides.placeOddsMin,
    winOdds: overrides.winOdds === undefined ? 10 : overrides.winOdds,
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

function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function allCandidateRows(n: number): AnalysisRow[] {
  return umabansOf(n).map((umaban) => row({ umaban }));
}

/** items(昇順)から要素数kの組合せをすべて列挙する(テスト専用)。 */
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

/** umabans(昇順)からcomboSizeの組合せをすべて列挙し、一律のオッズ値を割り当てたRecordを作る。 */
function fullOddsRecord(
  umabans: readonly number[],
  comboSize: number,
  odds: number,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildComboOddsKey(combo)] = odds;
  }
  return record;
}

/**
 * n=8頭・ワイド/3連複オッズも用意した「混在経路(kind='mixed')に入る」標準フィクスチャ
 * (mixed-race-allocation-win.test.tsのmixedRace()と同じレシピ)。
 */
function mixedRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullOddsRecord(umabans, 2, 30000),
    trioCombo: fullOddsRecord(umabans, 3, 90000),
  });
}

/** テスト用のMixedAllocationSettingsを組み立てる(既定は混在経路〈kind="mixed"〉に入る値)。 */
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

describe("buildMixedRaceAllocation: includeExactaInAllocationの値を変えても結果が変わらないこと(#24-E3a。候補ビルダー未接続の直接確認)", () => {
  it("mixed経路(8頭)でincludeExactaInAllocationをtrue/falseに変えても、kind・result全体がビット一致すること", () => {
    const race = mixedRace(8);
    const withExactaOn = buildMixedRaceAllocation(race, settings({ includeExactaInAllocation: true }));
    const withExactaOff = buildMixedRaceAllocation(race, settings({ includeExactaInAllocation: false }));
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止。unset/yoso等の
    // 早期リターンではincludeExactaInAllocationを見る機会自体が無いため、それらでの一致は無意味)。
    expect(withExactaOn.kind).toBe("mixed");
    expect(withExactaOff.kind).toBe("mixed");
    expect(withExactaOff).toEqual(withExactaOn);
  });

  it("isComboBetTypesOff配線(D-2フォールバック規則の条件②)経路でincludeExactaInAllocationを変えても結果・理由コードが変わらないこと", () => {
    // ワイド・三連複・馬連の3つを明示的にOFFにし、isComboBetTypesOff(条件②)を真に成立させる
    // (`isComboBetTypesOff`は現状この3項目しか見ない。3つともOFFにしないと、Issue #117以降の
    // 既定ON〈includeQuinellaInAllocation〉が残ってcondition②が成立せず、
    // 候補0件による条件③〈no-combo-candidates〉に落ちてしまい、条件②自体を検証できない)。
    const race = raceInput({ rows: allCandidateRows(8) });
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
    });
    const withExactaOn = buildMixedRaceAllocationWithOutcome(race, {
      ...base,
      includeExactaInAllocation: true,
    });
    const withExactaOff = buildMixedRaceAllocationWithOutcome(race, {
      ...base,
      includeExactaInAllocation: false,
    });
    // 前提固定: 実際に条件②(combo-bet-types-off)経由でplace-onlyへ落ちていること
    // (includeExactaInAllocationの値に関わらず、isComboBetTypesOffがこのフィールドを
    // 参照しない限りfallbackReasonは変わらないはず)。
    expect(withExactaOn.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(withExactaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(withExactaOn.view.kind).toBe("computed");
    expect(withExactaOff.view.kind).toBe("computed");
    expect(withExactaOff.view).toEqual(withExactaOn.view);
  });
});
