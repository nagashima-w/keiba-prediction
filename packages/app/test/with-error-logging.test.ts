/**
 * main/with-error-logging.ts のテスト。Task#35。
 *
 * IPCハンドラ境界で例外を捕捉し、操作名・コンテキスト付きでログしてから再送出する薄いラッパー。
 * main/logger.js をこのファイル内でモックし、実electron-logへは一切触れずに
 * 「成功時はログを呼ばずそのまま返す」「失敗時はlogErrorを呼んでから同じ例外を再送出する」を固定する。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { logErrorMock } = vi.hoisted(() => ({ logErrorMock: vi.fn() }));

vi.mock("../src/main/logger.js", () => ({
  logError: logErrorMock,
}));

beforeEach(() => {
  logErrorMock.mockReset();
});

describe("withErrorLogging(IPCハンドラ境界のエラーログ付きラッパー)", () => {
  it("成功時はlogErrorを呼ばず、fnの戻り値をそのまま返す", async () => {
    const { withErrorLogging } = await import("../src/main/with-error-logging.js");
    const result = await withErrorLogging("verify:report", undefined, async () => "ok");
    expect(result).toBe("ok");
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("失敗時はlogErrorへ操作名・コンテキスト・元の例外を渡してから、同じ例外を再送出する", async () => {
    const { withErrorLogging } = await import("../src/main/with-error-logging.js");
    const original = new Error("DB接続エラー");

    await expect(
      withErrorLogging("result:import", { raceId: "202601010101" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(logErrorMock).toHaveBeenCalledWith("result:import", original, {
      raceId: "202601010101",
    });
  });

  it("同期関数(Promiseを返さない fn)でも失敗を捕捉してログする", async () => {
    const { withErrorLogging } = await import("../src/main/with-error-logging.js");
    const original = new Error("同期エラー");
    await expect(
      withErrorLogging("settings:save", undefined, () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(logErrorMock).toHaveBeenCalledWith("settings:save", original, undefined);
  });
});
