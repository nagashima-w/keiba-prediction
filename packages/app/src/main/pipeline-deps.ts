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
  computeVerifyReport,
  HttpClient,
  listRaces,
  parseRaceResult,
  ScrapeCache,
  scrapeRace,
  type BuildPromptInput,
  type KaisaiDate,
  type RaceId,
  type RaceListEntry,
} from "@keiba/core";

import type {
  AnalysisHistoryItem,
  ImportResultOutcome,
  VerifyReportView,
} from "../shared/analysis-types.js";
import type { AnalysisPipelineDeps } from "./analysis-pipeline.js";
import { importRaceResult } from "./result-import.js";
import { buildAnalysisHistory } from "./verify-history.js";

/** createPipelineDeps の設定。 */
export interface PipelineWiringConfig {
  /** SQLiteファイルパス(":memory:" 可)。キャッシュと分析履歴を1ファイルに同居させる。 */
  readonly dbPath: string;
  /** Anthropic APIキー。未設定・空文字なら LLM分析をスキップする。 */
  readonly apiKey?: string;
}

/** 配線済みの依存一式(runAnalysis 用 deps + レース一覧取得 + 検証 + 後始末)。 */
export interface PipelineResources {
  /** runAnalysis に渡す依存。 */
  readonly deps: AnalysisPipelineDeps;
  /** 開催日のレース一覧を取得する(キャッシュ経由)。 */
  readonly listRaces: (kaisaiDate: KaisaiDate) => Promise<RaceListEntry[]>;
  /** レース結果を取り込む(result.html取得→パース→実着順+複勝確定払戻を保存)。 */
  readonly importResult: (raceId: RaceId) => Promise<ImportResultOutcome>;
  /** 検証レポート(累積回収率・キャリブレーション表)を取得する。 */
  readonly getVerifyReport: () => VerifyReportView;
  /** 分析履歴一覧(検証画面用)を取得する。 */
  readonly listAnalysisHistory: () => AnalysisHistoryItem[];
  /** DB接続などを閉じる。 */
  readonly close: () => void;
}

// 注: 以前は結果ページに長TTL(90日)キャッシュを設けていたが、発走前に取込を押すと未確定HTMLが
// キャッシュに載り確定後も再取得されない「キャッシュ毒化」が起きるため廃止した。取込は手動・低頻度で
// 常に確定済み最新が欲しいので、importRaceResult は毎回 bypassCache: true でライブ取得する。

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
    importResult: (raceId: RaceId): Promise<ImportResultOutcome> =>
      importRaceResult(raceId, {
        // 常にライブ取得(キャッシュ毒化回避)。パース失敗時は saveResult に到達しない。
        fetchText: (url, options) => fetcher.fetchText(url, options),
        parse: parseRaceResult,
        saveResult: (rid, entries) => store.saveResult(rid, entries),
      }),
    getVerifyReport: (): VerifyReportView => computeVerifyReport(store),
    listAnalysisHistory: (): AnalysisHistoryItem[] => {
      const analyses = store.listAnalyses();
      // 結果取込済み(実着順あり)/払戻取込済み(複勝払戻あり)のレースID集合を作る。
      // 重複レースIDは1回だけ getResult する。着順のみで払戻が無いレースは hasPayout=false になる。
      const resultRaceIds = new Set<string>();
      const payoutRaceIds = new Set<string>();
      for (const raceId of new Set(analyses.map((a) => a.raceId))) {
        const results = store.getResult(raceId);
        if (results !== undefined) {
          resultRaceIds.add(raceId);
          if (results.some((r) => r.placePayout !== null && r.placePayout !== undefined)) {
            payoutRaceIds.add(raceId);
          }
        }
      }
      return buildAnalysisHistory(analyses, resultRaceIds, payoutRaceIds);
    },
    close: () => db.close(),
  };
}
