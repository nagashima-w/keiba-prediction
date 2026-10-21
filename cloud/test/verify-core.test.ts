import { describe, expect, it } from "vitest";
import {
  VERIFY_BACKOFF_MS,
  VERIFY_MAX_ATTEMPTS,
  VERIFY_TICK_QUERY_LIMIT,
  VerifyCore,
  type VerifyCoreDeps,
  type VerifyCoreOptions,
  type VerifyKv,
  type VerifyStorePort,
} from "../src/verify-core";
import type { ConditionResolution, PendingPage, PendingRow, ReadAllResult, ResolveOutcome, StartTimeResolution, Watermark } from "../src/verify-store";
import type { VerifyAnalysisRow, VerifyReadRows } from "../src/verify-read";
import { R2_FENCE_LIMITS, type R2Usage } from "../src/r2-fence";
import { computeVerifyReport, computeVerifyReportByPromptVersion, DEFAULT_VERIFY_CONFIG, PRODUCTION_VERIFY_CONFIG, type VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";
import { summarizePromptVersions } from "../src/verify-versions";
import { buildVerifySource } from "../src/verify-read";
import { computeCloseComparison, type VerifyCloseRows } from "../src/verify-close";
import { computeVerifyBreakdowns } from "../src/verify-breakdown";

/**
 * Issue #219: 検証の DO の純ロジック(`VerifyCore`)。D1・R2・時計・アラームは偽物で、キャッシュ・費用の柵・単一飛行・発走時刻の補完の進め方を確かめる。
 * 集計そのものは本物の core の `computeVerifyReport`(行 → 読み取り口は `buildVerifySource`)。
 */

const T0 = Date.parse("2026-10-10T03:00:00.000Z"); // JST 12:00

function memoryKv(): VerifyKv & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    put: (key: string, value: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

/** 中央 1 レース・地方 1 レース(結果あり・複勝の賭けあり)の最小の行。 */
function analysisRow(id: number, raceId: string, over: Partial<VerifyAnalysisRow> = {}): VerifyAnalysisRow {
  return {
    id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
    ...over,
  };
}
function rowsOf(analyses: readonly VerifyAnalysisRow[]): VerifyReadRows {
  const horses = analyses.map((a) => ({ analysisId: a.id, umaban: 1, prior: 0.5, adjusted_prob: 0.5, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null }));
  const results = [...new Set(analyses.map((a) => a.raceId))].map((raceId) => ({ raceId, umaban: 1, finishPosition: 1, placePayout: 300 as number | null, winPayout: null as number | null }));
  return { analyses, horses, allocationMeta: [], bets: [], results, comboPayouts: [], comboImports: [] };
}
const CENTRAL = "202606030811";
const NAR = "202644071411";
const DEFAULT_ROWS = rowsOf([analysisRow(1, CENTRAL), analysisRow(2, NAR, { kaisaiDate: null })]);

interface FakeState {
  watermark: Watermark;
  pending: PendingRow[];
  usage: R2Usage;
  rows: VerifyReadRows;
  /** resolveStartTimes の結果を差し替える。省略時は全行を '' で解決。 */
  resolve?: (rows: readonly PendingRow[]) => ResolveOutcome;
  /** readAll が返す再計算の行(Issue #352)。省略(undefined)なら、この項目を持たない読み取り口(既存の偽物と同じ)。null は表が読めなかった場合。 */
  close?: VerifyCloseRows | null;
  failReadAll?: boolean;
  failResolve?: boolean;
  /** readAll の途中で呼ぶ(競合の再現)。 */
  duringReadAll?: () => void;
}

function fakeStore() {
  const calls: string[] = [];
  const state: FakeState = {
    watermark: { analyses: 2, results: 2, comboPayouts: null, comboImports: null },
    pending: [],
    usage: { classA: 0, classB: 0 },
    rows: DEFAULT_ROWS,
  };
  const listPendingArgs: Array<[number, number]> = [];
  const committed: Array<{ resolved: StartTimeResolution[]; gets: number }> = [];
  /** commitStartTimes の第 3 引数(条件の結果。Issue #389)。committed と同じ並び。 */
  const committedConditions: Array<readonly ConditionResolution[] | undefined> = [];
  const port: VerifyStorePort = {
    async readWatermark() {
      calls.push("watermark");
      return { ...state.watermark };
    },
    async listPending(cursor, limit): Promise<PendingPage> {
      calls.push("listPending");
      listPendingArgs.push([cursor, limit]);
      const rows = state.pending.filter((r) => r.id > cursor);
      return { rows: rows.slice(0, limit), total: rows.length };
    },
    async readUsage() {
      calls.push("usage");
      return state.usage;
    },
    async resolveStartTimes(rows): Promise<ResolveOutcome> {
      calls.push("resolve");
      if (state.failResolve === true) throw new Error("D1_ERROR");
      if (state.resolve !== undefined) return state.resolve(rows);
      return { resolved: rows.map((r) => ({ id: r.id, value: "" })), missing: [], failed: [], gets: rows.length };
    },
    async commitStartTimes(resolved, gets, conditions) {
      calls.push("commit");
      committed.push({ resolved: [...resolved], gets });
      committedConditions.push(conditions === undefined ? undefined : [...conditions]);
      const ids = new Set(resolved.map((r) => r.id));
      state.pending = state.pending.filter((p) => !ids.has(p.id));
      return resolved.length;
    },
    async readAll(): Promise<ReadAllResult> {
      calls.push("readAll");
      state.duringReadAll?.();
      if (state.failReadAll === true) throw new Error("D1_ERROR");
      const rows = state.rows;
      const counts = { analyses: rows.analyses.length, horses: rows.horses.length, allocationMeta: 0, bets: 0, results: rows.results.length, comboPayouts: 0, comboImports: 0 };
      if (state.close === undefined) return { rows, rowsRead: 123, counts };
      if (state.close === null) return { rows, rowsRead: 123, counts, close: null };
      return { rows, rowsRead: 123, counts: { ...counts, closeMeta: state.close.meta.length, closeBets: state.close.bets.length }, close: state.close };
    },
  };
  return { port, state, calls, listPendingArgs, committed, committedConditions };
}

function setup(options: VerifyCoreOptions = {}) {
  const store = fakeStore();
  const kv = memoryKv();
  const clock = { now: T0 };
  const alarms: number[] = [];
  let alarm: number | null = null;
  const warns: string[] = [];
  const deps: VerifyCoreDeps = {
    kv,
    now: () => clock.now,
    setAlarm: (at) => {
      alarm = at;
      alarms.push(at);
    },
    getAlarm: async () => alarm,
    store: store.port,
    onWarn: (m) => warns.push(m),
  };
  const core = new VerifyCore(deps, options);
  return { core, store, kv, clock, alarms, getAlarm: () => alarm, clearAlarm: () => { alarm = null; }, warns };
}

const pendingRow = (id: number): PendingRow => ({ id, raceId: CENTRAL, analyzedAt: "2026-07-05T05:00:00.000Z", detailKey: `analyses/${id}.json.gz` });

/** 配分ベースの要約(`ProposedBetTypeSummary`)を持つキー: overall と 8 券種。 */
const SUMMARY_KEYS = ["overall", "place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];

describe("getReport: 計算とキャッシュ", () => {
  it("初回は計算して ready を返す。3 区分を同時に計算・保存し、要求した区分の報告を返す。診断(読んだ行数・所要時間)を添える", async () => {
    const { core, store, kv } = setup();
    const res = await core.getReport("all");
    expect(res.status).toBe("ready");
    if (res.status !== "ready") throw new Error("unreachable");
    expect(res.venue).toBe("all");
    expect(res.stale).toBe(false);
    expect(res.staleReason).toBeNull();
    expect(res.computedAt).toBe(new Date(T0).toISOString());
    expect(res.report.includedAnalysisCount).toBe(2);
    expect(res.diag.rowsRead).toBe(123);
    expect(res.diag.counts.analyses).toBe(2);
    expect(res.diag.startTimeGaps).toEqual({ lost: 0, affecting: 0 });
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1);
    // 3 区分が保存されている(区分の切替で D1 を読まない)
    const cache = kv.get<{ reports: Record<string, { includedAnalysisCount: number }> }>("cache")!;
    expect(Object.keys(cache.reports).sort()).toEqual(["all", "central", "nar"]);
    expect(cache.reports["central"]!.includedAnalysisCount).toBe(1);
    expect(cache.reports["nar"]!.includedAnalysisCount).toBe(1);
    // 区分を変えても再計算しない
    const central = await core.getReport("central");
    const nar = await core.getReport("nar");
    expect(central.status === "ready" && central.report.includedAnalysisCount).toBe(1);
    expect(nar.status === "ready" && nar.report.includedAnalysisCount).toBe(1);
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1);
  });

  it("版別比較(Issue #220): 同時に計算して返し、kv に保存する。区分に依らず全体(中央のみ・地方のみでも同じ)で、画面が使う項目だけを持つ", async () => {
    const rows = rowsOf([analysisRow(1, CENTRAL, { promptVersion: "v1" }), analysisRow(2, NAR, { kaisaiDate: null, promptVersion: "v2", additionalInstruction: "逃げ馬を重視" }), analysisRow(3, "202606030812", { promptVersion: "v2" })]);
    const { core, store, kv } = setup();
    store.state.rows = rows;
    const all = await core.getReport("all");
    const central = await core.getReport("central");
    const nar = await core.getReport("nar");
    if (all.status !== "ready" || central.status !== "ready" || nar.status !== "ready") throw new Error("ready のはず");
    // 前提(空振り防止): 区分で絞ると集計件数が変わる(全体 3・中央 2・地方 1)のに、版別は全体のまま
    expect([all.report.includedAnalysisCount, central.report.includedAnalysisCount, nar.report.includedAnalysisCount]).toEqual([3, 2, 1]);
    expect(all.promptVersions.map((v) => [v.promptVersion, v.includedAnalysisCount])).toEqual([["v1", 1], ["v2", 2]]);
    expect(central.promptVersions).toEqual(all.promptVersions);
    expect(nar.promptVersions).toEqual(all.promptVersions);
    expect(all.promptVersions[1]!.additionalInstructions).toEqual(["逃げ馬を重視", null]);
    expect(Object.keys(all.promptVersions[0]!).sort()).toEqual(["additionalInstructions", "bet", "calibration", "includedAnalysisCount", "overconfidenceGaps", "priorCalibration", "promptVersion", "quality"]);
    const cache = kv.get<{ v: number; promptVersions: unknown }>("cache")!;
    expect(cache.promptVersions).toEqual(JSON.parse(JSON.stringify(all.promptVersions)));
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1); // D1 の読みは増えない
  });

  it("診断: 版別比較の所要時間(promptVersionsMs)は、3 区分の集計(computeMs)とは別に出す(computeMs の意味を変えない)", async () => {
    const { core, clock } = setup();
    let ticks = 0;
    Object.defineProperty(clock, "now", { get: () => T0 + 7 * (ticks += 1) }); // now() を呼ぶたびに 7ms 進む時計
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    // recompute の now() は t0(読む前)・t1(読んだ後)・t2(3 区分の後)・t3(版別の後)の 4 回。3 区分と版別の間に別の now() は無い
    expect(res.diag.readMs).toBe(7);
    expect(res.diag.computeMs).toBe(7);
    expect(res.diag.promptVersionsMs).toBe(7);
  });

  it("透かしが同じで TTL 内なら、キャッシュを返す(D1 の集計用の読みは 0 回。発行するのは透かしと補完の確認の 2 クエリ)", async () => {
    const { core, store, clock } = setup();
    await core.getReport("all");
    store.calls.length = 0;
    clock.now += 30 * 60_000;
    const res = await core.getReport("all");
    expect(res.status === "ready" && res.stale).toBe(false);
    expect(store.calls).toEqual(["watermark", "listPending"]);
  });

  it("TTL(1 時間)を過ぎたら、透かしが同じでも再計算する(既存行の更新は透かしに出ないため)", async () => {
    const { core, store, clock } = setup();
    await core.getReport("all");
    clock.now += 60 * 60_000 + 1;
    await core.getReport("all");
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(2);
  });

  it("透かしが変わったら再計算する。ただし前回から 5 分未満なら、古いキャッシュを stale(min-interval)で返し、5 分後に再計算する", async () => {
    const { core, store, clock } = setup();
    await core.getReport("all");
    store.state.watermark = { ...store.state.watermark, analyses: 3 };
    clock.now += 4 * 60_000;
    const early = await core.getReport("all");
    expect(early.status).toBe("ready");
    if (early.status !== "ready") throw new Error("unreachable");
    expect(early.stale).toBe(true);
    expect(early.staleReason).toBe("min-interval");
    expect(early.nextRecomputeAt).toBe(new Date(T0 + 5 * 60_000).toISOString());
    expect(early.computedAt).toBe(new Date(T0).toISOString());
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1);
    clock.now = T0 + 5 * 60_000;
    const later = await core.getReport("all");
    expect(later.status === "ready" && later.stale).toBe(false);
    expect(later.status === "ready" && later.computedAt).toBe(new Date(T0 + 5 * 60_000).toISOString());
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(2);
  });

  it("refresh を指定すると、透かしが同じ・TTL 内でも再計算する。ただし最短間隔(5 分)は守る。守られている間は、透かしが同じなので集計は最新=stale にしない(『データが更新されています』と偽らない。レビュー指摘)", async () => {
    const { core, store, clock } = setup();
    await core.getReport("all");
    clock.now += 60_000;
    const early = await core.getReport("all", { refresh: true });
    expect(early.status).toBe("ready");
    if (early.status !== "ready") throw new Error("unreachable");
    expect(early.stale).toBe(false);
    expect(early.staleReason).toBeNull();
    expect(early.nextRecomputeAt).toBeNull();
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1);
    clock.now += 5 * 60_000;
    await core.getReport("all", { refresh: true });
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(2);
  });

  it("1 日(JST)の再計算の上限: 達したら古い集計を stale(daily-limit)で返し、翌日(JST)に戻る。集計が無ければ throttled", async () => {
    const { core, store, clock } = setup({ dailyLimit: 2 });
    // 1 回目・2 回目
    await core.getReport("all");
    clock.now += 6 * 60_000;
    store.state.watermark = { ...store.state.watermark, analyses: 3 };
    await core.getReport("all");
    // 3 回目は上限
    clock.now += 6 * 60_000;
    store.state.watermark = { ...store.state.watermark, analyses: 4 };
    const limited = await core.getReport("all");
    expect(limited.status === "ready" && limited.staleReason).toBe("daily-limit");
    expect(limited.status === "ready" && limited.nextRecomputeAt).toBe("2026-10-10T15:00:00.000Z"); // 翌日 0:00 JST
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(2);
    // 翌日(JST)に戻る
    clock.now = Date.parse("2026-10-10T15:00:01.000Z");
    const next = await core.getReport("all");
    expect(next.status === "ready" && next.stale).toBe(false);
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(3);
  });

  it("上限に達していて集計が無い(DO のキャッシュが消えた)と throttled で、次に計算できる時刻を返す", async () => {
    const { core, store, kv, clock } = setup({ dailyLimit: 1 });
    await core.getReport("all");
    kv.data.delete("cache");
    clock.now += 6 * 60_000;
    const res = await core.getReport("all");
    expect(res).toEqual({ status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" });
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1);
  });

  it("単一飛行: 計算中の同時の要求は、集計用の読みを共有する(readAll は 1 回)", async () => {
    const { core, store } = setup();
    const [a, b, c] = await Promise.all([core.getReport("all"), core.getReport("central"), core.getReport("nar")]);
    expect([a.status, b.status, c.status]).toEqual(["ready", "ready", "ready"]);
    expect(store.calls.filter((x) => x === "readAll")).toHaveLength(1);
  });

  it("計算が失敗(D1 の例外)したら例外を投げ、キャッシュ・実行回数を汚さない(次の要求は再計算できる)", async () => {
    const { core, store, kv } = setup();
    store.state.failReadAll = true;
    await expect(core.getReport("all")).rejects.toThrow("D1_ERROR");
    expect(kv.get("cache")).toBeUndefined();
    expect(kv.get("runs")).toBeUndefined();
    store.state.failReadAll = false;
    const res = await core.getReport("all");
    expect(res.status).toBe("ready");
  });

  it("版別比較を持たない旧い形式のキャッシュ(版 1)は使わず、再計算する(promptVersions の無い ready を返さない)", async () => {
    const { core, store, kv, clock } = setup();
    await core.getReport("all");
    const { promptVersions: _drop, ...rest } = kv.get<Record<string, unknown>>("cache")!;
    kv.put("cache", { ...rest, v: 1 });
    store.calls.length = 0;
    clock.now += 6 * 60_000; // 最短間隔を過ぎている
    const res = await core.getReport("all");
    expect(store.calls).toContain("readAll");
    expect(res.status === "ready" && Array.isArray(res.promptVersions)).toBe(true);
    expect(kv.get<{ v: number }>("cache")!.v).toBeGreaterThanOrEqual(2);
  });

  it("Issue #254: 補正前の対応表(priorCalibration)と帯の平均予測値を持たない版 2 のキャッシュは使わず、再計算する。新しい集計は(Issue #271 以降)版 6 で、3 区分とも priorCalibration を持つ", async () => {
    const { core, store, kv, clock } = setup();
    await core.getReport("all");
    const cache = kv.get<{ v: number; reports: Record<string, Record<string, unknown>> }>("cache")!;
    expect(cache.v).toBe(6);
    // 版 2 の形(priorCalibration が無い)を模擬する
    const oldReports = Object.fromEntries(Object.entries(cache.reports).map(([venue, r]) => {
      const { priorCalibration: _drop, ...rest } = r;
      return [venue, rest];
    }));
    kv.put("cache", { ...cache, v: 2, reports: oldReports });
    store.calls.length = 0;
    clock.now += 6 * 60_000; // 最短間隔を過ぎている
    const res = await core.getReport("central");
    expect(store.calls).toContain("readAll"); // 版 2 は使われない
    expect(res.status).toBe("ready");
    const fresh = kv.get<{ v: number; reports: Record<string, { priorCalibration?: unknown[]; calibration: unknown[] }> }>("cache")!;
    expect(fresh.v).toBe(6);
    for (const venue of ["all", "central", "nar"]) {
      expect(fresh.reports[venue]!.priorCalibration).toHaveLength(20);
      expect(fresh.reports[venue]!.calibration).toHaveLength(20);
    }
  });

  it("Issue #72: 返還の項目(refundedCount・refundedStake)を持たない版 3 のキャッシュは使わず、再計算する。新しい集計は(Issue #271 以降)版 6 で、3 区分とも配分ベースの全要約(overall と 8 券種)が返還の項目を持つ", async () => {
    const { core, store, kv, clock } = setup();
    await core.getReport("all");
    const cache = kv.get<{ v: number; reports: Record<string, { proposedBet: Record<string, unknown> }> }>("cache")!;
    expect(cache.v).toBe(6);
    // 版 3 の形(返還の項目が無い)を模擬する
    const strip = (summary: unknown): unknown => {
      const { refundedCount: _c, refundedStake: _s, ...rest } = summary as Record<string, unknown>;
      return rest;
    };
    const oldReports = Object.fromEntries(
      Object.entries(cache.reports).map(([venue, r]) => [
        venue,
        { ...r, proposedBet: Object.fromEntries(Object.entries(r.proposedBet).map(([k, v]) => [k, SUMMARY_KEYS.includes(k) ? strip(v) : v])) },
      ]),
    );
    kv.put("cache", { ...cache, v: 3, reports: oldReports });
    store.calls.length = 0;
    clock.now += 6 * 60_000; // 最短間隔を過ぎている
    const res = await core.getReport("nar");
    expect(store.calls).toContain("readAll"); // 版 3 は使われない
    expect(res.status).toBe("ready");
    const fresh = kv.get<{ v: number; reports: Record<string, { proposedBet: Record<string, Record<string, unknown>> }> }>("cache")!;
    expect(fresh.v).toBe(6);
    for (const venue of ["all", "central", "nar"]) {
      for (const key of SUMMARY_KEYS) {
        expect(fresh.reports[venue]!.proposedBet[key], `${venue}.${key}`).toMatchObject({ refundedCount: 0, refundedStake: 0 });
      }
    }
    expect(SUMMARY_KEYS).toHaveLength(9); // overall + 8 券種(空振り防止: 検査対象が空でない)
  });

  it("Issue #16: 一律 100 円の項目(flatStake・flatReturn・flatRecoveryRate)を持たない版 4 のキャッシュ(#72 だけが先に公開された本番に残る形)は使わず、再計算する。新しい集計は(Issue #271 以降)版 6 で、3 区分とも配分ベースの全要約(overall と 8 券種)が一律の項目を持つ", async () => {
    const { core, store, kv, clock } = setup();
    await core.getReport("all");
    const cache = kv.get<{ v: number; reports: Record<string, { proposedBet: Record<string, unknown> }> }>("cache")!;
    expect(cache.v).toBe(6);
    // 版 4 の形(返還の項目はあるが、一律の項目が無い)を模擬する
    const strip = (summary: unknown): unknown => {
      const { flatStake: _a, flatReturn: _b, flatRecoveryRate: _c, ...rest } = summary as Record<string, unknown>;
      return rest;
    };
    const oldReports = Object.fromEntries(
      Object.entries(cache.reports).map(([venue, r]) => [
        venue,
        { ...r, proposedBet: Object.fromEntries(Object.entries(r.proposedBet).map(([k, v]) => [k, SUMMARY_KEYS.includes(k) ? strip(v) : v])) },
      ]),
    );
    // 前提(空振り防止): 版 4 の形には返還の項目があり、一律の項目が無い
    const sample = oldReports["all"]!.proposedBet["overall"] as Record<string, unknown>;
    expect(sample).toHaveProperty("refundedCount");
    expect(sample).not.toHaveProperty("flatStake");
    kv.put("cache", { ...cache, v: 4, reports: oldReports });
    store.calls.length = 0;
    clock.now += 6 * 60_000; // 最短間隔を過ぎている
    const res = await core.getReport("nar");
    expect(store.calls).toContain("readAll"); // 版 4 は使われない
    expect(res.status).toBe("ready");
    const fresh = kv.get<{ v: number; reports: Record<string, { proposedBet: Record<string, Record<string, unknown>> }> }>("cache")!;
    expect(fresh.v).toBe(6);
    for (const venue of ["all", "central", "nar"]) {
      for (const key of SUMMARY_KEYS) {
        expect(fresh.reports[venue]!.proposedBet[key], `${venue}.${key}`).toMatchObject({ flatStake: 0, flatReturn: 0, flatRecoveryRate: null });
      }
    }
  });

  it("Issue #271: 版別比較の補正前の対応表と Brier(priorCalibration・quality)を持たない版 5 のキャッシュは使わず、再計算する。新しい集計は版 6 で、各版が両方を持つ", async () => {
    const { core, store, kv, clock } = setup();
    await core.getReport("all");
    const cache = kv.get<{ v: number; promptVersions: Record<string, unknown>[] }>("cache")!;
    expect(cache.v).toBe(6);
    // 前提(空振り防止): 版別比較があり、各版が新しい 2 項目を持つ(旧い形を模擬する元)
    expect(cache.promptVersions.length).toBeGreaterThan(0);
    expect(cache.promptVersions.every((v) => "priorCalibration" in v && "quality" in v)).toBe(true);
    // 版 5 の形(版別比較に priorCalibration・quality が無い)を模擬する
    const oldVersions = cache.promptVersions.map((v) => {
      const { priorCalibration: _a, quality: _b, ...rest } = v;
      return rest;
    });
    kv.put("cache", { ...cache, v: 5, promptVersions: oldVersions });
    store.calls.length = 0;
    clock.now += 6 * 60_000; // 最短間隔を過ぎている
    const res = await core.getReport("all");
    expect(store.calls).toContain("readAll"); // 版 5 は使われない
    expect(res.status).toBe("ready");
    const fresh = kv.get<{ v: number; promptVersions: Record<string, unknown>[] }>("cache")!;
    expect(fresh.v).toBe(6);
    expect(fresh.promptVersions.every((v) => "priorCalibration" in v && "quality" in v)).toBe(true);
  });

  it("古い形式のキャッシュ(版が違う)は使わず、再計算する", async () => {
    const { core, store, kv, clock } = setup();
    await core.getReport("all");
    const cache = kv.get<Record<string, unknown>>("cache")!;
    kv.put("cache", { ...cache, v: 0 });
    store.calls.length = 0;
    clock.now += 6 * 60_000; // 最短間隔を過ぎている
    await core.getReport("all");
    expect(store.calls).toContain("readAll");
  });

  it("Issue #245: 形式の版を上げた直後の要求が最短間隔の内側だと、古い集計を stale で出さず throttled になる(docs/current-spec.md の『形式の版を上げた日の副作用』)", async () => {
    const { core, store, kv, clock } = setup();
    expect((await core.getReport("all")).status).toBe("ready");
    const cache = kv.get<Record<string, unknown>>("cache")!;
    kv.put("cache", { ...cache, v: 1 }); // 直前の形式(版が違う)のキャッシュが残っている状況の模擬
    store.calls.length = 0;
    clock.now += 60_000; // 最短間隔(5 分)の内側
    const res = await core.getReport("all");
    expect(res.status).toBe("throttled"); // 前提と結論: 古い集計は使われず、出せる集計が無い
    // Issue #254: 理由は『最短間隔』(1 日の上限ではない)。画面が文言を出し分ける。次に開ける時刻は最短間隔の終わり
    expect(res).toEqual({ status: "throttled", nextAt: new Date(T0 + 5 * 60_000).toISOString(), reason: "min-interval" });
    expect(store.calls).not.toContain("readAll"); // 再計算もしていない
    // 対照: 同じ状況で、版が同じキャッシュなら stale の集計か最新の集計が出る(throttled にならない)
    kv.put("cache", cache);
    expect((await core.getReport("all")).status).toBe("ready");
  });
});

/** `verify-read.ts` の SQL が `start_time` から組み立てる発走時刻つきのスナップショット(JSON 文字列)。 */
const SNAP_1545 = JSON.stringify({ race: { startTime: "15:45" } });
const SNAP_2050 = JSON.stringify({ race: { startTime: "20:50" } });

describe("getReport: exe と同じ集計の設定・区分の割り当て(レビュー指摘: これが無いと、設定や区分の取り違えが全緑のまま残る)", () => {
  /** 先読み疑い(遮断なし・発走後に分析)・clean・結果なしを、中央と地方の両方に入れた入力。 */
  function mixedRows(): VerifyReadRows {
    const unguarded = { historyCutoffDate: null, promptLookaheadGuarded: null } as const;
    const analyses = [
      analysisRow(1, CENTRAL), // 遮断済み(clean)
      analysisRow(2, "202606030812", { ...unguarded, startTime: "15:45", raceSnapshotJson: SNAP_1545, analyzedAt: "2026-07-05T07:00:00.000Z" }), // 中央: 遮断なし・15:45 発走の後(JST 16:00)に分析 = suspect
      analysisRow(3, "202606030810", { ...unguarded, startTime: "15:45", raceSnapshotJson: SNAP_1545, analyzedAt: "2026-07-05T05:00:00.000Z" }), // 中央: 遮断なし・発走前 = clean
      analysisRow(4, NAR, { kaisaiDate: null }), // 地方: 遮断済み
      analysisRow(5, "202644071412", { ...unguarded, startTime: "20:50", raceSnapshotJson: SNAP_2050, analyzedAt: "2026-07-14T12:00:00.000Z", kaisaiDate: null }), // 地方: 遮断なし・20:50 の後 = suspect
    ];
    return rowsOf(analyses);
  }

  it("3 区分とも、core の computeVerifyReport(PRODUCTION_VERIFY_CONFIG, 区分)の直接の呼び出しと完全に一致する(先読み疑いの除外あり・区分は取り違えない)", async () => {
    const { core, store } = setup();
    store.state.rows = mixedRows();
    const direct = (venue: VerifyVenueFilter) => JSON.parse(JSON.stringify(computeVerifyReport(buildVerifySource(store.state.rows), PRODUCTION_VERIFY_CONFIG, venue)));
    const got = async (venue: VerifyVenueFilter) => {
      const res = await core.getReport(venue);
      if (res.status !== "ready") throw new Error(`ready のはず: ${res.status}`);
      return JSON.parse(JSON.stringify(res.report));
    };
    for (const venue of ["all", "central", "nar"] as const) {
      expect(await got(venue), venue).toEqual(direct(venue));
    }
    // 前提(空振り防止): 入力が先読みの除外と区分の違いを実際に動かす
    const all = direct("all");
    const central = direct("central");
    const nar = direct("nar");
    expect(all.excludedLookaheadSuspectCount).toBe(2);
    expect(central.excludedLookaheadSuspectCount).toBe(1);
    expect(nar.excludedLookaheadSuspectCount).toBe(1);
    expect(central.includedAnalysisCount).toBe(2);
    expect(nar.includedAnalysisCount).toBe(1);
    expect(all.includedAnalysisCount).toBe(central.includedAnalysisCount + nar.includedAnalysisCount);
    // 除外を外すと別の値になる(設定の取り違えを検出できる)
    const off = JSON.parse(JSON.stringify(computeVerifyReport(buildVerifySource(store.state.rows), { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }, "all")));
    expect(off.excludedLookaheadSuspectCount).toBe(0);
    expect(off).not.toEqual(all);
    expect(JSON.stringify(central)).not.toBe(JSON.stringify(nar));
  });

  it("Issue #288: 版別比較(promptVersions)も、core の computeVerifyReportByPromptVersion(PRODUCTION_VERIFY_CONFIG)の射影と完全に一致する(先読み疑いの除外あり。経路全体〈getReport → verify-versions〉の設定の取り違えを検出する)", async () => {
    const { core, store } = setup();
    store.state.rows = mixedRows();
    const source = buildVerifySource(store.state.rows);
    const direct = JSON.parse(JSON.stringify(summarizePromptVersions(computeVerifyReportByPromptVersion(source, PRODUCTION_VERIFY_CONFIG))));
    const withoutExclusion = summarizePromptVersions(computeVerifyReportByPromptVersion(source, DEFAULT_VERIFY_CONFIG));
    // 前提(空振り防止): 入力が先読みの除外を実際に動かす(同じ版 v1 で、除外ありは 3 件、除外なしは 5 件)
    expect(direct.map((v: { promptVersion: string | null; includedAnalysisCount: number }) => [v.promptVersion, v.includedAnalysisCount])).toEqual([["v1", 3]]);
    expect(withoutExclusion.map((v) => [v.promptVersion, v.includedAnalysisCount])).toEqual([["v1", 5]]);
    for (const venue of ["all", "central", "nar"] as const) {
      const res = await core.getReport(venue);
      if (res.status !== "ready") throw new Error(`ready のはず: ${res.status}`);
      expect(JSON.parse(JSON.stringify(res.promptVersions)), venue).toEqual(direct);
    }
  });

  it("透かしの各項目(analyses・results・comboPayouts・comboImports)のどれが動いても再計算が走る(1 つでも比較から漏れると、更新が反映されない)", async () => {
    for (const key of ["analyses", "results", "comboPayouts", "comboImports"] as const) {
      const { core, store, clock } = setup();
      await core.getReport("all");
      expect(store.calls.filter((c) => c === "readAll"), `${key}: 初回`).toHaveLength(1);
      clock.now += 6 * 60_000; // 最短間隔を過ぎる
      store.state.watermark = { ...store.state.watermark, [key]: (store.state.watermark[key] ?? 0) + 1 };
      const res = await core.getReport("all");
      expect(res.status === "ready" && res.stale, `${key}: 再計算した集計は最新`).toBe(false);
      expect(store.calls.filter((c) => c === "readAll"), `${key}: 透かしが動いたら再計算`).toHaveLength(2);
    }
  });
});

describe("getReport: 発走時刻の補完が終わっていないとき", () => {
  it("補完待ちの行があり集計が無ければ preparing(残り件数)。集計用の読みはしない。補完のアラームを今に張る", async () => {
    const { core, store, alarms } = setup();
    store.state.pending = [pendingRow(1), pendingRow(2), pendingRow(3)];
    const res = await core.getReport("all");
    expect(res).toEqual({ status: "preparing", remaining: 3, blocked: null, resumeAt: null });
    expect(store.calls).not.toContain("readAll");
    expect(alarms).toEqual([T0]);
  });

  it("補完待ちの行があっても集計があれば、それを stale(backfilling)で返す", async () => {
    const { core, store } = setup();
    await core.getReport("all");
    store.state.pending = [pendingRow(5)];
    store.state.watermark = { ...store.state.watermark, analyses: 5 };
    const res = await core.getReport("all");
    expect(res.status === "ready" && res.staleReason).toBe("backfilling");
    expect(res.status === "ready" && res.stale).toBe(true);
  });

  it("集計用の読みの時点で start_time が NULL の行が混ざっていたら(確認と読みの間に保存された)、キャッシュせず preparing にする", async () => {
    const { core, store, kv } = setup();
    store.state.rows = rowsOf([analysisRow(1, CENTRAL), analysisRow(2, NAR, { startTime: null })]);
    const res = await core.getReport("all");
    expect(res).toMatchObject({ status: "preparing", remaining: 1 });
    expect(kv.get("cache")).toBeUndefined();
    expect(kv.get("runs")).toBeUndefined();
  });

  it("補完待ちが無いと確認できたら、カーソルを透かしの最大 id まで進める(次回の確認は新しい行だけを見る)", async () => {
    const { core, store } = setup();
    await core.getReport("all");
    await core.getReport("all");
    expect(store.listPendingArgs).toEqual([[0, 1], [2, 1]]);
  });

  it("補完が R2 の柵で止まっている(blocked)なら、preparing に blocked と再開時刻を載せる", async () => {
    const { core, store } = setup();
    store.state.pending = [pendingRow(1)];
    store.state.usage = { classA: 0, classB: R2_FENCE_LIMITS.classB };
    await core.runBackfillTick();
    const res = await core.getReport("all");
    expect(res).toEqual({ status: "preparing", remaining: 1, blocked: "r2-fence", resumeAt: "2026-11-01T00:05:00.000Z" });
  });

  it("アラームが無いのに補完待ちがあれば張り直す(自己回復)。張られていれば張り直さない", async () => {
    const { core, store, alarms, getAlarm } = setup();
    store.state.pending = [pendingRow(1)];
    await core.getReport("all");
    expect(alarms).toEqual([T0]);
    expect(getAlarm()).toBe(T0);
    await core.getReport("all");
    expect(alarms).toEqual([T0]);
  });
});

describe("runBackfillTick(アラーム: 発走時刻の補完を少しずつ)", () => {
  it("1 回に読む行数の上限は 問い合わせ数の上限 − 4(使用量・補完待ち・書き込み 2)。合計の問い合わせ数は上限を超えない", async () => {
    const { core, store } = setup();
    store.state.pending = Array.from({ length: 100 }, (_, i) => pendingRow(i + 1));
    await core.runBackfillTick();
    expect(store.listPendingArgs).toEqual([[0, VERIFY_TICK_QUERY_LIMIT - 4]]);
    const gets = store.committed[0]!.gets;
    expect(gets).toBe(VERIFY_TICK_QUERY_LIMIT - 4);
    // 使用量 1 + 補完待ち 1 + 書き込みの batch 2 文 + R2 の get = 上限ちょうど
    expect(1 + 1 + 2 + gets).toBe(VERIFY_TICK_QUERY_LIMIT);
    expect(store.committed[0]!.resolved).toHaveLength(VERIFY_TICK_QUERY_LIMIT - 4);
  });

  it("残りがあれば 1 秒後に次のアラーム。カーソルは解決した行の末尾まで進み、次の tick はそこから読む", async () => {
    const { core, store, alarms } = setup({ tickQueryLimit: 10 });
    store.state.pending = Array.from({ length: 10 }, (_, i) => pendingRow(i + 1));
    await core.runBackfillTick();
    expect(alarms).toEqual([T0 + 1000]);
    await core.runBackfillTick();
    expect(store.listPendingArgs).toEqual([[0, 6], [6, 6]]);
    expect(store.state.pending).toEqual([]);
    // 全部済んだ 2 回目は次のアラームを張らない(張ったのは 1 回目の 1 つだけ)
    expect(alarms).toEqual([T0 + 1000]);
  });

  it("補完待ちが無ければ何もしない(アラームを張らない・R2 を読まない)", async () => {
    const { core, store, alarms } = setup();
    await core.runBackfillTick();
    expect(alarms).toEqual([]);
    expect(store.calls).not.toContain("resolve");
  });

  it("R2 の Class B が柵に達していたら、R2 を読まず、翌月 1 日の 00:05 UTC に再開する", async () => {
    const { core, store, alarms } = setup();
    store.state.pending = [pendingRow(1)];
    store.state.usage = { classA: 0, classB: R2_FENCE_LIMITS.classB };
    await core.runBackfillTick();
    expect(store.calls).not.toContain("resolve");
    expect(store.calls).not.toContain("commit");
    expect(alarms).toEqual([Date.parse("2026-11-01T00:05:00.000Z")]);
    // 柵の手前(上限 −1)なら続ける
    const t = setup();
    t.store.state.pending = [pendingRow(1)];
    t.store.state.usage = { classA: 0, classB: R2_FENCE_LIMITS.classB - 1 };
    await t.core.runBackfillTick();
    expect(t.store.calls).toContain("resolve");
  });

  it("R2 に詳細が無い行(missing)は、初めて見てから 30 分は '?' にせず保留する(60 秒後に再試行・失敗に数えない・カーソルは手前で止める)。分析日時は見ない。30 分たっても現れなければ '?'。途中で現れたら本当の値(レビュー指摘: 移行中の分析は D1 に行があり R2 にまだ無い瞬間がある)", async () => {
    const { core, store, alarms, kv, clock } = setup();
    store.state.pending = [pendingRow(1), pendingRow(2), pendingRow(3)];
    // 1 は読めた。2・3 は R2 に無い(分析日時は古い=pendingRow の analyzedAt は 2026-07-05)
    store.state.resolve = (rows) => ({ resolved: [{ id: rows[0]!.id, value: "15:45" }], missing: rows.slice(1).map((r) => r.id), failed: [], gets: rows.length });
    await core.runBackfillTick();
    expect(store.committed[0]!.resolved).toEqual([{ id: 1, value: "15:45" }]);
    expect(alarms).toEqual([T0 + 60_000]);
    expect(kv.get<{ attempts: number }>("backfill")!.attempts).toBe(0);
    // 29 分 59 秒後もまだ '?' にしない
    clock.now = T0 + 30 * 60_000 - 1000;
    store.state.resolve = (rows) => ({ resolved: [], missing: rows.map((r) => r.id), failed: [], gets: rows.length });
    await core.runBackfillTick();
    expect(store.committed[1]!.resolved).toEqual([]);
    expect(store.listPendingArgs[1]).toEqual([1, VERIFY_TICK_QUERY_LIMIT - 4]); // カーソルは 1 まで(2・3 の手前)
    // 3 は現れた(本当の値)。2 は 30 分に達して '?'
    clock.now = T0 + 30 * 60_000;
    store.state.resolve = (rows) => ({ resolved: [{ id: 3, value: "16:00" }], missing: rows.filter((r) => r.id === 2).map((r) => r.id), failed: [], gets: rows.length });
    await core.runBackfillTick();
    expect(store.committed[2]!.resolved).toEqual([{ id: 3, value: "16:00" }, { id: 2, value: "?" }]);
    expect(store.state.pending).toEqual([]);
    // 状態は片づく(解決した行の初回観測時刻は残さない)
    expect(kv.get<Record<string, number>>("missingSince")).toEqual({});
  });

  it("初回観測時刻は行ごとに持つ(新しく見えた行は、先に見えていた行の時刻を引き継がない)", async () => {
    const { core, store, clock, kv } = setup();
    store.state.pending = [pendingRow(1)];
    store.state.resolve = (rows) => ({ resolved: [], missing: rows.map((r) => r.id), failed: [], gets: rows.length });
    await core.runBackfillTick();
    expect(kv.get<Record<string, number>>("missingSince")).toEqual({ "1": T0 });
    clock.now = T0 + 20 * 60_000;
    store.state.pending = [pendingRow(1), pendingRow(2)];
    await core.runBackfillTick();
    expect(kv.get<Record<string, number>>("missingSince")).toEqual({ "1": T0, "2": T0 + 20 * 60_000 });
    clock.now = T0 + 31 * 60_000;
    await core.runBackfillTick();
    // 1 は 31 分(>=30)で '?'。2 は 11 分なので保留のまま
    expect(store.committed.at(-1)!.resolved).toEqual([{ id: 1, value: "?" }]);
    expect(kv.get<Record<string, number>>("missingSince")).toEqual({ "2": T0 + 20 * 60_000 });
  });

  it("get の失敗(failed)があれば、解決できた行は書いたうえで、失敗の回数を数えて退避の間隔で再試行する。連続 MAX 回で止まる(アラームを張らない)", async () => {
    const { core, store, alarms, kv } = setup();
    store.state.pending = [pendingRow(1), pendingRow(2)];
    store.state.resolve = (rows) => ({ resolved: [{ id: rows[0]!.id, value: "" }], missing: [], failed: [rows[1]!.id], gets: rows.length });
    await core.runBackfillTick();
    expect(store.committed[0]!.resolved).toEqual([{ id: 1, value: "" }]);
    expect(alarms).toEqual([T0 + VERIFY_BACKOFF_MS[0]!]);
    expect(kv.get<{ attempts: number }>("backfill")!.attempts).toBe(1);
    // 失敗が続く(行 2 は NULL のまま)
    for (let i = 1; i < VERIFY_MAX_ATTEMPTS; i += 1) {
      await core.runBackfillTick();
    }
    expect(kv.get<{ attempts: number }>("backfill")!.attempts).toBe(VERIFY_MAX_ATTEMPTS);
    // MAX 回目の失敗では次のアラームを張らない(張ったのは 1〜MAX-1 回目の失敗の後の MAX-1 回)
    expect(alarms).toHaveLength(VERIFY_MAX_ATTEMPTS - 1);
  });

  it("D1 などの例外でも握って失敗として数え、退避の間隔で再試行する(例外の本文は状態に残さない)", async () => {
    const { core, store, alarms, kv, warns } = setup();
    store.state.pending = [pendingRow(1)];
    store.state.failResolve = true;
    await core.runBackfillTick();
    expect(alarms).toEqual([T0 + VERIFY_BACKOFF_MS[0]!]);
    expect(JSON.stringify(kv.get("backfill"))).not.toContain("D1_ERROR");
    expect(warns).toHaveLength(1);
  });

  it("失敗で止まったあとは、10 分経ってから getReport が張り直して再開する(それまでは張り直さない)", async () => {
    const { core, store, alarms, clock, clearAlarm } = setup();
    store.state.pending = [pendingRow(1)];
    store.state.failResolve = true;
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i += 1) {
      await core.runBackfillTick();
    }
    clearAlarm();
    const armed = alarms.length;
    const early = await core.getReport("all");
    expect(early).toMatchObject({ status: "preparing", blocked: "error" });
    expect(alarms).toHaveLength(armed);
    clock.now += 10 * 60_000 + 1;
    store.state.failResolve = false;
    await core.getReport("all");
    expect(alarms).toHaveLength(armed + 1);
    expect(alarms.at(-1)).toBe(clock.now);
  });
});

describe("Issue #263: getViewerReport(閲覧者の要求。集計のやり直しを起こさず、D1・R2・アラームに触れない)", () => {
  /** 管理者の要求で集計を 1 回作り、store の呼び出し記録を空にした状態。 */
  async function withCache(options: VerifyCoreOptions = {}, rows: VerifyReadRows = DEFAULT_ROWS) {
    const env = setup(options);
    env.store.state.rows = rows;
    const first = await env.core.getReport("all");
    if (first.status !== "ready") throw new Error("前提: 管理者の最初の要求で集計ができているはず");
    env.store.calls.length = 0;
    env.alarms.length = 0;
    return { ...env, first };
  }

  it("キャッシュがあれば ready で返す(区分ごとの報告・版別比較・集計の時刻)。D1 も R2 もアラームも使わず、再計算の記録(runs)も増えない", async () => {
    const { core, store, kv, alarms, first } = await withCache();
    const runsBefore = JSON.stringify(kv.get("runs"));
    expect(runsBefore).toBeDefined(); // 前提: 管理者の再計算の記録がある(比べる相手が undefined でない)
    // 管理者の応答(区分ごと)を先に取る(キャッシュのヒットで D1 の確認クエリを発行するので、閲覧者の区間とは分ける)
    const adminByVenue = {
      all: first,
      central: await core.getReport("central"),
      nar: await core.getReport("nar"),
    };
    store.calls.length = 0;
    alarms.length = 0;
    for (const venue of ["all", "central", "nar"] as const) {
      const res = core.getViewerReport(venue);
      const admin = adminByVenue[venue];
      if (res.status !== "ready" || admin.status !== "ready") throw new Error("ready のはず");
      expect(res.venue).toBe(venue);
      expect(res.report).toEqual(admin.report);
      expect(res.promptVersions.length).toBeGreaterThan(0); // 前提: 版別比較が空でない(下の比較が自明にならない)
      expect(res.promptVersions.map((v) => v.includedAnalysisCount)).toEqual(admin.promptVersions.map((v) => v.includedAnalysisCount));
      expect(res.computedAt).toBe(admin.computedAt);
    }
    // 前提(空振り防止): 区分で報告が違う(全体 2・中央 1・地方 1)ので、区分を取り違えると上の toEqual が落ちる
    const central = core.getViewerReport("central");
    const all = core.getViewerReport("all");
    expect(central.status === "ready" && all.status === "ready" && [all.report.includedAnalysisCount, central.report.includedAnalysisCount]).toEqual([2, 1]);
    expect(store.calls).toEqual([]);
    expect(alarms).toEqual([]);
    expect(JSON.stringify(kv.get("runs"))).toBe(runsBefore);
  });

  it("古いキャッシュ(TTL 超過・透かしが変わった・最短間隔の外・上限の内 = 管理者なら再計算する状況)でも、そのまま返す。stale にも偽らない。再計算しない", async () => {
    const { core, store, kv, clock, first } = await withCache();
    clock.now += 3 * 60 * 60_000; // TTL(1 時間)を大きく超える
    store.state.watermark = { ...store.state.watermark, analyses: 99 };
    const runsBefore = JSON.stringify(kv.get("runs"));
    const cacheBefore = JSON.stringify(kv.get("cache"));
    const res = core.getViewerReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.computedAt).toBe(first.status === "ready" ? first.computedAt : "");
    expect(res.computedAt).toBe(new Date(T0).toISOString()); // 古い集計の時刻のまま
    expect(res.stale).toBe(false);
    expect(store.calls).toEqual([]); // 透かしも読まない(D1 に触れない)
    expect(JSON.stringify(kv.get("runs"))).toBe(runsBefore);
    expect(JSON.stringify(kv.get("cache"))).toBe(cacheBefore);
    // 対照(空振り防止): 同じ状態で管理者の要求なら再計算する(=閲覧者の要求がやり直しを起こさないことに意味がある状況だった)
    await core.getReport("all");
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1);
    expect(JSON.stringify(kv.get("runs"))).not.toBe(runsBefore);
  });

  it("キャッシュがまったく無ければ not-computed。再計算しない(管理者なら計算する状況)。D1・R2・アラームに触れず、runs・cache を作らない", async () => {
    const { core, store, kv, alarms } = setup();
    store.state.pending = [pendingRow(1)]; // 補完待ちがあっても、閲覧者はアラームを張らない
    for (const venue of ["all", "central", "nar"] as const) {
      expect(core.getViewerReport(venue)).toEqual({ status: "not-computed" });
    }
    expect(store.calls).toEqual([]);
    expect(alarms).toEqual([]);
    expect(kv.get("runs")).toBeUndefined();
    expect(kv.get("cache")).toBeUndefined();
    // 対照(空振り防止): 補完待ちを外して管理者の要求なら計算する
    store.state.pending = [];
    const admin = await core.getReport("all");
    expect(admin.status).toBe("ready");
  });

  it("形式の版が違う(使えない)キャッシュは無いものとして not-computed。古い形式の中身を閲覧者に出さない", async () => {
    const { core, kv } = await withCache();
    const cache = kv.get<Record<string, unknown>>("cache")!;
    kv.put("cache", { ...cache, v: 2 });
    expect(core.getViewerReport("all")).toEqual({ status: "not-computed" });
    // 対照: 版を戻せば返る
    kv.put("cache", cache);
    expect(core.getViewerReport("all").status).toBe("ready");
  });

  it("閲覧者がどれだけ要求しても、費用の柵(1 日の上限・最短間隔)を消費しない: 後からの管理者の再計算が、上限の手前なら通る", async () => {
    // 1 日の上限 2 回。管理者が 1 回計算したあと、閲覧者が 50 回要求し(新しいデータがある状況)、その後の管理者の再計算が(最短間隔の後に)通る
    const { core, store, kv, clock } = await withCache({ dailyLimit: 2 });
    for (let i = 0; i < 50; i += 1) {
      clock.now += 60_000;
      store.state.watermark = { ...store.state.watermark, analyses: 10 + i };
      core.getViewerReport((["all", "central", "nar"] as const)[i % 3]!);
    }
    expect(kv.get<{ count: number }>("runs")?.count).toBe(1); // 柵の記録は管理者の 1 回だけ
    expect(store.calls).toEqual([]);
    const admin = await core.getReport("all");
    expect(admin.status === "ready" && admin.stale).toBe(false);
    expect(admin.status === "ready" && admin.computedAt).toBe(new Date(clock.now).toISOString()); // 再計算された(上限で止められていない)
    expect(kv.get<{ count: number }>("runs")?.count).toBe(2);
  });

  it("閲覧者に見せる応答は、画面が使う項目だけ: 診断は発走時刻の欠落(startTimeGaps)だけで、D1 の読み取り行数・表ごとの行数・所要時間を含まない", async () => {
    const { core } = await withCache();
    const res = core.getViewerReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(Object.keys(res).sort()).toEqual(["breakdown", "closeComparison", "computedAt", "diag", "nextRecomputeAt", "promptVersions", "report", "stale", "staleReason", "status", "venue"]);
    expect(res.stale).toBe(false);
    expect(res.staleReason).toBeNull();
    expect(res.nextRecomputeAt).toBeNull();
    expect(Object.keys(res.diag)).toEqual(["startTimeGaps"]);
    expect(res.diag.startTimeGaps).toEqual({ lost: 0, affecting: 0 });
    const text = JSON.stringify(res);
    for (const forbidden of ["rowsRead", "counts", "readMs", "computeMs", "promptVersionsMs"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // 対照(空振り防止): 管理者の応答には診断の細目がある
    const admin = await core.getReport("all");
    expect(JSON.stringify(admin)).toContain("rowsRead");
  });

  it("追加指示の全文(設定の値。分析の詳細の API も閲覧者には返さない)は、閲覧者の応答に含めない。版ごとの『あり/なし』の別と数は残す", async () => {
    const SECRET = "SECRET-逃げ馬を重視せよ";
    const rows = rowsOf([analysisRow(1, CENTRAL, { promptVersion: "v1", additionalInstruction: null }), analysisRow(2, NAR, { kaisaiDate: null, promptVersion: "v2", additionalInstruction: SECRET }), analysisRow(3, "202606030812", { promptVersion: "v2", additionalInstruction: null })]);
    const { core } = await withCache({}, rows);
    const admin = await core.getReport("all");
    if (admin.status !== "ready") throw new Error("ready のはず");
    // 前提: 管理者の応答には全文がある(下の not.toContain が自明にならない)
    expect(admin.promptVersions[1]!.additionalInstructions).toEqual([SECRET, null]);
    const res = core.getViewerReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("逃げ馬");
    // 構造は同じ(あり=非 null・なし=null の別と順序・数)
    expect(res.promptVersions.map((v) => v.additionalInstructions.map((i) => i === null))).toEqual(admin.promptVersions.map((v) => v.additionalInstructions.map((i) => i === null)));
    expect(res.promptVersions[1]!.additionalInstructions).toHaveLength(2);
    // ほかの項目は変えない
    expect(res.promptVersions.map((v) => ({ ...v, additionalInstructions: [] }))).toEqual(admin.promptVersions.map((v) => ({ ...v, additionalInstructions: [] })));
  });
});

describe("Issue #352: 締切直前の再計算との比較(closeComparison)", () => {
  /** 分析 1(中央・的中する 1 番に分析時は 1,000 円)に対して、再計算の回 1 は 外れる 2 番に 500 円。 */
  function withAllocation(): { rows: VerifyReadRows; close: VerifyCloseRows } {
    const rows: VerifyReadRows = {
      ...rowsOf([analysisRow(1, CENTRAL)]),
      allocationMeta: [{ analysisId: 1, route: "place-only", skipReasonCode: null }],
      bets: [{ analysisId: 1, betType: "place", comboKey: "01", stake: 1000 }],
    };
    const close: VerifyCloseRows = {
      meta: [{ analysisId: 1, round: 1, status: "ok", route: "place-only", skipReasonCode: null }],
      bets: [{ analysisId: 1, round: 1, betType: "place", comboKey: "02", stake: 500 }],
    };
    return { rows, close };
  }

  /**
   * Issue #379: 中央 1 件(id1)に加えて、地方の組合せ ON の分析(id2。分析時の配分メタの include_combo_odds = 1)と、地方の組合せ OFF の分析(id3)。
   * どちらも分析時は place 01(的中)に 1,000 円、再計算の回 1 は 外れる 02 に 500 円。
   */
  function withVenues(): { rows: VerifyReadRows; close: VerifyCloseRows } {
    const N2 = "202644071412";
    const base = rowsOf([analysisRow(1, CENTRAL), analysisRow(2, NAR), analysisRow(3, N2)]);
    const rows: VerifyReadRows = {
      ...base,
      allocationMeta: [1, 2, 3].map((id) => ({ analysisId: id, route: "place-only", skipReasonCode: null, includeComboOdds: id === 2 ? 1 : 0 })),
      bets: [1, 2, 3].map((id) => ({ analysisId: id, betType: "place", comboKey: "01", stake: 1000 })),
    };
    const close: VerifyCloseRows = {
      meta: [1, 2, 3].map((id) => ({ analysisId: id, round: 1, status: "ok", route: "place-only", skipReasonCode: null, reason: null })),
      bets: [1, 2, 3].map((id) => ({ analysisId: id, round: 1, betType: "place", comboKey: "02", stake: 500 })),
    };
    return { rows, close };
  }

  it("再計算で比較を作り、kv のキャッシュにも応答にも載せる。値は純関数 computeCloseComparison と同じ。区分(all・central・nar)ごとに別の値で、応答はリクエストの区分のもの(Issue #379。旧: 区分に依らず中央固定)", async () => {
    const { core, store, kv } = setup();
    const { rows, close } = withVenues();
    store.state.rows = rows;
    store.state.close = close;
    const source = buildVerifySource(rows);
    const comboOnIds = new Set([2]);
    const expected = {
      all: computeCloseComparison(source, close, { venue: "all", comboOnIds }),
      central: computeCloseComparison(source, close, { venue: "central", comboOnIds }),
      nar: computeCloseComparison(source, close, { venue: "nar", comboOnIds }),
    };
    // 前提(空振り防止): 区分ごとに値が違う(取り違えを検出できる)。中央は 1 件、地方は基準で 2 行、全体は中央 + 地方の OFF が refetched・地方の ON が analysis
    const targetOf = (c: typeof expected.all, basis: string) => c!.rounds.find((r) => r.round === 1 && r.basis === basis)?.targetCount;
    expect([targetOf(expected.central, "refetched"), targetOf(expected.central, "analysis")]).toEqual([1, undefined]);
    expect([targetOf(expected.nar, "refetched"), targetOf(expected.nar, "analysis")]).toEqual([1, 1]);
    expect([targetOf(expected.all, "refetched"), targetOf(expected.all, "analysis")]).toEqual([2, 1]);
    expect(expected.central!.rounds[0]!.base.totalStake).toBe(1000);
    expect(expected.central!.rounds[0]!.recalc.totalStake).toBe(500);
    for (const venue of ["all", "central", "nar"] as const) {
      const res = await core.getReport(venue);
      if (res.status !== "ready") throw new Error("ready のはず");
      expect(res.closeComparison, venue).toEqual(expected[venue]);
    }
    expect(kv.get<{ closeByVenue: unknown }>("cache")!.closeByVenue).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1); // D1 の読みは増えない(読むのは readAll の中)
  });

  it("基準(組合せ ON か)は分析時の配分メタの includeComboOdds から決める: 値が 0・NULL・無しの分析は ON に数えない", async () => {
    const { core, store } = setup();
    const { rows, close } = withVenues();
    const noFlag: VerifyReadRows = { ...rows, allocationMeta: rows.allocationMeta.map((m) => ({ analysisId: m.analysisId, route: m.route, skipReasonCode: m.skipReasonCode })) };
    store.state.rows = noFlag;
    store.state.close = close;
    const res = await core.getReport("nar");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.closeComparison!.rounds.map((r) => r.basis)).toEqual(["refetched", "refetched"]); // 回 1・回 2 とも refetched だけ(analysis の行なし)
  });

  it("診断: 比較の所要時間(closeMs)を、3 区分(computeMs)・版別(promptVersionsMs)とは別に出す(それらの意味を変えない)。表ごとの行数に再計算の表が出る", async () => {
    const { core, store, clock } = setup();
    const { rows, close } = withAllocation();
    store.state.rows = rows;
    store.state.close = close;
    let ticks = 0;
    Object.defineProperty(clock, "now", { get: () => T0 + 7 * (ticks += 1) });
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect([res.diag.readMs, res.diag.computeMs, res.diag.promptVersionsMs, res.diag.closeMs]).toEqual([7, 7, 7, 7]);
    expect(res.diag.counts).toMatchObject({ closeMeta: 1, closeBets: 1 });
  });

  it("診断の 4 つの所要時間は、隣り合う時刻の差(Issue #373): 時計を呼ぶたびに刻みが 2 倍になるようにして、式の取り違えを検出する(readMs:computeMs:promptVersionsMs:closeMs = 1:2:4:8)", async () => {
    // 上のテストは刻みが一定(7)なので、closeMs を promptVersionsMs と同じ式(t3 - t2)にしても緑になる。ここでは差が 1:2:4:8 になる時計を使う。
    // 限界: `const t4 = now()` を比較の計算の前へ動かす変異は検出しない(now() の呼び出し回数が変わらず、純関数の中で時計を進める手段もない)。検出するのは区間の式の取り違えだけ。
    const { core, store, clock } = setup();
    const { rows, close } = withAllocation();
    store.state.rows = rows;
    store.state.close = close;
    let ticks = 0;
    Object.defineProperty(clock, "now", { get: () => T0 + 2 ** (ticks += 1) });
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    const d = [res.diag.readMs, res.diag.computeMs, res.diag.promptVersionsMs, res.diag.closeMs] as number[];
    expect(d[0], "前提: 最初の区間が 0 でない(以降の比が自明に成立しない)").toBeGreaterThan(0);
    expect([d[1]! / d[0]!, d[2]! / d[0]!, d[3]! / d[0]!]).toEqual([2, 4, 8]);
  });

  it("★再計算の表が読めない(close: null)・この項目を持たない読み取り口でも、比較は null になるだけで、本体の集計は出る(既存の応答を壊さない)", async () => {
    for (const close of [null, undefined]) {
      const { core, store } = setup();
      store.state.close = close;
      const res = await core.getReport("all");
      if (res.status !== "ready") throw new Error("ready のはず");
      expect(res.closeComparison).toBeNull();
      expect(res.report.includedAnalysisCount).toBeGreaterThan(0); // 前提: 本体の集計は出ている
      expect(res.promptVersions.length).toBeGreaterThan(0);
    }
  });

  it("★再計算の表を読めなかったとき(close: null)だけ、固定の警告を 1 行出す。項目を持たない読み取り口(undefined)・読めた場合(行 0 件を含む)では出さない。応答は変えない(Issue #375)", async () => {
    const WARN = "検証の再計算との比較の表を読めませんでした(比較なしで集計します)";
    const none = setup();
    none.store.state.close = null;
    const failed = await none.core.getReport("all");
    expect(none.warns).toEqual([WARN]);
    // 応答は警告の有無に依らない: undefined(項目を持たない)と同じ形で、比較は null・本体の集計は出る
    const absent = setup();
    absent.store.state.close = undefined;
    const withoutKey = await absent.core.getReport("all");
    expect(absent.warns, "項目を持たない読み取り口では出さない").toEqual([]);
    if (failed.status !== "ready" || withoutKey.status !== "ready") throw new Error("ready のはず");
    expect(failed.closeComparison).toBeNull();
    expect(failed.report).toEqual(withoutKey.report);
    // 読めた場合(行 0 件)では出さない
    const empty = setup();
    empty.store.state.close = { meta: [], bets: [] };
    expect((await empty.core.getReport("all")).status).toBe("ready");
    expect(empty.warns, "読めた(0 行)なら警告なし").toEqual([]);
    // キャッシュに当たる 2 回目は再計算しないので、同じ警告を重ねない
    await none.core.getReport("all");
    expect(none.warns).toEqual([WARN]);
  });

  it("★比較の計算が例外を投げても、本体の集計は出る(比較は null。固定の警告だけを残し、例外の文面は持ち込まない)", async () => {
    const { core, store, warns } = setup();
    store.state.close = { meta: [null as never], bets: [] }; // 壊れた行
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.closeComparison).toBeNull();
    expect(res.report.includedAnalysisCount).toBeGreaterThan(0);
    expect(warns).toEqual(["検証の再計算との比較の計算で例外が起きました(比較なしで集計します)"]);
  });

  it("★比較の項目を持たない旧い集計(版 6 のまま)も使える: 再計算せず、closeComparison は null で返す。形式の版は上げていない", async () => {
    const { core, store, kv } = setup();
    expect((await core.getReport("all")).status).toBe("ready");
    const cache = kv.get<Record<string, unknown>>("cache")!;
    expect(cache["v"]).toBe(6); // 形式の版は据え置き(#245 の副作用を避ける。上げるときはこの assert を直す)
    const { closeComparison: _dropOld, closeByVenue: _drop, ...old } = cache;
    // Issue #379 より前の集計は、中央だけの `closeComparison` を持っていた。区分ごとの値ではないので読まない(次の再計算で埋まる)
    kv.put("cache", { ...old, closeComparison: { description: "旧い中央だけの比較", rounds: [] } });
    store.calls.length = 0;
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.closeComparison).toBeNull();
    expect(store.calls).not.toContain("readAll");
    const viewer = core.getViewerReport("all");
    if (viewer.status !== "ready") throw new Error("ready のはず");
    expect(viewer.closeComparison).toBeNull();
  });

  it("閲覧者の応答にも同じ比較が載る(管理者向けの情報ではないので伏せない)。閲覧者の要求は store に触れない", async () => {
    const { core, store } = setup();
    const { rows, close } = withAllocation();
    store.state.rows = rows;
    store.state.close = close;
    const admin = await core.getReport("all");
    if (admin.status !== "ready") throw new Error("ready のはず");
    expect(admin.closeComparison!.rounds).toHaveLength(2); // 前提: 比較がある(undefined・null ではない)
    store.calls.length = 0;
    const viewer = core.getViewerReport("all");
    if (viewer.status !== "ready") throw new Error("ready のはず");
    expect(viewer.closeComparison).toEqual(admin.closeComparison);
    expect(store.calls).toEqual([]);
  });

  it("★閲覧者の応答は区分(all・central・nar)ごとに別の値を返す: 比較・内訳・報告・venue が、管理者の同じ区分の応答と一致する(Issue #445。`closeByVenue?.[venue]` を `.central` に固定する変異を検出する)", async () => {
    const { core, store } = setup();
    const { rows, close } = withVenues();
    store.state.rows = rows;
    store.state.close = close;
    const admins = {} as Record<VerifyVenueFilter, Extract<Awaited<ReturnType<typeof core.getReport>>, { status: "ready" }>>;
    for (const venue of ["all", "central", "nar"] as const) {
      const res = await core.getReport(venue);
      if (res.status !== "ready") throw new Error("ready のはず");
      admins[venue] = res;
    }
    // 前提(空振り防止): 区分ごとに値が違う。比較は基準の行の件数が違い、内訳も区分で違い、どれも null ではない
    const keyOf = (c: (typeof admins)["all"]["closeComparison"]) => JSON.stringify(c);
    expect(admins.all.closeComparison).not.toBeNull();
    expect(new Set([keyOf(admins.all.closeComparison), keyOf(admins.central.closeComparison), keyOf(admins.nar.closeComparison)]).size).toBe(3);
    expect(admins.all.breakdown).not.toBeNull();
    expect(new Set([JSON.stringify(admins.all.breakdown), JSON.stringify(admins.central.breakdown), JSON.stringify(admins.nar.breakdown)]).size).toBe(3);
    expect(new Set([JSON.stringify(admins.all.report), JSON.stringify(admins.central.report), JSON.stringify(admins.nar.report)]).size).toBe(3);
    store.calls.length = 0;
    for (const venue of ["all", "central", "nar"] as const) {
      const viewer = core.getViewerReport(venue);
      if (viewer.status !== "ready") throw new Error("ready のはず");
      expect(viewer.venue, venue).toBe(venue);
      expect(viewer.closeComparison, venue).toEqual(admins[venue].closeComparison);
      expect(viewer.breakdown, venue).toEqual(admins[venue].breakdown);
      expect(viewer.report, venue).toEqual(admins[venue].report);
    }
    expect(store.calls).toEqual([]);
  });
});


describe("Issue #384: 人気帯ごとの期待値と回収率(breakdown)", () => {
  /** 中央 1 レース(1 番が 1 着・複勝 300)に、複勝 01 を 1,000 円(odds 2・ev 1.2)。馬は 1 頭(複勝オッズ下限 2 → 分析時の順位 1)。 */
  function withBets(): VerifyReadRows {
    return {
      ...rowsOf([analysisRow(1, CENTRAL)]),
      allocationMeta: [{ analysisId: 1, route: "place-only", skipReasonCode: null }],
      bets: [{ analysisId: 1, betType: "place", comboKey: "01", stake: 1000, odds: 2, ev: 1.2 }],
    };
  }

  it("★配線(Issue #389): 分析の行の条件(芝・1600m・稍・G3)が、再計算の内訳の 3 つの節(距離帯・馬場・芝ダ)に届く。条件の列が無い行は新しい節を出さない", async () => {
    const withFacts = (): VerifyReadRows => {
      const rows = withBets();
      return { ...rows, analyses: rows.analyses.map((a) => ({ ...a, courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "毎日王冠", condRead: 1 })) };
    };
    const a = setup();
    a.store.state.rows = withFacts();
    const res = await a.core.getReport("central");
    if (res.status !== "ready") throw new Error("ready のはず");
    const labelsOf = (heading: string): string[] => res.breakdown!.find((s) => s.heading === heading)!.rows.map((r) => r.label);
    expect(labelsOf("条件ごとの的中率と回収率(距離帯)")).toEqual(["全体", "1401〜1800m"]);
    expect(labelsOf("条件ごとの的中率と回収率(馬場)")).toEqual(["全体", "稍重"]);
    expect(labelsOf("条件ごとの的中率と回収率(芝ダ)")).toEqual(["全体", "芝"]);
    expect(res.breakdown).toHaveLength(10); // 中央のみ: 人気帯 5 + 競馬場・頭数 2 + 新 3
    const b = setup();
    b.store.state.rows = withBets(); // 条件の列を持たない行
    const plain = await b.core.getReport("central");
    if (plain.status !== "ready") throw new Error("ready のはず");
    expect(plain.breakdown).toHaveLength(7);
  });

  it("再計算で内訳を作り、kv のキャッシュにも応答にも載せる。値は純関数 computeVerifyBreakdowns の節と同じ。区分ごとに別の値(地方のレースが無ければ nar は null)", async () => {
    const { core, store, kv } = setup();
    const rows = withBets();
    store.state.rows = rows;
    const expected = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    // 前提(空振り防止): 全体には 8 つの節(人気帯 5 + 条件別の開催区分・競馬場・頭数)、中央のみには 7 つ(開催区分なし)があり、地方は無い。
    expect(expected.all!.sections).toHaveLength(8);
    expect(expected.central!.sections).toHaveLength(7);
    expect(expected.nar).toBeNull();
    const res = await core.getReport("central");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.breakdown).toEqual(expected.central!.sections);
    const nar = await core.getReport("nar");
    if (nar.status !== "ready") throw new Error("ready のはず");
    expect(nar.breakdown).toBeNull();
    const all = await core.getReport("all");
    if (all.status !== "ready") throw new Error("ready のはず");
    expect(all.breakdown).toEqual(expected.all!.sections);
    expect(kv.get<{ breakdownByVenue: unknown }>("cache")!.breakdownByVenue).toEqual({ all: { sections: expected.all!.sections }, central: { sections: expected.central!.sections }, nar: null });
    expect(store.calls.filter((c) => c === "readAll")).toHaveLength(1);
  });

  it("★キャッシュには集計の途中(stats)を持ち込まず、節だけを入れる(kv の値を小さく保つ)", async () => {
    const { core, store, kv } = setup();
    store.state.rows = withBets();
    await core.getReport("all");
    const cached = kv.get<{ breakdownByVenue: { all: Record<string, unknown> } }>("cache")!.breakdownByVenue.all;
    expect(Object.keys(cached)).toEqual(["sections"]);
  });

  it("診断: 内訳の所要時間(breakdownMs)を、ほかの 4 つとは別に出す(隣り合う時刻の差。readMs:computeMs:promptVersionsMs:closeMs:breakdownMs = 1:2:4:8:16)", async () => {
    const { core, store, clock } = setup();
    store.state.rows = withBets();
    store.state.close = { meta: [], bets: [] };
    let ticks = 0;
    Object.defineProperty(clock, "now", { get: () => T0 + 2 ** (ticks += 1) });
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    const d = [res.diag.readMs, res.diag.computeMs, res.diag.promptVersionsMs, res.diag.closeMs, res.diag.breakdownMs] as number[];
    expect(d[0], "前提: 最初の区間が 0 でない").toBeGreaterThan(0);
    expect([d[1]! / d[0]!, d[2]! / d[0]!, d[3]! / d[0]!, d[4]! / d[0]!]).toEqual([2, 4, 8, 16]);
  });

  it("★内訳の計算が例外を投げても、本体の集計は出る(内訳は null。固定の警告だけを残し、例外の文面は持ち込まない)", async () => {
    const { core, store, warns } = setup();
    const rows = withBets();
    const broken = { ...rows.bets[0]! };
    Object.defineProperty(broken, "ev", { get: () => { throw new Error("D1 の秘密の文面"); } }); // 内訳だけが ev を読む(読み取り口は読まない)
    store.state.rows = { ...rows, bets: [broken] };
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.breakdown).toBeNull();
    expect(res.report.includedAnalysisCount).toBeGreaterThan(0);
    expect(warns).toEqual(["検証の人気帯の内訳の計算で例外が起きました(内訳なしで集計します)"]);
    expect(JSON.stringify(warns)).not.toContain("秘密");
  });

  it("★内訳の項目を持たない旧い集計(版 6 のまま)も使える: 再計算せず、breakdown は null で返す。形式の版は上げていない", async () => {
    const { core, store, kv } = setup();
    store.state.rows = withBets();
    expect((await core.getReport("all")).status).toBe("ready");
    const { breakdownByVenue: _drop, ...old } = kv.get<Record<string, unknown>>("cache")!;
    kv.put("cache", old);
    store.calls.length = 0;
    const res = await core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.breakdown).toBeNull();
    expect(store.calls).not.toContain("readAll");
    const viewer = core.getViewerReport("all");
    if (viewer.status !== "ready") throw new Error("ready のはず");
    expect(viewer.breakdown).toBeNull();
  });

  it("閲覧者の応答にも同じ内訳が載る(検証画面の他の節と同じ扱い)。閲覧者の要求は store に触れない", async () => {
    const { core, store } = setup();
    store.state.rows = withBets();
    const admin = await core.getReport("all");
    if (admin.status !== "ready") throw new Error("ready のはず");
    expect(admin.breakdown).toHaveLength(8); // 前提: 内訳がある
    store.calls.length = 0;
    const viewer = core.getViewerReport("all");
    if (viewer.status !== "ready") throw new Error("ready のはず");
    expect(viewer.breakdown).toEqual(admin.breakdown);
    expect(store.calls).toEqual([]);
  });

  it("閲覧者の応答の診断は発走時刻の欠落だけのまま(内訳の所要時間 breakdownMs を漏らさない)", async () => {
    const { core, store } = setup();
    store.state.rows = withBets();
    await core.getReport("all");
    const viewer = core.getViewerReport("all");
    if (viewer.status !== "ready") throw new Error("ready のはず");
    expect(Object.keys(viewer.diag)).toEqual(["startTimeGaps"]);
  });
});


// ---------------------------------------------------------------------------
// Issue #389(#385-B の a): レースの条件(芝ダ・距離・馬場・グレード・レース名)を、発走時刻と同じ補完で埋める
// ---------------------------------------------------------------------------

const FACTS = { courseType: "芝", distance: 1600, trackCondition: "良", grade: null, raceName: "3歳未勝利" };

describe("Issue #389: 条件の補完(発走時刻と同じ tick・同じ commit)", () => {
  it("解決した行の条件(store が返した事実)を、同じ commit の第 3 引数に渡す。読めなかった行(facts: null)もそのまま渡す", async () => {
    const { core, store } = setup();
    store.state.pending = [pendingRow(1), pendingRow(2)];
    store.state.resolve = (rows) => ({
      resolved: rows.map((r) => ({ id: r.id, value: "15:45" })),
      missing: [],
      failed: [],
      gets: rows.length,
      conditions: [{ id: 1, facts: FACTS }, { id: 2, facts: null }],
    });
    await core.runBackfillTick();
    expect(store.committed).toHaveLength(1);
    expect(store.committedConditions[0]).toEqual([{ id: 1, facts: FACTS }, { id: 2, facts: null }]);
  });

  it("★解決した行は必ず条件の結果を持つ: store が条件を返さなかった行も facts: null(読めなかった印)で渡す(cond_read が NULL のまま永久に保留にならない)", async () => {
    const { core, store } = setup();
    store.state.pending = [pendingRow(1), pendingRow(2)];
    store.state.resolve = (rows) => ({ resolved: rows.map((r) => ({ id: r.id, value: "" })), missing: [], failed: [], gets: rows.length, conditions: [{ id: 1, facts: FACTS }] });
    await core.runBackfillTick();
    expect(store.committedConditions[0]).toEqual([{ id: 1, facts: FACTS }, { id: 2, facts: null }]);
  });

  it("★猶予切れで '?' にする行にも、条件は facts: null で渡す。保留の行・失敗の行には渡さない", async () => {
    const { core, store, clock } = setup();
    store.state.pending = [pendingRow(1), pendingRow(2)];
    store.state.resolve = (rows) => ({ resolved: [], missing: rows.map((r) => r.id), failed: [], gets: rows.length, conditions: [] });
    await core.runBackfillTick();
    expect(store.committed[0]!.resolved).toEqual([]);
    expect(store.committedConditions[0]).toEqual([]); // 保留の間は何も書かない
    clock.now = T0 + 30 * 60_000;
    await core.runBackfillTick();
    expect(store.committed[1]!.resolved).toEqual([{ id: 1, value: "?" }, { id: 2, value: "?" }]);
    expect(store.committedConditions[1]).toEqual([{ id: 1, facts: null }, { id: 2, facts: null }]);
  });

  it("失敗した行(failed)は条件も渡さない(NULL のまま再試行する)", async () => {
    const { core, store } = setup();
    store.state.pending = [pendingRow(1), pendingRow(2)];
    store.state.resolve = (rows) => ({ resolved: [{ id: rows[0]!.id, value: "" }], missing: [], failed: [rows[1]!.id], gets: rows.length, conditions: [{ id: 1, facts: FACTS }] });
    await core.runBackfillTick();
    expect(store.committedConditions[0]).toEqual([{ id: 1, facts: FACTS }]);
  });
});

describe("Issue #389: 補完の候補のカーソル(kv のキーを替えた)", () => {
  it("★旧いキー `cursor` が最大 id まで進んだ状態から始めても、新しいキーでは 0 から数え直す(発走時刻は済みで条件が未確認の既存分を拾う)", async () => {
    const { core, store, kv } = setup();
    kv.put("cursor", 2); // 公開前の補完が最大 id まで進めた状態
    store.state.pending = [pendingRow(1), pendingRow(2)]; // 発走時刻は済み・条件が未確認の既存分(偽物の store は pending をそのまま候補にする)
    await core.runBackfillTick();
    expect(store.listPendingArgs[0]).toEqual([0, VERIFY_TICK_QUERY_LIMIT - 4]);
    expect(store.committed[0]!.resolved.map((r) => r.id)).toEqual([1, 2]);
    expect(kv.get("cursor")).toBe(2); // 旧いキーは読まず・書かない
    expect(kv.get("cursor2")).toBe(2); // 新しいキーが進む
  });

  it("getReport の補完待ちの確認も新しいキーから数える。補完待ちが無いと確認できたら、新しいキーを透かしの最大 id まで進める", async () => {
    const { core, store, kv } = setup();
    kv.put("cursor", 99);
    await core.getReport("all");
    expect(store.listPendingArgs[0]).toEqual([0, 1]);
    expect(kv.get("cursor2")).toBe(2);
    expect(kv.get("cursor")).toBe(99);
  });
});

describe("Issue #389: 集計用の読みの時点で条件が未確認(cond_read が NULL)の行が混ざっていたら集計しない", () => {
  it("condRead が null の行があれば、キャッシュせず preparing(発走時刻が NULL の行と同じ扱い)。件数は、発走時刻 NULL の行と重なっても 1 行を 1 と数える", async () => {
    const { core, store, kv } = setup();
    store.state.rows = rowsOf([analysisRow(1, CENTRAL, { condRead: 1 }), analysisRow(2, NAR, { condRead: null }), analysisRow(3, "202606030812", { condRead: null, startTime: null })]);
    const res = await core.getReport("all");
    expect(res).toMatchObject({ status: "preparing", remaining: 2 });
    expect(kv.get("cache")).toBeUndefined();
    expect(kv.get("runs")).toBeUndefined();
  });

  it("condRead が 0(読めなかった)・1 の行、condRead を持たない行(既存の偽物)は、確認済みとして集計する", async () => {
    const { core, store } = setup();
    store.state.rows = rowsOf([analysisRow(1, CENTRAL, { condRead: 0 }), analysisRow(2, NAR, { kaisaiDate: null, condRead: 1 }), analysisRow(3, "202606030812")]);
    const res = await core.getReport("all");
    expect(res.status).toBe("ready");
  });
});
