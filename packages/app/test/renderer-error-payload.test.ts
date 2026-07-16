/**
 * renderer/renderer-error-payload.ts のテスト。Task#35 code-reviewer指摘(要修正3-a)対応。
 *
 * App.tsx の複数のcatch節(一括取込・一括分析の全体失敗)で重複していたエラーペイロード組み立て
 * ロジックを純関数として切り出したもの。Error インスタンス・非Errorの値それぞれから
 * 正しいペイロード({operation, message, stack})が組み立てられることを確認する。
 */

import { describe, expect, it } from "vitest";

import { buildRendererErrorPayload } from "../src/renderer/renderer-error-payload.js";

describe("buildRendererErrorPayload(rendererエラーペイロードの組み立て)", () => {
  it("Errorインスタンスからoperation・message・stackを組み立てる", () => {
    const error = new Error("一括分析に失敗しました");
    const payload = buildRendererErrorPayload("renderer:batch-analysis", error);
    expect(payload.operation).toBe("renderer:batch-analysis");
    expect(payload.message).toBe("一括分析に失敗しました");
    expect(payload.stack).toEqual(expect.stringContaining("Error: 一括分析に失敗しました"));
  });

  it("Errorインスタンスでもstackが無ければnullにする", () => {
    const error = new Error("失敗");
    error.stack = undefined;
    const payload = buildRendererErrorPayload("renderer:bulk-import", error);
    expect(payload.stack).toBeNull();
  });

  it("非Errorの値(文字列)はString化してmessageに使い、stackはnullにする", () => {
    const payload = buildRendererErrorPayload("renderer:bulk-import", "予期しない文字列エラー");
    expect(payload.operation).toBe("renderer:bulk-import");
    expect(payload.message).toBe("予期しない文字列エラー");
    expect(payload.stack).toBeNull();
  });

  it("非Errorの値(オブジェクト)もString化してmessageに使う", () => {
    const payload = buildRendererErrorPayload("renderer:window-error", { code: 500 });
    expect(payload.operation).toBe("renderer:window-error");
    expect(payload.message).toBe(String({ code: 500 }));
    expect(payload.stack).toBeNull();
  });
});
