import {
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  type OddsSnapshot,
  type RaceData,
  type RaceHorseData,
  type ShutubaHorse,
} from "@keiba/core";
import type { AnalysisRecord } from "@keiba/core";
import {
  buildAllocationBetComboKey,
  buildComboOddsKey,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
} from "@keiba/core/ev/combo-bet-allocation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAnalysis, type AnalysisPipelineDeps } from "../src/main/analysis-pipeline.js";

/**
 * analysis-pipeline-allocation.test.ts — Issue #59(#56-3)。
 * `runAnalysis` から配分提案(`AnalysisRecord.allocation`)への配線と、AC6(配分計算の例外で
 * 分析本体を失わないこと)を検証する。`analysis-pipeline.test.ts` は既存の巨大な回帰群であり、
 * AC6の検証には `shared/mixed-race-allocation.ts` をファイル全体でモックする必要があるため
 * (既存の他テストへ影響させないため)、独立ファイルに分離する。
 */

// buildMixedRaceAllocationWithOutcomeだけをモックし、他のexport(buildMixedRaceAllocation等)は
// 実物のまま素通しする(vi.importActualで実モジュールを取得し、1関数だけ差し替える)。
const { buildMixedRaceAllocationWithOutcomeMock } = vi.hoisted(() => ({
  buildMixedRaceAllocationWithOutcomeMock: vi.fn(),
}));
vi.mock("../src/shared/mixed-race-allocation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shared/mixed-race-allocation.js")>();
  return {
    ...actual,
    buildMixedRaceAllocationWithOutcome: (...args: unknown[]) => {
      const forced = buildMixedRaceAllocationWithOutcomeMock(...args);
      if (forced !== undefined) {
        return forced;
      }
      return (actual.buildMixedRaceAllocationWithOutcome as (...a: unknown[]) => unknown)(...args);
    },
  };
});

function fakeHorse(umaban: number): ShutubaHorse {
  return {
    wakuban: umaban,
    umaban,
    name: `テスト馬${umaban}`,
    horseId: parseHorseId(`10000000${String(umaban).padStart(2, "0")}`),
    sex: "牡",
    age: 4,
    kinryo: 56,
    jockeyName: `騎手${umaban}`,
    jockeyId: null,
    stableLocation: "美浦",
    trainerName: `調教師${umaban}`,
    trainerId: null,
    bodyWeight: { weight: 480, diff: 0 },
  };
}

/** 8頭・複勝オッズ付きのフェイクレースデータ(全馬EVプラス相当)。 */
function fakeRaceData(raceId: string): RaceData {
  const horses: RaceHorseData[] = Array.from({ length: 8 }, (_, i) => i + 1).map((n) => ({
    shutuba: fakeHorse(n),
    results: [],
    oikiri: null,
  }));
  const odds: OddsSnapshot = {
    officialDatetime: "2026-07-09 09:00:00",
    oddsStatus: "result",
    win: Object.fromEntries(horses.map((h) => [h.shutuba.umaban, { odds: 5.0, ninki: h.shutuba.umaban }])),
    place: Object.fromEntries(
      horses.map((h) => [h.shutuba.umaban, { oddsMin: 3.0, oddsMax: 4.0, ninki: h.shutuba.umaban }]),
    ),
  };
  return {
    raceId: parseRaceId(raceId),
    race: {
      raceName: "テスト特別",
      courseType: "芝",
      distance: 1600,
      weather: "晴",
      trackCondition: "良",
    },
    horses,
    odds,
    meta: {
      fetchedAt: "2026-07-09T00:00:00.000Z",
      oddsFetchedAt: "2026-07-09T00:00:05.000Z",
      warnings: [],
    },
  };
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
function fullOddsRecord(umabans: readonly number[], comboSize: number, odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildComboOddsKey(combo)] = odds;
  }
  return record;
}

/**
 * n頭(昇順)から順序付きの全ペア(a≠b)を列挙し、一律のオッズ値を割り当てたRecordを作る
 * (馬単〈exacta〉専用。Issue #125)。`buildAllocationBetComboKey("exacta", pair)`
 * (唯一のゲートウェイ)でキー化するため、キー生成ロジック自体は複製しない。
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

/**
 * 8頭・複勝オッズに加えてワイド・3連複・馬連のオッズも一律高値(EVプラス確実)で持つ
 * フェイクレースデータ(Issue #117・AC-10)。**馬単(exactaCombo)は含めない**
 * (既存のquinella用AC-10テストが使う共有フィクスチャのため、exactaを混ぜると
 * greedy配分がexactaとquinellaの間でEVを奪い合い、既存テストの前提〈馬連に1円以上
 * 配分される〉が意図せず変わりうる。馬単専用の確認は`fakeRaceDataWithExacta`を使う)。
 */
function fakeRaceDataWithCombos(raceId: string): RaceData {
  const base = fakeRaceData(raceId);
  const umabans = base.horses.map((h) => h.shutuba.umaban);
  return {
    ...base,
    odds: {
      ...base.odds,
      wideCombo: fullOddsRecord(umabans, 2, 100000),
      trioCombo: fullOddsRecord(umabans, 3, 100000),
      quinellaCombo: fullOddsRecord(umabans, 2, 100000),
    },
  };
}

/**
 * 8頭・複勝オッズに加えて馬単のオッズも一律高値(EVプラス確実)で持つフェイクレースデータ
 * (Issue #125・AC-10)。`fakeRaceDataWithCombos`と同じレシピに倣うが、馬単の候補だけを
 * 単独で確認できるよう、ワイド・3連複・馬連のオッズは含めない
 * (`mixed-race-allocation-quinella.test.ts`の`quinellaOnlyRace`と同じ考え方)。
 */
function fakeRaceDataWithExacta(raceId: string): RaceData {
  const base = fakeRaceData(raceId);
  const umabans = base.horses.map((h) => h.shutuba.umaban);
  return {
    ...base,
    odds: {
      ...base.odds,
      exactaCombo: fullOrderedOddsRecord(umabans, 100000),
    },
  };
}

/**
 * `fakeRaceDataWithCombos`(ワイド・3連複・馬連)に馬単のオッズも足した、4券種すべてを
 * 持つフェイクレースデータ(Issue #125・AC-10の対照テスト専用)。includeExactaInAllocation=
 * OFFのときに他の組合せ券種(ワイド等)の存在によって混在経路(kind='mixed')に留まった
 * まま「馬単だけが現れない」ことを確認するために、`fakeRaceDataWithExacta`(馬単のみ)とは
 * 別に用意する。
 */
function fakeRaceDataWithAllCombos(raceId: string): RaceData {
  const base = fakeRaceDataWithCombos(raceId);
  const umabans = base.horses.map((h) => h.shutuba.umaban);
  return {
    ...base,
    odds: {
      ...base.odds,
      exactaCombo: fullOrderedOddsRecord(umabans, 100000),
    },
  };
}

const RACE_ID = "202605020811";
const KAISAI = "20260709";
const FIXED_NOW = new Date("2026-07-09T12:34:56.000Z");

function baseDeps(): AnalysisPipelineDeps {
  return {
    scrape: vi.fn(async () => fakeRaceData(RACE_ID)),
    analyze: null,
    saveAnalysis: vi.fn((_rec: AnalysisRecord) => 1),
    now: () => FIXED_NOW,
    llmSkipReason: "APIキー未設定",
    allocationSettings: null,
  };
}

describe("runAnalysis → AnalysisRecord.allocation の配線(Issue #59)", () => {
  beforeEach(() => {
    buildMixedRaceAllocationWithOutcomeMock.mockReset();
  });

  it("deps.allocationSettings===null なら record.allocation を含めないこと(旧分析との後方互換・AC4)", async () => {
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
    };
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(saved).toHaveLength(1); // 前提固定。
    expect(saved[0]!.allocation).toBeUndefined();
  });

  // Issue #118(#24-D3b-3)で契約反転: このテストはIssue #117まで「includeQuinellaInAllocationは
  // メタ行に漏れない(#59スキーマ固定を#24-D3aでは解除しない)」ことを保証していた。
  // Issue #118でこの凍結を解除した(coordinator裁定(A))ため、逆にincludeQuinellaInAllocationが
  // メタ行のincludeQuinellaへ反映されることを保証するテストへ書き換える。
  it("deps.allocationSettings が非nullなら、record.allocation.meta に設定8項目(evThresholdはevConfig由来・includeQuinellaはIssue #118で追加)が反映されること(route=unsetで確認)", async () => {
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      evConfig: { threshold: 1.2 },
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
      allocationSettings: {
        bankroll: 0, // unset(見送り)を確実に踏む。
        perRaceCap: 0,
        kellyFraction: 0.5,
        includeComboOdds: true,
        includeWideInAllocation: true,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: true,
        // #24-E3a(Issue #124): メタ行のスキーマは#59で凍結されたまま(既存8列を保つ)なので、
        // trueにしてもメタ行のincludeWide/includeTrio/includeQuinella以外は一切変わらないはず
        // (下のtoEqualで固定。"includeExacta"というキー自体が無い)。
        includeExactaInAllocation: true,
      },
    };
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(saved).toHaveLength(1); // 前提固定。
    const allocation = saved[0]!.allocation;
    expect(allocation).not.toBeUndefined();
    expect(allocation!.meta).toEqual({
      route: "unset",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 0,
      perRaceCap: 0,
      kellyFraction: 0.5,
      evThreshold: 1.2, // evConfig.threshold由来(allocationSettingsには持たせていない)。
      includeComboOdds: true,
      includeWide: true,
      includeTrio: false,
      includeQuinella: true,
      betUnit: null,
      greedySteps: null,
      candidateCap: null,
      modelId: null,
      modelApproximate: null,
      oddsStatus: "result",
    });
    expect(allocation!.bets).toEqual([]);
  });

  it("AC6: buildMixedRaceAllocationWithOutcome自体が例外を投げても runAnalysis は成功し、分析が保存され、メタ行がroute='invalid'で残ること", async () => {
    buildMixedRaceAllocationWithOutcomeMock.mockImplementation(() => {
      throw new Error("テスト用に強制した契約違反例外(呼び出し元の前提が崩れているケースを模す)");
    });
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
      allocationSettings: {
        bankroll: 300000,
        perRaceCap: 20000,
        kellyFraction: 0.5,
        includeComboOdds: true,
        includeWideInAllocation: true,
        includeTrioInAllocation: true,
        includeQuinellaInAllocation: true,
        includeExactaInAllocation: true,
      },
    };
    // runAnalysis自体が例外を投げず正常終了すること(分析本体を失わない)。
    const result = await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(result.raceId).toBe(RACE_ID);
    expect(saved).toHaveLength(1); // 前提固定(分析は保存された)。
    const allocation = saved[0]!.allocation;
    expect(allocation).not.toBeUndefined();
    expect(allocation!.meta).toEqual({
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 300000,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      evThreshold: 1.0, // deps.evConfig未指定 → DEFAULT_EV_CONFIG.threshold(1.0)。
      includeComboOdds: true,
      includeWide: true,
      includeTrio: true,
      includeQuinella: true,
      betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
      greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
      candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
      modelId: null,
      modelApproximate: null,
      oddsStatus: "result",
    });
    expect(allocation!.bets).toEqual([]);
  });

  it("Issue #117(AC-10): raceForAllocationのquinellaCombo/comboOddsが実際に消費され、馬連オッズあり・includeQuinellaInAllocation=ONのとき保存される配分記録(analysis_bets)にbet_type='quinella'の行が入ること", async () => {
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceDataWithCombos(RACE_ID)),
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
      allocationSettings: {
        // wide/trioはOFFにする(実測して確認: ワイドは「2頭が上位3着以内」というquinellaより
        // 緩い的中条件のため、同じオッズ〈100000〉ではワイドのEVがquinellaより大きく上回り、
        // greedy配分が予算をワイドだけで使い切ってしまい馬連に1円も配分されない。券種間の
        // 競合はこのテストの関心事ではないため、wide/tri併存によるEV競合を避け、
        // quinellaComboの配線そのもの〈AC-10の主張〉を単独で確認できる形にする)。
        bankroll: 300000,
        perRaceCap: 20000,
        kellyFraction: 0.5,
        includeComboOdds: true,
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: true,
        includeExactaInAllocation: true,
      },
    };
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(saved).toHaveLength(1); // 前提固定。
    const allocation = saved[0]!.allocation;
    expect(allocation).not.toBeUndefined();
    // 前提固定(空振り防止): 実際に混在配分が計算されたこと(route='invalid'/'unset'等ではないこと)。
    expect(allocation!.meta.route).toBe("mixed");
    const quinellaBets = allocation!.bets.filter((b) => b.betType === "quinella");
    expect(quinellaBets.length).toBeGreaterThan(0);
  });

  it("Issue #117(AC-10): includeQuinellaInAllocation=OFFなら、馬連オッズがあっても保存される配分記録にbet_type='quinella'の行が入らないこと(対照)", async () => {
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceDataWithCombos(RACE_ID)),
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
      allocationSettings: {
        bankroll: 3000000,
        perRaceCap: 3000000,
        kellyFraction: 0.5,
        includeComboOdds: true,
        includeWideInAllocation: true,
        includeTrioInAllocation: true,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: true,
      },
    };
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(saved).toHaveLength(1); // 前提固定。
    const allocation = saved[0]!.allocation;
    expect(allocation).not.toBeUndefined();
    expect(allocation!.meta.route).toBe("mixed");
    const quinellaBets = allocation!.bets.filter((b) => b.betType === "quinella");
    expect(quinellaBets).toEqual([]);
  });

  // 【Issue #125(#24-E3b)で改訂】旧版(#122時点)は`resolveMixedBetTypes`への接続が
  // #125のスコープで、その時点ではraceForAllocation.exactaComboが配分結果に一切影響しない
  // ことが結論だったため、「保存された配分にexacta由来の買い目が入ること」を直接確認する
  // AC-10型のテストが書けず、代わりに`buildMixedRaceAllocationWithOutcomeMock`の呼び出し
  // 引数を捕捉して「spreadが渡っていること」だけを確認していた(「配分結果には影響しない」
  // ことも対照として確認)。#125で接続されたため、quinellaのAC-10テスト
  // (Issue #117・上記287行目付近)と同じ形の「実際に保存されることの直接確認」に反転する。
  // 何を保証していたか(新旧対応表):
  //   旧: raceForAllocationにexactaCombo・comboOdds.exactaが渡っていること(モック引数捕捉)
  //       + includeExactaInAllocation=trueでも配分結果には一切影響しないこと(対照)
  //   新: 「Issue #125(AC-10): raceForAllocationのexactaCombo/comboOddsが実際に消費され、
  //       馬単オッズあり・includeExactaInAllocation=ONのとき保存される配分記録に
  //       bet_type='exacta'の行が入ること」+「OFFなら入らないこと(対照)」
  //       (quinellaのAC-10テストと同型。「渡っている」ことは「実際に使われて結果に出ること」
  //       で包含して確認するため、モック引数の直接捕捉は不要になった)
  it("Issue #125(AC-10): raceForAllocationのexactaCombo/comboOddsが実際に消費され、馬単オッズあり・includeExactaInAllocation=ONのとき保存される配分記録(analysis_bets)にbet_type='exacta'の行が入ること", async () => {
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceDataWithExacta(RACE_ID)),
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
      allocationSettings: {
        bankroll: 300000,
        perRaceCap: 20000,
        kellyFraction: 0.5,
        includeComboOdds: true,
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: true,
      },
    };
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(saved).toHaveLength(1); // 前提固定。
    const allocation = saved[0]!.allocation;
    expect(allocation).not.toBeUndefined();
    // 前提固定(空振り防止): 実際に混在配分が計算されたこと(route='invalid'/'unset'等ではないこと)。
    expect(allocation!.meta.route).toBe("mixed");
    const exactaBets = allocation!.bets.filter((b) => b.betType === "exacta");
    expect(exactaBets.length).toBeGreaterThan(0);
  });

  it("Issue #125(AC-10): includeExactaInAllocation=OFFなら、馬単オッズがあっても保存される配分記録にbet_type='exacta'の行が入らないこと(対照)", async () => {
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceDataWithAllCombos(RACE_ID)),
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
      allocationSettings: {
        bankroll: 3000000,
        perRaceCap: 3000000,
        kellyFraction: 0.5,
        includeComboOdds: true,
        includeWideInAllocation: true,
        includeTrioInAllocation: true,
        includeQuinellaInAllocation: true,
        includeExactaInAllocation: false,
      },
    };
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(saved).toHaveLength(1); // 前提固定。
    const allocation = saved[0]!.allocation;
    expect(allocation).not.toBeUndefined();
    expect(allocation!.meta.route).toBe("mixed");
    const exactaBets = allocation!.bets.filter((b) => b.betType === "exacta");
    expect(exactaBets).toEqual([]);
  });
});
