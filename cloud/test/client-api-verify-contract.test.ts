import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchVerify, parseVerifyResponse, PROPOSED_BET_TYPES, verifyFetchFailureMessage } from "../client/api-verify";
import { handle, type Env } from "../src/handler";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { VerifyResponse } from "../src/verify-core";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyReadRows } from "../src/verify-read";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #219: 契約テスト。クライアントの `fetchVerify` が送るリクエストを実際の `handle()`(偽の DO)に通し、**本物の core の `computeVerifyReport` が作った集計**をクライアントの
 * 分類に通す。サーバ(core の `VerifyReport`・`ProposedBetReport`)のキー名・形が変わると、ここで検出する。
 */
const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

/** 中央 1 レース(複勝・単勝・ワイドの買い目と払戻あり)を入れた本物の集計。 */
function realReport() {
  const analysis: VerifyAnalysisRow = {
    id: 1, raceId: "202606030811", analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
  };
  const rows: VerifyReadRows = {
    analyses: [analysis],
    horses: [{ analysisId: 1, umaban: 1, prior: 0.5, adjusted_prob: 0.5, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null }],
    allocationMeta: [{ analysisId: 1, route: "mixed", skipReasonCode: null }],
    bets: [
      { analysisId: 1, betType: "place", comboKey: "01", stake: 200 },
      { analysisId: 1, betType: "win", comboKey: "01", stake: 100 },
      { analysisId: 1, betType: "wide", comboKey: "0102", stake: 300 },
      { analysisId: 1, betType: "mystery", comboKey: "01", stake: 100 },
    ],
    results: [{ raceId: "202606030811", umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 380 }, { raceId: "202606030811", umaban: 2, finishPosition: 2, placePayout: 120, winPayout: null }],
    comboPayouts: [{ raceId: "202606030811", betType: "wide", comboKey: "0102", payout: 450 }],
    comboImports: [{ raceId: "202606030811", betType: "wide" }],
  };
  return computeVerifyReport(buildVerifySource(rows), PRODUCTION_VERIFY_CONFIG, "all");
}

interface Connected {
  readonly fetch: FetchLike;
  response: VerifyResponse;
  fails: boolean;
  readonly calls: Array<{ venue: string; refresh: boolean | undefined }>;
}

async function connect(): Promise<Connected> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const state: Connected = {
    fetch: undefined as never,
    response: { status: "ready", venue: "all", report: realReport(), computedAt: "2026-10-10T03:00:00.000Z", stale: true, staleReason: "min-interval", nextRecomputeAt: "2026-10-10T03:05:00.000Z", diag: { rowsRead: 5, counts: {}, readMs: 1, computeMs: 1, startTimeGaps: { lost: 3, affecting: 2 } } },
    fails: false,
    calls: [],
  };
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: {} as unknown as Env["DB"],
    ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
    VERIFY_REPORT: {
      idFromName: (name: string) => name,
      get: () => ({
        getReport: async (venue, options) => {
          state.calls.push({ venue, refresh: options?.refresh });
          if (state.fails) throw new Error("DO の秘密");
          return state.response;
        },
      }),
    },
  };
  (state as { fetch: FetchLike }).fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    headers.set("Cf-Access-Jwt-Assertion", token);
    headers.set("Sec-Fetch-Site", "same-origin");
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return state;
}

describe("GET /api/verify の契約", () => {
  it("本物の VerifyReport(core)と応答の枠を、クライアントの結果に読める。券種 8 つと合算・母集団・未知の券種・除外 6 カウンタ・診断の欠落件数", async () => {
    const s = await connect();
    const result = await fetchVerify(s.fetch, "all", false);
    expect(result.ok).toBe(true);
    if (!result.ok || result.outcome.kind !== "ready") throw new Error("ready のはず");
    const o = result.outcome;
    expect(o).toMatchObject({ venue: "all", computedAt: "2026-10-10T03:00:00.000Z", stale: true, staleReason: "min-interval", nextRecomputeAt: "2026-10-10T03:05:00.000Z", startTimeGaps: { lost: 3, affecting: 2 } });
    const server = (s.response as Extract<VerifyResponse, { status: "ready" }>).report;
    // 値は core の集計そのもの(キー名の取り違え・欠落があると、ここで食い違う)
    expect(o.report.includedAnalysisCount).toBe(server.includedAnalysisCount);
    expect(o.report.includedAnalysisCount).toBe(1); // 前提(空振り防止): 集計に 1 件入っている
    expect(o.report.bet).toEqual({ betCount: server.bet.betCount, totalStake: server.bet.totalStake, totalReturn: server.bet.totalReturn, recoveryRate: server.bet.recoveryRate, actualPayoutCount: server.bet.actualPayoutCount, approximatePayoutCount: server.bet.approximatePayoutCount });
    expect(o.report.bet.betCount).toBe(1);
    expect(o.report.proposedBet.population).toEqual(server.proposedBet.population);
    expect(o.report.proposedBet.population.allocated).toBe(1);
    const pick = (x: { betCount: number; totalStake: number; totalReturn: number; recoveryRate: number | null; unjudgedCount: number }) => ({ betCount: x.betCount, totalStake: x.totalStake, totalReturn: x.totalReturn, recoveryRate: x.recoveryRate, unjudgedCount: x.unjudgedCount });
    expect(o.report.proposedBet.overall).toEqual(pick(server.proposedBet.overall));
    for (const type of PROPOSED_BET_TYPES) {
      expect(o.report.proposedBet.byType[type], type).toEqual(pick(server.proposedBet[type]));
    }
    // 前提(空振り防止): 複勝・単勝・ワイドは点数があり、回収額が 0 でないものがある。未知の券種も 1 点
    expect(o.report.proposedBet.byType.place.betCount).toBe(1);
    expect(o.report.proposedBet.byType.win.betCount).toBe(1);
    expect(o.report.proposedBet.byType.wide.totalReturn).toBe(1350);
    expect(o.report.proposedBet.unknownBetType).toEqual({ count: 1, totalStake: 100, betTypes: ["mystery"] });
  });

  it("venue と refresh が DO まで届く(refresh=1 は true、それ以外は false)", async () => {
    const s = await connect();
    await fetchVerify(s.fetch, "nar", true);
    await fetchVerify(s.fetch, "central", false);
    expect(s.calls).toEqual([{ venue: "nar", refresh: true }, { venue: "central", refresh: false }]);
  });

  it("preparing・throttled も読める", async () => {
    const s = await connect();
    s.response = { status: "preparing", remaining: 40, blocked: "r2-fence", resumeAt: "2026-11-01T00:05:00.000Z" };
    expect(await fetchVerify(s.fetch, "all", false)).toEqual({ ok: true, outcome: { kind: "preparing", remaining: 40, blocked: "r2-fence", resumeAt: "2026-11-01T00:05:00.000Z" } });
    s.response = { status: "throttled", nextAt: "2026-10-10T15:00:00.000Z" };
    expect(await fetchVerify(s.fetch, "all", false)).toEqual({ ok: true, outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z" } });
  });

  it("DO の失敗(503)は server-error。文面は持ち込まない", async () => {
    const s = await connect();
    s.fails = true;
    const result = await fetchVerify(s.fetch, "all", false);
    expect(result).toEqual({ ok: false, error: { kind: "server-error" } });
    if (result.ok) throw new Error("失敗のはず");
    expect(verifyFetchFailureMessage(result.error)).not.toContain("秘密");
  });
});

describe("parseVerifyResponse(応答を信用しない)", () => {
  const ready = (): Record<string, unknown> => ({ ok: true, ...(JSON.parse(JSON.stringify({ status: "ready", venue: "all", report: realReport(), computedAt: "x", stale: false, staleReason: null, nextRecomputeAt: null, diag: { startTimeGaps: { lost: 0, affecting: 0 } } })) as object) });

  it("前提: 本物の集計から作った ready は読める", () => {
    expect(parseVerifyResponse(ready())?.kind).toBe("ready");
  });

  const mutations: ReadonlyArray<readonly [string, (b: Record<string, any>) => void]> = [
    ["ok が true でない", (b) => { b["ok"] = false; }],
    ["status が未知", (b) => { b["status"] = "later"; }],
    ["venue が未知", (b) => { b["venue"] = "both"; }],
    ["stale が真偽でない", (b) => { b["stale"] = "no"; }],
    ["staleReason が未知", (b) => { b["staleReason"] = "weather"; }],
    ["診断の欠落件数が無い", (b) => { delete b["diag"].startTimeGaps; }],
    ["bet の件数が負", (b) => { b["report"].bet.betCount = -1; }],
    ["bet の件数が小数", (b) => { b["report"].bet.betCount = 1.5; }],
    ["回収率が文字列", (b) => { b["report"].bet.recoveryRate = "50%"; }],
    ["投資額が欠ける", (b) => { delete b["report"].bet.totalStake; }],
    ["券種の内訳が 1 つ欠ける(三連単)", (b) => { delete b["report"].proposedBet.trifecta; }],
    ["券種の内訳の点数が文字列", (b) => { b["report"].proposedBet.wide.betCount = "3"; }],
    ["母集団の項目が欠ける", (b) => { delete b["report"].proposedBet.population.noRecord; }],
    ["未知の券種の券種コードが文字列の配列でない", (b) => { b["report"].proposedBet.unknownBetType.betTypes = [1]; }],
    ["除外カウンタが欠ける", (b) => { delete b["report"].excludedLookaheadUnknownCount; }],
    ["report が無い", (b) => { delete b["report"]; }],
  ];
  it.each(mutations)("%s は null(一部だけを採用しない)", (_name, mutate) => {
    const body = ready();
    mutate(body);
    expect(parseVerifyResponse(body)).toBeNull();
  });

  it("preparing: remaining が不正・blocked が未知なら null。throttled: nextAt が無ければ null", () => {
    expect(parseVerifyResponse({ ok: true, status: "preparing", remaining: -1, blocked: null, resumeAt: null })).toBeNull();
    expect(parseVerifyResponse({ ok: true, status: "preparing", remaining: 1, blocked: "x", resumeAt: null })).toBeNull();
    expect(parseVerifyResponse({ ok: true, status: "throttled" })).toBeNull();
    expect(parseVerifyResponse(null)).toBeNull();
    expect(parseVerifyResponse("ready")).toBeNull();
  });

  it("余計なキー(補正傾向・キャリブレーション・診断の細目)は無視して読める", () => {
    const body = ready();
    body["extra"] = 1;
    expect(parseVerifyResponse(body)?.kind).toBe("ready");
  });
});

describe("fetchVerify の失敗の分類", () => {
  const fetchWith = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });
  it("403・400・200 で形が違う・例外・json が壊れている", async () => {
    expect(await fetchVerify(fetchWith(403, { ok: false, error: { type: "origin-mismatch" } }), "all", false)).toEqual({ ok: false, error: { kind: "origin-mismatch" } });
    expect(await fetchVerify(fetchWith(403, "x"), "all", false)).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await fetchVerify(fetchWith(400, {}), "all", false)).toEqual({ ok: false, error: { kind: "bad-request" } });
    expect(await fetchVerify(fetchWith(200, { ok: true, status: "ready" }), "all", false)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    expect(await fetchVerify(async () => { throw new Error("通信の詳細"); }, "all", false)).toEqual({ ok: false, error: { kind: "network" } });
    expect(await fetchVerify(async () => ({ status: 200, json: async () => { throw new Error("壊れた"); } }), "all", false)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });
  it("固定の文言はサーバの文面を含まない", () => {
    for (const failure of [{ kind: "forbidden" }, { kind: "origin-mismatch" }, { kind: "network" }, { kind: "server-error" }, { kind: "bad-request" }, { kind: "not-found" }, { kind: "unexpected", httpStatus: 418 }] as const) {
      expect(verifyFetchFailureMessage(failure).length).toBeGreaterThan(10);
    }
    expect(verifyFetchFailureMessage({ kind: "unexpected", httpStatus: 418 })).toContain("418");
  });
});
