/**
 * ipc.ts の「分析データのエクスポート」ハンドラの結線テスト(第一版・GitHub Issue#10)。
 *
 * ipc-log-export.test.ts(dialog.showSaveDialog→writeFileSync、キャンセル時canceled)と
 * ipc-verify-report-venue.test.ts(pipeline-deps全体をモックし、resourcesの特定メソッドの
 * 呼び出し・戻り値だけを検証する)の両方の流儀を組み合わせる。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { AnalysisExportOutcome } from "../src/shared/analysis-types.js";
import type { AnalysisExportSource } from "../src/main/analysis-export.js";

const {
  handleMock,
  showSaveDialogMock,
  fromWebContentsMock,
  createPipelineDepsMock,
  deriveCsvPathOverride,
  ctx,
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  fromWebContentsMock: vi.fn(() => null),
  createPipelineDepsMock: vi.fn(),
  // code-reviewer指摘対応(パス衝突ガード)テスト専用: deriveCsvPathFromJsonPathを
  // 一時的に差し替え、ipc.ts側の防御ガード(csvPath===jsonPathならエラーで書き込まない)を
  // 単体で踏めるようにする。通常は null のまま(=実装をそのまま使う)。
  deriveCsvPathOverride: { fn: null as ((jsonPath: string) => string) | null },
  ctx: { userData: "" },
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.2.3",
    getPath: () => ctx.userData,
  },
  ipcMain: { handle: handleMock },
  dialog: { showSaveDialog: showSaveDialogMock },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
}));

vi.mock("../src/main/pipeline-deps.js", () => ({
  createPipelineDeps: createPipelineDepsMock,
}));

vi.mock("../src/main/analysis-export.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/analysis-export.js")>();
  return {
    ...actual,
    deriveCsvPathFromJsonPath: (jsonPath: string) =>
      deriveCsvPathOverride.fn !== null
        ? deriveCsvPathOverride.fn(jsonPath)
        : actual.deriveCsvPathFromJsonPath(jsonPath),
  };
});

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`ハンドラ未登録: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

const fakeEvent = { sender: {} };
let tempDir: string;
let getAnalysisExportInputMock: ReturnType<typeof vi.fn>;

/** テスト用の最小 AnalysisExportSource(analysis-export.ts の入力材料)を作る。 */
function makeSource(overrides: Partial<AnalysisExportSource> = {}): AnalysisExportSource {
  return {
    analysis: {
      id: 42,
      raceId: "202605020811",
      analyzedAt: "2026-07-24T09:05:00.000Z",
      evEstimated: false,
      promptVersion: "v1",
      additionalInstruction: null,
      kaisaiDate: "20260724",
      model: "claude-sonnet-4-6",
      rawResponse: "raw",
      raceSnapshot: { race: { raceName: "テストS" }, horses: [] },
      horses: [
        {
          umaban: 1,
          prior: 0.4,
          adjustedProb: 0.45,
          placeOddsMin: 1.2,
          ev: 0.9,
          isPositive: false,
          contributions: null,
          mark: "◎",
          reason: "調教良化",
        },
      ],
    },
    venueName: "東京",
    results: undefined,
    resultDetail: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  showSaveDialogMock.mockReset();
  fromWebContentsMock.mockReset();
  fromWebContentsMock.mockReturnValue(null);
  createPipelineDepsMock.mockReset();
  deriveCsvPathOverride.fn = null;
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-export-analysis-"));
  ctx.userData = tempDir;

  getAnalysisExportInputMock = vi.fn(() => makeSource());
  createPipelineDepsMock.mockImplementation(() => ({
    deps: {},
    listRaces: vi.fn(async () => []),
    listNarRaces: vi.fn(async () => []),
    importResult: vi.fn(async () => ({})),
    listUnimportedRaceIds: vi.fn(() => []),
    listAnalyzedRaceIdsByPromptVersion: vi.fn(() => []),
    getVerifyReport: vi.fn(() => ({ includedAnalysisCount: 0 })),
    getVerifyReportByPromptVersion: vi.fn(() => []),
    deleteUnknownPromptVersionAnalyses: vi.fn(() => ({ deletedCount: 0 })),
    getRaceLedger: vi.fn(() => []),
    getAnalysisExportInput: getAnalysisExportInputMock,
    close: vi.fn(),
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("analysis:export ハンドラ(分析データのエクスポート・第一版)", () => {
  it("analysis:export チャネルをハンドラ付きで登録する", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    expect(handleMock).toHaveBeenCalledWith(
      IPC_CHANNELS.exportAnalysis,
      expect.any(Function),
    );
  });

  it("対象レースの分析が見つからなければ例外を投げること(getAnalysisExportInputがnull)", async () => {
    getAnalysisExportInputMock.mockReturnValue(null);
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await expect(
      handlerFor(IPC_CHANNELS.exportAnalysis)(fakeEvent, "202605020811"),
    ).rejects.toThrow();
  });

  it("保存先ダイアログで選んだ場所へschemaVersion=1のJSONと、拡張子を置き換えたCSVの両方を書き込み、jsonPath/csvPathを返すこと", async () => {
    const jsonPath = path.join(tempDir, "analysis.json");
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: jsonPath });

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcome = (await handlerFor(IPC_CHANNELS.exportAnalysis)(
      fakeEvent,
      "202605020811",
    )) as AnalysisExportOutcome;

    const expectedCsvPath = path.join(tempDir, "analysis.csv");
    expect(outcome).toEqual({
      status: "saved",
      jsonPath,
      csvPath: expectedCsvPath,
    });

    const jsonContent = readFileSync(jsonPath, "utf8");
    expect(jsonContent).toContain('"schemaVersion": 1');
    const parsed = JSON.parse(jsonContent) as { meta: { toolVersion: string } };
    // app.getVersion()のモック値("1.2.3")がツール版としてそのまま載ること。
    expect(parsed.meta.toolVersion).toBe("1.2.3");

    const csvContent = readFileSync(expectedCsvPath, "utf8");
    expect(csvContent).toContain("umaban");
    expect(csvContent).toContain("調教良化");
  });

  it("保存先ダイアログをキャンセルしたら何も書き込まずcanceledを返すこと", async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    const outcome = (await handlerFor(IPC_CHANNELS.exportAnalysis)(
      fakeEvent,
      "202605020811",
    )) as AnalysisExportOutcome;

    expect(outcome).toEqual({ status: "canceled" });
  });

  it("既定のファイル名(defaultPath)にレースIDと当日日付(YYYYMMDD)を含めてダイアログを呼ぶこと", async () => {
    vi.setSystemTime(new Date(2026, 6, 16));
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await handlerFor(IPC_CHANNELS.exportAnalysis)(fakeEvent, "202605020811");

    expect(showSaveDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "keiba-ev-tool-analysis-202605020811-20260716.json",
      }),
    );
    vi.useRealTimers();
  });

  it("getAnalysisExportInputに検証済みのRaceId(パース後)を渡すこと", async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();

    await handlerFor(IPC_CHANNELS.exportAnalysis)(fakeEvent, "202605020811");

    expect(getAnalysisExportInputMock).toHaveBeenCalledWith("202605020811");
  });

  describe("JSON/CSV保存先パス衝突の防止(code-reviewer指摘対応: サイレントなデータ消失防止)", () => {
    it("実装(修正後のderiveCsvPathFromJsonPath)では、JSON保存先に.csv拡張子を指定してもcsvPathが別パスになり、両ファイルとも正しい内容で保存されること(データ消失なし)", async () => {
      // ユーザーが保存ダイアログでわざわざ.csv拡張子のファイル名を選んだケース。
      const jsonPath = path.join(tempDir, "analysis.csv");
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: jsonPath });

      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();

      const outcome = (await handlerFor(IPC_CHANNELS.exportAnalysis)(
        fakeEvent,
        "202605020811",
      )) as AnalysisExportOutcome;

      // 実装のderiveCsvPathFromJsonPathは.csv拡張子を置き換えないため、衝突せず別パスになる。
      const expectedCsvPath = path.join(tempDir, "analysis.csv.csv");
      expect(outcome).toEqual({
        status: "saved",
        jsonPath,
        csvPath: expectedCsvPath,
      });
      // jsonPath側は上書きされず、JSON内容(schemaVersion:1)のまま残っていること。
      expect(readFileSync(jsonPath, "utf8")).toContain('"schemaVersion": 1');
      // csvPath側にはCSVヘッダが書かれていること。
      expect(readFileSync(expectedCsvPath, "utf8")).toContain("umaban");
    });

    it("防御ガード: 万一csvPathがjsonPathと一致してしまう場合(deriveCsvPathFromJsonPathの異常値を模擬)、書き込まずerrorを返しJSONを上書き消失させないこと", async () => {
      const jsonPath = path.join(tempDir, "analysis.json");
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: jsonPath });
      // deriveCsvPathFromJsonPathがjsonPathをそのまま返す異常値を模擬(衝突ガード自体の単体検証)。
      deriveCsvPathOverride.fn = (p) => p;

      const { registerIpcHandlers } = await import("../src/main/ipc.js");
      registerIpcHandlers();

      const outcome = (await handlerFor(IPC_CHANNELS.exportAnalysis)(
        fakeEvent,
        "202605020811",
      )) as AnalysisExportOutcome;

      expect(outcome.status).toBe("error");
      // JSON/CSVいずれのファイルも書き込まれていない(消失も誤書き込みも起きない)こと。
      expect(existsSync(jsonPath)).toBe(false);
    });
  });
});
