import { describe, expect, it } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";

describe("IPCチャネル定義", () => {
  it("すべてのチャネル名は一意である", () => {
    const values = Object.values(IPC_CHANNELS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("すべてのチャネル名は名前空間プレフィックス(コロン区切り)を持つ", () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).toMatch(/^[a-z]+:[a-z-]+$/);
    }
  });

  it("レース一覧チャネルが定義されている", () => {
    expect(IPC_CHANNELS.listRaces).toBe("race:list");
  });

  it("設定画面用のチャネル(取得・保存・初期化)が定義されている", () => {
    expect(IPC_CHANNELS.getSettings).toBe("settings:get");
    expect(IPC_CHANNELS.saveSettings).toBe("settings:save");
    expect(IPC_CHANNELS.resetSettings).toBe("settings:reset");
  });

  it("一括分析用のチャネル(実行・中断・全体進捗)が定義されている", () => {
    expect(IPC_CHANNELS.runBatchAnalysis).toBe("analysis:run-batch");
    expect(IPC_CHANNELS.cancelBatchAnalysis).toBe("analysis:cancel-batch");
    expect(IPC_CHANNELS.batchProgress).toBe("analysis:batch-progress");
  });

  it("一括サマリのDiscord送信チャネルが定義されている", () => {
    expect(IPC_CHANNELS.sendBatchDiscord).toBe("notify:discord-batch");
  });

  it("結果の一括取込用のチャネル(実行・中断・全体進捗)が定義されている(Task#31)", () => {
    expect(IPC_CHANNELS.runBulkImport).toBe("result:run-bulk-import");
    expect(IPC_CHANNELS.cancelBulkImport).toBe("result:cancel-bulk-import");
    expect(IPC_CHANNELS.bulkImportProgress).toBe("result:bulk-import-progress");
  });

  it("rendererのエラーをmain側のログファイルへ集約するチャネルが定義されている(Task#35)", () => {
    expect(IPC_CHANNELS.logRendererError).toBe("log:renderer-error");
  });

  it("ログフォルダを開く・ログエクスポート用のチャネルが定義されている(Task#36)", () => {
    expect(IPC_CHANNELS.openLogFolder).toBe("log:open-folder");
    expect(IPC_CHANNELS.exportLogs).toBe("log:export");
  });

  it("レース単位の統合リスト取得チャネルが定義されている(検証画面UI統合。旧getRaceBreakdown+listAnalysesの置換)", () => {
    expect(IPC_CHANNELS.getRaceLedger).toBe("verify:race-ledger");
  });
});
