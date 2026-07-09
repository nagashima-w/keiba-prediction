import path from "node:path";

import { app, ipcMain, type IpcMainInvokeEvent } from "electron";

import { parseKaisaiDate, parseRaceId, type KaisaiDate } from "@keiba/core";

import type {
  AnalysisHistoryItem,
  AnalysisProgress,
  AnalysisResult,
  ImportResultOutcome,
  RaceListItem,
  VerifyReportView,
} from "../shared/analysis-types.js";
import { IPC_CHANNELS } from "../shared/channels.js";
import { buildAppInfo } from "./app-info.js";
import { runAnalysis } from "./analysis-pipeline.js";
import { createPipelineDeps, type PipelineResources } from "./pipeline-deps.js";
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
}

/**
 * 配線済み依存を解放する(DB接続のクローズ)。
 * main の will-quit で呼び、次回起動まで持ち越さない。close は冪等。
 */
export function closeResources(): void {
  resources?.close();
  resources = null;
}

/**
 * 分析の依存(SQLiteキャッシュ・分析ストア・LLM)を1度だけ配線して使い回す。
 * DBのオープンはコストがあるため、最初に必要になった時点で遅延生成する
 * (registerIpcHandlers 時点では DB を開かない → app 情報のみのテストに副作用が無い)。
 */
let resources: PipelineResources | null = null;

/** 配線済み依存を取得する(未生成なら生成)。 */
function getResources(): PipelineResources {
  if (resources === null) {
    resources = createPipelineDeps({
      dbPath: path.join(app.getPath("userData"), "keiba.db"),
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return resources;
}

/** レース一覧取得ハンドラの実処理。 */
async function handleListRaces(dateStr: string): Promise<RaceListItem[]> {
  const kaisaiDate = parseKaisaiDate(dateStr);
  const entries = await getResources().listRaces(kaisaiDate);
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
  const { deps } = getResources();
  return runAnalysis(raceId, kaisaiDate, deps, (progress: AnalysisProgress) => {
    event.sender.send(IPC_CHANNELS.analysisProgress, progress);
  });
}

/** 結果取込ハンドラの実処理(result.html取得→パース→実着順+複勝払戻を保存)。 */
async function handleImportResult(
  raceIdStr: string,
): Promise<ImportResultOutcome> {
  const raceId = parseRaceId(raceIdStr);
  return getResources().importResult(raceId);
}

/** 検証レポート取得ハンドラの実処理。 */
function handleGetVerifyReport(): VerifyReportView {
  return getResources().getVerifyReport();
}

/** 分析履歴一覧取得ハンドラの実処理。 */
function handleListAnalyses(): AnalysisHistoryItem[] {
  return getResources().listAnalysisHistory();
}
