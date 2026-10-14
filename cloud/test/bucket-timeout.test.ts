import { afterEach, describe, expect, it, vi } from "vitest";
import { withPutTimeout } from "../src/bucket-timeout";

/**
 * Issue #178(#164-c)・#175 の申し送り: R2 の put には上限時間が無い(再試行するのは例外が出たときだけ)。呼び出し側(DO)で上限時間を設ける。
 * 上限を超えた put は例外にし(ストアが再試行し、それでも駄目なら detail: failed で要約だけを残す)、get はそのまま通す。
 */
afterEach(() => {
  vi.useRealTimers();
});

function bucket(put: () => Promise<unknown>, get: () => Promise<unknown> = async () => null) {
  return { put, get } as never;
}

describe("withPutTimeout", () => {
  it("上限内に終わった put は、その結果をそのまま返す", async () => {
    const wrapped = withPutTimeout(bucket(async () => ({ key: "k" })), 1000);
    await expect(wrapped.put("k", new Uint8Array([1]))).resolves.toEqual({ key: "k" });
  });

  it("上限を超えた put は、上限の時刻に例外で終わる(待ち続けない)", async () => {
    vi.useFakeTimers();
    const wrapped = withPutTimeout(bucket(() => new Promise(() => {})), 15_000);
    const result = wrapped.put("k", new Uint8Array([1])).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // 上限の1ms前はまだ待っている
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatch(/タイムアウト|15000/);
  });

  it("put が例外で終わったら、その例外をそのまま伝える。get は包まずに通す(get に上限は掛けない)", async () => {
    const wrapped = withPutTimeout(
      bucket(
        async () => {
          throw new Error("R2 の失敗");
        },
        async () => "object",
      ),
      1000,
    );
    await expect(wrapped.put("k", new Uint8Array([1]))).rejects.toThrow("R2 の失敗");
    await expect(wrapped.get("k")).resolves.toBe("object");
  });

  it("上限内に終わったら、タイマーを残さない(終わった put の後に、遅れて例外が出ない)", async () => {
    vi.useFakeTimers();
    const wrapped = withPutTimeout(bucket(async () => "ok"), 1000);
    await expect(wrapped.put("k", new Uint8Array([1]))).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("上限は正の整数(ミリ秒)。0 以下・小数・非有限は拒否する", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withPutTimeout(bucket(async () => null), bad)).toThrow(RangeError);
    }
  });
});
