/**
 * exacta-allocation-setting-wiring.test.ts — 設定「馬単を配分に含める」の配管
 * (#24-E3a・Issue #124 → #24-E3b・Issue #125)を固定するテスト。
 *
 * `quinella-allocation-setting-wiring.test.ts`(馬連版・Issue #115→#117)と同じ構造を踏襲する。
 *
 * ## 経緯
 * Issue #124(#24-E3a)確定スコープ時点では:
 * - `AppSettings.includeExactaInAllocation` を新設し、保存・IPC・`MixedAllocationSettings`・
 *   キャッシュキーまで配管する
 * - **候補ビルダー(`resolveMixedBetTypes`)・D-2フォールバック規則(`isComboBetTypesOff`)・
 *   条件③の候補数カウント(`comboCandidateCount`)は変更しない**(馬単の候補を実際に作るのは
 *   #24-E3b〈Issue #125〉の仕事。E3aで変えると配分の答えが変わりうる)
 * - **設定画面(`SettingsView.tsx`)にトグルを出さない**
 * - DB列(`analysis_allocation_meta.include_exacta`)の追加は#24-E3c(Issue #126)へ送る
 *
 * このファイルは当時、上記2点(未接続・未表示)を「値の一致(toEqual)」の振る舞いテストと
 * 「参照していないこと」のソース走査を経由しない値比較で固定していた(#117の教訓を先取りし、
 * 最初からソース走査の否定は使っていない)。
 *
 * **Issue #125(#24-E3b)でこの2点をどちらも接続した**(#117と同じ裁定「値で接続を観測する形を
 * 優先する」)。本ファイルはその接続を「値」で固定する形に反転する。より詳細な配線の行列
 * (D-2フォールバック条件②③それぞれの分岐)は`mixed-race-allocation-exacta.test.ts`に
 * 分離した(`mixed-race-allocation-quinella.test.ts`と同じ構造)。本ファイルは
 * 「#124で配管した設定項目が、#125で実際に接続されたこと」を確認する最小限の回帰に絞る。
 *
 * ## 旧テスト→新テストの対応表(何を保証していたか)
 *
 * | 旧テスト(#124時点) | 何を保証していたか | 新テスト(#125) | 何を保証するか |
 * |---|---|---|---|
 * | 「mixed経路(8頭)でincludeExactaInAllocationをtrue/falseに変えても、kind・result全体がビット一致すること」 | 値を変えても計算結果が一切変わらない(未接続の証明) | 「resolveMixedBetTypes配線: includeExactaInAllocationの値でbetType='exacta'の有無が変わること」(値) | true/falseを実際に渡し、betType='exacta'の配分行の有無が切り替わること(接続されたことを値で確認) |
 * | 「isComboBetTypesOff配線(D-2フォールバック規則の条件②)経路でincludeExactaInAllocationを変えても結果・理由コードが変わらないこと」 | 条件②の判定式がincludeExactaInAllocationを参照しない(値を変えても`fallbackReason`が一切変わらない) | 「isComboBetTypesOff配線: includeExactaInAllocationの値でfallbackReasonが変わること」(値) | ワイド・3連複・馬連OFFのまま馬単だけtrue/falseを切り替えると、fallbackReasonが'combo-bet-types-off'かどうかが切り替わること |
 * | (#124時点に無し。SettingsView.tsxのソース走査は元々このファイルの対象外) | — | 「SettingsView.tsxがincludeExactaInAllocationを参照すること」(ソース走査の肯定) | #125でチェックボックスを追加したため、識別子が実在すること(JSX直書きでレンダリングテスト基盤が無いため、この項目のみソース走査で確認する。`quinella-allocation-setting-wiring.test.ts`・`combo-odds-scope-guard.test.ts`と同じ流儀) |
 *
 * 設定の保存・読込・キャッシュキー等(#124で配管した「参照していないこと」以外の部分)を
 * 固定する往復テストは本ファイルには元々存在しない(`settings-reducer.test.ts`・
 * `settings-store.test.ts`・`ipc-*-wiring.test.ts`が担う。それらは本タスクでは変更しない)。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildAllocationBetComboKey } from "@keiba/core/ev/combo-bet-allocation";

import type { AnalysisRow } from "../src/shared/analysis-types.js";
import type { MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(currentDir, "../src/renderer");

describe("SettingsView.tsxがincludeExactaInAllocationを参照すること(Issue #125。#124時点は未参照だったが#125でチェックボックスを追加した)", () => {
  it("SettingsView.tsxのソースにincludeExactaInAllocationという識別子が出現すること(JSX直書きでレンダリングテスト基盤が無いためソース走査で確認する。quinella-allocation-setting-wiring.test.ts・combo-odds-scope-guard.test.tsと同じ流儀)", () => {
    const source = readFileSync(path.join(rendererDir, "SettingsView.tsx"), "utf8");
    // 前提固定: 既存3券種のチェックボックスは実在すること(空振り防止。ファイルを正しく読めていることの確認)。
    expect(source).toContain("includeWideInAllocation");
    expect(source).toContain("includeQuinellaInAllocation");
    expect(source).toContain("includeTrioInAllocation");
    expect(source).toContain("includeExactaInAllocation");
  });
});

// ============================================================================
// 振る舞いレベル: MixedAllocationSettings.includeExactaInAllocationの値で
// 混在配分の計算結果が実際に変わること(Issue #125で接続)。
// より詳細な行列(D-2フォールバック条件②③それぞれの分岐)は
// mixed-race-allocation-exacta.test.ts に分離してある。
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

/**
 * n頭(昇順)から順序付きの全ペア(a≠b)を列挙し、一律のオッズ値を割り当てたRecordを作る。
 * `buildAllocationBetComboKey("exacta", pair)`(本タスクでcoreに追加した唯一のゲートウェイ)で
 * キー化するため、キー生成ロジック自体は複製しない(mixed-race-allocation-exacta.test.tsと
 * 同じ流儀)。
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

function fullUnorderedOddsRecord(
  umabans: readonly number[],
  comboSize: number,
  odds: number,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildAllocationBetComboKey("wide", combo)] = odds;
  }
  return record;
}

/**
 * n=8頭・ワイド/3連複/馬連/馬単オッズをすべて用意した「混在経路(kind='mixed')に入る」
 * 標準フィクスチャ(mixed-race-allocation-quinella.test.tsのmixedRaceWithQuinella()と
 * 同じレシピに馬単オッズを足したもの)。
 */
function mixedRaceWithExacta(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullUnorderedOddsRecord(umabans, 2, 30000),
    trioCombo: fullUnorderedOddsRecord(umabans, 3, 90000),
    quinellaCombo: fullUnorderedOddsRecord(umabans, 2, 3000),
    exactaCombo: fullOrderedOddsRecord(umabans, 3000),
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

describe("resolveMixedBetTypes配線: includeExactaInAllocationの値でbetType='exacta'の有無が変わること(Issue #125)", () => {
  it("mixed経路(8頭・馬単オッズあり)でincludeExactaInAllocationをtrue/falseに変えると、馬単配分行の有無が切り替わること", () => {
    const race = mixedRaceWithExacta(8);
    const withExactaOn = buildMixedRaceAllocation(race, settings({ includeExactaInAllocation: true }));
    const withExactaOff = buildMixedRaceAllocation(race, settings({ includeExactaInAllocation: false }));
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止)。
    expect(withExactaOn.kind).toBe("mixed");
    expect(withExactaOff.kind).toBe("mixed");
    if (withExactaOn.kind !== "mixed" || withExactaOff.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const hasExactaOn = withExactaOn.result.allocations.some((a) => a.betType === "exacta");
    const hasExactaOff = withExactaOff.result.allocations.some((a) => a.betType === "exacta");
    expect(hasExactaOn).toBe(true);
    expect(hasExactaOff).toBe(false);
    // 接続された結果、bit-for-bitでは一致しないこと(#124時点はここがtoEqualで一致していた)。
    expect(withExactaOff).not.toEqual(withExactaOn);
  });
});

describe("isComboBetTypesOff配線: includeExactaInAllocationの値でfallbackReasonが変わること(Issue #125)", () => {
  it("ワイド・3連複・馬連OFFのまま馬単だけtrue/falseを切り替えると、combo-bet-types-offになるかどうかが切り替わること", () => {
    const race = mixedRaceWithExacta(8);
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
    });

    const withExactaOn = buildMixedRaceAllocationWithOutcome(race, { ...base, includeExactaInAllocation: true });
    expect(withExactaOn.outcome.route).toBe("mixed");
    expect(withExactaOn.outcome.fallbackReason).toBeNull();

    const withExactaOff = buildMixedRaceAllocationWithOutcome(race, { ...base, includeExactaInAllocation: false });
    expect(withExactaOff.outcome.route).toBe("place-only");
    expect(withExactaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
  });

  it("(オッズ自体が無いケース。#124時点からの回帰) place-only経路(ワイド・3連複・馬連とも候補0件)でincludeExactaInAllocationを変えても、view.kindと中身は一致すること——ただし理由(fallbackReason)は② combo-bet-types-off / ③ no-combo-candidatesで異なる", () => {
    // このrace自体にexactaComboを含まないため、includeExactaInAllocationをtrueにしても
    // 馬単の候補は0件になり(オッズが無い)、最終的にどちらも「組合せ候補ゼロ」という
    // 同じ結末(view.kind="computed"・中身も同一)に到達する。理由コード(fallbackReason)は
    // trueなら③no-combo-candidates、falseなら②combo-bet-types-offと異なる値になる
    // (「接続後も一律に無視される」という意味ではないことに注意)。
    const race = raceInput({ rows: allCandidateRows(8) });
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
    });
    const withExactaOn = buildMixedRaceAllocationWithOutcome(race, { ...base, includeExactaInAllocation: true });
    const withExactaOff = buildMixedRaceAllocationWithOutcome(race, { ...base, includeExactaInAllocation: false });
    // 前提固定: 実際にD-2フォールバック経路(複勝専用。kind="computed")に到達していること。
    expect(withExactaOn.view.kind).toBe("computed");
    expect(withExactaOff.view.kind).toBe("computed");
    expect(withExactaOff.view).toEqual(withExactaOn.view);
    // 理由コードは異なること(前提固定。同じなら本itのタイトルの前提が崩れる)。
    expect(withExactaOn.outcome.fallbackReason).toBe("no-combo-candidates");
    expect(withExactaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
  });
});
