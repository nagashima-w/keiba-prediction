/**
 * ipc.ts の verify:report ハンドラの結線テスト(Task#32)。
 *
 * 目的: 検証レポート取得時の開催区分(venueKind)引数が resources.getVerifyReport に
 * そのまま渡ること(既存 ipc-list-races.test.ts の venueKind 呼び分けテストと同じ流儀:
 * electron・pipeline-deps をモックし、ipcMain.handle が捕捉したハンドラ関数を直接呼ぶ)。
 * 未指定・不正値は "all"(全体、既定・従来どおり)へ正規化されることも確認する。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";

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

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`ハンドラ未登録: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

const fakeEvent = { sender: { send: vi.fn() } };
let tempDir: string;
let getVerifyReportMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  createPipelineDepsMock.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-verify-report-venue-"));
  ctx.userData = tempDir;

  getVerifyReportMock = vi.fn(() => ({ includedAnalysisCount: 0 }));
  createPipelineDepsMock.mockImplementation(() => ({
    listRaces: vi.fn(async () => []),
    listNarRaces: vi.fn(async () => []),
    importResult: vi.fn(async () => ({})),
    getVerifyReport: getVerifyReportMock,
    getVerifyReportByPromptVersion: vi.fn(() => []),
    getRaceLedger: vi.fn(() => []),
    listUnimportedRaceIds: vi.fn(() => []),
    close: vi.fn(),
    deps: {},
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("verify:report ハンドラ(開催区分フィルタの受け渡し、Task#32)", () => {
  it("venueKindを渡さない場合は resources.getVerifyReport('all') を呼ぶ(既定は全体)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await handler(fakeEvent);

    expect(getVerifyReportMock).toHaveBeenCalledWith("all");
  });

  it("venueKind: 'central' を渡した場合は resources.getVerifyReport('central') を呼ぶ", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await handler(fakeEvent, "central");

    expect(getVerifyReportMock).toHaveBeenCalledWith("central");
  });

  it("venueKind: 'nar' を渡した場合は resources.getVerifyReport('nar') を呼ぶ", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await handler(fakeEvent, "nar");

    expect(getVerifyReportMock).toHaveBeenCalledWith("nar");
  });

  it("不正な値(想定外の文字列)は 'all' に正規化する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await handler(fakeEvent, "unknown-value");

    expect(getVerifyReportMock).toHaveBeenCalledWith("all");
  });
});
