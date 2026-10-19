import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchVerify, MARKS, parseVerifyResponse, PROPOSED_BET_TYPES, verifyFetchFailureMessage } from "../client/api-verify";
import { handle, type Env } from "../src/handler";
import { PREDICTION_MARKS } from "../../packages/core/src/analyzer/parse-response.js";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { VerifyCore, type VerifyKv, type VerifyResponse, type VerifyStorePort } from "../src/verify-core";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyReadRows } from "../src/verify-read";
import { computePromptVersionSummaries } from "../src/verify-versions";
import { CLOSE_COMPARISON_DESCRIPTION } from "../src/verify-close";
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
    horses: [
      { analysisId: 1, umaban: 1, prior: 0.5, adjusted_prob: 0.5, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null },
      // 補正方向(上げ・下げ)・印(〇・印なし)・複勝圏外を作る馬(補正傾向・キャリブレーション・印別が空振りにならないように)
      { analysisId: 1, umaban: 2, prior: 0.3, adjusted_prob: 0.36, place_odds_min: 3, ev: 0.9, is_positive: 0, contributions_json: null, mark: "〇", reason: null, highlights_json: null, concerns_json: null },
      { analysisId: 1, umaban: 3, prior: 0.4, adjusted_prob: 0.31, place_odds_min: 4, ev: 0.8, is_positive: 0, contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null },
    ],
    allocationMeta: [{ analysisId: 1, route: "mixed", skipReasonCode: null }],
    bets: [
      { analysisId: 1, betType: "place", comboKey: "01", stake: 200 },
      { analysisId: 1, betType: "win", comboKey: "01", stake: 100 },
      { analysisId: 1, betType: "wide", comboKey: "0102", stake: 300 },
      { analysisId: 1, betType: "mystery", comboKey: "01", stake: 100 },
      // 取消(4番。下の results で scratched=1)を含む3連複: 返還として数える(Issue #72。契約の refundedCount・refundedStake が 0 のままの空振りを避ける)
      { analysisId: 1, betType: "trio", comboKey: "010204", stake: 400 },
    ],
    results: [
      { raceId: "202606030811", umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 380 },
      { raceId: "202606030811", umaban: 2, finishPosition: 2, placePayout: 120, winPayout: null },
      { raceId: "202606030811", umaban: 3, finishPosition: 5, placePayout: null, winPayout: null },
      { raceId: "202606030811", umaban: 4, finishPosition: null, placePayout: null, winPayout: null, scratched: 1 },
    ],
    comboPayouts: [{ raceId: "202606030811", betType: "wide", comboKey: "0102", payout: 450 }],
    comboImports: [{ raceId: "202606030811", betType: "wide" }],
  };
  return computeVerifyReport(buildVerifySource(rows), PRODUCTION_VERIFY_CONFIG, "all");
}

/** 版が 3 つ(v1・v2〈追加指示あり〉・版不明)の本物の版別比較(core の `computeVerifyReportByPromptVersion` の射影)。 */
function realVersions() {
  const analysis = (id: number, raceId: string, promptVersion: string | null, additionalInstruction: string | null): VerifyAnalysisRow => ({
    id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion, additionalInstruction, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
  });
  const analyses = [analysis(1, "202606030801", "v1", null), analysis(2, "202606030802", "v2", "逃げ馬を重視"), analysis(3, "202606030803", "v2", null), analysis(4, "202606030804", null, null)];
  const horses = analyses.flatMap((a) => [
    { analysisId: a.id, umaban: 1, prior: 0.5, adjusted_prob: 0.55, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null },
    { analysisId: a.id, umaban: 2, prior: 0.2, adjusted_prob: 0.15, place_odds_min: 5, ev: 0.8, is_positive: 0, contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null },
  ]);
  const results = analyses.flatMap((a) => [
    { raceId: a.raceId, umaban: 1, finishPosition: a.id % 2 === 0 ? 1 : 5, placePayout: a.id % 2 === 0 ? 300 : null, winPayout: null },
    { raceId: a.raceId, umaban: 2, finishPosition: 2, placePayout: 150, winPayout: null },
  ]);
  return computePromptVersionSummaries(buildVerifySource({ analyses, horses, allocationMeta: [], bets: [], results, comboPayouts: [], comboImports: [] }));
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
    response: { status: "ready", venue: "all", report: realReport(), promptVersions: realVersions(), closeComparison: null, computedAt: "2026-10-10T03:00:00.000Z", stale: true, staleReason: "min-interval", nextRecomputeAt: "2026-10-10T03:05:00.000Z", diag: { rowsRead: 5, counts: {}, readMs: 1, computeMs: 1, promptVersionsMs: 1, startTimeGaps: { lost: 3, affecting: 2 } } },
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
        getViewerReport: async () => {
          throw new Error("管理者の要求では呼ばれない想定");
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
    const pick = (x: { betCount: number; totalStake: number; totalReturn: number; recoveryRate: number | null; unjudgedCount: number; refundedCount: number; refundedStake: number; flatStake: number; flatReturn: number; flatRecoveryRate: number | null }) => ({ flatStake: x.flatStake, flatReturn: x.flatReturn, flatRecoveryRate: x.flatRecoveryRate, refundedCount: x.refundedCount, refundedStake: x.refundedStake, betCount: x.betCount, totalStake: x.totalStake, totalReturn: x.totalReturn, recoveryRate: x.recoveryRate, unjudgedCount: x.unjudgedCount });
    expect(o.report.proposedBet.overall).toEqual(pick(server.proposedBet.overall));
    for (const type of PROPOSED_BET_TYPES) {
      expect(o.report.proposedBet.byType[type], type).toEqual(pick(server.proposedBet[type]));
    }
    // 前提(空振り防止): 複勝・単勝・ワイドは点数があり、回収額が 0 でないものがある。未知の券種も 1 点
    expect(o.report.proposedBet.byType.place.betCount).toBe(1);
    expect(o.report.proposedBet.byType.win.betCount).toBe(1);
    expect(o.report.proposedBet.byType.wide.totalReturn).toBe(1350);
    // Issue #72: 返還(取消の4番を含む3連複 400 円)が、サーバの値のままクライアントの結果に読める
    expect(o.report.proposedBet.byType.trio).toMatchObject({ betCount: 1, totalStake: 400, totalReturn: 400, refundedCount: 1, refundedStake: 400 });
    expect(o.report.proposedBet.overall).toMatchObject({ refundedCount: 1, refundedStake: 400 });
    // Issue #16: 同じ買い目に一律 100 円(サーバの値のまま読める。賭け金が 100 円でない買い目を含むので、配分ベースとは値が違う)
    const overall = o.report.proposedBet.overall;
    expect(overall.betCount).toBeGreaterThan(1); // 前提(空振り防止)
    expect(overall.flatStake).toBe(overall.betCount * 100);
    expect(overall.flatStake).not.toBe(overall.totalStake);
    expect(overall.flatReturn).toBeGreaterThan(0);
    expect(overall.flatRecoveryRate).toBe(overall.flatReturn / overall.flatStake);
    expect(o.report.proposedBet.byType.trio).toMatchObject({ flatStake: 100, flatReturn: 100 }); // 返還は一律でも 100 円
    expect(o.report.proposedBet.unknownBetType).toEqual({ count: 1, totalStake: 100, betTypes: ["mystery"] });
  });

  it("補正方向×結果・キャリブレーション・印別的中率(core の trend・calibration)をそのまま読める。群の数と順序・帯の数は core のまま", async () => {
    const s = await connect();
    const result = await fetchVerify(s.fetch, "all", false);
    if (!result.ok || result.outcome.kind !== "ready") throw new Error("ready のはず");
    const server = (s.response as Extract<VerifyResponse, { status: "ready" }>).report;
    const r = result.outcome.report;
    // 前提(空振り防止): 3 群すべてに 1 頭ずつ入り、帯・印にも件数がある
    expect(server.trend.directionGroups.map((g) => [g.direction, g.count])).toEqual([["raised", 1], ["lowered", 1], ["unchanged", 1]]);
    expect(server.calibration).toHaveLength(20);
    expect(server.calibration.filter((b) => b.predictedCount > 0).length).toBeGreaterThanOrEqual(3);
    expect(server.trend.markStats.filter((m) => m.count > 0).map((m) => m.mark)).toEqual(["◎", "〇", null]);
    expect(server.trend.directionGroups.every((g) => g.averageAdjustment !== null && g.actualPlaceRate !== null)).toBe(true);
    // 値は core のそのもの
    expect(r.trend.directionGroups).toEqual(server.trend.directionGroups);
    expect(r.calibration).toEqual(server.calibration);
    // Issue #254: 帯の平均予測値(meanPredictedProb)と、補正前(prior)の対応表もそのまま読める。補正前の対応表は補正後とは別の振り分けである(取り違えを弾く)
    expect(server.calibration.filter((b) => b.predictedCount > 0).every((b) => typeof b.meanPredictedProb === "number")).toBe(true);
    expect(server.calibration.filter((b) => b.predictedCount === 0).every((b) => b.meanPredictedProb === null)).toBe(true);
    expect(server.priorCalibration).toHaveLength(20);
    expect(server.priorCalibration).not.toEqual(server.calibration);
    expect(server.priorCalibration.reduce((n, b) => n + b.predictedCount, 0)).toBe(server.calibration.reduce((n, b) => n + b.predictedCount, 0));
    expect(r.priorCalibration).toEqual(server.priorCalibration);
    expect(r.trend.calibrationBias).toEqual(server.trend.calibrationBias.map((b) => ({ overconfidenceGap: b.overconfidenceGap })));
    expect(r.trend.markStats).toEqual(server.trend.markStats);
    expect(r.trend.markStats).toHaveLength(7);
    // クライアントの印の一覧は core の PREDICTION_MARKS と同じ
    expect([...MARKS]).toEqual([...PREDICTION_MARKS]);
  });

  it("プロンプト版別の比較(Issue #220): サーバの射影をそのまま読める。版の並び・追加指示・帯・過信バイアスの添字", async () => {
    const s = await connect();
    const result = await fetchVerify(s.fetch, "all", false);
    if (!result.ok || result.outcome.kind !== "ready") throw new Error("ready のはず");
    const server = (s.response as Extract<VerifyResponse, { status: "ready" }>).promptVersions;
    // 前提(空振り防止): 3 つの版、追加指示が複数の版、帯に件数がある
    expect(server.map((v) => v.promptVersion)).toEqual(["v1", "v2", null]);
    expect(server[1]!.additionalInstructions).toEqual(["逃げ馬を重視", null]);
    expect(server.every((v) => v.calibration.length === 20 && v.overconfidenceGaps.length === 20 && v.calibration.some((b) => b.predictedCount > 0))).toBe(true);
    expect(result.outcome.promptVersions).toEqual(server);
    // Issue #254: 版別の帯にも平均予測値がある(版別カードの判定に使う)
    expect(server.every((v) => v.calibration.some((b) => b.meanPredictedProb !== null))).toBe(true);
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
    s.response = { status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" };
    expect(await fetchVerify(s.fetch, "all", false)).toEqual({ ok: true, outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" } });
    // Issue #254: 最短間隔(5 分)の柵も区別して読める
    s.response = { status: "throttled", nextAt: "2026-10-10T03:05:00.000Z", reason: "min-interval" };
    expect(await fetchVerify(s.fetch, "all", false)).toEqual({ ok: true, outcome: { kind: "throttled", nextAt: "2026-10-10T03:05:00.000Z", reason: "min-interval" } });
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

describe("Issue #263: 閲覧者の応答の契約(本物の VerifyCore.getViewerReport → 本物の handle() → クライアントの結果)", () => {
  /** 本物の VerifyCore(偽の D1・R2・時計)。管理者の要求で集計を 1 回作っておくか(`computed`)、まだ作らない。 */
  async function viewerSetup(computed: boolean) {
    const data = new Map<string, unknown>();
    const kv: VerifyKv = { get: <T,>(key: string) => data.get(key) as T | undefined, put: (key, value) => void data.set(key, JSON.parse(JSON.stringify(value))) };
    const analysis = (id: number, raceId: string, promptVersion: string, additionalInstruction: string | null): VerifyAnalysisRow => ({
      id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion, additionalInstruction, kaisaiDate: "20260705",
      model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
    });
    const analyses = [analysis(1, "202606030811", "v1", null), analysis(2, "202606030812", "v2", "SECRET-逃げ馬を重視")];
    const rows: VerifyReadRows = {
      analyses,
      horses: analyses.map((a) => ({ analysisId: a.id, umaban: 1, prior: 0.5, adjusted_prob: 0.5, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null })),
      allocationMeta: [], bets: [],
      results: analyses.map((a) => ({ raceId: a.raceId, umaban: 1, finishPosition: 1, placePayout: 300, winPayout: null })),
      comboPayouts: [], comboImports: [],
    };
    const storeCalls: string[] = [];
    const store: VerifyStorePort = {
      readWatermark: async () => (storeCalls.push("watermark"), { analyses: 2, results: 2, comboPayouts: null, comboImports: null }),
      listPending: async () => (storeCalls.push("listPending"), { rows: [], total: 0 }),
      readUsage: async () => ({ classA: 0, classB: 0 }),
      resolveStartTimes: async () => ({ resolved: [], missing: [], failed: [], gets: 0 }),
      commitStartTimes: async () => 0,
      readAll: async () => (storeCalls.push("readAll"), { rows, rowsRead: 4321, counts: {} as never }),
    };
    const core = new VerifyCore({ kv, now: () => Date.parse("2026-10-10T03:00:00.000Z"), setAlarm: () => {}, getAlarm: async () => null, store });
    if (computed) await core.getReport("all");
    storeCalls.length = 0;
    const key = await makeKey("k1");
    const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
    const token = await signToken(key, { email: "friend@example.com" }); // 管理者(GOOD_ENV の ACCESS_ALLOWED_EMAIL)ではないアカウント = 閲覧者
    const adminCalls: string[] = [];
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
            adminCalls.push(`${venue} ${String(options?.refresh)}`);
            return core.getReport(venue, options);
          },
          getViewerReport: async (venue) => core.getViewerReport(venue),
        }),
      },
    };
    const fetchLike: FetchLike = async (url, init) => {
      const headers = new Headers(init.headers);
      headers.set("Cf-Access-Jwt-Assertion", token);
      headers.set("Sec-Fetch-Site", "same-origin");
      const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers }), env, {}, deps);
      return { status: response.status, json: () => response.json() };
    };
    return { fetch: fetchLike, adminCalls, storeCalls };
  }

  it("集計がある: 閲覧者の要求(refresh を付けても)は管理者用の getReport に届かず、D1 にも触れない。ready として読め、stale でなく、追加指示の全文はクライアントの結果にも入らない", async () => {
    const s = await viewerSetup(true);
    const result = await fetchVerify(s.fetch, "central", true);
    if (!result.ok || result.outcome.kind !== "ready") throw new Error("ready のはず");
    expect(s.adminCalls).toEqual([]);
    expect(s.storeCalls).toEqual([]);
    expect(result.outcome).toMatchObject({ venue: "central", computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, startTimeGaps: { lost: 0, affecting: 0 } });
    expect(result.outcome.report.includedAnalysisCount).toBe(2); // 前提(空振り防止): 集計に入っている
    expect(result.outcome.promptVersions.map((v) => v.additionalInstructions)).toEqual([[null], ["(非公開)"]]);
    expect(JSON.stringify(result.outcome)).not.toContain("SECRET");
    expect(JSON.stringify(result.outcome)).not.toContain("rowsRead");
  });

  it("集計がまだ無い: not-computed として読める(集計は起こさない)", async () => {
    const s = await viewerSetup(false);
    expect(await fetchVerify(s.fetch, "all", true)).toEqual({ ok: true, outcome: { kind: "not-computed" } });
    expect(s.adminCalls).toEqual([]);
    expect(s.storeCalls).toEqual([]);
  });
});

describe("parseVerifyResponse(応答を信用しない)", () => {
  const ready = (): Record<string, unknown> => ({ ok: true, ...(JSON.parse(JSON.stringify({ status: "ready", venue: "all", report: realReport(), promptVersions: realVersions(), computedAt: "x", stale: false, staleReason: null, nextRecomputeAt: null, diag: { startTimeGaps: { lost: 0, affecting: 0 } } })) as object) });

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
    ["返還の点数が欠ける(合算。Issue #72)", (b) => { delete b["report"].proposedBet.overall.refundedCount; }],
    ["返還の賭け金が欠ける(券種別)", (b) => { delete b["report"].proposedBet.wide.refundedStake; }],
    ["返還の点数が負", (b) => { b["report"].proposedBet.place.refundedCount = -1; }],
    ["返還の点数が小数", (b) => { b["report"].proposedBet.trio.refundedCount = 0.5; }],
    ["返還の賭け金が文字列", (b) => { b["report"].proposedBet.overall.refundedStake = "400"; }],
    ["一律の賭け金が欠ける(合算。Issue #16)", (b) => { delete b["report"].proposedBet.overall.flatStake; }],
    ["一律の払戻が欠ける(券種別)", (b) => { delete b["report"].proposedBet.wide.flatReturn; }],
    ["一律の回収率が欠ける(券種別。null は許すが、キー自体が無いのは不可)", (b) => { delete b["report"].proposedBet.place.flatRecoveryRate; }],
    ["一律の賭け金が負", (b) => { b["report"].proposedBet.place.flatStake = -100; }],
    ["一律の賭け金が文字列", (b) => { b["report"].proposedBet.overall.flatStake = "100"; }],
    ["一律の払戻が文字列", (b) => { b["report"].proposedBet.trio.flatReturn = "100"; }],
    ["一律の回収率が文字列", (b) => { b["report"].proposedBet.overall.flatRecoveryRate = "50%"; }],
    ["未知の券種の券種コードが文字列の配列でない", (b) => { b["report"].proposedBet.unknownBetType.betTypes = [1]; }],
    ["除外カウンタが欠ける", (b) => { delete b["report"].excludedLookaheadUnknownCount; }],
    ["report が無い", (b) => { delete b["report"]; }],
    ["trend が無い", (b) => { delete b["report"].trend; }],
    ["補正方向の群が 2 つしかない", (b) => { b["report"].trend.directionGroups.pop(); }],
    ["補正方向の群が重複(上げが 2 つ)", (b) => { b["report"].trend.directionGroups[1].direction = "raised"; }],
    ["補正方向が未知", (b) => { b["report"].trend.directionGroups[0].direction = "up"; }],
    ["補正方向の件数が負", (b) => { b["report"].trend.directionGroups[0].count = -1; }],
    ["補正方向の複勝率が 1 を超える", (b) => { b["report"].trend.directionGroups[0].actualPlaceRate = 1.5; }],
    ["平均補正幅が文字列", (b) => { b["report"].trend.directionGroups[0].averageAdjustment = "+1pt"; }],
    ["平均補正幅が無限大", (b) => { b["report"].trend.directionGroups[0].averageAdjustment = null; b["report"].trend.directionGroups[1].averageAdjustment = 1e999; }],
    ["印別が 6 群しかない", (b) => { b["report"].trend.markStats.pop(); }],
    ["印が未知", (b) => { b["report"].trend.markStats[0].mark = "×"; }],
    ["印が重複(◎が 2 つ)", (b) => { b["report"].trend.markStats[1].mark = "◎"; }],
    ["印なしが無い", (b) => { b["report"].trend.markStats[6].mark = "注"; }],
    ["印別の勝率が負", (b) => { b["report"].trend.markStats[0].winRate = -0.1; }],
    ["印別の件数が小数", (b) => { b["report"].trend.markStats[0].count = 0.5; }],
    ["キャリブレーションが配列でない", (b) => { b["report"].calibration = {}; }],
    ["帯の予測件数が負", (b) => { b["report"].calibration[0].predictedCount = -1; }],
    ["帯の複勝件数が予測件数より多い", (b) => { b["report"].calibration[0].predictedCount = 0; b["report"].calibration[0].placedCount = 1; }],
    ["帯の下限が欠ける", (b) => { delete b["report"].calibration[0].lowerBound; }],
    ["帯の上限が下限以下", (b) => { b["report"].calibration[3].upperBound = b["report"].calibration[3].lowerBound; }],
    ["帯の実複勝率が負", (b) => { b["report"].calibration[0].actualPlaceRate = -0.2; }],
    ["帯の平均予測値が欠ける(Issue #254)", (b) => { delete b["report"].calibration[7].meanPredictedProb; }],
    ["帯の平均予測値が 1 を超える", (b) => { b["report"].calibration[7].meanPredictedProb = 1.2; }],
    ["帯の平均予測値が負", (b) => { b["report"].calibration[7].meanPredictedProb = -0.1; }],
    ["帯の平均予測値が文字列", (b) => { b["report"].calibration[7].meanPredictedProb = "0.3"; }],
    ["予測件数があるのに平均予測値が null", (b) => { const bin = b["report"].calibration.find((x: { predictedCount: number }) => x.predictedCount > 0); bin.meanPredictedProb = null; }],
    ["予測件数が 0 なのに平均予測値がある", (b) => { const bin = b["report"].calibration.find((x: { predictedCount: number }) => x.predictedCount === 0); bin.meanPredictedProb = 0.1; }],
    ["補正前の対応表が無い", (b) => { delete b["report"].priorCalibration; }],
    ["補正前の対応表が配列でない", (b) => { b["report"].priorCalibration = {}; }],
    ["補正前の対応表の帯数が補正後と違う", (b) => { b["report"].priorCalibration.pop(); }],
    ["補正前の帯の予測件数が負", (b) => { b["report"].priorCalibration[0].predictedCount = -1; }],
    ["補正前の帯の平均予測値が欠ける", (b) => { delete b["report"].priorCalibration[0].meanPredictedProb; }],
    ["版の帯の平均予測値が文字列", (b) => { b["promptVersions"][0].calibration[3].meanPredictedProb = "x"; }],
    ["過信バイアスが配列でない", (b) => { b["report"].trend.calibrationBias = null; }],
    ["過信バイアスが文字列", (b) => { b["report"].trend.calibrationBias[0].overconfidenceGap = "x"; }],
    ["promptVersions が無い", (b) => { delete b["promptVersions"]; }],
    ["promptVersions が配列でない", (b) => { b["promptVersions"] = {}; }],
    ["版が数値", (b) => { b["promptVersions"][0].promptVersion = 1; }],
    ["版が重複", (b) => { b["promptVersions"][1].promptVersion = "v1"; }],
    ["追加指示が配列でない", (b) => { b["promptVersions"][0].additionalInstructions = "x"; }],
    ["追加指示に数値が混ざる", (b) => { b["promptVersions"][1].additionalInstructions = ["a", 1]; }],
    ["版の集計件数が負", (b) => { b["promptVersions"][0].includedAnalysisCount = -1; }],
    ["版の回収率が文字列", (b) => { b["promptVersions"][0].bet.recoveryRate = "96%"; }],
    ["版の賭け数が欠ける", (b) => { delete b["promptVersions"][0].bet.betCount; }],
    ["版の帯が不正(予測件数が負)", (b) => { b["promptVersions"][0].calibration[3].predictedCount = -1; }],
    ["版の過信バイアスの長さが帯と違う", (b) => { b["promptVersions"][0].overconfidenceGaps.pop(); }],
    ["版の過信バイアスが文字列", (b) => { b["promptVersions"][0].overconfidenceGaps[0] = "x"; }],
    ["版の補正前の対応表が無い(Issue #271)", (b) => { delete b["promptVersions"][0].priorCalibration; }],
    ["版の補正前の対応表が配列でない", (b) => { b["promptVersions"][0].priorCalibration = {}; }],
    ["版の補正前の対応表の帯数が補正後と違う", (b) => { b["promptVersions"][0].priorCalibration.pop(); }],
    ["版の補正前の帯が不正(予測件数が負)", (b) => { b["promptVersions"][0].priorCalibration[3].predictedCount = -1; }],
    ["版の補正前の帯の平均予測値が欠ける", (b) => { delete b["promptVersions"][0].priorCalibration[3].meanPredictedProb; }],
    ["版の quality が無い", (b) => { delete b["promptVersions"][0].quality; }],
    ["版の quality がオブジェクトでない", (b) => { b["promptVersions"][0].quality = 0.17; }],
    ["版の評価頭数が負", (b) => { b["promptVersions"][0].quality.evaluatedCount = -1; }],
    ["版の評価頭数が小数", (b) => { b["promptVersions"][0].quality.evaluatedCount = 1.5; }],
    ["版の補正前 Brier が文字列", (b) => { b["promptVersions"][0].quality.priorBrier = "0.17"; }],
    ["版の補正後 Brier が欠ける", (b) => { delete b["promptVersions"][0].quality.adjustedBrier; }],
    ["版の補正後 Brier が 1 を超える", (b) => { b["promptVersions"][0].quality.adjustedBrier = 1.2; }],
    ["版の補正前 Brier が負", (b) => { b["promptVersions"][0].quality.priorBrier = -0.1; }],
    ["版の評価頭数が 0 なのに Brier がある", (b) => { b["promptVersions"][0].quality = { evaluatedCount: 0, priorBrier: 0.1, adjustedBrier: null }; }],
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
    // Issue #254: 柵の種類(reason)が無い・未知なら null
    expect(parseVerifyResponse({ ok: true, status: "throttled", nextAt: "2026-10-10T15:00:00.000Z" })).toBeNull();
    expect(parseVerifyResponse({ ok: true, status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "x" })).toBeNull();
    expect(parseVerifyResponse(null)).toBeNull();
    expect(parseVerifyResponse("ready")).toBeNull();
  });

  it("Issue #263: not-computed(閲覧者に、集計がまだ無い)は読める。ok が true でなければ null", () => {
    expect(parseVerifyResponse({ ok: true, status: "not-computed" })).toEqual({ kind: "not-computed" });
    expect(parseVerifyResponse({ ok: false, status: "not-computed" })).toBeNull();
  });

  it("Issue #263: 閲覧者の ready(診断は発走時刻の欠落だけ)も読める。欠落(startTimeGaps)が無ければ null", () => {
    const body = ready();
    body["diag"] = { startTimeGaps: { lost: 1, affecting: 0 } };
    expect(parseVerifyResponse(body)).toMatchObject({ kind: "ready", startTimeGaps: { lost: 1, affecting: 0 } });
    body["diag"] = {};
    expect(parseVerifyResponse(body)).toBeNull();
  });

  it("版別が 0 件(分析が無い)でも読める", () => {
    const body = ready();
    body["promptVersions"] = [];
    expect(parseVerifyResponse(body)).toMatchObject({ kind: "ready", promptVersions: [] });
  });

  it("余計なキー(診断の細目など)は無視して読める", () => {
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
  it("Issue #263: 閲覧者(更新ボタンが無い)向けの文言は『更新』を案内しない(再読み込みを案内する)。管理者向け(既定)は従来どおり", () => {
    const failures = [{ kind: "forbidden" }, { kind: "origin-mismatch" }, { kind: "network" }, { kind: "server-error" }, { kind: "bad-request" }, { kind: "not-found" }, { kind: "unexpected", httpStatus: 418 }] as const;
    const adminMessages = failures.map((f) => verifyFetchFailureMessage(f));
    expect(adminMessages.filter((m) => m.includes("「更新」"))).toHaveLength(5); // 前提(空振り防止): 管理者向けには『更新』の案内がある(network・server-error・bad-request・not-found・unexpected の 5 つ。forbidden・origin-mismatch は再読み込みのみ)
    for (const failure of failures) {
      const viewerMessage = verifyFetchFailureMessage(failure, false);
      expect(viewerMessage, failure.kind).not.toContain("「更新」");
      expect(viewerMessage.length, failure.kind).toBeGreaterThan(10);
    }
    expect(verifyFetchFailureMessage({ kind: "server-error" }, false)).toContain("再読み込み");
  });
});

describe("Issue #352: closeComparison(締切直前の再計算との比較)の読み取り", () => {
  const ready = (): Record<string, any> => ({ ok: true, ...(JSON.parse(JSON.stringify({ status: "ready", venue: "all", report: realReport(), promptVersions: realVersions(), computedAt: "x", stale: false, staleReason: null, nextRecomputeAt: null, diag: { startTimeGaps: { lost: 0, affecting: 0 } } })) as Record<string, unknown>) });
  // Issue #379: 説明文(description)・基準ごとの見出しの語(basisLabel。null か文字列)をサーバが渡す。同じ回に、基準の違う行が並びうる(3 行目)。
  const valid = () => ({
    description: "説明文(サーバが組み立てる)",
    rounds: [
      { round: 1, basisLabel: null, leadMinutes: 5, okCount: 2, targetCount: 3, base: { betCount: 4, totalStake: 400, totalReturn: 300, recoveryRate: 0.75 }, recalc: { betCount: 3, totalStake: 300, totalReturn: 450, recoveryRate: 1.5 } },
      { round: 2, basisLabel: null, leadMinutes: 2, okCount: 0, targetCount: 1, base: { betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null }, recalc: { betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null } },
      { round: 1, basisLabel: "組合せは分析時のオッズ", leadMinutes: 5, okCount: 1, targetCount: 1, base: { betCount: 2, totalStake: 200, totalReturn: 100, recoveryRate: 0.5 }, recalc: { betCount: 1, totalStake: 100, totalReturn: 300, recoveryRate: 3 } },
    ],
  });

  it("項目が無い(旧い集計・旧い Worker)・null は、比較なし(null)として読める。ほかの節は読める", () => {
    const absent = parseVerifyResponse(ready());
    expect(absent).toMatchObject({ kind: "ready", closeComparison: null });
    const body = ready();
    body["closeComparison"] = null;
    expect(parseVerifyResponse(body)).toMatchObject({ kind: "ready", closeComparison: null });
  });

  it("正しい値は、そのまま読める(回・リード・件数・両側の 4 値)", () => {
    const body = ready();
    body["closeComparison"] = valid();
    const outcome = parseVerifyResponse(body);
    expect(outcome?.kind === "ready" ? outcome.closeComparison : "ready でない").toEqual(valid());
  });

  const bad: ReadonlyArray<readonly [string, (c: any) => void]> = [
    ["rounds が配列でない", (c) => { c.rounds = {}; }],
    ["description が無い", (c) => { delete c.description; }],
    ["description が文字列でない", (c) => { c.description = 1; }],
    ["description が長すぎる(1000 字超)", (c) => { c.description = "あ".repeat(1001); }],
    ["basisLabel が無い", (c) => { delete c.rounds[0].basisLabel; }],
    ["basisLabel が文字列でも null でもない", (c) => { c.rounds[0].basisLabel = 1; }],
    ["同じ回・同じ見出しの語の行が重複する", (c) => { c.rounds[2].basisLabel = null; }],
    ["rounds が空", (c) => { c.rounds = []; }],
    ["回の番号が 0", (c) => { c.rounds[0].round = 0; }],
    ["回の番号が小数", (c) => { c.rounds[0].round = 1.5; }],
    ["回が重複する", (c) => { c.rounds[1].round = 1; }],
    ["leadMinutes が 0", (c) => { c.rounds[0].leadMinutes = 0; }],
    ["leadMinutes が負", (c) => { c.rounds[0].leadMinutes = -2; }],
    ["leadMinutes が文字列", (c) => { c.rounds[0].leadMinutes = "5"; }],
    ["ok の件数が対象より多い", (c) => { c.rounds[0].okCount = 4; }],
    ["件数が負", (c) => { c.rounds[0].targetCount = -1; }],
    ["件数が小数", (c) => { c.rounds[0].okCount = 1.5; }],
    ["分析時の側が欠ける", (c) => { delete c.rounds[0].base; }],
    ["再計算の投資額が負", (c) => { c.rounds[0].recalc.totalStake = -1; }],
    ["再計算の回収率が文字列", (c) => { c.rounds[0].recalc.recoveryRate = "150%"; }],
    ["賭け数が小数", (c) => { c.rounds[0].base.betCount = 0.5; }],
  ];
  it.each(bad)("★壊れた closeComparison(%s)は、この節だけ null に落とす。ほかの節(集計・版別)は読める", (_name, mutate) => {
    const body = ready();
    const close = valid();
    mutate(close);
    body["closeComparison"] = close;
    const outcome = parseVerifyResponse(body);
    expect(outcome).not.toBeNull(); // 応答全体は捨てない
    expect(outcome).toMatchObject({ kind: "ready", closeComparison: null });
    expect(outcome?.kind === "ready" ? outcome.report.includedAnalysisCount : -1).toBeGreaterThan(0);
    expect(outcome?.kind === "ready" ? outcome.promptVersions.length : -1).toBeGreaterThan(0);
  });
});

describe("Issue #352: 契約(本物の VerifyCore → 本物の handle() → クライアント)で比較が読める", () => {
  it("管理者・閲覧者のどちらの要求でも、サーバが作った比較(回・リード・件数・両側の回収率)をクライアントが読める。表が読めなければ null", async () => {
    for (const close of [true, false]) {
      const s = await closeSetup(close);
      const result = await fetchVerify(s.fetch, "central", false);
      if (!result.ok || result.outcome.kind !== "ready") throw new Error("ready のはず");
      if (!close) {
        expect(result.outcome.closeComparison).toBeNull();
        continue;
      }
      const c = result.outcome.closeComparison;
      if (c === null) throw new Error("比較があるはず");
      expect(c.rounds.map((r) => [r.round, r.leadMinutes, r.okCount, r.targetCount])).toEqual([[1, 5, 1, 1], [2, 2, 0, 0]]);
      expect(c.description).toBe(CLOSE_COMPARISON_DESCRIPTION); // サーバの文がそのまま届く(クライアントは固定の説明文を持たない)
      expect(c.rounds.map((r) => r.basisLabel)).toEqual([null, null]);
      // 空振り防止: 分析時と再計算で賭け金が違う
      expect([c.rounds[0]!.base.totalStake, c.rounds[0]!.recalc.totalStake]).toEqual([300, 100]);
      expect([c.rounds[0]!.base.recoveryRate, c.rounds[0]!.recalc.recoveryRate]).toEqual([1.5, 0]);
    }
  });
});

/** 閲覧者の要求(`handle()`)で、本物の VerifyCore の比較を読む。`withClose` が偽なら、再計算の表が読めなかった場合(close: null)。 */
async function closeSetup(withClose: boolean) {
  const data = new Map<string, unknown>();
  const kv: VerifyKv = { get: <T,>(key: string) => data.get(key) as T | undefined, put: (key, value) => void data.set(key, JSON.parse(JSON.stringify(value))) };
  const analysis: VerifyAnalysisRow = {
    id: 1, raceId: "202606030811", analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
  };
  const rows: VerifyReadRows = {
    analyses: [analysis],
    horses: [{ analysisId: 1, umaban: 1, prior: 0.5, adjusted_prob: 0.5, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null }],
    allocationMeta: [{ analysisId: 1, route: "place-only", skipReasonCode: null }],
    bets: [{ analysisId: 1, betType: "place", comboKey: "01", stake: 300 }],
    results: [{ raceId: "202606030811", umaban: 1, finishPosition: 1, placePayout: 150, winPayout: null }, { raceId: "202606030811", umaban: 2, finishPosition: 5, placePayout: null, winPayout: null }],
    comboPayouts: [], comboImports: [],
  };
  const close = withClose
    ? { meta: [{ analysisId: 1, round: 1, status: "ok", route: "place-only", skipReasonCode: null }], bets: [{ analysisId: 1, round: 1, betType: "place", comboKey: "02", stake: 100 }] }
    : null;
  const store: VerifyStorePort = {
    readWatermark: async () => ({ analyses: 1, results: 2, comboPayouts: null, comboImports: null }),
    listPending: async () => ({ rows: [], total: 0 }),
    readUsage: async () => ({ classA: 0, classB: 0 }),
    resolveStartTimes: async () => ({ resolved: [], missing: [], failed: [], gets: 0 }),
    commitStartTimes: async () => 0,
    readAll: async () => ({ rows, rowsRead: 1, counts: {}, close }),
  };
  const core = new VerifyCore({ kv, now: () => Date.parse("2026-10-10T03:00:00.000Z"), setAlarm: () => {}, getAlarm: async () => null, store });
  await core.getReport("all");
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key, { email: "friend@example.com" });
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: {} as unknown as Env["DB"],
    ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
    VERIFY_REPORT: { idFromName: (name: string) => name, get: () => ({ getReport: async (venue, options) => core.getReport(venue, options), getViewerReport: async (venue) => core.getViewerReport(venue) }) },
  };
  const fetchLike: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    headers.set("Cf-Access-Jwt-Assertion", token);
    headers.set("Sec-Fetch-Site", "same-origin");
    const response = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers }), env, {}, deps);
    return { status: response.status, json: () => response.json() };
  };
  return { fetch: fetchLike };
}
