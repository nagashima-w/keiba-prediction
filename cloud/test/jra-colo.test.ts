import { describe, expect, it } from "vitest";

import { ColoOfDay, COLO_TRACE_URL, fetchTraceColo } from "../src/jra-colo";

/**
 * Issue #804: 取得した Cloudflare の拠点(3 文字のコード)。`cdn-cgi/trace` を DO の中で 1 日 1 回だけ取り、「その日の最初の JRA の取得のときの拠点」として持つ。
 * 実際の Cloudflare には一切出ない(注入した偽の fetch)。
 */

const jst = (s: string): number => Date.parse(`${s}+09:00`);

describe("fetchTraceColo(投げない。形違い・失敗は null)", () => {
  const traceOf = (colo: string): Response => new Response(`fl=1\nip=1.2.3.4\ncolo=${colo}\nhttp=http/2\n`, { status: 200 });
  it("cdn-cgi/trace を GET し、colo= の 3 文字を返す。リダイレクトは追わない・タイムアウトの信号つき・ヘッダは足さない", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const colo = await fetchTraceColo(async (url, init) => {
      calls.push({ url, init });
      return traceOf("NRT");
    });
    expect(colo).toBe("NRT");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(COLO_TRACE_URL);
    expect(COLO_TRACE_URL).toBe("https://www.cloudflare.com/cdn-cgi/trace");
    expect(calls[0]!.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.headers).toBeUndefined();
  });
  it.each([
    ["形違い(小文字)", async () => traceOf("nrt")],
    ["HTTP 500", async () => new Response("colo=NRT", { status: 500 })],
    ["リダイレクト", async () => new Response(null, { status: 302, headers: { location: "https://x.invalid/" } })],
    ["例外", async () => Promise.reject(new Error("secret https://x.invalid"))],
    ["colo の行が無い", async () => new Response("fl=1\n", { status: 200 })],
  ])("%s は null", async (_n, fn) => {
    expect(await fetchTraceColo(fn)).toBeNull();
  });
  it("本文が大きすぎるとき(64KB 超)は読まずに null", async () => {
    expect(await fetchTraceColo(async () => new Response("a".repeat(70_000) + "\ncolo=NRT\n", { status: 200 }))).toBeNull();
  });
});

describe("ColoOfDay(1 日 1 回。日付つきで DO のメタに持つ)", () => {
  function setup(fetchColo: () => Promise<string | null>) {
    const meta = new Map<string, string>();
    const clock = { now: jst("2026-11-28T09:00:00") };
    let calls = 0;
    const colo = new ColoOfDay({
      metaGet: (k) => meta.get(k) ?? null,
      metaSet: (k, v) => void meta.set(k, v),
      now: () => clock.now,
      fetchColo: async () => {
        calls += 1;
        return fetchColo();
      },
    });
    return { colo, meta, clock, calls: () => calls };
  }
  it("取る前の get は null。ensure で取って、その日のうちは同じ値(取るのは 1 回)", async () => {
    const t = setup(async () => "NRT");
    expect(t.colo.get()).toBeNull();
    await t.colo.ensure();
    await t.colo.ensure();
    t.clock.now += 3 * 3_600_000;
    await t.colo.ensure();
    expect(t.calls()).toBe(1);
    expect(t.colo.get()).toBe("NRT");
  });
  it("isPending は同期で、取る前は true・取った後(取れなかった日も)は false。翌日になれば true", async () => {
    const t = setup(async () => null);
    expect(t.colo.isPending()).toBe(true);
    await t.colo.ensure();
    expect(t.colo.isPending()).toBe(false);
    t.clock.now = jst("2026-11-29T00:00:00");
    expect(t.colo.isPending()).toBe(true);
  });
  it("日(JST)が変わったら、もう一度取る。日が変わったあと ensure の前の get は前日の値を返さない", async () => {
    const t = setup(async () => (t.calls() === 1 ? "NRT" : "KIX"));
    await t.colo.ensure();
    t.clock.now = jst("2026-11-29T00:00:01");
    expect(t.colo.get()).toBeNull();
    await t.colo.ensure();
    expect(t.calls()).toBe(2);
    expect(t.colo.get()).toBe("KIX");
  });
  it("JST の日付の境界(23:59:59 と 00:00:00)", async () => {
    const t = setup(async () => "NRT");
    t.clock.now = jst("2026-11-28T23:59:59");
    await t.colo.ensure();
    t.clock.now = jst("2026-11-29T00:00:00");
    await t.colo.ensure();
    expect(t.calls()).toBe(2);
  });
  it("取れなかった(null)日も、その日は取り直さない(1 日 1 回まで)。get は null", async () => {
    const t = setup(async () => null);
    await t.colo.ensure();
    await t.colo.ensure();
    expect(t.calls()).toBe(1);
    expect(t.colo.get()).toBeNull();
  });
  it("取得の関数が投げても ensure は投げない(JRA の取得を止めない)。その日は取り直さない", async () => {
    const t = setup(async () => {
      throw new Error("boom");
    });
    await expect(t.colo.ensure()).resolves.toBeUndefined();
    await t.colo.ensure();
    expect(t.calls()).toBe(1);
    expect(t.colo.get()).toBeNull();
  });
  it("同時に ensure を呼んでも、取るのは 1 回", async () => {
    const t = setup(async () => "NRT");
    await Promise.all([t.colo.ensure(), t.colo.ensure(), t.colo.ensure()]);
    expect(t.calls()).toBe(1);
  });
  it("DO の再起動(メタが残る)の後も、同じ日は取り直さない。メタに外の文字列が入っていても、3 文字の大文字でなければ get は null", async () => {
    const t = setup(async () => "NRT");
    await t.colo.ensure();
    const again = new ColoOfDay({ metaGet: (k) => t.meta.get(k) ?? null, metaSet: (k, v) => void t.meta.set(k, v), now: () => t.clock.now, fetchColo: async () => "KIX" });
    await again.ensure();
    expect(again.get()).toBe("NRT");
    t.meta.set("colo", 'NR"');
    expect(again.get()).toBeNull();
  });
});
