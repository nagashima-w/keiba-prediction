/**
 * quinella-allocation-setting-wiring.test.ts — 設定「馬連を配分に含める」の配管
 * (#24-D3a・Issue #115)を固定するテスト。
 *
 * Issue #115の確定スコープ(オーケストレーター裁定 2026-09-24):
 * - `AppSettings.includeQuinellaInAllocation` を新設し、保存・IPC・`MixedAllocationSettings`・
 *   キャッシュキーまで配管する
 * - **候補ビルダー(`resolveMixedBetTypes`)・D-2フォールバック規則(`isComboBetTypesOff`)は
 *   変更しない**(馬連の候補を実際に作るのは#24-D3bの仕事。D3aで変えると配分の答えが変わりうる)
 * - **設定画面(`SettingsView.tsx`)にトグルを出さない**
 * - DB列(`analysis_allocation_meta.include_quinella`)の追加は#24-D3bへ送る
 *   (`analysis_allocation_meta`の列一覧は#59で「固定・増減は停止条件」と凍結されており、
 *   読む人〈#55再表示の「馬連: ON/OFF」〉が実在するタスクで解除する)
 *
 * このファイルは上記のうち「候補ビルダー・フォールバック規則を変えない」「画面に出さない」を
 * ソース走査で構造的に固定し(`combo-odds-scope-guard.test.ts`と同じ流儀)、
 * 「MixedAllocationSettingsに新フィールドを持たせても混在配分の計算結果が変わらない」ことを
 * 振る舞いレベルでも固定する(AC-4の単体テスト版。感度表全体のビット一致は
 * `scripts/bench-mixed-allocation.ts`で別途確認する)。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildComboOddsKey } from "@keiba/core/ev/combo-bet-allocation";

import type { AnalysisRow } from "../src/shared/analysis-types.js";
import type { MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sharedDir = path.join(currentDir, "../src/shared");
const rendererDir = path.join(currentDir, "../src/renderer");

/** ソースから`function name(...) { ... }`本体を抽出する(単純な波括弧対応。テスト専用)。 */
function extractFunctionBody(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`関数が見つからない: ${name}`);
  }
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }
  throw new Error(`関数本体の終端が見つからない: ${name}`);
}

describe("地雷(3): 候補ビルダー・D-2フォールバック規則がincludeQuinellaInAllocationを参照していないこと(#24-D3a)", () => {
  const source = readFileSync(path.join(sharedDir, "mixed-race-allocation.ts"), "utf8");

  it("resolveMixedBetTypes(候補構築のbetTypes組み立て)がincludeQuinellaInAllocationを参照していないこと", () => {
    const body = extractFunctionBody(source, "resolveMixedBetTypes");
    // 前提固定: 既存の2券種は変わらず参照していること(空振り防止)。
    expect(body).toContain("includeWideInAllocation");
    expect(body).toContain("includeTrioInAllocation");
    expect(body).not.toContain("includeQuinellaInAllocation");
  });

  it("isComboBetTypesOff(D-2フォールバック規則の条件②)がincludeQuinellaInAllocationを参照していないこと", () => {
    const body = extractFunctionBody(source, "isComboBetTypesOff");
    expect(body).toContain("includeWideInAllocation");
    expect(body).toContain("includeTrioInAllocation");
    expect(body).not.toContain("includeQuinellaInAllocation");
  });
});

describe("AC-5: SettingsView.tsxがincludeQuinellaInAllocationを一切参照していないこと(#24-D3a。画面にまだ出さない)", () => {
  it("SettingsView.tsxのソースにincludeQuinellaInAllocationという識別子が出現しないこと", () => {
    const source = readFileSync(path.join(rendererDir, "SettingsView.tsx"), "utf8");
    // 前提固定: 既存2券種のチェックボックスは実在すること(空振り防止。ファイルを正しく読めていることの確認)。
    expect(source).toContain("includeWideInAllocation");
    expect(source).toContain("includeTrioInAllocation");
    expect(source).not.toContain("includeQuinellaInAllocation");
  });
});

// ============================================================================
// 振る舞いレベル: MixedAllocationSettingsにincludeQuinellaInAllocationを持たせても
// 混在配分の計算結果が一切変わらないこと(AC-4の単体テスト版)
// ============================================================================

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
    ...overrides,
  };
}

describe("buildMixedRaceAllocation: includeQuinellaInAllocationの値を変えても結果が変わらないこと(#24-D3a。候補ビルダー未接続の直接確認)", () => {
  it("mixed経路(8頭)でincludeQuinellaInAllocationをtrue/falseに変えても、kind・result全体がビット一致すること", () => {
    const race = mixedRace(8);
    const withQuinellaOn = buildMixedRaceAllocation(race, settings({ includeQuinellaInAllocation: true }));
    const withQuinellaOff = buildMixedRaceAllocation(race, settings({ includeQuinellaInAllocation: false }));
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止。unset/yoso等の
    // 早期リターンではincludeQuinellaInAllocationを見る機会自体が無いため、それらでの一致は無意味)。
    expect(withQuinellaOn.kind).toBe("mixed");
    expect(withQuinellaOff.kind).toBe("mixed");
    expect(withQuinellaOff).toEqual(withQuinellaOn);
  });

  it("place-only経路(D-2フォールバック該当・includeWide/Trio双方OFF)でincludeQuinellaInAllocationを変えても結果が変わらないこと", () => {
    const race = raceInput({ rows: allCandidateRows(8) });
    const base = settings({ includeWideInAllocation: false, includeTrioInAllocation: false });
    const withQuinellaOn = buildMixedRaceAllocation(race, { ...base, includeQuinellaInAllocation: true });
    const withQuinellaOff = buildMixedRaceAllocation(race, { ...base, includeQuinellaInAllocation: false });
    // 前提固定: 実際にD-2フォールバック経路(複勝専用。kind="computed")に到達していること。
    expect(withQuinellaOn.kind).toBe("computed");
    expect(withQuinellaOff.kind).toBe("computed");
    expect(withQuinellaOff).toEqual(withQuinellaOn);
  });
});
