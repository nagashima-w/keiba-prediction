import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";

/**
 * ipc.ts が HttpClient(core, electron非依存)のサポート外charset警告を
 * ログ基盤(main/logger.ts の logWarn)へ接続していることを固定するテスト(要修正4)。
 *
 * core の HttpClient は electron に依存できないため console.warn を既定としつつ
 * onWarn コールバックを注入可能にした(http-client.test.ts で確認済み)。
 * ここでは、その onWarn を実際に main/logger.ts の logWarn へ配線している(ipc.ts の
 * resourceManager.create() → createPipelineDeps へ渡す config.onWarn)ことを検証する。
 * 実IO(better-sqlite3・HTTP)は避け、pipeline-deps.js と logger.js をモックして
 * createPipelineDeps へ渡された config.onWarn を直接呼び出し、logWarn への委譲を確認する。
 */

const { handleMock, createPipelineDepsMock, logWarnMock, logErrorMock, ctx } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    createPipelineDepsMock: vi.fn(),
    logWarnMock: vi.fn(),
    logErrorMock: vi.fn(),
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

vi.mock("../src/main/logger.js", () => ({
  logError: logErrorMock,
  logWarn: logWarnMock,
  setSecretsProvider: vi.fn(),
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
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-http-warn-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ipc: HttpClientのサポート外charset警告をログ基盤へ接続する(要修正4)", () => {
  it("createPipelineDeps へ onWarn を関数として注入する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    // 資源生成を誘発する(getVerifyReport は getResources() 経由で create を呼ぶ)。
    handlerFor(IPC_CHANNELS.getVerifyReport)(fakeEvent);

    expect(createPipelineDepsMock).toHaveBeenCalled();
    const config = createPipelineDepsMock.mock.calls[0]![0] as {
      onWarn?: unknown;
    };
    expect(typeof config.onWarn).toBe("function");
  });

  it("注入されたonWarnを呼ぶとlogWarnへ警告メッセージが委譲される", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    handlerFor(IPC_CHANNELS.getVerifyReport)(fakeEvent);

    const config = createPipelineDepsMock.mock.calls[0]![0] as {
      onWarn?: (message: string) => void;
    };
    config.onWarn!(
      "サポート外のcharset(shift_jis)を検出したため、utf-8にフォールバックします: https://example.test",
    );

    expect(logWarnMock).toHaveBeenCalledTimes(1);
    const [operation, message] = logWarnMock.mock.calls[0]!;
    expect(typeof operation).toBe("string");
    expect(operation).not.toBe("");
    expect(message).toContain("shift_jis");
  });
});
