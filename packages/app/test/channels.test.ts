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
});
