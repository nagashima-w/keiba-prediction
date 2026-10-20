import { describe, expect, it } from "vitest";
import { fetchBoard, fetchRaces, type ApiFailure, type FetchLike } from "../client/api";
import { postBulk } from "../client/api-bulk";
import { fetchMonthly, fetchMonthlyList, postMonthlyRun } from "../client/api-monthly";
import { fetchPromptPreview } from "../client/api-prompt-preview";
import { fetchReport, fetchReportList, postReportRun } from "../client/api-report";
import { postRun } from "../client/api-run";
import { fetchSettings, postSettings } from "../client/api-settings";
import { fetchVerify } from "../client/api-verify";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";

/**
 * Issue #397(R-6)の特性テスト: client の API 層(送受信まわり・日報と月報の取得)の**今の挙動**を固定する。
 * 共通化(`getJson`・`postJson`・`readBody`・分類・一覧/詳細の前半・先頭 7 項目)の前後で、次が 1 つも変わらないことを守る。
 *   (1) 各関数が送るリクエスト(URL・メソッド・ヘッダ・credentials・referrerPolicy・本文。`mode` は付けない)
 *   (2) 例外(同期・非同期)と JSON でない応答の扱い
 *   (3) ステータスと本文から決まる失敗の分類(関数の系統ごとに違う: 下の `SCENARIOS`)
 *   (4) 日報・月報の一覧と詳細の先頭 7 項目の検査
 * 期待値はコードの出力の写しではなく、各系統の仕様(分類の規則)から表に直書きした。**共通化の前のコードで緑になることを確かめてから共通化した**。
 */

const GET_INIT = { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } };
const postInit = (body: string) => ({
  method: "POST",
  credentials: "same-origin",
  referrerPolicy: "same-origin",
  headers: { "content-type": "application/json", accept: "application/json" },
  body,
});

const DATE = "20261005";
const MONTH = "202610";
const RACE_ID = "202603020211";

type Call = (f: FetchLike) => Promise<unknown>;
interface RequestCase {
  readonly name: string;
  readonly call: Call;
  readonly url: string;
  readonly init: Record<string, unknown>;
}

const REQUEST_CASES: readonly RequestCase[] = [
  { name: "fetchRaces", call: (f) => fetchRaces(f, DATE, "nar"), url: `/api/races?kaisai_date=${DATE}&venue=nar`, init: GET_INIT },
  { name: "fetchBoard", call: (f) => fetchBoard(f, DATE), url: `/api/analyses/status?kaisai_date=${DATE}`, init: GET_INIT },
  { name: "fetchReportList", call: (f) => fetchReportList(f), url: "/api/reports", init: GET_INIT },
  { name: "fetchReport", call: (f) => fetchReport(f, DATE), url: `/api/reports/${DATE}`, init: GET_INIT },
  { name: "fetchMonthlyList", call: (f) => fetchMonthlyList(f), url: "/api/monthly-reports", init: GET_INIT },
  { name: "fetchMonthly", call: (f) => fetchMonthly(f, MONTH), url: `/api/monthly-reports/${MONTH}`, init: GET_INIT },
  { name: "fetchSettings", call: (f) => fetchSettings(f), url: "/api/settings", init: GET_INIT },
  { name: "fetchVerify(refresh なし)", call: (f) => fetchVerify(f, "central", false), url: "/api/verify?venue=central", init: GET_INIT },
  { name: "fetchVerify(refresh あり)", call: (f) => fetchVerify(f, "nar", true), url: "/api/verify?venue=nar&refresh=1", init: GET_INIT },
  {
    name: "postRun(分析の起動)",
    call: (f) => postRun(f, { raceId: RACE_ID, date: DATE, mode: "morning" }),
    url: "/api/analyses/run",
    init: postInit(JSON.stringify({ race_id: RACE_ID, kaisai_date: DATE, mode: "morning" })),
  },
  {
    name: "postBulk",
    call: (f) => postBulk(f, { date: DATE, mode: "pre_race", raceIds: [RACE_ID, "202603020212"] }),
    url: "/api/analyses/run/bulk",
    init: postInit(JSON.stringify({ kaisai_date: DATE, mode: "pre_race", race_ids: [RACE_ID, "202603020212"] })),
  },
  { name: "postSettings", call: (f) => postSettings(f, DEFAULT_CLOUD_SETTINGS), url: "/api/settings", init: postInit(JSON.stringify(DEFAULT_CLOUD_SETTINGS)) },
  { name: "postReportRun(作成)", call: (f) => postReportRun(f, DATE), url: "/api/reports/run", init: postInit(JSON.stringify({ date: DATE })) },
  { name: "postReportRun(作り直し)", call: (f) => postReportRun(f, DATE, true), url: "/api/reports/run", init: postInit(JSON.stringify({ date: DATE, regenerate: true })) },
  { name: "postMonthlyRun(作成)", call: (f) => postMonthlyRun(f, MONTH), url: "/api/monthly-reports/run", init: postInit(JSON.stringify({ month: MONTH })) },
  { name: "postMonthlyRun(作り直し)", call: (f) => postMonthlyRun(f, MONTH, true), url: "/api/monthly-reports/run", init: postInit(JSON.stringify({ month: MONTH, regenerate: true })) },
  {
    name: "fetchPromptPreview",
    call: (f) => fetchPromptPreview(f, { additionalInstruction: "慎重に", clipVariant: "wide15" }),
    url: "/api/settings/prompt-preview",
    init: postInit(JSON.stringify({ additionalInstruction: "慎重に", clipVariant: "wide15" })),
  },
];

/** fetch の偽物。呼ばれた (url, init) を記録する。 */
function recorder(respond: () => { status: number; json: () => Promise<unknown> }): { fetch: FetchLike; calls: { url: string; init: unknown }[] } {
  const calls: { url: string; init: unknown }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

describe("リクエストの形(共通化の前後で 1 バイトも変えない)", () => {
  it("表は 17 件(関数の追加・削除に気づく)", () => {
    expect(REQUEST_CASES).toHaveLength(17);
  });

  for (const c of REQUEST_CASES) {
    it(`${c.name}: URL・init が表のとおり(fetch は 1 回。init に mode を含めない)`, async () => {
      const r = recorder(() => ({ status: 200, json: async () => ({}) }));
      await c.call(r.fetch);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.url).toBe(c.url);
      expect(r.calls[0]!.init).toStrictEqual(c.init);
      expect(Object.keys(r.calls[0]!.init as object)).not.toContain("mode");
    });
  }
});

/** 失敗を表の記法(`kind`・`unexpected:<status>`・`bad-request+stale`・`netkeiba:<reason>`)に直す。 */
function tagOfFailure(f: ApiFailure): string {
  if (f.kind === "unexpected") return `unexpected:${f.httpStatus}`;
  if (f.kind === "bad-request") return f.staleScreen === true ? "bad-request+stale" : "bad-request";
  if (f.kind === "netkeiba-unavailable") return `netkeiba:${f.reason}`;
  return f.kind;
}
/** 結果から失敗の記法を取る。失敗でなければ `NOT-FAILURE:` + JSON。 */
function tagOf(result: unknown): string {
  const r = result as { ok?: boolean; error?: ApiFailure; kind?: string; failure?: ApiFailure };
  if (r.ok === false && r.error !== undefined) return tagOfFailure(r.error);
  if (r.kind === "failed" && r.failure !== undefined) return tagOfFailure(r.failure);
  return `NOT-FAILURE:${JSON.stringify(result)}`;
}

type Family = "list" | "detail" | "settings" | "verify" | "write" | "preview";
type ClassifiedFamily = Exclude<Family, "preview">;
interface Fn {
  readonly name: string;
  readonly family: Family;
  readonly call: Call;
}
const FNS: readonly Fn[] = [
  { name: "fetchReportList", family: "list", call: (f) => fetchReportList(f) },
  { name: "fetchMonthlyList", family: "list", call: (f) => fetchMonthlyList(f) },
  { name: "fetchReport", family: "detail", call: (f) => fetchReport(f, DATE) },
  { name: "fetchMonthly", family: "detail", call: (f) => fetchMonthly(f, MONTH) },
  { name: "fetchSettings", family: "settings", call: (f) => fetchSettings(f) },
  { name: "postSettings", family: "settings", call: (f) => postSettings(f, DEFAULT_CLOUD_SETTINGS) },
  { name: "fetchVerify", family: "verify", call: (f) => fetchVerify(f, "central", false) },
  { name: "postRun", family: "write", call: (f) => postRun(f, { raceId: RACE_ID, date: DATE, mode: "morning" }) },
  { name: "postBulk", family: "write", call: (f) => postBulk(f, { date: DATE, mode: "morning", raceIds: [RACE_ID] }) },
  { name: "postReportRun", family: "write", call: (f) => postReportRun(f, DATE) },
  { name: "postMonthlyRun", family: "write", call: (f) => postMonthlyRun(f, MONTH) },
  { name: "fetchPromptPreview", family: "preview", call: (f) => fetchPromptPreview(f, { additionalInstruction: "", clipVariant: "wide15" }) },
];

const failingJson = (status: number): FetchLike => async () => ({
  status,
  json: async () => {
    throw new SyntaxError("SECRET-JSON");
  },
});

describe("例外と JSON でない応答(network・本文なし扱い)", () => {
  it("関数は 12 件(系統は list 2・detail 2・settings 2・verify 1・write 4・preview 1)", () => {
    expect(FNS).toHaveLength(12);
    const count = (family: Family) => FNS.filter((f) => f.family === family).length;
    expect([count("list"), count("detail"), count("settings"), count("verify"), count("write"), count("preview")]).toEqual([2, 2, 2, 1, 4, 1]);
  });

  const NETWORK: Record<Family, unknown> = {
    list: { ok: false, error: { kind: "network" } },
    detail: { ok: false, error: { kind: "network" } },
    settings: { ok: false, error: { kind: "network" } },
    verify: { ok: false, error: { kind: "network" } },
    write: { kind: "failed", failure: { kind: "network" } },
    preview: { ok: false },
  };

  for (const fn of FNS) {
    it(`${fn.name}: fetch が同期で投げても、非同期で reject しても network(例外の文面を持ち込まない)`, async () => {
      const sync = await fn.call(() => {
        throw new Error("SECRET-SYNC");
      });
      const asyncFail = await fn.call(async () => {
        throw new Error("SECRET-ASYNC");
      });
      expect(sync).toStrictEqual(NETWORK[fn.family]);
      expect(asyncFail).toStrictEqual(NETWORK[fn.family]);
      expect(JSON.stringify([sync, asyncFail])).not.toContain("SECRET");
    });
  }

  for (const fn of FNS.filter((f) => f.family !== "write" && f.family !== "preview")) {
    it(`${fn.name}: json() が失敗した 200 は、本文なしとして unexpected:200`, async () => {
      const result = await fn.call(failingJson(200));
      expect(tagOf(result)).toBe("unexpected:200");
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });
  }

  for (const fn of FNS.filter((f) => f.family === "write")) {
    it(`${fn.name}: json() が失敗した 202 は accepted-malformed(サーバは受理している)`, async () => {
      expect(await fn.call(failingJson(202))).toStrictEqual({ kind: "accepted-malformed" });
    });
    it(`${fn.name}: json() が失敗した 409 は unexpected:409`, async () => {
      expect(tagOf(await fn.call(failingJson(409)))).toBe("unexpected:409");
    });
  }

  it("fetchPromptPreview: json() が失敗した 200 は { ok: false }", async () => {
    expect(await fetchPromptPreview(failingJson(200), { additionalInstruction: "", clipVariant: "wide15" })).toStrictEqual({ ok: false });
  });

  it("json() の読み取り回数: fetchPromptPreview は 200 以外では読まない(0 回)。ほかの 11 関数は 200 以外でも 1 回読む", async () => {
    for (const fn of FNS) {
      let reads = 0;
      await fn.call(async () => ({
        status: 500,
        json: async () => {
          reads += 1;
          return {};
        },
      }));
      expect([fn.name, reads]).toEqual([fn.name, fn.family === "preview" ? 0 : 1]);
    }
    let reads200 = 0;
    await fetchPromptPreview(
      async () => ({
        status: 200,
        json: async () => {
          reads200 += 1;
          return {};
        },
      }),
      { additionalInstruction: "", clipVariant: "wide15" },
    );
    expect(reads200).toBe(1);
  });
});

/** 失敗の分類の表の 1 行 = 1 つの (status, body)。列 = 系統。 */
interface Scenario {
  readonly name: string;
  readonly status: number;
  /** undefined は json() が失敗する応答。 */
  readonly body: unknown;
  readonly expected: Readonly<Record<ClassifiedFamily, string>>;
}
const NK = (reason: string) => ({ error: { type: "netkeiba-unavailable", reason } });
const KEYS_MISMATCH = { error: { reason: "keys-mismatch" } };
const row = (list: string, detail: string, settings: string, verify: string, write: string) => ({ list, detail, settings, verify, write });
/**
 * 系統ごとの規則(列の順は row(list, detail, settings, verify, write)):
 *   list: `classify` そのまま(netkeiba の 503 を保つ。413・415 は unexpected)
 *   detail: list に加えて 404 は not-found
 *   settings: 413・415 は bad-request。400 で reason が keys-mismatch のときだけ stale。netkeiba の 503 は server-error
 *   verify: `classify` のあと netkeiba の 503 を server-error にする。**413・415 の分岐は無い**(unexpected のまま)
 *   write(分析の起動・一括・日報・月報の作成): 400・413・415 は bad-request。そのほかは `classify` のあと netkeiba の 503 を server-error にする
 */
const SCENARIOS: readonly Scenario[] = [
  { name: "400", status: 400, body: {}, expected: row("bad-request", "bad-request", "bad-request", "bad-request", "bad-request") },
  { name: "400 keys-mismatch", status: 400, body: KEYS_MISMATCH, expected: row("bad-request", "bad-request", "bad-request+stale", "bad-request", "bad-request") },
  { name: "413 keys-mismatch(400 以外では stale にしない)", status: 413, body: KEYS_MISMATCH, expected: row("unexpected:413", "unexpected:413", "bad-request", "unexpected:413", "bad-request") },
  { name: "401", status: 401, body: {}, expected: row("unexpected:401", "unexpected:401", "unexpected:401", "unexpected:401", "unexpected:401") },
  { name: "403", status: 403, body: {}, expected: row("forbidden", "forbidden", "forbidden", "forbidden", "forbidden") },
  { name: "403 origin-mismatch", status: 403, body: { error: { type: "origin-mismatch" } }, expected: row("origin-mismatch", "origin-mismatch", "origin-mismatch", "origin-mismatch", "origin-mismatch") },
  { name: "403 本文が平文(json 失敗)", status: 403, body: undefined, expected: row("forbidden", "forbidden", "forbidden", "forbidden", "forbidden") },
  { name: "404", status: 404, body: {}, expected: row("unexpected:404", "not-found", "unexpected:404", "unexpected:404", "unexpected:404") },
  { name: "413", status: 413, body: {}, expected: row("unexpected:413", "unexpected:413", "bad-request", "unexpected:413", "bad-request") },
  { name: "415", status: 415, body: {}, expected: row("unexpected:415", "unexpected:415", "bad-request", "unexpected:415", "bad-request") },
  { name: "429(daily-limit でない)", status: 429, body: {}, expected: row("unexpected:429", "unexpected:429", "unexpected:429", "unexpected:429", "unexpected:429") },
  { name: "500", status: 500, body: {}, expected: row("unexpected:500", "unexpected:500", "unexpected:500", "unexpected:500", "unexpected:500") },
  { name: "502 本文が平文(json 失敗)", status: 502, body: undefined, expected: row("unexpected:502", "unexpected:502", "unexpected:502", "unexpected:502", "unexpected:502") },
  { name: "503 本文なし", status: 503, body: {}, expected: row("server-error", "server-error", "server-error", "server-error", "server-error") },
  { name: "503 別の type", status: 503, body: { error: { type: "other" } }, expected: row("server-error", "server-error", "server-error", "server-error", "server-error") },
  { name: "503 netkeiba blocked", status: 503, body: NK("blocked"), expected: row("netkeiba:blocked", "netkeiba:blocked", "server-error", "server-error", "server-error") },
  { name: "503 netkeiba busy", status: 503, body: NK("busy"), expected: row("netkeiba:busy", "netkeiba:busy", "server-error", "server-error", "server-error") },
  { name: "503 netkeiba 別の reason", status: 503, body: NK("zzz"), expected: row("netkeiba:failed", "netkeiba:failed", "server-error", "server-error", "server-error") },
  { name: "200 だが本文が {}(成功の形でない)", status: 200, body: {}, expected: row("unexpected:200", "unexpected:200", "unexpected:200", "unexpected:200", "unexpected:200") },
  { name: "409 本文が {}(write 系は already-* の形でない)", status: 409, body: {}, expected: row("unexpected:409", "unexpected:409", "unexpected:409", "unexpected:409", "unexpected:409") },
];

describe("失敗の分類(系統ごとの真理値表。系統の差を残す: 特に verify は 413・415 を bad-request にしない)", () => {
  it("表は 20 行 × 5 系統", () => {
    expect(SCENARIOS).toHaveLength(20);
    for (const s of SCENARIOS) expect(Object.keys(s.expected).sort()).toEqual(["detail", "list", "settings", "verify", "write"]);
  });

  it("verify と write が 413・415 で分かれる行が表にある(系統を統合する変更を検出できる)", () => {
    const rows = SCENARIOS.filter((s) => (s.status === 413 || s.status === 415) && s.name !== "413 keys-mismatch(400 以外では stale にしない)");
    expect(rows).toHaveLength(2);
    for (const s of rows) {
      expect(s.expected.verify).toBe(`unexpected:${s.status}`);
      expect(s.expected.write).toBe("bad-request");
    }
  });

  for (const fn of FNS.filter((f) => f.family !== "preview")) {
    const family = fn.family as ClassifiedFamily;
    for (const s of SCENARIOS) {
      it(`${fn.name} × ${s.name} → ${s.expected[family]}`, async () => {
        const result = await fn.call(async () => ({
          status: s.status,
          json: async () => {
            if (s.body === undefined) throw new SyntaxError("not json");
            return s.body;
          },
        }));
        expect(tagOf(result)).toBe(s.expected[family]);
      });
    }
  }

  it("fetchPromptPreview: 200 以外はすべて { ok: false }", async () => {
    for (const status of [201, 400, 403, 404, 413, 429, 500, 503]) {
      const result = await fetchPromptPreview(async () => ({ status, json: async () => ({ ok: true, text: "x", clamped: false, promptVersion: "v" }) }), { additionalInstruction: "", clipVariant: "wide15" });
      expect([status, result]).toEqual([status, { ok: false }]);
    }
  });

  it("日報・月報の作成: 429 の daily-limit は daily-limit、409 の already-exists・in-progress はそれぞれの種類、202 は本文が整っていれば accepted", async () => {
    const reply = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });
    expect(await postReportRun(reply(429, { error: { type: "daily-limit" } }), DATE)).toStrictEqual({ kind: "daily-limit" });
    expect(await postMonthlyRun(reply(429, { error: { type: "daily-limit" } }), MONTH)).toStrictEqual({ kind: "daily-limit" });
    expect(await postReportRun(reply(409, { error: { type: "already-exists" } }), DATE)).toStrictEqual({ kind: "already-exists" });
    expect(await postMonthlyRun(reply(409, { error: { type: "in-progress" } }), MONTH)).toStrictEqual({ kind: "in-progress" });
    expect(await postReportRun(reply(202, { ok: true, accepted: true, date: DATE }), DATE)).toStrictEqual({ kind: "accepted" });
    expect(await postMonthlyRun(reply(202, { ok: true, accepted: true, month: MONTH }), MONTH)).toStrictEqual({ kind: "accepted" });
    expect(await postReportRun(reply(202, { ok: true, accepted: true, date: "20261004" }), DATE)).toStrictEqual({ kind: "accepted-malformed" });
  });
});

// ---- 日報・月報の一覧と詳細の先頭 7 項目 ----

const REPORT_STATS = {
  raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, betRaceCount: 1, llmUsedRaceCount: 1,
  totalStake: 100, totalReturn: 0, recoveryRate: null, judgedBetCount: 1, hitBetCount: 0, unjudgedBetCount: 0, unjudgedStake: 0, byBetType: {}, byMark: [],
};
const PERIOD = { ...REPORT_STATS, fromDate: DATE, toDate: DATE, dayCount: 1 };

interface HeadSite {
  readonly name: string;
  /** 先頭 7 項目の ID のキー(date・month)。 */
  readonly idKey: "date" | "month";
  readonly goodId: string;
  readonly badIds: readonly unknown[];
  readonly fetchList: Call;
  readonly fetchDetail: Call;
  readonly detailBody: Record<string, unknown>;
  readonly detailEnvelope: Record<string, unknown>;
  readonly expectedHead: Record<string, unknown>;
}
const HEAD = { created_at: "2026-10-05T11:00:00.000Z", model: "m", race_count: 3, total_stake: 100, total_return: 250, summary: "要約" };
const HEAD_OUT = { createdAt: "2026-10-05T11:00:00.000Z", model: "m", raceCount: 3, totalStake: 100, totalReturn: 250, summary: "要約" };

const HEAD_SITES: readonly HeadSite[] = [
  {
    name: "日報",
    idKey: "date",
    goodId: DATE,
    badIds: [undefined, null, 20261005, "2026-10-05", "2026100", "202610051", "２０２６１００５", "20261005\n"],
    fetchList: (f) => fetchReportList(f),
    fetchDetail: (f) => fetchReport(f, DATE),
    detailBody: { stats: REPORT_STATS, races: [], narrative: null, narrativeRaw: null, note: null },
    detailEnvelope: { ok: true, job: null, job_status: "ok" },
    expectedHead: { date: DATE, ...HEAD_OUT },
  },
  {
    name: "月報",
    idKey: "month",
    goodId: MONTH,
    badIds: [undefined, null, 202610, "2026-10", "20261", "2026100", "202613", "202600", "２０２６１０", "202610\n"],
    fetchList: (f) => fetchMonthlyList(f),
    fetchDetail: (f) => fetchMonthly(f, MONTH),
    detailBody: { stats: { ...PERIOD, days: [], byVersion: [] }, lastDayPending: false },
    detailEnvelope: { ok: true },
    expectedHead: { month: MONTH, ...HEAD_OUT },
  },
];

const BAD_FIELD_VALUES: Readonly<Record<string, readonly unknown[]>> = {
  created_at: [undefined, null, 5],
  model: [undefined, 5],
  race_count: [undefined, null, "3", 1.5, -1, Infinity],
  total_stake: [undefined, null, "1", Infinity],
  total_return: [undefined, null, "1", Infinity],
  summary: [undefined, 5],
};

const UNEXPECTED_200 = { ok: false, error: { kind: "unexpected", httpStatus: 200 } };

/** JSON 経由の応答(Infinity・undefined は JSON にできないので、`json()` が返すオブジェクトをそのまま渡す)。 */
const replyWith = (body: unknown): FetchLike => async () => ({ status: 200, json: async () => body });

describe("日報・月報の先頭 7 項目(一覧の行と詳細の頭。共通化の前後で同じ判定)", () => {
  for (const site of HEAD_SITES) {
    const listBody = (r: unknown) => ({ ok: true, reports: [r] });
    const detailBody = (r: unknown) => ({ ...site.detailEnvelope, report: r });
    const goodRow = { [site.idKey]: site.goodId, ...HEAD };

    describe(site.name, () => {
      it("対照: 正しい行・詳細は成功し、先頭 7 項目が camelCase で同じ順(ID が先頭)に写る", async () => {
        const list = (await site.fetchList(replyWith(listBody(goodRow)))) as { ok: boolean; reports: Record<string, unknown>[] };
        expect(list.ok).toBe(true);
        expect(list.reports).toHaveLength(1);
        expect(list.reports[0]).toStrictEqual(site.expectedHead);
        expect(Object.keys(list.reports[0]!)).toEqual(Object.keys(site.expectedHead));
        const detail = (await site.fetchDetail(replyWith(detailBody({ ...goodRow, body: site.detailBody })))) as { ok: boolean; report: Record<string, unknown> };
        expect(detail.ok).toBe(true);
        const head: Record<string, unknown> = {};
        for (const k of Object.keys(site.expectedHead)) head[k] = detail.report[k];
        expect(head).toStrictEqual(site.expectedHead);
        expect(Object.keys(detail.report).slice(0, 7)).toEqual(Object.keys(site.expectedHead));
      });

      it("対照: model・summary は null でもよい", async () => {
        const r = { ...goodRow, model: null, summary: null };
        expect(((await site.fetchList(replyWith(listBody(r)))) as { ok: boolean }).ok).toBe(true);
        expect(((await site.fetchDetail(replyWith(detailBody({ ...r, body: site.detailBody })))) as { ok: boolean }).ok).toBe(true);
      });

      for (const bad of site.badIds) {
        it(`ID(${site.idKey})が ${JSON.stringify(bad) ?? "undefined"} の行・詳細は unexpected:200`, async () => {
          const r: Record<string, unknown> = { ...goodRow, [site.idKey]: bad };
          expect(await site.fetchList(replyWith(listBody(r)))).toStrictEqual(UNEXPECTED_200);
          expect(await site.fetchDetail(replyWith(detailBody({ ...r, body: site.detailBody })))).toStrictEqual(UNEXPECTED_200);
        });
      }

      for (const [field, values] of Object.entries(BAD_FIELD_VALUES)) {
        for (const bad of values) {
          it(`${field} が ${bad === undefined ? "欠落" : String(bad)}(${typeof bad})の行・詳細は unexpected:200`, async () => {
            const r: Record<string, unknown> = { ...goodRow };
            if (bad === undefined) delete r[field];
            else r[field] = bad;
            expect(await site.fetchList(replyWith(listBody(r)))).toStrictEqual(UNEXPECTED_200);
            expect(await site.fetchDetail(replyWith(detailBody({ ...r, body: site.detailBody })))).toStrictEqual(UNEXPECTED_200);
          });
        }
      }

      it("行が配列でない・null・文字列・数なら unexpected:200。1 行でも壊れていれば全体が unexpected:200", async () => {
        for (const bad of [null, [], "x", 5]) {
          expect(await site.fetchList(replyWith(listBody(bad)))).toStrictEqual(UNEXPECTED_200);
        }
        expect(await site.fetchList(replyWith(listBody(goodRow)))).toMatchObject({ ok: true });
        expect(await site.fetchList(replyWith({ ok: true, reports: [goodRow, { ...goodRow, summary: 5 }] }))).toStrictEqual(UNEXPECTED_200);
      });

      it("詳細の body が無い・null・配列・文字列なら unexpected:200", async () => {
        for (const body of [undefined, null, [], "x"]) {
          const r: Record<string, unknown> = { ...goodRow };
          if (body !== undefined) r["body"] = body;
          expect(await site.fetchDetail(replyWith(detailBody(r)))).toStrictEqual(UNEXPECTED_200);
        }
      });

      it("一覧: reports が配列でない・無い・ok が true でないは unexpected:200 / 404 は、一覧が unexpected:404、詳細が not-found", async () => {
        expect(await site.fetchList(replyWith({ ok: true, reports: {} }))).toStrictEqual(UNEXPECTED_200);
        expect(await site.fetchList(replyWith({ ok: true }))).toStrictEqual(UNEXPECTED_200);
        expect(await site.fetchList(replyWith({ ok: false, reports: [goodRow] }))).toStrictEqual(UNEXPECTED_200);
        const r404: FetchLike = async () => ({ status: 404, json: async () => ({ ok: false }) });
        expect(await site.fetchList(r404)).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 404 } });
        expect(await site.fetchDetail(r404)).toStrictEqual({ ok: false, error: { kind: "not-found" } });
      });
    });
  }
});
