import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import { DEFAULT_APP_SETTINGS } from "../src/main/settings-store.js";
import type { SettingsUpdate } from "../src/shared/settings.js";

/**
 * ipc.ts が設定画面のクリップ幅版セレクタ(shared/settings.ts の AppSettings.clipVariant)を
 * createPipelineDeps へ実際に渡していることを固定するテスト(タスクD-2: 新規配線・D-5の欠落箇所)。
 * createPipelineDeps 自体はモックし、渡された config.clipVariant だけを観測する
 * (実IO・実LLM呼び出しは行わない。net-fetch-wiring.test.ts / ipc-resource-lifecycle.test.ts と同じ流儀)。
 */

const { handleMock, createPipelineDepsMock, ctx } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createPipelineDepsMock: vi.fn(),
  ctx: { userData: "" },
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0",
    getPath: () => ctx.userData,
  },
  ipcMain: { handle: handleMock },
}));

vi.mock("../src/main/pipeline-deps.js", () => ({
  createPipelineDeps: createPipelineDepsMock,
}));

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
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-clipvariant-wiring-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ipc: 設定のクリップ幅版(clipVariant)をcreatePipelineDepsへ配線する(タスクD-2)", () => {
  it("設定未保存(既定)なら createPipelineDeps へ clipVariant='default' が渡ること", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    handlerFor(IPC_CHANNELS.getVerifyReport)(fakeEvent);

    expect(createPipelineDepsMock).toHaveBeenCalled();
    const config = createPipelineDepsMock.mock.calls[0]![0] as {
      clipVariant?: unknown;
    };
    expect(config.clipVariant).toBe("default");
  });

  it("設定で clipVariant='wide15' を保存すると、次の資源生成で createPipelineDeps へ渡ること", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const saveHandler = handlerFor(IPC_CHANNELS.saveSettings);
    const verifyHandler = handlerFor(IPC_CHANNELS.getVerifyReport);

    const update: SettingsUpdate = {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "wide15",
    };
    await saveHandler(fakeEvent, update);

    // 設定保存直後はアイドル時の資源生成(getResources)を経て、新しい設定で再構築される。
    verifyHandler(fakeEvent);

    const lastCall =
      createPipelineDepsMock.mock.calls[createPipelineDepsMock.mock.calls.length - 1]!;
    const config = lastCall[0] as { clipVariant?: unknown };
    expect(config.clipVariant).toBe("wide15");
  });
});
