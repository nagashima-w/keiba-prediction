/**
 * ipc.ts の一括取込ハンドラの結線テスト(Task#31。既存 ipc-batch.test.ts の流儀:
 * electron・pipeline-deps をモックし、ipcMain.handle が捕捉したハンドラ関数を直接呼ぶ)。
 *
 * レート制限(レース間1.5秒待機)は実装(runBulkImport の既定 sleep)がそのまま使われるため、
 * フェイクタイマーで実時間を消費せずに検証する(既存 http-client.test.ts と同じ流儀)。
 *
 * 目的:
 * - listUnimportedRaceIds で列挙したレースを直列に取り込み、全体進捗イベントを送ること。
 * - 中断チャネルを叩くと次のレース境界で停止し、残りをスキップすること。
 * - 部分失敗(1レース失敗)でも全体を止めず、per-race の結果を返すこと。
 * - 未確定(not_confirmed)は自動スキップとして記録されること。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { BulkImportRaceOutcome } from "../src/shared/analysis-types.js";

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

// Task#35: ログ基盤の実electron-logへは触れず、失敗時にlogErrorが呼ばれることだけを検証する。
vi.mock("../src/main/logger.js", () => ({
  logError: logErrorMock,
  setSecretsProvider: vi.fn(),
}));

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
let listUnimportedRaceIdsMock: ReturnType<typeof vi.fn>;
let importResultMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  handleMock.mockReset();
  createPipelineDepsMock.mockReset();
  logErrorMock.mockReset();
  senderSend.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-bulk-import-"));
  ctx.userData = tempDir;
  listUnimportedRaceIdsMock = vi.fn(() => []);
  importResultMock = vi.fn(async () => ({}));
  createPipelineDepsMock.mockImplementation(() => ({
    listRaces: vi.fn(async () => []),
    importResult: importResultMock,
    listUnimportedRaceIds: listUnimportedRaceIdsMock,
    getVerifyReport: vi.fn(() => ({})),
    getVerifyReportByPromptVersion: vi.fn(() => []),
    listAnalysisHistory: vi.fn(() => []),
    close: vi.fn(),
    deps: {},
  }));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

const R1 = "202605020810";
const R2 = "202605020811";
const R3 = "202605020812";

/** フェイクタイマー環境下でハンドラ呼び出しの Promise を待つ(レート制限の待機を進める)。 */
async function runHandlerWithFakeTimers<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(60_000);
  return promise;
}

describe("ipc 一括取込ハンドラ(Task#31)", () => {
  it("listUnimportedRaceIds が列挙したレースを直列に取り込み、全体進捗を送って per-race 結果を返す", async () => {
    listUnimportedRaceIdsMock.mockReturnValue([R1, R2]);
    importResultMock.mockImplementation(async (raceId: { toString(): string }) => ({
      status: "imported",
      raceId: String(raceId),
      horseCount: 10,
      placePayoutCount: 3,
      hasPayout: true,
    }));
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcomes = await runHandlerWithFakeTimers(
      handlerFor(IPC_CHANNELS.runBulkImport)(fakeEvent) as Promise<
        BulkImportRaceOutcome[]
      >,
    );

    expect(importResultMock).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.status)).toEqual(["imported", "imported"]);
    expect(outcomes.map((o) => o.raceId)).toEqual([R1, R2]);

    const progressCalls = senderSend.mock.calls.filter(
      (c) => c[0] === IPC_CHANNELS.bulkImportProgress,
    );
    expect(progressCalls.length).toBeGreaterThan(0);
    const last = progressCalls[progressCalls.length - 1]![1] as {
      completedRaces: number;
      totalRaces: number;
    };
    expect(last.completedRaces).toBe(2);
    expect(last.totalRaces).toBe(2);
  });

  it("未確定(not_confirmed)は自動スキップとして記録され、全体は止まらないこと", async () => {
    listUnimportedRaceIdsMock.mockReturnValue([R1, R2]);
    importResultMock.mockImplementation(async (raceId: { toString(): string }) => {
      if (String(raceId) === R2) {
        return { status: "not_confirmed", raceId: String(raceId) };
      }
      return {
        status: "imported",
        raceId: String(raceId),
        horseCount: 10,
        placePayoutCount: 3,
        hasPayout: true,
      };
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcomes = await runHandlerWithFakeTimers(
      handlerFor(IPC_CHANNELS.runBulkImport)(fakeEvent) as Promise<
        BulkImportRaceOutcome[]
      >,
    );

    expect(outcomes.map((o) => o.status)).toEqual(["imported", "not_confirmed"]);
  });

  it("1レースの失敗でも全体を止めず、失敗を記録して次へ進む", async () => {
    listUnimportedRaceIdsMock.mockReturnValue([R1, R2, R3]);
    importResultMock.mockImplementation(async (raceId: { toString(): string }) => {
      if (String(raceId) === R2) {
        throw new Error("R2の取込に失敗");
      }
      return {
        status: "imported",
        raceId: String(raceId),
        horseCount: 10,
        placePayoutCount: 3,
        hasPayout: true,
      };
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcomes = await runHandlerWithFakeTimers(
      handlerFor(IPC_CHANNELS.runBulkImport)(fakeEvent) as Promise<
        BulkImportRaceOutcome[]
      >,
    );

    expect(outcomes.map((o) => o.status)).toEqual([
      "imported",
      "failure",
      "imported",
    ]);
    expect(outcomes[1]!.error).toContain("R2の取込に失敗");

    // Task#35: 失敗レースは操作名・raceId・URL付きでログされる(AIが原因特定できる粒度の受け入れ条件)。
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [operation, error, context] = logErrorMock.mock.calls[0]!;
    expect(operation).toBe("result:run-bulk-import:race");
    expect((error as Error).message).toBe("R2の取込に失敗");
    expect(context).toEqual({
      raceId: R2,
      url: expect.stringContaining(R2) as unknown as string,
    });
  });

  it("中断チャネルを叩くと次のレース境界で停止し、残りをスキップする", async () => {
    listUnimportedRaceIdsMock.mockReturnValue([R1, R2, R3]);
    let cancelHandler: (...args: unknown[]) => unknown;
    importResultMock.mockImplementation(async (raceId: { toString(): string }) => {
      cancelHandler(fakeEvent);
      return {
        status: "imported",
        raceId: String(raceId),
        horseCount: 10,
        placePayoutCount: 3,
        hasPayout: true,
      };
    });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    cancelHandler = handlerFor(IPC_CHANNELS.cancelBulkImport);

    const outcomes = await runHandlerWithFakeTimers(
      handlerFor(IPC_CHANNELS.runBulkImport)(fakeEvent) as Promise<
        BulkImportRaceOutcome[]
      >,
    );

    expect(importResultMock).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status)).toEqual([
      "imported",
      "skipped",
      "skipped",
    ]);
  });

  it("連続実行で前回の中断フラグが残らない(新しい実行は全レースを処理する)", async () => {
    listUnimportedRaceIdsMock.mockReturnValue([R1, R2]);
    let cancelHandler: (...args: unknown[]) => unknown;
    importResultMock.mockImplementation(async (raceId: { toString(): string }) => ({
      status: "imported",
      raceId: String(raceId),
      horseCount: 10,
      placePayoutCount: 3,
      hasPayout: true,
    }));
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    cancelHandler = handlerFor(IPC_CHANNELS.cancelBulkImport);
    const runHandler = handlerFor(IPC_CHANNELS.runBulkImport);

    // 1回目: 途中で中断。
    importResultMock.mockImplementationOnce(async (raceId: { toString(): string }) => {
      cancelHandler(fakeEvent);
      return {
        status: "imported",
        raceId: String(raceId),
        horseCount: 10,
        placePayoutCount: 3,
        hasPayout: true,
      };
    });
    await runHandlerWithFakeTimers(
      runHandler(fakeEvent) as Promise<BulkImportRaceOutcome[]>,
    );

    // 2回目: 中断していないので両方成功するはず。
    const outcomes2 = await runHandlerWithFakeTimers(
      runHandler(fakeEvent) as Promise<BulkImportRaceOutcome[]>,
    );
    expect(outcomes2.map((o) => o.status)).toEqual(["imported", "imported"]);
  });
});
