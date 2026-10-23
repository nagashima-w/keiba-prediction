import { describe, expect, it, vi } from "vitest";

import {
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  type AnalysisRecord,
  type OddsSnapshot,
  type RaceData,
  type RaceHorseData,
  type ShutubaHorse,
} from "../../src/index.js";
import { runAnalysis, type AnalysisPipelineDeps } from "../../src/analysis/analysis-pipeline.js";
import { normalizeComboStats } from "../../src/analysis/combo-stats.js";
import { buildAllocationBetComboKey } from "../../src/ev/combo-bet-allocation.js";

/**
 * analysis-pipeline-combo-stats.test.ts — Issue #296。`runAnalysis` が、配分の候補の診断から作った `comboStats` を
 * R2 のスナップショット(`AnalysisRecord.raceSnapshot.comboStats`)に残す配線。配分を計算しなかった経路では残さない。
 */

const RACE_ID = "202605020811";
const KAISAI = "20260709";

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

/** 8頭。ワイドは全ペアを高オッズ(EV プラス確実)で持つ。 */
function fakeRace(withWide: boolean): RaceData {
  const horses: RaceHorseData[] = Array.from({ length: 8 }, (_, i) => ({ shutuba: fakeHorse(i + 1), results: [], oikiri: null }));
  const wideCombo: Record<string, number> = {};
  for (let a = 1; a <= 8; a++) {
    for (let b = a + 1; b <= 8; b++) wideCombo[buildAllocationBetComboKey("wide", [a, b])] = 100000;
  }
  const odds: OddsSnapshot = {
    officialDatetime: "2026-07-09 09:00:00",
    oddsStatus: "result",
    win: Object.fromEntries(horses.map((h) => [h.shutuba.umaban, { odds: 5.0, ninki: h.shutuba.umaban }])),
    place: Object.fromEntries(horses.map((h) => [h.shutuba.umaban, { oddsMin: 3.0, oddsMax: 4.0, ninki: h.shutuba.umaban }])),
    ...(withWide ? { wideCombo } : {}),
  };
  return {
    raceId: parseRaceId(RACE_ID),
    race: { raceName: "テスト特別", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良" },
    horses,
    odds,
    meta: { fetchedAt: "2026-07-09T00:00:00.000Z", oddsFetchedAt: "2026-07-09T00:00:05.000Z", warnings: [] },
  };
}

function depsWith(saved: AnalysisRecord[], race: RaceData, allocationSettings: AnalysisPipelineDeps["allocationSettings"]): AnalysisPipelineDeps {
  return {
    scrape: vi.fn(async () => race),
    analyze: null,
    saveAnalysis: (rec: AnalysisRecord) => {
      saved.push(rec);
      return 1;
    },
    now: () => new Date("2026-07-09T12:34:56.000Z"),
    llmSkipReason: "APIキー未設定",
    allocationSettings,
  };
}

const SETTINGS = {
  bankroll: 300000,
  perRaceCap: 20000,
  kellyFraction: 0.5,
  minHitProb: 0, // Issue #470: 既存のテストは下限なしで固定する
  includeComboOdds: true,
  includeWideInAllocation: true,
  includeTrioInAllocation: true,
  includeQuinellaInAllocation: true,
  includeExactaInAllocation: true,
  includeTrifectaInAllocation: true,
  includeBracketQuinellaInAllocation: true,
} as const;

describe("runAnalysis → raceSnapshot.comboStats の配線(Issue #296)", () => {
  it("組合せの配分を計算した分析は、スナップショットに comboStats(ワイドは 28 点中すべてプラス)を残し、元のスナップショットの項目も保つ", async () => {
    const saved: AnalysisRecord[] = [];
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), depsWith(saved, fakeRace(true), SETTINGS));
    expect(saved).toHaveLength(1);
    const snapshot = saved[0]!.raceSnapshot as Record<string, unknown>;
    const stats = normalizeComboStats(snapshot["comboStats"]);
    expect(stats).not.toBeNull();
    // 8 頭のワイドは C(8,2)=28 点。全ペアを 100000 倍にしたので全部プラス。
    expect(stats!.wide).toEqual({ positive: 28, judged: 28 });
    expect(stats!.trifecta).toEqual({ positive: 0, judged: 0 });
    // 既存のスナップショットの項目(レース・馬・組合せオッズ)は保たれる。
    expect(Object.keys(snapshot["wideCombo"] as object)).toHaveLength(28);
    expect((snapshot["race"] as { raceName: string }).raceName).toBe("テスト特別");
  });

  it("組合せのオッズが無く no-combo-candidates になった分析も、comboStats(含めた券種は 0 点)を残す", async () => {
    const saved: AnalysisRecord[] = [];
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), depsWith(saved, fakeRace(false), SETTINGS));
    const snapshot = saved[0]!.raceSnapshot as Record<string, unknown>;
    expect(normalizeComboStats(snapshot["comboStats"])!.wide).toEqual({ positive: 0, judged: 0 });
  });

  it("配分を計算しなかった分析(allocationSettings が null・総資金 0 の unset)は comboStats のキーを持たない", async () => {
    const saved: AnalysisRecord[] = [];
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), depsWith(saved, fakeRace(true), null));
    await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), depsWith(saved, fakeRace(true), { ...SETTINGS, bankroll: 0, perRaceCap: 0 }));
    expect(saved).toHaveLength(2);
    for (const rec of saved) {
      expect("comboStats" in (rec.raceSnapshot as Record<string, unknown>)).toBe(false);
    }
  });
});
