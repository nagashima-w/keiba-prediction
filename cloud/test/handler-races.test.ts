import { describe, expect, it } from "vitest";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { handle, type Env } from "../src/handler";
import type { RaceListResult, RaceListVenue } from "../src/race-day-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #183(#165-a): `GET /api/races?kaisai_date=YYYYMMDD&venue=central|nar`。
 * 日単位の DO(RaceDay)は偽物(呼び出しを記録する)。実 netkeiba・実 DO には触れない。
 * 入口の守り: 認証の後・GET だけ(HEAD で取得を起こさない)・Sec-Fetch-Site・検証 400(DO を呼ばない)・DO と gate の失敗は 503(文面を返さない)。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20260628";

function entry(raceId: string, over: Partial<RaceListEntry> = {}): RaceListEntry {
  return { raceId, name: `レース${raceId.slice(-2)}`, courseType: "芝", distance: 1600, entryCount: 16, venue: "福島", raceNumber: Number(raceId.slice(-2)), ...over } as RaceListEntry;
}

interface FakeRaceDay {
  readonly names: string[];
  readonly lists: { kaisaiDate: string; venue: RaceListVenue }[];
  impl: (kaisaiDate: string, venue: RaceListVenue) => Promise<RaceListResult>;
  readonly namespace: Env["RACE_DAY"];
  calls(): number;
}

function fakeRaceDay(): FakeRaceDay {
  const f: FakeRaceDay = {
    names: [],
    lists: [],
    impl: async () => ({ ok: true, races: [] }),
    namespace: undefined as never,
    calls: () => f.names.length + f.lists.length,
  };
  (f as { namespace: Env["RACE_DAY"] }).namespace = {
    idFromName: (name: string) => {
      f.names.push(name);
      return name;
    },
    get: () =>
      ({
        getRaceList: (kaisaiDate: string, venue: RaceListVenue) => {
          f.lists.push({ kaisaiDate, venue });
          return f.impl(kaisaiDate, venue);
        },
      }) as never,
  };
  return f;
}

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function envOf(raceDay: FakeRaceDay): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: raceDay.namespace,
  };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const stranger = await signToken(key, { email: "stranger@example.com" });
  return { deps, token, stranger };
}

function get(path: string, init: { token?: string; method?: string; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers });
}

const GOOD = `/api/races?kaisai_date=${DATE}&venue=central`;

describe("GET /api/races(Issue #183)", () => {
  it("正しい入力は 200。日単位の DO(名前は開催日)を1回引き、getRaceList を(開催日, venue)で1回だけ呼ぶ", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(get(GOOD, { token }), envOf(raceDay), {}, deps);
    expect(response.status).toBe(200);
    expect(raceDay.names).toEqual([DATE]);
    expect(raceDay.lists).toEqual([{ kaisaiDate: DATE, venue: "central" }]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, kaisai_date: DATE, venue: "central", races: [] });
    // 地方
    const nar = fakeRaceDay();
    await handle(get(`/api/races?venue=nar&kaisai_date=20260927`, { token }), envOf(nar), {}, deps);
    expect(nar.names).toEqual(["20260927"]);
    expect(nar.lists).toEqual([{ kaisaiDate: "20260927", venue: "nar" }]);
  });

  it("整形: snake_case・undefined は null・並びは race_id の昇順(場 → R)。DO が逆順・場が入り混じった順で返しても揃える", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const a = entry("202603020211", { grade: undefined, venue: "福島" });
    const b = entry("202603020212", { grade: "G3", venue: "福島" });
    const c = entry("202610020301", { venue: undefined, courseType: "ダ", distance: 1200, entryCount: 9 });
    const d = entry("202602010109", { venue: "函館" });
    // 入れ替わった順(場も R も)で返す
    raceDay.impl = async () => ({ ok: true, races: [b, c, a, d] });
    const response = await handle(get(GOOD, { token }), envOf(raceDay), {}, deps);
    const body = (await response.json()) as { races: Record<string, unknown>[] };
    expect(body.races.map((r) => r["race_id"])).toEqual(["202602010109", "202603020211", "202603020212", "202610020301"]);
    expect(body.races[1]).toEqual({ race_id: "202603020211", venue_name: "福島", race_number: 11, race_name: "レース11", course_type: "芝", distance: 1600, entry_count: 16, grade: null });
    expect(body.races[2]!["grade"]).toBe("G3");
    expect(body.races[3]).toEqual({ race_id: "202610020301", venue_name: null, race_number: 1, race_name: "レース01", course_type: "ダ", distance: 1200, entry_count: 9, grade: null });
    // 余計なキーを返さない(RaceListEntry をそのまま写していない)
    for (const row of body.races) {
      expect(Object.keys(row).sort()).toEqual(["course_type", "distance", "entry_count", "grade", "race_id", "race_name", "race_number", "venue_name"]);
    }
  });

  it("開催なしの日(空の一覧)は 200 で races: []", async () => {
    const { deps, token } = await setup();
    const raceDay = fakeRaceDay();
    const response = await handle(get(GOOD, { token }), envOf(raceDay), {}, deps);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { races: unknown[] }).races).toEqual([]);
    expect(raceDay.lists).toHaveLength(1); // 前提: DO は実際に呼ばれた
  });

  describe("認証(Access の関門の後ろ)", () => {
    it.each([
      ["JWT なし", undefined],
      ["壊れた JWT", "a.b.c"],
    ])("%s は 403(固定の本文)で、DO を呼ばない", async (_name, badToken) => {
      const { deps } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(get(GOOD, badToken === undefined ? {} : { token: badToken }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
      expect(raceDay.calls()).toBe(0);
    });

    it("許可メール以外は 403 で、DO を呼ばない", async () => {
      const { deps, stranger } = await setup();
      const raceDay = fakeRaceDay();
      expect((await handle(get(GOOD, { token: stranger }), envOf(raceDay), {}, deps)).status).toBe(403);
      expect(raceDay.calls()).toBe(0);
    });
  });

  describe("メソッドとパス", () => {
    it("HEAD は 405(Allow: GET)。取得を起こさない(DO 0 回)。POST も 405(DO 0 回)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const head = await handle(get(GOOD, { token, method: "HEAD" }), envOf(raceDay), {}, deps);
      expect(head.status).toBe(405);
      expect(head.headers.get("allow")).toBe("GET");
      const post = await handle(get(GOOD, { token, method: "POST" }), envOf(raceDay), {}, deps);
      expect(post.status).toBe(405);
      expect(raceDay.calls()).toBe(0);
    });

    it("パスは厳密(末尾スラッシュ・下位パス・別名は 404。DO 0 回)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      for (const path of ["/api/races/", "/api/races/1", "/api/racesx"]) {
        expect((await handle(get(`${path}?kaisai_date=${DATE}&venue=central`, { token }), envOf(raceDay), {}, deps)).status, path).toBe(404);
      }
      expect(raceDay.calls()).toBe(0);
    });
  });

  describe("入力の検証(400。DO を呼ばない)", () => {
    it.each([
      ["kaisai_date が無い", "/api/races?venue=central"],
      ["venue が無い", `/api/races?kaisai_date=${DATE}`],
      ["クエリが無い", "/api/races"],
      ["kaisai_date が 7 桁", "/api/races?kaisai_date=2026062&venue=central"],
      ["kaisai_date が 9 桁", "/api/races?kaisai_date=202606280&venue=central"],
      ["kaisai_date が英字", "/api/races?kaisai_date=2026abcd&venue=central"],
      ["kaisai_date が存在しない月", "/api/races?kaisai_date=20261340&venue=central"],
      ["kaisai_date が存在しない日", "/api/races?kaisai_date=20260231&venue=central"],
      ["kaisai_date が空", "/api/races?kaisai_date=&venue=central"],
      ["venue が未知", `/api/races?kaisai_date=${DATE}&venue=foo`],
      ["venue が大文字", `/api/races?kaisai_date=${DATE}&venue=Central`],
      ["venue が空", `/api/races?kaisai_date=${DATE}&venue=`],
      ["未知のクエリ", `/api/races?kaisai_date=${DATE}&venue=central&x=1`],
      ["kaisai_date の重複", `/api/races?kaisai_date=${DATE}&kaisai_date=${DATE}&venue=central`],
      ["venue の重複", `/api/races?kaisai_date=${DATE}&venue=central&venue=central`],
      ["venue の重複(別の値)", `/api/races?kaisai_date=${DATE}&venue=central&venue=nar`],
    ])("%s は 400", async (_name, path) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(get(path, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: { type: string } };
      expect(body.ok).toBe(false);
      expect(body.error.type).toBe("bad-request");
      expect(raceDay.calls()).toBe(0);
    });

    it("長い入力はメッセージに先頭だけを写す(入力の全文を返さない)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const long = "9".repeat(500);
      const response = await handle(get(`/api/races?kaisai_date=${long}&venue=central`, { token }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(400);
      expect((await response.text()).length).toBeLessThan(400);
      expect(raceDay.calls()).toBe(0);
    });
  });

  describe("Sec-Fetch-Site(GET が netkeiba に出るので、別サイトのページからの呼び出しを拒否する。Issue #183 D5)", () => {
    it.each([["cross-site"], ["same-site"], ["bogus"]])("Sec-Fetch-Site: %s は 403 origin-mismatch で、DO を呼ばない", async (site) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(get(GOOD, { token, headers: { "Sec-Fetch-Site": site } }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
      expect(raceDay.calls()).toBe(0);
    });

    it.each([["same-origin"], ["none"]])("Sec-Fetch-Site: %s は通る", async (site) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(get(GOOD, { token, headers: { "Sec-Fetch-Site": site } }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(200);
      expect(raceDay.lists).toHaveLength(1);
    });

    it("ヘッダが無い(curl 等の非ブラウザ)は通る", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      expect((await handle(get(GOOD, { token }), envOf(raceDay), {}, deps)).status).toBe(200);
    });

    it("不正な入力で Sec-Fetch-Site も不正なら、403 を先に返す(DO 0 回)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const response = await handle(get("/api/races?venue=foo", { token, headers: { "Sec-Fetch-Site": "cross-site" } }), envOf(raceDay), {}, deps);
      expect(response.status).toBe(403);
      expect(raceDay.calls()).toBe(0);
    });
  });

  describe("失敗(503。文面を返さない)", () => {
    const SECRET = "SECRET-internal-detail-12345";

    it("DO が throw したら 503 race-day-error。例外の文面・スタックを返さない", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.impl = async () => {
        throw new Error(SECRET);
      };
      const response = await handle(get(GOOD, { token }), envOf(raceDay), {}, deps);
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "race-day-error" } });
      expect(text).not.toContain(SECRET);
    });

    it("idFromName が throw しても 503 race-day-error(DO の取得自体の失敗)", async () => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      const env = envOf(raceDay);
      const broken: Env = {
        ...env,
        RACE_DAY: {
          idFromName: () => {
            throw new Error(SECRET);
          },
          get: NOT_CALLED,
        },
      };
      const response = await handle(get(GOOD, { token }), broken, {}, deps);
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "race-day-error" } });
    });

    it.each([["blocked"], ["busy"], ["failed"]] as const)("取得の失敗 %s は 503 netkeiba-unavailable と reason(gate の文面は載せない)", async (reason) => {
      const { deps, token } = await setup();
      const raceDay = fakeRaceDay();
      raceDay.impl = async () => ({ ok: false, reason, message: SECRET }) as unknown as RaceListResult;
      const response = await handle(get(GOOD, { token }), envOf(raceDay), {}, deps);
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "netkeiba-unavailable", reason } });
      expect(text).not.toContain(SECRET);
      expect(response.headers.get("retry-after")).toBeNull();
    });
  });
});
