/**
 * ipc.ts の期間バッチ「実行」(phase2。タスクC1)ハンドラの結線テスト。
 *
 * 期間バッチは収集(phase1)で複数の開催日にまたがる targetRaces(raceId+kaisaiDate の組)を
 * 確定させる。単日一括分析の既存ハンドラ(handleRunBatchAnalysis)は全レース共通の単一 date を
 * 前提にしているため、そのまま流用すると日跨ぎレースの kaisaiDate が誤って揃ってしまう
 * (過去日較正が壊れるバグ)。本ハンドラはレースごとに自分の kaisaiDate で runAnalysis を
 * 呼び分けることでこれを防ぐ。オーケストレーション本体(runBatchAnalysis/analysis-batch.js)は
 * 無改変で再利用し、進捗(analysis:batch-progress)・中断(analysis:cancel-batch)も
 * 単日一括分析と共有する(両者は同時に走らない前提)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { BatchRaceOutcome } from "../src/shared/analysis-types.js";

const { handleMock, createPipelineDepsMock, runAnalysisMock, logErrorMock, ctx } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    createPipelineDepsMock: vi.fn(),
    runAnalysisMock: vi.fn(),
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

// runAnalysis 本体は実IOを伴うためモックする(結線=日ごとのkaisaiDate束縛のみ検証)。
vi.mock("../src/main/analysis-pipeline.js", () => ({
  runAnalysis: runAnalysisMock,
}));

vi.mock("../src/main/logger.js", () => ({
  logError: logErrorMock,
  logWarn: vi.fn(),
  setSecretsProvider: vi.fn(),
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
  logErrorMock.mockReset();
  senderSend.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-period-batch-run-"));
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
const R2 = "202608120811";
const R3 = "202608120812";

describe("ipc 期間バッチ実行(phase2)ハンドラ(タスクC1)", () => {
  it("targetRacesの各レースが、自分のkaisaiDateでrunAnalysisへ渡されること(日跨ぎでも単一共有日にならない)", async () => {
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) =>
      fakeResult(String(raceId)),
    );
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const targetRaces = [
      { raceId: R1, kaisaiDate: "20260710" },
      { raceId: R2, kaisaiDate: "20260812" },
    ];

    const outcomes = (await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(
      fakeEvent,
      targetRaces,
    )) as BatchRaceOutcome[];

    expect(runAnalysisMock).toHaveBeenCalledTimes(2);
    // 呼び出しごとに raceId とその raceId 自身の kaisaiDate が渡っていること(取り違え無し)。
    expect(String(runAnalysisMock.mock.calls[0]![0])).toBe(R1);
    expect(String(runAnalysisMock.mock.calls[0]![1])).toBe("20260710");
    expect(String(runAnalysisMock.mock.calls[1]![0])).toBe(R2);
    expect(String(runAnalysisMock.mock.calls[1]![1])).toBe("20260812");
    expect(outcomes.map((o) => o.status)).toEqual(["success", "success"]);
  });

  it("同一raceIdが異なる開催日で複数回出現しても、各出現がそれぞれ自分の開催日でrunAnalysisに呼ばれること(要修正1: 位置ベース束縛。raceIdキーのMapだと後勝ちで先の出現が壊れる)", async () => {
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) =>
      fakeResult(String(raceId)),
    );
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    // 同一raceId(R1)が異なる開催日で2回出現する(例: dedup漏れ・呼び出し側の重複等でも
    // 各出現の開催日を独立に守れることを保証する)。
    const targetRaces = [
      { raceId: R1, kaisaiDate: "20260710" },
      { raceId: R1, kaisaiDate: "20260812" },
    ];

    await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(fakeEvent, targetRaces);

    expect(runAnalysisMock).toHaveBeenCalledTimes(2);
    expect(String(runAnalysisMock.mock.calls[0]![0])).toBe(R1);
    expect(String(runAnalysisMock.mock.calls[0]![1])).toBe("20260710");
    expect(String(runAnalysisMock.mock.calls[1]![0])).toBe(R1);
    expect(String(runAnalysisMock.mock.calls[1]![1])).toBe("20260812");
  });

  it("全体進捗は既存の一括分析チャネル(analysis:batch-progress)へ送られること(進捗チャネルの再利用)", async () => {
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) =>
      fakeResult(String(raceId)),
    );
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(fakeEvent, [
      { raceId: R1, kaisaiDate: "20260710" },
    ]);

    const progressCalls = senderSend.mock.calls.filter(
      (c) => c[0] === IPC_CHANNELS.batchProgress,
    );
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it("既存の中断チャネル(analysis:cancel-batch)を叩くと次のレース境界で停止すること(中断フラグの再利用)", async () => {
    let cancelHandler: (...args: unknown[]) => unknown;
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) => {
      cancelHandler(fakeEvent);
      return fakeResult(String(raceId));
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    cancelHandler = handlerFor(IPC_CHANNELS.cancelBatchAnalysis);

    const outcomes = (await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(
      fakeEvent,
      [
        { raceId: R1, kaisaiDate: "20260710" },
        { raceId: R2, kaisaiDate: "20260812" },
        { raceId: R3, kaisaiDate: "20260812" },
      ],
    )) as BatchRaceOutcome[];

    expect(runAnalysisMock).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status)).toEqual([
      "success",
      "skipped",
      "skipped",
    ]);
  });

  it("1レースの失敗でも全体を止めず、raceId付きでログ記録されること(onErrorの継承)", async () => {
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) => {
      if (String(raceId) === R2) {
        throw new Error("R2の取得に失敗");
      }
      return fakeResult(String(raceId));
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcomes = (await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(
      fakeEvent,
      [
        { raceId: R1, kaisaiDate: "20260710" },
        { raceId: R2, kaisaiDate: "20260812" },
      ],
    )) as BatchRaceOutcome[];

    expect(outcomes.map((o) => o.status)).toEqual(["success", "failure"]);
    expect(outcomes[1]!.error).toContain("R2の取得に失敗");
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [, error, context] = logErrorMock.mock.calls[0]!;
    expect((error as Error).message).toBe("R2の取得に失敗");
    expect(context).toEqual({ raceId: R2 });
  });

  it("連続実行で前回の中断フラグが残らないこと(単日一括分析と共有するフラグの独立リセット)", async () => {
    let cancelHandler: (...args: unknown[]) => unknown;
    runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) =>
      fakeResult(String(raceId)),
    );
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    cancelHandler = handlerFor(IPC_CHANNELS.cancelBatchAnalysis);
    const runHandler = handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis);

    runAnalysisMock.mockImplementationOnce(async (raceId: { toString(): string }) => {
      cancelHandler(fakeEvent);
      return fakeResult(String(raceId));
    });
    await runHandler(fakeEvent, [
      { raceId: R1, kaisaiDate: "20260710" },
      { raceId: R2, kaisaiDate: "20260812" },
    ]);

    const outcomes2 = (await runHandler(fakeEvent, [
      { raceId: R1, kaisaiDate: "20260710" },
      { raceId: R2, kaisaiDate: "20260812" },
    ])) as BatchRaceOutcome[];
    expect(outcomes2.map((o) => o.status)).toEqual(["success", "success"]);
  });

  describe("targetRacesの防御的正規化(要修正2: 不正な要素で例外を投げないこと)", () => {
    it("非配列(undefined)を渡しても例外を投げず、空として扱われること", async () => {
      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();

      const outcomes = (await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(
        fakeEvent,
        undefined,
      )) as BatchRaceOutcome[];

      expect(outcomes).toEqual([]);
      expect(runAnalysisMock).not.toHaveBeenCalled();
    });

    it("要素にnull/undefinedが混在していても例外を投げず、安全側で除外されること", async () => {
      runAnalysisMock.mockImplementation(async (raceId: { toString(): string }) =>
        fakeResult(String(raceId)),
      );
      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();

      const outcomes = (await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(
        fakeEvent,
        [null, { raceId: R1, kaisaiDate: "20260710" }, undefined],
      )) as BatchRaceOutcome[];

      // 不正要素(null/undefined)は除外され、有効な1件のみ処理されること。
      expect(runAnalysisMock).toHaveBeenCalledTimes(1);
      expect(String(runAnalysisMock.mock.calls[0]![0])).toBe(R1);
      expect(outcomes.map((o) => o.raceId)).toEqual([R1]);
    });

    it("配列そのものがnullでも例外を投げず、空として扱われること", async () => {
      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();

      const outcomes = (await handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis)(
        fakeEvent,
        null,
      )) as BatchRaceOutcome[];

      expect(outcomes).toEqual([]);
      expect(runAnalysisMock).not.toHaveBeenCalled();
    });
  });
});
