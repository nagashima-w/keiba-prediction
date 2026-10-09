import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchSettings, postSettings } from "../client/api-settings";
import { handle, type Env } from "../src/handler";
import { DEFAULT_CLOUD_SETTINGS, SELECT_SETTINGS_SQL, UPSERT_SETTINGS_SQL, type CloudSettings } from "../src/settings";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #189(段階2): 契約テスト。クライアントの `fetchSettings`・`postSettings` が送るリクエストを、実際の `handle()`(偽の D1)に通し、本物の応答をクライアントの分類に通す。
 * サーバ側のキー名・状態(15 項目の camelCase・source・Content-Type・Origin の検査・200/400/403/503 の形)が変わると、ここで検出する。
 * ブラウザが付けるヘッダ(Origin・Sec-Fetch-Site)は、ブラウザが付ける値を模して付ける。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

interface Connected {
  readonly fetch: FetchLike;
  row: { settings_json: string } | null;
  failRead: boolean;
  failWrite: boolean;
  /** D1 に書いた回数。 */
  writes: number;
}

async function connect(options: { origin?: string | null; token?: boolean } = {}): Promise<Connected> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const state: Connected = { fetch: undefined as never, row: null, failRead: false, failWrite: false, writes: 0 };
  const db = {
    prepare: (sql: string) => ({
      first: async () => {
        if (sql !== SELECT_SETTINGS_SQL) throw new Error("想定外の読み");
        if (state.failRead) throw new Error("D1 の秘密");
        return state.row;
      },
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql !== UPSERT_SETTINGS_SQL) throw new Error("想定外の書き");
          if (state.failWrite) throw new Error("D1 の秘密");
          state.writes += 1;
          state.row = { settings_json: args[0] as string };
        },
      }),
    }),
  } as unknown as Env["DB"];
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: db,
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
  };
  (state as { fetch: FetchLike }).fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    if (options.token !== false) headers.set("Cf-Access-Jwt-Assertion", token);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers.set("Origin", origin);
    headers.set("Sec-Fetch-Site", "same-origin");
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers, body: init.body }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return state;
}

const CHANGED: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  evThreshold: 1.1,
  bankroll: 300_000,
  perRaceCap: 30_000,
  kellyFraction: 0.1,
  includeComboOdds: true,
  includeTrioInAllocation: false,
  additionalInstruction: "慎重に\n二行目",
  clipVariant: "wide15",
  preRaceOffsetMinutes: 90,
};

describe("契約: GET・POST /api/settings の本物の応答をクライアントが分類できる", () => {
  it("GET: 行が無ければ既定値(source: default)。クライアントが全項目を読める", async () => {
    const c = await connect();
    expect(await fetchSettings(c.fetch)).toEqual({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "default" });
  });

  it("POST → GET: クライアントの本文(15 項目の camelCase・Content-Type)をサーバが受け付け、保存した設定を返し、読み戻すと同じ(source: d1)。D1 への書き込みは1回", async () => {
    const c = await connect();
    expect(await postSettings(c.fetch, CHANGED)).toEqual({ ok: true, settings: CHANGED });
    expect(c.writes).toBe(1);
    expect(await fetchSettings(c.fetch)).toEqual({ ok: true, settings: CHANGED, source: "d1" });
  });

  it("POST: 範囲外(kelly 0.01・追加指示 2,001 文字・発走 5 分前)は、サーバが 400 にし、クライアントは bad-request。D1 に書かない", async () => {
    for (const bad of [{ ...CHANGED, kellyFraction: 0.01 }, { ...CHANGED, additionalInstruction: "a".repeat(2001) }, { ...CHANGED, preRaceOffsetMinutes: 5 }]) {
      const c = await connect();
      expect(await postSettings(c.fetch, bad)).toEqual({ ok: false, error: { kind: "bad-request" } });
      expect(c.writes).toBe(0);
    }
  });

  it("403: Origin が `null`・無い・別のオリジンは origin-mismatch(サーバの本物の本文)。D1 に書かない", async () => {
    for (const origin of ["null", null, "https://evil.example"]) {
      const c = await connect({ origin });
      expect(await postSettings(c.fetch, CHANGED), String(origin)).toEqual({ ok: false, error: { kind: "origin-mismatch" } });
      expect(c.writes).toBe(0);
    }
  });

  it("403: 認証に失敗した応答(Access の関門。本文は平文の forbidden)は forbidden(GET・POST とも)", async () => {
    const c = await connect({ token: false });
    expect(await fetchSettings(c.fetch)).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await postSettings(c.fetch, CHANGED)).toEqual({ ok: false, error: { kind: "forbidden" } });
  });

  it("D1 の失敗(503)は server-error(読み・書きとも)。例外の文面を持ち込まない", async () => {
    const reading = await connect();
    reading.failRead = true;
    const readResult = await fetchSettings(reading.fetch);
    expect(readResult).toEqual({ ok: false, error: { kind: "server-error" } });
    const writing = await connect();
    writing.failWrite = true;
    const writeResult = await postSettings(writing.fetch, CHANGED);
    expect(writeResult).toEqual({ ok: false, error: { kind: "server-error" } });
    expect(JSON.stringify([readResult, writeResult])).not.toContain("秘密");
  });
});
