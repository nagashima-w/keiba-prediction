/**
 * ipc.ts の一括分析ハンドラの結線テスト(既存 ipc-resource-lifecycle.test.ts の流儀:
 * electron・pipeline-deps・analysis-pipeline をモックし、ipcMain.handle が捕捉した
 * ハンドラ関数を直接呼ぶ)。
 *
 * 目的:
 * - 選択レースを直列に分析し、全体進捗イベント(batch-progress)を送ること。
 * - 中断チャネルを叩くと次のレース境界で停止し、残りをスキップすること。
 * - 部分失敗(1レース失敗)でも全体を止めず、per-race の結果を返すこと。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { BatchRaceOutcome } from "../src/shared/analysis-types.js";

const { handleMock, createPipelineDepsMock, runAnalysisMock, ctx } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    createPipelineDepsMock: vi.fn(),
    runAnalysisMock: vi.fn(),
    ctx: { userData: "" },
  }),
);

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

// runAnalysis 本体は実IOを伴うためモックする(結線=一括オーケストレーションのみ検証)。
vi.mock("../src/main/analysis-pipeline.js", () => ({
  runAnalysis: runAnalysisMock,
}));

/** 最小の分析結果を返す。 */
function fakeResult(raceId: string): unknown {
  return {
    raceId,
    venueName: "東京",
    raceName: `${raceId}のレース`,
    courseType: "芝",
    distance: 1600,
    date: "2026/07/12",
    dateApproximate: false,
    llmUsed: false,
    llmSkippedReason: null,
    fallback: false,
    oddsStatus: "result",
    rows: [],
    warnings: [],
    analyzedAt: "2026-07-12T00:00:00.000Z",
  };
}

const senderSend = vi.fn();
const fakeEvent = { sender: { send: senderSend } };

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
  runAnalysisMock.mockReset();
  senderSend.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-batch-"));
  ctx.userData = tempDir;
  createPipelineDepsMock.mockImplementation(() => ({
    listRaces: vi.fn(async () => []),
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

const R1 = "202605020810";
const R2 = "202605020811";
const R3 = "202605020812";

describe("ipc 一括分析ハンドラ", () => {
  it("選択レースを直列に分析し、全体進捗を送って per-race 結果を返す", async () => {
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) =>
      fakeResult(String(raceId)),
    );
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcomes = (await handlerFor(IPC_CHANNELS.runBatchAnalysis)(
      fakeEvent,
      [R1, R2],
      "20260712",
    )) as BatchRaceOutcome[];

    expect(runAnalysisMock).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.status)).toEqual(["success", "success"]);
    expect(outcomes.map((o) => o.raceId)).toEqual([R1, R2]);
    // batch-progress チャネルへ全体進捗が送られている。
    const progressCalls = senderSend.mock.calls.filter(
      (c) => c[0] === IPC_CHANNELS.batchProgress,
    );
    expect(progressCalls.length).toBeGreaterThan(0);
    const last = progressCalls[progressCalls.length - 1]![1] as {
      completedRaces: number;
      totalRaces: number;
    };
    expect(last.completedRaces).toBe(2);
    expect(last.totalRaces).toBe(2);
  });

  it("中断チャネルを叩くと次のレース境界で停止し、残りをスキップする", async () => {
    // 1レース目の分析中に中断ハンドラを呼ぶ(境界前に flag を立てる)。
    let cancelHandler: (...args: unknown[]) => unknown;
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) => {
      cancelHandler(fakeEvent);
      return fakeResult(String(raceId));
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    cancelHandler = handlerFor(IPC_CHANNELS.cancelBatchAnalysis);

    const outcomes = (await handlerFor(IPC_CHANNELS.runBatchAnalysis)(
      fakeEvent,
      [R1, R2, R3],
      "20260712",
    )) as BatchRaceOutcome[];

    expect(runAnalysisMock).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status)).toEqual([
      "success",
      "skipped",
      "skipped",
    ]);
  });

  it("1レースの失敗でも全体を止めず、失敗を記録して次へ進む", async () => {
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) => {
      if (String(raceId) === R2) {
        throw new Error("R2の取得に失敗");
      }
      return fakeResult(String(raceId));
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcomes = (await handlerFor(IPC_CHANNELS.runBatchAnalysis)(
      fakeEvent,
      [R1, R2, R3],
      "20260712",
    )) as BatchRaceOutcome[];

    expect(outcomes.map((o) => o.status)).toEqual([
      "success",
      "failure",
      "success",
    ]);
    expect(outcomes[1]!.error).toContain("R2の取得に失敗");
  });

  it("連続実行で前回の中断フラグが残らない(新しい実行は全レースを処理する)", async () => {
    let cancelHandler: (...args: unknown[]) => unknown;
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) =>
      fakeResult(String(raceId)),
    );
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    cancelHandler = handlerFor(IPC_CHANNELS.cancelBatchAnalysis);
    const runHandler = handlerFor(IPC_CHANNELS.runBatchAnalysis);

    // 1回目: 途中で中断。
    runAnalysisMock.mockImplementationOnce(async (raceId: { toString(): string }) => {
      cancelHandler(fakeEvent);
      return fakeResult(String(raceId));
    });
    await runHandler(fakeEvent, [R1, R2], "20260712");

    // 2回目: 中断していないので両方成功するはず。
    const outcomes2 = (await runHandler(
      fakeEvent,
      [R1, R2],
      "20260712",
    )) as BatchRaceOutcome[];
    expect(outcomes2.map((o) => o.status)).toEqual(["success", "success"]);
  });
});
