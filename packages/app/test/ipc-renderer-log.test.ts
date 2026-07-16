/**
 * ipc.ts の renderer エラー集約ハンドラ(log:renderer-error)のテスト。Task#35。
 *
 * renderer側のエラー(既存の errorMessage 表示経路等)が、main側のログファイルへ
 * 構造化ログとして集約されることを固定する(受け入れ条件6)。
 * main/logger.js をこのファイル内でモックし、実electron-logへは触れない(既存 ipc 系テストの流儀通り)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";

const { handleMock, logErrorMock, ctx } = vi.hoisted(() => ({
  handleMock: vi.fn(),
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

vi.mock("../src/main/logger.js", () => ({
  logError: logErrorMock,
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

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  logErrorMock.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-renderer-log-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("log:renderer-error ハンドラ", () => {
  it("log:renderer-error チャネルをハンドラ関数付きで登録する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.logRendererError,
      expect.any(Function),
    );
  });

  it("renderer から届いた operation/message/stack/raceId/url を logError へ委譲する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.logRendererError);

    await handler(fakeEvent, {
      operation: "renderer:bulk-import",
      message: "一括取込に失敗しました",
      stack: "Error: 一括取込に失敗しました\n    at foo (App.tsx:1:1)",
      raceId: "202601010101",
      url: null,
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [operation, error, context] = logErrorMock.mock.calls[0]!;
    expect(operation).toBe("renderer:bulk-import");
    expect(error).toEqual({
      message: "一括取込に失敗しました",
      stack: "Error: 一括取込に失敗しました\n    at foo (App.tsx:1:1)",
    });
    expect(context).toEqual({ raceId: "202601010101", url: null });
  });

  it("不正な形状のpayloadでも例外を投げず、安全な既定値で委譲する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.logRendererError);

    expect(() => handler(fakeEvent, null)).not.toThrow();
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [operation] = logErrorMock.mock.calls[0]!;
    expect(operation).toBe("renderer:unknown");
  });

  it("messageが10,000文字を超える場合は切り詰めて委譲する(提案採用1)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.logRendererError);

    const longMessage = "あ".repeat(10050);
    await handler(fakeEvent, { operation: "renderer:bulk-import", message: longMessage });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [, error] = logErrorMock.mock.calls[0]! as [string, { message: string }];
    expect(error.message.length).toBeLessThanOrEqual(10000 + "…(省略)".length);
    expect(error.message.length).toBeLessThan(longMessage.length);
    expect(error.message).toContain("…(省略)");
    expect(error.message.startsWith("あ".repeat(100))).toBe(true);
  });

  it("stackが10,000文字を超える場合は切り詰めて委譲する(提案採用1)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.logRendererError);

    const longStack = "at foo (bar.js:1:1)\n".repeat(1000);
    await handler(fakeEvent, {
      operation: "renderer:bulk-import",
      message: "失敗しました",
      stack: longStack,
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [, error] = logErrorMock.mock.calls[0]! as [string, { stack: string }];
    expect(error.stack.length).toBeLessThan(longStack.length);
    expect(error.stack).toContain("…(省略)");
  });

  it("非文字列型のmessage/stackはString()変換されてから委譲される(提案採用1)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.logRendererError);

    await handler(fakeEvent, {
      operation: "renderer:bulk-import",
      message: 12345,
      stack: { foo: "bar" },
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [, error] = logErrorMock.mock.calls[0]! as [
      string,
      { message: string; stack: string },
    ];
    expect(error.message).toBe("12345");
    expect(error.stack).toBe("[object Object]");
  });

  it("stack未指定の場合はundefinedのまま委譲される(切り詰め処理で誤ってstackを生成しない)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.logRendererError);

    await handler(fakeEvent, {
      operation: "renderer:bulk-import",
      message: "失敗しました",
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [, error] = logErrorMock.mock.calls[0]! as [string, { stack: unknown }];
    expect(error.stack).toBeUndefined();
  });
});
