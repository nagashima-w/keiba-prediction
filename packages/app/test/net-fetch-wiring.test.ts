import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type {
  AnalysisResult,
  BatchRaceOutcome,
} from "../src/shared/analysis-types.js";
import type { SettingsUpdate } from "../src/shared/settings.js";
import { DEFAULT_APP_SETTINGS } from "../src/main/settings-store.js";

/**
 * ipc.ts が「Electron の net.fetch アダプタ」を実HTTP経路へ注入していることを固定するテスト。
 *
 * 目的(Windows実機バグの本命修正の結線検証):
 * - レース一覧等の取得を担う createPipelineDeps へ fetch(= net.fetch アダプタ)が渡ること。
 * - Discord 送信(sendDiscordNotification)へ fetch(= net.fetch アダプタ)が渡ること。
 * いずれも undici(Electron 内蔵 Node 20 では実行時に失敗しうる)を通さないための注入。
 */

const { handleMock, createPipelineDepsMock, sendDiscordMock, netFetchMock, ctx } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    createPipelineDepsMock: vi.fn(),
    sendDiscordMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    netFetchMock: vi.fn(),
    ctx: { userData: "" },
  }));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0",
    getPath: () => ctx.userData,
  },
  ipcMain: { handle: handleMock },
  net: { fetch: netFetchMock },
}));

// 実IO(better-sqlite3・HTTP)を避ける。createPipelineDeps の引数だけを観測する。
vi.mock("../src/main/pipeline-deps.js", () => ({
  createPipelineDeps: createPipelineDepsMock,
}));

// @keiba/core は他の関数(検証・パース)を実物のまま使いつつ、送信のみスパイに差し替える。
vi.mock("@keiba/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core")>();
  return { ...actual, sendDiscordNotification: sendDiscordMock };
});

const fakeEvent = { sender: { send: vi.fn() } };

/** 登録済みハンドラを取得する。 */
function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`ハンドラ未登録: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  createPipelineDepsMock.mockReset();
  createPipelineDepsMock.mockImplementation(() => ({
    deps: {},
    listRaces: vi.fn(async () => []),
    importResult: vi.fn(async () => ({ kind: "取込成功" })),
    getVerifyReport: vi.fn(() => ({})),
    listAnalysisHistory: vi.fn(() => []),
    close: vi.fn(),
  }));
  sendDiscordMock.mockClear();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-netfetch-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ipc: net.fetch アダプタの注入", () => {
  it("createPipelineDeps へ fetch(net.fetch アダプタ)を注入する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    // 資源生成を誘発する(getVerifyReport は getResources() 経由で create を呼ぶ)。
    handlerFor(IPC_CHANNELS.getVerifyReport)(fakeEvent);

    expect(createPipelineDepsMock).toHaveBeenCalled();
    const config = createPipelineDepsMock.mock.calls[0]![0] as {
      fetch?: unknown;
    };
    expect(typeof config.fetch).toBe("function");
  });

  it("一括サマリのDiscord 送信(sendDiscordNotification)へ fetch(net.fetch アダプタ)を注入する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    // Webhook URL を設定に保存(送信検証を通す)。
    const update: SettingsUpdate = {
      discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "default",
    };
    handlerFor(IPC_CHANNELS.saveSettings)(fakeEvent, update);

    const result: AnalysisResult = {
      raceId: "202601010101",
      venueName: "中山",
      raceName: "テストレース",
      courseType: "芝",
      distance: 1600,
      date: "2026/01/01",
      dateApproximate: false,
      llmUsed: false,
      llmSkippedReason: null,
      fallback: false,
      fallbackReason: null,
      oddsStatus: "result",
      rows: [],
      warnings: [],
      analyzedAt: "2026-01-01T00:00:00.000Z",
    };
    const outcomes: BatchRaceOutcome[] = [
      {
        raceId: "202601010101",
        raceName: "テストレース",
        status: "success",
        result,
        error: null,
      },
    ];

    await handlerFor(IPC_CHANNELS.sendBatchDiscord)(fakeEvent, outcomes);

    expect(sendDiscordMock).toHaveBeenCalledTimes(1);
    const deps = sendDiscordMock.mock.calls[0]![2] as { fetch?: unknown };
    expect(typeof deps.fetch).toBe("function");
  });
});
