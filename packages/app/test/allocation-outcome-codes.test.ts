import { describe, expect, it } from "vitest";

import { buildComboOddsKey, type SkipReasonCode } from "@keiba/core/ev/combo-bet-allocation";

import type {
  AnalysisRow,
  ComboOddsFetchDiagnosticsView,
  ComboOddsFetchOutcomeView,
} from "../src/shared/analysis-types.js";
import type { ComboCandidateDiagnosticsView, MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  buildMixedRaceAllocationWithOutcome,
  comboOddsAvailabilityFromDiagnostics,
  type AllocationOutcomeCodes,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

/**
 * allocation-outcome-codes — Issue #58(#56-2)。見送り理由を「日本語文言」ではなく
 * 「文言を持たないコード」のタプル(route/fallbackReason/skipReasonCode/comboOdds)として
 * 復元できることを検証する。永続化(DB書き込み)自体は#59のスコープ。本ファイルは
 * `buildMixedRaceAllocationWithOutcome` が返すコードの正しさだけを検証する。
 */

// ============================================================================
// テストヘルパー(mixed-allocation-view.test.tsと同じ流儀。ヘルパーは自己テストする)
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
    ...overrides,
  };
}

/** n頭ぶんの馬番配列(1..n)。 */
function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** n頭立て・全馬EVプラス(複勝候補になる)行配列を作る。 */
function allCandidateRows(n: number): AnalysisRow[] {
  return umabansOf(n).map((umaban) => row({ umaban }));
}

/** n頭立て・全馬EVマイナス(複勝候補にならない)行配列を作る。 */
function allNonCandidateRows(n: number): AnalysisRow[] {
  return umabansOf(n).map((umaban) => row({ umaban, placeOddsMin: 1.1, ev: 0.5, isPositive: false }));
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

/** ComboOddsFetchOutcomeViewを組み立てる補助関数(診断値の中身はテストの関心事ではないため最小構成)。 */
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
 * AC1(boss訂正版)のタプル射影。`AllocationOutcomeCodes`の**全フィールド**を対象にする
 * (部分集合にしない)。`Object.keys(outcome)`から動的に組み立てることで、将来
 * `AllocationOutcomeCodes`にフィールドが増えても手動更新を忘れにくくする——実装側は
 * 型がrequiredなフィールドの省略をコンパイルエラーで弾くため(オブジェクトリテラルの
 * excess/missing property check)、`Object.keys`は常に完全なキー集合を返す。
 * 直後の自己テストは、この期待フィールド数(5)が実際の型と一致していることを固定する
 * (フィールドを増やしたとき気づけるようにするためのcanary。フィールドを足したら
 * そちらのexpect配列も更新すること)。
 */
function tupleOf(outcome: AllocationOutcomeCodes): string {
  const keys = (Object.keys(outcome) as (keyof AllocationOutcomeCodes)[]).sort();
  return JSON.stringify(keys.map((k) => outcome[k]));
}

describe("tupleOf()自己テスト(AC1訂正版: 射影がAllocationOutcomeCodesの全フィールドと一致すること)", () => {
  it("射影対象のキー集合が5個(comboOdds/fallbackReason/route/skipReasonCode/unavailableReason)であること", () => {
    const sample = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings()).outcome;
    const keys = Object.keys(sample).sort();
    // AllocationOutcomeCodesにフィールドを足したら、この配列も更新すること(canary)。
    expect(keys).toEqual(["comboOdds", "fallbackReason", "route", "skipReasonCode", "unavailableReason"]);
  });
});

describe("テストヘルパー自己テスト", () => {
  it("raceWithPositiveCombos(): 実際に混在配分(kind='mixed')に到達する入力であること(空振り防止)", () => {
    const { view } = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());
    expect(view.kind).toBe("mixed");
  });

  it("allNonCandidateRows(): 実際に複勝候補が0件になる入力であること(空振り防止)", () => {
    const race = raceInput({ rows: allNonCandidateRows(8) });
    const view = buildMixedRaceAllocation(race, settings({ includeComboOdds: false }));
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.skipReasonCode).toBe("no-candidates");
    }
  });
});

// ============================================================================
// comboOddsAvailabilityFromDiagnostics(純写像。診断値の判別共用体から直接テストする)
// ============================================================================

describe("comboOddsAvailabilityFromDiagnostics(診断値からの純写像。新しい判定を足さない)", () => {
  it("kind='not-requested' → 'not-requested'", () => {
    const diag: ComboCandidateDiagnosticsView = { kind: "not-requested" };
    expect(comboOddsAvailabilityFromDiagnostics(diag)).toBe("not-requested");
  });

  it("kind='yoso' → 'yoso'", () => {
    const diag: ComboCandidateDiagnosticsView = { kind: "yoso" };
    expect(comboOddsAvailabilityFromDiagnostics(diag)).toBe("yoso");
  });

  it("kind='built' & fieldPresence='absent' → 'unfetched'", () => {
    const diag: ComboCandidateDiagnosticsView = {
      kind: "built",
      fieldPresence: "absent",
      comboOddsState: "unknown",
      build: { enumeratedCount: 0, judged: { positiveCount: 0, notPositiveCount: 0 }, unjudged: { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 } },
    };
    expect(comboOddsAvailabilityFromDiagnostics(diag)).toBe("unfetched");
  });

  it("kind='built' & fieldPresence='empty' → 'empty'", () => {
    const diag: ComboCandidateDiagnosticsView = {
      kind: "built",
      fieldPresence: "empty",
      comboOddsState: "unknown",
      build: { enumeratedCount: 0, judged: { positiveCount: 0, notPositiveCount: 0 }, unjudged: { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 } },
    };
    expect(comboOddsAvailabilityFromDiagnostics(diag)).toBe("empty");
  });

  it("kind='built' & fieldPresence='present' → 'present'", () => {
    const diag: ComboCandidateDiagnosticsView = {
      kind: "built",
      fieldPresence: "present",
      comboOddsState: "available",
      build: { enumeratedCount: 1, judged: { positiveCount: 1, notPositiveCount: 0 }, unjudged: { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 } },
    };
    expect(comboOddsAvailabilityFromDiagnostics(diag)).toBe("present");
  });

  it("5つの入力それぞれが互いに異なる出力を持つこと(集合サイズで固定)", () => {
    const diags: ComboCandidateDiagnosticsView[] = [
      { kind: "not-requested" },
      { kind: "yoso" },
      { kind: "built", fieldPresence: "absent", comboOddsState: "unknown", build: { enumeratedCount: 0, judged: { positiveCount: 0, notPositiveCount: 0 }, unjudged: { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 } } },
      { kind: "built", fieldPresence: "empty", comboOddsState: "unknown", build: { enumeratedCount: 0, judged: { positiveCount: 0, notPositiveCount: 0 }, unjudged: { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 } } },
      { kind: "built", fieldPresence: "present", comboOddsState: "available", build: { enumeratedCount: 1, judged: { positiveCount: 1, notPositiveCount: 0 }, unjudged: { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 } } },
    ];
    const results = new Set(diags.map((d) => comboOddsAvailabilityFromDiagnostics(d)));
    expect(results.size).toBe(5);
  });
});

// ============================================================================
// AC1(boss訂正版): 全5フィールドのタプルだけで状態が区別できること
// ============================================================================

describe("AC1(訂正版): (route, unavailableReason, fallbackReason, skipReasonCode, comboOdds) の全5フィールドだけで状態が区別できること", () => {
  it("状態1: 総資金が未設定(層1のunset)。bankroll=0", () => {
    const { outcome } = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: 0 }));
    expect(outcome.route).toBe("unset");
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.fallbackReason).toBeNull();
    expect(outcome.skipReasonCode).toBeNull();
    expect(outcome.comboOdds).toBeNull();
  });

  it("状態2: 総資金が非有限(bankroll=NaN)。層1は素通りし、coreがbankroll-unsetと判定する(状態1とは別)", () => {
    const { outcome } = buildMixedRaceAllocationWithOutcome(
      raceWithPositiveCombos(8),
      settings({ bankroll: Number.NaN }),
    );
    // 前提固定: 混在経路(mixed)に実際に到達していること(D-2フォールバックに落ちていないこと)。
    expect(outcome.route).toBe("mixed");
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.skipReasonCode).toBe("bankroll-unset");
    expect(outcome.comboOdds).toEqual({ wide: "present", trio: "present" });
  });

  it("状態3: D-2フォールバック(組合せオッズ未取得)理由が復元できる。従来は捨てられていた診断値", () => {
    const race = raceInput({ rows: allCandidateRows(8) }); // wideCombo/trioComboともキー不在
    const { outcome, view } = buildMixedRaceAllocationWithOutcome(race, settings());
    // 前提固定: 実際にD-2フォールバック(place-only)に落ちていること。
    expect(outcome.route).toBe("place-only");
    expect(view.kind).toBe("computed");
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.fallbackReason).toBe("no-combo-candidates");
    expect(outcome.comboOdds).toEqual({ wide: "unfetched", trio: "unfetched" });
  });

  it("状態4: 正常な混在配分(オッズ取得済み・見送りなし)", () => {
    const { outcome } = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());
    expect(outcome.route).toBe("mixed");
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.fallbackReason).toBeNull();
    expect(outcome.skipReasonCode).toBeNull();
    expect(outcome.comboOdds).toEqual({ wide: "present", trio: "present" });
  });

  it("4状態(状態1〜4)のタプルが互いに異なること(集合サイズで機械的に固定)", () => {
    const cases: AllocationOutcomeCodes[] = [
      buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: 0 })).outcome,
      buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: Number.NaN })).outcome,
      buildMixedRaceAllocationWithOutcome(raceInput({ rows: allCandidateRows(8) }), settings()).outcome,
      buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings()).outcome,
    ];
    const tuples = new Set(cases.map(tupleOf));
    expect(tuples.size).toBe(4);
  });

  it("8状態(状態1〜4 + unavailableReasonの3値 + invalid)まで広げてもタプルが互いに異なること" +
    "(boss懸念2: route='invalid'のcomboOdds非null裁定が、unavailableReasonを加えたタプルでも一意性を壊さないことを確認する)", () => {
    const invalidRows = allCandidateRows(8).map((r) =>
      r.umaban === 1 ? row({ umaban: 1, placeOddsMin: -5, ev: 2, isPositive: true }) : r,
    );
    const cases: AllocationOutcomeCodes[] = [
      // 状態1〜4(上のケースと同一入力)。
      buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: 0 })).outcome,
      buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: Number.NaN })).outcome,
      buildMixedRaceAllocationWithOutcome(raceInput({ rows: allCandidateRows(8) }), settings()).outcome,
      buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings()).outcome,
      // unavailableReasonの3値(それぞれ別のfallbackReason経由)。
      buildMixedRaceAllocationWithOutcome(
        raceInput({ rows: allCandidateRows(3) }),
        settings({ includeComboOdds: false }),
      ).outcome,
      buildMixedRaceAllocationWithOutcome(
        raceInput({ rows: allCandidateRows(6) }),
        settings({ includeWideInAllocation: false, includeTrioInAllocation: false }),
      ).outcome,
      buildMixedRaceAllocationWithOutcome(raceInput({ rows: [] }), settings({ includeComboOdds: false })).outcome,
      // route='invalid'。
      buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8, { rows: invalidRows }), settings()).outcome,
    ];
    expect(cases.length).toBe(8);
    const tuples = new Set(cases.map(tupleOf));
    expect(tuples.size).toBe(8);
  });
});

// ============================================================================
// AC2: no-candidatesとno-edgeが潰れていないこと(app経路単体)
// ============================================================================

describe("AC2: no-candidatesとno-edgeがapp経路単体で別のskipReasonCodeとして観測できること", () => {
  it("no-candidates: 複勝候補0頭(EVマイナスのみ)は skipReasonCode='no-candidates' になること", () => {
    // includeComboOdds=false でD-2フォールバック(place-only)に入り、buildRaceAllocationが
    // そのまま返すBetAllocationResult.skipReasonCodeを観測する。
    const race = raceInput({ rows: allNonCandidateRows(8) });
    const { outcome } = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false }));
    expect(outcome.route).toBe("place-only");
    expect(outcome.skipReasonCode).toBe("no-candidates");
  });

  it("no-edge: 候補1頭・極小エッジ(placeOddsMin/evがともに1にほぼ等しい)は skipReasonCode='no-edge' になること" +
    "(貪欲法の連続最適解が丸めで0になる退化ケースを意図的に作る。他9頭はオッズ欠損で候補外にし単独候補にする)", () => {
    const rows: AnalysisRow[] = [
      row({ umaban: 1, adjustedProb: 0.0000001, placeOddsMin: 1.0000001, ev: 1.00000005, isPositive: true }),
      ...umabansOf(9).map((i) =>
        row({ umaban: i + 1, placeOddsMin: null, ev: null, isPositive: false }),
      ),
    ];
    const race = raceInput({ rows });
    const { outcome } = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false }));
    expect(outcome.route).toBe("place-only");
    expect(outcome.skipReasonCode).toBe("no-edge");
  });

  it("no-candidatesとno-edgeが異なる値であること(潰れていないことの直接証拠)", () => {
    const noCandidatesRace = raceInput({ rows: allNonCandidateRows(8) });
    const noEdgeRows: AnalysisRow[] = [
      row({ umaban: 1, adjustedProb: 0.0000001, placeOddsMin: 1.0000001, ev: 1.00000005, isPositive: true }),
      ...umabansOf(9).map((i) => row({ umaban: i + 1, placeOddsMin: null, ev: null, isPositive: false })),
    ];
    const noEdgeRace = raceInput({ rows: noEdgeRows });
    const a = buildMixedRaceAllocationWithOutcome(noCandidatesRace, settings({ includeComboOdds: false })).outcome;
    const b = buildMixedRaceAllocationWithOutcome(noEdgeRace, settings({ includeComboOdds: false })).outcome;
    expect(a.skipReasonCode).not.toBeNull();
    expect(b.skipReasonCode).not.toBeNull();
    expect(a.skipReasonCode).not.toBe(b.skipReasonCode);
  });
});

// ============================================================================
// fallbackReason: 3値それぞれが到達可能で、優先順位が既存の短絡順を保つこと
// ============================================================================

describe("fallbackReason: D-2フォールバックの3分岐が別々の値として観測できること", () => {
  it("① includeComboOdds=false → 'combo-odds-not-requested'", () => {
    const { outcome } = buildMixedRaceAllocationWithOutcome(
      raceWithPositiveCombos(8),
      settings({ includeComboOdds: false }),
    );
    expect(outcome.fallbackReason).toBe("combo-odds-not-requested");
  });

  it("② ワイド・3連複とも配分対象OFF → 'combo-bet-types-off'", () => {
    const { outcome } = buildMixedRaceAllocationWithOutcome(
      raceWithPositiveCombos(8),
      settings({ includeWideInAllocation: false, includeTrioInAllocation: false }),
    );
    expect(outcome.fallbackReason).toBe("combo-bet-types-off");
  });

  it("③ 組合せ候補の合計が0件 → 'no-combo-candidates'", () => {
    const race = raceInput({ rows: allCandidateRows(8) }); // wideCombo/trioComboキー不在→候補0件
    const { outcome } = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.fallbackReason).toBe("no-combo-candidates");
  });

  it("優先順位: ①②がともに真のとき①が優先されること(現行shouldFallbackBeforeBuildingCandidatesの短絡順を保つ)", () => {
    const { outcome } = buildMixedRaceAllocationWithOutcome(
      raceWithPositiveCombos(8),
      settings({ includeComboOdds: false, includeWideInAllocation: false, includeTrioInAllocation: false }),
    );
    expect(outcome.fallbackReason).toBe("combo-odds-not-requested");
  });

  it("3値が互いに異なること(集合サイズで固定)", () => {
    const r1 = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ includeComboOdds: false })).outcome.fallbackReason;
    const r2 = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ includeWideInAllocation: false, includeTrioInAllocation: false })).outcome.fallbackReason;
    const r3 = buildMixedRaceAllocationWithOutcome(raceInput({ rows: allCandidateRows(8) }), settings()).outcome.fallbackReason;
    expect(new Set([r1, r2, r3]).size).toBe(3);
  });
});

// ============================================================================
// 不変条件: (route, skipReasonCode) から「配分あり」と「core未到達」が一意に決まること
// ============================================================================

describe("不変条件(boss確定): route∈{unset,yoso,unavailable,invalid}ならcore未到達。route∈{place-only,mixed}∧skipReasonCode===nullなら配分あり", () => {
  /** サンプル群: 代表的な各ルートを実際にbuildMixedRaceAllocationWithOutcomeで作る。 */
  function sampleCases(): { readonly label: string; readonly outcome: AllocationOutcomeCodes; readonly isSkip: boolean | null }[] {
    const unset = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: 0 }));
    const yosoRace = raceInput({ rows: allCandidateRows(8), oddsStatus: "yoso" });
    const yosoResult = buildMixedRaceAllocationWithOutcome(yosoRace, settings());
    const unavailable = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: allCandidateRows(6) }), // 6頭(two-place-only)。includeComboOdds=falseでplace-onlyフォールバックへ
      settings({ includeComboOdds: false }),
    );
    const placeOnlySkipped = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: allNonCandidateRows(8) }),
      settings({ includeComboOdds: false }),
    );
    const placeOnlyAllocated = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: allCandidateRows(8) }),
      settings({ includeComboOdds: false }),
    );
    const mixedAllocated = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());
    const mixedSkipped = buildMixedRaceAllocationWithOutcome(
      raceWithPositiveCombos(8),
      settings({ bankroll: Number.NaN }),
    );

    function isSkipOf(view: ReturnType<typeof buildMixedRaceAllocationWithOutcome>["view"]): boolean | null {
      if (view.kind === "computed" || view.kind === "mixed") {
        return view.result.isSkip;
      }
      return null;
    }

    return [
      { label: "unset", outcome: unset.outcome, isSkip: isSkipOf(unset.view) },
      { label: "yoso", outcome: yosoResult.outcome, isSkip: isSkipOf(yosoResult.view) },
      { label: "unavailable", outcome: unavailable.outcome, isSkip: isSkipOf(unavailable.view) },
      { label: "place-only(skip)", outcome: placeOnlySkipped.outcome, isSkip: isSkipOf(placeOnlySkipped.view) },
      { label: "place-only(配分あり)", outcome: placeOnlyAllocated.outcome, isSkip: isSkipOf(placeOnlyAllocated.view) },
      { label: "mixed(配分あり)", outcome: mixedAllocated.outcome, isSkip: isSkipOf(mixedAllocated.view) },
      { label: "mixed(skip)", outcome: mixedSkipped.outcome, isSkip: isSkipOf(mixedSkipped.view) },
    ];
  }

  it("前提固定(空振り防止): サンプルが7ルート・route値の集合が最低4種を含むこと", () => {
    const cases = sampleCases();
    expect(cases.length).toBe(7);
    const routes = new Set(cases.map((c) => c.outcome.route));
    expect(routes.size).toBeGreaterThanOrEqual(4);
  });

  it("route∈{unset,yoso,unavailable}のときskipReasonCode===null(core未到達)であること", () => {
    const cases = sampleCases().filter((c) => ["unset", "yoso", "unavailable"].includes(c.outcome.route));
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      expect(c.outcome.skipReasonCode).toBeNull();
    }
  });

  it("route∈{place-only,mixed}のとき、skipReasonCode===null ⟺ isSkip===false(配分あり)であること", () => {
    const cases = sampleCases().filter((c) => c.outcome.route === "place-only" || c.outcome.route === "mixed");
    expect(cases.length).toBeGreaterThanOrEqual(4);
    // 前提固定: 少なくとも1件はskipReasonCode!==null、少なくとも1件はskipReasonCode===nullであること
    // (退化(全件同じ側)防止)。
    expect(cases.some((c) => c.outcome.skipReasonCode !== null)).toBe(true);
    expect(cases.some((c) => c.outcome.skipReasonCode === null)).toBe(true);
    for (const c of cases) {
      expect(c.isSkip).not.toBeNull();
      expect(c.outcome.skipReasonCode === null).toBe(c.isSkip === false);
    }
  });
});

// ============================================================================
// unavailableReason: PlaceBetUnavailableReason(not-sold/two-place-only/unknown)の復元
// (code-reviewer要修正1件・2026年: #31の核心〈判定不能と判定結果を混同しない〉を運ぶ
// フィールドが無防御だった)
// ============================================================================

describe("unavailableReason: route==='unavailable'のとき正しいPlaceBetUnavailableReasonに一致すること", () => {
  it("not-sold(1〜4頭): 3頭・includeComboOdds=falseでunavailableに落ちたとき'not-sold'になること", () => {
    const race = raceInput({ rows: allCandidateRows(3) });
    const { outcome } = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false }));
    // 前提固定(空振り防止): 実際にroute==='unavailable'に到達していること。
    expect(outcome.route).toBe("unavailable");
    expect(outcome.fallbackReason).toBe("combo-odds-not-requested");
    expect(outcome.unavailableReason).toBe("not-sold");
  });

  it("two-place-only(5〜7頭): 6頭・combo-bet-types-offでunavailableに落ちたとき'two-place-only'になること", () => {
    const race = raceInput({ rows: allCandidateRows(6) });
    const { outcome } = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ includeWideInAllocation: false, includeTrioInAllocation: false }),
    );
    expect(outcome.route).toBe("unavailable");
    expect(outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(outcome.unavailableReason).toBe("two-place-only");
  });

  it("unknown(0・負・非整数・非有限): 0頭・includeComboOdds=falseでunavailableに落ちたとき'unknown'になること", () => {
    const race = raceInput({ rows: [] });
    const { outcome } = buildMixedRaceAllocationWithOutcome(race, settings({ includeComboOdds: false }));
    expect(outcome.route).toBe("unavailable");
    expect(outcome.unavailableReason).toBe("unknown");
  });

  it("route==='unavailable' ∧ fallbackReason==='no-combo-candidates'(D-2条件③経由でunavailableに落ちる組み合わせ)を直接固定する", () => {
    // 6頭(two-place-only該当)・comboOdds/bet-typesはすべてON・wideCombo/trioComboはキー不在
    // (=候補0件)。条件①②はいずれもfalseなので、条件③(no-combo-candidates)経由で
    // buildRaceAllocationを呼び、そちらの頭数判定でunavailableになる。
    const race = raceInput({ rows: allCandidateRows(6) });
    const { outcome } = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(outcome.route).toBe("unavailable");
    expect(outcome.fallbackReason).toBe("no-combo-candidates");
    expect(outcome.unavailableReason).toBe("two-place-only");
  });

  it("3つのreasonが互いに異なること(#31の核心: not-sold/two-place-onlyという判定結果とunknownという判定不能を区別する)", () => {
    const notSold = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: allCandidateRows(3) }),
      settings({ includeComboOdds: false }),
    ).outcome.unavailableReason;
    const twoPlaceOnly = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: allCandidateRows(6) }),
      settings({ includeWideInAllocation: false, includeTrioInAllocation: false }),
    ).outcome.unavailableReason;
    const unknown = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: [] }),
      settings({ includeComboOdds: false }),
    ).outcome.unavailableReason;
    expect(new Set([notSold, twoPlaceOnly, unknown]).size).toBe(3);
  });

  it("route!=='unavailable'(unset/yoso/place-only/mixed)ではunavailableReasonが常にnullであること", () => {
    const unset = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings({ bankroll: 0 }));
    const yoso = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: allCandidateRows(8), oddsStatus: "yoso" }),
      settings(),
    );
    const placeOnly = buildMixedRaceAllocationWithOutcome(
      raceInput({ rows: allCandidateRows(8) }),
      settings({ includeComboOdds: false }),
    );
    const mixed = buildMixedRaceAllocationWithOutcome(raceWithPositiveCombos(8), settings());

    // 前提固定(空振り防止): 4件それぞれが狙ったrouteに実際に到達していること。
    expect(unset.outcome.route).toBe("unset");
    expect(yoso.outcome.route).toBe("yoso");
    expect(placeOnly.outcome.route).toBe("place-only");
    expect(mixed.outcome.route).toBe("mixed");

    for (const r of [unset, yoso, placeOnly, mixed]) {
      expect(r.outcome.unavailableReason).toBeNull();
    }
  });
});

// ============================================================================
// route==='invalid': comboOddsは非null(裁定1)
// ============================================================================

describe("route='invalid'(裁定1): buildMixedCandidatesはthrowの前に実行済みなのでcomboOddsは非null", () => {
  it("allocateGeneralBetsが契約違反でthrowしたレースは、route='invalid'かつcomboOddsが非nullであること", () => {
    // buildPlaceCandidatesはplaceOddsMin<=0を弾かない(AC17のJSDoc参照)。1頭だけ負のオッズを
    // 混入させ、allocateGeneralBets内部のvalidateCandidatesにthrowさせる。他の7頭・組合せ
    // オッズは正常に用意し、comboCandidateCount>0(=D-2フォールバック非該当)を満たしたうえで
    // 実際にtryブロックへ到達させる(空振り防止。事前にtsxで実測しthrowを確認済み)。
    const rows = allCandidateRows(8).map((r) =>
      r.umaban === 1 ? row({ umaban: 1, placeOddsMin: -5, ev: 2, isPositive: true }) : r,
    );
    const race = raceWithPositiveCombos(8, { rows });
    const { outcome, view } = buildMixedRaceAllocationWithOutcome(race, settings());
    expect(view.kind).toBe("invalid");
    expect(outcome.route).toBe("invalid");
    // 裁定1: buildMixedCandidatesはthrowの前(mixed.diagnostics構築時点)で既に実行済みのため、
    // 「オッズが取得できていたか」という事実は判定済みである。comboOddsをnullにすると
    // 「判定していない」という誤った記録になる(#31が禁じる方向)ため非nullになること。
    expect(outcome.comboOdds).toEqual({ wide: "present", trio: "present" });
    expect(outcome.skipReasonCode).toBeNull();
    expect(outcome.fallbackReason).toBeNull();
  });
});
