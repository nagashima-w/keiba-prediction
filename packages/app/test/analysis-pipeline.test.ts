import {
  buildPriorInput,
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type HorseRaceResult,
  type OddsSnapshot,
  type RaceData,
  type RaceHorseData,
  type ShutubaHorse,
} from "@keiba/core";
import type { AnalysisRecord } from "@keiba/core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  resolveAnalysisDate,
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../src/main/analysis-pipeline.js";
import type { AnalysisProgress } from "../src/shared/analysis-types.js";

// buildPriorInput を実挙動そのままのスパイに差し替え、渡された race.date を検証できるようにする。
vi.mock("@keiba/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core")>();
  return { ...actual, buildPriorInput: vi.fn(actual.buildPriorInput) };
});

// ---- テスト用フェイクデータ組み立て ----------------------------------------

/** テスト用の全戦績1走分を作る(指定した日付・通過順以外は空)。 */
function fakeResult(date: string, passing: number[] = []): HorseRaceResult {
  return {
    date,
    venue: null,
    weather: null,
    raceNumber: null,
    raceName: null,
    raceId: null,
    raceIdRaw: null,
    venueKind: "中央",
    entryCount: 12,
    wakuban: null,
    umaban: null,
    odds: null,
    ninki: null,
    finishPosition: null,
    jockeyName: null,
    jockeyId: null,
    kinryo: null,
    courseType: null,
    distance: null,
    trackCondition: null,
    time: null,
    margin: null,
    passing,
    pace: null,
    last3f: null,
    bodyWeight: null,
    winnerName: null,
  };
}

/** テスト用の出馬表馬を作る。 */
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

/** 3頭・複勝オッズ付きのフェイクレースデータを作る。resultsByUmaban で戦績を差し込める。 */
function fakeRaceData(
  raceId: string,
  resultsByUmaban: Record<number, HorseRaceResult[]> = {},
): RaceData {
  const horses: RaceHorseData[] = [1, 2, 3].map((n) => ({
    shutuba: fakeHorse(n),
    results: resultsByUmaban[n] ?? [],
    oikiri: null,
  }));
  const odds: OddsSnapshot = {
    officialDatetime: "2026-07-09 09:00:00",
    win: {},
    place: {
      1: { oddsMin: 5.0, oddsMax: 6.0, ninki: 3 },
      2: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 },
      // 3番は複勝オッズ下限が欠損 → EV対象外になること。
      3: { oddsMin: null, oddsMax: null, ninki: null },
    },
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
      warnings: [{ kind: "戦績", message: "馬ID xxx の戦績取得に失敗しました" }],
    },
  };
}

const RACE_ID = "202605020811"; // 場コード05 → 東京。
const KAISAI = "20260709"; // 開催日(選択済みとして渡す)。
const FIXED_NOW = new Date("2026-07-09T12:34:56.000Z");

describe("resolveAnalysisDate(開催日の解決)", () => {
  it("YYYYMMDD が渡れば YYYY/MM/DD に変換し、近似ではない", () => {
    expect(resolveAnalysisDate("20250115", () => FIXED_NOW)).toEqual({
      date: "2025/01/15",
      approximate: false,
    });
  });

  it("null(渡らない)なら当日日付で近似し、approximate=true", () => {
    expect(resolveAnalysisDate(null, () => FIXED_NOW)).toEqual({
      date: "2026/07/09",
      approximate: true,
    });
  });
});

describe("runAnalysis(分析パイプライン)", () => {
  let saved: AnalysisRecord[];
  let progress: AnalysisProgress[];
  let baseDeps: () => AnalysisPipelineDeps;

  beforeEach(() => {
    (buildPriorInput as unknown as Mock).mockClear();
    saved = [];
    progress = [];
    baseDeps = () => ({
      scrape: vi.fn(async () => fakeRaceData(RACE_ID)),
      analyze: null,
      saveAnalysis: vi.fn((rec: AnalysisRecord) => {
        saved.push(rec);
        return saved.length;
      }),
      now: () => FIXED_NOW,
      llmSkipReason: "APIキー未設定",
    });
  });

  const onProgress = (p: AnalysisProgress): void => {
    progress.push(p);
  };

  it("選択済み開催日を buildPriorInput の race.date と結果に反映する(近似ではない)", async () => {
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate("20250115"),
      baseDeps(),
      onProgress,
    );

    expect(result.date).toBe("2025/01/15");
    expect(result.dateApproximate).toBe(false);

    const calls = (buildPriorInput as unknown as Mock).mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[0].race.date).toBe("2025/01/15");
    }
  });

  it("開催日が渡らない(null)場合は当日日付で近似し dateApproximate=true", async () => {
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      null,
      baseDeps(),
      onProgress,
    );
    expect(result.date).toBe("2026/07/09");
    expect(result.dateApproximate).toBe(true);
  });

  it("LLM無し(analyze=null): prior をそのまま採用し、EV・保存まで実行して結果を返す", async () => {
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );

    expect(result.venueName).toBe("東京");
    expect(result.raceName).toBe("テスト特別");
    expect(result.llmUsed).toBe(false);
    expect(result.llmSkippedReason).toBe("APIキー未設定");
    expect(result.fallback).toBe(false);

    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.umaban)).toEqual([1, 2, 3]);
    for (const row of result.rows) {
      expect(row.adjustedProb).toBe(row.prior);
      expect(row.reason).toBeNull();
      expect(row.prior).toBeGreaterThan(0);
      expect(row.prior).toBeLessThanOrEqual(1);
    }

    const row3 = result.rows.find((r) => r.umaban === 3)!;
    expect(row3.ev).toBeNull();
    expect(row3.isPositive).toBe(false);

    const row1 = result.rows.find((r) => r.umaban === 1)!;
    expect(row1.ev).toBeCloseTo(row1.adjustedProb * 5.0, 8);
    expect(row1.isPositive).toBe(row1.ev! > 1.0);

    expect(result.warnings).toContain("馬ID xxx の戦績取得に失敗しました");

    expect(saved).toHaveLength(1);
    expect(saved[0]!.raceId).toBe(RACE_ID);
    expect(saved[0]!.horses).toHaveLength(3);
    expect(result.analyzedAt).toBe(FIXED_NOW.toISOString());
  });

  it("進捗コールバックは4段階(スクレイピング→スコアリング→LLM分析→保存)を通知し、スコアリングは n/N頭 を報告する", async () => {
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );

    const stagesInOrder = progress.map((p) => p.stage);
    const firstIndex = (stage: string): number =>
      stagesInOrder.indexOf(stage as AnalysisProgress["stage"]);
    expect(firstIndex("スクレイピング")).toBeGreaterThanOrEqual(0);
    expect(firstIndex("スクレイピング")).toBeLessThan(firstIndex("スコアリング"));
    expect(firstIndex("スコアリング")).toBeLessThan(firstIndex("LLM分析"));
    expect(firstIndex("LLM分析")).toBeLessThan(firstIndex("保存"));

    const scoring = progress.filter((p) => p.stage === "スコアリング");
    expect(scoring).toHaveLength(3);
    expect(scoring.map((p) => p.current)).toEqual([1, 2, 3]);
    expect(scoring.every((p) => p.total === 3)).toBe(true);
  });

  it("LLMスキップ時は LLM分析段階でスキップ理由を通知する", async () => {
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );
    const llm = progress.filter((p) => p.stage === "LLM分析");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.message).toContain("スキップ");
  });

  it("LLM有り(analyze注入): 補正後確率と根拠を採用し、EVは補正後確率で計算する", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: 0.5,
          reason: `根拠${h.umaban}`,
          clipped: false,
          usedPrior: false,
        })),
        fallback: false,
        retryCount: 0,
        fallbackReason: null,
      }),
    );
    const deps: AnalysisPipelineDeps = { ...baseDeps(), analyze };

    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.llmUsed).toBe(true);
    expect(result.llmSkippedReason).toBeNull();
    for (const row of result.rows) {
      expect(row.adjustedProb).toBe(0.5);
      expect(row.reason).toBe(`根拠${row.umaban}`);
    }
    const row1 = result.rows.find((r) => r.umaban === 1)!;
    expect(row1.ev).toBeCloseTo(2.5, 8);
    expect(row1.isPositive).toBe(true);
    const row2 = result.rows.find((r) => r.umaban === 2)!;
    expect(row2.ev).toBeCloseTo(0.6, 8);
    expect(row2.isPositive).toBe(false);

    expect(saved[0]!.horses.every((h) => h.adjustedProb === 0.5)).toBe(true);
  });

  it("LLMプロンプトへ restInterval(直近走→開催日のレース間隔)を供給する", async () => {
    let captured: BuildPromptInput | null = null;
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => {
        captured = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      },
    );
    // 1番の直近走は 2026/06/28。開催日 2026/07/09 まで11日 → 「連闘〜中3週」。
    const scrape = vi.fn(async () =>
      fakeRaceData(RACE_ID, { 1: [fakeResult("2026/06/28")] }),
    );
    const deps: AnalysisPipelineDeps = { ...baseDeps(), analyze, scrape };

    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    const horse1 = captured!.horses.find((h) => h.umaban === 1)!;
    expect(horse1.restInterval).toBe("連闘〜中3週");
    const horse2 = captured!.horses.find((h) => h.umaban === 2)!;
    expect(horse2.restInterval ?? null).toBeNull();
  });

  it("LLMがフェイルセーフで prior にフォールバックした場合、result.fallback=true を返す", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: h.prior,
          reason: null,
          clipped: false,
          usedPrior: true,
        })),
        fallback: true,
        retryCount: 1,
        fallbackReason: "JSONパースに2回失敗",
      }),
    );
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      { ...baseDeps(), analyze },
      onProgress,
    );
    expect(result.llmUsed).toBe(true);
    expect(result.fallback).toBe(true);
  });
});
