import { describe, expect, it } from "vitest";
import { handleSubrequestProbe, parseProbeCount, runSubrequestProbe } from "../../spikes/cloudflare/src/socket-matrix-handlers.js";

/**
 * #162 段階1: Worker から DO を繰り返し呼んで、subrequest の数え方を見る試験(netkeiba へは出ない)の処理
 * (`spikes/cloudflare/src/socket-matrix-handlers.ts`)。DO の呼び出しを注入できるので、実際の DO・実ネットワークには出ない。
 */

const ok = (): Promise<Response> => Promise.resolve(new Response("ok", { status: 200 }));

describe("parseProbeCount(?n=)", () => {
  it.each([
    [null, 60],
    ["60", 60],
    ["51", 51],
    ["1", 1],
    ["100", 100],
  ])("%j → %j", (value, expected) => {
    expect(parseProbeCount(value)).toBe(expected);
  });

  it.each([["0"], ["-1"], ["101"], ["1.5"], ["abc"], [""], ["1e2"], [" 5"]])("%j は不正(null)", (value) => {
    expect(parseProbeCount(value)).toBeNull();
  });
});

describe("runSubrequestProbe", () => {
  it("すべて成功したら、要求した回数だけ呼び、失敗なしの結果を返す", async () => {
    let calls = 0;
    const r = await runSubrequestProbe(async () => {
      calls += 1;
      return ok();
    }, 60);
    expect(calls).toBe(60);
    expect(r).toEqual({ ran: true, requested: 60, attempted: 60, succeeded: 60, firstFailureAt: null, errorKind: null, error: null, httpStatus: null });
  });

  it("呼び出しが 51 回目で例外を投げたら、そこで止め(それ以降は呼ばない)、通番・種類・メッセージを残す", async () => {
    let calls = 0;
    const r = await runSubrequestProbe(async () => {
      calls += 1;
      if (calls === 51) {
        throw new Error("Too many subrequests by single Worker invocation.");
      }
      return ok();
    }, 60);
    expect(calls).toBe(51);
    expect(r).toMatchObject({ ran: true, requested: 60, attempted: 51, succeeded: 50, firstFailureAt: 51, errorKind: "subrequest-limit" });
    expect(r.error).toMatch(/Too many subrequests/);
  });

  it("CPU 上限のメッセージは cpu-limit に分類する", async () => {
    const r = await runSubrequestProbe(async () => {
      throw new Error("Worker exceeded CPU time limit.");
    }, 5);
    expect(r).toMatchObject({ attempted: 1, succeeded: 0, firstFailureAt: 1, errorKind: "cpu-limit" });
  });

  it("DO が非 2xx を返したら、失敗として扱い、HTTP ステータスを残す(subrequest の上限とは決めつけない)", async () => {
    let calls = 0;
    const r = await runSubrequestProbe(async () => {
      calls += 1;
      return calls < 4 ? ok() : new Response("err", { status: 500 });
    }, 10);
    expect(r).toMatchObject({ attempted: 4, succeeded: 3, firstFailureAt: 4, errorKind: "other", httpStatus: 500 });
    expect(r.error).toMatch(/500/);
  });

  it("呼び出しは直列(前の呼び出しが終わってから次を呼ぶ)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runSubrequestProbe(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return ok();
    }, 5);
    expect(maxInFlight).toBe(1);
  });
});

describe("handleSubrequestProbe(POST /subrequest-probe)", () => {
  const post = (query = ""): Request => new Request(`https://worker.invalid/subrequest-probe${query}`, { method: "POST" });

  it("既定は 60 回。{ok, result} を返す", async () => {
    let calls = 0;
    const res = await handleSubrequestProbe(post(), async () => {
      calls += 1;
      return ok();
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(60);
    const json = (await res.json()) as { ok: boolean; result: { requested: number; succeeded: number } };
    expect(json.ok).toBe(true);
    expect(json.result).toMatchObject({ requested: 60, succeeded: 60 });
  });

  it("?n= で回数を変えられる", async () => {
    let calls = 0;
    await handleSubrequestProbe(post("?n=7"), async () => {
      calls += 1;
      return ok();
    });
    expect(calls).toBe(7);
  });

  it("不正な n は 400 で、DO は1回も呼ばれない", async () => {
    let calls = 0;
    const res = await handleSubrequestProbe(post("?n=1000"), async () => {
      calls += 1;
      return ok();
    });
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("試験の中で失敗しても Worker の応答は 200(失敗は結果として運ぶ)", async () => {
    const res = await handleSubrequestProbe(post("?n=3"), async () => {
      throw new Error("Too many subrequests");
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { firstFailureAt: number } }).result.firstFailureAt).toBe(1);
  });
});
