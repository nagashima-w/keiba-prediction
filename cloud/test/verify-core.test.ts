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
import type { PendingPage, PendingRow, ReadAllResult, ResolveOutcome, StartTimeResolution, Watermark } from "../src/verify-store";
import type { VerifyAnalysisRow, VerifyReadRows } from "../src/verify-read";
import { R2_FENCE_LIMITS, type R2Usage } from "../src/r2-fence";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG, type VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";
import { buildVerifySource } from "../src/verify-read";

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
    async commitStartTimes(resolved, gets) {
      calls.push("commit");
      committed.push({ resolved: [...resolved], gets });
      const ids = new Set(resolved.map((r) => r.id));
      state.pending = state.pending.filter((p) => !ids.has(p.id));
      return resolved.length;
    },
    async readAll(): Promise<ReadAllResult> {
      calls.push("readAll");
      state.duringReadAll?.();
      if (state.failReadAll === true) throw new Error("D1_ERROR");
      const rows = state.rows;
      return { rows, rowsRead: 123, counts: { analyses: rows.analyses.length, horses: rows.horses.length, allocationMeta: 0, bets: 0, results: rows.results.length, comboPayouts: 0, comboImports: 0 } };
    },
  };
  return { port, state, calls, listPendingArgs, committed };
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
    expect(res).toEqual({ status: "throttled", nextAt: "2026-10-10T15:00:00.000Z" });
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
