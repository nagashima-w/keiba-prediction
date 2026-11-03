import { describe, expect, it } from "vitest";
import { assertReadOnlySql, ReadonlyCloudflare, asReadonlyBucket, asReadonlyD1 } from "../cf-readonly-client";

/**
 * Issue #586・#587: 手元の開発用の道具が Cloudflare の REST を叩く窓口。**読み取り専用の守りが最重要**。
 * SQL は SELECT(と WITH ... SELECT)だけを通し、HTTP は「D1 の query への POST」と「R2 のオブジェクトの GET」だけを通す。
 * 実ネットワークには出ない(fetch は偽物)。
 */

describe("assertReadOnlySql: 書き込みの文を通さない", () => {
  const ok: Array<[string, string]> = [
    ["素の SELECT", "SELECT 1"],
    ["小文字", "select race_id from race_archive"],
    ["先頭の空白・改行", "  \n\t SELECT 1"],
    ["先頭の行コメント", "-- 説明\nSELECT 1"],
    ["先頭のブロックコメント", "/* 説明 */ SELECT 1"],
    ["末尾の ;", "SELECT 1;"],
    ["WITH ... SELECT", "WITH t AS (SELECT 1 AS a) SELECT a FROM t"],
    ["列名に予約語を含む(updated_at・deleted)", "SELECT updated_at, deleted FROM x WHERE y = ?"],
    ["文字列リテラルの中の予約語", "SELECT * FROM x WHERE name = 'DELETE FROM y'"],
    ["json_each の IN", "SELECT a FROM t WHERE id IN (SELECT value FROM json_each(?))"],
  ];
  for (const [name, sql] of ok) {
    it(`通す: ${name}`, () => {
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    });
  }

  const ng: Array<[string, string]> = [
    ["INSERT", "INSERT INTO t VALUES (1)"],
    ["小文字の insert", "insert into t values (1)"],
    ["UPDATE", "UPDATE t SET a = 1"],
    ["DELETE", "DELETE FROM t"],
    ["DROP", "DROP TABLE t"],
    ["CREATE", "CREATE TABLE t (a)"],
    ["ALTER", "ALTER TABLE t ADD COLUMN b"],
    ["REPLACE", "REPLACE INTO t VALUES (1)"],
    ["PRAGMA", "PRAGMA table_info(t)"],
    ["ATTACH", "ATTACH DATABASE 'x' AS y"],
    ["VACUUM", "VACUUM"],
    ["先頭に空白を置いた DELETE", "   \n DELETE FROM t"],
    ["コメントの後ろの DELETE", "-- SELECT 1\nDELETE FROM t"],
    ["ブロックコメントの後ろの DELETE", "/* SELECT */ DELETE FROM t"],
    ["複数の文(SELECT ; DELETE)", "SELECT 1; DELETE FROM t"],
    ["複数の文(SELECT ; SELECT)", "SELECT 1; SELECT 2"],
    ["WITH の後に書き込み", "WITH t AS (SELECT 1) DELETE FROM x WHERE a IN (SELECT * FROM t)"],
    ["WITH の後に INSERT", "WITH t AS (SELECT 1 AS a) INSERT INTO x SELECT a FROM t"],
    ["SELECT の中に INSERT が混ざる", "SELECT 1 FROM (INSERT INTO t VALUES (1))"],
    ["終わっていないブロックコメント", "SELECT 1 /* DELETE"],
    ["終わっていない文字列", "SELECT 'abc"],
    ["空", ""],
    ["コメントだけ", "-- SELECT 1"],
    ["EXPLAIN", "EXPLAIN SELECT 1"],
  ];
  for (const [name, sql] of ng) {
    it(`拒否する: ${name}`, () => {
      expect(() => assertReadOnlySql(sql)).toThrow();
    });
  }
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly auth: string | undefined;
}

function fakeFetch(handler: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, auth: headers.get("authorization") ?? undefined };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const d1Ok = (results: unknown[], meta: Record<string, unknown> = { rows_read: 1 }): Response =>
  new Response(JSON.stringify({ success: true, errors: [], result: [{ results, meta }] }), { status: 200 });

function client(f: typeof fetch, sleeps: number[] = [], over: Partial<ConstructorParameters<typeof ReadonlyCloudflare>[0]> = {}): ReadonlyCloudflare {
  let t = 0;
  return new ReadonlyCloudflare({ accountId: "ACC", databaseId: "DB1", bucket: "BKT", token: "TOKEN", fetch: f, sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, minIntervalMs: 300, retryBaseMs: 5000, ...over });
}

describe("ReadonlyCloudflare: HTTP は読み取りの 2 種類だけ", () => {
  it("query は D1 の query に POST し、sql と params を送る。鍵は Authorization に付く", async () => {
    const { fetch: f, calls } = fakeFetch(() => d1Ok([{ a: 1 }], { rows_read: 7 }));
    const r = await client(f).query("SELECT a FROM t WHERE b = ?", ["x"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/ACC/d1/database/DB1/query");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sql: "SELECT a FROM t WHERE b = ?", params: ["x"] });
    expect(calls[0]!.auth).toBe("Bearer TOKEN");
    expect(r.results).toEqual([{ a: 1 }]);
    expect(r.meta.rows_read).toBe(7);
  });

  it("書き込みの SQL は、HTTP を送る前に拒否する(fetch は 1 回も呼ばれない)", async () => {
    const { fetch: f, calls } = fakeFetch(() => d1Ok([]));
    await expect(client(f).query("DELETE FROM race_archive", [])).rejects.toThrow();
    await expect(client(f).query("SELECT 1; DELETE FROM race_archive", [])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("getObject は GET で、鍵をエンコードして送る。404 は null。200 は生のバイト列", async () => {
    const body = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    const { fetch: f, calls } = fakeFetch((c) => (c.url.endsWith("missing.json.gz") ? new Response("", { status: 404 }) : new Response(body, { status: 200 })));
    const c = client(f);
    const got = await c.getObject("race-results/1.json.gz");
    expect(got).toEqual(body);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/ACC/r2/buckets/BKT/objects/race-results%2F1.json.gz");
    expect(await c.getObject("race-results/missing.json.gz")).toBeNull();
  });

  it("D1 の失敗(success: false)は例外。応答の本文に鍵は含まれない想定だが、例外にも鍵を入れない", async () => {
    const { fetch: f } = fakeFetch(() => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "boom" }], result: [] }), { status: 200 }));
    const err = await client(f).query("SELECT 1", []).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("boom");
    expect((err as Error).message).not.toContain("TOKEN");
  });

  it("要求の間隔: 連続する要求は minIntervalMs ずつあける(同時に出しても重ならない)", async () => {
    const { fetch: f } = fakeFetch(() => d1Ok([]));
    const sleeps: number[] = [];
    const c = client(f, sleeps, { now: () => 0 }); // 時計を進めない(同時に出した 3 つの要求が、同じ時刻に枠を取る)
    await Promise.all([c.query("SELECT 1", []), c.query("SELECT 2", []), c.query("SELECT 3", [])]);
    expect(sleeps).toEqual([300, 600]);
    expect(c.requests).toBe(3);
  });

  it("429 は待って再試行する(待ちは 5 秒・10 秒…)。上限を超えたら例外", async () => {
    let n = 0;
    const { fetch: f, calls } = fakeFetch(() => (++n <= 2 ? new Response("", { status: 429 }) : d1Ok([{ ok: 1 }])));
    const sleeps: number[] = [];
    const r = await client(f, sleeps).query("SELECT 1", []);
    expect(r.results).toEqual([{ ok: 1 }]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toContain(5000);
    expect(sleeps).toContain(10000);

    const always = fakeFetch(() => new Response("", { status: 503 }));
    await expect(client(always.fetch, [], { maxRetries: 2 }).getObject("k")).rejects.toThrow();
    expect(always.calls).toHaveLength(3);
  });

  it("404 以外の 4xx(403 など)は再試行せず、すぐ例外", async () => {
    const { fetch: f, calls } = fakeFetch(() => new Response("", { status: 403 }));
    await expect(client(f).getObject("k")).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });
});

describe("D1・R2 の窓口(既存のストアに差し込む形)", () => {
  it("prepare().bind().all() は SELECT を送って results と meta を返す。first は先頭の行", async () => {
    const { fetch: f, calls } = fakeFetch(() => d1Ok([{ a: 1 }, { a: 2 }]));
    const db = asReadonlyD1(client(f));
    const all = await db.prepare("SELECT a FROM t WHERE b = ?").bind("x").all<{ a: number }>();
    expect(all.results).toEqual([{ a: 1 }, { a: 2 }]);
    expect(all.meta.rows_read).toBe(1);
    expect(await db.prepare("SELECT a FROM t").first<{ a: number }>()).toEqual({ a: 1 });
    expect(JSON.parse(calls[0]!.body!).params).toEqual(["x"]);
  });

  it("run() と、書き込みの文の batch は例外(HTTP を送らない)", async () => {
    const { fetch: f, calls } = fakeFetch(() => d1Ok([]));
    const db = asReadonlyD1(client(f));
    await expect(db.prepare("SELECT 1").run()).rejects.toThrow();
    await expect(db.batch([db.prepare("SELECT 1"), db.prepare("INSERT INTO t VALUES (1)")])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("batch は SELECT を順に送って結果の配列を返す", async () => {
    const { fetch: f } = fakeFetch(() => d1Ok([{ a: 1 }]));
    const db = asReadonlyD1(client(f));
    const rs = await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]);
    expect(rs).toHaveLength(2);
    expect(rs[1]!.results).toEqual([{ a: 1 }]);
  });

  it("R2 の窓口: get は arrayBuffer を返し、無ければ null。put は例外(HTTP を送らない)", async () => {
    const { fetch: f, calls } = fakeFetch((c) => (c.url.endsWith("none") ? new Response("", { status: 404 }) : new Response(new Uint8Array([9, 8]), { status: 200 })));
    const bucket = asReadonlyBucket(client(f));
    const obj = await bucket.get("a/b");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(new Uint8Array([9, 8]));
    expect(await bucket.get("none")).toBeNull();
    const before = calls.length;
    await expect(bucket.put()).rejects.toThrow();
    expect(calls).toHaveLength(before);
  });
});
