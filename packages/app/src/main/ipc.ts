import path from "node:path";

import { app, ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  DiscordNotifyError,
  isDiscordWebhookUrl,
  parseKaisaiDate,
  parseRaceId,
  sendDiscordNotification,
  type KaisaiDate,
} from "@keiba/core";

import type {
  AnalysisHistoryItem,
  AnalysisProgress,
  AnalysisResult,
  ImportResultOutcome,
  RaceListItem,
  VerifyReportView,
} from "../shared/analysis-types.js";
import { buildDiscordPayload } from "./discord-payload.js";
import { IPC_CHANNELS } from "../shared/channels.js";
import type { MaskedSettings, SettingsUpdate } from "../shared/settings.js";
import { buildAppInfo } from "./app-info.js";
import { runAnalysis } from "./analysis-pipeline.js";
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

/**
 * main プロセスの IPC ハンドラをまとめて登録する。
 *
 * アプリ情報(app-info)は Electron 非依存の純関数に委ねる。
 * レース一覧・分析実行は実IO(SQLite・HTTP・LLM)を伴うため、依存は pipeline-deps に配線し、
 * 進捗は event.sender.send で renderer へ一方向通知する。実IOの配線はテスト対象外(結線層)。
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, () => buildAppInfo(app.getVersion()));

  ipcMain.handle(IPC_CHANNELS.listRaces, (_event, date: unknown) =>
    handleListRaces(String(date)),
  );

  ipcMain.handle(
    IPC_CHANNELS.runAnalysis,
    (event, raceId: unknown, date: unknown) =>
      handleRunAnalysis(event, String(raceId), String(date)),
  );

  ipcMain.handle(IPC_CHANNELS.importResult, (_event, raceId: unknown) =>
    handleImportResult(String(raceId)),
  );

  ipcMain.handle(IPC_CHANNELS.getVerifyReport, () => handleGetVerifyReport());

  ipcMain.handle(IPC_CHANNELS.listAnalyses, () => handleListAnalyses());

  ipcMain.handle(IPC_CHANNELS.getSettings, () => handleGetSettings());

  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, update: unknown) =>
    handleSaveSettings(update as SettingsUpdate),
  );

  ipcMain.handle(IPC_CHANNELS.resetSettings, () => handleResetSettings());

  ipcMain.handle(IPC_CHANNELS.sendDiscord, (_event, result: unknown) =>
    handleSendDiscord(result as AnalysisResult),
  );
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

/** レース一覧取得ハンドラの実処理。 */
async function handleListRaces(dateStr: string): Promise<RaceListItem[]> {
  const kaisaiDate = parseKaisaiDate(dateStr);
  // キャッシュミス時に取得→scrape_cache へ書き込む await があるため runExclusive で保護する
  // (実行中の設定保存で DB を閉じられて「connection is not open」になるのを防ぐ)。
  const entries = await resourceManager.runExclusive((resources) =>
    resources.listRaces(kaisaiDate),
  );
  return entries.map(toRaceListItem);
}

/** 開催日文字列を検証する。妥当な YYYYMMDD でなければ null(パイプライン側で当日近似)。 */
function parseKaisaiDateOrNull(dateStr: string): KaisaiDate | null {
  try {
    return parseKaisaiDate(dateStr);
  } catch {
    return null;
  }
}

/** 分析実行ハンドラの実処理(進捗は event.sender へ送る)。 */
async function handleRunAnalysis(
  event: IpcMainInvokeEvent,
  raceIdStr: string,
  dateStr: string,
): Promise<AnalysisResult> {
  const raceId = parseRaceId(raceIdStr);
  const kaisaiDate = parseKaisaiDateOrNull(dateStr);
  // runExclusive で実行中フラグを立て、この分析の最中に設定保存が来ても DB を閉じさせない
  // (実行中の破棄を防ぎ「connection is not open」を回避する)。
  return resourceManager.runExclusive(({ deps }) =>
    runAnalysis(raceId, kaisaiDate, deps, (progress: AnalysisProgress) => {
      event.sender.send(IPC_CHANNELS.analysisProgress, progress);
    }),
  );
}

/** 結果取込ハンドラの実処理(result.html取得→パース→実着順+複勝払戻を保存)。 */
async function handleImportResult(
  raceIdStr: string,
): Promise<ImportResultOutcome> {
  const raceId = parseRaceId(raceIdStr);
  // 取得→parse→saveResult の await を含むため runExclusive で保護する(実行中の DB クローズを防ぐ)。
  return resourceManager.runExclusive((resources) =>
    resources.importResult(raceId),
  );
}

/** 検証レポート取得ハンドラの実処理。 */
function handleGetVerifyReport(): VerifyReportView {
  return getResources().getVerifyReport();
}

/** 分析履歴一覧取得ハンドラの実処理。 */
function handleListAnalyses(): AnalysisHistoryItem[] {
  return getResources().listAnalysisHistory();
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
function handleSaveSettings(update: SettingsUpdate): MaskedSettings {
  const store = getSettingsStore();
  const next = applyUpdate(store.load(), update);
  store.save(next);
  resourceManager.markDirty();
  return maskSettings(next, process.env.ANTHROPIC_API_KEY);
}

/**
 * Discord送信ハンドラの実処理。
 * DBを触らないため runExclusive は不要だが、Webhook URL は必ず最新設定から読む(設定変更を即反映)。
 * URL未設定・検証NG・送信失敗はユーザー向けメッセージの Error にして reject する(renderer が表示)。
 */
async function handleSendDiscord(result: AnalysisResult): Promise<void> {
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
    await sendDiscordNotification(webhookUrl, buildDiscordPayload(result));
  } catch (error) {
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
function handleResetSettings(): MaskedSettings {
  const store = getSettingsStore();
  store.save(DEFAULT_APP_SETTINGS);
  resourceManager.markDirty();
  return maskSettings(DEFAULT_APP_SETTINGS, process.env.ANTHROPIC_API_KEY);
}
