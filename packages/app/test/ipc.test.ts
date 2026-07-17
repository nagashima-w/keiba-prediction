import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

// electron はテスト環境で読み込めないためモックする。
// ipcMain.handle と app.getVersion のみを差し替え、結線ロジックだけを検証する。
const { handleMock, getVersionMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getVersionMock: vi.fn(() => "9.9.9"),
}));

vi.mock("electron", () => ({
  app: { getVersion: getVersionMock },
  ipcMain: { handle: handleMock },
}));

import { registerIpcHandlers } from "../src/main/ipc.js";
import { IPC_CHANNELS } from "../src/shared/channels.js";

describe("registerIpcHandlers(IPCハンドラの結線)", () => {
  beforeEach(() => {
    handleMock.mockClear();
    getVersionMock.mockClear();
  });

  it("app:get-info チャネルをハンドラ関数付きで登録する", () => {
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.getAppInfo,
      expect.any(Function),
    );
  });

  it("登録されたハンドラは buildAppInfo に委譲する(app.getVersion 由来のバージョン + core要約を返す)", async () => {
    registerIpcHandlers();
    const call = handleMock.mock.calls.find((c) => c[0] === IPC_CHANNELS.getAppInfo);
    expect(call).toBeDefined();
    const handler = call![1] as () => unknown;

    const result = (await handler()) as {
      appName: string;
      appVersion: string;
      core: { minSampleForBias: number };
    };

    expect(result.appVersion).toBe("9.9.9");
    expect(result.appName).toBe("競馬期待値分析ツール");
    expect(result.core.minSampleForBias).toBe(DEFAULT_SCORER_CONFIG.minSampleForBias);
  });

  it("検証画面用のチャネル(結果取込・検証レポート・分析履歴)をハンドラ付きで登録する", () => {
    registerIpcHandlers();
    for (const channel of [
      IPC_CHANNELS.importResult,
      IPC_CHANNELS.getVerifyReport,
      IPC_CHANNELS.listAnalyses,
    ]) {
      expect(handleMock).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  it("プロンプト版別検証レポートのチャネルをハンドラ付きで登録する(Task#27)", () => {
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.getVerifyReportByPromptVersion,
      expect.any(Function),
    );
  });

  it("レース単位の予実ブレークダウン取得チャネルをハンドラ付きで登録する(Task#34)", () => {
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.getRaceBreakdown,
      expect.any(Function),
    );
  });

  it("設定画面用のチャネル(取得・保存・初期化)をハンドラ付きで登録する", () => {
    registerIpcHandlers();
    for (const channel of [
      IPC_CHANNELS.getSettings,
      IPC_CHANNELS.saveSettings,
      IPC_CHANNELS.resetSettings,
    ]) {
      expect(handleMock).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  it("一括分析チャネル(実行・中断・サマリ送信)をハンドラ付きで登録する", () => {
    registerIpcHandlers();
    for (const channel of [
      IPC_CHANNELS.runBatchAnalysis,
      IPC_CHANNELS.cancelBatchAnalysis,
      IPC_CHANNELS.sendBatchDiscord,
    ]) {
      expect(handleMock).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });
});
