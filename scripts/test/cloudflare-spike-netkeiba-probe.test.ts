import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeNetkeiba, type ProbeFetch } from "../../spikes/cloudflare/src/netkeiba-probe.js";
import { judgeReachability } from "../cloudflare-spike/reachability.js";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba.js";
import { parseHorseResults } from "../../packages/core/src/scraper/parse-horse-results.js";
import { parseOdds } from "../../packages/core/src/scraper/parse-odds.js";
import { parseComboOdds } from "../../packages/core/src/scraper/parse-combo-odds.js";
import { parseNarOdds } from "../../packages/core/src/scraper/parse-nar-odds.js";

/**
 * #159 Worker が netkeiba の1本を取得して記録を作る処理(`spikes/cloudflare/src/netkeiba-probe.ts`)。
 * Worker に載せるコードだが、fetch を注入できるので、保存済みフィクスチャを「netkeiba の応答」として返す
 * 偽 fetch でここから検証できる。実ネットワークには出ない。
 */

// iconv-lite はルートの依存ではなく @keiba/core の依存(pnpm のため core 側からだけ解決できる)。
const iconv = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "core", "package.json"),
)("iconv-lite") as { encode(text: string, encoding: string): Buffer };

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const readFixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

/** 指定のステータス・ヘッダ・本文を返す偽 fetch。呼び出し履歴も返す。 */
function fakeFetch(
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
): { fetch: ProbeFetch; calls: { url: string; init: unknown }[] } {
  const calls: { url: string; init: unknown }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers });
    },
  };
}

const HTML_UTF8 = { "content-type": "text/html; charset=UTF-8", server: "cloudflare", "cf-ray": "abc-NRT", "set-cookie": "secret=1" };

describe("probeNetkeiba: 成功した取得の記録", () => {
  it("出馬表(UTF-8)は、ステータス・本文バイト数・charset・パース件数(16頭)・置換文字0を記録する", async () => {
    const bytes = readFixture("shutuba_202603020211.html");
    const { fetch } = fakeFetch(200, bytes, HTML_UTF8);
    const rec = await probeNetkeiba(
      { targetId: "central-shutuba", url: "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211", kind: "shutuba", encoding: "utf-8" },
      fetch,
    );
    expect(rec.status).toBe(200);
    expect(rec.bodyLength).toBe(bytes.length);
    expect(rec.charset).toBe("UTF-8");
    expect(rec.parsedKind).toBe("shutuba");
    expect(rec.parsedCount).toBe(16);
    expect(rec.parseError).toBeNull();
    expect(rec.replacementChars).toBe(0);
    expect(rec.bodyHead).toBeNull();
    expect(rec.error).toBeNull();
    expect(judgeReachability(rec).verdict).toBe("ok");
  });

  it("診断用に選んだヘッダ(server / cf-ray)だけを残し、set-cookie などは残さない", async () => {
    const { fetch } = fakeFetch(200, readFixture("shutuba_202603020211.html"), HTML_UTF8);
    const rec = await probeNetkeiba(
      { targetId: "t", url: "https://race.netkeiba.com/x", kind: "shutuba", encoding: "utf-8" },
      fetch,
    );
    expect(rec.headers).toEqual({
      server: "cloudflare",
      "cf-ray": "abc-NRT",
      "content-type": "text/html; charset=UTF-8",
    });
  });

  it("地方の出馬表は、既存パーサ(parseShutuba)で読んだ頭数と一致する", async () => {
    const html = readFixture("nar_shutuba_202654071210.html");
    const expected = parseShutuba(html.toString("utf-8")).horses.length;
    expect(expected).toBeGreaterThan(0);
    const { fetch } = fakeFetch(200, html, HTML_UTF8);
    const rec = await probeNetkeiba(
      { targetId: "nar-shutuba", url: "https://nar.netkeiba.com/race/shutuba.html?race_id=202654071210", kind: "shutuba", encoding: "utf-8" },
      fetch,
    );
    expect(rec.parsedCount).toBe(expected);
  });

  it("戦績 API(JSON)は parseHorseResults の件数、オッズ API は parseOdds の単勝の頭数を記録する", async () => {
    const resultsJson = readFixture("horse_results_2021105857.json");
    const expectedResults = parseHorseResults(resultsJson.toString("utf-8")).length;
    expect(expectedResults).toBeGreaterThan(0);
    const r1 = await probeNetkeiba(
      { targetId: "r", url: "https://db.netkeiba.com/horse/ajax_horse_results.html?id=1", kind: "horse-results", encoding: "utf-8" },
      fakeFetch(200, resultsJson, { "content-type": "application/json" }).fetch,
    );
    expect(r1.parsedKind).toBe("horse-results");
    expect(r1.parsedCount).toBe(expectedResults);

    const oddsJson = readFixture("odds_202603020211.json");
    const expectedOdds = Object.keys(parseOdds(oddsJson.toString("utf-8")).win).length;
    expect(expectedOdds).toBeGreaterThan(0);
    const r2 = await probeNetkeiba(
      { targetId: "o", url: "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=1&type=1&action=init", kind: "odds-json", encoding: "utf-8" },
      fakeFetch(200, oddsJson, { "content-type": "application/json" }).fetch,
    );
    expect(r2.parsedKind).toBe("odds-json");
    expect(r2.parsedCount).toBe(expectedOdds);
  });
});

describe("probeNetkeiba: EUC-JP の馬ページ(db.netkeiba.com)", () => {
  const html = readFixture("horse_2021105857.html").toString("utf-8");
  const eucBytes = iconv.encode(html, "euc-jp");
  const url = "https://db.netkeiba.com/horse/2021105857/";

  it("EUC-JP のバイト列を encoding=euc-jp で読めば、馬名を読めて文字化け(置換文字)は0", async () => {
    const rec = await probeNetkeiba(
      { targetId: "db-horse-page", url, kind: "horse-page", encoding: "euc-jp" },
      fakeFetch(200, eucBytes, { "content-type": "text/html" }).fetch,
    );
    expect(rec.bodyLength).toBe(eucBytes.length);
    expect(rec.charset).toBeNull(); // Content-Type に charset が無い(実サイトと同じ)
    expect(rec.parsedKind).toBe("horse-page");
    expect(rec.parsedCount).toBe(1);
    expect(rec.replacementChars).toBe(0);
    expect(judgeReachability(rec).verdict).toBe("ok");
  });

  it("同じバイト列を誤って utf-8 で読むと、置換文字が検出され reachable-but-unparsed になる(文字化け検出が空振りでない)", async () => {
    const rec = await probeNetkeiba(
      { targetId: "db-horse-page", url, kind: "horse-page", encoding: "utf-8" },
      fakeFetch(200, eucBytes, { "content-type": "text/html" }).fetch,
    );
    expect(rec.replacementChars).toBeGreaterThan(0);
    expect(judgeReachability(rec).verdict).toBe("reachable-but-unparsed");
  });
});

describe("probeNetkeiba: 失敗した取得の記録", () => {
  const target = { targetId: "central-shutuba", url: "https://race.netkeiba.com/race/shutuba.html?race_id=1", kind: "shutuba", encoding: "utf-8" } as const;

  it("403 のチャレンジページは、ステータス・ヘッダ・本文の先頭を記録し、challenge と判定される(HttpClient が捨てる情報を残す)", async () => {
    const { fetch } = fakeFetch(403, "<html><title>Just a moment...</title></html>", {
      "content-type": "text/html; charset=UTF-8",
      "cf-mitigated": "challenge",
      server: "cloudflare",
    });
    const rec = await probeNetkeiba(target, fetch);
    expect(rec.status).toBe(403);
    expect(rec.headers["cf-mitigated"]).toBe("challenge");
    expect(rec.bodyHead).toContain("Just a moment");
    expect(rec.parsedCount).toBeNull();
    expect(rec.error).not.toBeNull();
    expect(judgeReachability(rec).verdict).toBe("challenge");
  });

  it("非 2xx の本文の先頭は 400 バイトで切る", async () => {
    const { fetch } = fakeFetch(403, "x".repeat(10_000), {});
    const rec = await probeNetkeiba(target, fetch);
    expect(rec.bodyLength).toBe(10_000);
    expect(rec.bodyHead).toHaveLength(400);
  });

  it("5xx でも fetch は1回だけ(HttpClient の既定の再試行を無効にして、netkeiba への本数を増やさない)", async () => {
    const { fetch, calls } = fakeFetch(503, "unavailable");
    const rec = await probeNetkeiba(target, fetch);
    expect(rec.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("200 でもパースに失敗すれば、parseError と本文の先頭(300文字まで)を残す", async () => {
    const { fetch } = fakeFetch(200, "<html><body>hello</body></html>" + "y".repeat(1000), HTML_UTF8);
    const rec = await probeNetkeiba(target, fetch);
    expect(rec.status).toBe(200);
    expect(rec.parsedCount).toBeNull();
    expect(rec.parseError).not.toBeNull();
    expect(rec.bodyHead).toContain("hello");
    expect(rec.bodyHead!.length).toBe(300);
    expect(judgeReachability(rec).verdict).toBe("reachable-but-unparsed");
  });

  it("fetch 自体が例外なら、status=null・error に原因・本文バイトも null で、network-error と判定される", async () => {
    const rec = await probeNetkeiba(target, async () => {
      throw new Error("connection reset");
    });
    expect(rec.status).toBeNull();
    expect(rec.bodyLength).toBeNull();
    expect(rec.error).toContain("connection reset");
    expect(judgeReachability(rec).verdict).toBe("network-error");
  });
});

describe("probeNetkeiba: 送るリクエスト", () => {
  it("GET で、User-Agent を明示して送る(HttpClient の既定)。1回の呼び出しで fetch は1回", async () => {
    const { fetch, calls } = fakeFetch(200, readFixture("shutuba_202603020211.html"), HTML_UTF8);
    await probeNetkeiba(
      { targetId: "t", url: "https://race.netkeiba.com/x", kind: "shutuba", encoding: "utf-8" },
      fetch,
    );
    expect(calls).toHaveLength(1);
    const init = calls[0]!.init as { method?: string; headers?: Record<string, string> };
    expect(init.method ?? "GET").toBe("GET");
    expect(init.headers?.["User-Agent"]).toContain("keiba-ev-tool");
  });
});

describe("probeNetkeiba: リダイレクトに従わない(許可ホスト外への転送や、本数の上限の素通りを防ぐ)", () => {
  const target = { targetId: "central-shutuba", url: "https://race.netkeiba.com/race/shutuba.html?race_id=1", kind: "shutuba", encoding: "utf-8" } as const;

  it("fetch には redirect: 'manual' を渡す", async () => {
    const { fetch, calls } = fakeFetch(200, readFixture("shutuba_202603020211.html"), HTML_UTF8);
    await probeNetkeiba(target, fetch);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init as { redirect?: string }).redirect).toBe("manual");
  });

  it("302 は追わずに、ステータスと location を記録して redirect と判定する。fetch は1回だけ", async () => {
    const { fetch, calls } = fakeFetch(302, "", { location: "https://evil.example/x", server: "cloudflare" });
    const rec = await probeNetkeiba(target, fetch);
    expect(calls).toHaveLength(1);
    expect(rec.status).toBe(302);
    expect(rec.headers["location"]).toBe("https://evil.example/x");
    expect(rec.parsedCount).toBeNull();
    const j = judgeReachability(rec);
    expect(j.verdict).toBe("redirect");
    expect(j.reason).toContain("https://evil.example/x");
  });
});

describe("probeNetkeiba: 三連複の JSON・地方のオッズページ(#162)", () => {
  it("三連複の JSON(combo-trio-json)は、組合せの件数(560)を parsedCount にする", async () => {
    const json = readFixture("odds_trio_202603020211.json");
    const parsed = parseComboOdds(json.toString("utf-8"), "trio");
    // 期待値はパーサから取り直す(16頭の C(16,3)=560 組が読めている前提を固定する)。
    expect(parsed.state).toBe("available");
    const expected = parsed.state === "available" ? parsed.odds.size : 0;
    expect(expected).toBe(560);
    const rec = await probeNetkeiba(
      { targetId: "central-trio-odds", url: "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init", kind: "combo-trio-json", encoding: "utf-8" },
      fakeFetch(200, json, { "content-type": "application/json" }).fetch,
    );
    expect(rec.parsedKind).toBe("combo-trio-json");
    expect(rec.parsedCount).toBe(expected);
    expect(rec.parseError).toBeNull();
    expect(judgeReachability(rec).verdict).toBe("ok");
  });

  it("三連複の JSON が発売なし(unavailable)のときは、件数 0(到達したがパーサで読めなかった扱い)", async () => {
    const rec = await probeNetkeiba(
      { targetId: "t", url: "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=1&type=7&action=init", kind: "combo-trio-json", encoding: "utf-8" },
      fakeFetch(200, JSON.stringify({ status: "NG", data: "" }), { "content-type": "application/json" }).fetch,
    );
    expect(rec.status).toBe(200);
    expect(rec.parsedCount).toBe(0);
    expect(judgeReachability(rec).verdict).toBe("reachable-but-unparsed");
  });

  it("地方のオッズページ(nar-odds-page)は、parseNarOdds で読んだ単勝の頭数を parsedCount にする", async () => {
    const html = readFixture("nar_odds_b1_202654071210.html");
    const expected = Object.keys(parseNarOdds(html.toString("utf-8")).win).length;
    expect(expected).toBeGreaterThan(0);
    const rec = await probeNetkeiba(
      { targetId: "nar-odds-page", url: "https://nar.netkeiba.com/odds/index.html?type=b1&race_id=202654071210", kind: "nar-odds-page", encoding: "utf-8" },
      fakeFetch(200, html, { "content-type": "text/html; charset=UTF-8" }).fetch,
    );
    expect(rec.parsedKind).toBe("nar-odds-page");
    expect(rec.parsedCount).toBe(expected);
    expect(rec.replacementChars).toBe(0);
    expect(judgeReachability(rec).verdict).toBe("ok");
  });
});
