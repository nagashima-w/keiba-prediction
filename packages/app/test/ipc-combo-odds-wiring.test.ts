import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import { DEFAULT_APP_SETTINGS } from "../src/main/settings-store.js";
import type { SettingsUpdate } from "../src/shared/settings.js";

/**
 * ipc.ts が設定画面の組合せオッズ取得チェックボックス(shared/settings.ts の
 * AppSettings.includeComboOdds)を createPipelineDeps へ実際に渡していることを固定するテスト
 * (機能D-2c第3段・Issue #28・対応表C1)。ipc-clip-variant-wiring.test.ts と同じ流儀:
 * createPipelineDeps 自体はモックし、渡された config.includeComboOdds だけを観測する
 * (実IO・実LLM呼び出しは行わない)。
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

/** 有効な設定更新ペイロード(includeComboOdds以外は固定値)を組み立てる。 */
function makeUpdate(
  overrides: Partial<SettingsUpdate> = {},
): SettingsUpdate {
  return {
    discordWebhookUrl: "",
    evThreshold: 1,
    biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
    baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
    autoSendDiscord: false,
    additionalInstruction: "",
    clipVariant: "default",
    bankroll: 10000,
    perRaceCap: 5000,
    kellyFraction: 0.5,
    includeComboOdds: false,
    ...overrides,
  };
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
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-combo-odds-wiring-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ipc: 設定の組合せオッズ取得(includeComboOdds)をcreatePipelineDepsへ配線する(機能D-2c第3段・Issue #28・対応表C1)", () => {
  it("設定未保存(既定)なら createPipelineDeps へ includeComboOdds=false が渡ること(受け入れ条件2)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    handlerFor(IPC_CHANNELS.getVerifyReport)(fakeEvent);

    expect(createPipelineDepsMock).toHaveBeenCalled();
    const config = createPipelineDepsMock.mock.calls[0]![0] as {
      includeComboOdds?: unknown;
    };
    expect(config.includeComboOdds).toBe(false);
  });

  it("設定で includeComboOdds=true を保存すると、次の資源生成で createPipelineDeps へ渡ること(受け入れ条件4)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const saveHandler = handlerFor(IPC_CHANNELS.saveSettings);
    const verifyHandler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await saveHandler(fakeEvent, makeUpdate({ includeComboOdds: true }));

    // 設定保存直後はアイドル時の資源生成(getResources)を経て、新しい設定で再構築される
    // (対応表C2: 設定変更は「次の分析から」効く。ここでは次のIPC呼び出しで観測する)。
    verifyHandler(fakeEvent);

    const lastCall =
      createPipelineDepsMock.mock.calls[createPipelineDepsMock.mock.calls.length - 1]!;
    const config = lastCall[0] as { includeComboOdds?: unknown };
    expect(config.includeComboOdds).toBe(true);
  });

  it("includeComboOddsとautoSendDiscordが非対称でも取り違えないこと(隣接boolean項目の入れ替え変異検知)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const saveHandler = handlerFor(IPC_CHANNELS.saveSettings);
    const verifyHandler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await saveHandler(
      fakeEvent,
      makeUpdate({ autoSendDiscord: true, includeComboOdds: false }),
    );
    verifyHandler(fakeEvent);

    const lastCall =
      createPipelineDepsMock.mock.calls[createPipelineDepsMock.mock.calls.length - 1]!;
    const config = lastCall[0] as { includeComboOdds?: unknown };
    // autoSendDiscord=trueにつられてincludeComboOddsまでtrueにならないこと。
    expect(config.includeComboOdds).toBe(false);
  });
});
