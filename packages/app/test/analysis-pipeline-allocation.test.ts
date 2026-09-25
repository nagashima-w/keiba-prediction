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
import { buildComboOddsKey, DEFAULT_GENERAL_BET_ALLOCATION_CONFIG } from "@keiba/core/ev/combo-bet-allocation";
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
 * 8頭・複勝オッズに加えてワイド・3連複・馬連のオッズも一律高値(EVプラス確実)で持つ
 * フェイクレースデータ(Issue #117・AC-10)。
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

  it("deps.allocationSettings が非nullなら、record.allocation.meta に設定7項目(evThresholdはevConfig由来)が反映されること(route=unsetで確認)。includeQuinellaInAllocation(#24-D3a)はメタ行に漏れないこと", async () => {
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
        // #24-D3a(Issue #115): メタ行のスキーマは#59で凍結されたまま(既存7列を保つ)なので、
        // trueにしてもメタ行のincludeWide/includeTrio以外は一切変わらないはず(下のtoEqualで固定)。
        includeQuinellaInAllocation: true,
      },
    };
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    expect(saved).toHaveLength(1); // 前提固定。
    const allocation = saved[0]!.allocation;
    expect(allocation).not.toBeUndefined();
    // includeQuinellaInAllocation=trueを渡しているが、メタ行(#59スキーマ固定)には
    // "includeQuinella"というキー自体が無い(このtoEqualが完全一致のため、もし実装が
    // 誤って追加してしまえばここで検出される。#24-D3a裁定: DB列追加は#24-D3bへ送る)。
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
});
