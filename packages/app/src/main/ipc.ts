import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";

import {
  DiscordNotifyError,
  filterJpnOnlyEntries,
  isDiscordWebhookUrl,
  parseKaisaiDate,
  parseRaceId,
  raceResultUrl,
  resolveClipVariant,
  sendDiscordNotification,
  type DiscordPayload,
  type KaisaiDate,
} from "@keiba/core";

import type {
  BatchProgress,
  BatchRaceOutcome,
  BulkImportProgress,
  BulkImportRaceOutcome,
  DeleteUnknownPromptVersionAnalysesResult,
  ImportResultOutcome,
  LogExportOutcome,
  PeriodBatchCollectResult,
  PeriodBatchDayOutcomeView,
  PeriodBatchTargetRace,
  PromptVersionVerifyReportView,
  RaceLedgerView,
  RaceListItem,
  RaceListTarget,
  RaceVenueKind,
  VerifyReportView,
  VerifyVenueFilter,
} from "../shared/analysis-types.js";
import { collectRaceIdsOverRange, type RangeCollectResult } from "./range-collect.js";
import { buildBatchDiscordPayload } from "./batch-discord-payload.js";
import { IPC_CHANNELS } from "../shared/channels.js";
import type { MaskedSettings, SettingsUpdate } from "../shared/settings.js";
import { buildAppInfo } from "./app-info.js";
import { runAnalysis } from "./analysis-pipeline.js";
import { runBatchAnalysis } from "./analysis-batch.js";
import { runBulkImport } from "./import-batch.js";
import { buildDefaultLogExportFileName, collectLogExportContent } from "./log-export.js";
import { getLogDirectory, logError, logWarn, setSecretsProvider } from "./logger.js";
import { netFetchAdapter } from "./net-fetch-adapter.js";
import { createPipelineDeps, type PipelineResources } from "./pipeline-deps.js";
import { ResourceManager } from "./resource-manager.js";
import {
  applyUpdate,
  buildEvConfig,
  buildScorerConfig,
  DEFAULT_APP_SETTINGS,
  maskSettings,
  resolveEffectiveApiKey,
  SettingsStore,
} from "./settings-store.js";
import { toRaceListItem } from "./to-race-list-item.js";
import { withErrorLogging } from "./with-error-logging.js";

/**
 * main プロセスの IPC ハンドラをまとめて登録する。
 *
 * アプリ情報(app-info)は Electron 非依存の純関数に委ねる。
 * レース一覧・分析実行は実IO(SQLite・HTTP・LLM)を伴うため、依存は pipeline-deps に配線し、
 * 進捗は event.sender.send で renderer へ一方向通知する。実IOの配線はテスト対象外(結線層)。
 */
export function registerIpcHandlers(): void {
  // ログのマスキング(Task#35)に使う「既知の秘密値」を登録する。設定変更を都度反映するため、
  // 値ではなく関数で渡す(ログ出力の直前に毎回 getSettingsStore().load() を呼ぶ)。
  setSecretsProvider(() => {
    const settings = getSettingsStore().load();
    return [
      settings.apiKey,
      settings.discordWebhookUrl,
      process.env.ANTHROPIC_API_KEY ?? "",
    ];
  });

  ipcMain.handle(IPC_CHANNELS.getAppInfo, () => buildAppInfo(app.getVersion()));

  ipcMain.handle(
    IPC_CHANNELS.listRaces,
    (_event, date: unknown, venueKind: unknown, jpnOnly: unknown) =>
      handleListRaces(
        String(date),
        venueKind === "nar" ? "nar" : "central",
        jpnOnly === true,
      ),
  );

  ipcMain.handle(
    IPC_CHANNELS.runBatchAnalysis,
    (event, raceIds: unknown, date: unknown) =>
      handleRunBatchAnalysis(
        event,
        (Array.isArray(raceIds) ? raceIds : []).map(String),
        String(date),
      ),
  );

  ipcMain.handle(IPC_CHANNELS.cancelBatchAnalysis, () =>
    handleCancelBatchAnalysis(),
  );

  ipcMain.handle(
    IPC_CHANNELS.collectPeriodBatch,
    (_event, from: unknown, to: unknown, target: unknown) =>
      handleCollectPeriodBatch(
        String(from),
        String(to),
        normalizeRaceListTarget(target),
      ),
  );

  ipcMain.handle(IPC_CHANNELS.cancelCollectPeriodBatch, () =>
    handleCancelCollectPeriodBatch(),
  );

  ipcMain.handle(
    IPC_CHANNELS.runPeriodBatchAnalysis,
    (event, targetRaces: unknown) =>
      handleRunPeriodBatchAnalysis(event, normalizePeriodBatchTargetRaces(targetRaces)),
  );

  ipcMain.handle(IPC_CHANNELS.importResult, (_event, raceId: unknown) =>
    handleImportResult(String(raceId)),
  );

  ipcMain.handle(IPC_CHANNELS.runBulkImport, (event) =>
    handleRunBulkImport(event),
  );

  ipcMain.handle(IPC_CHANNELS.cancelBulkImport, () =>
    handleCancelBulkImport(),
  );

  ipcMain.handle(IPC_CHANNELS.getVerifyReport, (_event, venueKind: unknown) =>
    handleGetVerifyReport(normalizeVerifyVenueFilter(venueKind)),
  );

  ipcMain.handle(IPC_CHANNELS.getVerifyReportByPromptVersion, () =>
    handleGetVerifyReportByPromptVersion(),
  );

  ipcMain.handle(IPC_CHANNELS.deleteUnknownPromptVersionAnalyses, () =>
    handleDeleteUnknownPromptVersionAnalyses(),
  );

  ipcMain.handle(IPC_CHANNELS.getRaceLedger, () => handleGetRaceLedger());

  ipcMain.handle(IPC_CHANNELS.getSettings, () => handleGetSettings());

  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, update: unknown) =>
    handleSaveSettings(update as SettingsUpdate),
  );

  ipcMain.handle(IPC_CHANNELS.resetSettings, () => handleResetSettings());

  ipcMain.handle(IPC_CHANNELS.sendBatchDiscord, (_event, outcomes: unknown) =>
    handleSendBatchDiscord(
      (Array.isArray(outcomes) ? outcomes : []) as BatchRaceOutcome[],
    ),
  );

  // renderer側のエラーをmain側のログファイルへ集約する(Task#35 受け入れ条件6)。
  ipcMain.handle(IPC_CHANNELS.logRendererError, (_event, payload: unknown) =>
    handleLogRendererError(payload),
  );

  // ログ取り出し導線(Task#36)。
  ipcMain.handle(IPC_CHANNELS.openLogFolder, () => handleOpenLogFolder());
  ipcMain.handle(IPC_CHANNELS.exportLogs, (event) => handleExportLogs(event));
}

/**
 * 配線済み依存を解放する(DB接続のクローズ)。
 * main の will-quit で呼び、次回起動まで持ち越さない。close は冪等。
 */
export function closeResources(): void {
  resourceManager.close();
}

/**
 * 分析の依存(SQLiteキャッシュ・分析ストア・LLM)を配線して使い回す。
 * DBのオープンはコストがあるため、最初に必要になった時点で遅延生成する
 * (registerIpcHandlers 時点では DB を開かない → app 情報のみのテストに副作用が無い)。
 *
 * 生成時に現在の設定(重み・EV閾値・APIキー)を読み込んで反映する。APIキーは環境変数優先。
 * 設定保存(markDirty)で破棄予約されるが、分析実行中は破棄を遅延し(実行中の DB を閉じない)、
 * 次のアイドル時の acquire で最新設定に再構築する(再起動不要)。
 */
const resourceManager = new ResourceManager<PipelineResources>({
  create: () => {
    const settings = getSettingsStore().load();
    return createPipelineDeps({
      dbPath: path.join(app.getPath("userData"), "keiba.db"),
      apiKey: resolveEffectiveApiKey(settings, process.env.ANTHROPIC_API_KEY),
      scorerConfig: buildScorerConfig(settings),
      evConfig: buildEvConfig(settings),
      additionalInstruction: settings.additionalInstruction,
      // クリップ幅版(タスクD-2)。設定画面のセレクタで選んだ版をそのまま渡す
      // (未設定・不正値は pipeline-deps.ts 側の resolveClipVariant が対照へフォールバックする)。
      clipVariant: settings.clipVariant,
      // Electron の net.fetch を注入し、undici(Electron 内蔵 Node 20 では非互換)を通さない。
      fetch: netFetchAdapter,
      // HttpClient(core)のサポート外charset警告をログ基盤へ接続する(要修正4)。
      onWarn: (message: string) => logWarn(HTTP_CLIENT_WARN_OPERATION, message),
      // LLMフォールバック発生時の診断ログをログ基盤へ接続する(論点E・#35診断ログ保持)。
      // message(diagnosticMessage)には例外の生詳細が入りうるが、logWarn→formatLogEntry
      // (shared/log-formatter.ts)で apiKey・Webhook等の既知の秘密値を必ずマスキングしてから
      // 出力するため、この配線自体は生の詳細を持ち回ってよい(UI/DBには一切渡さない)。
      onFallback: (message: string, context: { raceId: string; stopReason: string | null }) =>
        logWarn(ANALYSIS_FALLBACK_OPERATION, message, context),
    });
  },
  close: (resources) => resources.close(),
});

/** 設定ストア(settings.json)。app.getPath を避けるため遅延生成する。 */
let settingsStore: SettingsStore | null = null;

/** 設定ストアを取得する(未生成なら userData 配下に生成)。 */
function getSettingsStore(): SettingsStore {
  if (settingsStore === null) {
    settingsStore = new SettingsStore(
      path.join(app.getPath("userData"), "settings.json"),
    );
  }
  return settingsStore;
}

/** 配線済み依存を取得する(未生成・設定変更保留かつアイドルなら再構築)。 */
function getResources(): PipelineResources {
  return resourceManager.acquire();
}

/**
 * レース一覧取得ハンドラの実処理。
 * 開催区分(venueKind)に応じて資源(PipelineResources)の listRaces / listNarRaces を呼び分ける
 * (仕様「選択に応じて listRaces / listNarRaces を呼び分ける」。既定は central)。
 *
 * jpnOnly=true かつ venueKind='nar' のときのみ、交流重賞(Jpn1/2/3)だけに絞り込む(タスクB1)。
 * venueKind='central' のときは jpnOnly の値に関わらず無視する(中央+Jpn限定で全滅させる事故防止。
 * 3択UI側でも central 選択時は jpnOnly=false 固定にしているが、IPC層でも二重にガードする)。
 * core の listRaces/listNarRaces 自体は無改修で、フィルタは取得結果に対しmain層で適用する。
 */
async function handleListRaces(
  dateStr: string,
  venueKind: RaceVenueKind,
  jpnOnly: boolean,
): Promise<RaceListItem[]> {
  return withErrorLogging(
    IPC_CHANNELS.listRaces,
    { date: dateStr, venueKind, jpnOnly },
    async () => {
      const kaisaiDate = parseKaisaiDate(dateStr);
      // キャッシュミス時に取得→scrape_cache へ書き込む await があるため runExclusive で保護する
      // (実行中の設定保存で DB を閉じられて「connection is not open」になるのを防ぐ)。
      const entries = await resourceManager.runExclusive((resources) =>
        venueKind === "nar"
          ? resources.listNarRaces(kaisaiDate)
          : resources.listRaces(kaisaiDate),
      );
      const filtered =
        venueKind === "nar" && jpnOnly ? filterJpnOnlyEntries(entries) : entries;
      return filtered.map(toRaceListItem);
    },
  );
}

/** 開催日文字列を検証する。妥当な YYYYMMDD でなければ null(パイプライン側で当日近似)。 */
function parseKaisaiDateOrNull(dateStr: string): KaisaiDate | null {
  try {
    return parseKaisaiDate(dateStr);
  } catch {
    return null;
  }
}

/**
 * 一括分析の中断フラグ(main プロセス内の単一実行を前提とした module 状態)。
 * runBatchAnalysis 開始時に false へリセットし、cancel チャネルで true にする。
 * runBatchAnalysis は各レース境界でこの値を参照し、要求されていれば残りをスキップする。
 * 同時に複数の一括分析は走らない(実行中は UI が再実行を無効化する)前提のため単一フラグで足りる。
 */
let batchCancelRequested = false;

/** 一括分析の per-race 失敗ログの操作名(全体起動の失敗ログとは区別する)。 */
const BATCH_ANALYSIS_RACE_OPERATION = `${IPC_CHANNELS.runBatchAnalysis}:race`;

/** 期間バッチ実行(phase2)の per-race 失敗ログの操作名(タスクC1)。 */
const PERIOD_BATCH_ANALYSIS_RACE_OPERATION = `${IPC_CHANNELS.runPeriodBatchAnalysis}:race`;

/**
 * HttpClient(core)のサポート外charset警告の操作名(要修正4)。
 * core は electron に依存できないため console.warn が既定だが、main プロセスでは
 * ログ基盤(logWarn)へ接続する(resourceManager.create() で HttpClient へ onWarn として注入)。
 */
const HTTP_CLIENT_WARN_OPERATION = "http-client:unsupported-charset";

/**
 * LLMフォールバック(prior復帰)発生時の診断ログの操作名(論点E・#35診断ログ保持)。
 * grepで「LLM呼び出し失敗・JSON解析失敗の原因を辿りたい」場面を見つけやすくするための固定文字列。
 */
const ANALYSIS_FALLBACK_OPERATION = "analysis:fallback";

/**
 * 一括分析ハンドラの実処理。選択レースを直列に分析し、per-race のアウトカムを返す。
 * 全体を runExclusive 1回で包む(粗い粒度)ことで、バッチ実行中は DB を閉じさせない。
 * 設定保存(markDirty)はバッチ完了後の次アイドルまで反映されない(バッチ内の設定は一貫)。
 * 進捗は batch-progress チャネルで renderer へ一方向通知する。
 */
async function handleRunBatchAnalysis(
  event: IpcMainInvokeEvent,
  raceIdStrs: readonly string[],
  dateStr: string,
): Promise<BatchRaceOutcome[]> {
  return withErrorLogging(IPC_CHANNELS.runBatchAnalysis, undefined, async () => {
    const kaisaiDate = parseKaisaiDateOrNull(dateStr);
    // 新しいバッチの開始時に前回の中断要求を必ずクリアする(残留で即スキップにならないように)。
    batchCancelRequested = false;
    return resourceManager.runExclusive(({ deps }) =>
      runBatchAnalysis(raceIdStrs, {
        // 個別レースは既存の runAnalysis を1件ずつ実行し、レース内段階を全体進捗へ転送する。
        analyzeOne: (raceIdStr, onStage) =>
          runAnalysis(parseRaceId(raceIdStr), kaisaiDate, deps, onStage),
        shouldCancel: () => batchCancelRequested,
        onProgress: (progress: BatchProgress) => {
          event.sender.send(IPC_CHANNELS.batchProgress, progress);
        },
        // per-race の失敗はここで構造化ログを残す(操作名・raceId・例外スタック)。
        // outcomes には既存どおり failure として記録され、renderer 側の挙動は変わらない。
        onError: (raceId, error) => {
          logError(BATCH_ANALYSIS_RACE_OPERATION, error, { raceId });
        },
      }),
    );
  });
}

/** 一括分析の中断要求ハンドラ。次のレース境界で停止させるためフラグを立てる。 */
function handleCancelBatchAnalysis(): void {
  batchCancelRequested = true;
}

/**
 * 期間バッチ「先取得+件数算出」(phase1)の中断フラグ(タスクB2b-1)。
 * 一括分析の中断(batchCancelRequested)とは独立したモジュール変数で、
 * bulkImportCancelRequested と同じ流儀(専用フラグ・専用チャネル)を踏襲する。
 */
let periodBatchCollectCancelRequested = false;

/**
 * IPC越しに届いた RaceListTarget 引数を検証済みの値へ正規化する(タスクB2b-1)。
 * 未指定・不正値は既定の "central" にフォールバックする(handleListRaces の venueKind 正規化と同じ方針)。
 */
function normalizeRaceListTarget(value: unknown): RaceListTarget {
  return value === "nar-all" || value === "nar-jpn" ? value : "central";
}

/**
 * core の RangeCollectResult(RaceId/KaisaiDateブランド型を含む)を、IPCシリアライズ用の
 * プレーンな PeriodBatchCollectResult(すべて素の string)へ変換する(タスクB2b-1)。
 */
function toPeriodBatchCollectResult(
  result: RangeCollectResult,
): PeriodBatchCollectResult {
  const perDayOutcome: PeriodBatchDayOutcomeView[] = result.perDayOutcome.map(
    (o) => {
      if (o.status === "hasRaces") {
        return { date: String(o.date), status: "hasRaces", raceCount: o.raceCount };
      }
      if (o.status === "empty") {
        return { date: String(o.date), status: "empty" };
      }
      return { date: String(o.date), status: "failure", error: o.error };
    },
  );
  return {
    totalRaces: result.totalRaces,
    skippedAlreadyAnalyzed: result.skippedAlreadyAnalyzed,
    // ブランド型(RaceId/KaisaiDate)からプレーンな string へ(タスクC1: レースごとのkaisaiDateを保持)。
    targetRaces: result.targetRaces.map((t) => ({
      raceId: String(t.raceId),
      kaisaiDate: String(t.kaisaiDate),
    })),
    failureDays: result.failureDays.map(String),
    perDayOutcome,
    cancelled: result.cancelled,
  };
}

/**
 * 期間バッチ「先取得+件数算出」(phase1)ハンドラの実処理(タスクB2b-1)。
 * B2aの collectRaceIdsOverRange(純ロジック)を呼ぶだけで、LLM分析(runBatchAnalysis/analyzeOne)は
 * 一切呼ばない(実行〈phase2〉は対象確定後に既存 runBatchAnalysis を再利用する。別ハンドラ)。
 *
 * 収集ループ全体を runExclusive 1回で包む(handleRunBulkImport と同じ粗い粒度)ことで、
 * 収集中は DB を閉じさせない。bulk query(listAnalyzedRaceIdsByPromptVersion)はこの
 * runExclusive コールバック内で1回だけ発行し、Set化してから収集ループへ束縛する。
 *
 * currentPromptVersion は設定(clipVariant)から resolveClipVariant で1回だけ解決してスナップショットし、
 * 収集ループ全体(bulk query・dedup判定)で使い回す。実行中に設定のクリップ版が変わっても
 * このphase1呼び出し内では変わらない(実行〈phase2〉は実行時点の版で走るため実害はないbest-effort最適化。
 * boss合意の非ブロッキング留意事項)。
 */
async function handleCollectPeriodBatch(
  fromStr: string,
  toStr: string,
  target: RaceListTarget,
): Promise<PeriodBatchCollectResult> {
  return withErrorLogging(
    IPC_CHANNELS.collectPeriodBatch,
    { from: fromStr, to: toStr, target },
    async () => {
      const from = parseKaisaiDate(fromStr);
      const to = parseKaisaiDate(toStr);
      // 新しい収集の開始時に前回の中断要求を必ずクリアする(残留で即打ち切りにならないように)。
      periodBatchCollectCancelRequested = false;
      const result = await resourceManager.runExclusive((resources) => {
        const settings = getSettingsStore().load();
        const currentPromptVersion = resolveClipVariant(
          settings.clipVariant,
        ).promptVersion;
        // bulk queryは1回だけ発行し、Set化してdedup判定を束縛する(4ケースの集合意味論を保存)。
        const analyzedSet = new Set(
          resources.listAnalyzedRaceIdsByPromptVersion(currentPromptVersion),
        );
        return collectRaceIdsOverRange(from, to, target, {
          listDayRaces: (date, t) =>
            t === "central" ? resources.listRaces(date) : resources.listNarRaces(date),
          analyzedPromptVersionsOf: (raceId) =>
            analyzedSet.has(raceId) ? [currentPromptVersion] : [],
          currentPromptVersion,
          shouldCancel: () => periodBatchCollectCancelRequested,
        });
      });
      return toPeriodBatchCollectResult(result);
    },
  );
}

/** 期間バッチ先取得(phase1)の中断要求ハンドラ。次の日境界で停止させるためフラグを立てる。 */
function handleCancelCollectPeriodBatch(): void {
  periodBatchCollectCancelRequested = true;
}

/**
 * renderer から渡された targetRaces(unknown)を、プレーンな PeriodBatchTargetRace[] へ
 * 防御的に正規化する(要修正2)。IPC引数は信頼できない外部入力のため:
 * - 配列でなければ空配列を返す。
 * - 要素が非オブジェクト・null(typeof null は"object"のため明示的に除外)なら、その要素を
 *   安全側で読み飛ばす(raceId/kaisaiDate に触れず素通しで例外を投げない)。
 * - 有効な要素は raceId/kaisaiDate を String() 化する(既存 handleRunBatchAnalysis の
 *   `(Array.isArray(raceIds)?raceIds:[]).map(String)` と同じ「信頼しない」流儀)。
 */
function normalizePeriodBatchTargetRaces(value: unknown): PeriodBatchTargetRace[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: PeriodBatchTargetRace[] = [];
  for (const v of value) {
    if (typeof v !== "object" || v === null) {
      continue;
    }
    const t = v as { raceId?: unknown; kaisaiDate?: unknown };
    result.push({ raceId: String(t.raceId), kaisaiDate: String(t.kaisaiDate) });
  }
  return result;
}

/**
 * 期間バッチ「実行」(phase2。タスクC1)ハンドラの実処理。
 *
 * phase1(collectPeriodBatch)が確定した targetRaces(raceId+そのレースの開催日)を受け取り、
 * レースごとに自分の kaisaiDate で runAnalysis を呼び分ける。単日一括分析の
 * handleRunBatchAnalysis(全レース共通の単一 date)をそのまま使うと、日跨ぎの期間バッチでは
 * 一部レースの開催日を取り違える(過去日較正が壊れる致命的バグ)ため、専用ハンドラとして分離する。
 *
 * オーケストレーション本体(runBatchAnalysis)・進捗チャネル(batchProgress)・
 * 中断フラグ(batchCancelRequested)は単日一括分析とそのまま共有する(両者は同時に走らない前提。
 * bulkImportCancelRequested のような別フラグを新設するほどの独立性は不要という boss合意)。
 *
 * 開催日の束縛は raceId をキーにした Map ではなく「位置(呼び出し順)」で行う(要修正1)。
 * raceId をキーにすると、targetRaces に同一 raceId が複数回出現した場合に後勝ちで
 * 上書きされ、先に出現したレースが誤った開催日で分析されてしまう(較正データの正しさを
 * 「raceIdの一意性」という暗黙の前提に委ねてしまう)。runBatchAnalysis の analyzeOne は
 * raceIds を渡した順に、境界(中断判定)ごとに最大1回ずつ・欠番無く呼ばれる
 * (中断時は残り全部をまとめてスキップするだけで、途中の呼び出しを飛ばすことは無い)ため、
 * 呼ばれた回数をそのまま targetRaces の添字として使えば、raceId の重複があっても
 * 各出現が自分の開催日を正しく引ける。万一 targetRaces と呼び出し順がずれた場合は
 * (raceIds 生成ロジックが変わる等の将来の実装ミスを検知するため)raceId 不一致を
 * 明示的なエラーとして投げ、黙って誤った開催日を使わない。
 */
async function handleRunPeriodBatchAnalysis(
  event: IpcMainInvokeEvent,
  targetRaces: readonly PeriodBatchTargetRace[],
): Promise<BatchRaceOutcome[]> {
  return withErrorLogging(
    IPC_CHANNELS.runPeriodBatchAnalysis,
    undefined,
    async () => {
      const raceIds = targetRaces.map((t) => t.raceId);
      // 新しいバッチの開始時に前回の中断要求を必ずクリアする(単日一括分析と共有するフラグ)。
      batchCancelRequested = false;
      let callIndex = 0;
      return resourceManager.runExclusive(({ deps }) =>
        runBatchAnalysis(raceIds, {
          // 位置(呼び出し順)でその出現の開催日に束縛する(日跨ぎ・raceId重複の取り違え防止の核心)。
          analyzeOne: (raceIdStr, onStage) => {
            const target = targetRaces[callIndex];
            callIndex += 1;
            if (target === undefined || target.raceId !== raceIdStr) {
              throw new Error(
                `期間バッチ実行: targetRacesとの対応がずれています(index=${
                  callIndex - 1
                }, raceId=${raceIdStr})`,
              );
            }
            const kaisaiDate = parseKaisaiDateOrNull(target.kaisaiDate);
            return runAnalysis(parseRaceId(raceIdStr), kaisaiDate, deps, onStage);
          },
          shouldCancel: () => batchCancelRequested,
          onProgress: (progress: BatchProgress) => {
            event.sender.send(IPC_CHANNELS.batchProgress, progress);
          },
          onError: (raceId, error) => {
            logError(PERIOD_BATCH_ANALYSIS_RACE_OPERATION, error, { raceId });
          },
        }),
      );
    },
  );
}

/**
 * raceId文字列から result.html の URL を求める(ログのコンテキスト用)。
 * raceIdStr がレースID形式として不正な場合でも、ログ記録自体を失敗させないよう null にフォールバックする。
 */
function safeRaceResultUrl(raceIdStr: string): string | null {
  try {
    return raceResultUrl(parseRaceId(raceIdStr));
  } catch {
    return null;
  }
}

/** 結果取込ハンドラの実処理(result.html取得→パース→実着順+複勝払戻を保存)。 */
async function handleImportResult(
  raceIdStr: string,
): Promise<ImportResultOutcome> {
  return withErrorLogging(
    IPC_CHANNELS.importResult,
    { raceId: raceIdStr, url: safeRaceResultUrl(raceIdStr) },
    async () => {
      const raceId = parseRaceId(raceIdStr);
      // 取得→parse→saveResult の await を含むため runExclusive で保護する(実行中の DB クローズを防ぐ)。
      return resourceManager.runExclusive((resources) =>
        resources.importResult(raceId),
      );
    },
  );
}

/**
 * 一括取込の中断フラグ(main プロセス内の単一実行を前提とした module 状態)。
 * runBulkImport 開始時に false へリセットし、cancel チャネルで true にする。
 * 一括分析(batchCancelRequested)とは別のフラグを持つ(同時に走らない前提だが、意味的に独立させる)。
 */
let bulkImportCancelRequested = false;

/** 一括取込の per-race 失敗ログの操作名(全体起動の失敗ログとは区別する)。 */
const BULK_IMPORT_RACE_OPERATION = `${IPC_CHANNELS.runBulkImport}:race`;

/**
 * 一括取込ハンドラの実処理(Task#31)。分析済みで結果未取込のレース(listUnimportedRaceIds、
 * NOT EXISTSで判定済み)を直列に取り込み、per-race のアウトカムを返す。
 * 全体を runExclusive 1回で包む(粗い粒度)ことで、取込中は DB を閉じさせない。
 * 進捗は bulk-import-progress チャネルで renderer へ一方向通知する。
 *
 * 設計判断(code-reviewer提案対応): 一括分析(handleRunBatchAnalysis)と一括取込は互いの
 * running 状態を見ておらず、同時実行を妨げない。これは意図した許容であり修正不要と判断した。
 * 理由は次の2点で、同時実行しても実害が無いため:
 * 1. 実HTTPリクエストは共有 HttpClient のレート制限(1.5秒間隔)で直列化される
 *    (resourceManager.runExclusive 自体は名前に反して排他しないが、HttpClient 側で律速される)。
 * 2. 結果保存(saveResult)は upsert であり冪等なため、仮に同一レースへ競合して書き込まれても
 *    最終状態が壊れることはない。
 */
async function handleRunBulkImport(
  event: IpcMainInvokeEvent,
): Promise<BulkImportRaceOutcome[]> {
  return withErrorLogging(IPC_CHANNELS.runBulkImport, undefined, async () => {
    // 新しい実行の開始時に前回の中断要求を必ずクリアする(残留で即スキップにならないように)。
    bulkImportCancelRequested = false;
    return resourceManager.runExclusive((resources) => {
      const raceIds = resources.listUnimportedRaceIds();
      return runBulkImport(raceIds, {
        importOne: (raceIdStr) => resources.importResult(parseRaceId(raceIdStr)),
        shouldCancel: () => bulkImportCancelRequested,
        onProgress: (progress: BulkImportProgress) => {
          event.sender.send(IPC_CHANNELS.bulkImportProgress, progress);
        },
        // per-race の失敗はここで構造化ログを残す(操作名・raceId・URL・例外スタック)。
        onError: (raceId, error) => {
          logError(BULK_IMPORT_RACE_OPERATION, error, {
            raceId,
            url: safeRaceResultUrl(raceId),
          });
        },
      });
    });
  });
}

/** 一括取込の中断要求ハンドラ。次のレース境界で停止させるためフラグを立てる。 */
function handleCancelBulkImport(): void {
  bulkImportCancelRequested = true;
}

/**
 * IPC越しに届いた venueKind 引数を検証済みの VerifyVenueFilter へ正規化する(Task#32)。
 * renderer からの入力は unknown として扱い、"central"/"nar" 以外(未指定・不正値)は
 * 既定の "all"(全体、従来どおり)にフォールバックする(listRaces の venueKind 正規化と同じ方針)。
 */
function normalizeVerifyVenueFilter(value: unknown): VerifyVenueFilter {
  return value === "central" || value === "nar" ? value : "all";
}

/** 検証レポート取得ハンドラの実処理。 */
async function handleGetVerifyReport(
  venueKind: VerifyVenueFilter,
): Promise<VerifyReportView> {
  return withErrorLogging(IPC_CHANNELS.getVerifyReport, { venueKind }, () =>
    getResources().getVerifyReport(venueKind),
  );
}

/** プロンプト版別検証レポート取得ハンドラの実処理(Task#27)。 */
async function handleGetVerifyReportByPromptVersion(): Promise<
  readonly PromptVersionVerifyReportView[]
> {
  return withErrorLogging(
    IPC_CHANNELS.getVerifyReportByPromptVersion,
    undefined,
    () => getResources().getVerifyReportByPromptVersion(),
  );
}

/**
 * 版不明(prompt_version が null)の分析をまとめて削除するハンドラの実処理(Task#33)。
 * 破壊的な DB 書き込み(analyses・analysis_horses からの DELETE)を伴うため、既存の
 * 他の書き込み操作(handleImportResult 等)と同様に runExclusive で保護する(実行中の設定保存で
 * DB を閉じられて「connection is not open」になるのを防ぐ)。
 */
async function handleDeleteUnknownPromptVersionAnalyses(): Promise<DeleteUnknownPromptVersionAnalysesResult> {
  return withErrorLogging(
    IPC_CHANNELS.deleteUnknownPromptVersionAnalyses,
    undefined,
    async () =>
      resourceManager.runExclusive((resources) =>
        Promise.resolve(resources.deleteUnknownPromptVersionAnalyses()),
      ),
  );
}

/**
 * レース単位の統合リスト取得ハンドラの実処理(検証画面UI統合)。
 * 旧 handleGetRaceBreakdown(結果取込済みのみ)と旧 handleListAnalyses(分析単位・重複あり)を
 * 1つのチャネルへ統合したもの。
 */
async function handleGetRaceLedger(): Promise<readonly RaceLedgerView[]> {
  return withErrorLogging(IPC_CHANNELS.getRaceLedger, undefined, () =>
    getResources().getRaceLedger(),
  );
}

/** 設定取得ハンドラの実処理。マスク済み(環境変数優先を反映)で返す。 */
function handleGetSettings(): MaskedSettings {
  const settings = getSettingsStore().load();
  return maskSettings(settings, process.env.ANTHROPIC_API_KEY);
}

/**
 * 設定保存ハンドラの実処理。現在設定へ更新を適用して保存し、マスク済み結果を返す。
 * 依存の再構築は markDirty で予約する(分析実行中は破棄を遅延し、実行中の DB を閉じない。
 * 次のアイドル時の分析で最新設定=重み・EV閾値・APIキーが反映される。再起動不要)。
 */
async function handleSaveSettings(update: SettingsUpdate): Promise<MaskedSettings> {
  return withErrorLogging(IPC_CHANNELS.saveSettings, undefined, () => {
    const store = getSettingsStore();
    const next = applyUpdate(store.load(), update);
    store.save(next);
    resourceManager.markDirty();
    return maskSettings(next, process.env.ANTHROPIC_API_KEY);
  });
}

/**
 * 一括サマリ Discord送信ハンドラの実処理。横断EVプラス一覧を embed 1件にまとめて1通で送る。
 * DBを触らないため runExclusive は不要だが、Webhook URL は必ず最新設定から読む(設定変更を即反映)。
 */
async function handleSendBatchDiscord(
  outcomes: readonly BatchRaceOutcome[],
): Promise<void> {
  await sendPayloadToDiscord(buildBatchDiscordPayload(outcomes));
}

/**
 * 最新設定の Webhook URL を検証してからペイロードを送信する共通処理。
 * URL未設定・検証NG・送信失敗はユーザー向けメッセージの Error にして reject する(renderer が表示)。
 */
async function sendPayloadToDiscord(payload: DiscordPayload): Promise<void> {
  const settings = getSettingsStore().load();
  const webhookUrl = settings.discordWebhookUrl.trim();
  if (webhookUrl === "") {
    throw new Error(
      "Discord Webhook URL が未設定です。設定画面で登録してください。",
    );
  }
  if (!isDiscordWebhookUrl(webhookUrl)) {
    throw new Error(
      "Discord Webhook URL が不正です(https://discord.com/api/webhooks/ で始まる必要があります)。",
    );
  }
  try {
    // Electron の net.fetch を注入し、undici(Electron 内蔵 Node 20 では非互換)を通さない。
    await sendDiscordNotification(webhookUrl, payload, {
      fetch: netFetchAdapter,
    });
  } catch (error) {
    // 送信失敗はログに残す(webhookUrl自体は既知の秘密フィールド名ではないコンテキストに積まないよう
    // 意図的に省略し、formatLogEntry の秘密値スキャン(secretsProvider経由)による二重防御に委ねる)。
    logError(IPC_CHANNELS.sendBatchDiscord, error);
    // core の例外(DiscordNotifyError)はユーザー向けメッセージを持つのでそのまま伝える。
    // それ以外(ネットワーク例外等)は簡潔なメッセージに包む。
    if (error instanceof DiscordNotifyError) {
      throw new Error(error.message);
    }
    throw new Error(
      `Discord への送信に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 設定初期化ハンドラの実処理。既定へ戻して保存し、マスク済み結果を返す。 */
async function handleResetSettings(): Promise<MaskedSettings> {
  return withErrorLogging(IPC_CHANNELS.resetSettings, undefined, () => {
    const store = getSettingsStore();
    store.save(DEFAULT_APP_SETTINGS);
    resourceManager.markDirty();
    return maskSettings(DEFAULT_APP_SETTINGS, process.env.ANTHROPIC_API_KEY);
  });
}

/**
 * renderer由来のログ入力(message/stack)の長さ上限(提案採用1)。
 * renderer側の例外は原理上どれだけ長いメッセージ・スタックを積んでくるか制御できないため、
 * ログファイルの肥大化・可読性低下を防ぐために切り詰める。
 */
const MAX_RENDERER_LOG_FIELD_LENGTH = 10_000;

/** 長さ上限超過時に末尾へ付記する省略の目印。 */
const RENDERER_LOG_TRUNCATION_SUFFIX = "…(省略)";

/**
 * renderer から届いた値を安全な文字列へ変換する(非文字列型の防御)。
 * undefined はそのまま undefined を返す(値自体が省略されたことを区別するため)。
 */
function toSafeString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : String(value);
}

/** 上限を超えた文字列を切り詰め、省略した旨を付記する(提案採用1)。 */
function truncateForRendererLog(value: string): string {
  if (value.length <= MAX_RENDERER_LOG_FIELD_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_RENDERER_LOG_FIELD_LENGTH) + RENDERER_LOG_TRUNCATION_SUFFIX;
}

/**
 * renderer から届いたエラー情報(unknown、IPC越し)を安全に検証してログへ委譲する(受け入れ条件6)。
 * 形状が不正でも例外を投げず、可能な範囲の情報だけでログを残す(ログ集約自体を落とさない)。
 * message/stack は非文字列型なら String() 変換し(提案採用1)、長さ上限で切り詰めてから委譲する。
 */
function handleLogRendererError(payload: unknown): void {
  const rec =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const operation =
    typeof rec.operation === "string" && rec.operation !== ""
      ? rec.operation
      : "renderer:unknown";
  // message は「値の省略」を区別する必要が無い(空でも "undefined" 等の文字列表現でよい)ため、
  // toSafeString の undefined フォールバックを経由せず String() で直接変換する(冗長な二重変換を排除)。
  const message = truncateForRendererLog(String(rec.message));
  const stackRaw = toSafeString(rec.stack);
  const stack = stackRaw !== undefined ? truncateForRendererLog(stackRaw) : undefined;
  const raceId = typeof rec.raceId === "string" ? rec.raceId : null;
  const url = typeof rec.url === "string" ? rec.url : null;
  logError(operation, { message, stack }, { raceId, url });
}

/**
 * 「ログフォルダを開く」ハンドラの実処理(Task#36 受け入れ条件1)。
 * ディレクトリが未作成(初回起動直後等)でも安全に開けるよう、開く前に必ず作成する
 * (settings-store.ts と同じ mkdirSync({ recursive: true }) の流儀)。
 * shell.openPath は失敗時に例外を投げず、空でないエラーメッセージ文字列を返す仕様のため、
 * それを検知して Error に変換し、他のIPCハンドラと同様にrendererへ失敗を伝える。
 */
async function handleOpenLogFolder(): Promise<void> {
  return withErrorLogging(IPC_CHANNELS.openLogFolder, undefined, async () => {
    const dir = getLogDirectory();
    mkdirSync(dir, { recursive: true });
    const result = await shell.openPath(dir);
    if (result !== "") {
      throw new Error(`ログフォルダを開けませんでした: ${result}`);
    }
  });
}

/**
 * 「最新ログをエクスポート」ハンドラの実処理(Task#36 受け入れ条件2)。
 * 保存先は dialog.showSaveDialog でユーザーに選ばせる(既定ファイル名は当日日付付き)。
 * キャンセル時(canceled または filePath 未指定)は何もせず "canceled" を返す。
 * 集約(log-export.ts の純関数)は現行ログ+ローテーション済みログを old→current の順で結合する。
 *
 * dialog.showSaveDialog に渡す親ウィンドウは、呼び出し元の webContents から解決する
 * (main.ts はウィンドウ参照をグローバルに保持していないため。取れなければウィンドウ無しで呼ぶ)。
 */
async function handleExportLogs(
  event: IpcMainInvokeEvent,
): Promise<LogExportOutcome> {
  return withErrorLogging(IPC_CHANNELS.exportLogs, undefined, async () => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      defaultPath: buildDefaultLogExportFileName(new Date()),
      filters: [{ name: "テキスト", extensions: ["txt"] }],
    };
    const result =
      window !== null
        ? await dialog.showSaveDialog(window, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || result.filePath === undefined || result.filePath === "") {
      return { status: "canceled" };
    }
    const content = collectLogExportContent(getLogDirectory());
    writeFileSync(result.filePath, content, "utf8");
    return { status: "saved", filePath: result.filePath };
  });
}
