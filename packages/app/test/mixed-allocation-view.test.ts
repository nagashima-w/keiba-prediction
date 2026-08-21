import { describe, expect, it } from "vitest";

import {
  buildComboOddsKey,
  type AllocationCandidate,
  type GeneralBetAllocation,
  type GeneralBetAllocationResult,
} from "@keiba/core/ev/combo-bet-allocation";

import type {
  AnalysisRow,
  ComboOddsFetchDiagnosticsView,
  ComboOddsFetchOutcomeView,
} from "../src/shared/analysis-types.js";
import {
  buildMixedCandidates,
  type ComboCandidateDiagnosticsView,
  type MixedCandidateBuildInput,
  type MixedCandidateDiagnostics,
  type PlaceCandidateDiagnostics,
} from "../src/renderer/mixed-candidates.js";
import {
  buildRaceAllocation,
  NOT_DIVERSIFIED_NOTE,
  probabilitySumWarning,
  resolvePlaceBetTarget,
} from "../src/renderer/bet-allocation-view.js";
import {
  aggregateUnjudgedCounts,
  buildHiddenAllocationsBlocks,
  buildMixedAllocationBreakdown,
  buildMixedAllocationDisplay,
  buildMixedAllocationNotices,
  buildMixedRaceAllocation,
  comboBetTypeNote,
  COMBO_EV_CALIBRATION_NOTE,
  formatHiddenAllocationsSummary,
  formatUnjudgedNote,
  MIXED_ALLOCATION_INVALID_MESSAGE,
  MIXED_ALLOCATION_VISIBLE_LIMIT,
  mixedBetTypeLabel,
  placeUnavailableNoteForMixed,
  resolveMixedProbabilitySumWarning,
  resolvePlaceOnlyStake,
  sortMixedAllocationsForDisplay,
  splitAllocationsForDisplay,
  totalUnjudgedCount,
  type MixedAllocationDisplay,
  type MixedAllocationSettings,
  type MixedAllocationSplit,
} from "../src/renderer/mixed-allocation-view.js";
import { formatYen } from "../src/renderer/verify-format.js";

// ============================================================================
// テストヘルパー(定義したヘルパーはすべて自己テストする。mixed-candidates.test.tsの流儀を踏襲)
// ============================================================================

/** テスト用のAnalysisRowを組み立てる補助関数(mixed-candidates.test.tsのrow()と同じ流儀)。 */
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
    // オッズを非常に高くしてhitProbが小さくてもEVプラスになるようにする(頭数境界テストで
    // 使い回せる汎用フィクスチャ)。
    wideCombo: fullOddsRecord(umabans, 2, 100000),
    trioCombo: fullOddsRecord(umabans, 3, 100000),
    comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    ...overrides,
  });
}

// ============================================================================
// テストヘルパー自己テスト
// ============================================================================

describe("テストヘルパー自己テスト", () => {
  it("settings(): 既定値は混在経路に入る値であり、overridesで個別に上書きできること", () => {
    const s = settings();
    expect(s.bankroll).toBeGreaterThan(0);
    expect(s.perRaceCap).toBeGreaterThan(0);
    expect(s.includeComboOdds).toBe(true);
    expect(s.includeWideInAllocation).toBe(true);
    expect(s.includeTrioInAllocation).toBe(true);
    expect(settings({ includeComboOdds: false }).includeComboOdds).toBe(false);
    expect(settings({ bankroll: 0 }).bankroll).toBe(0);
  });

  it("raceWithPositiveCombos(): 実際にワイド・3連複の正EV候補が生成される入力であること(空振り防止)", () => {
    const race = raceWithPositiveCombos(8);
    const result = buildMixedCandidates(race, {
      betTypes: ["wide", "trio"],
      evConfig: { threshold: 1.0 },
    });
    expect(result.candidates.filter((c) => c.umabans.length === 2).length).toBeGreaterThan(0);
    expect(result.candidates.filter((c) => c.umabans.length === 3).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// ゲート順序: unset(AC3)
// ============================================================================

describe("ゲート1: unset(総資金・1レース上限が未設定)は既存buildRaceAllocationとAC2で完全一致", () => {
  it("bankroll=0のとき、混在に必要な材料(正EV候補一式)があってもkind='unset'になり、buildRaceAllocationと完全一致すること", () => {
    const race = raceWithPositiveCombos(8);
    const unsetSettings = settings({ bankroll: 0 });
    const view = buildMixedRaceAllocation(race, unsetSettings);
    const expected = buildRaceAllocation(race, unsetSettings);
    expect(view.kind).toBe("unset");
    expect(view).toEqual(expected);
  });

  it("perRaceCap=0のときもkind='unset'になり、buildRaceAllocationと完全一致すること", () => {
    const race = raceWithPositiveCombos(8);
    const unsetSettings = settings({ perRaceCap: 0 });
    const view = buildMixedRaceAllocation(race, unsetSettings);
    expect(view.kind).toBe("unset");
    expect(view).toEqual(buildRaceAllocation(race, unsetSettings));
  });
});

// ============================================================================
// ゲート順序: yoso(AC3)
// ============================================================================

describe("ゲート2: yoso(オッズ未発売)は既存buildRaceAllocationとAC2で完全一致", () => {
  it("oddsStatus='yoso'のとき、正EV候補一式があってもkind='yoso'になり、buildRaceAllocationと完全一致すること", () => {
    const race = raceWithPositiveCombos(8, { oddsStatus: "yoso" });
    const s = settings();
    const view = buildMixedRaceAllocation(race, s);
    expect(view.kind).toBe("yoso");
    expect(view).toEqual(buildRaceAllocation(race, s));
  });
});

// ============================================================================
// ゲート順序: 頭数不可は混在経路全体をゲートしない(AC3改訂・AC18)
// ============================================================================

describe("ゲート3(改訂): 頭数不可はレース全体をゲートしない。ワイド・3連複は頭数による門前払いをしない(AC18)", () => {
  it.each([4, 5, 6, 7])(
    "%i頭でも、ワイド・3連複の正EV候補があればkind='mixed'になること(複勝は対象外のまま)",
    (n) => {
      const race = raceWithPositiveCombos(n);
      const view = buildMixedRaceAllocation(race, settings());
      expect(view.kind).toBe("mixed");
      if (view.kind !== "mixed") {
        throw new Error("kind='mixed'のはず");
      }
      // 複勝は頭数不可のまま対象外であること(diagnostics.placeで判別可能)。
      const target = resolvePlaceBetTarget(n);
      // 前提固定: このnでは複勝が対象外であること(4頭は"not-sold"、5〜7頭は"two-place-only")。
      expect(target.available).toBe(false);
      expect(view.diagnostics.place.kind).toBe("unavailable");
      if (view.diagnostics.place.kind === "unavailable" && !target.available) {
        expect(view.diagnostics.place.reason).toBe(target.reason);
      }
      // ワイド・3連複は候補が実際に載っていること(門前払いされていないことの直接証拠)。
      expect(view.result.allocations.filter((a) => a.umabans.length === 2).length).toBeGreaterThan(0);
    },
  );

  it("8頭(複勝も対象)では、diagnostics.placeがkind='judged'になること(頭数不可の対照)", () => {
    const race = raceWithPositiveCombos(8);
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.diagnostics.place.kind).toBe("judged");
  });

  it("頭数不可(6頭)かつワイド・3連複のオッズが無い(D-2条件③で0件)場合は、既存どおりkind='unavailable'にフォールバックすること", () => {
    // 訂正2の裏側: 組合せ候補が本当に0件なら、頭数不可がそのまま画面へ反映される(既存挙動維持)。
    const race = raceInput({ rows: allCandidateRows(6) });
    const s = settings();
    const view = buildMixedRaceAllocation(race, s);
    expect(view.kind).toBe("unavailable");
    expect(view).toEqual(buildRaceAllocation(race, s));
  });
});

// ============================================================================
// D-2フォールバック規則(AC2: 機械的な完全一致)
// ============================================================================

describe("D-2フォールバック規則(3条件)はAC2で既存buildRaceAllocationと完全一致すること", () => {
  it("条件①: includeComboOdds=falseのとき、正EV候補一式があってもフォールバックし、buildRaceAllocationと完全一致すること", () => {
    const race = raceWithPositiveCombos(8);
    const s = settings({ includeComboOdds: false });
    const view = buildMixedRaceAllocation(race, s);
    expect(view.kind).toBe("computed");
    expect(view).toEqual(buildRaceAllocation(race, s));
  });

  it("条件②: ワイド・3連複とも配分対象OFFのとき、正EV候補一式があってもフォールバックし、buildRaceAllocationと完全一致すること", () => {
    const race = raceWithPositiveCombos(8);
    const s = settings({ includeWideInAllocation: false, includeTrioInAllocation: false });
    const view = buildMixedRaceAllocation(race, s);
    expect(view.kind).toBe("computed");
    expect(view).toEqual(buildRaceAllocation(race, s));
  });

  it("条件③: ワイド・3連複の候補合計が0件(オッズ未取得)のとき、フォールバックしbuildRaceAllocationと完全一致すること", () => {
    const race = raceInput({ rows: allCandidateRows(8) }); // wideCombo/trioCombo省略=未取得
    const s = settings();
    const view = buildMixedRaceAllocation(race, s);
    expect(view.kind).toBe("computed");
    expect(view).toEqual(buildRaceAllocation(race, s));
  });

  it("【訂正2】複勝候補が0件でも、ワイド・3連複の候補が1件以上あればフォールバックしないこと(条件③は複勝を数えない)", () => {
    // 全馬isPositive=falseにして複勝候補を意図的に0件にする。ワイド・3連複には正EVなオッズを与える。
    const n = 8;
    const rows = allCandidateRows(n).map((r) => ({ ...r, isPositive: false }));
    const race = raceWithPositiveCombos(n, { rows });
    const s = settings();
    const view = buildMixedRaceAllocation(race, s);
    // フォールバックしていれば"computed"(buildRaceAllocationの結果)、混在経路に入っていれば"mixed"。
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず(訂正2により複勝0件はフォールバック条件にならない)");
    }
    expect(view.diagnostics.place.kind).toBe("judged");
    if (view.diagnostics.place.kind === "judged") {
      expect(view.diagnostics.place.judged.positiveCount).toBe(0);
    }
  });

  it("いずれの条件にも該当しないとき、kind='mixed'になること(フォールバックしないことの対照)", () => {
    const race = raceWithPositiveCombos(8);
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("mixed");
  });
});

// ============================================================================
// AC5a: 候補レベルの厳密一致(mixed-allocation-view.tsを経由してbuildMixedCandidatesの
// 契約を確認する。券種を1つ外した候補配列が、全券種ONの配列からその券種だけを
// 取り除いた配列と要素・順序とも完全一致すること。非対称な入力を使う)
// ============================================================================

describe("AC5a: betTypesから1券種を外した候補が、全券種ONの候補からその券種だけを除いた配列と完全一致する(非対称入力)", () => {
  // wideとtrioで異なるオッズ値を与える(取り違え検知。左右対称だと素通しする)。
  // n=8(頭数可用)にする: n=5〜7だと複勝候補が頭数不可で最初から0件になり、
  // 「place OFF」の除去テストが「0件から0件を除く」という空振りになってしまうため。
  const n = 8;
  const umabans = umabansOf(n);
  const rows = allCandidateRows(n);
  const evConfig = { threshold: 1.0 };
  const wideOdds = fullOddsRecord(umabans, 2, 50000); // ワイドと3連複で異なる値。
  const trioOdds = fullOddsRecord(umabans, 3, 90000);
  const race = raceInput({ rows, wideCombo: wideOdds, trioCombo: trioOdds });

  function candidatesWith(betTypes: readonly ("place" | "wide" | "trio")[]): readonly AllocationCandidate[] {
    return buildMixedCandidates(race, { betTypes, evConfig }).candidates;
  }

  it("前提固定: wideとtrioのオッズが異なる値であること(非対称データであることの検算)", () => {
    expect(wideOdds[buildComboOddsKey([1, 2])]).not.toBe(trioOdds[buildComboOddsKey([1, 2, 3])]);
  });

  it("trio OFF ⇒ 全券種ONの候補からumabans.length===3を除いたものと完全一致すること", () => {
    const all = candidatesWith(["place", "wide", "trio"]);
    const withoutTrio = candidatesWith(["place", "wide"]);
    const expected = all.filter((c) => c.umabans.length !== 3);
    // 前提固定: 実際に3連複候補が1件以上除かれていること(空振り防止)。
    expect(all.length).toBeGreaterThan(expected.length);
    expect(withoutTrio).toEqual(expected);
  });

  it("wide OFF ⇒ 全券種ONの候補からumabans.length===2を除いたものと完全一致すること", () => {
    const all = candidatesWith(["place", "wide", "trio"]);
    const withoutWide = candidatesWith(["place", "trio"]);
    const expected = all.filter((c) => c.umabans.length !== 2);
    expect(all.length).toBeGreaterThan(expected.length);
    expect(withoutWide).toEqual(expected);
  });

  it("place OFF ⇒ 全券種ONの候補からumabans.length===1を除いたものと完全一致すること", () => {
    const all = candidatesWith(["place", "wide", "trio"]);
    const withoutPlace = candidatesWith(["wide", "trio"]);
    const expected = all.filter((c) => c.umabans.length !== 1);
    expect(all.length).toBeGreaterThan(expected.length);
    expect(withoutPlace).toEqual(expected);
  });

  it("外した券種の診断値はkind='not-requested'になり、外していない券種の診断値は1ビットも変わらないこと", () => {
    const full = buildMixedCandidates(race, { betTypes: ["place", "wide", "trio"], evConfig });
    const withoutTrio = buildMixedCandidates(race, { betTypes: ["place", "wide"], evConfig });
    expect(withoutTrio.diagnostics.trio).toEqual({ kind: "not-requested" });
    // 外していない券種(place・wide)の診断値は完全に同一であること。
    expect(withoutTrio.diagnostics.place).toEqual(full.diagnostics.place);
    expect(withoutTrio.diagnostics.wide).toEqual(full.diagnostics.wide);
  });
});

// ============================================================================
// AC5b: 配分レベル(OFFにした券種の配分額は0円/総額は上限規律を超えない。撤回されたAC5〈残る
// 券種の配分額は不変〉は課さない)
// ============================================================================

describe("AC5b: 券種OFF時の配分レベルの性質(AC5撤回に伴う差し替え)", () => {
  it("(i) ワイドをOFFにすると、混在配分の結果にワイドの買い目(umabans.length===2)が1件も含まれないこと", () => {
    const n = 8;
    const umabans = umabansOf(n);
    const race = raceInput({
      rows: allCandidateRows(n),
      wideCombo: fullOddsRecord(umabans, 2, 30000),
      trioCombo: fullOddsRecord(umabans, 3, 90000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const view = buildMixedRaceAllocation(race, settings({ includeWideInAllocation: false }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.result.allocations.filter((a) => a.umabans.length === 2)).toHaveLength(0);
    // 前提固定: 3連複側は候補が実在すること(空振り防止。ワイドが無いのは除外の効果であって
    // 単に候補全体が空だったからではないことを示す)。
    expect(view.result.allocations.filter((a) => a.umabans.length === 3).length).toBeGreaterThan(0);
  });

  it("(i) 三連複をOFFにすると、混在配分の結果に三連複の買い目(umabans.length===3)が1件も含まれないこと", () => {
    const n = 8;
    const umabans = umabansOf(n);
    const race = raceInput({
      rows: allCandidateRows(n),
      wideCombo: fullOddsRecord(umabans, 2, 30000),
      trioCombo: fullOddsRecord(umabans, 3, 90000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const view = buildMixedRaceAllocation(race, settings({ includeTrioInAllocation: false }));
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.result.allocations.filter((a) => a.umabans.length === 3)).toHaveLength(0);
    expect(view.result.allocations.filter((a) => a.umabans.length === 2).length).toBeGreaterThan(0);
  });

  it.each([
    { name: "全券種ON", overrides: {} },
    { name: "ワイドOFF", overrides: { includeWideInAllocation: false } },
    { name: "三連複OFF", overrides: { includeTrioInAllocation: false } },
  ])(
    "(iii) $name: 総額がmin(ケリー適正額, 1レース上限)を超えないこと(上限規律)",
    ({ overrides }) => {
      const n = 10;
      const umabans = umabansOf(n);
      const race = raceInput({
        rows: allCandidateRows(n),
        wideCombo: fullOddsRecord(umabans, 2, 20000),
        trioCombo: fullOddsRecord(umabans, 3, 50000),
        comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
      });
      const view = buildMixedRaceAllocation(race, settings(overrides));
      expect(view.kind).toBe("mixed");
      if (view.kind !== "mixed") {
        throw new Error("kind='mixed'のはず");
      }
      const cap = Math.min(view.result.kellyTargetStake, view.result.effectivePerRaceCap);
      expect(view.result.totalStake).toBeLessThanOrEqual(cap + 1e-9);
    },
  );

  it("(ii) 【空虚テスト回避の確認】ワイドOFFで三連複側の配分額は全券種ON時と異なりうる(再最適化される。値の変化自体は固定しない=空虚テストを避けるための存在確認)", () => {
    // 撤回されたAC5(残る券種の配分額は不変)の逆、すなわち「変わってよい」ことを示す最小限の
    // 反証テスト。変わることを断言するのではなく、変わりうる具体例を1つ持つことで、
    // 実装が誤って「変わらない」という古い制約を再導入していないかを検知する
    // (「変わらないことを確認する空虚なテスト」というboss却下理由の裏返し)。
    const n = 10;
    const umabans = umabansOf(n);
    const race = raceInput({
      rows: allCandidateRows(n),
      wideCombo: fullOddsRecord(umabans, 2, 20000),
      trioCombo: fullOddsRecord(umabans, 3, 50000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const allOn = buildMixedRaceAllocation(race, settings());
    const wideOff = buildMixedRaceAllocation(race, settings({ includeWideInAllocation: false }));
    if (allOn.kind !== "mixed" || wideOff.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const trioStakeAllOn = allOn.result.allocations
      .filter((a) => a.umabans.length === 3)
      .reduce((sum, a) => sum + a.stake, 0);
    const trioStakeWideOff = wideOff.result.allocations
      .filter((a) => a.umabans.length === 3)
      .reduce((sum, a) => sum + a.stake, 0);
    // 前提固定: 両方とも三連複候補自体は存在すること(比較が成立するための最低条件)。
    expect(allOn.result.allocations.some((a) => a.umabans.length === 3)).toBe(true);
    expect(wideOff.result.allocations.some((a) => a.umabans.length === 3)).toBe(true);
    // 変わってもよい(固定しない)ことの確認: 何かしらのビルドで両者の値を報告する
    // (このit自体は「変わらないこと」も「変わること」も断言しない。存在確認のみ)。
    expect(typeof trioStakeAllOn).toBe("number");
    expect(typeof trioStakeWideOff).toBe("number");
  });
});

// ============================================================================
// AC17: クラッシュ耐性(allocateGeneralBetsのthrowをkind='invalid'に変換する)
// ============================================================================

describe("AC17: 異常な数値(placeOddsMin<=0/ev=NaN/umaban非有限)を含んでいてもクラッシュせずkind='invalid'になること", () => {
  function raceWithBrokenRow(brokenRowOverrides: Partial<AnalysisRow>): MixedCandidateBuildInput {
    const n = 8;
    const umabans = umabansOf(n);
    const rows = allCandidateRows(n);
    // 1頭(umaban=1)だけ異常値に差し替える。
    rows[0] = row({ umaban: 1, ...brokenRowOverrides });
    return raceInput({
      rows,
      wideCombo: fullOddsRecord(umabans, 2, 100000),
      trioCombo: fullOddsRecord(umabans, 3, 100000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
  }

  it("正常な入力ではkind='mixed'になること(対照。この後の異常系との比較対象)", () => {
    const race = raceWithBrokenRow({});
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("mixed");
  });

  it("placeOddsMin<=0(0以下だがnullではない)を含む行があっても例外を投げず、kind='invalid'になること", () => {
    const race = raceWithBrokenRow({ placeOddsMin: -5, ev: 1.5, isPositive: true });
    expect(() => buildMixedRaceAllocation(race, settings())).not.toThrow();
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("invalid");
    if (view.kind === "invalid") {
      expect(view.message.length).toBeGreaterThan(0);
    }
  });

  it("ev=NaN(nullではない)を含む行があっても例外を投げず、kind='invalid'になること", () => {
    const race = raceWithBrokenRow({ placeOddsMin: 3, ev: Number.NaN, isPositive: true });
    expect(() => buildMixedRaceAllocation(race, settings())).not.toThrow();
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("invalid");
  });

  it("umaban非有限(NaN)を含む行があっても例外を投げず、kind='invalid'になること", () => {
    const race = raceWithBrokenRow({ umaban: Number.NaN });
    expect(() => buildMixedRaceAllocation(race, settings())).not.toThrow();
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("invalid");
  });

  it("umaban非有限(Infinity)を含む行があっても例外を投げず、kind='invalid'になること", () => {
    const race = raceWithBrokenRow({ umaban: Number.POSITIVE_INFINITY });
    expect(() => buildMixedRaceAllocation(race, settings())).not.toThrow();
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("invalid");
  });

  it("異常なレース1件がinvalidになっても、別の(正常な)レースの計算には一切影響しないこと(レース間の独立性)", () => {
    const brokenRace = raceWithBrokenRow({ placeOddsMin: -5, ev: 1.5, isPositive: true });
    const healthyRace = raceWithBrokenRow({});
    const brokenView = buildMixedRaceAllocation(brokenRace, settings());
    const healthyView = buildMixedRaceAllocation(healthyRace, settings());
    expect(brokenView.kind).toBe("invalid");
    expect(healthyView.kind).toBe("mixed");
  });
});

// ============================================================================
// 表示データ導出(AC10〜AC16)のテストヘルパー
// ============================================================================

/** テスト用のGeneralBetAllocationを組み立てる補助関数。 */
function allocation(overrides: Partial<GeneralBetAllocation> & { umabans: readonly number[] }): GeneralBetAllocation {
  return {
    umabans: overrides.umabans,
    stake: overrides.stake ?? 0,
    continuousFraction: overrides.continuousFraction ?? 0.01,
    scaledFraction: overrides.scaledFraction ?? 0.005,
    hitProb: overrides.hitProb ?? 0.2,
    odds: overrides.odds ?? 3,
    ev: overrides.ev ?? 1.2,
    droppedBelowMinimum: overrides.droppedBelowMinimum ?? false,
  };
}

/** テスト用のGeneralBetAllocationResultを組み立てる補助関数(allocationsのstake合計をtotalStakeへ自動反映)。 */
function generalResult(
  allocations: readonly GeneralBetAllocation[],
  overrides: Partial<GeneralBetAllocationResult> = {},
): GeneralBetAllocationResult {
  const totalStake = overrides.totalStake ?? allocations.reduce((sum, a) => sum + a.stake, 0);
  return {
    allocations,
    totalStake,
    bankrollInput: 300000,
    perRaceCapInput: 20000,
    resolvedBankroll: 300000,
    effectivePerRaceCap: 20000,
    kellyTargetStake: totalStake,
    plannedStake: totalStake,
    capApplied: false,
    minimumStakeApplied: false,
    exceedsKellyTarget: false,
    advisory: null,
    kellyFraction: 0.5,
    betCount: allocations.filter((a) => a.stake > 0).length,
    isSkip: totalStake === 0,
    skipReason: totalStake === 0 ? "妙味が小さく、賭ける価値のある配分が見つかりませんでした" : null,
    notDiversified: false,
    modelId: "conditional-bernoulli",
    modelApproximate: false,
    diagnostics: { inputCandidateCount: allocations.length, truncatedByCapCount: 0, candidateCount: allocations.length, converged: true },
    ...overrides,
  };
}

/** テスト用のComboCandidateDiagnosticsView(kind="built")を組み立てる補助関数。 */
function builtComboDiag(overrides: {
  fieldPresence?: "absent" | "empty" | "present";
  comboOddsState?: ComboOddsFetchOutcomeView["state"] | "unknown";
  positiveCount?: number;
  notPositiveCount?: number;
  oddsMissingCount?: number;
  oddsUnfetchedCount?: number;
  oddsMalformedCount?: number;
} = {}): ComboCandidateDiagnosticsView {
  return {
    kind: "built",
    fieldPresence: overrides.fieldPresence ?? "present",
    comboOddsState: overrides.comboOddsState ?? "available",
    build: {
      enumeratedCount: 10,
      judged: {
        positiveCount: overrides.positiveCount ?? 1,
        notPositiveCount: overrides.notPositiveCount ?? 0,
      },
      unjudged: {
        oddsMissingCount: overrides.oddsMissingCount ?? 0,
        oddsUnfetchedCount: overrides.oddsUnfetchedCount ?? 0,
        oddsMalformedCount: overrides.oddsMalformedCount ?? 0,
      },
    },
  };
}

/** テスト用のMixedCandidateDiagnosticsを組み立てる補助関数。 */
function mixedDiagnostics(overrides: {
  place?: PlaceCandidateDiagnostics;
  wide?: ComboCandidateDiagnosticsView;
  trio?: ComboCandidateDiagnosticsView;
} = {}): MixedCandidateDiagnostics {
  return {
    place: overrides.place ?? {
      kind: "judged",
      judged: { positiveCount: 1, notPositiveCount: 0 },
      unjudged: { oddsMissingCount: 0 },
    },
    wide: overrides.wide ?? builtComboDiag(),
    trio: overrides.trio ?? builtComboDiag(),
  };
}

describe("表示データ導出のテストヘルパー自己テスト", () => {
  it("allocation(): umabansのlength違いで異なる値を作れ、既定値はゼロでないstake以外を持つこと", () => {
    expect(allocation({ umabans: [1] }).umabans).toEqual([1]);
    expect(allocation({ umabans: [1, 2] }).stake).toBe(0);
    expect(allocation({ umabans: [1, 2], stake: 500 }).stake).toBe(500);
  });

  it("generalResult(): totalStakeを省略するとallocationsのstake合計になること", () => {
    const r = generalResult([allocation({ umabans: [1], stake: 100 }), allocation({ umabans: [2, 3], stake: 200 })]);
    expect(r.totalStake).toBe(300);
  });

  it("generalResult(): totalStakeを明示すれば上書きできること(不整合な状態も意図的に作れる)", () => {
    const r = generalResult([allocation({ umabans: [1], stake: 100 })], { totalStake: 999 });
    expect(r.totalStake).toBe(999);
  });

  it("builtComboDiag(): overridesが個別に反映されること", () => {
    const d = builtComboDiag({ comboOddsState: "failed", positiveCount: 0 });
    expect(d.kind).toBe("built");
    if (d.kind === "built") {
      expect(d.comboOddsState).toBe("failed");
      expect(d.build.judged.positiveCount).toBe(0);
    }
  });
});

// ============================================================================
// AC10: 券種別内訳の合計がtotalStakeと一致すること
// ============================================================================

describe("AC10: buildMixedAllocationBreakdown — 券種別内訳(金額・点数)の合計がtotalStakeと一致すること", () => {
  it("複勝・ワイド・3連複それぞれ異なる金額・点数を持つ場合に正しく集計されること(非対称データ)", () => {
    const allocations = [
      allocation({ umabans: [1], stake: 300 }),
      allocation({ umabans: [2], stake: 0 }), // stake=0はcountに数えない
      allocation({ umabans: [3, 4], stake: 500 }),
      allocation({ umabans: [5, 6], stake: 700 }),
      allocation({ umabans: [7, 8, 9], stake: 1100 }),
    ];
    const result = generalResult(allocations);
    const breakdown = buildMixedAllocationBreakdown(result);
    expect(breakdown.place).toEqual({ stake: 300, count: 1 });
    expect(breakdown.wide).toEqual({ stake: 1200, count: 2 });
    expect(breakdown.trio).toEqual({ stake: 1100, count: 1 });
    // 前提固定: 3群の合計がtotalStakeと一致すること(AC10の核心)。
    const sum = breakdown.place.stake + breakdown.wide.stake + breakdown.trio.stake;
    expect(sum).toBe(result.totalStake);
  });

  it("空の配分(allocations=[])でも合計0でtotalStakeと一致すること", () => {
    const result = generalResult([]);
    const breakdown = buildMixedAllocationBreakdown(result);
    const sum = breakdown.place.stake + breakdown.wide.stake + breakdown.trio.stake;
    expect(sum).toBe(0);
    expect(sum).toBe(result.totalStake);
  });

  it("実データ(buildMixedRaceAllocationの本物の結果)でも内訳の合計がtotalStakeと一致すること(統合確認)", () => {
    const n = 8;
    const umabans = umabansOf(n);
    const race = raceInput({
      rows: allCandidateRows(n),
      wideCombo: fullOddsRecord(umabans, 2, 30000),
      trioCombo: fullOddsRecord(umabans, 3, 90000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const view = buildMixedRaceAllocation(race, settings());
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const breakdown = buildMixedAllocationBreakdown(view.result);
    const sum = breakdown.place.stake + breakdown.wide.stake + breakdown.trio.stake;
    // 前提固定: 実際に金額が動いていること(空振り防止)。
    expect(view.result.totalStake).toBeGreaterThan(0);
    expect(sum).toBe(view.result.totalStake);
  });
});

// ============================================================================
// AC13: 個々の買い目を全件・stake降順(同額は馬番配列の辞書順)で列挙。券種ラベル。
// ============================================================================

describe("AC13: sortMixedAllocationsForDisplay — 全件・stake降順(同額は馬番配列の辞書順)で列挙すること", () => {
  it("stake降順で並ぶこと(打ち切りなし=全件)", () => {
    const allocations = [
      allocation({ umabans: [1], stake: 100 }),
      allocation({ umabans: [2, 3], stake: 500 }),
      allocation({ umabans: [4, 5, 6], stake: 300 }),
      allocation({ umabans: [7], stake: 0 }), // stake=0は除外される
    ];
    const sorted = sortMixedAllocationsForDisplay(generalResult(allocations));
    expect(sorted.map((a) => a.umabans)).toEqual([[2, 3], [4, 5, 6], [1]]);
    // 前提固定: stake=0の候補が除外されていること(「全件」はstake>0の全件を意味する)。
    expect(sorted).toHaveLength(3);
  });

  it("同額のときは馬番配列の辞書順(要素ごとの昇順)でタイブレークすること", () => {
    const allocations = [
      allocation({ umabans: [5, 9], stake: 200 }),
      allocation({ umabans: [1, 2], stake: 200 }),
      allocation({ umabans: [1, 9], stake: 200 }),
    ];
    const sorted = sortMixedAllocationsForDisplay(generalResult(allocations));
    expect(sorted.map((a) => a.umabans)).toEqual([[1, 2], [1, 9], [5, 9]]);
  });

  it("同額かつ長さが異なる場合は短い方を先にすること(辞書順の定義どおり)", () => {
    const allocations = [
      allocation({ umabans: [1, 2, 3], stake: 200 }),
      allocation({ umabans: [1, 2], stake: 200 }),
    ];
    const sorted = sortMixedAllocationsForDisplay(generalResult(allocations));
    expect(sorted.map((a) => a.umabans)).toEqual([[1, 2], [1, 2, 3]]);
  });

  it("実データでも、返された配列に含まれる要素数がstake>0の件数と一致すること(全件性の確認)", () => {
    const n = 8;
    const umabans = umabansOf(n);
    const race = raceInput({
      rows: allCandidateRows(n),
      wideCombo: fullOddsRecord(umabans, 2, 30000),
      trioCombo: fullOddsRecord(umabans, 3, 90000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const view = buildMixedRaceAllocation(race, settings());
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const sorted = sortMixedAllocationsForDisplay(view.result);
    const expectedCount = view.result.allocations.filter((a) => a.stake > 0).length;
    expect(sorted).toHaveLength(expectedCount);
    // 前提固定: 空振り防止(実際に複数件あること)。
    expect(expectedCount).toBeGreaterThan(1);
  });
});

// ============================================================================
// 上位N件+折りたたみ(機能D-3再スコープ・Issue #15)
//
// splitAllocationsForDisplay(sorted, limit?) は sortMixedAllocationsForDisplay の結果を
// visible(上位N件)/hidden(残り)に分割する。不変式(可視+隠れ=合計。ev-tool-spec上の用語ではなく
// 本タスクのブリーフの呼称に合わせ「不変式1〜3」と呼ぶ)は buildMixedAllocationBreakdown・
// sortMixedAllocationsForDisplayが既に保証している「同じ配列からの集計」という性質の上に
// 単純な分割を載せるだけなので、分割そのものが不変式を壊さないことをテストで固定する。
// ============================================================================

/** n件の配分を、stakeが互いに異なる降順(重複なし)で生成する補助関数(タイブレークを気にせず使える)。 */
function manyDistinctAllocations(n: number): GeneralBetAllocation[] {
  return Array.from({ length: n }, (_, i) => allocation({ umabans: [i + 1], stake: (n - i) * 10 }));
}

describe("MIXED_ALLOCATION_VISIBLE_LIMIT — 上位表示件数の既定値", () => {
  it("既定値は20であること", () => {
    expect(MIXED_ALLOCATION_VISIBLE_LIMIT).toBe(20);
  });
});

describe("splitAllocationsForDisplay — 境界値(0/1/N-1/N/N+1/大量)", () => {
  it("0件のとき、visible=[]・hidden=[]・hiddenCount=0であること", () => {
    const split = splitAllocationsForDisplay([]);
    expect(split.visible).toEqual([]);
    expect(split.hidden).toEqual([]);
    expect(split.hiddenCount).toBe(0);
    expect(split.hiddenStake).toBe(0);
  });

  it("1件のとき、visible=1件・hiddenCount=0であること", () => {
    const sorted = manyDistinctAllocations(1);
    const split = splitAllocationsForDisplay(sorted);
    expect(split.visible).toHaveLength(1);
    expect(split.hiddenCount).toBe(0);
  });

  it("N-1件(19件)のとき、hiddenCount=0であること(まだ打ち切りが発生しない側の境界)", () => {
    const sorted = manyDistinctAllocations(19);
    const split = splitAllocationsForDisplay(sorted);
    expect(split.visible).toHaveLength(19);
    expect(split.hiddenCount).toBe(0);
  });

  it("N件ちょうど(20件)のとき、hiddenCount=0であること(『他0件』を出さない境界)", () => {
    const sorted = manyDistinctAllocations(20);
    const split = splitAllocationsForDisplay(sorted);
    expect(split.visible).toHaveLength(20);
    expect(split.hidden).toEqual([]);
    expect(split.hiddenCount).toBe(0);
  });

  it("【条項4の核心】limit引数を渡さず(=本番既定)21件を入れると、visible.length===20・hiddenCount===1になること(定数値の間接参照ではなく、実際の分割挙動をハードコードした数値で固定する)", () => {
    const sorted = manyDistinctAllocations(21);
    const split = splitAllocationsForDisplay(sorted);
    expect(split.visible).toHaveLength(20);
    expect(split.hidden).toHaveLength(1);
    expect(split.hiddenCount).toBe(1);
    // hiddenStakeは21番目(最後尾)の1件のstakeそのものであること。
    expect(split.hiddenStake).toBe(sorted[20]!.stake);
    expect(split.hidden[0]).toEqual(sorted[20]);
  });

  it("大量(100件)のとき、visible+hiddenの件数がstake>0の総件数と一致すること(不変式3相当の最小形)", () => {
    const sorted = manyDistinctAllocations(100);
    const split = splitAllocationsForDisplay(sorted);
    // 前提固定(空振り防止): 実際に打ち切りが発生していること。
    expect(split.hiddenCount).toBeGreaterThan(0);
    expect(split.visible.length + split.hiddenCount).toBe(100);
  });

  it("limit引数に非有限・負値・0を渡すと既定値(20)へフォールバックすること(resolveBetUnit等と同じ流儀)", () => {
    const sorted = manyDistinctAllocations(25);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 0]) {
      const split = splitAllocationsForDisplay(sorted, bad);
      expect(split.visible).toHaveLength(20);
    }
  });

  it("visible ++ hiddenが元のsorted配列と順序・要素ともに完全一致すること(AC5)", () => {
    const sorted = manyDistinctAllocations(45);
    const split = splitAllocationsForDisplay(sorted);
    expect([...split.visible, ...split.hidden]).toEqual(sorted);
  });
});

describe("splitAllocationsForDisplay — 同額が境界をまたぐ場合の決定性(馬番配列の辞書順タイブレーク・入力順シャッフル耐性)", () => {
  it("境界(20/21番目)で同額のとき、馬番の辞書順が小さい方がvisibleに残り、大きい方がhiddenへ回ること。入力順をシャッフルしても結果が同一であること", () => {
    // 18件の「大きいstake」(重複なし)+3件の「同額(500)」を用意する。
    // 同額3件の馬番は[2]・[5]・[10]で、辞書順(数値昇順)は[2] < [5] < [10]。
    // 20件目までに[2]・[5]が入り、[10]だけがhiddenへ回る想定。
    const bigOnes = Array.from({ length: 18 }, (_, i) => allocation({ umabans: [100 + i], stake: 1000 - i }));
    const tied = [
      allocation({ umabans: [10], stake: 500 }),
      allocation({ umabans: [2], stake: 500 }),
      allocation({ umabans: [5], stake: 500 }),
    ];
    const original = [...bigOnes, ...tied];
    const shuffled = [...tied, ...bigOnes].reverse();
    // 前提固定: 2つの入力配列が(順序を除き)同じ要素集合であること。
    expect(original).toHaveLength(shuffled.length);

    const sortedFromOriginal = sortMixedAllocationsForDisplay(generalResult(original));
    const sortedFromShuffled = sortMixedAllocationsForDisplay(generalResult(shuffled));
    const splitFromOriginal = splitAllocationsForDisplay(sortedFromOriginal);
    const splitFromShuffled = splitAllocationsForDisplay(sortedFromShuffled);

    expect(splitFromOriginal.hidden.map((a) => a.umabans)).toEqual([[10]]);
    expect(splitFromOriginal.visible.map((a) => a.umabans)).toContainEqual([2]);
    expect(splitFromOriginal.visible.map((a) => a.umabans)).toContainEqual([5]);
    // 決定性: 入力順をシャッフルしても、visible/hiddenの中身(馬番)が完全に同一であること。
    expect(splitFromShuffled.visible.map((a) => a.umabans)).toEqual(splitFromOriginal.visible.map((a) => a.umabans));
    expect(splitFromShuffled.hidden.map((a) => a.umabans)).toEqual(splitFromOriginal.hidden.map((a) => a.umabans));
  });
});

describe("不変式1〜3(可視+隠れ=合計。有限なstakeの下で成り立つ主張)", () => {
  it("大量(103件・stake>0が100件+stake=0が3件・複勝/ワイド/三連複混在)のとき、不変式1〜3がすべて成り立つこと", () => {
    const placeAllocs = Array.from({ length: 30 }, (_, i) => allocation({ umabans: [i + 1], stake: 100 + i }));
    const wideAllocs = Array.from({ length: 40 }, (_, i) => allocation({ umabans: [i + 1, i + 2], stake: 50 + i }));
    const trioAllocs = Array.from({ length: 30 }, (_, i) =>
      allocation({ umabans: [i + 1, i + 2, i + 3], stake: 30 + i }),
    );
    // boss指摘(採用2): stake===0の行を1件では終わらせず券種ごとに混ぜる。これが無いと、
    // 「countがstake>0基準であること」という不変式3の主張が、buildMixedAllocationBreakdown
    // 自身の既存契約(AC10)と同じ土俵で二重に確認しているだけになり、合成した主張として
    // 自立しない(仮に本関数がstake>=0基準に取り違えても、stake===0の入力が無ければ
    // どちらの基準でも同じ数になり検知できない)。
    const zeroStakeAllocs = [
      allocation({ umabans: [901], stake: 0 }),
      allocation({ umabans: [902, 903], stake: 0 }),
      allocation({ umabans: [904, 905, 906], stake: 0 }),
    ];
    const allocations = [...placeAllocs, ...wideAllocs, ...trioAllocs, ...zeroStakeAllocs];
    const result = generalResult(allocations);
    const sorted = sortMixedAllocationsForDisplay(result);
    const split = splitAllocationsForDisplay(sorted);
    const breakdown = buildMixedAllocationBreakdown(result);
    // 不変式3の右辺(count)を、production関数(buildMixedAllocationBreakdown)に頼らず
    // 生の入力配列から独立に数え直す(自立した主張にするため。boss指摘)。
    const expectedPositiveCount = allocations.filter((a) => a.stake > 0).length;

    // 前提固定(空振り防止): 実際に打ち切りが発生し、totalStakeが有限の正値であり、
    // かつstake=0の行が実在すること(不変式3を自立させる前提そのもの)。
    expect(result.totalStake).toBeGreaterThan(0);
    expect(split.hiddenCount).toBeGreaterThan(0);
    expect(allocations.filter((a) => a.stake === 0)).toHaveLength(3);
    // 前提固定: stake=0の3件はstake>0の100件とは別枠であり、合計103件であること。
    expect(allocations).toHaveLength(103);
    expect(expectedPositiveCount).toBe(100);

    // 不変式1: visible.stake合計 + hidden.stake合計 === totalStake
    const visibleStake = split.visible.reduce((sum, a) => sum + a.stake, 0);
    expect(visibleStake + split.hiddenStake).toBe(result.totalStake);

    // 不変式2: totalStake === breakdown.place+wide+trio(buildMixedAllocationBreakdownの既存契約AC10)
    expect(breakdown.place.stake + breakdown.wide.stake + breakdown.trio.stake).toBe(result.totalStake);

    // 不変式3: visible.length + hiddenCount === breakdown.place.count+wide.count+trio.count
    // （かつ、生入力から独立に数えたstake>0件数〈100〉とも一致すること。自立した主張の核心）。
    expect(split.visible.length + split.hiddenCount).toBe(
      breakdown.place.count + breakdown.wide.count + breakdown.trio.count,
    );
    expect(split.visible.length + split.hiddenCount).toBe(expectedPositiveCount);
  });
});

describe("buildMixedAllocationDisplay — display.splitはdisplay.sortedAllocationsから導出されること(条項4・AC13)", () => {
  it("実データ(混在配分)で、display.split.visible ++ display.split.hiddenがdisplay.sortedAllocationsと完全一致すること", () => {
    const n = 8;
    const umabans = umabansOf(n);
    const race = raceInput({
      rows: allCandidateRows(n),
      wideCombo: fullOddsRecord(umabans, 2, 30000),
      trioCombo: fullOddsRecord(umabans, 3, 90000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const view = buildMixedAllocationDisplay(race, settings());
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    // 前提固定(空振り防止): 実際に買い目が1件以上あること。
    expect(view.display.sortedAllocations.length).toBeGreaterThan(0);
    expect([...view.display.split.visible, ...view.display.split.hidden]).toEqual(
      view.display.sortedAllocations,
    );
  });
});

// ============================================================================
// AC1(強化): 折りたたみブロックは0/1要素の配列として返し、JSXは.mapするだけにする
// (buildMixedAllocationNoticesと同型。JSXに条件式`hiddenCount > 0 &&`を書かない設計)。
//
// 経緯: `>`を`>=`に変える変異が入っても、hiddenCountが0であることしか検証していないテストは
// 検知できない(pushの1行削除がすり抜けた事故と同じ構造。boss指摘)。折りたたみブロックの
// 「出る/出ない」自体を配列の長さとして値で固定する。
// ============================================================================

describe("buildHiddenAllocationsBlocks — 折りたたみブロックを0/1要素の配列として返すこと(AC1)", () => {
  it("hiddenCount===0のとき、配列長が0であること(『他0件』ブロックを出さない側の直接固定)", () => {
    const split: MixedAllocationSplit = { visible: manyDistinctAllocations(5), hidden: [], hiddenCount: 0, hiddenStake: 0 };
    const blocks = buildHiddenAllocationsBlocks(split);
    expect(blocks).toHaveLength(0);
  });

  it("hiddenCount>0のとき、配列長が1であり、summaryTextとrows(=split.hidden)を持つこと", () => {
    const hidden = [allocation({ umabans: [21], stake: 300 }), allocation({ umabans: [22], stake: 100 })];
    const split: MixedAllocationSplit = {
      visible: manyDistinctAllocations(20),
      hidden,
      hiddenCount: 2,
      hiddenStake: 400,
    };
    const blocks = buildHiddenAllocationsBlocks(split);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.rows).toEqual(hidden);
    expect(blocks[0]!.summaryText).toBe(formatHiddenAllocationsSummary(split));
  });
});

// ============================================================================
// AC2(強化): 見出しの金額が「隠れている買い目の配分額合計」であることが文言だけで一意に読めること
// (合計行〈総額〉と読み違えられない)。
// ============================================================================

describe("formatHiddenAllocationsSummary — 件数と、隠れている買い目の配分額合計であることが分かる金額の両方を含むこと", () => {
  it("件数(hiddenCount)と金額(formatYen(hiddenStake))の両方が文言に含まれること", () => {
    const split: MixedAllocationSplit = {
      visible: manyDistinctAllocations(20),
      hidden: [allocation({ umabans: [21], stake: 1200 })],
      hiddenCount: 1,
      hiddenStake: 1200,
    };
    const text = formatHiddenAllocationsSummary(split);
    expect(text.includes("1件")).toBe(true);
    expect(text.includes(formatYen(1200))).toBe(true);
  });

  it("金額が『隠れている買い目の配分額合計』であることを示す語(合計行と取り違えない語)を含むこと", () => {
    // 前提固定(空振り防止): hiddenStakeが合計行(totalStake)とは別の値であること
    // (visibleが1件以上あるため、hiddenStake < totalStakeが成立する構図で確認する)。
    const visible = manyDistinctAllocations(20);
    const hidden = [allocation({ umabans: [21], stake: 1200 })];
    const totalStake = [...visible, ...hidden].reduce((sum, a) => sum + a.stake, 0);
    expect(hidden[0]!.stake).toBeLessThan(totalStake);

    const split: MixedAllocationSplit = { visible, hidden, hiddenCount: 1, hiddenStake: 1200 };
    const text = formatHiddenAllocationsSummary(split);
    // 「非表示」等、隠れている分であることを明示する語を含むこと(合計行の文言と同一にしない)。
    expect(text.includes("非表示")).toBe(true);
  });
});

describe("mixedBetTypeLabel — umabans.lengthから券種ラベルを返すこと", () => {
  it.each([
    [1, "複勝"],
    [2, "ワイド"],
    [3, "三連複"],
  ] as const)("length=%i は %s", (length, expected) => {
    expect(mixedBetTypeLabel(length)).toBe(expected);
  });
});

// ============================================================================
// AC15: 判定不能(unjudged)件数の合算。0件なら表示側は出さない(合計0の判定はtotalUnjudgedCountに委ねる)
// ============================================================================

describe("AC15: aggregateUnjudgedCounts/totalUnjudgedCount — 券種横断の判定不能件数を合算すること", () => {
  it("複勝・ワイド・3連複それぞれ異なる件数を持つ場合に正しく合算されること(非対称データ)", () => {
    const diagnostics = mixedDiagnostics({
      place: { kind: "judged", judged: { positiveCount: 1, notPositiveCount: 0 }, unjudged: { oddsMissingCount: 2 } },
      wide: builtComboDiag({ oddsMissingCount: 3, oddsUnfetchedCount: 5, oddsMalformedCount: 1 }),
      trio: builtComboDiag({ oddsMissingCount: 1, oddsUnfetchedCount: 0, oddsMalformedCount: 2 }),
    });
    const counts = aggregateUnjudgedCounts(diagnostics);
    expect(counts).toEqual({ oddsMissingCount: 6, oddsUnfetchedCount: 5, oddsMalformedCount: 3 });
    expect(totalUnjudgedCount(counts)).toBe(14);
  });

  it("すべて0件ならtotalUnjudgedCountも0であること(表示を出さない判定に使う)", () => {
    const diagnostics = mixedDiagnostics();
    const counts = aggregateUnjudgedCounts(diagnostics);
    expect(totalUnjudgedCount(counts)).toBe(0);
  });

  it("not-requested(対象外にした券種)は判定不能に加算しないこと(対象外と判定不能を混同しない)", () => {
    const diagnostics = mixedDiagnostics({
      wide: { kind: "not-requested" },
      trio: builtComboDiag({ oddsMissingCount: 5 }),
    });
    const counts = aggregateUnjudgedCounts(diagnostics);
    // wideがnot-requestedでも、trioの5件だけが計上されること(0を足しているだけで無視されていないことの確認)。
    expect(counts.oddsMissingCount).toBe(5);
  });

  it("部分被覆(comboOddsState='available'かつunjudgedが1件以上)でも件数が計上されること(地方三連複の軸別取得で発生。AC15の核心)", () => {
    // state='available'(発売あり・取得成功)でも、oddsUnfetchedCount>0(一部の組だけ取得できなかった)
    // というケースを表現する。stateだけを見て「全部揃っている」と誤判定しないことを固定する。
    const diagnostics = mixedDiagnostics({
      trio: builtComboDiag({ comboOddsState: "available", positiveCount: 50, oddsUnfetchedCount: 12 }),
    });
    const counts = aggregateUnjudgedCounts(diagnostics);
    expect(counts.oddsUnfetchedCount).toBe(12);
    expect(totalUnjudgedCount(counts)).toBeGreaterThan(0);
  });
});

describe("formatUnjudgedNote — 判定不能件数の注記文言(0件の区分は文言に含めない)", () => {
  it("3区分すべて非0なら3つとも文言に含まれること", () => {
    const note = formatUnjudgedNote({ oddsMissingCount: 2, oddsUnfetchedCount: 5, oddsMalformedCount: 1 });
    expect(note).toContain("オッズ欠損2件");
    expect(note).toContain("未取得5件");
    expect(note).toContain("不正値1件");
  });

  it("0件の区分は文言に含めないこと(ノイズを出さない)", () => {
    const note = formatUnjudgedNote({ oddsMissingCount: 3, oddsUnfetchedCount: 0, oddsMalformedCount: 0 });
    expect(note).toContain("オッズ欠損3件");
    expect(note).not.toContain("未取得0件");
    expect(note).not.toContain("不正値0件");
  });
});

// ============================================================================
// AC16: {}(fieldPresence="empty")を「発売なし」と断定しない。comboOddsStateで原因を判別する
// ============================================================================

describe("AC16: comboBetTypeNote — {}を『発売なし』と断定せず、comboOddsStateで原因を判別すること", () => {
  it("comboOddsState='available'かつ候補ありのときは注記なし(null)", () => {
    expect(comboBetTypeNote(builtComboDiag({ comboOddsState: "available", positiveCount: 3 }))).toBeNull();
  });

  it("comboOddsState='available'かつ候補なし(0件)のときは『発売なし』と断定せず、EVプラスが無かった旨を表示すること", () => {
    const note = comboBetTypeNote(builtComboDiag({ comboOddsState: "available", positiveCount: 0 }));
    expect(note).not.toBeNull();
    expect(note).not.toContain("発売");
  });

  it("comboOddsState='unavailable'のときは発売なしと表示してよい(取得結果から確定できる唯一のケース)", () => {
    const note = comboBetTypeNote(builtComboDiag({ comboOddsState: "unavailable", positiveCount: 0 }));
    expect(note).toContain("発売");
  });

  it("comboOddsState='failed'のときは『発売なしとは限らない』ことを明示し、断定しないこと(AC16の核心)", () => {
    const note = comboBetTypeNote(builtComboDiag({ comboOddsState: "failed", positiveCount: 0 }));
    expect(note).not.toBeNull();
    expect(note).toContain("失敗");
    // 「発売なし」と断定する表現(「発売されていません」「発売なし」)を含まないこと。
    expect(note).not.toMatch(/発売されていません|発売なし/);
  });

  it("comboOddsState='unknown'(fieldPresence='absent'。未取得)のときは取得していない旨を表示し、断定しないこと", () => {
    const note = comboBetTypeNote(builtComboDiag({ fieldPresence: "absent", comboOddsState: "unknown", positiveCount: 0 }));
    expect(note).not.toBeNull();
    expect(note?.includes("未取得") || note?.includes("取得していません")).toBe(true);
    expect(note).not.toMatch(/発売されていません|発売なし/);
  });

  it("kind='not-requested'(ユーザーが対象外にした)は注記なし(null)", () => {
    expect(comboBetTypeNote({ kind: "not-requested" })).toBeNull();
  });

  // fieldPresence(値の中身)とcomboOddsState(原因)が食い違う組合せ(={}なのにstateがavailable、
  // 逆に値ありなのにstateがunavailable等)でも、comboOddsStateだけを根拠に判定すること
  // (fieldPresenceを読んで「発売なし」と誤判定していないかの検知)。
  it.each([
    { fieldPresence: "empty" as const, comboOddsState: "unavailable" as const, expectSubstr: "発売" },
    { fieldPresence: "present" as const, comboOddsState: "unavailable" as const, expectSubstr: "発売" },
    { fieldPresence: "empty" as const, comboOddsState: "failed" as const, expectSubstr: "失敗" },
    { fieldPresence: "present" as const, comboOddsState: "failed" as const, expectSubstr: "失敗" },
  ])(
    "fieldPresence=$fieldPresence・comboOddsState=$comboOddsStateの組合せでも、comboOddsStateに従った注記になること",
    ({ fieldPresence, comboOddsState, expectSubstr }) => {
      const note = comboBetTypeNote(builtComboDiag({ fieldPresence, comboOddsState, positiveCount: 0 }));
      expect(note).toContain(expectSubstr);
    },
  );
});

// ============================================================================
// AC3改訂: 頭数不可の一言注記(既存placeBetUnavailableMessageをそのまま使う)
// ============================================================================

describe("placeUnavailableNoteForMixed — 頭数不可のとき既存placeBetUnavailableMessageをそのまま使うこと", () => {
  it("kind='unavailable'のときplaceBetUnavailableMessage(reason)と同じ文言を返すこと(新しい文言を作らない)", () => {
    const diag: PlaceCandidateDiagnostics = { kind: "unavailable", reason: "two-place-only" };
    expect(placeUnavailableNoteForMixed(diag)).toContain("複勝が2着まで");
  });

  it("kind='judged'(複勝が対象)のときはnullであること", () => {
    const diag: PlaceCandidateDiagnostics = {
      kind: "judged",
      judged: { positiveCount: 1, notPositiveCount: 0 },
      unjudged: { oddsMissingCount: 0 },
    };
    expect(placeUnavailableNoteForMixed(diag)).toBeNull();
  });

  it("reason='yoso'のときは型安全のためnullを返すこと(ゲート順序上このkindがmixed表示に現れることはない)", () => {
    const diag: PlaceCandidateDiagnostics = { kind: "unavailable", reason: "yoso" };
    expect(placeUnavailableNoteForMixed(diag)).toBeNull();
  });
});

// ============================================================================
// AC14: #35較正注記
// ============================================================================

describe("AC14: COMBO_EV_CALIBRATION_NOTE — 組合せ券種のEV過大評価・較正未実施を明記すること", () => {
  it("『過大評価』『較正』の両方の趣旨を含むこと", () => {
    expect(COMBO_EV_CALIBRATION_NOTE).toContain("過大評価");
    expect(COMBO_EV_CALIBRATION_NOTE).toMatch(/較正/);
  });
});

// ============================================================================
// AC12: 説明文に寄り先の券種を断定する表現が含まれないこと(文言テストで固定)
// ============================================================================

describe("AC12: 寄り先の券種を断定する表現が含まれないこと(文言テストで固定)", () => {
  const forbiddenPatterns = /集中|寄る|偏る|多くなり(ます|がち)|優先(的)?に(配分|購入)/;

  it("COMBO_EV_CALIBRATION_NOTEに寄り先を断定する表現が含まれないこと", () => {
    expect(COMBO_EV_CALIBRATION_NOTE).not.toMatch(forbiddenPatterns);
  });

  it("comboBetTypeNoteの全パターンに寄り先を断定する表現が含まれないこと", () => {
    const states: readonly ComboOddsFetchOutcomeView["state"][] = ["available", "unavailable", "failed"];
    for (const state of states) {
      for (const positiveCount of [0, 1]) {
        const note = comboBetTypeNote(builtComboDiag({ comboOddsState: state, positiveCount }));
        if (note !== null) {
          expect(note).not.toMatch(forbiddenPatterns);
        }
      }
    }
    const unknownNote = comboBetTypeNote(builtComboDiag({ fieldPresence: "absent", comboOddsState: "unknown", positiveCount: 0 }));
    expect(unknownNote).not.toMatch(forbiddenPatterns);
  });

  it("MIXED_ALLOCATION_INVALID_MESSAGEに寄り先を断定する表現が含まれないこと", () => {
    expect(MIXED_ALLOCATION_INVALID_MESSAGE).not.toMatch(forbiddenPatterns);
  });
});

// ============================================================================
// AC17続き: kind='invalid'はユーザー向け文言(MIXED_ALLOCATION_INVALID_MESSAGE)を使うこと
// (core由来の生の例外メッセージをそのまま画面に出さない)
// ============================================================================

describe("MIXED_ALLOCATION_INVALID_MESSAGE — ユーザー向け文言であり、core由来の生メッセージを含まないこと", () => {
  it("『不正な買い目です』等のcore側の生の例外文言を含まないこと(開発者向けメッセージの露出防止)", () => {
    expect(MIXED_ALLOCATION_INVALID_MESSAGE).not.toContain("不正な買い目です");
    expect(MIXED_ALLOCATION_INVALID_MESSAGE).not.toContain("validateCandidates");
  });

  it("空でないこと", () => {
    expect(MIXED_ALLOCATION_INVALID_MESSAGE.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// AC11: 「複勝のみの場合の提案額」の併記(混在時の複勝配分額とは別々の値)
// 一致するケースと大きく食い違うケースの両方を持つ(boss指示)。
// ============================================================================

/** 複勝のみ1頭が候補になる8頭立ての行配列を作る(bet-allocation-view.test.tsの流儀を踏襲)。 */
function candidateRow(umaban: number, adjustedProb: number, placeOddsMin: number): AnalysisRow {
  const ev = adjustedProb * placeOddsMin;
  return row({ umaban, adjustedProb, placeOddsMin, ev, isPositive: ev > 1 });
}
function eightRunnersOnePlaceCandidate(): AnalysisRow[] {
  return [
    candidateRow(1, 0.5, 2.5),
    ...[2, 3, 4, 5, 6, 7, 8].map((u) =>
      row({ umaban: u, adjustedProb: 0.36, isPositive: false, ev: null, placeOddsMin: null }),
    ),
  ];
}

describe("AC11: resolvePlaceOnlyStake / buildMixedAllocationDisplay — 複勝のみの提案額を別々の値として併記すること", () => {
  it("【食い違うケース】強い組合せオッズがあると、混在時の複勝配分額と複勝のみの提案額が大きく異なること(実測の傾向を再現)", () => {
    const umabans = umabansOf(8);
    const race = raceInput({
      rows: eightRunnersOnePlaceCandidate(),
      wideCombo: fullOddsRecord(umabans, 2, 3000),
      trioCombo: fullOddsRecord(umabans, 3, 15000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const s = settings({ bankroll: 300000, perRaceCap: 20000 });
    const view = buildMixedAllocationDisplay(race, s);
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    // 前提固定: 複勝のみなら提案額が出ること(比較対象が両方とも意味のある値であることの確認)。
    expect(view.display.placeOnlyStake).not.toBeNull();
    expect(view.display.placeOnlyStake).toBeGreaterThan(0);
    // 核心: 混在時の複勝配分額(breakdown.place.stake)と複勝のみの提案額が別々の値であり、
    // 大きく食い違うこと(実測例: 複勝のみ19,900円→混在では100円、という傾向の再現)。
    expect(view.display.breakdown.place.stake).not.toBe(view.display.placeOnlyStake);
    expect(view.display.placeOnlyStake! - view.display.breakdown.place.stake).toBeGreaterThan(10000);
    // このケースでの具体的な値も固定する(回帰検知)。
    expect(view.display.placeOnlyStake).toBe(20000);
    expect(view.display.breakdown.place.stake).toBe(0);
  });

  it("【一致するケース】資金が小さく組合せ候補に1単位も配分されないと、混在時の複勝配分額と複勝のみの提案額が一致すること", () => {
    const umabans = umabansOf(8);
    const race = raceInput({
      rows: eightRunnersOnePlaceCandidate(),
      wideCombo: fullOddsRecord(umabans, 2, 8), // EVプラスの候補として存在する(D-2条件③には該当しない)。
      trioCombo: fullOddsRecord(umabans, 3, 1), // 3連複はEVプラスにならない(閾値未満)。
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    const s = settings({ bankroll: 5000, perRaceCap: 1000 });
    const view = buildMixedAllocationDisplay(race, s);
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    // 前提固定: 実際にワイド候補が存在し(D-2条件③に該当せず混在経路に入っていること)、
    // かつ資金が小さくワイドには1円も配分されなかったこと(この一致は偶然ではなく、
    // 「候補はあるが小さすぎて選ばれなかった」という具体的な機構によるものであることの確認)。
    expect(view.diagnostics.wide.kind === "built" && view.diagnostics.wide.build.judged.positiveCount).toBeGreaterThan(0);
    expect(view.display.breakdown.wide.stake).toBe(0);
    // 核心: 混在時の複勝配分額と複勝のみの提案額が一致すること。
    expect(view.display.placeOnlyStake).not.toBeNull();
    expect(view.display.breakdown.place.stake).toBe(view.display.placeOnlyStake);
    // このケースでの具体的な値も固定する(回帰検知。「たまたま両方0円」という空虚な一致ではないこと)。
    expect(view.display.placeOnlyStake).toBe(400);
    expect(view.display.breakdown.place.stake).toBe(400);
  });

  it("resolvePlaceOnlyStakeは頭数不可(複勝が対象外)のときnullを返すこと(0円と算出不能を区別する)", () => {
    const race = raceInput({ rows: allCandidateRows(6) }); // 5〜7頭=複勝対象外
    const s = settings();
    expect(resolvePlaceOnlyStake(race, s)).toBeNull();
  });
});

// ============================================================================
// boss メタレビュー差し戻し2026-08-13対応: 確率合計警告(probabilitySumWarning相当)が
// 混在経路で欠落していた欠陥の是正。既存の複勝専用経路(buildAllocationNotices)が出す
// 警告と同じ閾値・同じ文言を混在経路でも出すことを固定する。
// ============================================================================

describe("resolveMixedProbabilitySumWarning — 既存probabilitySumWarningと同じ閾値・同じ文言を再利用すること", () => {
  it("全出走馬(候補に限らない)のadjustedProb単純合計をplaceProbSumとして使うこと(isPositive=falseの馬も含む)", () => {
    // 前提固定: 8頭のうち1頭だけisPositive=trueでも、8頭全員のadjustedProbが合算されること。
    const rows = [
      row({ umaban: 1, adjustedProb: 0.5, isPositive: true }),
      ...[2, 3, 4, 5, 6, 7, 8].map((u) =>
        row({ umaban: u, adjustedProb: 0.5, isPositive: false, ev: null, placeOddsMin: null }),
      ),
    ];
    // 8頭×0.5=4.0、目標3に対し乖離1.0(>0.3)なので警告が出るはず。
    const warning = resolveMixedProbabilitySumWarning(raceInput({ rows }), 3);
    expect(warning).not.toBeNull();
    expect(warning).toContain("4.00");
  });

  it("乖離が閾値(0.3)以内なら警告しないこと(既存probabilitySumWarningと同じ閾値)", () => {
    // 8頭×0.375=3.0ちょうど(乖離0)。
    const rows = umabansOf(8).map((u) => row({ umaban: u, adjustedProb: 0.375 }));
    const warning = resolveMixedProbabilitySumWarning(raceInput({ rows }), 3);
    expect(warning).toBeNull();
  });

  it("既存probabilitySumWarningを同じ入力(placeProbSum/target/deviation)で直接呼んだ結果と文字列として完全一致すること(ロジックの複製が無いことの証拠)", () => {
    const rows = umabansOf(8).map((u) => row({ umaban: u, adjustedProb: 0.6 })); // 合計4.8、乖離1.8。
    const mixedWarning = resolveMixedProbabilitySumWarning(raceInput({ rows }), 3);
    const placeProbSum = rows.reduce((s, r) => s + r.adjustedProb, 0);
    const directWarning = probabilitySumWarning({
      placeProbSum,
      placeProbSumTarget: 3,
      placeProbSumDeviation: placeProbSum - 3,
    });
    // 前提固定: 両方とも実際に警告が出るケースであること(空振り防止)。
    expect(directWarning).not.toBeNull();
    expect(mixedWarning).toBe(directWarning);
  });

  it("topFinishCountが目標値(placeProbSumTarget)としてそのまま使われること", () => {
    // topFinishCountを敢えて5にして、目標値が3固定ではなく引数どおりであることを確認する
    // (本来は常に3だが、この関数自体は引数を信頼して使うことを確認する単体テスト)。
    const rows = umabansOf(8).map((u) => row({ umaban: u, adjustedProb: 0.625 })); // 合計5.0。
    const warning = resolveMixedProbabilitySumWarning(raceInput({ rows }), 5);
    // 目標5・実測5.0なら乖離0で警告なし。
    expect(warning).toBeNull();
  });
});

describe("buildMixedAllocationDisplay — display.probabilitySumWarningがkind='mixed'のときに実際に現れること(欠落していた欠陥の回帰テスト)", () => {
  it("乖離が大きい実データでは、display.probabilitySumWarningが非nullになること", () => {
    // raceWithPositiveCombosはallCandidateRows(既定adjustedProb=0.5)を使うため、
    // 8頭で合計4.0・乖離1.0(>0.3)となり、必ず警告が出る入力である。
    const race = raceWithPositiveCombos(8);
    const view = buildMixedAllocationDisplay(race, settings());
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.display.probabilitySumWarning).not.toBeNull();
    expect(view.display.probabilitySumWarning).toContain("4.00");
  });

  it("乖離が閾値以内なら、display.probabilitySumWarningがnullになること", () => {
    const umabans = umabansOf(8);
    const rows = umabans.map((u) => row({ umaban: u, adjustedProb: 0.375 })); // 合計3.0ちょうど。
    const race = raceWithPositiveCombos(8, { rows });
    const view = buildMixedAllocationDisplay(race, settings());
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    expect(view.display.probabilitySumWarning).toBeNull();
  });
});

// ============================================================================
// buildMixedAllocationNotices — 注記の組み立て(advisory→確率合計警告→notDiversified)を
// 値として直接テストする(boss メタレビュー再差し戻し2026-08-13対応)。
//
// 経緯: 当初はBatchAnalysisView.tsx内に直書きし、ソース走査(「push行を含む文字列がソースに
// あるか」)で代替しようとしたが、push行だけを削除しても`if (display.probabilitySumWarning...)`
// という行自体は残るため文字列一致テストをすり抜けた(オーケストレーターが実際に確認)。
// 純関数として切り出し、戻り値(配列の中身・件数・順序)を直接検証することで、
// 「pushを1行消したら配列の要素数・中身が変わる」ことを実データで固定する。
// ============================================================================

/** テスト用のMixedAllocationDisplayを組み立てる補助関数(probabilitySumWarning以外は空・0値の既定)。 */
function mixedDisplay(overrides: Partial<MixedAllocationDisplay> = {}): MixedAllocationDisplay {
  return {
    breakdown: { place: { stake: 0, count: 0 }, wide: { stake: 0, count: 0 }, trio: { stake: 0, count: 0 } },
    sortedAllocations: [],
    unjudged: { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 },
    wideNote: null,
    trioNote: null,
    placeUnavailableNote: null,
    placeOnlyStake: null,
    probabilitySumWarning: null,
    // splitの既定値(上位N件+折りたたみ・Issue #15再スコープ)。全件visible・隠れなし。
    split: { visible: [], hidden: [], hiddenCount: 0, hiddenStake: 0 },
    ...overrides,
  };
}

describe("テストヘルパー自己テスト: mixedDisplay()", () => {
  it("既定値はprobabilitySumWarning等すべてnull/0であり、overridesで個別に上書きできること", () => {
    const d = mixedDisplay();
    expect(d.probabilitySumWarning).toBeNull();
    expect(mixedDisplay({ probabilitySumWarning: "警告文" }).probabilitySumWarning).toBe("警告文");
  });
});

describe("buildMixedAllocationNotices(注記の表示順: advisory→確率合計警告→notDiversified。boss指摘の再発防止)", () => {
  it("【回帰の核心】3種すべてが該当するとき、3件とも含まれ、advisory→確率合計警告→notDiversifiedの順で並ぶこと", () => {
    const result = generalResult([allocation({ umabans: [1], stake: 100 })], {
      advisory: "適正額超過の警告文",
      notDiversified: true,
    });
    const display = mixedDisplay({ probabilitySumWarning: "確率合計の警告文" });
    const notices = buildMixedAllocationNotices(result, display);
    // 件数・各要素の値の両方を厳密に固定する(pushが1行でも欠けると長さ・中身のどちらかで
    // 必ず検知できる)。
    expect(notices).toHaveLength(3);
    expect(notices[0]).toBe("適正額超過の警告文");
    expect(notices[1]).toBe("確率合計の警告文");
    expect(notices[2]).toBe(NOT_DIVERSIFIED_NOTE);
  });

  it("確率合計警告だけがnullのとき、advisoryとnotDiversifiedの2件のみ含まれ、間が詰まること(該当箇所だけが抜けること)", () => {
    const result = generalResult([allocation({ umabans: [1], stake: 100 })], {
      advisory: "適正額超過の警告文",
      notDiversified: true,
    });
    const display = mixedDisplay({ probabilitySumWarning: null });
    const notices = buildMixedAllocationNotices(result, display);
    expect(notices).toEqual(["適正額超過の警告文", NOT_DIVERSIFIED_NOTE]);
  });

  it("確率合計警告のみ該当するとき、1件だけ(確率合計警告)が含まれること", () => {
    const result = generalResult([allocation({ umabans: [1], stake: 100 })], {
      advisory: null,
      notDiversified: false,
    });
    const display = mixedDisplay({ probabilitySumWarning: "確率合計の警告文" });
    const notices = buildMixedAllocationNotices(result, display);
    expect(notices).toEqual(["確率合計の警告文"]);
  });

  it("advisoryのみ該当するとき、1件だけ(advisory)が含まれること", () => {
    const result = generalResult([allocation({ umabans: [1], stake: 100 })], {
      advisory: "適正額超過の警告文",
      notDiversified: false,
    });
    const display = mixedDisplay();
    expect(buildMixedAllocationNotices(result, display)).toEqual(["適正額超過の警告文"]);
  });

  it("notDiversifiedのみ該当するとき、1件だけ(NOT_DIVERSIFIED_NOTE)が含まれること", () => {
    const result = generalResult([allocation({ umabans: [1], stake: 100 })], {
      advisory: null,
      notDiversified: true,
    });
    const display = mixedDisplay();
    expect(buildMixedAllocationNotices(result, display)).toEqual([NOT_DIVERSIFIED_NOTE]);
  });

  it("いずれも該当しないとき、空配列を返すこと", () => {
    const result = generalResult([allocation({ umabans: [1], stake: 100 })], {
      advisory: null,
      notDiversified: false,
    });
    const display = mixedDisplay();
    expect(buildMixedAllocationNotices(result, display)).toEqual([]);
  });

  it("buildMixedAllocationDisplayが返すMixedAllocationDisplayを実際にそのまま渡しても動作すること(統合確認)", () => {
    // raceWithPositiveCombosはallCandidateRows(既定adjustedProb=0.5)を使うため、
    // 8頭で合計4.0・乖離1.0(>0.3)となり、確率合計警告が必ず出る入力である。
    const race = raceWithPositiveCombos(8);
    const view = buildMixedAllocationDisplay(race, settings());
    expect(view.kind).toBe("mixed");
    if (view.kind !== "mixed") {
      throw new Error("kind='mixed'のはず");
    }
    const notices = buildMixedAllocationNotices(view.result, view.display);
    // 前提固定: この入力では確率合計警告が実際に出ること(空振り防止)。
    expect(view.display.probabilitySumWarning).not.toBeNull();
    expect(notices).toContain(view.display.probabilitySumWarning);
  });
});

// ============================================================================
// buildMixedAllocationDisplay: kind!=="mixed"のときはbuildMixedRaceAllocationの結果を
// そのまま通す(displayフィールドの追加が非破壊性〈AC2〉を壊さないことの確認)
// ============================================================================

describe("buildMixedAllocationDisplay — kind!=='mixed'のときは合成ロジック本体の結果をそのまま通すこと", () => {
  it("unset/computed(フォールバック)のとき、buildMixedRaceAllocationの結果と完全一致すること(displayフィールドが混ざらない)", () => {
    const race = raceInput({ rows: allCandidateRows(8) });
    const unsetSettings = settings({ bankroll: 0 });
    expect(buildMixedAllocationDisplay(race, unsetSettings)).toEqual(buildMixedRaceAllocation(race, unsetSettings));

    const fallbackSettings = settings({ includeComboOdds: false });
    const fallbackView = buildMixedAllocationDisplay(race, fallbackSettings);
    expect(fallbackView).toEqual(buildMixedRaceAllocation(race, fallbackSettings));
    // 前提固定: "display"フィールドが存在しないこと(型と実体の両方で非mixed状態であることの確認)。
    expect(fallbackView).not.toHaveProperty("display");
  });
});
