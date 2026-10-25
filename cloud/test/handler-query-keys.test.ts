import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * クエリの許可リスト(`handler.ts` の `*_PARAMS`)を持つ**全ルート**について、(1) 許可リストの外のキーは 400(文言込み)、
 * (2) 別サイト(`Sec-Fetch-Site` が `same-origin`・`none` 以外)の検査をするルートでは、不正なクエリが付いていても 403 が先、を確かめる。
 * Issue #446(H-5): 削除した特性テスト(`handler-boilerplate-characterization.test.ts`)の「過剰許可でない」「403 はクエリの検査より先」を移した。
 *
 * **網羅の保証**: ルートの表(`ROUTES`)は手で書いたものだが、最後の describe が `handler.ts` のソースを読み、
 *  - `*_PARAMS` 定数の名前と中身が、表の定数と一致すること
 *  - `hasInvalidQueryKeys(url, 定数)` の呼び出しが、定数ごとに表のルート数と一致すること
 *  - `crossSiteRejection(request)` の呼び出しが、表の「別サイトを検査する」ルート数と一致すること
 * を固定する。許可リストや呼び出しを足したのに表を直さなければ、そこで落ちる。
 *
 * 許可キーを足す変異は、**ほかのルートで許可されているキー**(`ALL_KEYS` から、そのルートの許可キーを除いたもの)と、
 * どのルートにも無いキー(`zzz`)の両方で検出する。
 */

const ORIGIN = "https://cloud.invalid";
const boom = (): never => {
  throw new Error("裏側は呼ばれない想定");
};

/** 裏側(DO・D1・R2)に触れると throw する env。検査だけで終わる応答は、裏側に触れない。 */
function env(): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: boom, get: boom },
    RACE_DAY: { idFromName: boom, get: boom },
    RESULT_BACKFILL: { idFromName: boom, get: boom },
    VERIFY_REPORT: { idFromName: boom, get: boom },
    PRIOR_EXPORT: { idFromName: boom, get: boom },
    DAILY_REPORT: { idFromName: boom, get: boom },
    MONTHLY_REPORT: { idFromName: boom, get: boom },
    DB: { prepare: boom, batch: boom },
    ANALYSIS_DETAIL: { get: boom, put: boom },
  } as unknown as Env;
}

async function setup() {
  const key = await makeKey("k1");
  return { deps: { keys: () => localKeys(key), now: () => NOW, log: () => {} }, token: await signToken(key) };
}

const get = (path: string, token: string, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, { method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, ...headers } });

const bad = (message: string): string => JSON.stringify({ ok: false, error: { type: "bad-request", message } });
const ORIGIN_MISMATCH = JSON.stringify({ ok: false, error: { type: "origin-mismatch" } });
const NO_QUERY = "このパスにクエリは指定できません";

/** 全ルートの許可キーの和集合(最後の describe が、ソースの `*_PARAMS` の和集合と一致することを固定する)。 */
const ALL_KEYS = ["cells", "days", "kaisai_date", "limit", "race_id", "refresh", "status", "type", "venue"];

interface Route {
  readonly name: string;
  /** クエリを除いたパス(動的な部分は通る形の値)。 */
  readonly path: string;
  /** `handler.ts` の許可リスト定数の名前。 */
  readonly constant: string;
  readonly allowed: readonly string[];
  readonly message: string;
  /** `crossSiteRejection` を呼ぶルートか。 */
  readonly site: boolean;
}

const ROUTES: readonly Route[] = [
  { name: "horse-runs", path: "/api/horse-runs", constant: "HORSE_RUNS_PARAMS", allowed: ["days", "cells"], message: "クエリは days(1〜60 の整数)と cells(1 または 0)だけを、それぞれ1つまで指定できます", site: true },
  { name: "baba-fetch", path: "/api/baba-fetch", constant: "KAISAI_DATE_PARAMS", allowed: ["kaisai_date"], message: "クエリは kaisai_date だけを1つ指定できます", site: true },
  { name: "verify", path: "/api/verify", constant: "VERIFY_PARAMS", allowed: ["venue", "refresh"], message: "クエリは venue(all・central・nar)と refresh(1 または 0)だけを、それぞれ1つまで指定できます", site: true },
  { name: "prior-export", path: "/api/export/prior-dataset", constant: "PRIOR_EXPORT_PARAMS", allowed: ["refresh", "status"], message: "クエリは refresh(1 または 0)と status(1 または 0)だけを、それぞれ1つまで指定できます", site: true },
  { name: "races", path: "/api/races", constant: "RACES_PARAMS", allowed: ["kaisai_date", "venue"], message: "クエリは kaisai_date(必須)と venue(必須)だけを、それぞれ1つまで指定できます", site: true },
  { name: "plan", path: "/api/plan", constant: "KAISAI_DATE_PARAMS", allowed: ["kaisai_date"], message: "クエリは kaisai_date だけを1つ指定できます", site: true },
  { name: "targets", path: "/api/targets", constant: "KAISAI_DATE_PARAMS", allowed: ["kaisai_date"], message: "クエリは kaisai_date だけを1つ指定できます", site: true },
  { name: "netkeiba/check", path: "/api/netkeiba/check", constant: "CHECK_PARAMS", allowed: ["race_id", "type"], message: "クエリは race_id(必須)と type(省略可。shutuba または grade-winner)だけを、それぞれ1つ指定してください", site: true },
  { name: "jra/check", path: "/api/jra/check", constant: "NO_PARAMS", allowed: [], message: NO_QUERY, site: true },
  { name: "analyses", path: "/api/analyses", constant: "ANALYSES_PARAMS", allowed: ["race_id", "kaisai_date", "limit"], message: "クエリは race_id・kaisai_date・limit だけを、それぞれ1つまで指定できます", site: false },
  { name: "analyses/status", path: "/api/analyses/status", constant: "STATUS_PARAMS", allowed: ["kaisai_date", "race_id"], message: "クエリは kaisai_date(必須)と race_id(任意)だけを、それぞれ1つまで指定できます", site: false },
  { name: "analyses/{id}", path: "/api/analyses/123", constant: "NO_PARAMS", allowed: [], message: NO_QUERY, site: false },
  { name: "reports", path: "/api/reports", constant: "NO_PARAMS", allowed: [], message: NO_QUERY, site: false },
  { name: "reports/{date}", path: "/api/reports/20261005", constant: "NO_PARAMS", allowed: [], message: NO_QUERY, site: false },
  { name: "monthly-reports", path: "/api/monthly-reports", constant: "NO_PARAMS", allowed: [], message: NO_QUERY, site: false },
  { name: "monthly-reports/{month}", path: "/api/monthly-reports/202609", constant: "NO_PARAMS", allowed: [], message: NO_QUERY, site: false },
];

describe("許可リストの外のキーは 400(全 16 ルート。ほかのルートで許可されているキー・どのルートにも無いキー・重複・大文字違い)", () => {
  for (const route of ROUTES) {
    const foreign = [...ALL_KEYS.filter((k) => !route.allowed.includes(k)), "zzz"];

    it(`${route.name}: ほかのルートのキー ${foreign.length - 1} 種と zzz は、単独でも許可キーに足しても 400(裏側に触れない)`, async () => {
      expect(foreign.length).toBeGreaterThan(1); // 前提: 過剰許可を試せるキーがある
      const { deps, token } = await setup();
      for (const key of foreign) {
        const queries = [`${key}=1`, ...route.allowed.map((a) => `${a}=1&${key}=1`)];
        for (const query of queries) {
          const res = await handle(get(`${route.path}?${query}`, token), env(), {}, deps);
          expect(res.status, `${route.path}?${query}`).toBe(400);
          expect(await res.text(), `${route.path}?${query}`).toBe(bad(route.message));
        }
      }
    });

    it(`${route.name}: 大文字違いのキー・値のない空のキーは 400`, async () => {
      const { deps, token } = await setup();
      const upper = (route.allowed[0] ?? "days").toUpperCase();
      for (const query of [`${upper}=1`, "=1"]) {
        const res = await handle(get(`${route.path}?${query}`, token), env(), {}, deps);
        expect(res.status, query).toBe(400);
      }
    });
  }
});

describe("別サイト(Sec-Fetch-Site が same-origin・none 以外)の検査は、クエリの検査より先(別サイト検査をする 9 ルート)", () => {
  const checked = ROUTES.filter((r) => r.site);

  it("前提: 別サイトを検査するルートは 9 本(Issue #488 で jra/check が加わり 8 → 9)", () => {
    expect(checked.map((r) => r.name)).toEqual(["horse-runs", "baba-fetch", "verify", "prior-export", "races", "plan", "targets", "netkeiba/check", "jra/check"]);
  });

  for (const route of checked) {
    it(`${route.name}: 別サイトのリクエストに不正なクエリ(未知のキー・重複・ほかのルートのキー)が付いていても 403(origin-mismatch)。裏側に触れない`, async () => {
      const { deps, token } = await setup();
      const dup = route.allowed[0] ?? "days";
      const foreign = ALL_KEYS.find((k) => !route.allowed.includes(k))!;
      for (const site of ["cross-site", "same-site"]) {
        for (const query of ["zzz=1", `${dup}=1&${dup}=2`, `${foreign}=1`, ""]) {
          const res = await handle(get(`${route.path}${query === "" ? "" : `?${query}`}`, token, { "Sec-Fetch-Site": site }), env(), {}, deps);
          expect(res.status, `${site} ${query}`).toBe(403);
          expect(await res.text(), `${site} ${query}`).toBe(ORIGIN_MISMATCH);
        }
      }
    });

    it(`${route.name}: Sec-Fetch-Site が none・same-origin・無し のときは別サイトとして断らない(不正なクエリは 400)`, async () => {
      const { deps, token } = await setup();
      for (const headers of [{ "Sec-Fetch-Site": "none" }, { "Sec-Fetch-Site": "same-origin" }, {}] as Array<Record<string, string>>) {
        const res = await handle(get(`${route.path}?zzz=1`, token, headers), env(), {}, deps);
        expect(res.status, JSON.stringify(headers)).toBe(400);
      }
    });
  }
});

describe("別サイトの検査をしない 7 ルートは、別サイトのヘッダが付いていてもクエリの検査の結果(400)になる", () => {
  for (const route of ROUTES.filter((r) => !r.site)) {
    it(`${route.name}: 403 にならない`, async () => {
      const { deps, token } = await setup();
      const res = await handle(get(`${route.path}?zzz=1`, token, { "Sec-Fetch-Site": "cross-site" }), env(), {}, deps);
      expect(res.status).toBe(400);
    });
  }
});

describe("netkeiba/check: race_id が無ければ、許可キーだけでも 400(必須キー。キーの検査と同じ文言)", () => {
  it.each(["", "?type=shutuba"])("クエリ「%s」", async (query) => {
    const { deps, token } = await setup();
    const route = ROUTES.find((r) => r.name === "netkeiba/check")!;
    const res = await handle(get(`${route.path}${query}`, token), env(), {}, deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(bad(route.message));
  });
});

describe("網羅の保証: handler.ts の `*_PARAMS`・呼び出しと、このテストの表が一致する", () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "handler.ts"), "utf-8");

  it("`*_PARAMS` 定数の名前と中身(NO_PARAMS は空)", () => {
    const found = new Map<string, string[]>();
    for (const m of source.matchAll(/^const (\w+_PARAMS)\b[^=]*= new Set(?:<string>)?\((?:\[([^\]]*)\])?\);$/gm)) {
      found.set(m[1]!, [...(m[2] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
    }
    const table = new Map<string, string[]>();
    for (const r of ROUTES) table.set(r.constant, [...r.allowed]);
    expect([...found.keys()].sort()).toEqual([...table.keys()].sort());
    for (const [name, keys] of found) {
      expect([...keys].sort(), name).toEqual([...(table.get(name) ?? [])].sort());
    }
    // 和集合が ALL_KEYS
    expect([...new Set([...found.values()].flat())].sort()).toEqual([...ALL_KEYS].sort());
  });

  it("`hasInvalidQueryKeys(url, 定数)` の呼び出しは、定数ごとに表のルート数と一致する", () => {
    const calls = new Map<string, number>();
    for (const m of source.matchAll(/hasInvalidQueryKeys\(url, (\w+)\)/g)) {
      calls.set(m[1]!, (calls.get(m[1]!) ?? 0) + 1);
    }
    const table = new Map<string, number>();
    for (const r of ROUTES) table.set(r.constant, (table.get(r.constant) ?? 0) + 1);
    expect(Object.fromEntries([...calls].sort())).toEqual(Object.fromEntries([...table].sort()));
    expect([...calls.values()].reduce((a, b) => a + b, 0)).toBe(ROUTES.length);
  });

  it("`crossSiteRejection(request)` の呼び出し(定義を除く)は、別サイトを検査するルートの数と一致する", () => {
    const calls = [...source.matchAll(/= crossSiteRejection\(request\)/g)].length;
    expect(calls).toBe(ROUTES.filter((r) => r.site).length);
  });
});
