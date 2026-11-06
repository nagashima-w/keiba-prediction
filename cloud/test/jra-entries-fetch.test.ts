import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createJraEntriesFetcher, type JraEntriesSession } from "../src/jra-entries-fetch";
import { JRA_GAP_MS, type JraFetchLike } from "../src/jra-http";

/**
 * Issue #639: JRA の出馬表の取得口。1 起床 = 1 つの session(本の間隔は 1.5 秒以上。最初の 1 本の前は待たない)。
 * 偽の fetch が見本のページを返す。**実際の JRA には出ない**。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name)));

const DLI = bytes("jra_639_dli00_top_20261106.html");
const DRL = bytes("jra_639_drl_tokyo_20261108.html");
const DDE = bytes("jra_639_dde_tokyo11R_20261108.html");
const DDE_02R = bytes("jra_639_dde_tokyo02R_20261107.html");
const PARAM_ERROR = bytes("jra_639_param_error.html");

const DRL_CNAME = "pw01drl00052026050220261108/30";
const DDE_CNAME = "pw01dde0105202605021120261108/65";

interface Call {
  url: string;
  method: string;
  body: string | null;
  redirect: string | undefined;
  hasHeaders: string[];
}

function harness(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const fetchFn: JraFetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      redirect: init.redirect,
      hasHeaders: Object.keys((init.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase()),
    };
    calls.push(call);
    return respond(call);
  };
  const fetcher = createJraEntriesFetcher({ fetch: fetchFn, wait: async (ms) => void waits.push(ms) });
  return { calls, waits, session: (): JraEntriesSession => fetcher.open() };
}

const html = (data: Uint8Array, status = 200): Response => new Response(data, { status, headers: { "content-type": "text/html" } });

describe("開催の選択 → レースの選択 → 詳細(取得口の 3 種の本)", () => {
  it("開催の選択は POST accessD.html(本文 cname=pw01dli00/F3)・指定の日の場を返す", async () => {
    const h = harness(() => html(DLI));
    const r = await h.session().listVenues("20261108");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ url: "https://www.jra.go.jp/JRADB/accessD.html", method: "POST", body: "cname=pw01dli00/F3", redirect: "manual" });
    expect(r).toEqual({
      status: "ok",
      value: [
        { venueCode: "03", drlCname: "pw01drl00032026030220261108/3A" },
        { venueCode: "05", drlCname: DRL_CNAME },
        { venueCode: "08", drlCname: "pw01drl00082026050220261108/0E" },
      ],
    });
  });
  it("レースの選択は POST(本文 cname=<drl>)・12 レースの詳細の CNAME を返す", async () => {
    const h = harness(() => html(DRL));
    const r = await h.session().listRaces(DRL_CNAME, "20261108", "05");
    expect(h.calls[0]).toMatchObject({ method: "POST", body: `cname=${DRL_CNAME}`, url: "https://www.jra.go.jp/JRADB/accessD.html" });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value).toHaveLength(12);
    }
  });
  it("詳細は GET accessD.html?CNAME=<dde>・18 頭を読む。本文は 25 万バイト(馬場の既定の上限 256KB の手前)でも読める", async () => {
    expect(DDE.byteLength).toBeGreaterThan(240_000);
    const h = harness(() => html(DDE));
    const r = await h.session().fetchRace(DDE_CNAME);
    expect(h.calls[0]).toMatchObject({ method: "GET", url: `https://www.jra.go.jp/JRADB/accessD.html?CNAME=${DDE_CNAME}`, body: null });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.race.raceId).toBe("202605050211");
      expect(r.value.horses).toHaveLength(18);
      expect(r.value.skipped).toBe(0);
    }
  });
  it("詳細ページだけ上限が広い: 256KB を超える詳細ページ(想定を超えた大きさ)も読め、開催の選択・レースの選択は 256KB で too-large", async () => {
    const pad = (data: Uint8Array, extra: number): Uint8Array => {
      const filler = new TextEncoder().encode(`<!-- ${"x".repeat(extra)} -->`);
      const out = new Uint8Array(data.byteLength + filler.byteLength);
      out.set(data);
      out.set(filler, data.byteLength);
      return out;
    };
    const bigDetail = pad(DDE, 300_000 - DDE.byteLength); // 約 300KB
    expect(bigDetail.byteLength).toBeGreaterThan(256 * 1024);
    const r = await harness(() => html(bigDetail)).session().fetchRace(DDE_CNAME);
    expect(r.status).toBe("ok");
    const bigList = pad(DLI, 300_000 - DLI.byteLength);
    expect(bigList.byteLength).toBeGreaterThan(256 * 1024);
    expect(await harness(() => html(bigList)).session().listVenues("20261108")).toEqual({ status: "too-large" });
    expect(await harness(() => html(pad(DRL, 300_000 - DRL.byteLength))).session().listRaces(DRL_CNAME, "20261108", "05")).toEqual({ status: "too-large" });
  });
  it("UA などのヘッダは付けない(素の fetch)", async () => {
    const h = harness((c) => (c.method === "POST" ? html(DLI) : html(DDE)));
    const s = h.session();
    await s.listVenues("20261108");
    await s.fetchRace(DDE_CNAME);
    expect(h.calls.map((c) => c.hasHeaders)).toEqual([["content-type"], []]);
  });
});

describe("本の間隔", () => {
  it("最初の 1 本の前は待たず、2 本目以降は 1.5 秒待つ(session ごとに数える)", async () => {
    const h = harness(() => html(DRL));
    const s = h.session();
    await s.listRaces(DRL_CNAME, "20261108", "05");
    expect(h.waits).toEqual([]);
    await s.listRaces(DRL_CNAME, "20261108", "05");
    await s.listRaces(DRL_CNAME, "20261108", "05");
    expect(h.waits).toEqual([JRA_GAP_MS, JRA_GAP_MS]);
    expect(JRA_GAP_MS).toBe(1500);
    const s2 = h.session();
    await s2.listRaces(DRL_CNAME, "20261108", "05");
    expect(h.waits).toHaveLength(2);
  });
  it("失敗した本の後も間隔は守る", async () => {
    const h = harness(() => html(new Uint8Array(0), 500));
    const s = h.session();
    await s.fetchRace(DDE_CNAME);
    await s.fetchRace(DDE_CNAME);
    expect(h.waits).toEqual([JRA_GAP_MS]);
    expect(s.requestCount).toBe(2);
  });
});

describe("失敗の分類(固定の語だけ)", () => {
  it("HTTP 200 のパラメータエラーのページは param-error(3 種の本のどれでも)", async () => {
    const h = harness(() => html(PARAM_ERROR));
    const s = h.session();
    expect(await s.listVenues("20261108")).toEqual({ status: "param-error" });
    expect(await s.listRaces(DRL_CNAME, "20261108", "05")).toEqual({ status: "param-error" });
    expect(await s.fetchRace(DDE_CNAME)).toEqual({ status: "param-error" });
  });
  it("HTTP 500・404 は http-<状態>、リダイレクトは redirect、ネットワーク例外は network、タイムアウトは timeout", async () => {
    expect(await harness(() => html(DDE, 503)).session().fetchRace(DDE_CNAME)).toEqual({ status: "http-503" });
    expect(await harness(() => html(DDE, 404)).session().fetchRace(DDE_CNAME)).toEqual({ status: "http-404" });
    expect(await harness(() => new Response(null, { status: 302, headers: { location: "https://example.invalid/" } })).session().fetchRace(DDE_CNAME)).toEqual({ status: "redirect" });
    expect(
      await harness(() => {
        throw new TypeError("fetch failed: secret-url-should-not-leak");
      })
        .session()
        .fetchRace(DDE_CNAME),
    ).toEqual({ status: "network" });
    expect(
      await harness(() => {
        throw new DOMException("x", "TimeoutError");
      })
        .session()
        .fetchRace(DDE_CNAME),
    ).toEqual({ status: "timeout" });
  });
  it("1MB を超える本文は too-large", async () => {
    const big = new Uint8Array(1024 * 1024 + 10).fill(0x61);
    expect(await harness(() => html(big)).session().fetchRace(DDE_CNAME)).toEqual({ status: "too-large" });
  });
  it("別のレースのページは race-mismatch、読めない形は shape-mismatch", async () => {
    expect(await harness(() => html(DDE_02R)).session().fetchRace(DDE_CNAME)).toEqual({ status: "race-mismatch" });
    expect(await harness(() => html(new TextEncoder().encode("<html><body>x</body></html>"))).session().fetchRace(DDE_CNAME)).toEqual({ status: "shape-mismatch" });
    expect(await harness(() => html(new TextEncoder().encode("<html></html>"))).session().listVenues("20261108")).toEqual({ status: "shape-mismatch" });
    expect(await harness(() => html(new TextEncoder().encode("<html></html>"))).session().listRaces(DRL_CNAME, "20261108", "05")).toEqual({ status: "shape-mismatch" });
  });
  it("開催の選択に指定の日の場が無ければ、ok の空(ページ自体は読めた)", async () => {
    const r = await harness(() => html(DLI)).session().listVenues("20261109");
    expect(r).toEqual({ status: "ok", value: [] });
  });
  it("CNAME の形が違うもの(レースの CNAME でない)は、JRA に出ずに shape-mismatch", async () => {
    const h = harness(() => html(DDE));
    expect(await h.session().fetchRace("pw01dde0105202605021120261108")).toEqual({ status: "shape-mismatch" });
    expect(await h.session().fetchRace("../../etc/passwd")).toEqual({ status: "shape-mismatch" });
    expect(h.calls).toHaveLength(0);
  });
  it("drl の CNAME・日付の形が違うものも、JRA に出ない", async () => {
    const h = harness(() => html(DRL));
    expect(await h.session().listRaces("evil&x=1", "20261108", "05")).toEqual({ status: "shape-mismatch" });
    expect(await h.session().listRaces(DRL_CNAME, "2026-11-08", "05")).toEqual({ status: "shape-mismatch" });
    expect(await h.session().listVenues("not-a-date")).toEqual({ status: "shape-mismatch" });
    expect(h.calls).toHaveLength(0);
  });
});
