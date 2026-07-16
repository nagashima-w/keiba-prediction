/**
 * ipc.ts の一括サマリDiscord送信ハンドラ(notify:discord-batch)の失敗パステスト。
 *
 * code-reviewer 再レビュー指摘(要修正): sendPayloadToDiscord の catch 節に追加された
 * logError(IPC_CHANNELS.sendBatchDiscord, error) 呼び出しに対応するテストが存在しなかった
 * (既存 net-fetch-wiring.test.ts の sendBatchDiscord テストは成功パスのみ)。
 * Webhook URL 検証は通した上で、送信本体(sendDiscordNotification)が例外を投げるケースを固定し、
 * logError が正しい操作名(IPC_CHANNELS.sendBatchDiscord)・例外で呼ばれることを検証する
 * (既存 ipc-batch.test.ts / ipc-bulk-import.test.ts の logger モックの流儀に合わせる)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { BatchRaceOutcome } from "../src/shared/analysis-types.js";
import type { SettingsUpdate } from "../src/shared/settings.js";
import { DEFAULT_APP_SETTINGS } from "../src/main/settings-store.js";

const { handleMock, createPipelineDepsMock, sendDiscordMock, logErrorMock, ctx } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    createPipelineDepsMock: vi.fn(),
    sendDiscordMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
    logErrorMock: vi.fn(),
    ctx: { userData: "" },
  }));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0",
    getPath: () => ctx.userData,
  },
  ipcMain: { handle: handleMock },
  net: { fetch: vi.fn() },
}));

vi.mock("../src/main/pipeline-deps.js", () => ({
  createPipelineDeps: createPipelineDepsMock,
}));

// Task#35: ログ基盤の実electron-logへは触れず、失敗時にlogErrorが呼ばれることだけを検証する。
vi.mock("../src/main/logger.js", () => ({
  logError: logErrorMock,
  logWarn: vi.fn(),
  setSecretsProvider: vi.fn(),
}));

// @keiba/core は他の関数(検証・DiscordNotifyError等)を実物のまま使いつつ、送信のみスパイに差し替える。
vi.mock("@keiba/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core")>();
  return { ...actual, sendDiscordNotification: sendDiscordMock };
});

const fakeEvent = { sender: { send: vi.fn() } };

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`ハンドラ未登録: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

let tempDir: string;

/** Webhook URL を検証を通る値で保存する(送信本体のみ失敗させたいので検証は通す)。 */
async function saveValidWebhookUrl(): Promise<void> {
  const update: SettingsUpdate = {
    discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
    evThreshold: 1,
    biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
    baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
    autoSendDiscord: false,
    additionalInstruction: "",
  };
  await handlerFor(IPC_CHANNELS.saveSettings)(fakeEvent, update);
}

const outcomes: BatchRaceOutcome[] = [
  {
    raceId: "202601010101",
    raceName: "テストレース",
    status: "success",
    result: {
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
      oddsStatus: "result",
      rows: [],
      warnings: [],
      analyzedAt: "2026-01-01T00:00:00.000Z",
    },
    error: null,
  },
];

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
  sendDiscordMock.mockReset();
  logErrorMock.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-send-batch-discord-error-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("notify:discord-batch ハンドラ(送信失敗パス)", () => {
  it("Webhook URL検証はOKで送信本体が例外を投げた場合、logErrorへ操作名と元の例外を渡す", async () => {
    const original = new Error("ネットワークエラー");
    sendDiscordMock.mockRejectedValueOnce(original);

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    await saveValidWebhookUrl();

    await expect(
      handlerFor(IPC_CHANNELS.sendBatchDiscord)(fakeEvent, outcomes),
    ).rejects.toThrow();

    expect(sendDiscordMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [operation, error] = logErrorMock.mock.calls[0]!;
    expect(operation).toBe(IPC_CHANNELS.sendBatchDiscord);
    expect(error).toBe(original);
  });

  it("core側のDiscordNotifyError(送信失敗)もlogErrorへ元の例外のまま渡し、メッセージはそのままrejectする", async () => {
    const { DiscordNotifyError } = await import("@keiba/core");
    const notifyError = new DiscordNotifyError("Discordへの送信が拒否されました", {
      status: 400,
    });
    sendDiscordMock.mockRejectedValueOnce(notifyError);

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    await saveValidWebhookUrl();

    await expect(
      handlerFor(IPC_CHANNELS.sendBatchDiscord)(fakeEvent, outcomes),
    ).rejects.toThrow("Discordへの送信が拒否されました");

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [operation, error] = logErrorMock.mock.calls[0]!;
    expect(operation).toBe(IPC_CHANNELS.sendBatchDiscord);
    expect(error).toBe(notifyError);
  });
});
