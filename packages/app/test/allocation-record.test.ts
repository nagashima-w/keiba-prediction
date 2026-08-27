import { describe, expect, it } from "vitest";

import { DEFAULT_BET_ALLOCATION_CONFIG } from "@keiba/core/ev/bet-allocation";
import {
  buildComboOddsKey,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
} from "@keiba/core/ev/combo-bet-allocation";

import {
  buildAllocationRecord,
  buildInvalidAllocationRecordForException,
  toMixedAllocationSettings,
  type AnalysisAllocationSettings,
} from "../src/main/allocation-record.js";
import type { AnalysisRow, ComboOddsFetchDiagnosticsView, ComboOddsFetchOutcomeView } from "../src/shared/analysis-types.js";
import {
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";
import type { MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";

/**
 * allocation-record.test.ts — Issue #59。`allocation-outcome-codes.test.ts` と同じテスト
 * ヘルパー流儀(自己テスト付き)を踏襲する(独立コピー。両ファイルで意図が異なるため共有しない)。
 */

// ============================================================================
// テストヘルパー
// ============================================================================

function row(overrides: Partial<AnalysisRow> & { umaban: number }): AnalysisRow {
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
    ...overrides,
  };
}

function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function allCandidateRows(n: number): AnalysisRow[] {
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

/**
 * 簡易疑似乱数(シード固定・再現可能。Math.randomは使わない)。AC3の「複勝・ワイド・3連複が
 * すべてstake>0になる」入力を作るために使う——`fullOddsRecord`(全組合せ一律オッズ)では
 * 貪欲最適化が単一券種に丸ごと寄ってしまい(実測: 全組合せのEV・限界効用が完全に同値の
 * ため、券種間で競合せず1つが総取りする)、券種混在を再現できないことを事前にtsxで実測確認済み。
 */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** umabans(昇順)から comboSize の組合せを列挙し、[min,max)の範囲でばらけたオッズを割り当てる。 */
function variedOddsRecord(
  umabans: readonly number[],
  comboSize: number,
  min: number,
  max: number,
  seed: number,
): Record<string, number> {
  const rnd = mulberry32(seed);
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildComboOddsKey(combo)] = Math.round((min + rnd() * (max - min)) * 10) / 10;
  }
  return record;
}

/**
 * 8頭・複勝オッズも馬ごとに異なる・ワイド[3,25)/3連複[8,80)でばらけたオッズを持つ race。
 * 複勝・ワイド・3連複の3券種すべてがstake>0で選ばれることを事前にtsxで実測確認済み
 * (seed=7。AC3の「空振り防止」の根拠)。
 */
function raceWithDiverseCombos(): MixedCandidateBuildInput {
  const n = 8;
  const umabans = umabansOf(n);
  const placeOddsByUmaban = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
  return raceInput({
    rows: umabans.map((umaban, i) => row({ umaban, placeOddsMin: placeOddsByUmaban[i] })),
    wideCombo: variedOddsRecord(umabans, 2, 3, 25, 7),
    trioCombo: variedOddsRecord(umabans, 3, 8, 80, 107),
    comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
  });
}

describe("テストヘルパー自己テスト", () => {
  it("raceWithPositiveCombos(): 実際に混在配分(kind='mixed')に到達する入力であること(空振り防止)", () => {
    const { view } = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());
    expect(view.kind).toBe("mixed");
  });

  it("raceWithDiverseCombos(): 複勝・ワイド・3連複の3券種すべてがstake>0で配分されること(空振り防止)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(raceWithDiverseCombos(), settings());
    if (outcome.view.kind !== "mixed") {
      throw new Error(`前提が崩れている(mixedに到達しなかった。kind=${outcome.view.kind})`);
    }
    const lens = new Set(
      outcome.view.result.allocations.filter((a) => a.stake > 0).map((a) => a.umabans.length),
    );
    expect(lens).toEqual(new Set([1, 2, 3]));
  });
});

// ============================================================================
// toMixedAllocationSettings(6項目+evThreshold合成)
// ============================================================================

describe("toMixedAllocationSettings(#59 3節: evThresholdの二重ソースを避けるための合成)", () => {
  it("6項目のAnalysisAllocationSettingsにevThresholdを合成し、7項目のMixedAllocationSettingsになること", () => {
    const six: AnalysisAllocationSettings = {
      bankroll: 100000,
      perRaceCap: 10000,
      kellyFraction: 0.5,
      includeComboOdds: true,
      includeWideInAllocation: false,
      includeTrioInAllocation: true,
    };
    expect(toMixedAllocationSettings(six, 1.2)).toEqual({
      bankroll: 100000,
      perRaceCap: 10000,
      kellyFraction: 0.5,
      includeComboOdds: true,
      includeWideInAllocation: false,
      includeTrioInAllocation: true,
      evThreshold: 1.2,
    });
  });
});

// ============================================================================
// buildAllocationRecord: 経路ごとのメタ行(AC2相当・app層)
// ============================================================================

describe("buildAllocationRecord(経路ごとのメタ行)", () => {
  it("route=unset: coreの配分計算に未到達のため、設定エコー7項目以外はすべてnull", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: 0 }));
    expect(outcome.view.kind).toBe("unset"); // 前提固定(空振り防止)。
    const rec = buildAllocationRecord(outcome, settings({ bankroll: 0 }), "result");
    expect(rec.meta).toEqual({
      route: "unset",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 0,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0,
      includeComboOdds: true,
      includeWide: true,
      includeTrio: true,
      betUnit: null,
      greedySteps: null,
      candidateCap: null,
      modelId: null,
      modelApproximate: null,
      oddsStatus: "result",
    });
    expect(rec.bets).toEqual([]);
  });

  it("route=yoso: coreの配分計算に未到達のため、設定エコー7項目以外はすべてnull", () => {
    const race = raceWithPositiveCombos(8, { oddsStatus: "yoso" });
    const s = settings();
    const outcome = buildMixedRaceAllocationWithOutcome(race, s);
    expect(outcome.view.kind).toBe("yoso"); // 前提固定。
    const rec = buildAllocationRecord(outcome, s, "yoso");
    expect(rec.meta).toEqual({
      route: "yoso",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 300000,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0,
      includeComboOdds: true,
      includeWide: true,
      includeTrio: true,
      betUnit: null,
      greedySteps: null,
      candidateCap: null,
      modelId: null,
      modelApproximate: null,
      oddsStatus: "yoso",
    });
    expect(rec.bets).toEqual([]);
  });

  it("route=unavailable(頭数不可・D-2フォールバック経由): unavailableReason・fallbackReasonが非null、betUnit等はnull", () => {
    const race = raceInput({ rows: allCandidateRows(3) }); // 1〜4頭=not-sold
    const s = settings({ includeComboOdds: false });
    const outcome = buildMixedRaceAllocationWithOutcome(race, s);
    expect(outcome.view.kind).toBe("unavailable"); // 前提固定。
    const rec = buildAllocationRecord(outcome, s, "result");
    expect(rec.meta).toEqual({
      route: "unavailable",
      unavailableReason: "not-sold",
      fallbackReason: "combo-odds-not-requested",
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 300000,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0,
      includeComboOdds: false,
      includeWide: true,
      includeTrio: true,
      betUnit: null,
      greedySteps: null,
      candidateCap: null,
      modelId: null,
      modelApproximate: null,
      oddsStatus: "result",
    });
    expect(rec.bets).toEqual([]);
  });

  it("route=place-only(includeComboOdds=false): メタ行が全フィールドで固定どおりに保存され、明細のodds/evがresult.allocationsの値と一致すること", () => {
    const race = raceInput({ rows: allCandidateRows(8) });
    const s = settings({ includeComboOdds: false });
    const outcome = buildMixedRaceAllocationWithOutcome(race, s);
    if (outcome.view.kind !== "computed") {
      throw new Error(`前提が崩れている(place-onlyに到達しなかった。kind=${outcome.view.kind})`);
    }
    const rec = buildAllocationRecord(outcome, s, "result");
    // 要修正1(code-reviewer指摘): フィールド単位の部分検査ではなく、meta全体をtoEqualで固定する
    // (#59 AC2「部分検査は禁止」。#58でunavailableReasonが検査漏れした事故の再発防止)。
    expect(rec.meta).toEqual({
      route: "place-only",
      unavailableReason: null,
      fallbackReason: "combo-odds-not-requested",
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 300000,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0,
      includeComboOdds: false,
      includeWide: true,
      includeTrio: true,
      // #59追加指定: place-only経路はDEFAULT_BET_ALLOCATION_CONFIG(mixed用の
      // DEFAULT_GENERAL_BET_ALLOCATION_CONFIGとは別オブジェクト)を参照すること。
      betUnit: DEFAULT_BET_ALLOCATION_CONFIG.betUnit,
      greedySteps: DEFAULT_BET_ALLOCATION_CONFIG.greedySteps,
      candidateCap: null, // BetAllocationConfigにcandidateCapは存在しない。
      modelId: "conditional-bernoulli",
      modelApproximate: true,
      oddsStatus: "result",
    });
    // 前提固定: stake>0の明細が実際に1件以上あること(空振り防止)。
    const result = outcome.view.result;
    const stakePositive = result.allocations.filter((a) => a.stake > 0);
    expect(stakePositive.length).toBeGreaterThan(0);
    expect(rec.bets.length).toBe(stakePositive.length);
    for (const b of rec.bets) {
      expect(b.betType).toBe("place");
      expect(b.comboKey).toMatch(/^\d{2}$/);
      expect(b.stake).toBeGreaterThan(0);
    }
    // 要修正2(code-reviewer指摘): bets[].odds/evがplaceOddsMin/evと取り違えられていないことを、
    // result.allocationsの対応する要素の値と突き合わせて確認する(#59 AC3・#54が直接使うデータ)。
    // このfixture(row()の既定値)ではodds(placeOddsMin=3)とev(1.5)が異なる値のため、
    // 取り違え(odds:a.ev/ev:a.placeOddsMinのような入れ替え)があれば必ず検出できる。
    for (const a of stakePositive) {
      const bet = rec.bets.find((b) => b.comboKey === buildComboOddsKey([a.umaban]));
      expect(bet).toBeDefined();
      expect(bet!.odds).toBe(a.placeOddsMin);
      expect(bet!.ev).toBe(a.ev);
      expect(bet!.odds).not.toBe(bet!.ev); // 取り違えても値が同じでは検出できないための自己チェック。
    }
  });

  it("route=mixed: メタ行が全フィールドで固定どおりに保存されること", () => {
    const s = settings();
    const outcome = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), s);
    if (outcome.view.kind !== "mixed") {
      throw new Error(`前提が崩れている(mixedに到達しなかった。kind=${outcome.view.kind})`);
    }
    const rec = buildAllocationRecord(outcome, s, "result");
    // 要修正1(code-reviewer指摘): フィールド単位の部分検査ではなく、meta全体をtoEqualで固定する。
    expect(rec.meta).toEqual({
      route: "mixed",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: "present",
      comboOddsTrio: "present",
      bankroll: 300000,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0,
      includeComboOdds: true,
      includeWide: true,
      includeTrio: true,
      betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
      greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
      candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
      modelId: "conditional-bernoulli",
      modelApproximate: true,
      oddsStatus: "result",
    });
  });

  it("AC3: mixed経路でSUM(stake)===totalStake・COUNT(*)===betCountが成り立ち、bet_typeが複勝/ワイド/3連複それぞれ正しく振り分けられること", () => {
    const s = settings();
    const outcome = buildMixedRaceAllocationWithOutcome(raceWithDiverseCombos(), s);
    if (outcome.view.kind !== "mixed") {
      throw new Error("前提が崩れている(mixedに到達しなかった)");
    }
    const result = outcome.view.result;
    // 前提固定: 複勝・ワイド・3連複のいずれも1件以上stake>0で配分されていること
    // (raceWithDiverseCombos()の自己テストで既に固定済みだが、この検証自体でも再度固定する)。
    const stakePositiveByLen = new Map<number, number>();
    for (const a of result.allocations) {
      if (a.stake > 0) {
        stakePositiveByLen.set(a.umabans.length, (stakePositiveByLen.get(a.umabans.length) ?? 0) + 1);
      }
    }
    expect(stakePositiveByLen.get(1)).toBeGreaterThan(0);
    expect(stakePositiveByLen.get(2)).toBeGreaterThan(0);
    expect(stakePositiveByLen.get(3)).toBeGreaterThan(0);

    const rec = buildAllocationRecord(outcome, s, "result");
    expect(rec.bets.length).toBe(result.betCount);
    expect(rec.bets.reduce((sum, b) => sum + b.stake, 0)).toBe(result.totalStake);
    for (const b of rec.bets) {
      expect(b.stake).toBeGreaterThan(0);
      if (b.betType === "place") {
        expect(b.comboKey).toMatch(/^\d{2}$/);
      } else if (b.betType === "wide") {
        expect(b.comboKey).toMatch(/^\d{4}$/);
      } else if (b.betType === "trio") {
        expect(b.comboKey).toMatch(/^\d{6}$/);
      } else {
        throw new Error(`想定外のbetType: ${b.betType}`);
      }
    }
    // 3券種とも明細に現れること(前提のstakePositiveByLenと対応)。
    const betTypes = new Set(rec.bets.map((b) => b.betType));
    expect(betTypes).toEqual(new Set(["place", "wide", "trio"]));

    // 要修正2(code-reviewer指摘): mixedBetsOfのodds/evの取り違えを、result.allocationsの
    // 対応する要素の値と突き合わせて検出できることを固定する(#59 AC3・#54が直接使うデータ)。
    // このfixture(raceWithDiverseCombos)ではオッズが券種・馬ごとにばらけているため、
    // odds(a.odds)とev(a.ev)を入れ替えても値が一致し検出できない、という空振りは起きにくいが、
    // 万一同値になっていないかを自己チェックしたうえで、対応する要素の値と直接比較する。
    for (const a of result.allocations.filter((x) => x.stake > 0)) {
      const key = buildComboOddsKey(a.umabans);
      const bet = rec.bets.find((b) => b.comboKey === key);
      expect(bet).toBeDefined();
      expect(bet!.odds).toBe(a.odds);
      expect(bet!.ev).toBe(a.ev);
      expect(bet!.odds).not.toBe(bet!.ev); // 取り違えても値が同じでは検出できないための自己チェック。
    }
  });

  it("route=invalid: allocateGeneralBetsの契約違反throwを内部で捕捉した経路のメタ行が全フィールドで固定どおりに保存されること", () => {
    // allocation-outcome-codes.test.tsと同じ「1頭だけ負のオッズ」レシピでallocateGeneralBetsをthrowさせる。
    const rows = allCandidateRows(8).map((r) =>
      r.umaban === 1 ? row({ umaban: 1, placeOddsMin: -5, ev: 2, isPositive: true }) : r,
    );
    const s = settings();
    const outcome = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8, { rows }), s);
    expect(outcome.view.kind).toBe("invalid"); // 前提固定。
    const rec = buildAllocationRecord(outcome, s, "result");
    // 要修正1(code-reviewer指摘): フィールド単位の部分検査ではなく、meta全体をtoEqualで固定する。
    // これにより「...codesColumnsの展開後にunavailableReasonを誤って上書きする」類の
    // 分岐固有の破壊も検出できる(#58と同型の穴の再発防止)。
    expect(rec.meta).toEqual({
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      // 裁定1(allocation-outcome-codes.test.ts): buildMixedCandidatesはthrow前に実行済みのため
      // comboOddsは非null。
      skipReasonCode: null,
      comboOddsWide: "present",
      comboOddsTrio: "present",
      bankroll: 300000,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0,
      includeComboOdds: true,
      includeWide: true,
      includeTrio: true,
      betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
      greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
      candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
      modelId: null,
      modelApproximate: null,
      oddsStatus: "result",
    });
    expect(rec.bets).toEqual([]);
  });
});

// ============================================================================
// buildInvalidAllocationRecordForException(AC6: 呼び出し自体の例外に対するフォールバック)
// ============================================================================

describe("buildInvalidAllocationRecordForException(AC6: buildMixedRaceAllocationWithOutcome自体が例外を投げたときのフォールバック)", () => {
  it("route='invalid'・コード5列(unavailable/fallback/skip/comboOdds)はすべてnull・設定エコーは渡した値をそのまま反映・betUnit等はmixedと同じ既定値", () => {
    const s = settings({ bankroll: 123456, includeWideInAllocation: false });
    const rec = buildInvalidAllocationRecordForException(s, "middle");
    expect(rec.meta).toEqual({
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 123456,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0,
      includeComboOdds: true,
      includeWide: false,
      includeTrio: true,
      betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
      greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
      candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
      modelId: null,
      modelApproximate: null,
      oddsStatus: "middle",
    });
    expect(rec.bets).toEqual([]);
  });
});
