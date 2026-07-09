/**
 * 分析パイプラインの「本番依存」配線。
 *
 * runAnalysis(analysis-pipeline.ts)は関数注入だけで完結するようにしてあるため、
 * ここで実IO(SQLiteキャッシュ+レート制限フェッチャ・LLMクライアント・分析ストア)を
 * 束ねて AnalysisPipelineDeps を組み立てる。electron には依存させず(dbPath/apiKey を引数で受ける)、
 * electron 固有のパス解決は呼び出し側(ipc.ts)が担う。
 *
 * DB共有: ScrapeCache(scrape_cache)と AnalysisStore(analyses ほか)は同一の
 * better-sqlite3 Database を共有する。テーブル名が独立しているため互いに干渉しない。
 */

import Database from "better-sqlite3";

import {
  AnalysisStore,
  analyzeRace,
  AnthropicLlmClient,
  CachedFetcher,
  HttpClient,
  listRaces,
  ScrapeCache,
  scrapeRace,
  type BuildPromptInput,
  type KaisaiDate,
  type RaceId,
  type RaceListEntry,
} from "@keiba/core";

import type { AnalysisPipelineDeps } from "./analysis-pipeline.js";

/** createPipelineDeps の設定。 */
export interface PipelineWiringConfig {
  /** SQLiteファイルパス(":memory:" 可)。キャッシュと分析履歴を1ファイルに同居させる。 */
  readonly dbPath: string;
  /** Anthropic APIキー。未設定・空文字なら LLM分析をスキップする。 */
  readonly apiKey?: string;
}

/** 配線済みの依存一式(runAnalysis 用 deps + レース一覧取得 + 後始末)。 */
export interface PipelineResources {
  /** runAnalysis に渡す依存。 */
  readonly deps: AnalysisPipelineDeps;
  /** 開催日のレース一覧を取得する(キャッシュ経由)。 */
  readonly listRaces: (kaisaiDate: KaisaiDate) => Promise<RaceListEntry[]>;
  /** DB接続などを閉じる。 */
  readonly close: () => void;
}

/** APIキーが実効値(空白のみでない)を持つかどうか。 */
export function shouldUseLlm(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.trim() !== "";
}

/**
 * 本番依存を配線する。
 * @param config DBパスとAPIキー
 */
export function createPipelineDeps(
  config: PipelineWiringConfig,
): PipelineResources {
  const db = new Database(config.dbPath);
  const cache = new ScrapeCache({ database: db });
  const httpClient = new HttpClient();
  const fetcher = new CachedFetcher({ fetcher: httpClient, cache });
  const store = new AnalysisStore({ database: db });

  // APIキー有無で LLM分析を分岐する。
  const useLlm = shouldUseLlm(config.apiKey);
  const analyze = useLlm
    ? (input: BuildPromptInput) =>
        analyzeRace(input, {
          llm: new AnthropicLlmClient({ apiKey: config.apiKey }),
        })
    : null;

  const deps: AnalysisPipelineDeps = {
    scrape: (raceId: RaceId) => scrapeRace(raceId, { fetcher }),
    analyze,
    saveAnalysis: (record) => store.saveAnalysis(record),
    llmSkipReason: useLlm
      ? undefined
      : "APIキー(ANTHROPIC_API_KEY)が未設定のため",
  };

  return {
    deps,
    listRaces: (kaisaiDate: KaisaiDate) => listRaces(kaisaiDate, { fetcher }),
    close: () => db.close(),
  };
}
