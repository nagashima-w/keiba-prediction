import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import { DEFAULT_APP_SETTINGS } from "../src/main/settings-store.js";
import type { SettingsUpdate } from "../src/shared/settings.js";

/**
 * ipc.ts の資源ライフサイクル結線テスト(既存 ipc.test.ts の流儀: electron をモックし、
 * ipcMain.handle が捕捉したハンドラ関数を直接呼ぶ)。
 *
 * 目的: await を伴う handleListRaces / handleImportResult の実行中に設定保存(markDirty)が来ても、
 * 実行中の資源(DB接続)が閉じられない(runExclusive で保護されている)ことを固定する。
 */

// hoisted: electron / pipeline-deps のモックから参照する共有オブジェクト。
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

// 実IO(better-sqlite3・HTTP)を避け、資源をフェイクに差し替える。
vi.mock("../src/main/pipeline-deps.js", () => ({
  createPipelineDeps: createPipelineDepsMock,
}));

/** フェイク資源。close で closed=true にして「閉じられたか」を観測する。 */
interface FakeResources {
  closed: boolean;
  listRaces: (...args: unknown[]) => Promise<unknown[]>;
  importResult: (...args: unknown[]) => Promise<unknown>;
  getVerifyReport: () => unknown;
  listAnalysisHistory: () => unknown[];
  close: () => void;
  deps: unknown;
}

const fakeEvent = { sender: { send: vi.fn() } };

/** 有効な設定更新ペイロード(保存が成功する最小構成)。 */
const validUpdate: SettingsUpdate = {
  discordWebhookUrl: "",
  evThreshold: 1,
  biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
  baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
  autoSendDiscord: false,
  additionalInstruction: "",
  clipVariant: "default",
};

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
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-life-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 生成される資源を配列に集めつつ、指定操作(listRaces/importResult)を gate 解決まで保留にする。
 * @returns 生成された資源配列と、保留を解除する release
 */
function setupDeferred(
  op: "listRaces" | "importResult",
): { fakes: FakeResources[]; release: () => void } {
  const fakes: FakeResources[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  createPipelineDepsMock.mockImplementation(() => {
    const f: FakeResources = {
      closed: false,
      listRaces: vi.fn(async () => []),
      importResult: vi.fn(async () => ({ kind: "取込成功" })),
      getVerifyReport: vi.fn(() => ({})),
      listAnalysisHistory: vi.fn(() => []),
      close: vi.fn(function (this: FakeResources) {
        f.closed = true;
      }),
      deps: {},
    };
    // 対象操作だけ gate 解決まで保留する。
    if (op === "listRaces") {
      f.listRaces = vi.fn(() => gate.then(() => []));
    } else {
      f.importResult = vi.fn(() => gate.then(() => ({ kind: "取込成功" })));
    }
    fakes.push(f);
    return f;
  });
  return { fakes, release };
}

describe("ipc 資源ライフサイクル(実行中の設定保存で資源を閉じない)", () => {
  it("listRaces 実行中に設定保存(markDirty)が来ても資源は閉じられず、完了後の取得で再構築する", async () => {
    const { fakes, release } = setupDeferred("listRaces");
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const listHandler = handlerFor(IPC_CHANNELS.listRaces);
    const saveHandler = handlerFor(IPC_CHANNELS.saveSettings);
    const verifyHandler = handlerFor(IPC_CHANNELS.getVerifyReport);

    // listRaces を開始(gate で保留)。
    const inflight = listHandler(fakeEvent, "20260101");
    // 実行中に設定保存 → markDirty。実行中なので即時 close してはならない。
    await saveHandler(fakeEvent, validUpdate);
    expect(fakes[0]!.closed).toBe(false);

    // 保留解除して完了。
    release();
    await inflight;

    // 次のアイドル取得で古い資源を閉じ、新設定で再構築する。
    verifyHandler(fakeEvent);
    expect(fakes[0]!.closed).toBe(true);
    expect(fakes).toHaveLength(2);
  });

  it("importResult 実行中に設定保存(markDirty)が来ても資源は閉じられない", async () => {
    const { fakes, release } = setupDeferred("importResult");
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const importHandler = handlerFor(IPC_CHANNELS.importResult);
    const saveHandler = handlerFor(IPC_CHANNELS.saveSettings);

    const inflight = importHandler(fakeEvent, "202601010101");
    await saveHandler(fakeEvent, validUpdate);
    expect(fakes[0]!.closed).toBe(false);

    release();
    await inflight;
  });
});
