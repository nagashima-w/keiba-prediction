import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * mixed-race-allocation-crash-safety — Issue #80(#78-A)。
 *
 * `PLACKETT_LUCE_MODEL` を含む「任意のモデルがthrowする」事態を、production の5つの入口
 * (`buildMixedRaceAllocationWithOutcome`内の3箇所 + `resolvePlaceOnlyStake`1箇所。
 * 数えると4関数だが、buildComboCandidatesはwide/trioの2回呼ばれるため入口としては5つ)
 * それぞれについて、既存の`route:"invalid"`/`kind:"invalid"`/`null`の受け皿に一本化して
 * 吸収できることを固定する。
 *
 * ## モデルではなく境界関数をモックする理由(boss裁定)
 * `PlaceJointModel`をapp層の関数へ注入する経路(`model?`引数の追加)は#81で既定モデルが
 * PLへ切り替わった際に「coreの既定引数」と「appのforward」という**2箇所の定義**を生み、
 * 一方だけCBが残ると1レース内でモデルが混在する(#78シリーズの問題そのもの)。そのため
 * ここでは`@keiba/core/ev/combo-bet-allocation`の`buildComboCandidates`と
 * `@keiba/core/ev/bet-allocation`の`allocateBets`という、モデルのthrowが実際に
 * app層へ届く境界の2関数だけを`vi.mock`+`importOriginal`で条件付きthrowに差し替える
 * (他のエクスポート、特に`allocateGeneralBets`はそのまま実物を使う)。
 *
 * ## vi.mockの巻き上げと動的import(boss試作の教訓)
 * `vi.mock`はファイル先頭へ巻き上げられるが、被テストモジュール(`mixed-race-allocation.ts`/
 * `mixed-allocation-view.ts`)を静的`import`で読み込むと、モック適用前の束縛を掴む場合がある。
 * これを避けるため、被テストモジュールは本ファイル冒頭で`await import()`(トップレベルawait)
 * により動的に読み込む。
 */

let throwFromWide = false;
let throwFromTrio = false;
let throwFromAllocateBets = false;

vi.mock("@keiba/core/ev/combo-bet-allocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core/ev/combo-bet-allocation")>();
  return {
    ...actual,
    buildComboCandidates: (
      ...args: Parameters<typeof actual.buildComboCandidates>
    ): ReturnType<typeof actual.buildComboCandidates> => {
      const betType = args[2];
      if ((betType === "wide" && throwFromWide) || (betType === "trio" && throwFromTrio)) {
        throw new Error(`テスト用スタブ: buildComboCandidates(${betType})が必ずthrowする`);
      }
      return actual.buildComboCandidates(...args);
    },
  };
});

vi.mock("@keiba/core/ev/bet-allocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core/ev/bet-allocation")>();
  return {
    ...actual,
    allocateBets: (
      ...args: Parameters<typeof actual.allocateBets>
    ): ReturnType<typeof actual.allocateBets> => {
      if (throwFromAllocateBets) {
        throw new Error("テスト用スタブ: allocateBetsが必ずthrowする");
      }
      return actual.allocateBets(...args);
    },
  };
});

const { buildMixedRaceAllocationWithOutcome } = await import("../src/shared/mixed-race-allocation.js");
const { resolvePlaceOnlyStake } = await import("../src/renderer/mixed-allocation-view.js");

// ============================================================================
// テストヘルパー(allocation-outcome-codes.test.tsと同じ流儀。本ファイル専用に複製する)
// ============================================================================

import type { AnalysisRow as AnalysisRowType, ComboOddsFetchDiagnosticsView, ComboOddsFetchOutcomeView } from "../src/shared/analysis-types.js";
import { buildComboOddsKey } from "@keiba/core/ev/combo-bet-allocation";
import { CONDITIONAL_BERNOULLI_MODEL, PLACKETT_LUCE_MODEL } from "@keiba/core/ev/place-joint-model";
import type { MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import type { MixedAllocationSettings } from "../src/shared/mixed-race-allocation.js";

function row(overrides: Partial<AnalysisRowType> & { umaban: number }): AnalysisRowType {
  return {
    umaban: overrides.umaban,
    wakuban: overrides.wakuban ?? 90,
    horseName: `${overrides.umaban}番`,
    prior: overrides.prior === undefined ? 0.3 : overrides.prior,
    adjustedProb: overrides.adjustedProb ?? 0.5,
    placeOddsMin: overrides.placeOddsMin === undefined ? 3 : overrides.placeOddsMin,
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
  overrides: Partial<MixedCandidateBuildInput> & { rows: readonly AnalysisRowType[] },
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
    ...overrides,
  };
}

function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function allCandidateRows(n: number): AnalysisRowType[] {
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

function fullOddsRecord(umabans: readonly number[], comboSize: number, odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildComboOddsKey(combo)] = odds;
  }
  return record;
}

function comboOddsOutcome(
  betType: "wide" | "trio",
  state: ComboOddsFetchOutcomeView["state"],
): ComboOddsFetchOutcomeView {
  const diagnostics: ComboOddsFetchDiagnosticsView = {
    betType,
    requestCount: 0,
    expectedComboCount: 0,
    obtainedComboCount: 0,
    missingComboCount: 0,
    axisUmabans: [],
    attempts: [],
    numericConflictCount: 0,
    nullWinConflictCount: 0,
    conflictSamples: [],
  };
  return { state, diagnostics };
}

/** n頭ぶんの、正EVなワイド・3連複オッズ一式を持つ race を作る補助関数(混在経路へ入るための共通材料)。 */
function raceWithPositiveCombos(n: number, overrides: Partial<MixedCandidateBuildInput> = {}): MixedCandidateBuildInput {
  const umabans = umabansOf(n);
  return raceInput({
    rows: allCandidateRows(n),
    wideCombo: fullOddsRecord(umabans, 2, 100000),
    trioCombo: fullOddsRecord(umabans, 3, 100000),
    comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    ...overrides,
  });
}

afterEach(() => {
  throwFromWide = false;
  throwFromTrio = false;
  throwFromAllocateBets = false;
});

// ============================================================================
// 5入口 × throwする側
// ============================================================================

describe("5入口: throwすると既存の受け皿(route:'invalid'/kind:'invalid'またはnull)に一本化されること", () => {
  it("入口1: buildComboCandidates('wide')がthrow → route:'invalid'・comboOddsはnull(判定不能。#31)", () => {
    throwFromWide = true;
    const { view, outcome } = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());
    expect(view.kind).toBe("invalid");
    expect(outcome).toEqual({
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOdds: null,
    });
  });

  it("入口2: buildComboCandidates('trio')がthrow → route:'invalid'・comboOddsはnull(判定不能。#31)", () => {
    throwFromTrio = true;
    const { view, outcome } = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());
    expect(view.kind).toBe("invalid");
    expect(outcome).toEqual({
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOdds: null,
    });
  });

  it("入口3: allocateGeneralBetsがthrow(既存の内側catch)→ route:'invalid'・comboOddsは実値(取得済みと判定済み)", () => {
    // allocateGeneralBets自体は本ファイルではモックしない(既存の内側catchの契約=
    // 「throwの前にmixed.diagnosticsが算出済み」を確認するため、buildComboCandidatesは
    // 正常実行させ、allocateGeneralBetsだけ契約違反データで自然にthrowさせる)。
    const rows = allCandidateRows(8).map((r) =>
      r.umaban === 1 ? row({ umaban: 1, placeOddsMin: -5, ev: 2, isPositive: true }) : r,
    );
    const race = raceWithPositiveCombos(8, { rows });
    const { view, outcome } = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(view.kind).toBe("invalid");
    expect(outcome).toEqual({
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOdds: { wide: "present", trio: "present" },
    });
  });

  it("入口4: resolvePlaceOnlyStake内部のallocateBetsがthrow → null(混在配分本体は巻き添えにしない)", () => {
    throwFromAllocateBets = true;
    const race = raceWithPositiveCombos(8);
    const stake = resolvePlaceOnlyStake(race, settings());
    expect(stake).toBeNull();
  });

  it("入口5: D-2フォールバック経由のallocateBetsがthrow → route:'invalid'・comboOddsはnull(判定不能。#31)", () => {
    throwFromAllocateBets = true;
    // includeComboOdds=falseでD-2条件①へ落とし、buildMixedCandidatesを経由せずに
    // buildPlaceOnlyFallbackOutcome→buildRaceAllocation→allocateBetsへ到達させる。
    const race = raceInput({ rows: allCandidateRows(8) });
    const { view, outcome } = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false }));
    expect(view.kind).toBe("invalid");
    expect(outcome).toEqual({
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOdds: null,
    });
  });
});

// ============================================================================
// 黙っているべき側(#76): throwしなければ、5入口すべてで通常どおりの値になること
// ============================================================================

describe("黙っているべき側: どの境界もthrowしなければ現行HEADと完全に同一のview/outcomeが返ること(AC-A4・#76)", () => {
  /**
   * 【#81での注記】このフィクスチャ(`raceWithPositiveCombos(8)`)は全馬`adjustedProb=0.5`の
   * 対称入力である。全馬が同一の確率を持つとき、CONDITIONAL_BERNOULLI_MODELと
   * PLACKETT_LUCE_MODELの同時分布は構造的に完全一致する(θがすべて等しくなり、
   * C(n,k)通りの一様分布になるため。#81着手前ゲートboss実測: このフィクスチャでの
   * 確率の最大差は厳密に0)。**したがってこのフィクスチャは配分額(stake)ではモデル差を
   * 検出できない。** #81で赤くなるのは`modelId`だけであり、直前の行(totalStake・betCount・
   * isSkip)は既定をPLに切り替えても一切変わらない。数値による検出は
   * AC-B10(下記「既定切替の数値検出」describe)が非対称フィクスチャで別途担う。
   */
  it("入口1・2・3(mixed経路): throwなしならoutcomeの5フィールド全部が現行HEADと一致し、view.result主要値もリテラルと一致すること", () => {
    const { view, outcome } = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());
    // AC-A4: 5フィールド全部を1つのオブジェクトとしてtoEqual(部分集合は不可)。
    expect(outcome).toEqual({
      route: "mixed",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOdds: { wide: "present", trio: "present" },
    });
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") return;
    // view側も現行HEADの実測値をリテラルで固定する(「同一のview」の直接証拠)。
    // totalStake・betCount・isSkipは対称フィクスチャのためCB/PLどちらでも同じ値になる
    // (上記JSDoc参照)。modelIdだけが#81(既定切替)の検出対象。
    expect(view.result.totalStake).toBe(19600);
    expect(view.result.betCount).toBe(28);
    expect(view.result.isSkip).toBe(false);
    expect(view.result.modelId).toBe("plackett-luce");
  });

  it("入口4(resolvePlaceOnlyStake): throwなしなら現行HEADの実測値(リテラル)がそのまま返ること", () => {
    const race = raceWithPositiveCombos(8);
    const stake = resolvePlaceOnlyStake(race, settings());
    // AC-A4: 述語検査(toBeGreaterThan等)ではなく値そのものをリテラルで固定する。
    // resolvePlaceOnlyStakeはstakeの数値のみを返しmodelIdを返さないため、このテストは
    // #81の影響を受けない(対称フィクスチャであることに加え、返り値自体にモデル起源の
    // フィールドが無い)。
    expect(stake).toBe(20000);
  });

  /**
   * 【#81での注記】このフィクスチャ(`allCandidateRows(8)`)も全馬`adjustedProb=0.5`の
   * 対称入力であり、かつ`totalStake===perRaceCap(20000)`でキャップ飽和している
   * (`view.result.capApplied`相当が拘束)。対称性(数値が一致)とキャップ飽和(仮に非対称でも
   * 縮小後の総額に丸められる)の**二重の理由**で配分額からモデル差を検出できない。
   * 数値による検出はAC-B10(下記)が非対称・キャップ非拘束フィクスチャで別途担う。
   */
  it("入口5(D-2フォールバック): throwなしならoutcomeの5フィールド全部が現行HEADと一致し、view.result主要値もリテラルと一致すること", () => {
    const race = raceInput({ rows: allCandidateRows(8) });
    const { view, outcome } = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false }));
    expect(outcome).toEqual({
      route: "place-only",
      unavailableReason: null,
      fallbackReason: "combo-odds-not-requested",
      skipReasonCode: null,
      comboOdds: null,
    });
    expect(view.kind).toBe("computed");
    if (view.kind !== "computed") return;
    expect(view.result.totalStake).toBe(20000);
    expect(view.result.betCount).toBe(8);
    expect(view.result.isSkip).toBe(false);
    expect(view.result.modelId).toBe("plackett-luce");
  });
});

// ============================================================================
// AC-B10(Issue #81): app層に配分額の変化を検出するテストを追加する
// ============================================================================

/**
 * AC-B10 — 上記「黙っているべき側」2件のフィクスチャは、対称入力(全馬同一確率)または
 * キャップ飽和のため配分額でモデル差を検出できない(#81着手前ゲートboss実測:
 * 対称入力での確率の最大差は厳密に0)。本describeは、**非対称**(馬ごとにadjustedProbが
 * 相異なる)かつ**キャップ非拘束**のフィクスチャを用い、`buildMixedRaceAllocationWithOutcome`
 * が返す配分額(totalStake・betCount・各allocations[].stake)が既定切替(#81)で
 * 実際に変わることを数値でリテラル固定する。
 *
 * モデル注入は行わない(boss裁定): 空振り防止は「両モデルのbuildDistributionを直接呼んで
 * 確率の最大差が0でないこと」を固定する形にする。これにより、モデルを増設せずとも
 * 「フィクスチャが対称に退化していないか」を直接検査できる。
 */
describe("既定切替の数値検出(#81・AC-B10): 非対称・キャップ非拘束フィクスチャでmodelId以外の数値も変わること", () => {
  function asymmetricRace(): MixedCandidateBuildInput {
    // 5頭・全馬adjustedProbが相異なる(0.75/0.65/0.55/0.45/0.35)。
    const probs = [0.75, 0.65, 0.55, 0.45, 0.35];
    const umabans = umabansOf(5);
    const rows = umabans.map((umaban, i) => row({ umaban, adjustedProb: probs[i] }));
    return raceInput({
      rows,
      wideCombo: fullOddsRecord(umabans, 2, 100000),
      trioCombo: fullOddsRecord(umabans, 3, 100000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
  }

  // キャップを十分大きくし、比例縮小(cap拘束)が働かないようにする(受け入れ条件の前提)。
  const nonBindingSettings = settings({ perRaceCap: 100000000 });

  it("前提(無条件expect・空振り防止): このフィクスチャのhorsesに対して、CBとPLの同時分布(k=3)の確率の最大差が0でないこと", () => {
    const probs = [0.75, 0.65, 0.55, 0.45, 0.35];
    const jointHorses = probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
    const cbDist = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(jointHorses, 3);
    const plDist = PLACKETT_LUCE_MODEL.buildDistribution(jointHorses, 3);
    const cbByKey = new Map(cbDist.map((o) => [o.placed.join(","), o.probability]));
    let maxDiff = 0;
    for (const o of plDist) {
      maxDiff = Math.max(maxDiff, Math.abs(o.probability - (cbByKey.get(o.placed.join(",")) ?? 0)));
    }
    expect(maxDiff).toBeGreaterThan(0);
    // 実測値(自分で実行して確認)。この数値自体は殺す変異の対象ではないが、
    // 前提が「たまたま今回だけ0でない」のではなく安定した実測であることの参考値として残す。
    expect(maxDiff).toBe(0.022854295451697842);
  });

  it("既定(model引数を注入しない実際の呼び出し経路)の配分結果がリテラルと一致すること(#81: 既定切替でこの値が変わる)", () => {
    const { view, outcome } = buildMixedRaceAllocationWithOutcome(asymmetricRace(), nonBindingSettings);
    expect(outcome.route).toBe("mixed");
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") return;

    // 前提(無条件expect): キャップが実際に拘束していないこと
    // (拘束していると比例縮小で数値が潰れ、AC-B10が測ろうとしている差が見えなくなる)。
    expect(view.result.capApplied).toBe(false);

    expect(view.result.modelId).toBe("plackett-luce");
    // totalStakeはCB(既定切替前。自分で実行して確認: 149800)と偶然一致する
    // (model-characterization.test.tsのF3・F6と同じ「totalStakeは判別指標にならない」現象)。
    // 判別しているのはbetCount(CB=7 vs PL=10)と下記のstakes配列そのもの。
    expect(view.result.totalStake).toBe(149800);
    expect(view.result.betCount).toBe(10);
    expect(view.result.isSkip).toBe(false);

    const stakes = view.result.allocations.map((a) => ({ betType: a.betType, umabans: a.umabans, stake: a.stake }));
    expect(stakes).toEqual([
      { betType: "wide", umabans: [1, 2], stake: 54600 },
      { betType: "trio", umabans: [1, 2, 3], stake: 0 },
      { betType: "trio", umabans: [1, 2, 4], stake: 0 },
      { betType: "trio", umabans: [1, 2, 5], stake: 0 },
      { betType: "wide", umabans: [1, 3], stake: 35200 },
      { betType: "trio", umabans: [1, 3, 4], stake: 0 },
      { betType: "trio", umabans: [1, 3, 5], stake: 0 },
      { betType: "wide", umabans: [1, 4], stake: 17100 },
      { betType: "trio", umabans: [1, 4, 5], stake: 0 },
      { betType: "wide", umabans: [1, 5], stake: 2100 },
      { betType: "wide", umabans: [2, 3], stake: 21600 },
      { betType: "trio", umabans: [2, 3, 4], stake: 0 },
      { betType: "trio", umabans: [2, 3, 5], stake: 0 },
      { betType: "wide", umabans: [2, 4], stake: 8100 },
      { betType: "trio", umabans: [2, 4, 5], stake: 0 },
      { betType: "wide", umabans: [2, 5], stake: 100 },
      { betType: "wide", umabans: [3, 4], stake: 2200 },
      { betType: "trio", umabans: [3, 4, 5], stake: 0 },
      { betType: "wide", umabans: [3, 5], stake: 900 },
      { betType: "wide", umabans: [4, 5], stake: 7900 },
    ]);
  });
});
