import { describe, expect, it } from "vitest";
import { HttpError } from "../../packages/core/src/index.js";
import { FetchHaltedError, HaltOnConsecutiveBlockFetcher } from "../probability-quality-41/guarded-fetcher.js";

/**
 * 取得の安全装置(`measurement-plan.md` §4): HTTP 400・403・429 が連続2回で取得を止める。
 * 止めた後はネットワークを叩かず即座に失敗させる(`scrapeRace` は馬ごとの戦績の例外を
 * 警告に握りつぶして次の馬へ進むため、フェッチャ側で止めないと残りの全馬へ要求が出てしまう)。
 */

/** 呼び出しごとに用意した結果(文字列=成功、数値=その HTTP ステータスで失敗、"net"=ネットワーク失敗)を返す。 */
function scripted(steps: ReadonlyArray<string | number | "net">) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    fetcher: {
      async fetchText(url: string): Promise<string> {
        calls.push(url);
        const step = steps[i++];
        if (step === undefined) {
          throw new Error("台本が尽きた");
        }
        if (typeof step === "string" && step !== "net") {
          return step;
        }
        if (step === "net") {
          throw new HttpError("network", { url });
        }
        throw new HttpError(`status ${step}`, { url, status: step });
      },
    },
  };
}

describe("HaltOnConsecutiveBlockFetcher", () => {
  it("400 が連続2回で止まり、3回目以降はネットワークを叩かず FetchHaltedError を投げる", async () => {
    const s = scripted([400, 400, "ok"]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    await expect(g.fetchText("u1")).rejects.toBeInstanceOf(HttpError);
    expect(g.tripped).toBe(false);
    await expect(g.fetchText("u2")).rejects.toBeInstanceOf(HttpError);
    expect(g.tripped).toBe(true);
    await expect(g.fetchText("u3")).rejects.toBeInstanceOf(FetchHaltedError);
    await expect(g.fetchText("u4")).rejects.toBeInstanceOf(FetchHaltedError);
    expect(s.calls).toEqual(["u1", "u2"]); // 3回目以降は内側へ届いていない
  });

  it("400 の後に成功すると連続回数が0に戻る(400→成功→400 では止まらない)", async () => {
    const s = scripted([400, "ok", 400, "ok"]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    await expect(g.fetchText("a")).rejects.toBeInstanceOf(HttpError);
    await expect(g.fetchText("b")).resolves.toBe("ok");
    await expect(g.fetchText("c")).rejects.toBeInstanceOf(HttpError);
    await expect(g.fetchText("d")).resolves.toBe("ok");
    expect(g.tripped).toBe(false);
    expect(g.consecutiveBlocked).toBe(0);
  });

  it("400 以外の失敗(500・ネットワーク)は数えない。成功が無い限り連続回数はそのまま", async () => {
    const s = scripted([400, 500, "net", 400]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    for (const url of ["a", "b", "c"]) {
      await expect(g.fetchText(url)).rejects.toBeInstanceOf(HttpError);
    }
    expect(g.consecutiveBlocked).toBe(1);
    expect(g.tripped).toBe(false);
    await expect(g.fetchText("d")).rejects.toBeInstanceOf(HttpError);
    expect(g.tripped).toBe(true); // 400 の間に400以外の失敗が挟まっても、成功が無ければ連続とみなす
  });

  it("元の例外はそのまま呼び出し側へ伝わる(400 でも握りつぶさない)", async () => {
    const s = scripted([400]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    await expect(g.fetchText("a")).rejects.toMatchObject({ status: 400 });
  });

  it("呼び出し回数と400を受けたURLを記録する", async () => {
    const s = scripted(["ok", 400, 400]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    await g.fetchText("a");
    await g.fetchText("b").catch(() => undefined);
    await g.fetchText("c").catch(() => undefined);
    await g.fetchText("d").catch(() => undefined); // 止まった後(カウントしない)
    expect(g.requestCount).toBe(3);
    expect(g.urlsBlocked).toEqual(["b", "c"]);
  });

  it("403 と 429 も 400 と同じくブロックの兆候として数える(403→429 の連続2回で止まる)", async () => {
    const s = scripted([403, 429, "ok"]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    await g.fetchText("a").catch(() => undefined);
    expect(g.tripped).toBe(false);
    await g.fetchText("b").catch(() => undefined);
    expect(g.tripped).toBe(true);
    await expect(g.fetchText("c")).rejects.toBeInstanceOf(FetchHaltedError);
    expect(s.calls).toEqual(["a", "b"]);
    expect(g.urlsBlocked).toEqual(["a", "b"]);
  });

  it("403 の後に成功すると連続回数が0に戻る", async () => {
    const s = scripted([403, "ok", 429]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    await g.fetchText("a").catch(() => undefined);
    await g.fetchText("b");
    await g.fetchText("c").catch(() => undefined);
    expect(g.tripped).toBe(false);
    expect(g.consecutiveBlocked).toBe(1);
  });

  it("404 や 500 はブロックの兆候として数えない", async () => {
    const s = scripted([404, 404, 500, 500]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher);
    for (const u of ["a", "b", "c", "d"]) {
      await g.fetchText(u).catch(() => undefined);
    }
    expect(g.tripped).toBe(false);
    expect(g.consecutiveBlocked).toBe(0);
  });

  it("上限は引数で変えられる(3回なら2回連続では止まらない)", async () => {
    const s = scripted([400, 400, 400]);
    const g = new HaltOnConsecutiveBlockFetcher(s.fetcher, 3);
    await g.fetchText("a").catch(() => undefined);
    await g.fetchText("b").catch(() => undefined);
    expect(g.tripped).toBe(false);
    await g.fetchText("c").catch(() => undefined);
    expect(g.tripped).toBe(true);
  });

  it("オプションは内側のフェッチャへそのまま渡す", async () => {
    const seen: unknown[] = [];
    const g = new HaltOnConsecutiveBlockFetcher({
      async fetchText(_url, options) {
        seen.push(options);
        return "ok";
      },
    });
    await g.fetchText("u", { bypassCache: true });
    expect(seen).toEqual([{ bypassCache: true }]);
  });
});
