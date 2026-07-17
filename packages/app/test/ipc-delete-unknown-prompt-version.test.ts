/**
 * ipc.ts の版不明分析削除ハンドラの結線テスト(Task#33。既存 ipc-list-races.test.ts の流儀:
 * electron・pipeline-deps をモックし、ipcMain.handle が捕捉したハンドラ関数を直接呼ぶ)。
 *
 * 目的:
 * - チャネルが登録され、resources.deleteUnknownPromptVersionAnalyses に委譲して結果を返すこと。
 * - 削除は runExclusive で保護される(既存の DB 書き込み操作と同様)ため、
 *   資源(PipelineResources)の取得経由(createPipelineDeps)で呼ばれること。
 * - 失敗時は withErrorLogging により logError を経由してから例外がそのまま再送出されること。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";

const { handleMock, createPipelineDepsMock, logErrorMock, ctx } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createPipelineDepsMock: vi.fn(),
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
  logWarn: vi.fn(),
  setSecretsProvider: vi.fn(),
}));

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`ハンドラ未登録: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

const fakeEvent = { sender: { send: vi.fn() } };
let tempDir: string;
let deleteUnknownPromptVersionAnalysesMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  createPipelineDepsMock.mockReset();
  logErrorMock.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-delete-unknown-prompt-version-"));
  ctx.userData = tempDir;

  deleteUnknownPromptVersionAnalysesMock = vi.fn(() => ({ deletedCount: 0 }));
  createPipelineDepsMock.mockImplementation(() => ({
    listRaces: vi.fn(async () => []),
    listNarRaces: vi.fn(async () => []),
    importResult: vi.fn(async () => ({})),
    listUnimportedRaceIds: vi.fn(() => []),
    getVerifyReport: vi.fn(() => ({})),
    getVerifyReportByPromptVersion: vi.fn(() => []),
    getRaceBreakdown: vi.fn(() => []),
    listAnalysisHistory: vi.fn(() => []),
    deleteUnknownPromptVersionAnalyses: deleteUnknownPromptVersionAnalysesMock,
    close: vi.fn(),
    deps: {},
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("verify:delete-unknown-prompt-version-analyses ハンドラ(Task#33)", () => {
  it("チャネルをハンドラ付きで登録すること", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.deleteUnknownPromptVersionAnalyses,
      expect.any(Function),
    );
  });

  it("resources.deleteUnknownPromptVersionAnalyses に委譲し、その戻り値をそのまま返すこと", async () => {
    deleteUnknownPromptVersionAnalysesMock.mockReturnValue({ deletedCount: 3 });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const result = await handlerFor(IPC_CHANNELS.deleteUnknownPromptVersionAnalyses)(
      fakeEvent,
    );

    expect(deleteUnknownPromptVersionAnalysesMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deletedCount: 3 });
  });

  it("版不明の分析が無い場合、削除0件を返すこと", async () => {
    deleteUnknownPromptVersionAnalysesMock.mockReturnValue({ deletedCount: 0 });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const result = await handlerFor(IPC_CHANNELS.deleteUnknownPromptVersionAnalyses)(
      fakeEvent,
    );

    expect(result).toEqual({ deletedCount: 0 });
  });

  it("失敗時は操作名付きでログしてから例外をそのまま再送出すること(Task#35の流儀)", async () => {
    const error = new Error("削除に失敗");
    deleteUnknownPromptVersionAnalysesMock.mockImplementation(() => {
      throw error;
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await expect(
      handlerFor(IPC_CHANNELS.deleteUnknownPromptVersionAnalyses)(fakeEvent),
    ).rejects.toThrow("削除に失敗");

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [operation, loggedError] = logErrorMock.mock.calls[0]!;
    expect(operation).toBe(IPC_CHANNELS.deleteUnknownPromptVersionAnalyses);
    expect(loggedError).toBe(error);
  });
});
