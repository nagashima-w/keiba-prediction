/**
 * ipc.ts の「ログフォルダを開く」「最新ログをエクスポート」ハンドラの結線テスト(Task#36)。
 *
 * 既存 ipc-bulk-import.test.ts の流儀(electron をモックし、ipcMain.handle が捕捉した
 * ハンドラ関数を直接呼ぶ)を踏襲する。実FSアクセスはテンポラリディレクトリで検証する
 * (settings-store.test.ts と同じ流儀)。
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { LogExportOutcome } from "../src/shared/analysis-types.js";

const {
  handleMock,
  openPathMock,
  showSaveDialogMock,
  fromWebContentsMock,
  ctx,
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  openPathMock: vi.fn(async () => ""),
  showSaveDialogMock: vi.fn(),
  fromWebContentsMock: vi.fn(() => null),
  ctx: { userData: "" },
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0",
    getPath: () => ctx.userData,
  },
  ipcMain: { handle: handleMock },
  shell: { openPath: openPathMock },
  dialog: { showSaveDialog: showSaveDialogMock },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
}));

const fakeEvent = { sender: {} };

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`ハンドラ未登録: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

let tempDir: string;
let logDir: string;

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  openPathMock.mockReset();
  openPathMock.mockResolvedValue("");
  showSaveDialogMock.mockReset();
  fromWebContentsMock.mockReset();
  fromWebContentsMock.mockReturnValue(null);
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-log-export-"));
  ctx.userData = tempDir;
  logDir = path.join(tempDir, "logs");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ipc ログフォルダを開くハンドラ(Task#36 受け入れ条件1)", () => {
  it("log:open-folder チャネルをハンドラ付きで登録する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.openLogFolder,
      expect.any(Function),
    );
  });

  it("ディレクトリが未作成でも作成してから shell.openPath を呼ぶ(安全側の挙動)", async () => {
    expect(existsSync(logDir)).toBe(false);
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await handlerFor(IPC_CHANNELS.openLogFolder)();

    expect(existsSync(logDir)).toBe(true);
    expect(openPathMock).toHaveBeenCalledWith(logDir);
  });

  it("shell.openPath がエラーメッセージ文字列を返したら例外を投げる", async () => {
    openPathMock.mockResolvedValue("開けませんでした");
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await expect(handlerFor(IPC_CHANNELS.openLogFolder)()).rejects.toThrow(
      "開けませんでした",
    );
  });
});

describe("ipc 最新ログをエクスポートするハンドラ(Task#36 受け入れ条件2)", () => {
  it("log:export チャネルをハンドラ付きで登録する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.exportLogs,
      expect.any(Function),
    );
  });

  it("現行ログ+旧ログを old→current の順で集約し、選んだ保存先へ書き込んで saved を返す", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "main.log"), "current-line", "utf8");
    writeFileSync(path.join(logDir, "main.old.log"), "old-line", "utf8");
    const outPath = path.join(tempDir, "out.txt");
    showSaveDialogMock.mockResolvedValue({
      canceled: false,
      filePath: outPath,
    });

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcome = (await handlerFor(IPC_CHANNELS.exportLogs)(
      fakeEvent,
    )) as LogExportOutcome;

    expect(outcome).toEqual({ status: "saved", filePath: outPath });
    expect(readFileSync(outPath, "utf8")).toBe("old-line\ncurrent-line");
  });

  it("保存先ダイアログをキャンセルしたら何も書き込まず canceled を返す", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "main.log"), "current-line", "utf8");
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcome = (await handlerFor(IPC_CHANNELS.exportLogs)(
      fakeEvent,
    )) as LogExportOutcome;

    expect(outcome).toEqual({ status: "canceled" });
  });

  it("既定のファイル名(defaultPath)に当日日付(YYYYMMDD)を含めてダイアログを呼ぶ", async () => {
    vi.setSystemTime(new Date(2026, 6, 16));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logDir, { recursive: true });
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await handlerFor(IPC_CHANNELS.exportLogs)(fakeEvent);

    expect(showSaveDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "keiba-ev-tool-logs-20260716.txt",
      }),
    );
    vi.useRealTimers();
  });

  it("ログが1件も無くても例外にせず空文字を書き込んで saved を返す", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logDir, { recursive: true });
    const outPath = path.join(tempDir, "empty-out.txt");
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: outPath });

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcome = (await handlerFor(IPC_CHANNELS.exportLogs)(
      fakeEvent,
    )) as LogExportOutcome;

    expect(outcome).toEqual({ status: "saved", filePath: outPath });
    expect(readFileSync(outPath, "utf8")).toBe("");
  });
});
