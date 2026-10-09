import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchMigration, postMigrationUpload } from "../client/api-migration";
import { handle, MIGRATION_UPLOAD_MAX_BYTES, type Env } from "../src/handler";
import type { MigrationStatus } from "../src/migration-core";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #222(#167-B2): 契約テスト。クライアントの `fetchMigration`・`postMigrationUpload` が送るリクエストを、実際の `handle()`(偽の DO・R2・D1)に通し、
 * 本物の応答をクライアントの分類に通す。サーバ側のキー名・状態名(`MigrationStatus`〈型で検査〉)・Origin と Content-Length の要求・409/413/503 の形が変わると、ここで検出する。
 * ブラウザが付けるヘッダ(Origin。Blob 本文の Content-Length)は、ブラウザが付ける値を模して付ける(`Request` は Content-Length を自動では付けない)。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

const WORKING: MigrationStatus = {
  state: "importing",
  upload: { size: 1234, uploadedAt: "2026-10-09T01:02:03.000Z", exportedAt: "2026-10-08T00:00:00.000Z", appVersion: "1.27.0" },
  analyses: { total: 2225, processed: 100, imported: 90, alreadyImported: 8, conflicts: 2 },
  results: { total: 1301, processed: 0 },
  resumeAt: "2026-10-10T00:05:00.000Z",
  failure: { phase: "import", message: "エラーが続いたため止めました(Error)。" },
  conflictSamples: ["analysis.id=7: race_id が違う"],
  attempts: 1,
  budget: { day: "20261009", usedRows: 1234, limitRows: 60000 },
  verified: { bytes: 1, lines: 2, ms: 3 },
  lastTick: { at: "2026-10-09T01:02:03.000Z", queries: 1, rows: 2, lines: 3, ms: 4 },
  updatedAt: "2026-10-09T01:02:03.000Z",
};

interface Connected {
  readonly fetch: FetchLike;
  status: MigrationStatus;
  statusFails: boolean;
  classA: number;
  readonly puts: { key: string; bytes: number }[];
  readonly starts: { key: string; size: number }[];
}

async function connect(): Promise<Connected> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const state: Connected = { fetch: undefined as never, status: WORKING, statusFails: false, classA: 0, puts: [], starts: [] };
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ classA: state.classA, classB: 0 }), run: async () => ({ success: true }) }) }),
      batch: NOT_CALLED,
    } as unknown as Env["DB"],
    ANALYSIS_DETAIL: {
      get: NOT_CALLED,
      put: async (k: string, body: ReadableStream<Uint8Array>) => {
        let bytes = 0;
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
        state.puts.push({ key: k, bytes });
      },
      delete: async () => {},
    } as unknown as Env["ANALYSIS_DETAIL"],
    CLOUD_MIGRATION: {
      idFromName: (name: string) => name,
      get: () => ({
        getStatus: async () => {
          if (state.statusFails) throw new Error("DO の秘密");
          return state.status;
        },
        start: async (input: { key: string; size: number }) => {
          state.starts.push(input);
          return { accepted: true } as const;
        },
      }),
    },
  };
  (state as { fetch: FetchLike }).fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    headers.set("Cf-Access-Jwt-Assertion", token);
    headers.set("Origin", ORIGIN);
    headers.set("Sec-Fetch-Site", "same-origin");
    if (init.body instanceof Blob) headers.set("Content-Length", String(init.body.size));
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers, body: init.body }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return state;
}

describe("GET /api/migration の契約", () => {
  it("サーバの MigrationStatus(全項目)を、クライアントの進捗に読める(キー名・状態名・失敗の phase/message・再開時刻・衝突の例・予算)", async () => {
    const s = await connect();
    const result = await fetchMigration(s.fetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.progress).toEqual({
      state: "importing",
      upload: WORKING.upload,
      analyses: WORKING.analyses,
      results: WORKING.results,
      resumeAt: WORKING.resumeAt,
      failure: WORKING.failure,
      conflictSamples: WORKING.conflictSamples,
      attempts: 1,
      budget: WORKING.budget,
    });
  });

  it("idle(null だらけ)も読める。サーバの state の 7 種をすべて読める", async () => {
    const s = await connect();
    for (const state of ["idle", "verifying", "importing", "waiting-budget", "waiting-r2", "completed", "failed"] as const) {
      s.status = { ...WORKING, state, upload: state === "idle" ? null : WORKING.upload, analyses: { ...WORKING.analyses, total: null }, results: { total: null, processed: 0 }, resumeAt: null, failure: null, conflictSamples: [] };
      const result = await fetchMigration(s.fetch);
      expect(result.ok, state).toBe(true);
      if (result.ok) expect(result.progress.state).toBe(state);
    }
  });

  it("DO が失敗したときの 503 は server-error(サーバの文面は出ない)", async () => {
    const s = await connect();
    s.statusFails = true;
    const result = await fetchMigration(s.fetch);
    expect(result).toEqual({ ok: false, error: { kind: "server-error" } });
  });
});

describe("POST /api/migration/upload の契約", () => {
  const blob = (n: number): Blob => new Blob([new Uint8Array(n).fill(7)]);

  it("クライアントのリクエスト(Blob 本文・application/gzip)を、サーバが 202 で受け付け、R2 にそのまま置いて DO に頼み、進捗を返す", async () => {
    const s = await connect();
    s.status = { ...WORKING, state: "idle", upload: null };
    const result = await postMigrationUpload(s.fetch, blob(1000));
    expect(result.ok).toBe(true);
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]!.bytes).toBe(1000);
    expect(s.starts).toEqual([{ key: s.puts[0]!.key, size: 1000 }]);
    if (result.ok) expect(result.progress).not.toBeNull();
  });

  it("取り込み中は 409 → busy(R2 に置かない)", async () => {
    const s = await connect();
    s.status = { ...WORKING, state: "waiting-budget" };
    expect(await postMigrationUpload(s.fetch, blob(10))).toEqual({ ok: false, error: { kind: "busy" } });
    expect(s.puts).toEqual([]);
  });

  it("上限(サーバの MIGRATION_UPLOAD_MAX_BYTES)を超えると 413 → too-large", async () => {
    const s = await connect();
    s.status = { ...WORKING, state: "idle", upload: null };
    expect(await postMigrationUpload(s.fetch, blob(MIGRATION_UPLOAD_MAX_BYTES + 1))).toEqual({ ok: false, error: { kind: "too-large" } });
    expect(s.puts).toEqual([]);
  });

  it("上限ちょうどは受け付ける(クライアントは大きさで先に断らない=サーバの上限が唯一の正)", async () => {
    const s = await connect();
    s.status = { ...WORKING, state: "idle", upload: null };
    expect((await postMigrationUpload(s.fetch, blob(MIGRATION_UPLOAD_MAX_BYTES))).ok).toBe(true);
  });

  it("R2 の柵(Class A が上限)は 503 → r2-fence", async () => {
    const s = await connect();
    s.status = { ...WORKING, state: "idle", upload: null };
    s.classA = 100_000;
    expect(await postMigrationUpload(s.fetch, blob(10))).toEqual({ ok: false, error: { kind: "r2-fence" } });
    expect(s.puts).toEqual([]);
  });

  it("DO の失敗は 503 → server-error(r2-fence と区別する)", async () => {
    const s = await connect();
    s.statusFails = true;
    expect(await postMigrationUpload(s.fetch, blob(10))).toEqual({ ok: false, error: { kind: "server-error" } });
  });
});
