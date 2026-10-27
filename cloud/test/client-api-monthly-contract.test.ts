import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchMonthly, fetchMonthlyList } from "../client/api-monthly";
import { buildMonthlyModel } from "../client/monthly-model";
import { handle, type Env } from "../src/handler";
import { jstMsOf } from "../src/monthly-month";
import type { MessageSender } from "@keiba/core/llm";
import { MonthlyReportCore, MONTHLY_NOTE_NO_KEY, type MonthlyMode, type MonthlyReportRecord, type MonthlyStatus } from "../src/monthly-report-core";
import { MONTHLY_PROMPT_VERSION } from "../src/monthly-report-prompt";
import { buildAdjustmentFit, selectFitAnalyses, type FitCandidate } from "../src/adjustment-fit";
import { adjustmentFitSections } from "../src/adjustment-fit-format";
import { buildMonthStats, type MonthStats } from "../src/monthly-stats";
import type { PeriodRows } from "../src/period-stats";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #279(#265-A): 契約テスト。**本物の `MonthlyReportCore` が作った月報**(保存される `MonthlyReportRecord`)を、実際の `handle()`(偽の D1)の応答としてクライアントのパーサに通す。
 * サーバ(月報の組み立て・API)のキー名・形が変わると、ここで検出する。さらに、そのまま画面のモデルまで通して、数字が食い違わないことを確かめる。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function rows(): PeriodRows {
  return {
    races: [
      { analysisId: 1, raceId: "202605030801", kaisaiDate: "20261003", model: "m", promptVersion: "v1" },
      { analysisId: 2, raceId: "202605030802", kaisaiDate: "20261003", model: null, promptVersion: "v2" },
      { analysisId: 3, raceId: "202605031001", kaisaiDate: "20261031", model: "m", promptVersion: null },
    ],
    bets: [
      { analysisId: 1, betType: "win", comboKey: "01", stake: 200, odds: 4, ev: 1.2 },
      { analysisId: 1, betType: "place", comboKey: "02", stake: 100, odds: 2, ev: 1.0 },
      { analysisId: 2, betType: "win", comboKey: "05", stake: 500, odds: 4, ev: 1.2 },
      { analysisId: 3, betType: "win", comboKey: "01", stake: 100, odds: 5, ev: 1.5 },
    ],
    marks: [
      { analysisId: 1, umaban: 1, mark: "◎" },
      { analysisId: 3, umaban: 1, mark: "◎" },
    ],
    results: [
      { raceId: "202605030801", umaban: 1, finishPosition: 1, winPayout: 400, placePayout: 150 },
      { raceId: "202605030801", umaban: 2, finishPosition: 5, winPayout: null, placePayout: null },
      { raceId: "202605031001", umaban: 2, finishPosition: 1, winPayout: 500, placePayout: 150 },
      { raceId: "202605031001", umaban: 1, finishPosition: 2, winPayout: null, placePayout: 200 },
    ],
    combos: [],
    imports: [],
  };
}

/**
 * 本物のコアに、偽の窓口(D1)を渡して月報を作らせ、保存された記録を取り出す。`llmText` を渡すと、その応答を返す偽の LLM を使う(Issue #280。省略は LLM なし = キー未登録の月報)。
 */
async function buildSavedRecord(lastDayPending: boolean, llmText?: string, withFit = false): Promise<MonthlyReportRecord> {
  const sender: MessageSender = async () => ({ content: [{ type: "text", text: llmText ?? "" }], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 10 } });
  const kv = new Map<string, unknown>();
  const saved: MonthlyReportRecord[] = [];
  let t = jstMsOf("20261031", 22);
  const core = new MonthlyReportCore({
    kv: {
      get: <T>(key: string) => (kv.has(key) ? (JSON.parse(JSON.stringify(kv.get(key))) as T) : undefined),
      put: (key, value) => void kv.set(key, JSON.parse(JSON.stringify(value))),
      delete: (key) => void kv.delete(key),
    },
    now: () => t,
    setAlarm: () => {},
    onWarn: () => {},
    source: {
      lastDayStatus: async () => ({ raceCount: 3, noResultRaceCount: lastDayPending ? 1 : 0, hasDailyReport: !lastDayPending }),
      readMonthStats: async (from, to): Promise<MonthStats> => ({ ...buildMonthStats(rows(), { fromDate: from, toDate: to }), ...(withFit ? { adjustmentFit: realFit() } : {}) }),
    },
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(llmText === undefined ? {} : { llm: { sender } }),
    store: { hasReport: async () => false, saveReport: async (r) => (saved.push(r), "saved"), replaceReport: async () => "replaced" },
  });
  await core.requestMonthly({ month: "202610", mode: "auto" });
  for (let i = 0; i < 20 && saved.length === 0; i += 1) {
    await core.runNextStep();
    t += 11 * 60_000; // 待ちの間隔(10 分)を越えて進める
  }
  expect(saved).toHaveLength(1);
  return saved[0]!;
}

/**
 * 本物のコアが作る進行状況(`getStatus`)。`regen-running`: 作り直しを依頼した直後・`regen-kept`: 置き換えを断られて failed・`create-running`: 手動の作成を依頼した直後。
 * 偽の窓口(D1)は、月報の有無と置き換えの結果だけを答える。
 */
async function realJob(scenario: "regen-running" | "regen-kept" | "create-running"): Promise<MonthlyStatus> {
  const kv = new Map<string, unknown>();
  let t = jstMsOf("20261102", 12);
  const mode: MonthlyMode = scenario === "create-running" ? "manual" : "regenerate";
  const core = new MonthlyReportCore({
    kv: {
      get: <T>(key: string) => (kv.has(key) ? (JSON.parse(JSON.stringify(kv.get(key))) as T) : undefined),
      put: (key, value) => void kv.set(key, JSON.parse(JSON.stringify(value))),
      delete: (key) => void kv.delete(key),
    },
    now: () => t,
    setAlarm: () => {},
    onWarn: () => {},
    source: { lastDayStatus: async () => ({ raceCount: 3, noResultRaceCount: 0, hasDailyReport: true }), readMonthStats: async (from, to) => buildMonthStats(rows(), { fromDate: from, toDate: to }) },
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    store: { hasReport: async () => mode === "regenerate", saveReport: async () => "saved", replaceReport: async () => "kept" },
  });
  expect(await core.requestMonthly({ month: "202610", mode })).toEqual({ accepted: true });
  if (scenario === "regen-kept") {
    for (let i = 0; i < 6 && core.getStatus("202610")?.status === "running"; i += 1) {
      await core.runNextStep();
      t += 1000;
    }
  }
  return core.getStatus("202610")!;
}

/** 本物の計算(`buildAdjustmentFit`)が作る補正の当たり具合(2 レース・各 3 頭)。 */
function realFit() {
  const candidate = (id: number, raceId: string): FitCandidate => ({
    id, raceId, analyzedAt: "2026-10-03T00:00:00.000Z", kaisaiDate: "20261003", promptVersion: "v1", detailKey: null, evEstimated: 0, promptLookaheadGuarded: 1, historyCutoffDate: "20261002", startTime: "15:45", model: "claude-x",
  });
  const horses = [1, 2].flatMap((id) => [
    { analysisId: id, umaban: 1, prior: 0.4, adjustedProb: 0.5 },
    { analysisId: id, umaban: 2, prior: 0.3, adjustedProb: 0.3 },
    { analysisId: id, umaban: 3, prior: 0.2, adjustedProb: 0.1 },
  ]);
  const results = ["R1", "R2"].flatMap((raceId) => [
    { raceId, umaban: 1, finishPosition: 1, ninki: 1 },
    { raceId, umaban: 2, finishPosition: 5, ninki: 2 },
    { raceId, umaban: 3, finishPosition: 3, ninki: 8 },
  ]);
  return buildAdjustmentFit(selectFitAnalyses([candidate(1, "R1"), candidate(2, "R2")]), horses, results);
}

async function connect(record: MonthlyReportRecord, options: { status?: MonthlyStatus | null; admin?: boolean } = {}): Promise<FetchLike> {
  const key = await makeKey("k1");
  const token = await signToken(key);
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const row = {
    month: record.month, createdAt: record.createdAt, model: record.model, raceCount: record.raceCount, totalStake: record.totalStake, totalReturn: record.totalReturn,
    summary: record.summary, bodyJson: JSON.stringify(record.body), llmCallsJson: record.llmCallsJson,
  };
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: {
      prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => (args[0] === row.month ? row : null), all: async () => ({ results: [row] }) }) }),
      batch: NOT_CALLED,
    } as unknown as Env["DB"],
    ANALYSIS_DETAIL: {} as unknown as Env["ANALYSIS_DETAIL"],
    ...(options.status === undefined ? {} : { MONTHLY_REPORT: { idFromName: (name: string) => name, get: () => ({ requestMonthlyReport: NOT_CALLED, getStatus: async () => options.status ?? null }) } }),
  };
  return async (url, init) => {
    const res = await handle(new Request(`${ORIGIN}${url}`, { method: init.method, headers: { "Cf-Access-Jwt-Assertion": token } }), env, {}, deps);
    return { status: res.status, json: () => res.json() };
  };
}

describe("契約: 本物の月報(MonthlyReportCore の出力)を、クライアントのパーサが読める", () => {
  it("一覧: 月・件数・賭け金・払戻が読める", async () => {
    const record = await buildSavedRecord(false);
    const list = await fetchMonthlyList(await connect(record));
    expect(list).toStrictEqual({ ok: true, reports: [{ month: "202610", createdAt: record.createdAt, model: null, raceCount: 3, totalStake: record.totalStake, totalReturn: record.totalReturn, summary: null }] });
    // 前提(空振り防止): 賭け金・払戻が実際に数えられている(判定できた買い目 400 円〈10/03 の単勝 200 円・複勝 100 円、10/31 の単勝 100 円。結果なしの 500 円は含めない〉、払戻は 10/03 の単勝の的中 800 円だけ)
    expect(record.totalStake).toBe(400);
    expect(record.totalReturn).toBe(800);
  });

  it("本文: 統計(期間・日ごとの行・版ごとの行)と最終日の未確定の印が、サーバが書いたとおりに読める", async () => {
    const record = await buildSavedRecord(false);
    const got = await fetchMonthly(await connect(record), "202610");
    expect(got.ok).toBe(true);
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    const s = got.report.stats;
    expect(got.report.lastDayPending).toBe(false);
    expect(s.fromDate).toBe("20261001");
    expect(s.toDate).toBe("20261031");
    expect(s.dayCount).toBe(2);
    expect(s.days.map((d) => d.date)).toEqual(["20261003", "20261031"]);
    expect(s.days.map((d) => d.raceCount)).toEqual([2, 1]);
    expect(s.byVersion.map((v) => v.promptVersion)).toEqual(["v1", "v2", null]);
    // サーバの統計とクライアントが読んだ統計が同じ数字(日ごとの合計が月の合計になる)
    expect(s.days.reduce((n, d) => n + d.totalStake, 0)).toBe(s.totalStake);
    expect(s.days.reduce((n, d) => n + d.totalReturn, 0)).toBe(s.totalReturn);
    expect(s.byVersion.reduce((n, v) => n + v.raceCount, 0)).toBe(s.raceCount);
    expect(s.totalStake).toBe(record.totalStake);
  });

  it("補正の当たり具合(Issue #509): 本物のコアが残した数字から、サーバが作った節を、クライアントがそのまま読み、画面のモデルまで通る。数字は本文にも残る", async () => {
    const record = await buildSavedRecord(false, undefined, true);
    const fit = realFit();
    expect(fit.all.horseCount).toBe(6); // 前提: 標本が実際に数えられている(空の節ではない)
    expect(record.body.stats.adjustmentFit).toEqual(fit);
    const got = await fetchMonthly(await connect(record), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    const expected = adjustmentFitSections(fit);
    expect(expected.length).toBeGreaterThan(0);
    expect(got.report.fit).toStrictEqual(expected);
    const model = buildMonthlyModel({ today: "20261101", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: got.report } });
    expect(model.body!.fit).toStrictEqual(expected);
    // 向き別の行の値が、入れた標本のとおり(大きく上げた 2 頭・そのまま 2 頭・大きく下げた 2 頭)
    const direction = model.body!.fit.find((s) => s.heading === "補正の向き別(月全体)")!;
    expect(direction.rows.map((r) => r.value.split("・")[0])).toEqual(["2 頭", "0 頭", "2 頭", "0 頭", "2 頭"]);
  });

  it("補正の当たり具合(Issue #509): 項目の無い月報(昔の月報)は fit が空の配列で、画面のモデルも空", async () => {
    const record = await buildSavedRecord(false);
    expect(record.body.stats.adjustmentFit).toBeUndefined();
    const got = await fetchMonthly(await connect(record), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.fit).toStrictEqual([]);
  });

  it("最終日の結果・日報を待ちきれずに作った月報(lastDayPending: true)も読め、画面のモデルに未確定の注記が出る", async () => {
    const record = await buildSavedRecord(true);
    expect(record.body.lastDayPending).toBe(true);
    const got = await fetchMonthly(await connect(record), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.lastDayPending).toBe(true);
    const model = buildMonthlyModel({ today: "20261101", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: got.report } });
    expect(model.body!.notes).toHaveLength(2);
    expect(model.body!.notes[0]).toContain("最終日");
  });

  it("月報が無い月は report: null、実在しない月は 404 で not-found", async () => {
    const record = await buildSavedRecord(false);
    const fetchLike = await connect(record);
    expect(await fetchMonthly(fetchLike, "202607")).toStrictEqual({ ok: true, report: null, job: null, jobStatus: "ok" });
    expect(await fetchMonthly(fetchLike, "202613")).toStrictEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("画面のモデルまで通す: 本物の月報の数字(賭け金・払戻・開催日ごとの行)が、そのまま画面の文言になる", async () => {
    const record = await buildSavedRecord(false);
    const got = await fetchMonthly(await connect(record), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    const model = buildMonthlyModel({ today: "20261101", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: got.report } });
    expect(model.body!.tiles.find((t) => t.label === "賭け金")!.value).toBe("400円"); // 判定できた買い目: 200 + 100 + 100 の 400 円に、結果なしの 500 円は含めない
    expect(model.body!.tiles.find((t) => t.label === "払戻")!.value).toBe("800円");
    expect(model.body!.dayRows.map((r) => r.href)).toEqual(["#report=20261003", "#report=20261031"]);
  });

  it("本文(文章なし): キー未登録の月報は、文章・生の文章が null・理由と月報のプロンプトの版が読め、画面のモデルは『統計だけ』の注記を出す", async () => {
    const record = await buildSavedRecord(false);
    const got = await fetchMonthly(await connect(record), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.narrative).toBeNull();
    expect(got.report.narrativeRaw).toBeNull();
    expect(got.report.note).toBe(MONTHLY_NOTE_NO_KEY);
    expect(got.report.promptVersion).toBe(MONTHLY_PROMPT_VERSION);
    expect(got.report.model).toBeNull();
    expect(got.job).toBeNull(); // 管理者でも DO の binding が無い構成は、ジョブなし・ok
    expect(got.jobStatus).toBe("ok");
    const model = buildMonthlyModel({ today: "20261101", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: got.report } });
    expect(model.body!.textNote).toContain("統計だけの月報");
    expect(model.body!.summary).toBeNull();
  });

  it("本文(文章あり): 本物のコアが LLM の応答から作った文章(総括・良かった点・改善点・来月に向けて)とモデルが、そのまま読めて、画面のモデルの節になる", async () => {
    const text = JSON.stringify({ summary: "10 月は 3 レースを分析した。", good: ["g1", "g2"], improve: ["i1"], outlook: ["o1"] });
    const record = await buildSavedRecord(false, text);
    expect(record.body.narrative).not.toBeNull(); // 前提: 本物のコアが文章を作っている
    const got = await fetchMonthly(await connect(record), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.narrative).toStrictEqual({ summary: "10 月は 3 レースを分析した。", good: ["g1", "g2"], improve: ["i1"], outlook: ["o1"] });
    expect(got.report.model).toBe("claude-sonnet-5-5");
    expect(got.report.summary).toBe("10 月は 3 レースを分析した。");
    expect(got.report.note).toBeNull();
    const model = buildMonthlyModel({ today: "20261101", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: got.report } });
    expect([model.body!.summary, model.body!.good, model.body!.improve, model.body!.outlook, model.body!.textNote]).toEqual(["10 月は 3 レースを分析した。", ["g1", "g2"], ["i1"], ["o1"], null]);
  });

  it("本文(読めなかった応答): 本物のコアが残した生の文章と理由が読めて、画面のモデルは生の文章を出す", async () => {
    const record = await buildSavedRecord(false, "これは JSON ではない応答");
    expect(record.body.narrativeRaw).toBe("これは JSON ではない応答"); // 前提
    const got = await fetchMonthly(await connect(record), "202610");
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    expect(got.report.narrative).toBeNull();
    expect(got.report.narrativeRaw).toBe("これは JSON ではない応答");
    expect(got.report.note).toContain("構造として読めなかった");
    const model = buildMonthlyModel({ today: "20261101", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: got.report } });
    expect(model.body!.raw).toBe("これは JSON ではない応答");
  });

  it("進行状況: 本物のコアの getStatus(作り直しの依頼直後・置き換えを断られた failed・手動の作成の依頼直後)が、サーバの応答(job・job_status)を通ってクライアントに読める", async () => {
    const record = await buildSavedRecord(false);
    const running = await realJob("regen-running");
    expect(running).toStrictEqual({ phase: "read", status: "running", attempts: 0, regenerate: true });
    const got = await fetchMonthly(await connect(record, { status: running }), "202610");
    expect(got.ok && got.job).toStrictEqual({ phase: "read", status: "running", attempts: 0, regenerate: true });
    expect(got.ok && got.jobStatus).toBe("ok");
    // 画面のモデル: 作り直し中の案内
    if (!got.ok || got.report === null) throw new Error("読めている想定");
    const m1 = buildMonthlyModel({ today: "20261102", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: got.report, job: got.job, jobUnavailable: false } });
    expect(m1.notice!.text).toContain("作り直しを依頼しました");

    const kept = await realJob("regen-kept");
    expect(kept).toStrictEqual({ phase: "save", status: "failed", attempts: 0, regenerate: true }); // 置き換えを断られた(kept)作り直しは save で failed
    const gotKept = await fetchMonthly(await connect(record, { status: kept }), "202610");
    if (!gotKept.ok || gotKept.report === null) throw new Error("読めている想定");
    const m2 = buildMonthlyModel({ today: "20261102", shownMonth: "202610", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: gotKept.report, job: gotKept.job, jobUnavailable: false } });
    expect(m2.notice!.text).toContain("前の月報のまま");

    const creating = await realJob("create-running");
    expect(creating).toStrictEqual({ phase: "read", status: "running", attempts: 0 });
    const gotCreating = await fetchMonthly(await connect(record, { status: creating }), "202610");
    expect(gotCreating.ok && gotCreating.job).toStrictEqual({ phase: "read", status: "running", attempts: 0 });
    expect(gotCreating.ok && gotCreating.job && "regenerate" in gotCreating.job).toBe(false);
  });
});
