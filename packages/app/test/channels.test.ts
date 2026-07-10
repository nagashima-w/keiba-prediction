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

  it("Phase4で追加したチャネル(レース一覧・分析実行・進捗)が定義されている", () => {
    expect(IPC_CHANNELS.listRaces).toBe("race:list");
    expect(IPC_CHANNELS.runAnalysis).toBe("analysis:run");
    expect(IPC_CHANNELS.analysisProgress).toBe("analysis:progress");
  });

  it("設定画面用のチャネル(取得・保存・初期化)が定義されている", () => {
    expect(IPC_CHANNELS.getSettings).toBe("settings:get");
    expect(IPC_CHANNELS.saveSettings).toBe("settings:save");
    expect(IPC_CHANNELS.resetSettings).toBe("settings:reset");
  });

  it("Phase5で追加したDiscord通知チャネルが定義されている", () => {
    expect(IPC_CHANNELS.sendDiscord).toBe("notify:discord");
  });
});
