import { describe, expect, it, vi } from "vitest";

import { JRA_GAP_MS, JRA_MAX_BODY_BYTES, JRA_TIMEOUT_MS, type JraFetchLike } from "../src/jra-http";
import { createJraBabaFetcher } from "../src/jra-baba-fetch";

import { installFetchTrap } from "./fetch-trap";
import { FIXTURE_NAMES, NOW_MONDAY, NOW_SUNDAY, accessJson, coursePage, cushionHtml, fixtureBytes, fixtureText, moistHtml, sjis } from "./jra-baba-samples";

/**
 * Issue #478(#477-B): JRA のページから馬場の値を取る流れ(createJraBabaFetcher)。
 * **実サイトには一切出ない**: すべて注入した偽の fetch と偽の待ちで確かめる(グローバルの `fetch` は呼ばれたら落ちるスタブ。待ちも実時間を使わない)。
 * 応答は調査(#477)で実際に取ったフィクスチャの生のバイト(Shift_JIS)。
 */

installFetchTrap();

const BASE = "https://www.jra.go.jp";
const URLS = {
  cushion: `${BASE}/keiba/baba/_data_cushion.html`,
  moist: `${BASE}/keiba/baba/_data_moist.html`,
  access: `${BASE}/JRADB/accessJ.html`,
  index1: `${BASE}/keiba/baba/index.html`,
  index2: `${BASE}/keiba/baba/index2.html`,
  index3: `${BASE}/keiba/baba/index3.html`,
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

type Responder = (call: Call) => Promise<Response> | Response;
type Routes = Partial<Record<keyof typeof URLS, Responder>>;

const html = (bytes: Uint8Array): Response => new Response(bytes, { status: 200, headers: { "content-type": "text/html" } });

/** 実物のフィクスチャで 6 本すべてに答える既定の経路。 */
function realRoutes(): Record<keyof typeof URLS, Responder> {
  return {
    cushion: () => html(fixtureBytes(FIXTURE_NAMES.cushion)),
    moist: () => html(fixtureBytes(FIXTURE_NAMES.moist)),
    access: () => new Response(fixtureBytes(FIXTURE_NAMES.access), { status: 200, headers: { "content-type": "application/json" } }),
    index1: () => html(fixtureBytes(FIXTURE_NAMES.index1)),
    index2: () => html(fixtureBytes(FIXTURE_NAMES.index2)),
    index3: () => html(fixtureBytes(FIXTURE_NAMES.index3)),
  };
}

interface Harness {
  readonly fetch: JraFetchLike;
  readonly wait: (ms: number) => Promise<void>;
  /** 順序つきの出来事(`GET <path>`・`POST <path>`・`wait <ms>`)。path は `https://www.jra.go.jp` を除いたもの。 */
  readonly events: string[];
  readonly calls: Call[];
  readonly waits: number[];
}

function harness(overrides: Routes = {}): Harness {
  const routes = { ...realRoutes(), ...overrides };
  const byUrl = new Map(Object.entries(URLS).map(([key, url]) => [url, key as keyof typeof URLS]));
  const events: string[] = [];
  const calls: Call[] = [];
  const waits: number[] = [];
  return {
    events,
    calls,
    waits,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      events.push(`${init.method ?? "GET"} ${url.replace(BASE, "")}`);
      const key = byUrl.get(url);
      if (key === undefined) {
        throw new Error(`想定外の URL: ${url}`);
      }
      return routes[key](call);
    },
    wait: async (ms) => {
      waits.push(ms);
      events.push(`wait ${ms}`);
    },
  };
}

const GET_ORDER = ["GET /keiba/baba/_data_cushion.html", "GET /keiba/baba/_data_moist.html", "POST /JRADB/accessJ.html", "GET /keiba/baba/index.html", "GET /keiba/baba/index2.html", "GET /keiba/baba/index3.html"];

describe("正常: 実物の 3 場", () => {
  it("クッション値 → 含水率 → 開催情報(POST) → コース(index・index2・index3)の順に 1 本ずつ、間に待ちを入れて取る(計 6 本・待ち 5 回)", async () => {
    const h = harness();
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    const expected: string[] = [];
    GET_ORDER.forEach((e, i) => {
      if (i > 0) expected.push(`wait ${JRA_GAP_MS}`);
      expected.push(e);
    });
    expect(h.events).toEqual(expected);
    expect(h.calls).toHaveLength(6);
    expect(h.waits).toHaveLength(5);
    expect(outcome.result).toBe("ok");
    expect(outcome.venues.map((v) => [v.venueCode, v.venueName, v.cushion])).toEqual([
      ["05", "東京", 9.5],
      ["08", "京都", 9.2],
      ["04", "新潟", 8.8],
    ]);
    expect(outcome.dropped).toBe(0);
  });

  it("各 URL は 1 回ずつ(再試行しない)。開催情報だけが POST で、本文は CNAME=pw01iwtS3/CD。リダイレクトは追わない設定・タイムアウトの信号つき・UA などのヘッダは足さない", async () => {
    const h = harness();
    await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(new Set(h.calls.map((c) => c.url)).size).toBe(h.calls.length);
    for (const c of h.calls) {
      expect(c.init.redirect).toBe("manual");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys((c.init.headers ?? {}) as Record<string, string>).filter((k) => k.toLowerCase() !== "content-type")).toEqual([]);
    }
    const post = h.calls.filter((c) => c.init.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0]!.url).toBe(URLS.access);
    expect(post[0]!.init.body).toBe("CNAME=pw01iwtS3/CD");
    expect(h.calls.filter((c) => (c.init.method ?? "GET") === "GET")).toHaveLength(5);
    expect(fetch).not.toHaveBeenCalled(); // グローバルの fetch(落ちるスタブ)は呼ばれていない
  });

  it("タイムアウトは、省略すれば JRA_TIMEOUT_MS(10 秒)を 6 本すべてに渡し、timeoutMs を渡せばその値を 6 本すべてに渡す(Issue #490-3)", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const byDefault = harness();
      await createJraBabaFetcher({ fetch: byDefault.fetch, wait: byDefault.wait })(NOW_SUNDAY);
      expect(byDefault.calls).toHaveLength(6); // 前提: 6 本取っている
      expect(spy.mock.calls).toEqual(Array.from({ length: 6 }, () => [10_000]));
      spy.mockClear();
      const custom = harness();
      await createJraBabaFetcher({ fetch: custom.fetch, wait: custom.wait, timeoutMs: 25 })(NOW_SUNDAY);
      expect(custom.calls).toHaveLength(6);
      expect(spy.mock.calls).toEqual(Array.from({ length: 6 }, () => [25]));
    } finally {
      spy.mockRestore();
    }
  });

  it("定数: 間は 1.5 秒以上・各本のタイムアウトは 10 秒・本文の上限は 256KB(index は約 75KB で収まる)", () => {
    expect(JRA_GAP_MS).toBeGreaterThanOrEqual(1500);
    expect(JRA_TIMEOUT_MS).toBe(10_000);
    expect(JRA_MAX_BODY_BYTES).toBe(256 * 1024);
    for (const name of [FIXTURE_NAMES.index1, FIXTURE_NAMES.index2, FIXTURE_NAMES.index3, FIXTURE_NAMES.moist]) {
      expect(fixtureBytes(name).byteLength).toBeLessThan(JRA_MAX_BODY_BYTES);
    }
  });

  it("コースのページは、index.html の切り替えタブの数だけ(開催が 2 場なら index・index2 の 2 本。3 本目は取らない)", async () => {
    const cushion = cushionHtml([
      { name: "東京", units: [["10月25日（日曜）7時00分", "9.5"]] },
      { name: "京都", units: [["10月25日（日曜）7時00分", "9.0"]] },
    ]);
    const h = harness({
      cushion: () => html(sjis(cushion)),
      index1: () => html(sjis(coursePage({ name: "東京", tabs: ["東京", "京都"] }))),
      index2: () => html(sjis(coursePage({ name: "京都", tabs: ["東京", "京都"], usedCourse: "<strong>B</strong>コース" }))),
    });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(h.events.filter((e) => !e.startsWith("wait"))).toEqual(GET_ORDER.slice(0, 5));
    expect(outcome.venues.find((v) => v.venueName === "京都")!.usedCourse).toBe("Bコース");
  });

  it("タブが 5 場あっても、コースのページは 3 本まで(上限)", async () => {
    const tabs = ["東京", "京都", "新潟", "札幌", "函館"];
    const h = harness({ index1: () => html(sjis(coursePage({ name: "東京", tabs }))) });
    await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(h.events.filter((e) => e.includes("/keiba/baba/index"))).toEqual(["GET /keiba/baba/index.html", "GET /keiba/baba/index2.html", "GET /keiba/baba/index3.html"]);
  });
});

describe("当日の値が無いとき", () => {
  it("翌日(月曜)に読むと 3 場とも前日の値: 1 場も保存できないので、開催情報とコースのページには出ない(2 本だけ)。no-today-venues", async () => {
    const h = harness();
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_MONDAY);
    expect(h.events.filter((e) => !e.startsWith("wait"))).toEqual(GET_ORDER.slice(0, 2));
    expect(outcome.result).toBe("no-today-venues");
    expect(outcome.venues).toEqual([]);
    expect(outcome.dropped).toBe(3);
    expect(outcome.droppedDetails.map((d) => d.reason)).toEqual(["not-today", "not-today", "not-today"]);
  });

  it("含水率だけが当日: 保存する。クッション値のページが 503 でも含水率で保存し、rawJson に失敗の語が残る", async () => {
    const h = harness({ cushion: () => new Response("busy", { status: 503 }) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(outcome.result).toBe("ok");
    expect(outcome.venues).toHaveLength(3);
    expect(outcome.venues[0]).toMatchObject({ venueName: "東京", cushion: null, measuredAt: "2026-10-25T05:30+09:00" });
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources).toEqual({ cushion: "http-503", moist: "ok", access: "ok", course: "ok" });
    expect(outcome.apiFetchedAt).toBeNull(); // クッション値のページを取れていない
  });
});

describe("失敗の扱い(取れたものだけで保存する。例外は投げない)", () => {
  it("クッション値も含水率も取れない: 開催情報・コースには出ない。分類はクッション値の失敗(http-503)。保存する場は無い", async () => {
    const h = harness({ cushion: () => new Response("x", { status: 503 }), moist: () => new Response("x", { status: 500 }) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(outcome.result).toBe("http-503");
    expect(outcome.venues).toEqual([]);
    expect(h.events.filter((e) => !e.startsWith("wait"))).toEqual(GET_ORDER.slice(0, 2));
  });

  it("開催情報(POST)が失敗: 全体の状態は null。含水率の語・クッション値・コースは保存する。結果は ok", async () => {
    const h = harness({
      access: () => {
        throw new TypeError("接続できません(この文面は残らない)");
      },
    });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(outcome.result).toBe("ok");
    expect(outcome.venues).toHaveLength(3);
    for (const v of outcome.venues) {
      expect(v.turf.condition).toBeNull();
      expect(v.dirt.condition).toBeNull();
      expect(v.turf.goalCondition).not.toBeNull();
      expect(v.usedCourse).not.toBeNull();
    }
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.access).toBe("network");
    expect(JSON.stringify(outcome)).not.toContain("この文面は残らない");
  });

  it("index.html が失敗: 以降のコースのページは取らず、コースの項目は null。ほかは保存する", async () => {
    const h = harness({ index1: () => new Response("x", { status: 404 }) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(outcome.result).toBe("ok");
    expect(h.events.filter((e) => e.includes("index"))).toEqual(["GET /keiba/baba/index.html"]);
    expect(outcome.venues.every((v) => v.usedCourse === null && v.turfLength === null && v.turfConditionText === null)).toBe(true);
    expect(outcome.venues).toHaveLength(3);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.course).toBe("http-404");
  });

  it("index2.html だけが失敗: 京都のコースの項目だけが null。東京・新潟は読めている", async () => {
    const h = harness({ index2: () => new Response("x", { status: 502 }) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    const byName = Object.fromEntries(outcome.venues.map((v) => [v.venueName, v]));
    expect(byName["東京"]!.usedCourse).toBe("Aコース（内柵を最内に設置）");
    expect(byName["京都"]!.usedCourse).toBeNull();
    expect(byName["新潟"]!.usedCourse).toBe("Aコース（内柵を最内に設置）");
    expect(JSON.parse(byName["京都"]!.rawJson!).sources.course).toBe("http-502");
  });

  const statusCases: { name: string; response: Responder; sourceWord: string }[] = [
    { name: "HTTP 404", response: () => new Response("x", { status: 404 }), sourceWord: "http-404" },
    { name: "3xx(リダイレクトは追わない)", response: () => new Response(null, { status: 302, headers: { location: "https://example.invalid/" } }), sourceWord: "redirect" },
    { name: "通信の失敗", response: () => { throw new TypeError("boom"); }, sourceWord: "network" },
    { name: "TimeoutError", response: () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, sourceWord: "timeout" },
    { name: "AbortError", response: () => { throw Object.assign(new Error("a"), { name: "AbortError" }); }, sourceWord: "timeout" },
    { name: "形が想定外(場の見出しが無い)", response: () => html(sjis("<html><body>メンテナンス中</body></html>")), sourceWord: "shape-mismatch" },
  ];
  for (const c of statusCases) {
    it(`含水率のページが ${c.name} → 含水率の取得の結果は ${c.sourceWord}(クッション値で保存、再送しない)`, async () => {
      const h = harness({ moist: c.response });
      const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
      expect(outcome.result).toBe("ok");
      expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.moist).toBe(c.sourceWord);
      expect(h.calls.filter((c2) => c2.url === URLS.moist)).toHaveLength(1);
      expect(outcome.venues[0]!.turf.goalMoisture).toBeNull();
      expect(outcome.venues[0]!.cushion).toBe(9.5);
    });
  }

  it("両方のページが同じ失敗なら、その分類が結果になる(redirect・network・timeout・too-large・shape-mismatch)", async () => {
    const cases: { response: Responder; result: string }[] = [
      { response: () => new Response(null, { status: 301 }), result: "redirect" },
      { response: () => { throw new TypeError("x"); }, result: "network" },
      { response: () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, result: "timeout" },
      { response: () => new Response(new Uint8Array(JRA_MAX_BODY_BYTES + 1), { status: 200 }), result: "too-large" },
      { response: () => html(sjis("<p>x</p>")), result: "shape-mismatch" },
    ];
    for (const c of cases) {
      const h = harness({ cushion: c.response, moist: c.response });
      const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
      expect(outcome.result).toBe(c.result);
      expect(outcome.venues).toEqual([]);
    }
  });

  it("開催情報が 3xx: 追わずに redirect(Location の先へは出ない)", async () => {
    const h = harness({ access: () => new Response(null, { status: 302, headers: { location: "https://other.invalid/x" } }) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(h.calls.every((c) => c.url.startsWith(BASE))).toBe(true);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.access).toBe("redirect");
  });

  it("開催情報が JSON でない → shape-mismatch(全体の状態は null)", async () => {
    const h = harness({ access: () => new Response(sjis("<html>エラー</html>"), { status: 200 }) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.access).toBe("shape-mismatch");
    expect(outcome.venues[0]!.turf.condition).toBeNull();
  });

  it("本文の上限: ちょうど上限は読める。1 バイトでも超えれば too-large(Content-Length が無くても読みながら打ち切る)。Content-Length が超過なら本文を読まずに too-large", async () => {
    const exact = new Uint8Array(JRA_MAX_BODY_BYTES);
    exact.set(fixtureBytes(FIXTURE_NAMES.cushion));
    // 上限ちょうどの本文 = クッション値のページ + 末尾の空白。読める(含水率だけの失敗にもならない)
    exact.fill(0x20, fixtureBytes(FIXTURE_NAMES.cushion).byteLength);
    const okRun = await createJraBabaFetcher({ fetch: harness({ cushion: () => html(exact) }).fetch, wait: async () => undefined })(NOW_SUNDAY);
    expect(JSON.parse(okRun.venues[0]!.rawJson!).sources.cushion).toBe("ok");

    const over = new Uint8Array(JRA_MAX_BODY_BYTES + 1);
    const overRun = await createJraBabaFetcher({ fetch: harness({ cushion: () => html(over) }).fetch, wait: async () => undefined })(NOW_SUNDAY);
    expect(JSON.parse(overRun.venues[0]!.rawJson!).sources.cushion).toBe("too-large");

    let cancelled = false;
    const declared = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-length": String(JRA_MAX_BODY_BYTES + 1) } },
    );
    const declaredRun = await createJraBabaFetcher({ fetch: harness({ cushion: () => declared }).fetch, wait: async () => undefined })(NOW_SUNDAY);
    expect(JSON.parse(declaredRun.venues[0]!.rawJson!).sources.cushion).toBe("too-large");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true); // 本文を読まずに(宣言の時点で)打ち切った
  });

  it("応答が返らなければ、タイムアウトの信号で打ち切って timeout(各 1 回だけ)", async () => {
    const hanging: JraFetchLike = (url, init) => {
      if (url === URLS.cushion) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
        });
      }
      return harness().fetch(url, init);
    };
    const outcome = await createJraBabaFetcher({ fetch: hanging, wait: async () => undefined, timeoutMs: 20 })(NOW_SUNDAY);
    expect(outcome.result).toBe("ok");
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.cushion).toBe("timeout");
  });

  it("本文の読み出しの途中で止まっても、タイムアウトの信号で打ち切って timeout", async () => {
    const stalled: Responder = ({ init }) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        }),
        { status: 200 },
      );
    const outcome = await createJraBabaFetcher({ fetch: harness({ cushion: stalled }).fetch, wait: async () => undefined, timeoutMs: 30 })(NOW_SUNDAY);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.cushion).toBe("timeout");
  });

  it("本文の読み出しが失敗 → network", async () => {
    const broken: Responder = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError("接続が切れた"));
          },
        }),
        { status: 200 },
      );
    const outcome = await createJraBabaFetcher({ fetch: harness({ cushion: broken }).fetch, wait: async () => undefined })(NOW_SUNDAY);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.cushion).toBe("network");
  });

  it("Error でない値を投げられても network に分類し、投げ直さない(文字列・null を投げる fetch)", async () => {
    for (const thrown of ["文字列の例外", null, 42]) {
      const h = harness({
        cushion: () => {
          throw thrown;
        },
      });
      const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
      expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.cushion, String(thrown)).toBe("network");
      expect(JSON.stringify(outcome)).not.toContain("文字列の例外");
    }
  });

  it("Shift_JIS のまま渡された本文を日本語として読める(場名・使用コースが文字化けしない)", async () => {
    const outcome = await createJraBabaFetcher({ fetch: harness().fetch, wait: async () => undefined })(NOW_SUNDAY);
    expect(outcome.venues[0]!.venueName).toBe("東京");
    expect(outcome.venues[0]!.usedCourse).toBe("Aコース（内柵を最内に設置）");
  });
});

describe("accessJson の合成(開催情報の欠落・別日)", () => {
  it("その場が開催情報に無い: 全体の状態だけ null で保存する", async () => {
    const h = harness({
      access: () => new Response(sjis(accessJson([{ jyoname: "東京", kaisai_ymd: "20261025", ba_s: "良", ba_d: "良" }])), { status: 200 }),
    });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    const byName = Object.fromEntries(outcome.venues.map((v) => [v.venueName, v]));
    expect(byName["東京"]!.turf.condition).toBe("良");
    expect(byName["京都"]!.turf.condition).toBeNull();
    expect(byName["京都"]!.turf.goalCondition).toBe("稍重");
  });

  it("含水率(JRA の JS の対応 hard/wet/soft)は面ごとの語を決め、ダートの語は芝の語と独立", async () => {
    const m = moistHtml([{ name: "東京", units: [{ time: "10月25日（日曜）5時30分", turf: ["1.0", "hard", "2.0", "wet"], dirt: ["3.0", "soft", "4.0", "hard"] }] }]);
    const h = harness({ moist: () => html(sjis(m)) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    const tokyo = outcome.venues.find((v) => v.venueName === "東京")!;
    expect([tokyo.turf.goalCondition, tokyo.turf.corner4Condition, tokyo.dirt.goalCondition, tokyo.dirt.corner4Condition]).toEqual(["良", "稍重", "重", "良"]);
  });
});

describe("HTTP の状態の分類(旧 baba-fetch の表を引き継ぐ。クッション値のページに当てて、含水率で保存できる状態で確かめる)", () => {
  const statuses: { status: number; word: string }[] = [
    { status: 301, word: "redirect" },
    { status: 302, word: "redirect" },
    { status: 307, word: "redirect" },
    { status: 399, word: "redirect" },
    { status: 400, word: "http-400" },
    { status: 404, word: "http-404" },
    { status: 429, word: "http-429" },
    { status: 500, word: "http-500" },
    { status: 503, word: "http-503" },
  ];
  for (const c of statuses) {
    it(`HTTP ${c.status} → ${c.word}(再送しない: そのページの fetch は 1 回。3xx の Location には出ない)`, async () => {
      const h = harness({ cushion: () => new Response("body", { status: c.status, headers: c.status >= 300 && c.status < 400 ? { location: "https://elsewhere.invalid/" } : {} }) });
      const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
      expect(outcome.result).toBe("ok"); // 含水率で保存できる
      expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.cushion).toBe(c.word);
      expect(h.calls.filter((call) => call.url === URLS.cushion)).toHaveLength(1);
      expect(h.calls.every((call) => call.url.startsWith(BASE))).toBe(true);
    });
  }

  it("200 台の別の状態(204・206)も成功扱い(本文を読む)。読めなければ形の不一致", async () => {
    const h = harness({ cushion: () => new Response(fixtureBytes(FIXTURE_NAMES.cushion), { status: 206 }) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.cushion).toBe("ok");
    const empty = harness({ cushion: () => new Response(null, { status: 204 }) });
    const outcome2 = await createJraBabaFetcher({ fetch: empty.fetch, wait: empty.wait })(NOW_SUNDAY);
    expect(JSON.parse(outcome2.venues[0]!.rawJson!).sources.cushion).toBe("shape-mismatch");
  });
});

describe("Issue #480(取り直し)で足した出力: 載っている場・クッション値を取り終えた時刻", () => {
  it("apiFetchedAt はクッション値のページを取り終えた時刻(取得口を呼んだ時刻 nowMs ではない)。含水率以降を待っている間に進んだ時計の値にならない", async () => {
    const h = harness();
    const clock = [NOW_SUNDAY + 3_000, NOW_SUNDAY + 9_000, NOW_SUNDAY + 20_000];
    let n = 0;
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait, now: () => clock[Math.min(n++, clock.length - 1)]! })(NOW_SUNDAY);
    expect(outcome.apiFetchedAt).toBe(new Date(NOW_SUNDAY + 3_000).toISOString()); // 最初の now() = クッション値の本を取り終えた直後
    expect(outcome.apiFetchedAt).not.toBe(new Date(NOW_SUNDAY).toISOString()); // 差が 0 でない(取得口を呼んだ時刻とは違う)
    expect(n).toBe(1); // 時計を引くのは 1 回だけ
  });

  it("クッション値のページを取れなければ apiFetchedAt は null(時計も引かない)", async () => {
    const h = harness({ cushion: () => new Response("x", { status: 503 }) });
    let n = 0;
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait, now: () => (n++, NOW_SUNDAY) })(NOW_SUNDAY);
    expect(outcome.apiFetchedAt).toBeNull();
    expect(n).toBe(0);
  });

  it("listedVenueCodes: クッション値・含水率のページに載っている場の場コード(載った順、重複なし)。当日の値が無い場(月曜)も載っている", async () => {
    const sunday = await createJraBabaFetcher({ fetch: harness().fetch, wait: harness().wait })(NOW_SUNDAY);
    expect(sunday.listedVenueCodes).toEqual(["05", "08", "04"]);
    const monday = await createJraBabaFetcher({ fetch: harness().fetch, wait: harness().wait })(NOW_MONDAY);
    expect(monday.venues).toEqual([]); // 前提: 1 場も保存しない回でも
    expect(monday.listedVenueCodes).toEqual(["05", "08", "04"]); // 載っている場は分かる
  });

  it("listedVenueCodes: 含水率のページにだけある場も入る。JRA の 10 場にない場名は入らない。ページを読めなければ空", async () => {
    const cushion = cushionHtml([{ name: "東京", units: [["10月25日（日曜）7時00分", "9.5"]] }]);
    const moist = moistHtml([
      { name: "京都", units: [{ time: "10月25日（日曜）5時30分", turf: ["10.0", "hard", "11.0", "hard"], dirt: ["3.0", "hard", "4.0", "hard"] }] },
      { name: "謎の場", units: [{ time: "10月25日（日曜）5時30分", turf: ["10.0", "hard", "11.0", "hard"], dirt: ["3.0", "hard", "4.0", "hard"] }] },
    ]);
    const h = harness({ cushion: () => html(sjis(cushion)), moist: () => html(sjis(moist)) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(outcome.listedVenueCodes).toEqual(["05", "08"]);
    const broken = harness({ cushion: () => new Response("x", { status: 503 }), moist: () => new Response("x", { status: 503 }) });
    expect((await createJraBabaFetcher({ fetch: broken.fetch, wait: broken.wait })(NOW_SUNDAY)).listedVenueCodes).toEqual([]);
  });
});

describe("Issue #490-1: ページの構造が変わったら、判定の結果ではなく shape-mismatch として残す", () => {
  const renamed = (name: string, from: string, to: string): Uint8Array => sjis(fixtureText(name).replaceAll(from, to));

  it("前提(対照): 実物のクッション値で、time の class を変えなければ読める", () => {
    expect(fixtureText(FIXTURE_NAMES.cushion)).toContain('class="time"');
    expect(fixtureText(FIXTURE_NAMES.moist)).toContain('class="mg"');
  });

  it("クッション値の time の class が変わった(含水率は読める): クッション値は shape-mismatch。含水率で保存し、rawJson の sources に残る。no-today-venues にはならない", async () => {
    const h = harness({ cushion: () => html(renamed(FIXTURE_NAMES.cushion, 'class="time"', 'class="tm"')) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(outcome.result).toBe("ok");
    expect(outcome.venues).toHaveLength(3);
    expect(outcome.venues.every((v) => v.cushion === null)).toBe(true);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.cushion).toBe("shape-mismatch");
    expect(outcome.apiFetchedAt).toBeNull(); // クッション値のページを読めていない
  });

  it("クッション値の time の class が変わり、含水率は当日の値が無い(月曜): 結果は shape-mismatch(no-today-venues ではない)。開催情報・コースには出ない", async () => {
    const h = harness({ cushion: () => html(renamed(FIXTURE_NAMES.cushion, 'class="time"', 'class="tm"')) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_MONDAY);
    expect(outcome.venues).toEqual([]);
    expect(outcome.result).toBe("shape-mismatch");
    expect(h.events.filter((e) => !e.startsWith("wait"))).toEqual(GET_ORDER.slice(0, 2));
  });

  it("含水率の span.mg・span.m4c の class が変わった(値が全部読めない): 含水率は shape-mismatch。クッション値で保存し、rawJson の sources に残る", async () => {
    const changed = fixtureText(FIXTURE_NAMES.moist).replaceAll('class="mg"', 'class="mgx"').replaceAll('class="m4c"', 'class="m4cx"');
    const h = harness({ moist: () => html(sjis(changed)) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(outcome.result).toBe("ok");
    expect(outcome.venues).toHaveLength(3);
    expect(outcome.venues.every((v) => v.cushion !== null)).toBe(true);
    expect(outcome.venues.every((v) => v.turf.goalMoisture === null && v.dirt.goalMoisture === null)).toBe(true);
    expect(JSON.parse(outcome.venues[0]!.rawJson!).sources.moist).toBe("shape-mismatch");
  });

  it("対照: 含水率の一部の面だけ値が無くても(ほかに値がある)、shape-mismatch にしない", async () => {
    const moist = moistHtml([
      { name: "東京", units: [{ time: "10月25日（日曜）5時30分", turf: ["", "hard", "11.0", "hard"], dirt: ["", "", "", ""] }] },
    ]);
    const h = harness({ moist: () => html(sjis(moist)) });
    const outcome = await createJraBabaFetcher({ fetch: h.fetch, wait: h.wait })(NOW_SUNDAY);
    expect(JSON.parse(outcome.venues.find((v) => v.venueName === "東京")!.rawJson!).sources.moist).toBe("ok");
  });
});
