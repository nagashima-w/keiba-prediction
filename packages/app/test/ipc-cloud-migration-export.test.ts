/**
 * ipc.ts の「クラウド移行用に書き出す」ハンドラの結線テスト(Issue #215・#167-A AC3・AC4)。
 *
 * ipc-export-analysis.test.ts の流儀(electron と pipeline-deps をモックし、ipcMain.handle が捕捉した
 * ハンドラを直接呼ぶ)。書き出し元(cloudMigrationSource)は core の実物(インメモリの AnalysisStore)を使い、
 * 書かれたファイルを gunzip して core の検証関数で 1 行ずつ読む。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnalysisStore,
  MigrationTally,
  createCloudMigrationSource,
  parseMigrationLine,
  type CloudMigrationSource,
} from "@keiba/core";

import { IPC_CHANNELS } from "../src/shared/channels.js";
import type { CloudMigrationExportOutcome } from "../src/shared/analysis-types.js";

const { handleMock, showSaveDialogMock, fromWebContentsMock, createPipelineDepsMock, closeMock, ctx } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    showSaveDialogMock: vi.fn(),
    fromWebContentsMock: vi.fn(() => null),
    createPipelineDepsMock: vi.fn(),
    closeMock: vi.fn(),
    ctx: { userData: "" },
  }),
);

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3", getPath: () => ctx.userData },
  ipcMain: { handle: handleMock },
  dialog: { showSaveDialog: showSaveDialogMock },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
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

const fakeEvent = { sender: {} };
let tempDir: string;
let outDir: string;
let store: AnalysisStore;
/** createPipelineDeps が返す書き出し元。テストごとに差し替えられる。 */
let source: CloudMigrationSource;

function saveSomeData(s: AnalysisStore): void {
  const horse = { umaban: 1, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.5, ev: 1.1, isPositive: true, contributions: null, mark: null };
  s.saveAnalysis({ raceId: "202603020211", analyzedAt: "2026-03-02T01:00:00.000Z", horses: [horse, { ...horse, umaban: 2 }] });
  s.saveAnalysis({ raceId: "202603020212", analyzedAt: "2026-03-02T02:00:00.000Z", model: "claude-x", rawResponse: "応答\n二行目", horses: [horse] });
  s.saveResult("202603020211", [{ umaban: 1, finishPosition: 1, placePayout: 150 }], "芝", {
    wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 560 }] },
  });
}

async function registerAndGet(): Promise<(event: unknown) => Promise<CloudMigrationExportOutcome>> {
  const { registerIpcHandlers } = await import("../src/main/ipc.js");
  registerIpcHandlers();
  return handlerFor(IPC_CHANNELS.exportCloudMigration) as (event: unknown) => Promise<CloudMigrationExportOutcome>;
}

beforeEach(() => {
  vi.resetModules();
  handleMock.mockReset();
  showSaveDialogMock.mockReset();
  fromWebContentsMock.mockReset();
  fromWebContentsMock.mockReturnValue(null);
  createPipelineDepsMock.mockReset();
  closeMock.mockReset();
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-cloud-migration-"));
  outDir = path.join(tempDir, "out");
  ctx.userData = tempDir;
  store = new AnalysisStore();
  saveSomeData(store);
  source = createCloudMigrationSource(store.rawDatabase);
  createPipelineDepsMock.mockImplementation(() => ({
    deps: {},
    cloudMigrationSource: {
      readAnalysisPage: (a: number, l: number) => source.readAnalysisPage(a, l),
      readResultPage: (a: string, l: number) => source.readResultPage(a, l),
    },
    close: closeMock,
  }));
  mkdirSync(outDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("クラウド移行の書き出しハンドラ", () => {
  it("migration:export-cloud チャネルをハンドラ付きで登録する", async () => {
    await registerAndGet();
    expect(handleMock.mock.calls.map((c) => c[0])).toContain("migration:export-cloud");
    expect(IPC_CHANNELS.exportCloudMigration).toBe("migration:export-cloud");
  });

  it("ダイアログをキャンセルしたら何もしない(canceled・ファイルなし・DB も開かない)", async () => {
    const handler = await registerAndGet();
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });
    await expect(handler(fakeEvent)).resolves.toEqual({ status: "canceled" });
    expect(readdirSync(outDir)).toEqual([]);
    expect(createPipelineDepsMock).not.toHaveBeenCalled();
  });

  it("filePath が空でもキャンセル扱い", async () => {
    const handler = await registerAndGet();
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: "" });
    await expect(handler(fakeEvent)).resolves.toEqual({ status: "canceled" });
  });

  it("保存ダイアログの既定名は keiba-cloud-migration-YYYYMMDD.ndjson.gz、拡張子フィルタは gz", async () => {
    const handler = await registerAndGet();
    showSaveDialogMock.mockResolvedValue({ canceled: true });
    await handler(fakeEvent);
    const options = showSaveDialogMock.mock.calls[0]![0] as { defaultPath: string; filters: Array<{ extensions: string[] }> };
    expect(options.defaultPath).toMatch(/^keiba-cloud-migration-\d{8}\.ndjson\.gz$/);
    expect(options.filters[0]!.extensions).toEqual(["gz"]);
  });

  it("保存したら、件数・ファイルの大きさ・保存先を返し、書かれたファイルは形式どおりに読める", async () => {
    const handler = await registerAndGet();
    const target = path.join(outDir, "x.ndjson.gz");
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: target });
    const outcome = await handler(fakeEvent);
    expect(outcome).toMatchObject({ status: "saved", filePath: target, analysisCount: 2, resultRaceCount: 1 });
    if (outcome.status !== "saved") throw new Error("unreachable");
    expect(outcome.fileBytes).toBe(readFileSync(target).length);
    expect(readdirSync(outDir)).toEqual(["x.ndjson.gz"]);

    const text = gunzipSync(readFileSync(target)).toString("utf-8");
    const tally = new MigrationTally();
    const lines = text.slice(0, -1).split("\n").map((l) => parseMigrationLine(l));
    for (const l of lines) tally.accept(l);
    tally.assertComplete();
    expect(lines.map((l) => l.type)).toEqual(["header", "analysis", "analysis", "result", "footer"]);
    expect(lines[0]).toMatchObject({ format: "keiba-cloud-migration", version: 1, appVersion: "1.2.3" });
    const footer = lines[4]!;
    expect(footer).toMatchObject({ analysisLines: 2, resultLines: 1, counts: { analyses: 2, analysis_horses: 3, race_results: 1, race_combo_payouts: 1 } });
  });

  it("書き出しの失敗は renderer へ reject され(メッセージ保持)、保存先に途中のファイルを残さない", async () => {
    const handler = await registerAndGet();
    const target = path.join(outDir, "x.ndjson.gz");
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: target });
    let calls = 0;
    source = {
      readAnalysisPage: (a, l) => {
        calls += 1;
        if (calls === 1) return createCloudMigrationSource(store.rawDatabase).readAnalysisPage(a, l);
        throw new Error("読み出しに失敗しました");
      },
      readResultPage: () => [],
    };
    // 1 ページ目(最大 50 件)で 2 件を返したあと、2 ページ目で throw する。
    await expect(handler(fakeEvent)).rejects.toThrow("読み出しに失敗しました");
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("形式に合わない値は、どの表・どの列かを含むメッセージで失敗する", async () => {
    const handler = await registerAndGet();
    const target = path.join(outDir, "x.ndjson.gz");
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: target });
    store.rawDatabase.exec("UPDATE analysis_horses SET prior = 1e999 WHERE analysis_id = 1 AND umaban = 2");
    await expect(handler(fakeEvent)).rejects.toThrow(/analysis_horses \(analysis_id=1, umaban=2\).*prior/);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("書き出し中に別の書き出しを始めようとすると、2 つ目は reject される(1 つ目は影響を受けない)", async () => {
    const handler = await registerAndGet();
    const target = path.join(outDir, "x.ndjson.gz");
    let resolveDialog!: (v: { canceled: boolean; filePath: string }) => void;
    showSaveDialogMock.mockImplementationOnce(() => new Promise((r) => (resolveDialog = r)));
    const first = handler(fakeEvent);
    await expect(handler(fakeEvent)).rejects.toThrow("書き出し中");
    expect(showSaveDialogMock).toHaveBeenCalledTimes(1);
    resolveDialog({ canceled: false, filePath: target });
    await expect(first).resolves.toMatchObject({ status: "saved" });
    // 終わったあとは再び実行できる(フラグが戻っている)
    showSaveDialogMock.mockResolvedValue({ canceled: true });
    await expect(handler(fakeEvent)).resolves.toEqual({ status: "canceled" });
  });

  it("失敗したあとも再び実行できる(進行中フラグが戻る)", async () => {
    const handler = await registerAndGet();
    const target = path.join(outDir, "x.ndjson.gz");
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: target });
    const real = source;
    source = { readAnalysisPage: () => { throw new Error("一度だけ失敗"); }, readResultPage: () => [] };
    await expect(handler(fakeEvent)).rejects.toThrow("一度だけ失敗");
    source = real;
    await expect(handler(fakeEvent)).resolves.toMatchObject({ status: "saved" });
  });

  it("書き出し中に設定が保存されても、DB 接続(資源)は書き出しが終わるまで閉じられない", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.exportCloudMigration) as (e: unknown) => Promise<CloudMigrationExportOutcome>;
    const target = path.join(outDir, "x.ndjson.gz");
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: target });
    const real = source;
    let closeCallsDuringRead = -1;
    let pages = 0;
    source = {
      readAnalysisPage: (a, l) => {
        pages += 1;
        if (pages === 1) {
          // 書き出しの最中に設定を保存する(markDirty が走る)。
          void (handlerFor(IPC_CHANNELS.saveSettings) as (e: unknown, u: unknown) => Promise<unknown>)(fakeEvent, {});
        }
        closeCallsDuringRead = closeMock.mock.calls.length;
        return real.readAnalysisPage(a, l);
      },
      readResultPage: (a, l) => real.readResultPage(a, l),
    };
    await expect(handler(fakeEvent)).resolves.toMatchObject({ status: "saved" });
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(closeCallsDuringRead).toBe(0);
  });
});
