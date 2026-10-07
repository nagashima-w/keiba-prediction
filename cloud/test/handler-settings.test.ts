import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { coerceCloudSettings, DEFAULT_CLOUD_SETTINGS, SELECT_SETTINGS_SQL, UPSERT_SETTINGS_SQL, type CloudSettings } from "../src/settings";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #189: 設定の API(`GET /api/settings`・`POST /api/settings`)。D1 は偽物(1行を持つ)。実 D1 には触れない。
 * 守り(Origin 403 → Content-Type 415 → 413 → 400)の順序は `handler-json-guard.test.ts` が run と同じ表で固定する。ここはルート固有の動作。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

const FULL: CloudSettings = {
  evThreshold: 1.2,
  additionalInstruction: "人気薄は慎重に",
  clipVariant: "wide15",
  bankroll: 500_000,
  perRaceCap: 50_000,
  kellyFraction: 0.25,
  includeComboOdds: true,
  includeWideInAllocation: false,
  includeTrioInAllocation: false,
  includeQuinellaInAllocation: true,
  includeExactaInAllocation: false,
  includeTrifectaInAllocation: true,
  includeBracketQuinellaInAllocation: false,
  preRaceOffsetMinutes: 60,
};

interface FakeDb {
  readonly db: Env["DB"];
  /** 実行された SQL(読み・書きとも)。 */
  readonly sqls: string[];
  /** 保存された行(無ければ null)。 */
  row: { settings_json: string; updated_at: string } | null;
  failRead: boolean;
  failWrite: boolean;
}

function fakeDb(initialJson: string | null = null): FakeDb {
  const f: FakeDb = {
    db: undefined as never,
    sqls: [],
    row: initialJson === null ? null : { settings_json: initialJson, updated_at: "2026-10-01T00:00:00.000Z" },
    failRead: false,
    failWrite: false,
  };
  (f as { db: Env["DB"] }).db = {
    prepare: (sql: string) => {
      f.sqls.push(sql);
      return {
        first: async () => {
          if (sql !== SELECT_SETTINGS_SQL) throw new Error(`想定外の読み: ${sql}`);
          if (f.failRead) throw new Error("D1 読み出し失敗 secret-sql-detail");
          return f.row;
        },
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql !== UPSERT_SETTINGS_SQL) throw new Error(`想定外の書き: ${sql}`);
            if (f.failWrite) throw new Error("D1 書き込み失敗 secret-sql-detail");
            f.row = { settings_json: args[0] as string, updated_at: args[1] as string };
            return { success: true };
          },
        }),
      };
    },
  } as unknown as Env["DB"];
  return f;
}

function envOf(f: FakeDb): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: f.db,
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
  };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const stranger = await signToken(key, { email: "stranger@example.com" });
  return { deps, token, stranger };
}

function get(token: string | undefined, method = "GET"): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}/api/settings`, { method, headers });
}

function post(token: string | undefined, body: unknown, raw?: string): Request {
  const headers = new Headers({ Origin: ORIGIN, "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}/api/settings`, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
}

describe("GET /api/settings", () => {
  it("行が無ければ既定値(source: default)。読むのは設定の1文だけ", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(null);
    const response = await handle(get(token), envOf(f), {}, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "default" });
    expect(f.sqls).toEqual([SELECT_SETTINGS_SQL]);
  });

  it("行があれば、その設定(source: d1)。camelCase の全 14 項目", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(JSON.stringify(FULL));
    const body = (await (await handle(get(token), envOf(f), {}, deps)).json()) as { ok: boolean; settings: CloudSettings; source: string };
    expect(body).toEqual({ ok: true, settings: FULL, source: "d1" });
    expect(Object.keys(body.settings).length).toBe(14);
  });

  it("手で入れた不正な値の行は、その項目だけ既定値(読む側)。kelly の 0 は読む側では有効で、そのまま返る", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(JSON.stringify({ bankroll: -5, kellyFraction: 0, preRaceOffsetMinutes: 5 }));
    const body = (await (await handle(get(token), envOf(f), {}, deps)).json()) as { settings: CloudSettings; source: string };
    expect(body.source).toBe("d1");
    expect(body.settings.bankroll).toBe(0);
    expect(body.settings.kellyFraction).toBe(0);
    expect(body.settings.preRaceOffsetMinutes).toBe(45);
  });

  it("JSON として読めない行は既定値(source: invalid)", async () => {
    const { deps, token } = await setup();
    const body = await (await handle(get(token), envOf(fakeDb("{not json")), {}, deps)).json();
    expect(body).toEqual({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "invalid" });
  });

  it("D1 の読み出しが失敗したら 503(d1-error)。例外の文面・SQL を返さない", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(null);
    f.failRead = true;
    const response = await handle(get(token), envOf(f), {}, deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "d1-error" } });
    expect(text).not.toContain("secret-sql-detail");
    expect(text).not.toContain("SELECT");
  });

  it("認証なし・許可メール以外は 403(forbidden)で、D1 を引かない", async () => {
    const { deps, stranger } = await setup();
    for (const token of [undefined, stranger]) {
      const f = fakeDb(null);
      const response = await handle(get(token), envOf(f), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
      expect(f.sqls).toEqual([]);
    }
  });

  it("HEAD・PUT・DELETE は 405(Allow: GET, POST)で、D1 を引かない。レスポンスにセキュリティヘッダ", async () => {
    const { deps, token } = await setup();
    for (const method of ["HEAD", "PUT", "DELETE"]) {
      const f = fakeDb(null);
      const response = await handle(get(token, method), envOf(f), {}, deps);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET, POST");
      expect(f.sqls, method).toEqual([]);
    }
    const ok = await handle(get(token), envOf(fakeDb(null)), {}, deps);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("パスは厳密: 末尾スラッシュ・下位パスは 404", async () => {
    const { deps, token } = await setup();
    for (const path of ["/api/settings/", "/api/settings/x"]) {
      const headers = new Headers({ "Cf-Access-Jwt-Assertion": token });
      const response = await handle(new Request(`${ORIGIN}${path}`, { headers }), envOf(fakeDb(null)), {}, deps);
      expect(response.status, path).toBe(404);
    }
  });
});

describe("POST /api/settings", () => {
  it("全項目が有効なら 200 で、保存した設定を返す。D1 には UPSERT を1回(設定の JSON と、注入された現在時刻の ISO 8601)", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(null);
    const response = await handle(post(token, FULL), envOf(f), {}, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, settings: FULL });
    expect(f.sqls).toEqual([UPSERT_SETTINGS_SQL]);
    expect(JSON.parse(f.row!.settings_json)).toEqual(FULL);
    expect(f.row!.updated_at).toBe(NOW.toISOString());
  });

  it("保存後の GET は、保存した設定(source: d1)。Worker が読み戻す値は、POST が返した値と同じ", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(null);
    const saved = (await (await handle(post(token, FULL), envOf(f), {}, deps)).json()) as { settings: CloudSettings };
    const read = (await (await handle(get(token), envOf(f), {}, deps)).json()) as { settings: CloudSettings; source: string };
    expect(read.source).toBe("d1");
    expect(read.settings).toEqual(saved.settings);
  });

  it("全境界値で、保存 → 読み戻しの値が一致する(下限・上限・kelly の 0.05・追加指示 2,000 文字・発走前の 10 と 180)", async () => {
    const { deps, token } = await setup();
    const lows: CloudSettings = { ...FULL, evThreshold: Number.MIN_VALUE, additionalInstruction: "", bankroll: 0, perRaceCap: 0, kellyFraction: 0.05, preRaceOffsetMinutes: 10 };
    const highs: CloudSettings = { ...FULL, evThreshold: 100, additionalInstruction: "あ".repeat(2000), bankroll: 100_000_000, perRaceCap: 10_000_000, kellyFraction: 1, preRaceOffsetMinutes: 180 };
    for (const settings of [lows, highs]) {
      const f = fakeDb(null);
      const saved = await handle(post(token, settings), envOf(f), {}, deps);
      expect(saved.status).toBe(200);
      const read = (await (await handle(get(token), envOf(f), {}, deps)).json()) as { settings: CloudSettings };
      expect(read.settings).toEqual(settings);
    }
  });

  it("追加指示が 2,000 文字すべて JSON のエスケープで 6 バイト(\\u0001)でも、本文の上限(16 KiB)に収まり保存できる", async () => {
    const { deps, token } = await setup();
    const settings = { ...FULL, additionalInstruction: "\u0001".repeat(2000) };
    const raw = JSON.stringify(settings);
    expect(Buffer.byteLength(raw), "前提: エスケープで 6 バイト/文字になり、12,000 バイトを超える").toBeGreaterThan(12_000);
    expect(Buffer.byteLength(raw), "前提: 上限未満").toBeLessThan(16 * 1024);
    const f = fakeDb(null);
    const response = await handle(post(token, null, raw), envOf(f), {}, deps);
    expect(response.status).toBe(200);
    expect(coerceCloudSettings(JSON.parse(f.row!.settings_json)).additionalInstruction).toBe("\u0001".repeat(2000));
  });

  it.each([
    ["追加指示が 2,001 文字", { additionalInstruction: "a".repeat(2001) }, "additionalInstruction"],
    ["kelly が 0.04999(読む側では有効だが書く側は不可)", { kellyFraction: 0.04999 }, "kellyFraction"],
    ["kelly が 0", { kellyFraction: 0 }, "kellyFraction"],
    ["kelly が 1 超え", { kellyFraction: 1.01 }, "kellyFraction"],
    ["bankroll が 1 億超え", { bankroll: 100_000_001 }, "bankroll"],
    ["bankroll が小数", { bankroll: 10.5 }, "bankroll"],
    ["perRaceCap が負", { perRaceCap: -1 }, "perRaceCap"],
    ["evThreshold が 0", { evThreshold: 0 }, "evThreshold"],
    ["clipVariant が未知", { clipVariant: "wide99" }, "clipVariant"],
    ["include が文字列", { includeComboOdds: "true" }, "includeComboOdds"],
    ["preRaceOffsetMinutes が 9", { preRaceOffsetMinutes: 9 }, "preRaceOffsetMinutes"],
    ["preRaceOffsetMinutes が 181", { preRaceOffsetMinutes: 181 }, "preRaceOffsetMinutes"],
    ["preRaceOffsetMinutes が小数", { preRaceOffsetMinutes: 30.5 }, "preRaceOffsetMinutes"],
  ])("%s は 400(bad-request・fields にその項目名)で、D1 に書かない。黙って既定値に戻さない", async (_name, patch, field) => {
    const { deps, token } = await setup();
    const f = fakeDb(JSON.stringify(FULL));
    const before = f.row;
    const response = await handle(post(token, { ...FULL, ...patch }), envOf(f), {}, deps);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: { type: string; message: string; fields: string[] } };
    expect(body.ok).toBe(false);
    expect(body.error.type).toBe("bad-request");
    expect(body.error.fields).toEqual([field]);
    expect(typeof body.error.message).toBe("string");
    expect(f.sqls).toEqual([]);
    expect(f.row).toBe(before);
  });

  it("キーが欠けている(部分更新は受けない)・未知のキーがある・__proto__ キーがあるときは 400 で、D1 に書かない。未知のキー名は本文に写さない", async () => {
    const { deps, token } = await setup();
    const { bankroll: _omit, ...missing } = FULL;
    const cases: Array<[string, string]> = [
      ["欠け", JSON.stringify(missing)],
      ["未知のキー", JSON.stringify({ ...FULL, secretKeyName: 1 })],
      ["__proto__", `{"__proto__":{"bankroll":1},${JSON.stringify(FULL).slice(1)}`],
    ];
    for (const [name, raw] of cases) {
      const f = fakeDb(null);
      const response = await handle(post(token, null, raw), envOf(f), {}, deps);
      expect(response.status, name).toBe(400);
      expect(await response.text(), name).not.toContain("secretKeyName");
      expect(f.sqls, name).toEqual([]);
    }
  });

  it("D1 の書き込みが失敗したら 503(d1-error)。例外の文面・SQL を返さない", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(null);
    f.failWrite = true;
    const response = await handle(post(token, FULL), envOf(f), {}, deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "d1-error" } });
    expect(text).not.toContain("secret-sql-detail");
    expect(text).not.toContain("INSERT");
  });

  it("認証なし・許可メール以外は 403(forbidden)で、D1 に触れない(Origin・本文が正しくても)", async () => {
    const { deps, stranger } = await setup();
    for (const token of [undefined, stranger]) {
      const f = fakeDb(null);
      const response = await handle(post(token, FULL), envOf(f), {}, deps);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
      expect(f.sqls).toEqual([]);
    }
  });

  it("Origin が違う POST は 403(origin-mismatch)で、D1 に触れない", async () => {
    const { deps, token } = await setup();
    const f = fakeDb(null);
    const headers = new Headers({ Origin: "https://evil.example", "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": token });
    const response = await handle(new Request(`${ORIGIN}/api/settings`, { method: "POST", headers, body: JSON.stringify(FULL) }), envOf(f), {}, deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    expect(f.sqls).toEqual([]);
  });
});

describe("他のルートへの影響なし", () => {
  it("run 以外・settings 以外の POST は、従来どおり 405(Allow: GET, HEAD)", async () => {
    const { deps, token } = await setup();
    for (const path of ["/", "/api/analyses", "/api/health"]) {
      const headers = new Headers({ "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN });
      const response = await handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers }), envOf(fakeDb(null)), {}, deps);
      expect(response.status, path).toBe(405);
      expect(response.headers.get("allow"), path).toBe("GET, HEAD");
    }
  });
});
