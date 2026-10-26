import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import type { AllocationExportFileInfo as ExportFileInfo, AllocationExportResponse as ExportResponse } from "../src/allocation-export-core";
import type { ExportMode } from "../src/prior-export-core";
import { ALLOCATION_EXPORT_KEY } from "../src/allocation-export-format";
import { EMAIL, GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #463: `GET /api/export/allocation-dataset`(管理者専用)。DO(`AllocationExportDO`)の状態に応じて、完成したファイルのストリーム(200)・進捗(202)・状態(`?status=1`)・拒否を返す。
 * Worker は D1 に触れず、R2 には「完成したファイルの get 1 回」だけ触れる(中身は読まず、本体をそのまま返す)。DO・R2 は偽物。
 */
const ORIGIN = "https://cloud.invalid";
const PATH = "/api/export/allocation-dataset";
const VIEWER_EMAIL = "friend@example.com";

const FILE: ExportFileInfo = {
  generatedAt: "2026-10-10T12:34:56.000Z", rows: 3, races: 3, missingOdds: 0, noAllocation: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, uncheckedRaces: 0, superseded: 0, estimated: 0 }, bytes: 5, diag: { rowsRead: 9, gets: 1 },
};
const READY: ExportResponse = { status: "ready", file: FILE };
const BUILDING: ExportResponse = { status: "building", phase: "building", racesDone: 30, races: 120, startedAt: "2026-10-10T12:00:00.000Z", file: null };
const BOOM = (): never => {
  throw new Error("呼ばれない想定");
};

interface Harness {
  readonly modes: ExportMode[];
  readonly names: string[];
  readonly bucketGets: string[];
  response: ExportResponse;
  fails: boolean;
  object: { body: ReadableStream<Uint8Array>; size: number } | null;
  env(withBinding?: boolean): Env;
}

function harness(): Harness {
  const h: Harness = {
    modes: [], names: [], bucketGets: [], response: READY, fails: false,
    object: { body: new Response(new Uint8Array([1, 2, 3, 4, 5])).body!, size: 5 },
    env: (withBinding = true) => ({
      ...GOOD_ENV,
      NETKEIBA_GATE: { idFromName: BOOM, get: BOOM },
      RACE_DAY: { idFromName: BOOM, get: BOOM },
      DB: new Proxy({}, { get: BOOM }) as unknown as Env["DB"],
      ANALYSIS_DETAIL: {
        get: async (key: string) => {
          h.bucketGets.push(key);
          return h.object;
        },
        put: BOOM,
      } as unknown as Env["ANALYSIS_DETAIL"],
      ...(withBinding
        ? {
            ALLOCATION_EXPORT: {
              idFromName: (name: string) => {
                h.names.push(name);
                return name;
              },
              get: () => ({
                request: async (mode: ExportMode) => {
                  h.modes.push(mode);
                  if (h.fails) throw new Error("DO の詳細 SECRET-DO");
                  return h.response;
                },
              }),
            },
          }
        : {}),
    }),
  };
  return h;
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  return { deps, admin: await signToken(key, { email: EMAIL }), viewer: await signToken(key, { email: VIEWER_EMAIL }) };
}

const req = (token: string | undefined, query = "", method = "GET", extra: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${PATH}${query}`, { method, headers: { ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }), ...extra } });

describe("GET /api/export/allocation-dataset: 完成したファイル", () => {
  it("ready なら R2 の固定キーの本体をそのまま返す(200・application/gzip・attachment・JST の日時のファイル名・no-store)。DO には download を単一インスタンスで頼む", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    const res = await handle(req(admin), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="allocation-dataset-20261010-2134.ndjson.gz"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("refresh")).toBeNull();
    expect(h.modes).toEqual(["download"]);
    expect(h.names).toEqual(["main"]);
    expect(h.bucketGets).toEqual([ALLOCATION_EXPORT_KEY]);
  });

  it("ready なのに R2 にファイルが無ければ 503 export-missing(refresh で作り直す)", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    h.object = null;
    const res = await handle(req(admin), h.env(), {}, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: { type: "export-missing" } });
  });
});

describe("作成中・作成の始まり", () => {
  it("(a) building なら 202 と進捗の JSON。古いファイルを返さず、R2 に触れない", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    h.response = { ...BUILDING, file: FILE };
    const res = await handle(req(admin), h.env(), {}, deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, ...h.response });
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(h.bucketGets).toEqual([]);
  });

  it("(b) 202 の Refresh ヘッダは 5 秒後に ?refresh=1 を含まない URL へ。?refresh=1 の要求への 202 でも同じ(自動の再読み込みで作成を何度も始めない)", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    h.response = BUILDING;
    for (const query of ["", "?refresh=1", "?status=1"]) {
      const res = await handle(req(admin, query), h.env(), {}, deps);
      if (query === "?status=1") {
        expect(res.status).toBe(200);
        expect(res.headers.get("refresh")).toBeNull();
        continue;
      }
      expect(res.status).toBe(202);
      expect(res.headers.get("refresh")).toBe(`5; url=${PATH}`);
      expect(res.headers.get("refresh")).not.toContain("refresh=1");
    }
  });

  it("?refresh=1 は DO に refresh を頼む。ファイルは返さない(DO が ready を返す想定外の場合も、本体は返さず状態の JSON)", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    h.response = BUILDING;
    expect((await handle(req(admin, "?refresh=1"), h.env(), {}, deps)).status).toBe(202);
    expect(h.modes).toEqual(["refresh"]);
    h.response = READY;
    const res = await handle(req(admin, "?refresh=1"), h.env(), {}, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...READY });
    expect(h.bucketGets).toEqual([]);
  });

  it("?status=1 は DO に status を頼み、どの状態でも 200 の JSON(R2 に触れない)", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    for (const response of [READY, BUILDING, { status: "empty", file: null } as ExportResponse]) {
      h.response = response;
      const res = await handle(req(admin, "?status=1"), h.env(), {}, deps);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ...response });
    }
    expect(h.modes).toEqual(["status", "status", "status"]);
    expect(h.bucketGets).toEqual([]);
  });
});

describe("柵・失敗", () => {
  it("throttled は 429(次に始められる時刻つき)、blocked(R2 の柵)・failed は 503。固定の種類名だけで、例外の文面を含まない", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    h.response = { status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", file: FILE };
    const throttled = await handle(req(admin, "?refresh=1"), h.env(), {}, deps);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ ok: false, error: { type: "export-throttled" }, nextAt: "2026-10-10T15:00:00.000Z", file: FILE });
    h.response = { status: "blocked", reason: "r2-fence", file: null };
    const blocked = await handle(req(admin), h.env(), {}, deps);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ ok: false, error: { type: "export-blocked", reason: "r2-fence" }, file: null });
    h.response = { status: "failed", reason: "tick-failed", file: null };
    const failed = await handle(req(admin), h.env(), {}, deps);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false, error: { type: "export-failed", reason: "tick-failed" }, file: null });
  });

  it("DO が例外を投げたら 503 export-error(本文に例外の文面を含めない)。binding が無い構成も 503", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    h.fails = true;
    const res = await handle(req(admin), h.env(), {}, deps);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "export-error" } });
    expect(text).not.toContain("SECRET");
    const none = await handle(req(admin), harness().env(false), {}, deps);
    expect(none.status).toBe(503);
    expect(await none.json()).toEqual({ ok: false, error: { type: "export-error" } });
  });
});

describe("入口の守り", () => {
  it("閲覧者は 403 admin-only。DO にも R2 にも触れない", async () => {
    const { deps, viewer } = await setup();
    const h = harness();
    const res = await handle(req(viewer), h.env(), {}, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: { type: "admin-only" } });
    expect(h.modes).toEqual([]);
    expect(h.bucketGets).toEqual([]);
  });

  it("認証なしは 403(従来どおり)。DO に触れない", async () => {
    const { deps } = await setup();
    const h = harness();
    expect((await handle(req(undefined), h.env(), {}, deps)).status).toBe(403);
    expect(h.modes).toEqual([]);
  });

  it("GET 以外(HEAD・POST)は 405(allow: GET)。DO に触れない", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
      const res = await handle(req(admin, "", method), h.env(), {}, deps);
      expect(res.status, method).toBe(405);
      if (method === "HEAD") {
        expect(res.headers.get("allow"), method).toBe("GET");
      }
    }
    expect(h.modes).toEqual([]);
  });

  it("別サイトからの要求(Sec-Fetch-Site: cross-site・same-site)は 403 origin-mismatch。アドレスバー(none)・同一オリジンは通る", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    for (const site of ["cross-site", "same-site"]) {
      const res = await handle(req(admin, "", "GET", { "sec-fetch-site": site }), h.env(), {}, deps);
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    }
    expect(h.modes).toEqual([]);
    for (const site of ["none", "same-origin"]) {
      expect((await handle(req(admin, "", "GET", { "sec-fetch-site": site }), h.env(), {}, deps)).status, site).toBe(200);
    }
  });

  it("クエリは refresh・status だけ(1 または 0 を 1 つずつ)。それ以外・両方の 1・重複は 400 で、DO に触れない", async () => {
    const { deps, admin } = await setup();
    const h = harness();
    for (const query of ["?x=1", "?refresh=2", "?refresh=1&refresh=1", "?status=yes", "?refresh=1&status=1"]) {
      const res = await handle(req(admin, query), h.env(), {}, deps);
      expect(res.status, query).toBe(400);
    }
    expect(h.modes).toEqual([]);
    // 0 は指定なしと同じ
    await handle(req(admin, "?refresh=0&status=0"), h.env(), {}, deps);
    expect(h.modes).toEqual(["download"]);
  });
});
