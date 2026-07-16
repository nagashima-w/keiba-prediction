/**
 * renderer/global-error-handlers.ts のテスト。Task#35 code-reviewer指摘(要修正3-b)対応。
 *
 * window.onerror / window.onunhandledrejection から渡される情報を受け取り、
 * logRendererError相当のペイロードを組み立てて logFn に渡すロジックを純粋寄りの関数として切り出したもの。
 * main.tsx(vitest対象外の.tsx)は本ファイルの関数を呼ぶだけの薄い配線にとどめ、
 * ロジック本体はここで直接テストする。
 */

import { describe, expect, it, vi } from "vitest";

import {
  handleUnhandledRejection,
  handleWindowError,
} from "../src/renderer/global-error-handlers.js";

describe("handleWindowError(window.onerror相当のハンドラ)", () => {
  it("message・filename・lineno・colnoからoperation=renderer:window-errorのペイロードを組み立ててlogFnへ渡す", async () => {
    const logFn = vi.fn().mockResolvedValue(undefined);
    handleWindowError(
      { message: "予期しないエラー", filename: "App.tsx", lineno: 12, colno: 3 },
      logFn,
    );
    expect(logFn).toHaveBeenCalledTimes(1);
    const payload = logFn.mock.calls[0]![0];
    expect(payload.operation).toBe("renderer:window-error");
    expect(payload.message).toContain("予期しないエラー");
    expect(payload.message).toContain("App.tsx");
    expect(payload.stack).toBeNull();
  });

  it("event.errorがErrorインスタンスであればstackを含める", async () => {
    const logFn = vi.fn().mockResolvedValue(undefined);
    const error = new Error("本体の例外");
    handleWindowError({ message: "予期しないエラー", error }, logFn);
    const payload = logFn.mock.calls[0]![0];
    expect(payload.stack).toEqual(expect.stringContaining("Error: 本体の例外"));
  });

  it("filenameが無ければメッセージに位置情報を付記しない", async () => {
    const logFn = vi.fn().mockResolvedValue(undefined);
    handleWindowError({ message: "シンプルなエラー" }, logFn);
    const payload = logFn.mock.calls[0]![0];
    expect(payload.message).toBe("シンプルなエラー");
  });

  it("logFnが失敗しても例外を外へ漏らさない(ログ起因でさらに壊さない)", async () => {
    const logFn = vi.fn().mockRejectedValue(new Error("ログ送信に失敗"));
    expect(() => handleWindowError({ message: "エラー" }, logFn)).not.toThrow();
    await vi.waitFor(() => {
      expect(logFn).toHaveBeenCalledTimes(1);
    });
  });
});

describe("handleUnhandledRejection(window.onunhandledrejection相当のハンドラ)", () => {
  it("reasonがErrorインスタンスならoperation=renderer:unhandled-rejectionでmessage・stackを組み立てる", async () => {
    const logFn = vi.fn().mockResolvedValue(undefined);
    const reason = new Error("未処理のPromise拒否");
    handleUnhandledRejection(reason, logFn);
    expect(logFn).toHaveBeenCalledTimes(1);
    const payload = logFn.mock.calls[0]![0];
    expect(payload.operation).toBe("renderer:unhandled-rejection");
    expect(payload.message).toBe("未処理のPromise拒否");
    expect(payload.stack).toEqual(expect.stringContaining("Error: 未処理のPromise拒否"));
  });

  it("reasonが非Error(文字列)ならString化してmessageに使い、stackはnullにする", async () => {
    const logFn = vi.fn().mockResolvedValue(undefined);
    handleUnhandledRejection("reject理由の文字列", logFn);
    const payload = logFn.mock.calls[0]![0];
    expect(payload.operation).toBe("renderer:unhandled-rejection");
    expect(payload.message).toBe("reject理由の文字列");
    expect(payload.stack).toBeNull();
  });

  it("logFnが失敗しても例外を外へ漏らさない", async () => {
    const logFn = vi.fn().mockRejectedValue(new Error("ログ送信に失敗"));
    expect(() => handleUnhandledRejection(new Error("失敗"), logFn)).not.toThrow();
    await vi.waitFor(() => {
      expect(logFn).toHaveBeenCalledTimes(1);
    });
  });
});
