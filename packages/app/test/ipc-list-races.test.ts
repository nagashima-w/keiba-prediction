/**
 * ipc.ts の race:list ハンドラの結線テスト(既存 ipc-batch.test.ts の流儀:
 * electron・pipeline-deps をモックし、ipcMain.handle が捕捉したハンドラ関数を直接呼ぶ)。
 *
 * 目的: 開催区分(venueKind)の指定に応じて、資源(PipelineResources)の
 * listRaces / listNarRaces を正しく呼び分けること(仕様「選択に応じて listRaces / listNarRaces
 * を呼び分ける」)。
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
let listRacesMock: ReturnType<typeof vi.fn>;
let listNarRacesMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  createPipelineDepsMock.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-list-races-"));
  ctx.userData = tempDir;

  listRacesMock = vi.fn(async () => [
    { raceId: "202605020811", name: "中央レース", courseType: "芝", distance: 1600, entryCount: 12, venue: "東京", raceNumber: 11 },
  ]);
  listNarRacesMock = vi.fn(async () => [
    { raceId: "202654071210", name: "地方レース", courseType: "ダ", distance: 1400, entryCount: 10, venue: "高知", raceNumber: 10 },
  ]);
  createPipelineDepsMock.mockImplementation(() => ({
    listRaces: listRacesMock,
    listNarRaces: listNarRacesMock,
    importResult: vi.fn(async () => ({})),
    getVerifyReport: vi.fn(() => ({})),
    listAnalysisHistory: vi.fn(() => []),
    close: vi.fn(),
    deps: {},
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("race:list ハンドラ(開催区分による呼び分け)", () => {
  it("venueKindを渡さない場合は resources.listRaces(中央)を呼ぶ(既定は central)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.listRaces);

    const result = await handler(fakeEvent, "20260712");

    expect(listRacesMock).toHaveBeenCalledTimes(1);
    expect(listNarRacesMock).not.toHaveBeenCalled();
    expect(result).toEqual([
      { raceId: "202605020811", name: "中央レース", courseType: "芝", distance: 1600, entryCount: 12, venue: "東京", raceNumber: 11 },
    ]);
  });

  it("venueKind: 'central' を渡した場合は resources.listRaces を呼ぶ", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.listRaces);

    await handler(fakeEvent, "20260712", "central");

    expect(listRacesMock).toHaveBeenCalledTimes(1);
    expect(listNarRacesMock).not.toHaveBeenCalled();
  });

  it("venueKind: 'nar' を渡した場合は resources.listNarRaces を呼ぶ", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.listRaces);

    const result = await handler(fakeEvent, "20260712", "nar");

    expect(listNarRacesMock).toHaveBeenCalledTimes(1);
    expect(listRacesMock).not.toHaveBeenCalled();
    expect(result).toEqual([
      { raceId: "202654071210", name: "地方レース", courseType: "ダ", distance: 1400, entryCount: 10, venue: "高知", raceNumber: 10 },
    ]);
  });
});
