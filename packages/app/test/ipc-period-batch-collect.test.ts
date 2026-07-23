/**
 * ipc.ts の期間バッチ「先取得+件数算出」(phase1)ハンドラの結線テスト(タスクB2b-1。
 * 既存 ipc-bulk-import.test.ts / ipc-list-races.test.ts の流儀: electron・pipeline-deps を
 * モックし、ipcMain.handle が捕捉したハンドラ関数を直接呼ぶ)。
 *
 * この層は「収集+件数算出」までを担い、LLM分析(runBatchAnalysis/analyzeOne)を一切呼ばない
 * ことをスタブの呼び出し回数0で確認する。また bulk query(listAnalyzedRaceIdsByPromptVersion)は
 * 収集ループ全体で1回だけ発行されること、先取得の中断フラグ・チャネルが分析フェーズの
 * 中断(cancelBatchAnalysis/batchCancelRequested)と独立であることを確認する。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { PeriodBatchCollectResult } from "../src/shared/analysis-types.js";

const {
  handleMock,
  createPipelineDepsMock,
  logErrorMock,
  runBatchAnalysisMock,
  runAnalysisMock,
  ctx,
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createPipelineDepsMock: vi.fn(),
  logErrorMock: vi.fn(),
  runBatchAnalysisMock: vi.fn(),
  runAnalysisMock: vi.fn(),
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

// phase1が「実行(analyzeOne/runBatchAnalysis)を一度も呼ばない」ことをスタブ0回で確認するため、
// 両モジュールをモックして呼び出し回数を監視する。
vi.mock("../src/main/analysis-batch.js", () => ({
  runBatchAnalysis: runBatchAnalysisMock,
}));
vi.mock("../src/main/analysis-pipeline.js", () => ({
  runAnalysis: runAnalysisMock,
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

/** テスト用の最小レース一覧エントリを作る。 */
function entry(raceId: string, grade?: string): unknown {
  return {
    raceId,
    name: `${raceId}のレース`,
    courseType: "ダ",
    distance: 1600,
    entryCount: 12,
    raceNumber: 1,
    ...(grade !== undefined ? { grade } : {}),
  };
}

let tempDir: string;
let listRacesMock: ReturnType<typeof vi.fn>;
let listNarRacesMock: ReturnType<typeof vi.fn>;
let listAnalyzedRaceIdsByPromptVersionMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  createPipelineDepsMock.mockReset();
  logErrorMock.mockReset();
  runBatchAnalysisMock.mockReset();
  runAnalysisMock.mockReset();
  senderSend.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-period-batch-"));
  ctx.userData = tempDir;

  listRacesMock = vi.fn(async () => [entry("202605020811")]);
  listNarRacesMock = vi.fn(async () => [entry("202642071001")]);
  listAnalyzedRaceIdsByPromptVersionMock = vi.fn(() => []);
  createPipelineDepsMock.mockImplementation(() => ({
    listRaces: listRacesMock,
    listNarRaces: listNarRacesMock,
    importResult: vi.fn(async () => ({})),
    listUnimportedRaceIds: vi.fn(() => []),
    listAnalyzedRaceIdsByPromptVersion: listAnalyzedRaceIdsByPromptVersionMock,
    getVerifyReport: vi.fn(() => ({})),
    getVerifyReportByPromptVersion: vi.fn(() => []),
    deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
    getRaceLedger: vi.fn(() => []),
    close: vi.fn(),
    deps: {},
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("期間バッチ「先取得+件数算出」ハンドラ(phase1。タスクB2b-1)", () => {
  it("central指定でlistRacesを日ごとに呼び、runBatchAnalysis/analyzeOneを一度も呼ばずに結果を返す", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    const result = (await handler(
      fakeEvent,
      "20260710",
      "20260711",
      "central",
    )) as PeriodBatchCollectResult;

    expect(listRacesMock).toHaveBeenCalledTimes(2);
    expect(listNarRacesMock).not.toHaveBeenCalled();
    expect(result.totalRaces).toBe(2);
    expect(result.targetRaces).toEqual([
      { raceId: "202605020811", kaisaiDate: "20260710" },
      { raceId: "202605020811", kaisaiDate: "20260711" },
    ]);
    expect(result.cancelled).toBe(false);

    // phase1はLLM分析を一切実行しない(スタブ呼び出し0回で構造的に確認)。
    expect(runBatchAnalysisMock).not.toHaveBeenCalled();
    expect(runAnalysisMock).not.toHaveBeenCalled();
  });

  it("nar-all指定でlistNarRacesを呼び、listRacesは呼ばないこと", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    await handler(fakeEvent, "20260710", "20260710", "nar-all");

    expect(listNarRacesMock).toHaveBeenCalledTimes(1);
    expect(listRacesMock).not.toHaveBeenCalled();
  });

  it("nar-jpn指定でlistNarRacesを呼び、Jpn以外の通常戦は除外されること(B2aのcollectRaceIdsOverRangeへ委譲)", async () => {
    listNarRacesMock = vi.fn(async () => [
      entry("202642071001", "Jpn1"),
      entry("202642071002"),
    ]);
    createPipelineDepsMock.mockImplementation(() => ({
      listRaces: listRacesMock,
      listNarRaces: listNarRacesMock,
      importResult: vi.fn(async () => ({})),
      listUnimportedRaceIds: vi.fn(() => []),
      listAnalyzedRaceIdsByPromptVersion: listAnalyzedRaceIdsByPromptVersionMock,
      getVerifyReport: vi.fn(() => ({})),
      getVerifyReportByPromptVersion: vi.fn(() => []),
      deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
      getRaceLedger: vi.fn(() => []),
      close: vi.fn(),
      deps: {},
    }));
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    const result = (await handler(
      fakeEvent,
      "20260710",
      "20260710",
      "nar-jpn",
    )) as PeriodBatchCollectResult;

    expect(result.targetRaces).toEqual([
      { raceId: "202642071001", kaisaiDate: "20260710" },
    ]);
    expect(result.totalRaces).toBe(1);
  });

  it.each<[string | undefined, string]>([
    ["nar", "central3択に含まれない値(RaceVenueKindの'nar')"],
    ["unknown-target", "想定外の任意文字列"],
    [undefined, "未指定(undefined)"],
  ])(
    "不正な取得対象(%s: %s)はcentralへフォールバックすること(normalizeRaceListTargetの防御的正規化)",
    async (invalidTarget) => {
      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();
      const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

      await handler(fakeEvent, "20260710", "20260710", invalidTarget);

      // central扱い(既定)になるため listRaces が呼ばれ、listNarRaces は呼ばれない。
      expect(listRacesMock).toHaveBeenCalledTimes(1);
      expect(listNarRacesMock).not.toHaveBeenCalled();
    },
  );

  it("bulk query(listAnalyzedRaceIdsByPromptVersion)は複数日にまたがっても1回だけ発行されること", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    await handler(fakeEvent, "20260710", "20260715", "central");

    expect(listAnalyzedRaceIdsByPromptVersionMock).toHaveBeenCalledTimes(1);
  });

  it("bulk queryの結果に含まれるraceIdはskippedAlreadyAnalyzedに計上され実行対象から除外されること", async () => {
    listRacesMock = vi.fn(async () => [entry("202605020811"), entry("202605020812")]);
    listAnalyzedRaceIdsByPromptVersionMock = vi.fn(() => ["202605020811"]);
    createPipelineDepsMock.mockImplementation(() => ({
      listRaces: listRacesMock,
      listNarRaces: listNarRacesMock,
      importResult: vi.fn(async () => ({})),
      listUnimportedRaceIds: vi.fn(() => []),
      listAnalyzedRaceIdsByPromptVersion: listAnalyzedRaceIdsByPromptVersionMock,
      getVerifyReport: vi.fn(() => ({})),
      getVerifyReportByPromptVersion: vi.fn(() => []),
      deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
      getRaceLedger: vi.fn(() => []),
      close: vi.fn(),
      deps: {},
    }));
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    const result = (await handler(
      fakeEvent,
      "20260710",
      "20260710",
      "central",
    )) as PeriodBatchCollectResult;

    expect(result.totalRaces).toBe(2);
    expect(result.skippedAlreadyAnalyzed).toBe(1);
    expect(result.targetRaces).toEqual([
      { raceId: "202605020812", kaisaiDate: "20260710" },
    ]);
  });

  it("複数日にまたがる収集で、各レースのkaisaiDateがそのレースが見つかった開催日と一致すること(タスクC1: 単一共有日にならないこと)", async () => {
    listRacesMock = vi.fn(async (date: string) => [entry(`race-${date}`)]);
    createPipelineDepsMock.mockImplementation(() => ({
      listRaces: listRacesMock,
      listNarRaces: listNarRacesMock,
      importResult: vi.fn(async () => ({})),
      listUnimportedRaceIds: vi.fn(() => []),
      listAnalyzedRaceIdsByPromptVersion: listAnalyzedRaceIdsByPromptVersionMock,
      getVerifyReport: vi.fn(() => ({})),
      getVerifyReportByPromptVersion: vi.fn(() => []),
      deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
      getRaceLedger: vi.fn(() => []),
      close: vi.fn(),
      deps: {},
    }));
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    const result = (await handler(
      fakeEvent,
      "20260710",
      "20260712",
      "central",
    )) as PeriodBatchCollectResult;

    expect(result.targetRaces).toEqual([
      { raceId: "race-20260710", kaisaiDate: "20260710" },
      { raceId: "race-20260711", kaisaiDate: "20260711" },
      { raceId: "race-20260712", kaisaiDate: "20260712" },
    ]);
  });

  it("設定のclipVariantに応じて現行版promptVersionを解決し、bulk queryへ渡すこと(版スナップショット)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const saveSettingsHandler = handlerFor(IPC_CHANNELS.saveSettings);
    await saveSettingsHandler(fakeEvent, { clipVariant: "wide15" });
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    await handler(fakeEvent, "20260710", "20260710", "central");

    expect(listAnalyzedRaceIdsByPromptVersionMock).toHaveBeenCalledWith(
      "2026-07-23.4-clip015",
    );
  });

  it("失敗した日はfailureDaysに記録され、他日の処理は継続すること", async () => {
    listRacesMock = vi.fn(async (date: string) => {
      if (date === "20260711") {
        throw new Error("ネットワークエラー");
      }
      return [entry(`race-${date}`)];
    });
    createPipelineDepsMock.mockImplementation(() => ({
      listRaces: listRacesMock,
      listNarRaces: listNarRacesMock,
      importResult: vi.fn(async () => ({})),
      listUnimportedRaceIds: vi.fn(() => []),
      listAnalyzedRaceIdsByPromptVersion: listAnalyzedRaceIdsByPromptVersionMock,
      getVerifyReport: vi.fn(() => ({})),
      getVerifyReportByPromptVersion: vi.fn(() => []),
      deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
      getRaceLedger: vi.fn(() => []),
      close: vi.fn(),
      deps: {},
    }));
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    const result = (await handler(
      fakeEvent,
      "20260710",
      "20260712",
      "central",
    )) as PeriodBatchCollectResult;

    expect(result.failureDays).toEqual(["20260711"]);
    expect(result.perDayOutcome[1]).toEqual({
      date: "20260711",
      status: "failure",
      error: "ネットワークエラー",
    });
  });

  it("中断チャネル(先取得専用)を叩くと次の日境界で停止し、cancelled:trueで確定すること", async () => {
    let callCount = 0;
    listRacesMock = vi.fn(async () => {
      callCount += 1;
      return [entry(`race-${callCount}`)];
    });
    createPipelineDepsMock.mockImplementation(() => ({
      listRaces: listRacesMock,
      listNarRaces: listNarRacesMock,
      importResult: vi.fn(async () => ({})),
      listUnimportedRaceIds: vi.fn(() => []),
      listAnalyzedRaceIdsByPromptVersion: listAnalyzedRaceIdsByPromptVersionMock,
      getVerifyReport: vi.fn(() => ({})),
      getVerifyReportByPromptVersion: vi.fn(() => []),
      deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
      getRaceLedger: vi.fn(() => []),
      close: vi.fn(),
      deps: {},
    }));
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const collectHandler = handlerFor(IPC_CHANNELS.collectPeriodBatch);
    const cancelHandler = handlerFor(IPC_CHANNELS.cancelCollectPeriodBatch);

    // 収集は4日分あるが、1日目完了直後に中断要求を立てる。
    listRacesMock.mockImplementationOnce(async () => {
      callCount += 1;
      cancelHandler(fakeEvent);
      return [entry("race-1")];
    });

    const result = (await collectHandler(
      fakeEvent,
      "20260710",
      "20260713",
      "central",
    )) as PeriodBatchCollectResult;

    expect(result.cancelled).toBe(true);
    expect(listRacesMock).toHaveBeenCalledTimes(1);
  });

  it("分析フェーズの中断(cancelBatchAnalysis)を叩いても、期間バッチの先取得は中断されないこと(フラグ独立性)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const cancelBatchAnalysisHandler = handlerFor(IPC_CHANNELS.cancelBatchAnalysis);
    const collectHandler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

    // 分析フェーズの中断だけを先に要求する。
    cancelBatchAnalysisHandler(fakeEvent);

    const result = (await collectHandler(
      fakeEvent,
      "20260710",
      "20260711",
      "central",
    )) as PeriodBatchCollectResult;

    expect(result.cancelled).toBe(false);
    expect(listRacesMock).toHaveBeenCalledTimes(2);
  });

  it("期間バッチの先取得中断(cancelCollectPeriodBatch)を叩いても、分析フェーズの中断フラグ(batchCancelRequested)には影響しないこと(フラグ独立性・逆方向)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const cancelCollectHandler = handlerFor(IPC_CHANNELS.cancelCollectPeriodBatch);
    const runBatchHandler = handlerFor(IPC_CHANNELS.runBatchAnalysis);

    // 先取得の中断だけを要求する。
    cancelCollectHandler(fakeEvent);

    await runBatchHandler(fakeEvent, [], "20260710");

    // runBatchAnalysis(analysis-batch.js)はモック化されているため、実際に渡された
    // shouldCancel コールバックを取り出し、先取得側の中断要求の影響を受けていない
    // (=false のまま)ことを直接確認する。
    expect(runBatchAnalysisMock).toHaveBeenCalledTimes(1);
    const depsArg = runBatchAnalysisMock.mock.calls[0]![1] as {
      shouldCancel: () => boolean;
    };
    expect(depsArg.shouldCancel()).toBe(false);
  });

  describe("先取得(phase1)の進捗チャネル配線(タスクC2)", () => {
    it("複数日の収集で、日ごとに進捗チャネル(periodBatchCollectProgress)へ{completedDays,totalDays}が送られること(N日→N回・順序どおり)", async () => {
      listRacesMock = vi.fn(async () => [entry("202605020811")]);
      createPipelineDepsMock.mockImplementation(() => ({
        listRaces: listRacesMock,
        listNarRaces: listNarRacesMock,
        importResult: vi.fn(async () => ({})),
        listUnimportedRaceIds: vi.fn(() => []),
        listAnalyzedRaceIdsByPromptVersion: listAnalyzedRaceIdsByPromptVersionMock,
        getVerifyReport: vi.fn(() => ({})),
        getVerifyReportByPromptVersion: vi.fn(() => []),
        deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
        getRaceLedger: vi.fn(() => []),
        close: vi.fn(),
        deps: {},
      }));
      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();
      const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

      await handler(fakeEvent, "20260710", "20260713", "central");

      const progressCalls = senderSend.mock.calls.filter(
        (c) => c[0] === IPC_CHANNELS.periodBatchCollectProgress,
      );
      expect(progressCalls.length).toBe(4);
      expect(progressCalls.map((c) => c[1])).toEqual([
        { completedDays: 1, totalDays: 4 },
        { completedDays: 2, totalDays: 4 },
        { completedDays: 3, totalDays: 4 },
        { completedDays: 4, totalDays: 4 },
      ]);
    });

    it("進捗チャネル配線後も、phase1はrunBatchAnalysis/runAnalysisを一度も呼ばないこと(確定前LLM呼出ゼロの維持)", async () => {
      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();
      const handler = handlerFor(IPC_CHANNELS.collectPeriodBatch);

      await handler(fakeEvent, "20260710", "20260712", "central");

      expect(runBatchAnalysisMock).not.toHaveBeenCalled();
      expect(runAnalysisMock).not.toHaveBeenCalled();
    });
  });
});
