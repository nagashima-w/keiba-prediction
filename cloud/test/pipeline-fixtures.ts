/**
 * runAnalysis(クラウド版の取り込み。Issue #176)のテスト用の入力。リポジトリ内のフィクスチャ(`fixtures/`。中央16頭 202603020211)と
 * 固定の合成値だけで、実ネットワーク・実 API には触れない。内容は `packages/app/test/golden/pipeline-golden-scenarios.ts`
 * (exe 側の golden を生成するシナリオ)と同じ。cloud はその app 側のファイル(core のバレルを import する)を取り込めないので、
 * ここに必要な部分を写している(golden JSON との一致が、写しが食い違っていないことの検査になる)。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AnalyzeRaceResult } from "../../packages/core/src/analyzer/analyze-race";
import type { BuildPromptInput } from "../../packages/core/src/analyzer/build-prompt";
import type { PredictionMark } from "../../packages/core/src/analyzer/parse-response";
import type { RaceResultDetail } from "../../packages/core/src/ev/analysis-store-types";
import { parseKaisaiDate, parseRaceId } from "../../packages/core/src/scraper/ids";
import { scrapeRace, type RaceData } from "../../packages/core/src/scraper/scrape-race";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const RACE_ID = parseRaceId("202603020211");
export const KAISAI_DATE = parseKaisaiDate("20260628");
export const FIXED_NOW = (): Date => new Date("2026-06-28T12:00:00.000Z");

export function loadFixture(name: string): string {
  return readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
}

/** exe 側の golden JSON(変更前のコミットで生成)。 */
export const GOLDEN = JSON.parse(
  readFileSync(path.join(ROOT, "packages", "app", "test", "golden", "pipeline-golden.json"), "utf-8"),
) as {
  noLlmAllBets: { result: unknown; record: { kaisaiDate: string | null; allocation?: { bets: unknown[] } } };
  llmStubSameDayGrade: { result: unknown; record: unknown; promptInput: unknown };
};

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

/** フィクスチャから組み立てる(全券種の組合せオッズ入り)。取得した URL の列も返す。 */
export async function scrapeFixtureRace(): Promise<{ race: RaceData; urls: string[] }> {
  const urls: string[] = [];
  const race = await scrapeRace(
    RACE_ID,
    {
      fetcher: {
        fetchText: async (url) => {
          urls.push(url);
          return fixtureForUrl(url);
        },
      },
      now: FIXED_NOW,
    },
    { includeComboOdds: true },
  );
  return { race, urls };
}

/** 重賞の過去10年傾向の応答(実フィクスチャ)。 */
export const GRADE_WINNER_RESPONSE = (): string => loadFixture("grade_winner_202603020211.json");

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

/** 前走のレース番号 → 合成した結果詳細(app 側の golden シナリオと同じ式)。 */
export function sameDayDetailOf(raceId: string): RaceResultDetail | undefined {
  if (!raceId.startsWith("2026030202")) return undefined;
  const raceNumber = Number(raceId.slice(10, 12));
  if (raceNumber < 1 || raceNumber > 12) return undefined;
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

/** 確定的な LLM スタブ(app 側の golden シナリオと同じ)。 */
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

/** JSON を経由して、JSON で表せない値を落とした形にする。 */
export function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
