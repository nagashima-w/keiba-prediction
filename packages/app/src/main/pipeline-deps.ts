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
  computeRaceBreakdown,
  computeVerifyReport,
  computeVerifyReportByPromptVersion,
  HttpClient,
  listNarRaces,
  listRaces,
  parseRaceResult,
  ScrapeCache,
  scrapeRace,
  type BuildPromptInput,
  type EvConfig,
  type FetchLike,
  type KaisaiDate,
  type RaceId,
  type RaceListEntry,
  type ScorerConfig,
} from "@keiba/core";

import type {
  AnalysisHistoryItem,
  DeleteUnknownPromptVersionAnalysesResult,
  ImportResultOutcome,
  PromptVersionVerifyReportView,
  RaceBreakdownView,
  VerifyReportView,
  VerifyVenueFilter,
} from "../shared/analysis-types.js";
import type { AnalysisPipelineDeps } from "./analysis-pipeline.js";
import { buildRaceBreakdownView } from "./race-breakdown-view.js";
import { importRaceResult } from "./result-import.js";
import { buildAnalysisHistory } from "./verify-history.js";

/** createPipelineDeps の設定。 */
export interface PipelineWiringConfig {
  /** SQLiteファイルパス(":memory:" 可)。キャッシュと分析履歴を1ファイルに同居させる。 */
  readonly dbPath: string;
  /** Anthropic APIキー。未設定・空文字なら LLM分析をスキップする。 */
  readonly apiKey?: string;
  /**
   * scorer設定(設定画面の重みを DEFAULT_SCORER_CONFIG へマージしたもの)。
   * 省略時は runAnalysis 側で core の既定を用いる。
   */
  readonly scorerConfig?: ScorerConfig;
  /** EV設定(設定画面のEV閾値)。省略時は runAnalysis 側で既定(閾値1.0)を用いる。 */
  readonly evConfig?: EvConfig;
  /**
   * プロンプト追加指示(設定画面、Task#28 プロンプト改善C)。省略時・空文字・空白のみは
   * runAnalysis 側で「注入なし」として扱われる。
   */
  readonly additionalInstruction?: string;
  /**
   * HTTP取得に使う fetch(注入)。
   *
   * Electron main では Electron の net.fetch アダプタ(net-fetch-adapter)を渡し、
   * Chromium ネットワークスタック(システムプロキシ・OS TLS・Node バージョン非依存)で取得する。
   * 省略時は HttpClient が undici 既定を用いる。core の undici は Electron 互換の ^7 へ整合済みだが、
   * net.fetch の実利を得るため main では必ず渡す。
   * この層を electron 非依存に保つため、アダプタ生成は呼び出し側(ipc.ts)が担う。
   */
  readonly fetch?: FetchLike;
  /**
   * HttpClient のサポート外charset警告等を受け取るコールバック(要修正4)。
   * core パッケージ(HttpClient)は electron に依存できないため、ここで受け取った関数を
   * そのまま HttpClient へ注入する。呼び出し側(ipc.ts)がログ基盤(logWarn)へ接続する。
   * 省略時は HttpClient の既定(console.warn)が使われる。
   */
  readonly onWarn?: (message: string) => void;
}

/** 配線済みの依存一式(runAnalysis 用 deps + レース一覧取得 + 検証 + 後始末)。 */
export interface PipelineResources {
  /** runAnalysis に渡す依存。 */
  readonly deps: AnalysisPipelineDeps;
  /** 開催日の中央競馬レース一覧を取得する(キャッシュ経由)。 */
  readonly listRaces: (kaisaiDate: KaisaiDate) => Promise<RaceListEntry[]>;
  /** 開催日の地方競馬(NAR)レース一覧を取得する(キャッシュ経由)。 */
  readonly listNarRaces: (kaisaiDate: KaisaiDate) => Promise<RaceListEntry[]>;
  /** レース結果を取り込む(result.html取得→パース→実着順+複勝確定払戻を保存)。 */
  readonly importResult: (raceId: RaceId) => Promise<ImportResultOutcome>;
  /**
   * 分析済みで結果未取込(race_results に行が1件も無い)のレースIDをレースID昇順で列挙する
   * (Task#31 一括取込)。判定は AnalysisStore.listUnimportedRaceIds(NOT EXISTS)に委ねる。
   */
  readonly listUnimportedRaceIds: () => readonly string[];
  /**
   * 検証レポート(累積回収率・キャリブレーション表)を取得する。
   * @param venueKind 開催区分フィルタ(Task#32)。省略時は "all"(全体、従来どおり)。
   */
  readonly getVerifyReport: (venueKind?: VerifyVenueFilter) => VerifyReportView;
  /** プロンプト版別の検証レポート一覧を取得する(Task#27)。 */
  readonly getVerifyReportByPromptVersion: () => readonly PromptVersionVerifyReportView[];
  /**
   * プロンプト版不明(prompt_version が null)の分析をまとめて削除する(Task#33)。
   * AnalysisStore.deleteAnalysesWithUnknownPromptVersion に委譲する(analysis_horses も併せて削除、
   * race_results は削除しない)。
   */
  readonly deleteUnknownPromptVersionAnalyses: () => DeleteUnknownPromptVersionAnalysesResult;
  /**
   * レース単位の予実ブレークダウン一覧を取得する(Task#34)。verifyと同じ母集団のレースを、
   * 開催日降順(null は最後)→レースID昇順で返す。
   */
  readonly getRaceBreakdown: () => readonly RaceBreakdownView[];
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
  // fetch を注入すると undici 既定経路を通らず、Electron main では net.fetch(Chromium スタック)で取得する。
  const httpClient = new HttpClient({ fetch: config.fetch, onWarn: config.onWarn });
  const fetcher = new CachedFetcher({ fetcher: httpClient, cache });
  const store = new AnalysisStore({ database: db });

  // APIキー有無で LLM分析を分岐する。
  // 注(net.fetch 注入の見送り記録): Anthropic SDK には HttpClient/Discord と同様の net.fetch 注入は
  // していない。SDK は globalThis.fetch(= Electron 内蔵 Node の undici)を使い、Node 20 互換で動作する
  // ことを確認済みのため、現時点で注入は不要。将来システムプロキシ整合(社内プロキシ経由の LLM 呼び出し)が
  // 必要になった場合に SDK の fetch 差し替え注入を再検討する。
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
    // 設定画面の重み・EV閾値を分析へ反映する(未指定なら runAnalysis 側の既定)。
    scorerConfig: config.scorerConfig,
    evConfig: config.evConfig,
    additionalInstruction: config.additionalInstruction,
    llmSkipReason: useLlm
      ? undefined
      : "APIキー(ANTHROPIC_API_KEY)が未設定のため",
  };

  return {
    deps,
    listRaces: (kaisaiDate: KaisaiDate) => listRaces(kaisaiDate, { fetcher }),
    listNarRaces: (kaisaiDate: KaisaiDate) =>
      listNarRaces(kaisaiDate, { fetcher }),
    importResult: (raceId: RaceId): Promise<ImportResultOutcome> =>
      importRaceResult(raceId, {
        // 常にライブ取得(キャッシュ毒化回避)。パース失敗時は saveResult に到達しない。
        fetchText: (url, options) => fetcher.fetchText(url, options),
        parse: parseRaceResult,
        saveResult: (rid, entries) => store.saveResult(rid, entries),
      }),
    listUnimportedRaceIds: (): readonly string[] => store.listUnimportedRaceIds(),
    getVerifyReport: (venueKind?: VerifyVenueFilter): VerifyReportView =>
      computeVerifyReport(store, undefined, venueKind),
    getVerifyReportByPromptVersion: (): readonly PromptVersionVerifyReportView[] =>
      computeVerifyReportByPromptVersion(store),
    deleteUnknownPromptVersionAnalyses: (): DeleteUnknownPromptVersionAnalysesResult => ({
      deletedCount: store.deleteAnalysesWithUnknownPromptVersion(),
    }),
    getRaceBreakdown: (): readonly RaceBreakdownView[] =>
      buildRaceBreakdownView(computeRaceBreakdown(store)),
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
