import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import { DEFAULT_APP_SETTINGS } from "../src/main/settings-store.js";
import type { SettingsUpdate } from "../src/shared/settings.js";

/**
 * ipc.ts が設定画面の配分5項目(shared/settings.ts の AppSettings.bankroll ほか)を
 * createPipelineDeps へ実際に渡していること、および単日一括分析
 * (handleRunBatchAnalysis)と期間バッチ(handleRunPeriodBatchAnalysis)が
 * createPipelineDeps が返した**同一の**deps オブジェクトを runAnalysis の第3引数に渡していることを
 * 固定するテスト(Issue #59・#56-3・AC1)。
 *
 * `ipc-combo-odds-wiring.test.ts` と同じ流儀: createPipelineDeps 自体はモックし、渡された
 * config だけを観測する(実IO・実LLM呼び出しは行わない)。deps オブジェクト同一性の検証には
 * runAnalysis(analysis-pipeline.js)もモックし、呼び出しごとに受け取った deps 引数を記録する。
 */

const {
  handleMock,
  createPipelineDepsMock,
  runAnalysisMock,
  ctx,
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createPipelineDepsMock: vi.fn(),
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

vi.mock("../src/main/analysis-pipeline.js", () => ({
  runAnalysis: runAnalysisMock,
}));

const fakeEvent = { sender: { send: vi.fn() } };

/** 登録済みハンドラを取得する。 */
function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`ハンドラ未登録: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

/** 有効な設定更新ペイロード(配分5項目・includeComboOdds以外は固定値)を組み立てる。 */
function makeUpdate(overrides: Partial<SettingsUpdate> = {}): SettingsUpdate {
  return {
    discordWebhookUrl: "",
    evThreshold: 1,
    biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
    baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
    autoSendDiscord: false,
    additionalInstruction: "",
    clipVariant: "default",
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: false,
    ...overrides,
  };
}

let tempDir: string;

/** deps を識別できる目印(オブジェクト同一性の判定に使う)。 */
let depsMarkerCounter = 0;

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  createPipelineDepsMock.mockReset();
  runAnalysisMock.mockReset();
  depsMarkerCounter = 0;
  createPipelineDepsMock.mockImplementation((config: { allocationSettings?: unknown }) => {
    depsMarkerCounter += 1;
    return {
      deps: { __marker: depsMarkerCounter, allocationSettings: config.allocationSettings ?? null },
      listRaces: vi.fn(async () => []),
      listNarRaces: vi.fn(async () => []),
      importResult: vi.fn(async () => ({ kind: "取込成功" })),
      listUnimportedRaceIds: vi.fn(() => []),
      listAnalyzedRaceIdsByPromptVersion: vi.fn(() => []),
      getVerifyReport: vi.fn(() => ({})),
      getVerifyReportByPromptVersion: vi.fn(() => []),
      deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
      getRaceLedger: vi.fn(() => []),
      getAnalysisExportInput: vi.fn(() => null),
      close: vi.fn(),
    };
  });
  runAnalysisMock.mockImplementation(async () => ({
    raceId: "202605020811",
    venueName: "テスト",
    raceName: "テスト特別",
    courseType: "芝",
    distance: 1600,
    date: "2026/07/09",
    dateApproximate: false,
    llmUsed: false,
    llmSkippedReason: "APIキー未設定",
    fallback: false,
    fallbackReason: null,
    marksDropped: false,
    marksDroppedReason: null,
    oddsStatus: "result",
    rows: [],
    warnings: [],
    analyzedAt: "2026-07-09T00:00:00.000Z",
  }));
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-allocation-wiring-"));
  ctx.userData = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ipc: 配分提案の設定5項目をcreatePipelineDepsへ配線する(Issue #59・AC1)", () => {
  it("設定の配分5項目 + includeComboOdds が createPipelineDeps の config.allocationSettings へ届くこと(includeComboOdds=true)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const saveHandler = handlerFor(IPC_CHANNELS.saveSettings);
    const verifyHandler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await saveHandler(fakeEvent, makeUpdate({ includeComboOdds: true }));
    verifyHandler(fakeEvent);

    const lastCall =
      createPipelineDepsMock.mock.calls[createPipelineDepsMock.mock.calls.length - 1]!;
    const config = lastCall[0] as {
      allocationSettings?: unknown;
      includeComboOdds?: unknown;
    };
    expect(config.allocationSettings).toEqual({
      bankroll: 300000,
      perRaceCap: 20000,
      kellyFraction: 0.5,
      includeWideInAllocation: true,
      includeTrioInAllocation: false,
    });
    // includeComboOddsはallocationSettingsに含めない(既存フィールドが単一ソース。#59 4節)。
    expect(config.includeComboOdds).toBe(true);
  });

  it("設定の配分5項目 + includeComboOdds が createPipelineDeps の config.allocationSettings へ届くこと(includeComboOdds=false)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const saveHandler = handlerFor(IPC_CHANNELS.saveSettings);
    const verifyHandler = handlerFor(IPC_CHANNELS.getVerifyReport);

    await saveHandler(
      fakeEvent,
      makeUpdate({ includeComboOdds: false, bankroll: 50000, kellyFraction: 0.3 }),
    );
    verifyHandler(fakeEvent);

    const lastCall =
      createPipelineDepsMock.mock.calls[createPipelineDepsMock.mock.calls.length - 1]!;
    const config = lastCall[0] as {
      allocationSettings?: unknown;
      includeComboOdds?: unknown;
    };
    expect(config.allocationSettings).toEqual({
      bankroll: 50000,
      perRaceCap: 20000,
      kellyFraction: 0.3,
      includeWideInAllocation: true,
      includeTrioInAllocation: false,
    });
    expect(config.includeComboOdds).toBe(false);
  });

  it("handleRunBatchAnalysisとhandleRunPeriodBatchAnalysisが、createPipelineDepsが返した同一のdepsオブジェクトをrunAnalysisの第3引数に渡すこと(オブジェクト同一性)", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const runBatchHandler = handlerFor(IPC_CHANNELS.runBatchAnalysis);
    const runPeriodBatchHandler = handlerFor(IPC_CHANNELS.runPeriodBatchAnalysis);

    await runBatchHandler(fakeEvent, ["202605020811"], "20260709");
    await runPeriodBatchHandler(fakeEvent, [
      { raceId: "202605020811", kaisaiDate: "20260709" },
    ]);

    // 前提固定: runAnalysisが両ハンドラからそれぞれ1回ずつ、計2回呼ばれていること(空振り防止)。
    expect(runAnalysisMock).toHaveBeenCalledTimes(2);
    const depsFromBatch = runAnalysisMock.mock.calls[0]![2];
    const depsFromPeriodBatch = runAnalysisMock.mock.calls[1]![2];
    expect(depsFromBatch).toBeDefined();
    expect(depsFromBatch).toBe(depsFromPeriodBatch);
    // createPipelineDepsが1回しか呼ばれていない(resourceManagerのキャッシュにより
    // 2ハンドラで再構築されていない)ことも合わせて固定する。
    expect(createPipelineDepsMock).toHaveBeenCalledTimes(1);
  });
});
