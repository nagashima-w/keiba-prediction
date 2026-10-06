/**
 * runAnalysis の出力を固定する「特性化テスト(golden)」の入力側(Issue #176〈#164-a〉AC-a1)。
 *
 * 目的: runAnalysis を cloud に載せるための変更(バレル import の差し替え・deps の非同期許容・当日傾向のバッチ読み出し)が、
 * **exe の出力を1バイトも変えない**ことを確かめる。golden JSON(`pipeline-golden.json`)は、変更前のコミット
 * (b821c97)でこのファイルの `computeGolden` を実行して生成した。生成手順は `scripts/gen-pipeline-golden.ts`
 * (`pnpm tsx scripts/gen-pipeline-golden.ts`)。入力はすべてリポジトリ内のフィクスチャ(`fixtures/`)と固定の合成値で、
 * 実ネットワーク・実 API には触れない。時刻は固定。
 *
 * シナリオ(3つ。いずれも中央16頭 202603020211 の実フィクスチャ・全券種の組合せオッズ入り):
 *  - `noLlmAllBets`: LLM なし・配分(全券種 ON)あり・開催日あり
 *  - `llmStubSameDayGrade`: LLM はスタブ(確定的な補正)・当日傾向(前走10本分の合成結果)・重賞の過去10年傾向(実フィクスチャの
 *    実応答を collectGradeWinnerTrend で集計)あり。**LLM に渡る promptInput とプロンプト本文**も固定する
 *  - `noLlmNoAllocationNoDate`: LLM なし・配分なし・開催日なし(当日日付で近似する経路)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  collectGradeWinnerTrend,
  parseKaisaiDate,
  parseRaceId,
  scrapeRace,
  type AnalysisRecord,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type PredictionMark,
  type RaceData,
  type RaceResultDetail,
} from "@keiba/core";
import { buildPrompt } from "@keiba/core/analyzer/build-prompt";

import type { AnalysisResult } from "../../src/shared/analysis-types.js";
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../../src/main/analysis-pipeline.js";

export const RACE_ID = parseRaceId("202603020211");
export const KAISAI_DATE = parseKaisaiDate("20260628");
export const FIXED_NOW = (): Date => new Date("2026-06-28T12:00:00.000Z");

function loadFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)),
    "utf-8",
  );
}

/** 戦績フィクスチャを馬ごとに変える(馬ID → フィクスチャ)。割り当ての無い馬は共通のものを返す。 */
const RESULTS_BY_HORSE: Record<string, string> = {
  "2023103386": "horse_results_2023103386.json",
  "2023105684": "horse_results_2021105857.json",
  "2023104885": "horse_results_2021105727.json",
  "2023101569": "horse_results_2024104976.json",
};

function fixtureForUrl(url: string): string {
  if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
  if (url.includes("ajax_horse_results")) {
    const horseId = /[?&]id=([^&]+)/.exec(url)?.[1] ?? "";
    return loadFixture(RESULTS_BY_HORSE[horseId] ?? "horse_results_2021105857.json");
  }
  if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
  if (url.includes("type=5")) return loadFixture("odds_wide_202603020211.json");
  if (url.includes("type=7")) return loadFixture("odds_trio_202603020211.json");
  if (url.includes("type=4")) return loadFixture("odds_quinella_202603020211.json");
  if (url.includes("type=6")) return loadFixture("odds_exacta_202603020211.json");
  if (url.includes("type=8")) return loadFixture("odds_trifecta_202603020211.json");
  if (url.includes("type=3")) return loadFixture("odds_wakuren_202603020211.json");
  if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
  throw new Error(`未知のURL: ${url}`);
}

/** フィクスチャから組み立てる(全券種の組合せオッズ入り)。 */
export async function scrapeFixtureRace(): Promise<RaceData> {
  return scrapeRace(
    RACE_ID,
    {
      fetcher: { fetchText: async (url) => fixtureForUrl(url) },
      now: FIXED_NOW,
    },
    { includeComboOdds: true },
  );
}

/** 前走のレース番号 → 合成した結果詳細(芝・10頭。着順・通過順・上がり3F は決定的な式)。 */
export function syntheticResultDetail(raceNumber: number): RaceResultDetail {
  return {
    courseType: "芝",
    horses: Array.from({ length: 10 }, (_, i) => i + 1).map((umaban) => {
      const pos = ((umaban * 3 + raceNumber) % 10) + 1;
      return {
        umaban,
        finishPosition: ((umaban + raceNumber) % 10) + 1,
        passing: [pos, pos],
        last3f: 34 + ((umaban * 7 + raceNumber) % 9) / 10,
      };
    }),
  };
}

/** 当日傾向の読み出しに使うレース結果(RaceId → 詳細)。01〜10R(自レース 11R より前だけでなく、12R も入れて混入を検出できるようにする)。 */
export function sameDayDetailOf(raceId: string): RaceResultDetail | undefined {
  if (!raceId.startsWith("2026030202")) return undefined;
  const raceNumber = Number(raceId.slice(10, 12));
  if (raceNumber < 1 || raceNumber > 12) return undefined;
  return syntheticResultDetail(raceNumber);
}

export const ALL_BETS_SETTINGS = {
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  includeComboOdds: true,
  includeWideInAllocation: true,
  includeTrioInAllocation: true,
  includeQuinellaInAllocation: true,
  includeExactaInAllocation: true,
  includeTrifectaInAllocation: true,
  includeBracketQuinellaInAllocation: true,
} as const;

/** 確定的な LLM スタブ。補正は ±5% 刻みで、予想印も決定的に付ける。 */
export function stubAnalyze(captured: BuildPromptInput[]): (input: BuildPromptInput) => Promise<AnalyzeRaceResult> {
  const marks: readonly (PredictionMark | null)[] = ["◎", "〇", "▲", "△", "☆", null];
  return async (input) => {
    captured.push(input);
    return {
      horses: [...input.horses]
        .sort((a, b) => a.umaban - b.umaban)
        .map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: Math.min(1, h.prior * (1 + 0.05 * ((h.umaban % 3) - 1))),
          reason: `スタブの根拠${h.umaban}`,
          clipped: false,
          usedPrior: false,
          mark: marks[h.umaban % marks.length] ?? null,
        })),
      fallback: false,
      retryCount: 0,
      fallbackReason: null,
      marksDropped: false,
      marksDroppedReason: null,
      rawResponse: "スタブの生応答",
      modelUsed: "claude-stub-model",
    };
  };
}

export interface GoldenScenarioOutput {
  /** runAnalysis の戻り値(AnalysisResult)。 */
  readonly result: AnalysisResult;
  /** saveAnalysis に渡った保存レコード(1件)。 */
  readonly record: AnalysisRecord;
  /** LLM スタブに渡った promptInput とプロンプト本文(LLM を使うシナリオだけ)。 */
  readonly promptInput?: BuildPromptInput;
  readonly promptText?: string;
  /** getRaceResultDetail に渡った raceId の列(呼び出し順。当日傾向を使うシナリオだけ)。 */
  readonly resultDetailLookups?: readonly string[];
}

export interface GoldenFile {
  readonly noLlmAllBets: GoldenScenarioOutput;
  readonly llmStubSameDayGrade: GoldenScenarioOutput;
  readonly noLlmNoAllocationNoDate: GoldenScenarioOutput;
}

/** JSON を経由して Infinity・undefined など JSON で表せない値を落とした形にする(golden と同じ表現で比べるため)。 */
export function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 3シナリオを実行して golden の形にまとめる。
 * `overrides` は deps へ足す上書き(変更後のコードで、同期・非同期の別の束縛でも同じ出力になることを確かめるために使う)。
 */
export async function computeGolden(
  overrides: Partial<AnalysisPipelineDeps> = {},
): Promise<GoldenFile> {
  const race = await scrapeFixtureRace();

  async function run(
    kaisaiDate: typeof KAISAI_DATE | null,
    deps: Partial<AnalysisPipelineDeps>,
  ): Promise<{ result: AnalysisResult; record: AnalysisRecord }> {
    const saved: AnalysisRecord[] = [];
    const result = await runAnalysis(RACE_ID, kaisaiDate, {
      scrape: async () => race,
      analyze: null,
      saveAnalysis: (record) => {
        saved.push(record);
        return saved.length;
      },
      allocationSettings: null,
      now: FIXED_NOW,
      ...deps,
      ...overrides,
    });
    if (saved.length !== 1) {
      throw new Error(`保存は1件のはずが ${saved.length} 件`);
    }
    return { result: viaJson(result), record: viaJson(saved[0]!) };
  }

  const noLlmAllBets = await run(KAISAI_DATE, {
    allocationSettings: ALL_BETS_SETTINGS,
    llmSkipReason: "golden: LLM なし",
  });

  const captured: BuildPromptInput[] = [];
  const lookups: string[] = [];
  const gradeFetcher = {
    fetchText: async () => loadFixture("grade_winner_202603020211.json"),
  };
  const llm = await run(KAISAI_DATE, {
    allocationSettings: ALL_BETS_SETTINGS,
    analyze: stubAnalyze(captured),
    modelName: "claude-stub-fixed",
    getRaceResultDetail: (raceId) => {
      lookups.push(raceId);
      return sameDayDetailOf(raceId);
    },
    getGradeWinnerTrend: (raceId, conditions, cutoffDate) =>
      collectGradeWinnerTrend(raceId, conditions, cutoffDate, { fetcher: gradeFetcher }),
  });
  if (captured.length !== 1) {
    throw new Error(`LLM スタブの呼び出しは1回のはずが ${captured.length} 回`);
  }

  const noLlmNoAllocationNoDate = await run(null, {});

  return {
    noLlmAllBets,
    llmStubSameDayGrade: {
      ...llm,
      promptInput: viaJson(captured[0]!),
      promptText: buildPrompt(captured[0]!),
      resultDetailLookups: [...lookups],
    },
    noLlmNoAllocationNoDate,
  };
}
