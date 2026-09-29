/**
 * bracket-quinella-allocation-setting-wiring.test.ts — 設定「枠連を配分に含める」の配管
 * (#26-E3a・Issue #149)を固定するテスト。
 *
 * `trifecta-allocation-setting-wiring.test.ts`の**#25-E3a時点版**
 * (`git show 2233dff:packages/app/test/trifecta-allocation-setting-wiring.test.ts`。まだ
 * `resolveMixedBetTypes`へ接続していない時点の版)と同じ構造を踏襲する。
 *
 * Issue #149(#26-E3a)確定スコープ(オーケストレーター着手前ゲート合意 2026-09-29):
 * - `AppSettings.includeBracketQuinellaInAllocation` を新設し、保存・IPC・`MixedAllocationSettings`・
 *   キャッシュキーまで配管する(既定ON。ユーザー指定「新しい券種は配分の対象に初期値で含める」)
 * - **候補ビルダー(`resolveMixedBetTypes`)・D-2フォールバック規則(`isComboBetTypesOff`)・
 *   条件③の候補数カウント(`comboCandidateCount`)は変更しない**(枠連の候補を実際に作るのは
 *   #26-E3b〈Issue #150〉の仕事。E3aで変えると配分の答えが変わりうる)
 * - **設定画面(`SettingsView.tsx`)にトグルを出さない**(reducerの切替アクションも作らない)
 * - DB列(`analysis_allocation_meta.include_bracket_quinella`相当)の追加は#26-E3c(Issue #151)へ送る
 *   (`analysis_allocation_meta`の列一覧は#59で「固定・増減は停止条件」と凍結されており、
 *   読む人が実在するタスクで解除する)
 *
 * ## 「参照していないこと」の確認方法
 * ソース走査(`not.toContain`)を経由せず、`buildMixedRaceAllocation`/
 * `buildMixedRaceAllocationWithOutcome`/`buildAllocationRecord`の値比較だけで未接続を固定する。
 *
 * **空振り(vacuous pass)の防止**: 枠連オッズが実在し、`betTypes`に枠連を明示すれば
 * 枠連候補が実際に作られる(=接続すれば配分が変わりうる)ことを、各テストで無条件`expect`により
 * 先に固定する。前提を固定しないと、枠連オッズが空のレースでは接続されても差が出ない。
 *
 * **注意: このファイルは#26-E3b(Issue #150)で反転される見込みである。** #150で
 * `resolveMixedBetTypes`・`isComboBetTypesOff`が実際に`includeBracketQuinellaInAllocation`を
 * 参照するようになったら、本ファイルの「値が変わらないこと」を保証するテストは
 * 「値が変わること」を保証するテストへ書き換える(三連単が#138→#139で辿った反転と同型。
 * `trifecta-allocation-setting-wiring.test.ts`冒頭の「旧テスト→新テストの対応表」参照)。
 */

import { describe, expect, it } from "vitest";

import { buildAllocationRecord } from "../src/main/allocation-record.js";
import type { AnalysisRow } from "../src/shared/analysis-types.js";
import { buildMixedCandidates, type MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

/** 馬番→枠番を明示した行(枠連の的中判定は枠番を読む。馬番≠枠番にして取り違えを防ぐ)。 */
function row(umaban: number, wakuban: number): AnalysisRow {
  return {
    umaban,
    wakuban,
    horseName: `${umaban}番`,
    prior: 0.3,
    adjustedProb: 0.5,
    placeOddsMin: 3,
    winOdds: 10,
    ev: 1.5,
    isPositive: true,
    reason: null,
    careerRunCount: 999,
    mark: null,
    evEstimated: false,
    conditionChangeTags: [],
  };
}

/** 馬番1..8を枠[1,2,2,3,4,5,6,7]に割り当てる(馬番≠枠番。複勝が対象になる8頭で、混在経路に入れる)。 */
const WAKUBANS = [1, 2, 2, 3, 4, 5, 6, 7];

function rows(): AnalysisRow[] {
  return WAKUBANS.map((wakuban, i) => row(i + 1, wakuban));
}

/** 全馬の2頭組合せに一律のワイドオッズを与える(枠連なしでも混在経路に入れるため)。 */
function wideOdds(odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (let a = 1; a <= WAKUBANS.length; a++) {
    for (let b = a + 1; b <= WAKUBANS.length; b++) {
      record[`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`] = odds;
    }
  }
  return record;
}

/**
 * 枠連の全買い目(キーは枠番4桁・昇順。同枠は2頭以上の枠だけ)に、ワイドより桁違いに有利な高オッズを
 * 与える(接続されれば配分が動く)。枠[1,2,2,3,4,5,6,7]なら、馬のいる枠は7つで同枠は枠2だけなので、
 * C(7,2)+1=22件。
 */
const BRACKET_COMBO_COUNT = 22;
function bracketOdds(odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  const frames = [...new Set(WAKUBANS)].sort((x, y) => x - y);
  for (const a of frames) {
    for (const b of frames) {
      if (a > b) continue;
      if (a === b && WAKUBANS.filter((w) => w === a).length < 2) continue;
      record[`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`] = odds;
    }
  }
  return record;
}

function raceWithBracket(): MixedCandidateBuildInput {
  return {
    oddsStatus: "result",
    rows: rows(),
    wideCombo: wideOdds(30),
    bracketQuinellaCombo: bracketOdds(9999),
  };
}

/** 枠連だけを配分対象にできる状態(ワイド〜三連単をOFF)から始めて上書きできるテスト用設定。 */
function settings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: false,
    includeQuinellaInAllocation: false,
    includeExactaInAllocation: false,
    includeTrifectaInAllocation: false,
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

/** 前提固定(空振り防止): 枠連を明示すれば、このレースから枠連の買い目候補が実際に作られること。 */
function expectBracketCandidatesExist(race: MixedCandidateBuildInput): void {
  const result = buildMixedCandidates(race, { betTypes: ["bracketQuinella"] });
  const bracket = result.candidates.filter((c) => c.betType === "bracketQuinella");
  expect(bracket).toHaveLength(BRACKET_COMBO_COUNT);
  // 桁違いの高オッズなので、全件が期待値プラス(配分に選ばれる資格がある)。
  expect(bracket.every((c) => c.ev !== null && c.ev > 1)).toBe(true);
}

describe("buildMixedRaceAllocation: includeBracketQuinellaInAllocationの値を変えても結果が変わらないこと(#26-E3a。候補ビルダー未接続の直接確認)", () => {
  it("mixed経路(ワイドON・枠連の高オッズあり)でincludeBracketQuinellaInAllocationをtrue/falseに変えても、kind・result全体がビット一致し、枠連の買い目が入らないこと", () => {
    const race = raceWithBracket();
    expectBracketCandidatesExist(race);

    const withBracketOn = buildMixedRaceAllocation(
      race,
      settings({ includeBracketQuinellaInAllocation: true }),
    );
    const withBracketOff = buildMixedRaceAllocation(
      race,
      settings({ includeBracketQuinellaInAllocation: false }),
    );
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止)。
    expect(withBracketOn.kind).toBe("mixed");
    expect(withBracketOff.kind).toBe("mixed");
    expect(withBracketOff).toEqual(withBracketOn);

    // 枠連の買い目は配分に含まれない(利用者から見える配分が変わらない)。
    if (withBracketOn.kind !== "mixed") {
      throw new Error("前提が崩れた: kind='mixed'であること");
    }
    expect(withBracketOn.result.allocations.some((a) => a.betType === "bracketQuinella")).toBe(false);
    // 前提: 混在配分自体は実際に何かを配分している(全体が空で一致しているだけではないこと)。
    expect(withBracketOn.result.allocations.length).toBeGreaterThan(0);
  });

  it("isComboBetTypesOff配線(D-2フォールバック規則の条件②)経路でincludeBracketQuinellaInAllocationを変えても結果・理由コードが変わらないこと", () => {
    // ワイド〜三連単の5つを明示的にOFFにし、条件②を真に成立させる。枠連は`isComboBetTypesOff`が
    // まだ見ない(#150で見る)ため、値によらず条件②が成立し続けるはず。
    const race = raceWithBracket();
    expectBracketCandidatesExist(race);
    const base = settings({
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: false,
      includeTrifectaInAllocation: false,
    });
    const withBracketOn = buildMixedRaceAllocationWithOutcome(race, {
      ...base,
      includeBracketQuinellaInAllocation: true,
    });
    const withBracketOff = buildMixedRaceAllocationWithOutcome(race, {
      ...base,
      includeBracketQuinellaInAllocation: false,
    });
    // 前提固定: 実際に条件②(combo-bet-types-off)経由でplace-onlyへ落ちていること。
    expect(withBracketOn.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(withBracketOff.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(withBracketOn.view.kind).toBe("computed");
    expect(withBracketOff.view.kind).toBe("computed");
    expect(withBracketOff.view).toEqual(withBracketOn.view);
    expect(withBracketOff.outcome).toEqual(withBracketOn.outcome);
  });

  it("配分記録(メタ行・買い目)も、includeBracketQuinellaInAllocationの値を変えて一致すること(メタ行の列は据え置き。#26-E3c〈Issue #151〉で解除するまで枠連の設定は書かない)", () => {
    const race = raceWithBracket();
    expectBracketCandidatesExist(race);
    const onSettings = settings({ includeBracketQuinellaInAllocation: true });
    const offSettings = settings({ includeBracketQuinellaInAllocation: false });
    // 前提: 2つの設定は枠連の項目だけが異なる。
    expect(onSettings.includeBracketQuinellaInAllocation).not.toBe(
      offSettings.includeBracketQuinellaInAllocation,
    );
    const onOutcome = buildMixedRaceAllocationWithOutcome(race, onSettings);
    const offOutcome = buildMixedRaceAllocationWithOutcome(race, offSettings);
    expect(onOutcome.view.kind).toBe("mixed");
    const onRecord = buildAllocationRecord(onOutcome, onSettings, "result");
    const offRecord = buildAllocationRecord(offOutcome, offSettings, "result");
    expect(offRecord).toEqual(onRecord);
    // 前提: 買い目が空ではない(空同士の一致ではないこと)。
    expect(onRecord.bets.length).toBeGreaterThan(0);
  });
});
