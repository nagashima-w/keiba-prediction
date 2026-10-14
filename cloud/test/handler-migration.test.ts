import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { MIGRATION_UPLOAD_MAX_BYTES } from "../src/handler";
import type { MigrationStatus, StartResult } from "../src/migration-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #216(#167-B1): 移行ファイルの受け取り `POST /api/migration/upload` と、進捗 `GET /api/migration`。
 * Worker は本文を解釈せず、R2 に**そのまま**置いて、移行の DO(`CloudMigration`)に取り込みを頼むだけ。順序: 認証 → Origin(403)→ Content-Type(415)→ Content-Length(411・413)→
 * 取り込み中でないか(409。本文を読まない)→ R2 の書き込みの柵(503)→ R2 に置く → 柵のカウンタ → DO(受け付けなければ置いたファイルを消して 409)。
 * DO・R2・D1 は偽物(呼び出しを記録する)。netkeiba にも LLM にも出ない。
 */

const ORIGIN = "https://cloud.invalid";
const CLASS_A_LIMIT = 100_000;

const IDLE: MigrationStatus = {
  state: "idle",
  upload: null,
  analyses: { total: null, processed: 0, imported: 0, alreadyImported: 0, conflicts: 0 },
  results: { total: null, processed: 0 },
  resumeAt: null,
  failure: null,
  conflictSamples: [],
  attempts: 0,
  budget: { day: "20261006", usedRows: 0, limitRows: 60000 },
  verified: null,
  lastTick: null,
  updatedAt: null,
};

interface Harness {
  readonly names: string[];
  readonly starts: { key: string; size: number }[];
  readonly puts: { key: string; bytes: number; contentType: string | undefined }[];
  readonly deletes: string[];
  readonly sql: string[];
  status: MigrationStatus;
  usage: { classA: number; classB: number };
  startResult: StartResult;
  startFails: boolean;
  statusFails: boolean;
  putFails: boolean;
  env(): Env;
}

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function harness(): Harness {
  const h: Harness = {
    names: [],
    starts: [],
    puts: [],
    deletes: [],
    sql: [],
    status: IDLE,
    usage: { classA: 0, classB: 0 },
    startResult: { accepted: true },
    startFails: false,
    statusFails: false,
    putFails: false,
    env: () => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
      RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => {
              h.sql.push(sql);
              return h.usage;
            },
            run: async () => {
              h.sql.push(sql);
              return { success: true };
            },
          }),
        }),
        batch: NOT_CALLED,
      } as unknown as Env["DB"],
      ANALYSIS_DETAIL: {
        get: NOT_CALLED,
        put: async (key: string, body: ReadableStream<Uint8Array>, options?: { httpMetadata?: { contentType?: string } }) => {
          if (h.putFails) throw new Error("R2 の詳細 SECRET-R2");
          let bytes = 0;
          const reader = body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
          }
          h.puts.push({ key, bytes, contentType: options?.httpMetadata?.contentType });
        },
        delete: async (key: string) => void h.deletes.push(key),
      } as unknown as Env["ANALYSIS_DETAIL"],
      CLOUD_MIGRATION: {
        idFromName: (name: string) => {
          h.names.push(name);
          return name;
        },
        get: () => ({
          getStatus: async () => {
            if (h.statusFails) throw new Error("DO の詳細 SECRET-DO");
            return h.status;
          },
          start: async (input: { key: string; size: number }) => {
            if (h.startFails) throw new Error("DO の詳細 SECRET-DO");
            h.starts.push(input);
            return h.startResult;
          },
        }),
      },
    }),
  };
  return h;
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  return { deps, token };
}

const BODY = new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4, 5, 6, 7, 8]);

function upload(init: { token?: string; origin?: string | null; contentType?: string | null; length?: string | null; body?: Uint8Array } = {}): Request {
  const headers = new Headers();
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("Origin", origin);
  const contentType = init.contentType === undefined ? "application/gzip" : init.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  const body = init.body ?? BODY;
  const length = init.length === undefined ? String(body.byteLength) : init.length;
  if (length !== null) headers.set("Content-Length", length);
  return new Request(`${ORIGIN}/api/migration/upload`, { method: "POST", headers, body });
}

describe("POST /api/migration/upload: 正常系", () => {
  it("本文を R2 にそのまま置き(キーは migration/ 配下で毎回別)、DO に取り込みを頼んで 202。応答は進捗", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const res = await handle(upload({ token }), h.env(), {}, deps);
    expect(res.status).toBe(202);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.key).toMatch(/^migration\/[0-9a-f-]{36}\.ndjson\.gz$/);
    expect(h.puts[0]!.bytes).toBe(BODY.byteLength); // 解釈せず、そのまま
    expect(h.puts[0]!.contentType).toBe("application/gzip");
    expect(h.starts).toEqual([{ key: h.puts[0]!.key, size: BODY.byteLength }]);
    expect(h.names).toEqual(["main"]); // 移行の DO は単一インスタンス
    expect(h.deletes).toEqual([]);
    expect(await res.json()).toEqual({ ok: true, ...IDLE });
    // R2 の書き込み(Class A)を 1 回数える(D1 の r2_ops の更新)。
    expect(h.sql.filter((s) => /INSERT INTO r2_ops/.test(s))).toHaveLength(1);
  });

  it("2回のアップロードは別のキーに置かれる(取り込み中のファイルを上書きしない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    await handle(upload({ token }), h.env(), {}, deps);
    await handle(upload({ token }), h.env(), {}, deps);
    expect(new Set(h.puts.map((p) => p.key)).size).toBe(2);
  });

  it("Content-Type は application/gzip・application/x-gzip・application/octet-stream を受ける", async () => {
    const { deps, token } = await setup();
    for (const contentType of ["application/gzip", "application/x-gzip", "application/octet-stream", "application/gzip; charset=binary"]) {
      const h = harness();
      expect((await handle(upload({ token, contentType }), h.env(), {}, deps)).status, contentType).toBe(202);
    }
  });
});

describe("POST /api/migration/upload: 拒否(裏側に触れる前)", () => {
  it("認証が無ければ 403(DO・R2・D1 に触れない)", async () => {
    const { deps } = await setup();
    const h = harness();
    const res = await handle(upload({}), h.env(), {}, deps);
    expect(res.status).toBe(403);
    expect(h.puts).toEqual([]);
    expect(h.names).toEqual([]);
  });

  it("Origin が無い・違う → 403 origin-mismatch", async () => {
    const { deps, token } = await setup();
    for (const origin of [null, "https://evil.invalid"]) {
      const h = harness();
      const res = await handle(upload({ token, origin }), h.env(), {}, deps);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { type: "origin-mismatch" } });
      expect(h.puts).toEqual([]);
      expect(h.names).toEqual([]);
    }
  });

  it("Content-Type が gzip/octet-stream 以外(JSON など)→ 415", async () => {
    const { deps, token } = await setup();
    for (const contentType of ["application/json", "text/plain", null]) {
      const h = harness();
      expect((await handle(upload({ token, contentType }), h.env(), {}, deps)).status, String(contentType)).toBe(415);
      expect(h.puts).toEqual([]);
    }
  });

  it("Content-Length が無い・数字でない・0 → 411", async () => {
    const { deps, token } = await setup();
    for (const length of [null, "abc", "0", "-5", "1.5"]) {
      const h = harness();
      expect((await handle(upload({ token, length }), h.env(), {}, deps)).status, String(length)).toBe(411);
      expect(h.puts).toEqual([]);
      expect(h.names).toEqual([]);
    }
  });

  it("宣言の大きさが上限(50MB)を超える → 413(本文を読まず、DO も R2 も呼ばない)。ちょうど上限は通る", async () => {
    const { deps, token } = await setup();
    expect(MIGRATION_UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024);
    const over = harness();
    const res = await handle(upload({ token, length: String(MIGRATION_UPLOAD_MAX_BYTES + 1) }), over.env(), {}, deps);
    expect(res.status).toBe(413);
    expect(over.puts).toEqual([]);
    expect(over.names).toEqual([]);
    // 対照: 上限ちょうどの宣言は検査を通る(その先の R2 の put は、宣言と実際の長さが違うだけの偽物なので 202 になる)
    const exact = harness();
    expect((await handle(upload({ token, length: String(MIGRATION_UPLOAD_MAX_BYTES) }), exact.env(), {}, deps)).status).toBe(202);
  });

  it("取り込み中(DO が busy の状態)→ 409。**本文を R2 に置かない**", async () => {
    const { deps, token } = await setup();
    for (const state of ["verifying", "importing", "waiting-budget", "waiting-r2"] as const) {
      const h = harness();
      h.status = { ...IDLE, state };
      const res = await handle(upload({ token }), h.env(), {}, deps);
      expect(res.status, state).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: { type: "migration-busy" } });
      expect(h.puts, state).toEqual([]);
      expect(h.starts).toEqual([]);
    }
    // 対照: 完了・失敗のあとは受け付ける
    for (const state of ["completed", "failed", "idle"] as const) {
      const h = harness();
      h.status = { ...IDLE, state };
      expect((await handle(upload({ token }), h.env(), {}, deps)).status, state).toBe(202);
    }
  });

  it("R2 の書き込み(Class A)が柵に達している → 503 r2-fence。R2 に置かない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.usage = { classA: CLASS_A_LIMIT, classB: 0 };
    const res = await handle(upload({ token }), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { type: "r2-fence" } });
    expect(h.puts).toEqual([]);
    expect(h.starts).toEqual([]);
  });
});

describe("POST /api/migration/upload: 失敗の扱い", () => {
  it("DO が受け付けなかった(置いたあとに別のアップロードが先に受け付けられた)→ 置いたファイルを消して 409", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.startResult = { accepted: false, reason: "busy" };
    const res = await handle(upload({ token }), h.env(), {}, deps);
    expect(res.status).toBe(409);
    expect(h.puts).toHaveLength(1);
    expect(h.deletes).toEqual([h.puts[0]!.key]);
  });

  it("DO の呼び出しが例外 → 置いたファイルを消して 503。例外の文面を返さない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.startFails = true;
    const res = await handle(upload({ token }), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("SECRET");
    expect(h.deletes).toEqual([h.puts[0]!.key]);
  });

  it("R2 への書き込みが例外 → 503。DO を呼ばない・文面を返さない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.putFails = true;
    const res = await handle(upload({ token }), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("SECRET");
    expect(h.starts).toEqual([]);
  });

  it("状態の確認(DO)が例外 → 503。R2 に置かない", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.statusFails = true;
    const res = await handle(upload({ token }), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(h.puts).toEqual([]);
  });
});

describe("GET /api/migration: 進捗", () => {
  it("DO の状態をそのまま返す(状態・件数・予算・再開時刻・失敗の理由)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    h.status = { ...IDLE, state: "waiting-budget", resumeAt: "2026-10-07T00:05:00.000Z", analyses: { total: 2225, processed: 300, imported: 290, alreadyImported: 10, conflicts: 0 } };
    const res = await handle(new Request(`${ORIGIN}/api/migration`, { headers: { "Cf-Access-Jwt-Assertion": token } }), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...h.status });
    expect(h.names).toEqual(["main"]);
  });

  it("認証が無ければ 403・DO に触れない。DO の失敗は 503(文面を返さない)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    expect((await handle(new Request(`${ORIGIN}/api/migration`), h.env(), {}, deps)).status).toBe(403);
    expect(h.names).toEqual([]);
    h.statusFails = true;
    const res = await handle(new Request(`${ORIGIN}/api/migration`, { headers: { "Cf-Access-Jwt-Assertion": token } }), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("SECRET");
  });

  it("メソッド: /api/migration は GET だけ(POST・PUT は 405)。/api/migration/upload は POST だけ(GET は 405)", async () => {
    const { deps, token } = await setup();
    const h = harness();
    const auth = { "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN };
    const post = await handle(new Request(`${ORIGIN}/api/migration`, { method: "POST", headers: auth, body: "{}" }), h.env(), {}, deps);
    expect(post.status).toBe(405);
    const get = await handle(new Request(`${ORIGIN}/api/migration/upload`, { headers: auth }), h.env(), {}, deps);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(h.names).toEqual([]);
    expect(h.puts).toEqual([]);
  });
});
