/**
 * 分析パイプライン(`runAnalysis`)のクラウド版の入口(Issue #176〈#164-a〉)。
 *
 * exe(`packages/app`)の `main/analysis-pipeline.ts` の `runAnalysis` を、**組み直さずに相対 import で取り込む**
 * (取得 → 戦績の先読みリーク遮断 → scorer → LLM → EV → 配分 → 保存。exe と同じコードなので、出力は同じになる。
 * exe の出力は golden〈`packages/app/test/golden/pipeline-golden.json`〉で固定されており、cloud のテストも同じ golden と照合する)。
 *
 * 取り込めるのは、`runAnalysis` の閉包が Electron・better-sqlite3・Node 固有の API を値で import しないため。core は
 * バレル(`@keiba/core`)ではなく、狭い入口 `@keiba/core/pipeline`(better-sqlite3 に依存するモジュールを型でも経由しない)から取る
 * (`wrangler.toml` の `[alias]`・`tsconfig.json` の `paths`・`vitest.config.ts` の `alias` が `@keiba/core` を `packages/core/src` に向ける)。
 * 静的ガード: `test/import-guard.test.ts`。バンドルの実物の検査: `test/bundle-guard.test.ts`。
 *
 * **deps は非同期でもよい**(D1 は非同期): `saveAnalysis` は Promise でもよく、runAnalysis が完了を待つ(reject は伝わる)。
 * 当日傾向は `getRaceResultDetails`(前のレースの ID をまとめて1回で引く。D1 の1呼び出しあたりのクエリ数の上限を避ける)で渡す。
 *
 * このモジュールは、まだ本番のエントリ(`worker.ts`)から呼ばれていない(呼び出し元は #177 以降)。
 */
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../../packages/app/src/main/analysis-pipeline";
import type { AnalysisProgress, AnalysisResult } from "../../packages/app/src/shared/analysis-types";
import type { KaisaiDate, RaceId } from "../../packages/core/src/scraper/ids";

export type { AnalysisPipelineDeps as CloudAnalysisDeps, AnalysisResult as CloudAnalysisResult };

/**
 * 1レースを分析する。**`kaisaiDate`(YYYYMMDD)は必須**。
 * runAnalysis は、開催日が渡らないと当日日付(実行環境のローカル時刻。Worker は UTC)で近似し、季節・休み明けの起点がずれうる。
 * クラウド版にはその近似に落ちる経路を作らない(取得も保存もする前に拒否する)。
 */
export async function runCloudAnalysis(
  raceId: RaceId,
  kaisaiDate: KaisaiDate,
  deps: AnalysisPipelineDeps,
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<AnalysisResult> {
  if (typeof kaisaiDate !== "string" || !/^[0-9]{8}$/.test(kaisaiDate)) {
    throw new Error(`kaisaiDate(YYYYMMDD の8桁)が必要です(渡された値: ${String(kaisaiDate)})`);
  }
  const result = await runAnalysis(raceId, kaisaiDate, deps, onProgress);
  if (result.dateApproximate) {
    // 到達しない(上で8桁を確かめている)。万一 runAnalysis の仕様が変わって近似に落ちたら、静かに通さない。
    throw new Error("開催日が近似になりました(クラウド版では許可しない)");
  }
  return result;
}
