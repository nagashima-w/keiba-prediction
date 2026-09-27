/**
 * trifecta-allocation-setting-wiring.test.ts — 設定「三連単を配分に含める」の配管
 * (#25-E3a・Issue #138)を固定するテスト。
 *
 * `exacta-allocation-setting-wiring.test.ts`(馬単版・Issue #124)の**#24-E3a時点版**
 * (`git show 7c70caa:packages/app/test/exacta-allocation-setting-wiring.test.ts`。
 * まだ`resolveMixedBetTypes`へ接続していない時点の版)と同じ構造を踏襲する。
 *
 * Issue #138(#25-E3a)確定スコープ(オーケストレーター着手前ゲート合意 2026-09-27):
 * - `AppSettings.includeTrifectaInAllocation` を新設し、保存・IPC・`MixedAllocationSettings`・
 *   キャッシュキーまで配管する
 * - **候補ビルダー(`resolveMixedBetTypes`)・D-2フォールバック規則(`isComboBetTypesOff`)・
 *   条件③の候補数カウント(`comboCandidateCount`)は変更しない**(三連単の候補を実際に作るのは
 *   #25-E3b〈Issue #139〉の仕事。E3aで変えると配分の答えが変わりうる)
 * - **設定画面(`SettingsView.tsx`)にトグルを出さない**
 * - DB列(`analysis_allocation_meta.include_trifecta`)の追加は#25-E3c(Issue #140)へ送る
 *   (`analysis_allocation_meta`の列一覧は#59で「固定・増減は停止条件」と凍結されており、
 *   読む人が実在するタスクで解除する。馬連〈#115→#118〉・馬単〈#124→#126〉と同じ切り方)
 *
 * ## 「参照していないこと」の確認方法(#117の教訓を先取りする)
 *
 * 馬単の#24-E3a時点(このファイルの元となった版)と同じく、本ファイルは最初からソース走査
 * (`not.toContain`)を経由せず、`buildMixedRaceAllocation`/`buildMixedRaceAllocationWithOutcome`の
 * 値比較(mixed経路・isComboBetTypesOff経路それぞれでtrue/falseがビット一致すること)だけで
 * AC-4(未接続の固定)を保証する。
 *
 * **注意: このファイルは#25-E3b(Issue #139)で反転される見込みである。** #139で
 * `resolveMixedBetTypes`・`isComboBetTypesOff`が実際に`includeTrifectaInAllocation`を
 * 参照するようになったら、本ファイルの「値が変わらないこと」を保証するテストは
 * 「値が変わること」を保証するテストへ書き換える(馬単が#124→#125で辿った反転と同型。
 * `exacta-allocation-setting-wiring.test.ts`冒頭の「旧テスト→新テストの対応表」参照)。
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
 * (mixed-race-allocation-win.test.tsのmixedRace()と同じレシピ。三連単オッズ自体は
 * 未接続のため用意しなくても混在経路に到達できる)。
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
    includeTrifectaInAllocation: true,
    ...overrides,
  };
}

describe("buildMixedRaceAllocation: includeTrifectaInAllocationの値を変えても結果が変わらないこと(#25-E3a。候補ビルダー未接続の直接確認)", () => {
  it("mixed経路(8頭)でincludeTrifectaInAllocationをtrue/falseに変えても、kind・result全体がビット一致すること", () => {
    const race = mixedRace(8);
    const withTrifectaOn = buildMixedRaceAllocation(race, settings({ includeTrifectaInAllocation: true }));
    const withTrifectaOff = buildMixedRaceAllocation(race, settings({ includeTrifectaInAllocation: false }));
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止。unset/yoso等の
    // 早期リターンではincludeTrifectaInAllocationを見る機会自体が無いため、それらでの一致は無意味)。
    expect(withTrifectaOn.kind).toBe("mixed");
    expect(withTrifectaOff.kind).toBe("mixed");
    expect(withTrifectaOff).toEqual(withTrifectaOn);
  });

  it("isComboBetTypesOff配線(D-2フォールバック規則の条件②)経路でincludeTrifectaInAllocationを変えても結果・理由コードが変わらないこと", () => {
    // ワイド・三連複・馬連・馬単の4つを明示的にOFFにし、isComboBetTypesOff(条件②)を真に成立させる
    // (`isComboBetTypesOff`は現状この4項目しか見ない。4つともOFFにしないと、既定ON〈馬連・馬単〉が
    // 残ってcondition②が成立せず、候補0件による条件③〈no-combo-candidates〉に落ちてしまい、
    // 条件②自体を検証できない)。
    const race = raceInput({ rows: allCandidateRows(8) });
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: false,
    });
    const withTrifectaOn = buildMixedRaceAllocationWithOutcome(race, {
      ...base,
      includeTrifectaInAllocation: true,
    });
    const withTrifectaOff = buildMixedRaceAllocationWithOutcome(race, {
      ...base,
      includeTrifectaInAllocation: false,
    });
    // 前提固定: 実際に条件②(combo-bet-types-off)経由でplace-onlyへ落ちていること
    // (includeTrifectaInAllocationの値に関わらず、isComboBetTypesOffがこのフィールドを
    // 参照しない限りfallbackReasonは変わらないはず)。
    expect(withTrifectaOn.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(withTrifectaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(withTrifectaOn.view.kind).toBe("computed");
    expect(withTrifectaOff.view.kind).toBe("computed");
    expect(withTrifectaOff.view).toEqual(withTrifectaOn.view);
  });
});
