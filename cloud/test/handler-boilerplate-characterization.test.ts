import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { checkKaisaiDate } from "../src/race-date";
import { EMAIL, GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #397(R-4): handler.ts の定型(Sec-Fetch-Site の検査・クエリキーの検査・日報と月報の list/detail/run)の**特性テスト**。
 * 共通化のリファクタリングの前後で、ルートごと・役割ごとに「ステータス・応答本文の生テキスト(キー順を含む)・ヘッダ・検査の順序・裏側に触れたか」が
 * 1 つも変わらないことを固定する。**リファクタ前のコードで緑**になる(新しい振る舞いのテストではない)。
 * 検出力は変異(検査順の入れ替え・403 の本文の変更・`none` の扱いの変更・月報の閲覧者の DO 読みの追加)で確かめた。
 */

const ORIGIN = "https://cloud.invalid";
const VIEWER_EMAIL = "friend@example.com";
/** 認証の設定の読み取りは「裏側に触れた」と数えない。 */
const AUTH_KEYS = new Set<string | symbol>(["ACCESS_TEAM_NAME", "ACCESS_AUD", "ACCESS_ALLOWED_EMAIL", "ADMIN_USER"]);

const boom = (): never => {
  throw new Error("裏側は呼ばれない想定");
};

/** 裏側(バインディング)の読み取りを記録する env。検証だけで終わるルートは、1 つも読まれない。 */
function trackedEnv(extra: Record<string, unknown> = {}): { env: Env; touched: string[] } {
  const touched: string[] = [];
  const base = {
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
    ...extra,
  };
  const env = new Proxy(base, {
    get(target, key) {
      if (!AUTH_KEYS.has(key)) {
        touched.push(String(key));
      }
      return (target as Record<string | symbol, unknown>)[key];
    },
  }) as unknown as Env;
  return { env, touched };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  return { deps, admin: await signToken(key, { email: EMAIL }), viewer: await signToken(key, { email: VIEWER_EMAIL }) };
}

/** 応答の観測可能な全部: ステータス・本文の生テキスト・ヘッダ(固定の 4 つ)。 */
interface Snapshot {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | null>;
}

async function snapshot(response: Response): Promise<Snapshot> {
  return {
    status: response.status,
    body: await response.text(),
    headers: {
      "content-type": response.headers.get("content-type"),
      "cache-control": response.headers.get("cache-control"),
      "x-content-type-options": response.headers.get("x-content-type-options"),
      "referrer-policy": response.headers.get("referrer-policy"),
    },
  };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const jsonSnap = (status: number, body: unknown): Snapshot => ({ status, body: JSON.stringify(body), headers: JSON_HEADERS });
const badRequestSnap = (message: string): Snapshot => jsonSnap(400, { ok: false, error: { type: "bad-request", message } });
const ORIGIN_MISMATCH = jsonSnap(403, { ok: false, error: { type: "origin-mismatch" } });
const NO_QUERY_MESSAGE = "このパスにクエリは指定できません";

function getRequest(path: string, token: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, ...headers } });
}

// ---------------------------------------------------------------------------------------------------------------------
// (a) Sec-Fetch-Site とクエリキーの検査
// ---------------------------------------------------------------------------------------------------------------------

interface KeyRoute {
  readonly name: string;
  readonly path: string;
  /** 通る形の完全なクエリ(`&` 区切り。先頭の組は重複・大文字違いの変異に使う)。 */
  readonly valid: string;
  readonly message: string;
  /** 許可されたキー(このルートのクエリ検査が通すキー全部)。他のルートの許可キーが紛れ込む「過剰許可」を検出するために持つ。 */
  readonly allowed: readonly string[];
  /** Sec-Fetch-Site を検査するルートか(8 本)。 */
  readonly siteChecked: boolean;
}

const KEY_ROUTES: readonly KeyRoute[] = [
  { name: "horse-runs", path: "/api/horse-runs", valid: "days=1", message: "クエリは days(1〜60 の整数)と cells(1 または 0)だけを、それぞれ1つまで指定できます", allowed: ["days", "cells"], siteChecked: true },
  { name: "baba-fetch", path: "/api/baba-fetch", valid: "kaisai_date=20261010", message: "クエリは kaisai_date だけを1つ指定できます", allowed: ["kaisai_date"], siteChecked: true },
  { name: "verify", path: "/api/verify", valid: "venue=all", message: "クエリは venue(all・central・nar)と refresh(1 または 0)だけを、それぞれ1つまで指定できます", allowed: ["venue", "refresh"], siteChecked: true },
  { name: "prior-export", path: "/api/export/prior-dataset", valid: "status=1", message: "クエリは refresh(1 または 0)と status(1 または 0)だけを、それぞれ1つまで指定できます", allowed: ["refresh", "status"], siteChecked: true },
  { name: "races", path: "/api/races", valid: "kaisai_date=20261010&venue=central", message: "クエリは kaisai_date(必須)と venue(必須)だけを、それぞれ1つまで指定できます", allowed: ["kaisai_date", "venue"], siteChecked: true },
  { name: "plan", path: "/api/plan", valid: "kaisai_date=20261010", message: "クエリは kaisai_date だけを1つ指定できます", allowed: ["kaisai_date"], siteChecked: true },
  { name: "targets", path: "/api/targets", valid: "kaisai_date=20261010", message: "クエリは kaisai_date だけを1つ指定できます", allowed: ["kaisai_date"], siteChecked: true },
  { name: "netkeiba-check", path: "/api/netkeiba/check", valid: "race_id=202605040811", message: "クエリは race_id(必須)と type(省略可。shutuba または grade-winner)だけを、それぞれ1つ指定してください", allowed: ["race_id", "type"], siteChecked: true },
  // Sec-Fetch-Site を検査しないが、クエリキーを検査するルート(2 本)
  { name: "analyses", path: "/api/analyses", valid: "limit=5", message: "クエリは race_id・kaisai_date・limit だけを、それぞれ1つまで指定できます", allowed: ["race_id", "kaisai_date", "limit"], siteChecked: false },
  { name: "analyses-status", path: "/api/analyses/status", valid: "kaisai_date=20261010", message: "クエリは kaisai_date(必須)と race_id(任意)だけを、それぞれ1つまで指定できます", allowed: ["kaisai_date", "race_id"], siteChecked: false },
];

const firstPair = (valid: string): string => valid.split("&")[0]!;
const CROSS_SITE_VALUES = ["cross-site", "same-site", "bogus", ""];

describe("Sec-Fetch-Site の検査(8 ルート): 別サイトは 403 origin-mismatch で、裏側に触れず、クエリの検査より先に効く", () => {
  const checked = KEY_ROUTES.filter((r) => r.siteChecked);

  it("前提: 検査するルートは 8 本、しないクエリ検査ルートは 2 本", () => {
    expect(checked.map((r) => r.name)).toEqual(["horse-runs", "baba-fetch", "verify", "prior-export", "races", "plan", "targets", "netkeiba-check"]);
    expect(KEY_ROUTES.filter((r) => !r.siteChecked).map((r) => r.name)).toEqual(["analyses", "analyses-status"]);
  });

  for (const route of checked) {
    it.each(CROSS_SITE_VALUES)(`${route.name}: Sec-Fetch-Site が「%s」(none・same-origin 以外)なら、通る形のクエリでも 403 で、裏側に触れない`, async (site) => {
      const { deps, admin } = await setup();
      const { env, touched } = trackedEnv();
      const got = await snapshot(await handle(getRequest(`${route.path}?${route.valid}`, admin, { "Sec-Fetch-Site": site }), env, {}, deps));
      expect(got).toEqual(ORIGIN_MISMATCH);
      expect(touched).toEqual([]);
    });

    it.each(["cross-site", "same-site", "bogus"])(`${route.name}: 別サイト(%s)で不正なクエリ(未知のキー・重複)も付いていれば、403 が先(400 にならない)`, async (site) => {
      const { deps, admin } = await setup();
      for (const query of ["zzz=1", `${firstPair(route.valid)}&${firstPair(route.valid)}`]) {
        const { env, touched } = trackedEnv();
        const got = await snapshot(await handle(getRequest(`${route.path}?${query}`, admin, { "Sec-Fetch-Site": site }), env, {}, deps));
        expect(got, query).toEqual(ORIGIN_MISMATCH);
        expect(touched).toEqual([]);
      }
    });

    it.each([["none"], ["same-origin"], [undefined]])(`${route.name}: Sec-Fetch-Site が %s なら検査を通る(次の検査の 400 になる。裏側には触れない)`, async (site) => {
      const { deps, admin } = await setup();
      const { env, touched } = trackedEnv();
      const headers: Record<string, string> = site === undefined ? {} : { "Sec-Fetch-Site": site };
      const got = await snapshot(await handle(getRequest(`${route.path}?zzz=1`, admin, headers), env, {}, deps));
      expect(got).toEqual(badRequestSnap(route.message));
      expect(touched).toEqual([]);
    });
  }

  it("検査しない 2 ルート(analyses・analyses/status)は、別サイトのヘッダでも 403 にならない(クエリの 400 になる)", async () => {
    const { deps, admin } = await setup();
    for (const route of KEY_ROUTES.filter((r) => !r.siteChecked)) {
      const { env, touched } = trackedEnv();
      const got = await snapshot(await handle(getRequest(`${route.path}?zzz=1`, admin, { "Sec-Fetch-Site": "cross-site" }), env, {}, deps));
      expect(got, route.name).toEqual(badRequestSnap(route.message));
      expect(touched).toEqual([]);
    }
  });
});

describe("クエリキーの検査(10 ルート): 許可リスト外のキー・重複したキーは 400(文言込み)で、裏側に触れない", () => {
  for (const route of KEY_ROUTES) {
    it(`${route.name}: 未知のキー・大文字違いのキー・通る形に未知のキーを足したものは 400`, async () => {
      const { deps, admin } = await setup();
      const upper = firstPair(route.valid).split("=")[0]!.toUpperCase();
      const queries = ["zzz=1", `${upper}=1`, `${route.valid}&zzz=1`, "=1"];
      for (const query of queries) {
        const { env, touched } = trackedEnv();
        const got = await snapshot(await handle(getRequest(`${route.path}?${query}`, admin), env, {}, deps));
        expect(got, query).toEqual(badRequestSnap(route.message));
        expect(touched, query).toEqual([]);
      }
    });

    it(`${route.name}: 許可されたキーの重複は(値が同じでも違っても)400`, async () => {
      const { deps, admin } = await setup();
      const pair = firstPair(route.valid);
      const [key, value] = pair.split("=") as [string, string];
      for (const query of [`${pair}&${pair}`, `${pair}&${key}=${value}0`, `${route.valid}&${pair}`]) {
        const { env, touched } = trackedEnv();
        const got = await snapshot(await handle(getRequest(`${route.path}?${query}`, admin), env, {}, deps));
        expect(got, query).toEqual(badRequestSnap(route.message));
        expect(touched, query).toEqual([]);
      }
    });
  }

  const ALL_KEYS = [...new Set(KEY_ROUTES.flatMap((r) => r.allowed))];

  it("前提: 10 ルートの許可キーの全体は 9 種で、どのルートにも「許可されていない他のルートのキー」が 1 つ以上ある(過剰許可を試せる)。valid は許可キーだけ", () => {
    expect(ALL_KEYS.sort()).toEqual(["cells", "days", "kaisai_date", "limit", "race_id", "refresh", "status", "type", "venue"]);
    for (const route of KEY_ROUTES) {
      expect(ALL_KEYS.filter((k) => !route.allowed.includes(k)).length, route.name).toBeGreaterThan(0);
      // valid の組は、すべて許可キーである(許可キーだけの完全なクエリ)
      expect(route.valid.split("&").every((pair) => route.allowed.includes(pair.split("=")[0]!)), route.name).toBe(true);
    }
  });

  for (const route of KEY_ROUTES) {
    it(`${route.name}: 許可キーだけの完全なクエリは、クエリ検査を通って次の段階(裏側)に進む`, async () => {
      const { deps, admin } = await setup();
      const { env, touched } = trackedEnv();
      // 裏側は呼ばれると throw する偽物。進んだ先で例外になるか 503 になるかはルート次第なので、ここでは「400 の文言にならない」ことと「裏側に触れた」ことを見る
      const outcome = await handle(getRequest(`${route.path}?${route.valid}`, admin), env, {}, deps).then(
        (response) => snapshot(response),
        () => "threw",
      );
      expect(touched.length, "裏側に触れた = クエリ検査を通った").toBeGreaterThan(0);
      expect(outcome).not.toEqual(badRequestSnap(route.message));
    });

    it(`${route.name}: 許可されていないキー(他のルートの許可キー)は、単独でも許可キーと並べても 400(過剰許可でない)`, async () => {
      const { deps, admin } = await setup();
      const foreign = ALL_KEYS.filter((k) => !route.allowed.includes(k));
      expect(foreign.length).toBeGreaterThan(0);
      for (const key of foreign) {
        for (const query of [`${key}=1`, `${route.valid}&${key}=1`]) {
          const { env, touched } = trackedEnv();
          const got = await snapshot(await handle(getRequest(`${route.path}?${query}`, admin), env, {}, deps));
          expect(got, query).toEqual(badRequestSnap(route.message));
          expect(touched, query).toEqual([]);
        }
      }
    });
  }

  it("netkeiba-check: 許可されたキーだけでも race_id が無ければ 400(必須キー)。type だけ・type の重複も同じ文言", async () => {
    const { deps, admin } = await setup();
    const route = KEY_ROUTES.find((r) => r.name === "netkeiba-check")!;
    for (const query of ["", "type=shutuba", "type=shutuba&type=grade-winner", "race_id=202605040811&type=shutuba&type=shutuba"]) {
      const { env, touched } = trackedEnv();
      const got = await snapshot(await handle(getRequest(`/api/netkeiba/check${query === "" ? "" : `?${query}`}`, admin), env, {}, deps));
      expect(got, query).toEqual(badRequestSnap(route.message));
      expect(touched, query).toEqual([]);
    }
  });

  it("analyses-status: kaisai_date と race_id の 2 つは許可(重複だけが 400)。race_id だけ・kaisai_date だけの欠落は別の文言の 400", async () => {
    const { deps, admin } = await setup();
    const route = KEY_ROUTES.find((r) => r.name === "analyses-status")!;
    const got1 = await snapshot(await handle(getRequest("/api/analyses/status?race_id=202605040811", admin), trackedEnv().env, {}, deps));
    expect(got1).toEqual(badRequestSnap("kaisai_date を YYYYMMDD の 8 桁で指定してください"));
    const got2 = await snapshot(await handle(getRequest("/api/analyses/status?kaisai_date=20261010&race_id=202605040811&race_id=202605040811", admin), trackedEnv().env, {}, deps));
    expect(got2).toEqual(badRequestSnap(route.message));
  });

  it("閲覧者にも開いているルート(verify・races・plan・targets・analyses・analyses/status)は、閲覧者でも同じ 400/403", async () => {
    const { deps, viewer } = await setup();
    for (const name of ["verify", "races", "plan", "targets", "analyses", "analyses-status"]) {
      const route = KEY_ROUTES.find((r) => r.name === name)!;
      const { env, touched } = trackedEnv();
      expect(await snapshot(await handle(getRequest(`${route.path}?zzz=1`, viewer), env, {}, deps)), `${name} 400`).toEqual(badRequestSnap(route.message));
      if (route.siteChecked) {
        expect(await snapshot(await handle(getRequest(`${route.path}?${route.valid}`, viewer, { "Sec-Fetch-Site": "cross-site" }), env, {}, deps)), `${name} 403`).toEqual(ORIGIN_MISMATCH);
      }
      expect(touched).toEqual([]);
    }
  });
});

describe("クエリ禁止の検査(5 ルート): クエリが 1 つでも付けば 400。日付・月・id の検査との順序も固定", () => {
  const PATHS = ["/api/analyses/123", "/api/reports", "/api/reports/20261005", "/api/monthly-reports", "/api/monthly-reports/202609"];

  it.each(PATHS)("%s: 任意のクエリ(値あり・値なし・キー空)は 400。管理者も閲覧者も。裏側に触れない", async (path) => {
    const { deps, admin, viewer } = await setup();
    for (const token of [admin, viewer]) {
      for (const query of ["x=1", "a=", "=", "x=1&x=2"]) {
        const { env, touched } = trackedEnv();
        const got = await snapshot(await handle(getRequest(`${path}?${query}`, token), env, {}, deps));
        expect(got, query).toEqual(badRequestSnap(NO_QUERY_MESSAGE));
        expect(touched, query).toEqual([]);
      }
    }
  });

  it.each(PATHS)("%s: クエリが無ければ検査を通って次の段階(裏側)に進む。どのルートの許可キーも 1 つ付くだけで 400(過剰許可でない)", async (path) => {
    const { deps, admin } = await setup();
    const reached = trackedEnv();
    const outcome = await handle(getRequest(path, admin), reached.env, {}, deps).then(
      (response) => snapshot(response),
      () => "threw",
    );
    expect(reached.touched.length, "裏側に触れた = クエリ検査を通った").toBeGreaterThan(0);
    expect(outcome).not.toEqual(badRequestSnap(NO_QUERY_MESSAGE));
    for (const key of ["kaisai_date", "venue", "race_id", "limit", "days", "cells", "refresh", "status", "type"]) {
      const { env, touched } = trackedEnv();
      expect(await snapshot(await handle(getRequest(`${path}?${key}=1`, admin), env, {}, deps)), key).toEqual(badRequestSnap(NO_QUERY_MESSAGE));
      expect(touched, key).toEqual([]);
    }
  });

  it("順序: 日報の日付・月報の月が不正なら 404 が先(クエリの 400 にならない)。分析 id は逆で、クエリの 400 が先", async () => {
    const { deps, admin } = await setup();
    const notFound = jsonSnap(404, { ok: false, error: { type: "not-found" } });
    for (const path of ["/api/reports/20261340", "/api/reports/abc", "/api/reports/2026100", "/api/monthly-reports/202613", "/api/monthly-reports/abc"]) {
      const { env, touched } = trackedEnv();
      expect(await snapshot(await handle(getRequest(`${path}?x=1`, admin), env, {}, deps)), path).toEqual(notFound);
      expect(touched).toEqual([]);
    }
    const idMessage = "分析 id は 1〜2147483647 の整数(先頭に 0 を付けない)で指定してください";
    expect(await snapshot(await handle(getRequest("/api/analyses/0?x=1", admin), trackedEnv().env, {}, deps))).toEqual(badRequestSnap(NO_QUERY_MESSAGE));
    expect(await snapshot(await handle(getRequest("/api/analyses/0", admin), trackedEnv().env, {}, deps))).toEqual(badRequestSnap(idMessage));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (b) 日報と月報: list / detail / run
// ---------------------------------------------------------------------------------------------------------------------

type Kind = "daily" | "monthly";
type JobState = "running" | "regenerate" | "extra-keys" | "none" | "undefined-return" | "throws" | "no-binding";

const JOB_STATES: readonly JobState[] = ["running", "regenerate", "extra-keys", "none", "undefined-return", "throws", "no-binding"];
const BODY = { format: 1, note: "本文" };

interface Fakes {
  readonly env: Env;
  /** DO の getStatus に渡された引数。 */
  readonly statusCalls: string[];
  /** DO の依頼に渡された入力。 */
  readonly requests: unknown[];
  /** DO の binding に触れたか(`idFromName` の呼び出し回数)。 */
  names: string[];
}

interface FakeOptions {
  readonly kind: Kind;
  readonly reportExists: boolean;
  readonly job: JobState;
  readonly requestResult?: unknown;
  readonly requestFails?: boolean;
  readonly dbFails?: boolean;
}

function statusFor(job: JobState): unknown {
  switch (job) {
    case "running":
      return { phase: "gather", status: "running", attempts: 2 };
    case "regenerate":
      return { phase: "generate", status: "failed", attempts: 3, regenerate: true };
    case "extra-keys":
      return { phase: "save", status: "running", attempts: 1, regenerate: false, leaked: "SECRET" };
    case "undefined-return":
      return undefined; // DO の getStatus が(型に反して)undefined を返す。「ジョブなし」(null)でも「binding なし」でもなく、読めなかった扱い(unavailable)
    default:
      return null;
  }
}

function fakes(options: FakeOptions): Fakes {
  const statusCalls: string[] = [];
  const requests: unknown[] = [];
  const names: string[] = [];
  const dateRow = { kaisaiDate: "20261005", createdAt: "2026-10-05T11:00:00.000Z", model: "claude-sonnet-5-5", raceCount: 24, totalStake: 12000, totalReturn: 15600, summary: "総括A", bodyJson: JSON.stringify(BODY), llmCallsJson: null };
  const monthRow = { month: "202609", createdAt: "2026-09-30T13:00:00.000Z", model: null, raceCount: 120, totalStake: 40000, totalReturn: 34000, summary: null, bodyJson: JSON.stringify(BODY), llmCallsJson: null };
  const row = options.kind === "daily" ? dateRow : monthRow;
  const rowKey = options.kind === "daily" ? "20261005" : "202609";
  const binding = {
    idFromName: (name: string) => {
      names.push(name);
      return name;
    },
    get: () => ({
      requestReport: async (input: unknown) => {
        requests.push(input);
        if (options.requestFails === true) throw new Error("DO の詳細 SECRET-DO");
        return options.requestResult;
      },
      requestMonthlyReport: async (input: unknown) => {
        requests.push(input);
        if (options.requestFails === true) throw new Error("DO の詳細 SECRET-DO");
        return options.requestResult;
      },
      getStatus: async (key: string) => {
        statusCalls.push(key);
        if (options.job === "throws") throw new Error("DO の詳細 SECRET-DO");
        return statusFor(options.job);
      },
    }),
  };
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (options.dbFails === true) throw new Error("D1 の詳細 SECRET-D1");
          return options.reportExists && args[0] === rowKey ? row : null;
        },
        all: async () => {
          if (options.dbFails === true) throw new Error("D1 の詳細 SECRET-D1");
          return { results: options.reportExists ? [row] : [] };
        },
      }),
    }),
    batch: boom,
  };
  const bindingKey = options.kind === "daily" ? "DAILY_REPORT" : "MONTHLY_REPORT";
  const env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: boom, get: boom },
    RACE_DAY: { idFromName: boom, get: boom },
    DB: db,
    ANALYSIS_DETAIL: { get: boom, put: boom },
    ...(options.job === "no-binding" ? {} : { [bindingKey]: binding }),
  } as unknown as Env;
  return { env, statusCalls, requests, names };
}

describe("日報・月報の list: 本文の形(キー順込み)・件数・D1 の失敗", () => {
  it("日報の一覧", async () => {
    const { deps, admin, viewer } = await setup();
    for (const token of [admin, viewer]) {
      const f = fakes({ kind: "daily", reportExists: true, job: "none" });
      expect(await snapshot(await handle(getRequest("/api/reports", token), f.env, {}, deps))).toEqual(
        jsonSnap(200, { ok: true, reports: [{ date: "20261005", created_at: "2026-10-05T11:00:00.000Z", model: "claude-sonnet-5-5", race_count: 24, total_stake: 12000, total_return: 15600, summary: "総括A" }] }),
      );
      expect(f.statusCalls).toEqual([]); // 一覧は DO に触れない
      expect(f.names).toEqual([]);
    }
  });

  it("月報の一覧", async () => {
    const { deps, admin, viewer } = await setup();
    for (const token of [admin, viewer]) {
      const f = fakes({ kind: "monthly", reportExists: true, job: "none" });
      expect(await snapshot(await handle(getRequest("/api/monthly-reports", token), f.env, {}, deps))).toEqual(
        jsonSnap(200, { ok: true, reports: [{ month: "202609", created_at: "2026-09-30T13:00:00.000Z", model: null, race_count: 120, total_stake: 40000, total_return: 34000, summary: null }] }),
      );
      expect(f.statusCalls).toEqual([]);
      expect(f.names).toEqual([]);
    }
  });

  it.each([["/api/reports", "daily"], ["/api/monthly-reports", "monthly"]] as const)("%s: D1 の失敗は 503 report-error(例外の文面は出ない)", async (path, kind) => {
    const { deps, admin } = await setup();
    const f = fakes({ kind, reportExists: true, job: "none", dbFails: true });
    const got = await snapshot(await handle(getRequest(path, admin), f.env, {}, deps));
    expect(got).toEqual(jsonSnap(503, { ok: false, error: { type: "report-error" } }));
    expect(got.body).not.toContain("SECRET");
  });
});

describe("日報・月報の detail: 役割 × 報告の有無 × DO の状態。閲覧者の扱いは日報と月報で意図的に違う", () => {
  it("前提: DO の状態は 7 つ。getStatus が undefined を返す状態を含む(unavailable の経路が 2 通り: throw と undefined)", () => {
    expect(JOB_STATES).toHaveLength(7);
    expect(JOB_STATES).toContain("undefined-return");
  });

  /** 期待する DO の読みと job。日報: 管理者か、日報が無いとき(閲覧者にも)読む。月報: 管理者だけ読む。 */
  function expected(kind: Kind, role: "admin" | "viewer", reportExists: boolean, job: JobState): { called: boolean; job: unknown; jobStatus: "ok" | "unavailable" } {
    const reads = kind === "daily" ? role === "admin" || !reportExists : role === "admin";
    if (!reads || job === "no-binding" || job === "none") {
      return { called: reads && job !== "no-binding", job: null, jobStatus: "ok" };
    }
    if (job === "throws" || job === "undefined-return") {
      return { called: true, job: null, jobStatus: "unavailable" };
    }
    const status = statusFor(job) as { phase: string; status: string; attempts: number; regenerate?: unknown };
    return { called: true, job: { phase: status.phase, status: status.status, attempts: status.attempts, ...(status.regenerate === true ? { regenerate: true } : {}) }, jobStatus: "ok" };
  }

  function expectedBody(kind: Kind, reportExists: boolean, job: unknown, jobStatus: string): unknown {
    if (kind === "daily") {
      return {
        ok: true,
        report: reportExists ? { date: "20261005", created_at: "2026-10-05T11:00:00.000Z", model: "claude-sonnet-5-5", race_count: 24, total_stake: 12000, total_return: 15600, summary: "総括A", body: BODY } : null,
        job,
        job_status: jobStatus,
      };
    }
    return {
      ok: true,
      report: reportExists ? { month: "202609", created_at: "2026-09-30T13:00:00.000Z", model: null, race_count: 120, total_stake: 40000, total_return: 34000, summary: null, body: BODY } : null,
      job,
      job_status: jobStatus,
    };
  }

  for (const kind of ["daily", "monthly"] as const) {
    for (const role of ["admin", "viewer"] as const) {
      for (const reportExists of [true, false]) {
        it(`${kind}・${role}・報告${reportExists ? "あり" : "なし"}: DO の ${JOB_STATES.length} 状態(${JOB_STATES.join("・")})で、応答の生テキストと DO の読みが期待どおり`, async () => {
          const { deps, admin, viewer } = await setup();
          const path = kind === "daily" ? "/api/reports/20261005" : "/api/monthly-reports/202609";
          const missingPath = kind === "daily" ? "/api/reports/20261003" : "/api/monthly-reports/202608";
          for (const job of JOB_STATES) {
            const f = fakes({ kind, reportExists, job });
            const got = await snapshot(await handle(getRequest(path, role === "admin" ? admin : viewer), f.env, {}, deps));
            const want = expected(kind, role, reportExists, job);
            expect(got, `${job}`).toEqual(jsonSnap(200, expectedBody(kind, reportExists, want.job, want.jobStatus)));
            expect(f.statusCalls, `${job}: DO の getStatus の呼び出し`).toEqual(want.called ? [path.split("/").pop()] : []);
            // 報告が無い日(D1 に行が無い別の日付)も同じ規則
            const f2 = fakes({ kind, reportExists, job });
            const got2 = await snapshot(await handle(getRequest(missingPath, role === "admin" ? admin : viewer), f2.env, {}, deps));
            const want2 = expected(kind, role, false, job);
            expect(got2, `${job}(別の日)`).toEqual(jsonSnap(200, expectedBody(kind, false, want2.job, want2.jobStatus)));
          }
        });
      }
    }
  }

  it("前提(意図的な差が表に現れている): 閲覧者が報告なしの日を見ると、日報は DO を読むが月報は読まない", async () => {
    const { deps, viewer } = await setup();
    const daily = fakes({ kind: "daily", reportExists: false, job: "running" });
    await handle(getRequest("/api/reports/20261005", viewer), daily.env, {}, deps);
    expect(daily.statusCalls).toEqual(["20261005"]);
    const monthly = fakes({ kind: "monthly", reportExists: false, job: "running" });
    await handle(getRequest("/api/monthly-reports/202609", viewer), monthly.env, {}, deps);
    expect(monthly.statusCalls).toEqual([]);
    expect(monthly.names).toEqual([]);
  });

  it.each([["/api/reports/20261005", "daily"], ["/api/monthly-reports/202609", "monthly"]] as const)("%s: D1 の失敗は 503 report-error で、DO を読まない", async (path, kind) => {
    const { deps, admin } = await setup();
    const f = fakes({ kind, reportExists: true, job: "running", dbFails: true });
    const got = await snapshot(await handle(getRequest(path, admin), f.env, {}, deps));
    expect(got).toEqual(jsonSnap(503, { ok: false, error: { type: "report-error" } }));
    expect(f.statusCalls).toEqual([]);
  });
});

describe("日報・月報の run(POST): 検証の順序・DO の断りの写し(409/429/503)・本文", () => {
  const post = (path: string, token: string, body: unknown, headers: Record<string, string> = {}): Request =>
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": token, origin: ORIGIN, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const DAILY = { kind: "daily" as Kind, path: "/api/reports/run", good: { date: "20261005" }, key: "date", accepted: { ok: true, accepted: true, date: "20261005" }, mode: (m: string) => ({ kaisaiDate: "20261005", mode: m }) };
  const MONTHLY = { kind: "monthly" as Kind, path: "/api/monthly-reports/run", good: { month: "202609" }, key: "month", accepted: { ok: true, accepted: true, month: "202609" }, mode: (m: string) => ({ month: "202609", mode: m }) };
  const ROUTES = [DAILY, MONTHLY];

  const REASONS = ["exists", "in-progress", "not-exists", "daily-limit", "invalid-date", "invalid-month", "future-date", "not-ended", "too-old", "bogus"];
  function refusal(reason: string, regenerate: boolean): Snapshot {
    if (reason === "exists" && !regenerate) return jsonSnap(409, { ok: false, error: { type: "already-exists" } });
    if (reason === "in-progress") return jsonSnap(409, { ok: false, error: { type: "in-progress" } });
    if (regenerate && reason === "not-exists") return jsonSnap(409, { ok: false, error: { type: "not-exists" } });
    if (regenerate && reason === "daily-limit") return jsonSnap(429, { ok: false, error: { type: "daily-limit" } });
    return jsonSnap(503, { ok: false, error: { type: "report-error" } });
  }

  for (const route of ROUTES) {
    it(`${route.kind}: DO の断りの理由 ${REASONS.length} 種 × regenerate(無し・false・true)の写し`, async () => {
      const { deps, admin } = await setup();
      for (const reason of REASONS) {
        for (const regenerate of [undefined, false, true]) {
          const f = fakes({ kind: route.kind, reportExists: true, job: "none", requestResult: { accepted: false, reason } });
          const body = regenerate === undefined ? route.good : { ...route.good, regenerate };
          const got = await snapshot(await handle(post(route.path, admin, body), f.env, {}, deps));
          expect(got, `${reason}/${String(regenerate)}`).toEqual(refusal(reason, regenerate === true));
          expect(f.requests, `${reason}/${String(regenerate)}`).toEqual([route.mode(regenerate === true ? "regenerate" : "manual")]);
        }
      }
    });

    it(`${route.kind}: 受理は 202(本文のキー順込み)。mode は regenerate:true のときだけ regenerate`, async () => {
      const { deps, admin } = await setup();
      for (const [regenerate, mode] of [[undefined, "manual"], [false, "manual"], [true, "regenerate"]] as const) {
        const f = fakes({ kind: route.kind, reportExists: true, job: "none", requestResult: { accepted: true } });
        const body = regenerate === undefined ? route.good : { ...route.good, regenerate };
        expect(await snapshot(await handle(post(route.path, admin, body), f.env, {}, deps))).toEqual(jsonSnap(202, route.accepted));
        expect(f.requests).toEqual([route.mode(mode)]);
      }
    });

    it(`${route.kind}: DO の失敗・binding なしは 503 report-error(例外の文面は出ない)`, async () => {
      const { deps, admin } = await setup();
      const failing = fakes({ kind: route.kind, reportExists: true, job: "none", requestFails: true });
      const got = await snapshot(await handle(post(route.path, admin, route.good), failing.env, {}, deps));
      expect(got).toEqual(jsonSnap(503, { ok: false, error: { type: "report-error" } }));
      expect(got.body).not.toContain("SECRET");
      const none = fakes({ kind: route.kind, reportExists: true, job: "no-binding" });
      expect(await snapshot(await handle(post(route.path, admin, route.good), none.env, {}, deps))).toEqual(jsonSnap(503, { ok: false, error: { type: "report-error" } }));
    });

    it(`${route.kind}: regenerate が boolean でなければ 400(同じ文言)。DO は呼ばれない`, async () => {
      const { deps, admin } = await setup();
      for (const value of ["true", 1, null, [true], {}]) {
        const f = fakes({ kind: route.kind, reportExists: true, job: "none", requestResult: { accepted: true } });
        expect(await snapshot(await handle(post(route.path, admin, { ...route.good, regenerate: value }), f.env, {}, deps))).toEqual(badRequestSnap("regenerate は true または false で指定してください"));
        expect(f.requests).toEqual([]);
        expect(f.names).toEqual([]);
      }
    });

    it(`${route.kind}: 守り(Origin 403 → Content-Type 415 → 413 → JSON 400)は検証より先。閲覧者は admin-only の 403`, async () => {
      const { deps, admin, viewer } = await setup();
      const f = fakes({ kind: route.kind, reportExists: true, job: "none", requestResult: { accepted: true } });
      expect(await snapshot(await handle(post(route.path, admin, "{壊れた", { origin: "https://evil.example", "content-type": "text/plain" }), f.env, {}, deps))).toEqual(ORIGIN_MISMATCH);
      const mediaType = await snapshot(await handle(post(route.path, admin, route.good, { "content-type": "text/plain" }), f.env, {}, deps));
      expect(mediaType).toEqual(jsonSnap(415, { ok: false, error: { type: "unsupported-media-type", message: "Content-Type は application/json にしてください" } }));
      const tooLarge = await snapshot(await handle(post(route.path, admin, JSON.stringify({ ...route.good, pad: "x".repeat(2000) })), f.env, {}, deps));
      expect(tooLarge).toEqual(jsonSnap(413, { ok: false, error: { type: "payload-too-large", message: "本文は 1024 バイトまでです" } }));
      expect(await snapshot(await handle(post(route.path, admin, "{壊れた"), f.env, {}, deps))).toEqual(badRequestSnap("本文が JSON として読めません"));
      expect(await snapshot(await handle(post(route.path, admin, "[1]"), f.env, {}, deps))).toEqual(badRequestSnap("本文は JSON のオブジェクトにしてください"));
      expect(await snapshot(await handle(post(route.path, viewer, route.good), f.env, {}, deps))).toEqual(jsonSnap(403, { ok: false, error: { type: "admin-only" } }));
      expect(f.requests).toEqual([]);
    });
  }

  it("daily: 検証の順序 — 余計なキー → date の型 → 開催日の形 → regenerate の型 → 今日以前(DO は呼ばない)", async () => {
    const { deps, admin } = await setup();
    const cases: Array<[unknown, Snapshot]> = [
      [{ date: "20261005", zzz: 1 }, badRequestSnap("本文のキーは date だけです")],
      [{ date: "bad", zzz: 1, regenerate: "x" }, badRequestSnap("本文のキーは date だけです")],
      [{ date: 20261005 }, badRequestSnap("date は YYYYMMDD の 8 桁の文字列で指定してください")],
      [{}, badRequestSnap("date は YYYYMMDD の 8 桁の文字列で指定してください")],
      [{ date: "2026100", regenerate: "x" }, badRequestSnap((checkKaisaiDate("2026100") as { message: string }).message)],
      [{ date: "20261340", regenerate: "x" }, badRequestSnap((checkKaisaiDate("20261340") as { message: string }).message)],
      [{ date: "20271005", regenerate: "x" }, badRequestSnap("regenerate は true または false で指定してください")],
      [{ date: "20261007" }, badRequestSnap("date は今日(20261006)以前にしてください")],
      [{ date: "20271005", regenerate: true }, badRequestSnap("date は今日(20261006)以前にしてください")],
    ];
    for (const [body, want] of cases) {
      const f = fakes({ kind: "daily", reportExists: true, job: "none", requestResult: { accepted: true } });
      expect(await snapshot(await handle(post("/api/reports/run", admin, body), f.env, {}, deps)), JSON.stringify(body)).toEqual(want);
      expect(f.requests).toEqual([]);
    }
    expect((checkKaisaiDate("2026100") as { ok: boolean }).ok).toBe(false); // 前提: 上の 2 件が実際に検証の失敗である(空振りでない)
    expect((checkKaisaiDate("20261340") as { ok: boolean }).ok).toBe(false);
  });

  it("monthly: 検証の順序 — 余計なキー → month の型・実在 → regenerate の型 → 終わった月(DO は呼ばない)", async () => {
    const { deps, admin } = await setup();
    const monthMessage = "month は YYYYMM の 6 桁の文字列(実在の月)で指定してください";
    const notEnded = "month は終わった月(今月より前)にしてください。今月の月報は、月の最終日の夜に自動で作られます";
    const cases: Array<[unknown, Snapshot]> = [
      [{ month: "202609", zzz: 1 }, badRequestSnap("本文のキーは month と regenerate だけです")],
      [{ month: "bad", zzz: 1, regenerate: "x" }, badRequestSnap("本文のキーは month と regenerate だけです")],
      [{ month: 202609 }, badRequestSnap(monthMessage)],
      [{}, badRequestSnap(monthMessage)],
      [{ month: "202613", regenerate: "x" }, badRequestSnap(monthMessage)],
      [{ month: "20269", regenerate: "x" }, badRequestSnap(monthMessage)],
      [{ month: "202610", regenerate: "x" }, badRequestSnap("regenerate は true または false で指定してください")],
      [{ month: "202610" }, badRequestSnap(notEnded)],
      [{ month: "202611", regenerate: true }, badRequestSnap(notEnded)],
    ];
    for (const [body, want] of cases) {
      const f = fakes({ kind: "monthly", reportExists: true, job: "none", requestResult: { accepted: true } });
      expect(await snapshot(await handle(post("/api/monthly-reports/run", admin, body), f.env, {}, deps)), JSON.stringify(body)).toEqual(want);
      expect(f.requests).toEqual([]);
    }
  });
});
