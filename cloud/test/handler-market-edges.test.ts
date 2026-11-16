import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #644: `GET /api/market-edges?kind=jockey|trainer`(騎手・調教師の指標の一覧)。D1 の読み取りだけ(`readEdges` と `readMeta`。新しい SQL は無い)。
 * 順序: メソッド(GET だけ)→ Sec-Fetch-Site → クエリの検証(400。ここまでで D1 は呼ばない)→ D1(失敗は 503・文面なし)。閲覧者にも開く(GET だけ)。
 */

const ORIGIN = "https://cloud.invalid";
type Row = Record<string, unknown>;

interface FakeDb {
  readonly sqls: string[];
  readonly binds: unknown[][];
  edges: Row[];
  meta: Row | null;
  fail: boolean;
  db: Env["DB"];
}

function fakeDb(): FakeDb {
  const f: FakeDb = {
    sqls: [],
    binds: [],
    edges: [
      { id: "a", name: "甲", n: 100, edge: 0.01, hitRate: 0.3, predMean: 0.29, computedOn: "2026-11-16" },
      { id: "b", name: "乙", n: 40, edge: 0.03, hitRate: 0.35, predMean: 0.31, computedOn: "2026-11-16" },
    ],
    meta: { computedOn: "2026-11-16", windowFrom: "2024-11-17", windowTo: "2026-11-15", coefJson: "[1,2,3]", converged: 1, iterations: 5, races: 10, horses: 100 },
    fail: false,
    db: undefined as never,
  };
  f.db = {
    prepare: (sql: string) => {
      f.sqls.push(sql);
      const st = {
        bind: (...args: unknown[]) => {
          f.binds.push(args);
          return st;
        },
        all: async () => {
          if (f.fail) throw new Error("D1_ERROR: injected");
          return { results: f.edges };
        },
        first: async () => {
          if (f.fail) throw new Error("D1_ERROR: injected");
          return f.meta;
        },
      };
      return st;
    },
  } as unknown as Env["DB"];
  return f;
}

function envOf(db: FakeDb): Env {
  return { ...GOOD_ENV, DB: db.db } as Env;
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const exp = Math.floor(NOW.getTime() / 1000) + 3600;
  return { deps, token: await signToken(key, { exp }), viewer: await signToken(key, { email: "stranger@example.com", exp }) };
}

function req(path: string, token?: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers });
}

describe("GET /api/market-edges(Issue #644)", () => {
  it("200: 指標の大きい順の行・注記・kind を返す。キャッシュしない。読むのは readEdges の 1 文と readMeta の 1 文(新しい SQL なし)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    const r = await handle(req("/api/market-edges?kind=jockey", token), envOf(db), {}, deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { ok: boolean; kind: string; note: string; rows: Row[] };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("jockey");
    expect(body.rows).toEqual([
      { name: "乙", edge: 0.03, n: 40, hit_rate: 0.35, pred_mean: 0.31 },
      { name: "甲", edge: 0.01, n: 100, hit_rate: 0.3, pred_mean: 0.29 },
    ]);
    expect(body.note).toContain("参考(確かめ中)");
    expect(db.sqls).toHaveLength(2);
    expect(db.binds[0]).toEqual(["jockey"]);
  });

  it("kind=trainer は調教師を読む(騎手の取り違えを許さない)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    const r = await handle(req("/api/market-edges?kind=trainer", token), envOf(db), {}, deps);
    expect(r.status).toBe(200);
    expect(db.binds[0]).toEqual(["trainer"]);
    expect(((await r.json()) as { kind: string }).kind).toBe("trainer");
  });

  it("閲覧者にも 200(GET だけ開く)", async () => {
    const { deps, viewer } = await setup();
    const r = await handle(req("/api/market-edges?kind=jockey", viewer), envOf(fakeDb()), {}, deps);
    expect(r.status).toBe(200);
  });

  it("閲覧者の HEAD は 403(管理者専用のまま)で、D1 を呼ばない", async () => {
    const { deps, viewer } = await setup();
    const db = fakeDb();
    const r = await handle(req("/api/market-edges?kind=jockey", viewer, { method: "HEAD" }), envOf(db), {}, deps);
    expect(r.status).toBe(403);
    expect(db.sqls).toEqual([]);
  });

  it("管理者の HEAD・POST は 405(D1 を呼ばない)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    for (const method of ["HEAD", "POST"]) {
      const r = await handle(req("/api/market-edges?kind=jockey", token, { method }), envOf(db), {}, deps);
      expect(r.status).toBe(405);
    }
    expect(db.sqls).toEqual([]);
  });

  it("認証なしは 403", async () => {
    const { deps } = await setup();
    const db = fakeDb();
    const r = await handle(req("/api/market-edges?kind=jockey"), envOf(db), {}, deps);
    expect(r.status).toBe(403);
    expect(db.sqls).toEqual([]);
  });

  it.each(["/api/market-edges", "/api/market-edges?kind=", "/api/market-edges?kind=horse", "/api/market-edges?kind=JOCKEY", "/api/market-edges?kind=jockey&kind=trainer", "/api/market-edges?kind=jockey&x=1", "/api/market-edges?x=1"])(
    "kind が無い・不正・重複・未知のキーは 400 で、D1 を呼ばない: %s",
    async (path) => {
      const { deps, token } = await setup();
      const db = fakeDb();
      const r = await handle(req(path, token), envOf(db), {}, deps);
      expect(r.status).toBe(400);
      expect(db.sqls).toEqual([]);
    },
  );

  it("別サイトからの GET は 403(D1 を呼ばない)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    const r = await handle(req("/api/market-edges?kind=jockey", token, { headers: { "Sec-Fetch-Site": "cross-site" } }), envOf(db), {}, deps);
    expect(r.status).toBe(403);
    expect(db.sqls).toEqual([]);
  });

  it("D1 の失敗は 503 の固定の型(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    db.fail = true;
    const r = await handle(req("/api/market-edges?kind=jockey", token), envOf(db), {}, deps);
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "d1-error" } });
    expect(text).not.toContain("injected");
  });

  it("meta が無いとき(計算前)は rows が空で、「まだ計算していません」の文", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    db.meta = null;
    const r = await handle(req("/api/market-edges?kind=jockey", token), envOf(db), {}, deps);
    const body = (await r.json()) as { ok: boolean; rows: Row[]; note: string };
    expect(r.status).toBe(200);
    expect(body.rows).toEqual([]);
    expect(body.note).toContain("まだ計算していません");
  });
});
