/**
 * trifecta-allocation-setting-wiring.test.ts — 設定「三連単を配分に含める」の配管
 * (#25-E3a・Issue #138 → #25-E3b・Issue #139)を固定するテスト。
 *
 * `exacta-allocation-setting-wiring.test.ts`(馬単版・Issue #124→#125)と同じ構造を踏襲する。
 *
 * ## 経緯
 * Issue #138(#25-E3a)確定スコープ時点では:
 * - `AppSettings.includeTrifectaInAllocation` を新設し、保存・IPC・`MixedAllocationSettings`・
 *   キャッシュキーまで配管する
 * - **候補ビルダー(`resolveMixedBetTypes`)・D-2フォールバック規則(`isComboBetTypesOff`)・
 *   条件③の候補数カウント(`comboCandidateCount`)は変更しない**(三連単の候補を実際に作るのは
 *   #25-E3b〈Issue #139〉の仕事。E3aで変えると配分の答えが変わりうる)
 * - **設定画面(`SettingsView.tsx`)にトグルを出さない**
 * - DB列(`analysis_allocation_meta.include_trifecta`)の追加は#25-E3c(Issue #140)へ送る
 *
 * このファイルは当時、上記2点(未接続・未表示)を「値の一致(toEqual)」の振る舞いテストと
 * 「参照していないこと」のソース走査を経由しない値比較で固定していた。
 *
 * **Issue #139(#25-E3b)でこの2点をどちらも接続した**(#125と同じ裁定「値で接続を観測する形を
 * 優先する」)。本ファイルはその接続を「値」で固定する形に反転する。より詳細な配線の行列
 * (D-2フォールバック条件②③それぞれの分岐)は`mixed-race-allocation-trifecta.test.ts`に
 * 分離した(`mixed-race-allocation-exacta.test.ts`と同じ構造)。本ファイルは
 * 「#138で配管した設定項目が、#139で実際に接続されたこと」を確認する最小限の回帰に絞る。
 *
 * ## 旧テスト→新テストの対応表(何を保証していたか)
 *
 * | 旧テスト(#138時点) | 何を保証していたか | 新テスト(#139) | 何を保証するか |
 * |---|---|---|---|
 * | 「mixed経路(8頭)でincludeTrifectaInAllocationをtrue/falseに変えても、kind・result全体がビット一致すること」 | 値を変えても計算結果が一切変わらない(未接続の証明) | 「resolveMixedBetTypes配線: includeTrifectaInAllocationの値でbetType='trifecta'の有無が変わること」(値) | true/falseを実際に渡し、betType='trifecta'の配分行の有無が切り替わること(接続されたことを値で確認) |
 * | 「isComboBetTypesOff配線(D-2フォールバック規則の条件②)経路でincludeTrifectaInAllocationを変えても結果・理由コードが変わらないこと」 | 条件②の判定式がincludeTrifectaInAllocationを参照しない(値を変えても`fallbackReason`が一切変わらない) | 「isComboBetTypesOff配線: includeTrifectaInAllocationの値でfallbackReasonが変わること」(値) | ワイド・3連複・馬連・馬単OFFのまま三連単だけtrue/falseを切り替えると、fallbackReasonが'combo-bet-types-off'かどうかが切り替わること |
 * | (#138時点に無し。SettingsView.tsxのソース走査は元々このファイルの対象外) | — | 「SettingsView.tsxがincludeTrifectaInAllocationを参照すること」(ソース走査の肯定) | #139でチェックボックスを追加したため、識別子が実在すること(JSX直書きでレンダリングテスト基盤が無いため、この項目のみソース走査で確認する。`exacta-allocation-setting-wiring.test.ts`・`combo-odds-scope-guard.test.ts`と同じ流儀) |
 *
 * 設定の保存・読込・キャッシュキー等(#138で配管した「参照していないこと」以外の部分)を
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

describe("SettingsView.tsxがincludeTrifectaInAllocationを参照すること(Issue #139。#138時点は未参照だったが#139でチェックボックスを追加した)", () => {
  it("SettingsView.tsxのソースにincludeTrifectaInAllocationという識別子が出現すること(JSX直書きでレンダリングテスト基盤が無いためソース走査で確認する。exacta-allocation-setting-wiring.test.ts・combo-odds-scope-guard.test.tsと同じ流儀)", () => {
    const source = readFileSync(path.join(rendererDir, "SettingsView.tsx"), "utf8");
    // 前提固定: 既存4券種のチェックボックスは実在すること(空振り防止。ファイルを正しく読めていることの確認)。
    expect(source).toContain("includeWideInAllocation");
    expect(source).toContain("includeQuinellaInAllocation");
    expect(source).toContain("includeTrioInAllocation");
    expect(source).toContain("includeExactaInAllocation");
    expect(source).toContain("includeTrifectaInAllocation");
  });
});

// ============================================================================
// 振る舞いレベル: MixedAllocationSettings.includeTrifectaInAllocationの値で
// 混在配分の計算結果が実際に変わること(Issue #139で接続)。
// より詳細な行列(D-2フォールバック条件②③それぞれの分岐)は
// mixed-race-allocation-trifecta.test.ts に分離してある。
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

/** n頭(昇順)から順序付きの全3つ組(着順どおり)を列挙し、一律のオッズ値を割り当てたRecordを作る(三連単用)。 */
function fullOrderedTriplesOddsRecord(umabans: readonly number[], odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const triple of permutations(umabans, 3)) {
    record[buildAllocationBetComboKey("trifecta", triple)] = odds;
  }
  return record;
}

/**
 * n=8頭・ワイド/3連複オッズも用意した「混在経路(kind='mixed')に入る」標準フィクスチャ
 * (mixed-race-allocation-win.test.tsのmixedRace()と同じレシピ)。
 */
function mixedRace(n = 8): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  const wideCombo: Record<string, number> = {};
  const trioCombo: Record<string, number> = {};
  for (const combo of permutations(umabans, 2)) {
    // ワイド・3連複は順不同のため、昇順の組だけを採用する(重複を避ける)。
    if (combo[0]! < combo[1]!) {
      wideCombo[buildAllocationBetComboKey("wide", combo)] = 30000;
    }
  }
  for (const combo of permutations(umabans, 3)) {
    if (combo[0]! < combo[1]! && combo[1]! < combo[2]!) {
      trioCombo[buildAllocationBetComboKey("trio", combo)] = 90000;
    }
  }
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo,
    trioCombo,
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
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

describe("resolveMixedBetTypes配線: includeTrifectaInAllocationの値でbetType='trifecta'の有無が変わること(Issue #139)", () => {
  it("mixed経路(8頭・三連単オッズあり)でincludeTrifectaInAllocationをtrue/falseに変えると、三連単配分行の有無が切り替わること", () => {
    const base = mixedRace(8);
    const race: MixedCandidateBuildInput = {
      ...base,
      trifectaCombo: fullOrderedTriplesOddsRecord(umabansOf(8), 3000),
    };
    const withTrifectaOn = buildMixedRaceAllocation(race, settings({ includeTrifectaInAllocation: true }));
    const withTrifectaOff = buildMixedRaceAllocation(race, settings({ includeTrifectaInAllocation: false }));
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止)。
    expect(withTrifectaOn.kind).toBe("mixed");
    expect(withTrifectaOff.kind).toBe("mixed");
    if (withTrifectaOn.kind !== "mixed" || withTrifectaOff.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const hasTrifectaOn = withTrifectaOn.result.allocations.some((a) => a.betType === "trifecta");
    const hasTrifectaOff = withTrifectaOff.result.allocations.some((a) => a.betType === "trifecta");
    expect(hasTrifectaOn).toBe(true);
    expect(hasTrifectaOff).toBe(false);
    // 接続された結果、bit-for-bitでは一致しないこと(#138時点はここがtoEqualで一致していた)。
    expect(withTrifectaOff).not.toEqual(withTrifectaOn);
  });
});

describe("isComboBetTypesOff配線: includeTrifectaInAllocationの値でfallbackReasonが変わること(Issue #139)", () => {
  it("ワイド・3連複・馬連・馬単OFFのまま三連単だけtrue/falseを切り替えると、combo-bet-types-offになるかどうかが切り替わること", () => {
    const race: MixedCandidateBuildInput = {
      ...raceInput({ rows: allCandidateRows(8) }),
      trifectaCombo: fullOrderedTriplesOddsRecord(umabansOf(8), 3000),
    };
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: false,
    });

    const withTrifectaOn = buildMixedRaceAllocationWithOutcome(race, { ...base, includeTrifectaInAllocation: true });
    expect(withTrifectaOn.outcome.route).toBe("mixed");
    expect(withTrifectaOn.outcome.fallbackReason).toBeNull();

    const withTrifectaOff = buildMixedRaceAllocationWithOutcome(race, { ...base, includeTrifectaInAllocation: false });
    expect(withTrifectaOff.outcome.route).toBe("place-only");
    expect(withTrifectaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
  });

  it("(オッズ自体が無いケース。#138時点からの回帰) place-only経路(ワイド・3連複・馬連・馬単とも候補0件)でincludeTrifectaInAllocationを変えても、view.kindと中身は一致すること——ただし理由(fallbackReason)は② combo-bet-types-off / ③ no-combo-candidatesで異なる", () => {
    // このrace自体にtrifectaComboを含まないため、includeTrifectaInAllocationをtrueにしても
    // 三連単の候補は0件になり(オッズが無い)、最終的にどちらも「組合せ候補ゼロ」という
    // 同じ結末(view.kind="computed"・中身も同一)に到達する。理由コード(fallbackReason)は
    // trueなら③no-combo-candidates、falseなら②combo-bet-types-offと異なる値になる。
    const race = raceInput({ rows: allCandidateRows(8) });
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: false,
    });
    const withTrifectaOn = buildMixedRaceAllocationWithOutcome(race, { ...base, includeTrifectaInAllocation: true });
    const withTrifectaOff = buildMixedRaceAllocationWithOutcome(race, { ...base, includeTrifectaInAllocation: false });
    // 前提固定: 実際にD-2フォールバック経路(複勝専用。kind="computed")に到達していること。
    expect(withTrifectaOn.view.kind).toBe("computed");
    expect(withTrifectaOff.view.kind).toBe("computed");
    expect(withTrifectaOff.view).toEqual(withTrifectaOn.view);
    // 理由コードは異なること(前提固定。同じなら本itのタイトルの前提が崩れる)。
    expect(withTrifectaOn.outcome.fallbackReason).toBe("no-combo-candidates");
    expect(withTrifectaOff.outcome.fallbackReason).toBe("combo-bet-types-off");
  });
});
