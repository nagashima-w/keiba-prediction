import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createJraOddsFetcher, createJraPacer, fetchJraRaceOdds, type JraOddsSession } from "../src/jra-odds-fetch";
import { JRA_GAP_MS, JRA_ODDS_MAX_BODY_BYTES, type JraFetchLike } from "../src/jra-http";
import { parseRaceCname, parseRaceListPage } from "../src/jra-entries-parse";
import { parseJraOddsRaceListPage } from "../../packages/core/src/scraper/parse-jra-odds-index";
import { parseJraWinPlaceOdds } from "../../packages/core/src/scraper/parse-jra-odds";

/**
 * Issue #673 段階 A: JRA のオッズの取得口。偽の fetch が見本のページ(Shift_JIS のバイト列)を返す。**実際の JRA には出ない**。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name)));
const decode = (name: string): string => new TextDecoder("shift_jis").decode(bytes(name));

const OLI = bytes("jra_odds_oli_20261108.html");
const ORL = bytes("jra_odds_orl_tokyo_20261108.html");
const TANPUKU = bytes("jra_odds_tanpuku_202605050208.html");
const PARAM_ERROR = bytes("jra_639_param_error.html");

const TOKYO_ORL = "pw15orl00052026050220261108/AA";
const R8_TANPUKU = "pw151ouS305202605020820261108Z/A9";
const R8_SANRENTAN = "pw158ouS305202605020820261108Z/45";

interface Call {
  url: string;
  method: string;
  body: string | null;
  redirect: string | undefined;
  headerNames: string[];
}

function harness(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const fetchFn: JraFetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      redirect: init.redirect,
      headerNames: Object.keys((init.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase()),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  const fetcher = createJraOddsFetcher({ fetch: fetchFn, wait: async (ms) => void waits.push(ms) });
  return { calls, waits, session: (): JraOddsSession => fetcher.open() };
}

const html = (data: Uint8Array, status = 200): Response => new Response(data, { status, headers: { "content-type": "text/html" } });

/** 本文の cname から、見本の頁を返す偽の JRA。 */
function fakeJra(call: Call): Response {
  if (call.body === "cname=pw15oli00/6D") return html(OLI);
  if (call.body === `cname=${TOKYO_ORL}`) return html(ORL);
  if (call.body?.startsWith("cname=pw151ou")) return html(TANPUKU);
  return new Response("x", { status: 404 });
}

describe("開催の選択 → レースの選択 → オッズの頁(取得口の本)", () => {
  it("開催の選択は POST accessO.html(本文 cname=pw15oli00/6D)。指定の日の場を返し、リダイレクトは追わず、ヘッダは付けない", async () => {
    const h = harness(fakeJra);
    const r = await h.session().listVenues("20261108");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ url: "https://www.jra.go.jp/JRADB/accessO.html", method: "POST", body: "cname=pw15oli00/6D", redirect: "manual" });
    expect(h.calls[0]!.headerNames).toEqual(["content-type"]);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.map((v) => v.venueCode)).toEqual(["03", "05", "08"]);
  });

  it("レースの選択は POST(本文 cname=<orl>)。12 レースを返す", async () => {
    const h = harness(fakeJra);
    const r = await h.session().listRaces({ venueCode: "05", year: "2026", kai: "05", day: "02", date: "20261108", racesCname: TOKYO_ORL });
    expect(h.calls[0]).toMatchObject({ method: "POST", body: `cname=${TOKYO_ORL}` });
    expect(r.status === "ok" && r.value).toHaveLength(12);
  });

  it("オッズの頁は POST(本文 cname=<odds>)。Shift_JIS をデコードした文字列が、そのままパーサで読める", async () => {
    const h = harness(fakeJra);
    const r = await h.session().fetchOdds(R8_TANPUKU);
    expect(h.calls[0]).toMatchObject({ method: "POST", body: `cname=${R8_TANPUKU}` });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const parsed = parseJraWinPlaceOdds(r.value, "2026-11-08");
    expect(parsed.state).toBe("available");
    expect(r.value).toBe(decode("jra_odds_tanpuku_202605050208.html"));
  });

  it("形の違う cname・日付は何も送らず shape-mismatch(JRA の入口で検査値を作らない)", async () => {
    const h = harness(fakeJra);
    const s = h.session();
    expect(await s.fetchOdds("pw151opS305202605020820261108Z/A9")).toEqual({ status: "shape-mismatch" });
    expect(await s.fetchOdds("pw151ouS3052026050208&evil=1/A9")).toEqual({ status: "shape-mismatch" });
    expect(await s.listVenues("2026-11-08")).toEqual({ status: "shape-mismatch" });
    expect(await s.listRaces({ venueCode: "05", year: "2026", kai: "05", day: "02", date: "20261108", racesCname: "pw15orl00052026050220261108/AA&x=1" })).toEqual({ status: "shape-mismatch" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("失敗の分類(例外は投げない。文面・URL・本文は残さない)", () => {
  it.each([
    ["404", () => html(new Uint8Array([1]), 404), "http-404"],
    ["500", () => html(new Uint8Array([1]), 500), "http-500"],
    ["リダイレクト", () => new Response(null, { status: 302, headers: { location: "https://x.invalid/" } }), "redirect"],
    ["パラメータエラー", () => html(PARAM_ERROR), "param-error"],
  ] as const)("%s は %s", async (_n, respond, expected) => {
    const h = harness(respond);
    expect(await h.session().fetchOdds(R8_TANPUKU)).toEqual({ status: expected });
  });

  it("fetch が例外を投げても、分類名だけを返す(メッセージ・URL を含めない)", async () => {
    const fetcher = createJraOddsFetcher({
      fetch: async () => {
        throw new Error("secret https://www.jra.go.jp/x");
      },
      wait: async () => undefined,
    });
    const r = await fetcher.open().fetchOdds(R8_TANPUKU);
    expect(r).toEqual({ status: "network" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("開催選択に入口のリンクが無い頁は shape-mismatch。指定の日の場が無いだけなら ok の空", async () => {
    const empty = harness(() => html(new TextEncoder().encode("<html><title>x</title></html>")));
    expect(await empty.session().listVenues("20261108")).toEqual({ status: "shape-mismatch" });
    const h = harness(fakeJra);
    expect(await h.session().listVenues("20261109")).toEqual({ status: "ok", value: [] });
  });

  it("レース選択にそのレースの式別が揃わなければ shape-mismatch", async () => {
    const h = harness(() => html(OLI));
    const r = await h.session().listRaces({ venueCode: "05", year: "2026", kai: "05", day: "02", date: "20261108", racesCname: TOKYO_ORL });
    expect(r).toEqual({ status: "shape-mismatch" });
  });
});

describe("本文の上限", () => {
  it("上限は 2MiB。三連単の見本(約 509KB)は通り、上限を超える宣言(content-length)は too-large で読まない", async () => {
    expect(JRA_ODDS_MAX_BODY_BYTES).toBe(2 * 1024 * 1024);
    const ok = harness(() => html(bytes("jra_odds_sanrentan_202605050208.html")));
    const r = await ok.session().fetchOdds(R8_SANRENTAN);
    expect(r.status).toBe("ok");
    const big = harness(() => new Response(new Uint8Array(10), { status: 200, headers: { "content-length": String(JRA_ODDS_MAX_BODY_BYTES + 1) } }));
    expect(await big.session().fetchOdds(R8_SANRENTAN)).toEqual({ status: "too-large" });
  });

  it("content-length が無くても、読んだ合計が上限を超えたら too-large", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(JRA_ODDS_MAX_BODY_BYTES));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    });
    const h = harness(() => new Response(stream, { status: 200 }));
    expect(await h.session().fetchOdds(R8_SANRENTAN)).toEqual({ status: "too-large" });
  });
});

describe("本の間隔(1.5 秒。最初の 1 本の前は待たない)", () => {
  it("1 つの session で 3 本送ると、2 本目・3 本目の前に 1500ms ずつ待つ", async () => {
    const h = harness(fakeJra);
    const s = h.session();
    await s.listVenues("20261108");
    await s.fetchOdds(R8_TANPUKU);
    await s.fetchOdds(R8_TANPUKU);
    expect(h.calls).toHaveLength(3);
    expect(s.requestCount).toBe(3);
    expect(h.waits).toEqual([JRA_GAP_MS, JRA_GAP_MS]);
  });
});

describe("共有の間隔(段をまたぐ。createJraPacer)", () => {
  it("同じ pacer を共有する 2 つの session は、直前の送信から 1500ms 未満なら残りを待つ。ずっと前なら待たない", async () => {
    let t = 10_000;
    const waits: number[] = [];
    const pacer = createJraPacer({
      now: () => t,
      wait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    const fetchFn: JraFetchLike = async () => html(OLI);
    const fetcher = createJraOddsFetcher({ fetch: fetchFn, pacer });
    await fetcher.open().listVenues("20261108"); // 初回: 待たない
    t += 400;
    await fetcher.open().listVenues("20261108"); // 別の session でも、400ms しか経っていないので 1100ms 待つ
    t += 5_000;
    await fetcher.open().listVenues("20261108"); // 十分に経った: 待たない
    expect(waits).toEqual([JRA_GAP_MS - 400]);
  });

  it("pacer を渡さなければ session ごとに独立(別の session の最初の 1 本は待たない)", async () => {
    const h = harness(fakeJra);
    await h.session().listVenues("20261108");
    await h.session().listVenues("20261108");
    expect(h.waits).toEqual([]);
  });
});

describe("fetchJraRaceOdds(1 レースぶんの式別の頁。cname の拾い方と param-error の再たどり)", () => {
  it("links が無ければ、開催選択 → レース選択をたどって、指定の式別の頁だけを取る(本数 = 2 + 頁数)", async () => {
    const h = harness(fakeJra);
    const s = h.session();
    const r = await fetchJraRaceOdds(s, { date: "20261108", raceId: "202605050208", pages: ["tanpuku"] });
    expect(h.calls.map((c) => c.body)).toEqual(["cname=pw15oli00/6D", `cname=${TOKYO_ORL}`, `cname=${R8_TANPUKU}`]);
    expect(r.links?.raceId).toBe("202605050208");
    expect(r.rediscovered).toBe(false);
    expect(r.pages.tanpuku?.status).toBe("ok");
    expect(Object.keys(r.pages)).toEqual(["tanpuku"]);
  });

  it("links を渡せば発見の 2 本を飛ばし、頁の本数だけ送る", async () => {
    const h = harness(fakeJra);
    const links = parseJraOddsRaceListPage(decode("jra_odds_orl_tokyo_20261108.html"), "20261108", "05").find((l) => l.raceId === "202605050208")!;
    const r = await fetchJraRaceOdds(h.session(), { date: "20261108", raceId: "202605050208", pages: ["tanpuku", "tanpuku"], links });
    expect(h.calls).toHaveLength(1); // 重複した頁は 1 本にまとめる
    expect(r.pages.tanpuku?.status).toBe("ok");
  });

  it("頁が param-error なら、発見からたどり直して 1 回だけ取り直す(たどり直しの本数 2 + 取り直し 1)", async () => {
    let tanpukuCalls = 0;
    const h = harness((call) => {
      if (call.body?.startsWith("cname=pw151ou")) {
        tanpukuCalls += 1;
        return tanpukuCalls === 1 ? html(PARAM_ERROR) : html(TANPUKU);
      }
      return fakeJra(call);
    });
    const links = parseJraOddsRaceListPage(decode("jra_odds_orl_tokyo_20261108.html"), "20261108", "05").find((l) => l.raceId === "202605050208")!;
    const r = await fetchJraRaceOdds(h.session(), { date: "20261108", raceId: "202605050208", pages: ["tanpuku"], links });
    expect(h.calls.map((c) => c.body)).toEqual([`cname=${R8_TANPUKU}`, "cname=pw15oli00/6D", `cname=${TOKYO_ORL}`, `cname=${R8_TANPUKU}`]);
    expect(r.rediscovered).toBe(true);
    expect(r.pages.tanpuku?.status).toBe("ok");
  });

  it("取り直しでも param-error なら、それ以上は撃たない(たどり直しは 1 回だけ)", async () => {
    const h = harness((call) => (/^cname=pw15\dou/.test(call.body ?? "") ? html(PARAM_ERROR) : fakeJra(call)));
    const r = await fetchJraRaceOdds(h.session(), { date: "20261108", raceId: "202605050208", pages: ["tanpuku", "sanrentan"] });
    // 発見 2 + 単勝・複勝(param-error)+ たどり直し 2 + 単勝・複勝(param-error)+ 三連単(param-error)。再発見は 2 回目を行わない
    expect(h.calls.filter((c) => c.body === "cname=pw15oli00/6D")).toHaveLength(2);
    expect(r.rediscovered).toBe(true);
    expect(r.pages.tanpuku).toEqual({ status: "param-error" });
    expect(r.pages.sanrentan).toEqual({ status: "param-error" });
  });

  it("その日・その場にレースが無ければ、すべての頁が not-found(頁は 1 本も送らない)", async () => {
    const h = harness(fakeJra);
    const r = await fetchJraRaceOdds(h.session(), { date: "20261109", raceId: "202605050208", pages: ["tanpuku", "wide"] });
    expect(r.links).toBeNull();
    expect(r.pages).toEqual({ tanpuku: { status: "not-found" }, wide: { status: "not-found" } });
    expect(h.calls).toHaveLength(1);
  });

  it("開催選択の失敗はその語を全頁に返す。ある頁の失敗はほかの頁を止めない", async () => {
    const h1 = harness(() => html(new Uint8Array([1]), 503));
    const r1 = await fetchJraRaceOdds(h1.session(), { date: "20261108", raceId: "202605050208", pages: ["tanpuku", "wide"] });
    expect(r1.pages).toEqual({ tanpuku: { status: "http-503" }, wide: { status: "http-503" } });
    const h2 = harness((call) => (call.body?.startsWith("cname=pw151ou") ? html(new Uint8Array([1]), 500) : call.body?.startsWith("cname=pw155ou") ? html(TANPUKU) : fakeJra(call)));
    const r2 = await fetchJraRaceOdds(h2.session(), { date: "20261108", raceId: "202605050208", pages: ["tanpuku", "wide"] });
    expect(r2.pages.tanpuku).toEqual({ status: "http-500" });
    expect(r2.pages.wide?.status).toBe("ok");
  });

  it("race_id の形が違えば何も送らず shape-mismatch", async () => {
    const h = harness(fakeJra);
    const r = await fetchJraRaceOdds(h.session(), { date: "20261108", raceId: "2026", pages: ["tanpuku"] });
    expect(r.pages).toEqual({ tanpuku: { status: "shape-mismatch" } });
    expect(h.calls).toHaveLength(0);
  });
});

describe("race_id の組み立ての照合(出馬表の別の入口と、全レース)", () => {
  const orl = decode("jra_odds_orl_tokyo_20261108.html");
  const odds = parseJraOddsRaceListPage(orl, "20261108", "05");

  it("東京 12R: オッズ側の race_id が、出馬表(accessD)のレース選択の 12 レースから parseRaceCname で作った race_id と、順序も含めて一致する", () => {
    const drl = decode("jra_639_drl_tokyo_20261108.html");
    const entries = parseRaceListPage(drl, "20261108", "05").map((c) => parseRaceCname(c)!.raceId);
    expect(entries).toHaveLength(12);
    expect(odds.map((o) => o.raceId)).toEqual(entries);
  });

  it("開催選択の 3 場(福島 03・東京 05・京都 08): 場・年・回・日が、出馬表(accessD)の開催選択から読んだ値と一致する", async () => {
    const dli = decode("jra_639_dli00_top_20261106.html");
    const fromEntries = [...dli.matchAll(/pw01drl00(\d{2})(\d{4})(\d{2})(\d{2})20261108\/[0-9A-F]{2}/g)].map((m) => `${m[2]}${m[1]}${m[3]}${m[4]}`).sort();
    expect(fromEntries).toEqual(["2026030302", "2026050502", "2026080502"]);
    const h = harness(fakeJra);
    const r = await h.session().listVenues("20261108");
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.map((v) => `${v.year}${v.venueCode}${v.kai}${v.day}`).sort()).toEqual(fromEntries);
  });
});
