/**
 * quinella-allocation-setting-wiring.test.ts — 設定「馬連を配分に含める」の配管
 * (#24-D3a・Issue #115 → #24-D3b-2・Issue #117)を固定するテスト。
 *
 * ## 経緯
 * Issue #115(#24-D3a)確定スコープ時点では:
 * - `AppSettings.includeQuinellaInAllocation` を新設し、保存・IPC・`MixedAllocationSettings`・
 *   キャッシュキーまで配管する
 * - **候補ビルダー(`resolveMixedBetTypes`)・D-2フォールバック規則(`isComboBetTypesOff`)は
 *   変更しない**(馬連の候補を実際に作るのは#117の仕事。D3aで変えると配分の答えが変わりうる)
 * - **設定画面(`SettingsView.tsx`)にトグルを出さない**
 *
 * このファイルは当時、上記2点(未接続・未表示)を「参照していないこと」のソース走査と
 * 「値を変えても結果が変わらないこと」の振る舞いテストで固定していた。
 *
 * **Issue #117(#24-D3b-2)でこの2点をどちらも接続した**(オーケストレーター裁定
 * 2026-09-25「ソース走査の否定をソース走査の肯定に替えるのではなく、
 * includeQuinellaInAllocationのtrue/falseで結果が実際に変わることを観測する形を優先する」)。
 * 本ファイルはその接続を「値」で固定する形に反転する。より詳細な配線の行列
 * (D-2フォールバック条件②③それぞれの分岐)は`mixed-race-allocation-quinella.test.ts`に
 * 分離した(`mixed-race-allocation-win.test.ts`と同じ構造)。本ファイルは
 * 「#115で配管した設定項目が、#117で実際に接続されたこと」を確認する最小限の回帰に絞る。
 *
 * ## 旧テスト→新テストの対応表(何を保証していたか)
 *
 * | 旧テスト(#115時点) | 何を保証していたか | 新テスト(#117) | 何を保証するか |
 * |---|---|---|---|
 * | 「resolveMixedBetTypesがincludeQuinellaInAllocationを参照していないこと」(ソース走査の否定) | 関数本体の文字列にincludeQuinellaInAllocationが出現しない(構造的な未接続) | 「resolveMixedBetTypes配線: includeQuinellaInAllocationの値でbetType='quinella'の有無が変わること」(値) | true/falseを実際に渡し、betType='quinella'の配分行の有無が切り替わること(接続されたことを値で確認) |
 * | 「isComboBetTypesOffがincludeQuinellaInAllocationを参照していないこと」(ソース走査の否定) | 同上(条件②の判定式にincludeQuinellaInAllocationが出現しない) | 「isComboBetTypesOff配線: includeQuinellaInAllocationの値でfallbackReasonが変わること」(値) | ワイド・3連複OFFのまま馬連だけtrue/falseを切り替えると、fallbackReasonが'combo-bet-types-off'かどうかが切り替わること |
 * | 「SettingsView.tsxがincludeQuinellaInAllocationを一切参照していないこと」(ソース走査の否定) | 画面にまだトグルを出していないこと | 「SettingsView.tsxがincludeQuinellaInAllocationを参照すること」(ソース走査の肯定) | #117でチェックボックスを追加したため、識別子が実在すること(JSX直書きでレンダリングテスト基盤が無いため、この項目のみソース走査を維持する。`combo-odds-scope-guard.test.ts`と同じ流儀) |
 * | 「mixed経路でtrue/falseに変えてもkind・result全体がビット一致すること」 | 値を変えても計算結果が一切変わらない(未接続の証明) | 「mixed経路でtrue/falseに変えると馬連配分行の有無が変わること」(値) | 接続されたことで結果が実際に変わること。より詳細な行列は`mixed-race-allocation-quinella.test.ts`が持つ |
 * | 「place-only経路でtrue/falseに変えても結果が変わらないこと」 | 同上(未接続の証明。place-only経由の対照) | 維持(意味を再解釈)。 | この特定のケース(馬連オッズ自体が無い)は#117後も**偶然**結果が一致する(quinella=trueでも候補0件のため条件③、quinella=falseなら条件②——**理由〈fallbackReason〉は異なるが最終的なview.kindと中身は一致する**)。オッズが無いケースでの一致であることをJSDocで明記し、「接続後も一律に無視される」という誤読を防ぐ |
 *
 * 設定の保存・読込・キャッシュキー等(#115で配管した「参照していないこと」以外の部分)を
 * 固定する往復テストは本ファイルには元々存在しない(`settings-reducer.test.ts`・
 * `settings-store.test.ts`・`ipc-*-wiring.test.ts`が担う。それらは本タスクでは変更しない)。
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
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(currentDir, "../src/renderer");

describe("SettingsView.tsxがincludeQuinellaInAllocationを参照すること(Issue #117。#115時点は未参照だったが#117でチェックボックスを追加した)", () => {
  it("SettingsView.tsxのソースにincludeQuinellaInAllocationという識別子が出現すること(JSX直書きでレンダリングテスト基盤が無いためソース走査で確認する。combo-odds-scope-guard.test.tsと同じ流儀)", () => {
    const source = readFileSync(path.join(rendererDir, "SettingsView.tsx"), "utf8");
    // 前提固定: 既存2券種のチェックボックスは実在すること(空振り防止。ファイルを正しく読めていることの確認)。
    expect(source).toContain("includeWideInAllocation");
    expect(source).toContain("includeTrioInAllocation");
    expect(source).toContain("includeQuinellaInAllocation");
  });
});

// ============================================================================
// 振る舞いレベル: MixedAllocationSettings.includeQuinellaInAllocationの値で
// 混在配分の計算結果が実際に変わること(Issue #117で接続)。
// より詳細な行列(D-2フォールバック条件②③それぞれの分岐)は
// mixed-race-allocation-quinella.test.ts に分離してある。
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
 * n=8頭・ワイド/3連複/馬連オッズをすべて用意した「混在経路(kind='mixed')に入る」標準フィクスチャ
 * (mixed-race-allocation-win.test.tsのmixedRace()と同じレシピに馬連オッズを足したもの)。
 */
function mixedRaceWithQuinella(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullOddsRecord(umabans, 2, 30000),
    trioCombo: fullOddsRecord(umabans, 3, 90000),
    quinellaCombo: fullOddsRecord(umabans, 2, 3000),
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

describe("resolveMixedBetTypes配線: includeQuinellaInAllocationの値でbetType='quinella'の有無が変わること(Issue #117)", () => {
  it("mixed経路(8頭・馬連オッズあり)でincludeQuinellaInAllocationをtrue/falseに変えると、馬連配分行の有無が切り替わること", () => {
    const race = mixedRaceWithQuinella(8);
    const withQuinellaOn = buildMixedRaceAllocation(race, settings({ includeQuinellaInAllocation: true }));
    const withQuinellaOff = buildMixedRaceAllocation(race, settings({ includeQuinellaInAllocation: false }));
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止)。
    expect(withQuinellaOn.kind).toBe("mixed");
    expect(withQuinellaOff.kind).toBe("mixed");
    if (withQuinellaOn.kind !== "mixed" || withQuinellaOff.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const hasQuinellaOn = withQuinellaOn.result.allocations.some((a) => a.betType === "quinella");
    const hasQuinellaOff = withQuinellaOff.result.allocations.some((a) => a.betType === "quinella");
    expect(hasQuinellaOn).toBe(true);
    expect(hasQuinellaOff).toBe(false);
    // 接続された結果、bit-for-bitでは一致しないこと(#115時点はここがtoEqualで一致していた)。
    expect(withQuinellaOff).not.toEqual(withQuinellaOn);
  });
});

describe("isComboBetTypesOff配線: includeQuinellaInAllocationの値でfallbackReasonが変わること(Issue #117)", () => {
  it("ワイド・3連複・馬単OFFのまま馬連だけtrue/falseを切り替えると、combo-bet-types-offになるかどうかが切り替わること(Issue #125で馬単も条件②に加わったため、明示的にOFFにする)", () => {
    const race = mixedRaceWithQuinella(8);
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeExactaInAllocation: false,
    });

    const withQuinellaOn = buildMixedRaceAllocationWithOutcome(race, { ...base, includeQuinellaInAllocation: true });
    expect(withQuinellaOn.outcome.route).toBe("mixed");
    expect(withQuinellaOn.outcome.fallbackReason).toBeNull();

    const withQuinellaOff = buildMixedRaceAllocationWithOutcome(race, { ...base, includeQuinellaInAllocation: false });
    expect(withQuinellaOff.outcome.route).toBe("place-only");
    expect(withQuinellaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
  });

  it("(オッズ自体が無いケース。#115時点からの回帰) place-only経路(ワイド・3連複とも候補0件)でincludeQuinellaInAllocationを変えても、view.kindと中身は一致すること——ただし理由(fallbackReason)は② combo-bet-types-off / ③ no-combo-candidatesで異なる", () => {
    // このrace自体にquinellaComboを含まないため、includeQuinellaInAllocationをtrueにしても
    // 馬連の候補は0件になり(オッズが無い)、最終的にどちらも「組合せ候補ゼロ」という
    // 同じ結末(view.kind="computed"・中身も同一)に到達する。理由コード(fallbackReason)は
    // trueなら③no-combo-candidates、falseなら②combo-bet-types-offと異なる値になる
    // (「接続後も一律に無視される」という意味ではないことに注意)。
    const race = raceInput({ rows: allCandidateRows(8) });
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeExactaInAllocation: false,
    });
    const withQuinellaOn = buildMixedRaceAllocationWithOutcome(race, { ...base, includeQuinellaInAllocation: true });
    const withQuinellaOff = buildMixedRaceAllocationWithOutcome(race, { ...base, includeQuinellaInAllocation: false });
    // 前提固定: 実際にD-2フォールバック経路(複勝専用。kind="computed")に到達していること。
    expect(withQuinellaOn.view.kind).toBe("computed");
    expect(withQuinellaOff.view.kind).toBe("computed");
    expect(withQuinellaOff.view).toEqual(withQuinellaOn.view);
    // 理由コードは異なること(前提固定。同じなら本itのタイトルの前提が崩れる)。
    expect(withQuinellaOn.outcome.fallbackReason).toBe("no-combo-candidates");
    expect(withQuinellaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
  });
});
