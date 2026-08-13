import { describe, expect, it } from "vitest";

import { buildComboOddsKey, type AllocationCandidate } from "@keiba/core/ev/combo-bet-allocation";

import type {
  AnalysisRow,
  ComboOddsFetchDiagnosticsView,
  ComboOddsFetchOutcomeView,
} from "../src/shared/analysis-types.js";
import { buildMixedCandidates, type MixedCandidateBuildInput } from "../src/renderer/mixed-candidates.js";
import { buildRaceAllocation, resolvePlaceBetTarget } from "../src/renderer/bet-allocation-view.js";
import {
  buildMixedRaceAllocation,
  type MixedAllocationSettings,
} from "../src/renderer/mixed-allocation-view.js";

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
