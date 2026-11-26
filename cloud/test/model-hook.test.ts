import { describe, expect, it } from "vitest";
import { createModelHook, MODEL_HOOK_TIMEOUT_MS } from "../src/model-hook";

/**
 * Issue #796: 別の Worker(service binding `MODEL`)への「計算を頼む口」。応答は見ない。失敗・例外・時間切れ・非 2xx は警告 1 行にして握る(投げない)。
 * 偽の Fetcher を差し込む。
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly hasSignal: boolean;
}

function fakeFetcher(handler: (req: Request) => Promise<Response> | Response): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = new Request(input as string, init);
      calls.push({ url: req.url, method: req.method, body: await req.clone().text(), hasSignal: init?.signal !== undefined && init.signal !== null });
      return handler(req);
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

describe("createModelHook", () => {
  it("Fetcher が無ければフックを作らない(何もしない)", () => {
    expect(createModelHook(undefined, () => undefined)).toBeUndefined();
  });

  it("card は POST /hook/card に race_id を送り、時間切れの信号を付ける", async () => {
    const { fetcher, calls } = fakeFetcher(() => new Response("{}", { status: 200 }));
    const hook = createModelHook(fetcher, () => undefined)!;
    await hook.card("202603020211");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/hook/card");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body)).toEqual({ race_id: "202603020211" });
    expect(calls[0]!.hasSignal).toBe(true);
  });

  it.each([5, 10] as const)("odds は POST /hook/odds に race_id と minutes_before=%i を送る", async (m) => {
    const { fetcher, calls } = fakeFetcher(() => new Response("{}", { status: 200 }));
    const hook = createModelHook(fetcher, () => undefined)!;
    await hook.odds("202603020211", m);
    expect(new URL(calls[0]!.url).pathname).toBe("/hook/odds");
    expect(JSON.parse(calls[0]!.body)).toEqual({ race_id: "202603020211", minutes_before: m });
  });

  it("成功のときは警告を出さない", async () => {
    const warns: string[] = [];
    const { fetcher } = fakeFetcher(() => new Response("{}", { status: 202 }));
    await createModelHook(fetcher, (m) => warns.push(m))!.card("202603020211");
    expect(warns).toEqual([]);
  });

  it("非 2xx は投げず、警告 1 行(レース ID と状態コードだけ。本文は出さない)", async () => {
    const warns: string[] = [];
    const { fetcher } = fakeFetcher(() => new Response("SECRET-BODY", { status: 500 }));
    await expect(createModelHook(fetcher, (m) => warns.push(m))!.card("202603020211")).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("202603020211");
    expect(warns[0]).toContain("500");
    expect(warns[0]).not.toContain("SECRET-BODY");
  });

  it("例外は投げず、警告 1 行(例外の文面は出さない)", async () => {
    const warns: string[] = [];
    const { fetcher } = fakeFetcher(() => {
      throw new Error("SECRET-ERROR");
    });
    await expect(createModelHook(fetcher, (m) => warns.push(m))!.odds("202603020211", 5)).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).not.toContain("SECRET-ERROR");
  });

  it("時間切れ(AbortSignal)でも投げず、警告 1 行", async () => {
    const warns: string[] = [];
    const { fetcher } = fakeFetcher(
      (req) => new Promise<Response>((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason))),
    );
    const hook = createModelHook(fetcher, (m) => warns.push(m), 20)!;
    await hook.card("202603020211");
    expect(warns).toHaveLength(1);
  });

  it("警告の出口が投げても、フックは投げない", async () => {
    const { fetcher } = fakeFetcher(() => new Response("", { status: 503 }));
    const hook = createModelHook(fetcher, () => {
      throw new Error("warn-failed");
    })!;
    await expect(hook.card("202603020211")).resolves.toBeUndefined();
  });

  it("race_id が 12 桁の数字でなければ送らない(警告 1 行)", async () => {
    const warns: string[] = [];
    const { fetcher, calls } = fakeFetcher(() => new Response("{}"));
    await createModelHook(fetcher, (m) => warns.push(m))!.card("abc");
    expect(calls).toHaveLength(0);
    expect(warns).toHaveLength(1);
  });

  it("地方のレースは送らない(警告も出さない。中央だけ)", async () => {
    const warns: string[] = [];
    const { fetcher, calls } = fakeFetcher(() => new Response("{}"));
    const hook = createModelHook(fetcher, (m) => warns.push(m))!;
    await hook.card("202644062911");
    await hook.odds("202644062911", 5);
    expect(calls).toHaveLength(0);
    expect(warns).toEqual([]);
  });

  it("中央の境界: 競馬場コード 10 は送り、11 は送らない", async () => {
    const { fetcher, calls } = fakeFetcher(() => new Response("{}"));
    const hook = createModelHook(fetcher, () => undefined)!;
    await hook.card("202610010101");
    await hook.card("202611010101");
    expect(calls.map((c) => JSON.parse(c.body).race_id)).toEqual(["202610010101"]);
  });

  it("時間切れの既定は 3 秒", () => {
    expect(MODEL_HOOK_TIMEOUT_MS).toBe(3000);
  });
});
