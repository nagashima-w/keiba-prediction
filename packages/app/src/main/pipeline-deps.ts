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
  computeRaceLedger,
  computeVerifyReport,
  computeVerifyReportByPromptVersion,
  DEFAULT_ANALYZER_CONFIG,
  HttpClient,
  listNarRaces,
  listRaces,
  parseRaceResult,
  resolveClipVariant,
  ScrapeCache,
  scrapeRace,
  type BuildPromptInput,
  type ClipVariantId,
  type EvConfig,
  type FetchLike,
  type KaisaiDate,
  type MessageSender,
  type RaceId,
  type RaceListEntry,
  type ScorerConfig,
} from "@keiba/core";

import type {
  DeleteUnknownPromptVersionAnalysesResult,
  ImportResultOutcome,
  PromptVersionVerifyReportView,
  RaceLedgerView,
  VerifyReportView,
  VerifyVenueFilter,
} from "../shared/analysis-types.js";
import type { AnalysisPipelineDeps } from "./analysis-pipeline.js";
import { pickLatestAnalysis, type AnalysisExportSource } from "./analysis-export.js";
import { buildRaceLedgerView } from "./race-ledger-view.js";
import { importRaceResult } from "./result-import.js";
import { venueNameFromRaceId } from "./venue-codes.js";

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
   * クリップ幅の版ID(タスクD-2: ±10%↔±15%のA/B・新版並走・2026-07-21 boss着手前ゲート合意)。
   * 省略時・不正値は対照("default"、±10%)へフォールバックする(resolveClipVariant)。
   * この設定から解決した単一の ClipVariant を、(a) analyzeRace へ渡す deps.maxAdjust の束縛、
   * (b) AnalysisPipelineDeps.clipVariant(analysis-pipeline.ts が promptInput.clipVariant・
   * 保存する promptVersion の解決に使う)の両方に用いる(文面とクリップ幅の食い違いを構造的に防ぐ。D-3)。
   */
  readonly clipVariant?: ClipVariantId;
  /**
   * テスト専用: LLM実送信関数の差し替え(code-reviewer指摘対応・2026-07-21)。
   * 省略時(本番既定)は AnthropicLlmClient の既定sender(実SDK呼び出し)を使う。
   * 指定すると、createPipelineDeps が組み立てる deps.analyze の LLM呼び出しがこの関数を経由する
   * ようになり、実ネットワーク・実API課金なしに「clipVariant→maxAdjust→parseAnalyzerResponseの
   * クリップ反映」という配線の核心区間(D-2)を単体テストで実際に踏んで検証できる
   * (AnthropicLlmClient コンストラクタの既存 deps.sender 注入口〈anthropic-client.ts〉をそのまま
   * 通すだけで、AnthropicLlmClient 自体・本番の既定挙動には一切手を入れない)。
   */
  readonly llmSender?: MessageSender;
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
  /**
   * フォールバック発生時(論点E)の診断ログ用コールバック。第1引数が診断メッセージ
   * (LLM呼び出し例外・JSONパース失敗の生詳細。truncated時は固定文言)、第2引数が
   * raceId・stopReason のみの構造化コンテキスト(apiKey・Webhookは含めない)。
   * 呼び出し側(ipc.ts)がログ基盤(logWarn)へ接続する。省略時は診断ログを残さない
   * (AnalysisPipelineDeps.onFallback は undefined のまま)。
   */
  readonly onFallback?: (
    message: string,
    context: { readonly raceId: string; readonly stopReason: string | null },
  ) => void;
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
   * 指定したプロンプト版で分析済みのレースIDをレースID昇順で列挙する(タスクB2b-1 期間バッチの
   * dedup bulk query)。AnalysisStore.listAnalyzedRaceIdsByPromptVersion に委ねる。
   */
  readonly listAnalyzedRaceIdsByPromptVersion: (version: string) => readonly string[];
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
   * レース単位の統合リスト(検証画面UI統合)を取得する。旧 getRaceBreakdown(結果取込済みのみ)と
   * 旧 listAnalysisHistory(分析単位・重複あり)を置き換える。母集団は「分析済みの全レース」
   * (latest統合済み・結果取込の有無を問わない)を、開催日降順(null は最後)→レースID昇順で返す。
   */
  readonly getRaceLedger: () => readonly RaceLedgerView[];
  /**
   * 分析データのエクスポート(Issue#10)用の材料を組み立てる。指定レースの分析が1件も無ければ
   * null。複数回分析済みなら最新(id最大)を対象にする(pickLatestAnalysis。決定的な選択)。
   * 会場名(venueName)はレースIDの場コードから解決し、結果(results/resultDetail)は
   * 取込済みならAnalysisStoreからそのまま渡す(未取込ならundefinedのまま)。
   * ツール名・ツール版・エクスポート実行時刻(electron/main固有の情報)は含まないため、
   * 呼び出し側(main/ipc.ts)がこれらを補って analysis-export.ts の
   * buildAnalysisExportDocument へ渡す。
   */
  readonly getAnalysisExportInput: (raceId: RaceId) => AnalysisExportSource | null;
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
  // クリップ幅版(タスクD-2)を1回だけ解決し、analyzeRace への束縛(maxAdjust)と
  // deps.clipVariant(analysis-pipeline.ts が promptInput.clipVariant・promptVersion の解決に使う)の
  // 両方に同じ変数を使う(単一ソース。文面とクリップ幅が別々の値を参照して食い違う余地を無くす)。
  const clipVariant = resolveClipVariant(config.clipVariant);
  const analyze = useLlm
    ? (input: BuildPromptInput) =>
        analyzeRace(input, {
          // config.llmSender はテスト専用の差し替え口(省略時 undefined なら
          // AnthropicLlmClient の既定sender=実SDK呼び出しのまま。本番挙動は不変)。
          llm: new AnthropicLlmClient(
            { apiKey: config.apiKey },
            config.llmSender ? { sender: config.llmSender } : {},
          ),
          maxAdjust: clipVariant.maxAdjust,
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
    clipVariant: clipVariant.id,
    // 使用するLLMモデル名(Issue#10)。LLM使用時のみ既定モデル名(anthropic-client.tsの
    // DEFAULT_ANALYZER_CONFIG.model)を注入する。LLM未使用時はundefinedのまま
    // (analysis-pipeline.ts側でllmUsed===falseのため、設定されていても保存レコードには使われない。
    // 二重の安全策として、そもそも注入自体もLLM使用時に限定する)。
    modelName: useLlm ? DEFAULT_ANALYZER_CONFIG.model : undefined,
    // 当日の同一場・同一面傾向(タスク#27-C)。store.getRaceResultDetail をそのまま束縛するだけで、
    // 新規スクレイピング・実リクエスト・DB書き込みは一切増えない(既存の取込済みデータの読み出しのみ)。
    getRaceResultDetail: (raceId: RaceId) => store.getRaceResultDetail(raceId),
    llmSkipReason: useLlm
      ? undefined
      : "APIキー(ANTHROPIC_API_KEY)が未設定のため",
    onFallback: config.onFallback
      ? (info) =>
          config.onFallback!(info.diagnosticMessage, {
            raceId: info.raceId,
            stopReason: info.stopReason,
          })
      : undefined,
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
        // courseType(面、タスク#27-A2)を素通しする。ここで引数を落とすと、
        // importRaceResult が渡す result.courseType が本番経路で握り潰される
        // (テストは緑でも実際にはrace_result_metaへ書かれない)ため、必ず転送する。
        saveResult: (rid, entries, courseType) =>
          store.saveResult(rid, entries, courseType),
      }),
    listUnimportedRaceIds: (): readonly string[] => store.listUnimportedRaceIds(),
    listAnalyzedRaceIdsByPromptVersion: (version: string): readonly string[] =>
      store.listAnalyzedRaceIdsByPromptVersion(version),
    getVerifyReport: (venueKind?: VerifyVenueFilter): VerifyReportView =>
      computeVerifyReport(store, undefined, venueKind),
    getVerifyReportByPromptVersion: (): readonly PromptVersionVerifyReportView[] =>
      computeVerifyReportByPromptVersion(store),
    deleteUnknownPromptVersionAnalyses: (): DeleteUnknownPromptVersionAnalysesResult => ({
      deletedCount: store.deleteAnalysesWithUnknownPromptVersion(),
    }),
    getRaceLedger: (): readonly RaceLedgerView[] =>
      buildRaceLedgerView(computeRaceLedger(store)),
    getAnalysisExportInput: (raceId: RaceId): AnalysisExportSource | null => {
      const latest = pickLatestAnalysis(store.listAnalyses({ raceId }));
      if (latest === null) {
        return null;
      }
      return {
        analysis: latest,
        venueName: venueNameFromRaceId(raceId),
        results: store.getResult(raceId),
        resultDetail: store.getRaceResultDetail(raceId),
      };
    },
    close: () => db.close(),
  };
}
