/**
 * #156(#41-B)`runAnalysis` を駆動する共通部。段階1(プロンプト生成)と段階3(適用)の**両方**が
 * この関数を通る。組み立ての二重実装を作らず、production の `runAnalysis` が作るプロンプト入力
 * (`BuildPromptInput`)をそのまま使うため。
 *
 * production との対応(`packages/app/src/main/analysis-pipeline.ts`):
 * - 取消・除外の馬は、結果ページで判別して出走馬から除く(#41 の `measure.ts` と同じ。#154 で
 *   `scrapeRace` が除くようになった production の入力と同じ形)。
 * - `kaisaiDate` を必ず渡す(近似日にならない)。#39・#153 の先読み遮断は `runAnalysis` が自分で行う。
 * - 同日傾向: `getRaceResultDetail` を、保存済みの結果ページ(`resultHtmlOf`)から作る。
 *   `runAnalysis`→`collectSameDayTrend` が**自レースより前**のレース番号だけを問い合わせる
 *   (後続レースの結果は構造的に見えない)。作り方は production の取込(`toResultEntries`)と同じ。
 * - 重賞の過去結果: `collectGradeWinnerTrend`(production と同じ関数)を、注入されたフェッチャで束縛する。
 *   段階1は記録フェッチャ、段階3は再生フェッチャ。cutoff は `runAnalysis` が渡す分析日。
 * - `clipVariant`・`additionalInstruction`・`now` は渡さない(production の既定: `default`・注入なし。
 *   `kaisaiDate` を渡すので `now` は使われない)。
 */

import {
  collectGradeWinnerTrend,
  parseKaisaiDate,
  parseRaceId,
  parseRaceResult,
  RaceResultNotConfirmedError,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type GradeWinnerFetcher,
  type RaceData,
  type RaceResult,
  type RaceResultDetail,
} from "../../packages/core/src/index.js";
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../../packages/app/src/main/analysis-pipeline.js";
import { toResultEntries } from "../../packages/app/src/main/result-import.js";
import type { AnalysisResult } from "../../packages/app/src/shared/analysis-types.js";
import {
  classifyRaceFinishes,
  type FinishClassification,
} from "../probability-quality-41/observation.js";

/** `driveRunAnalysis` の入力(1レース分)。 */
export interface DriveInput {
  readonly raceId: string;
  /** 実レース日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  /** raw の `RaceData`(取消除外前でもよい。結果ページで判別して除く)。 */
  readonly raceData: RaceData;
  /** 自レースの結果ページ HTML(取消・除外の判別に使う)。 */
  readonly resultHtml: string;
  /** 他レースの結果ページ HTML(同日傾向用)。無ければ undefined。 */
  readonly resultHtmlOf: (raceId: string) => string | undefined;
  /** 重賞の過去結果(`AplGradeWinner`)のフェッチャ(記録または再生)。 */
  readonly gradeFetcher: GradeWinnerFetcher;
}

/** `driveRunAnalysis` の出力。 */
export interface DriveOutput {
  readonly analysis: AnalysisResult;
  /** 取消・除外を除いた出走馬の `RaceData`。 */
  readonly runnerRace: RaceData;
  /** 着順の分類(`ok: true` のレースだけ返す)。 */
  readonly classification: Extract<FinishClassification, { ok: true }>;
  /** `getGradeWinnerTrend` が例外を投げた件(production は黙って null にするが、計測では黙らせない)。 */
  readonly gradeWinnerErrors: ReadonlyArray<{ readonly raceId: string; readonly message: string }>;
  /** 同日傾向のために `getRaceResultDetail` が問い合わせられたレースID(呼ばれた順)。 */
  readonly resultDetailLookups: readonly string[];
}

/**
 * 結果ページ HTML から、production の `AnalysisStore.getRaceResultDetail` が返すのと同じ形の
 * レース結果詳細を作る(取込の `toResultEntries` を通す。馬番昇順)。未確定のレースは undefined。
 */
export function buildRaceResultDetail(html: string): RaceResultDetail | undefined {
  let result: RaceResult;
  try {
    result = parseRaceResult(html);
  } catch (error) {
    if (error instanceof RaceResultNotConfirmedError) {
      return undefined;
    }
    throw error;
  }
  const entries = [...toResultEntries(result)].sort((a, b) => a.umaban - b.umaban);
  return {
    courseType: result.courseType ?? null,
    horses: entries.map((e) => ({
      umaban: e.umaban,
      finishPosition: e.finishPosition,
      passing: e.passing === undefined ? [] : [...e.passing],
      last3f: e.last3f ?? null,
    })),
  };
}

/**
 * 1レースについて `runAnalysis` を駆動する。`analyze` に渡した関数が、production の
 * `deps.analyze` と同じ `BuildPromptInput` を受け取る。
 *
 * @throws 結果ページの着順が分類できない・分析日が近似になった場合
 */
export async function driveRunAnalysis(
  input: DriveInput,
  analyze: (promptInput: BuildPromptInput) => Promise<AnalyzeRaceResult>,
): Promise<DriveOutput> {
  const raceId = parseRaceId(input.raceId);
  const ownResult = parseRaceResult(input.resultHtml);
  const classification = classifyRaceFinishes(
    input.raceData.horses.map((h) => h.shutuba.umaban),
    ownResult,
  );
  if (!classification.ok) {
    throw new Error(`${input.raceId}: 着順を分類できない(${classification.reason}: ${classification.detail})`);
  }
  const scratchedInShutuba = new Set(
    classification.scratched.filter((s) => s.inShutuba).map((s) => s.umaban),
  );
  const runnerRace: RaceData = {
    ...input.raceData,
    horses: input.raceData.horses.filter((h) => !scratchedInShutuba.has(h.shutuba.umaban)),
  };

  const gradeWinnerErrors: Array<{ raceId: string; message: string }> = [];
  const resultDetailLookups: string[] = [];
  const deps: AnalysisPipelineDeps = {
    scrape: async () => runnerRace,
    analyze,
    saveAnalysis: () => 0,
    allocationSettings: null,
    getRaceResultDetail: (rid) => {
      resultDetailLookups.push(rid);
      const html = input.resultHtmlOf(rid);
      return html === undefined ? undefined : buildRaceResultDetail(html);
    },
    getGradeWinnerTrend: (rid, conditions, cutoffDate) =>
      collectGradeWinnerTrend(rid, conditions, cutoffDate, { fetcher: input.gradeFetcher }),
    onGradeWinnerTrendError: (info) => {
      gradeWinnerErrors.push({ raceId: info.raceId, message: info.message });
    },
  };
  const analysis = await runAnalysis(raceId, parseKaisaiDate(input.kaisaiDate), deps);
  if (analysis.dateApproximate) {
    throw new Error(`${input.raceId}: 分析日が近似(kaisaiDate が渡っていない)`);
  }
  return { analysis, runnerRace, classification, gradeWinnerErrors, resultDetailLookups };
}
