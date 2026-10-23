import { describe, expect, it } from "vitest";
import type { MessageSender, ModelInfoLite } from "@keiba/core/llm";
import {
  isMonthlyRequestSettled,
  MonthlyReportCore,
  MONTHLY_MAX_LLM_ATTEMPTS,
  MONTHLY_MAX_STEP_ATTEMPTS,
  MONTHLY_MAX_WAITS,
  MONTHLY_NOTE_FAILED,
  MONTHLY_NOTE_NO_KEY,
  MONTHLY_NOTE_UNPARSED,
  MONTHLY_REGEN_DAILY_LIMIT,
  MONTHLY_RETRY_DELAY_MS,
  MONTHLY_WAIT_INTERVAL_MS,
  type LastDayStatus,
  type MonthlyMode,
  type MonthlyReportDeps,
  type MonthlyReportKv,
  type MonthlyReportRecord,
  type MonthlyStepOutcome,
} from "../src/monthly-report-core";
import { parseLlmCalls } from "../src/llm-calls";
import { jstMsOf } from "../src/monthly-month";
import { buildMonthlyPrompt, MONTHLY_PROMPT_VERSION } from "../src/monthly-report-prompt";
import { buildMonthStats, type MonthStats } from "../src/monthly-stats";
import type { PeriodRows } from "../src/period-stats";
import { DEFAULT_CLOUD_SETTINGS, type AnalysisModelId } from "../src/settings";
import type { DiscordPayload } from "../../packages/core/src/notify/discord";

/**
 * Issue #279(#265-A)・#280(#265-B): 月報の作成の流れ(`MonthlyReportCore`)。D1・時計・アラーム・LLM・Discord は偽物で、
 * 依頼の受け付け(月の終わり・古さ・冪等)→ 最終日の結果と日報を待つ → 読み出し → LLM(generate)→ 保存 → 通知(auto・catchup だけ)の進め方・失敗の扱いと、
 * 管理者の作り直し(regenerate。1 日の回数の上限・文章のある前の月報を潰さない・Discord に送らない)を確かめる。
 */

const MONTH = "202610";
const LAST_DAY = "20261031";
const T_2100 = jstMsOf(LAST_DAY, 21); // 最終日の 21:00(cron の 1 本目)
const T_2200 = jstMsOf(LAST_DAY, 22); // 最終日の 22:00(月報を作り始める時刻)

function memoryKv(): MonthlyReportKv & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => (data.has(key) ? (JSON.parse(JSON.stringify(data.get(key))) as T) : undefined),
    put: (key: string, value: unknown) => void data.set(key, JSON.parse(JSON.stringify(value))),
    delete: (key: string) => void data.delete(key),
  };
}

/** 2 開催日・3 レースの月(10/03 に 2 レース、10/31 に 1 レース)。 */
function monthRows(): PeriodRows {
  return {
    races: [
      { analysisId: 1, raceId: "202605030801", kaisaiDate: "20261003", model: "m", promptVersion: "v1" },
      { analysisId: 2, raceId: "202605030802", kaisaiDate: "20261003", model: "m", promptVersion: "v1" },
      { analysisId: 3, raceId: "202605031001", kaisaiDate: LAST_DAY, model: "m", promptVersion: "v1" },
    ],
    bets: [
      { analysisId: 1, betType: "win", comboKey: "01", stake: 200, odds: 4, ev: 1.2 },
      { analysisId: 3, betType: "win", comboKey: "01", stake: 100, odds: 5, ev: 1.5 },
    ],
    marks: [{ analysisId: 1, umaban: 1, mark: "◎" }],
    results: [
      { raceId: "202605030801", umaban: 1, finishPosition: 1, winPayout: 400, placePayout: 150 },
      { raceId: "202605030802", umaban: 1, finishPosition: 1, winPayout: 300, placePayout: 110 },
      { raceId: "202605031001", umaban: 2, finishPosition: 1, winPayout: 500, placePayout: 150 },
      { raceId: "202605031001", umaban: 1, finishPosition: 2, winPayout: null, placePayout: 200 },
    ],
    combos: [],
    imports: [],
  };
}

interface Harness {
  readonly core: MonthlyReportCore;
  readonly kv: ReturnType<typeof memoryKv>;
  readonly clock: { t: number };
  readonly alarms: number[];
  readonly warns: string[];
  readonly saved: MonthlyReportRecord[];
  readonly replaced: MonthlyReportRecord[];
  readonly sent: DiscordPayload[];
  readonly prompts: string[];
  readonly models: string[];
  /** LLM に送ったリクエストの max_tokens(送った順)。 */
  readonly maxTokens: number[];
  readonly statusCalls: string[];
  readonly readCalls: Array<[string, string]>;
  readonly state: {
    status: LastDayStatus;
    stats: MonthStats;
    failRead: number;
    failStatus: number;
    failSave: number;
    hasReport: boolean;
    hasReportCalls: number;
    saveResult: "saved" | "exists";
    replaceResult: "replaced" | "kept";
    llmFailures: number;
    llmText: string;
    notifyFails: boolean;
  };
  step(): Promise<MonthlyStepOutcome>;
  drain(max?: number): Promise<MonthlyStepOutcome[]>;
}

const SETTLED: LastDayStatus = { raceCount: 1, noResultRaceCount: 0, hasDailyReport: true };

const NARRATIVE_JSON = (): string => JSON.stringify({ summary: "10 月は 3 レースを分析した。", good: ["良い点 1"], improve: ["改善点 1"], outlook: ["来月に見ておく数字"] });

/**
 * 既定は LLM も Discord も無い構成(段階 A と同じ)。`llm: true`・`notifier: true` で足す。
 * `llm` を足すと、偽の sender が 1 回ごとにプロンプトとモデルを記録し、`state.llmFailures` 回まで失敗(HTTP 529)する。
 */
function harness(options: { start?: number; kv?: ReturnType<typeof memoryKv>; llm?: boolean; notifier?: boolean; appBaseUrl?: string; analysisModel?: AnalysisModelId; lister?: () => Promise<ReadonlyArray<ModelInfoLite>> } = {}): Harness {
  const kv = options.kv ?? memoryKv();
  const clock = { t: options.start ?? T_2200 };
  const alarms: number[] = [];
  const warns: string[] = [];
  const saved: MonthlyReportRecord[] = [];
  const replaced: MonthlyReportRecord[] = [];
  const sent: DiscordPayload[] = [];
  const prompts: string[] = [];
  const models: string[] = [];
  const maxTokens: number[] = [];
  const statusCalls: string[] = [];
  const readCalls: Array<[string, string]> = [];
  const state: Harness["state"] = {
    status: SETTLED,
    stats: buildMonthStats(monthRows(), { fromDate: "20261001", toDate: LAST_DAY }),
    failRead: 0,
    failStatus: 0,
    failSave: 0,
    hasReport: false,
    hasReportCalls: 0,
    saveResult: "saved",
    replaceResult: "replaced",
    llmFailures: 0,
    llmText: NARRATIVE_JSON(),
    notifyFails: false,
  };
  const sender: MessageSender = async (params) => {
    prompts.push(params.messages[0]!.content);
    models.push(params.model);
    maxTokens.push(params.max_tokens);
    if (state.llmFailures > 0) {
      state.llmFailures -= 1;
      throw Object.assign(new Error("boom"), { status: 529 });
    }
    return { content: [{ type: "text", text: state.llmText }], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 300 } };
  };
  const deps: MonthlyReportDeps = {
    kv,
    now: () => clock.t,
    setAlarm: (at) => void alarms.push(at),
    onWarn: (m) => void warns.push(m),
    loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS, analysisModel: options.analysisModel ?? DEFAULT_CLOUD_SETTINGS.analysisModel }),
    ...(options.llm === true ? { llm: { sender, ...(options.lister === undefined ? {} : { lister: options.lister }) } } : {}),
    ...(options.notifier === true
      ? {
          notifier: {
            send: async (payload: DiscordPayload) => {
              sent.push(payload);
              if (state.notifyFails) {
                throw new Error("discord down");
              }
            },
          },
        }
      : {}),
    ...(options.appBaseUrl === undefined ? {} : { appBaseUrl: options.appBaseUrl }),
    source: {
      lastDayStatus: async (date) => {
        statusCalls.push(date);
        if (state.failStatus > 0) {
          state.failStatus -= 1;
          throw new Error("D1 の詳細 SECRET-D1");
        }
        return state.status;
      },
      readMonthStats: async (from, to) => {
        readCalls.push([from, to]);
        if (state.failRead > 0) {
          state.failRead -= 1;
          throw new Error("D1 の詳細 SECRET-D1");
        }
        return state.stats;
      },
    },
    store: {
      hasReport: async () => {
        state.hasReportCalls += 1;
        return state.hasReport;
      },
      saveReport: async (record) => {
        if (state.failSave > 0) {
          state.failSave -= 1;
          throw new Error("D1 の詳細 SECRET-D1");
        }
        saved.push(record);
        return state.saveResult;
      },
      replaceReport: async (record) => {
        replaced.push(record);
        return state.replaceResult;
      },
    },
  };
  const core = new MonthlyReportCore(deps);
  const h: Harness = {
    core,
    kv,
    clock,
    alarms,
    warns,
    saved,
    replaced,
    sent,
    prompts,
    models,
    maxTokens,
    statusCalls,
    readCalls,
    state,
    step: () => core.runNextStep(),
    drain: async (max = 50) => {
      const out: MonthlyStepOutcome[] = [];
      for (let i = 0; i < max; i += 1) {
        const o = await core.runNextStep();
        out.push(o);
        if (o.kind === "idle") break;
        clock.t += 1; // 時計を進めて、nextAt が今になるものだけ動かす(待ちの間隔・再試行の待ちは別途進める)
      }
      return out;
    },
  };
  return h;
}

describe("依頼の受け付け(requestMonthly)", () => {
  it.each([
    { name: "最終日の自動(auto)", now: T_2100, month: MONTH, mode: "auto" as const, ok: true },
    { name: "最終日の翌日 1 日の補完(catchup。1 日後)", now: jstMsOf("20261101", 23), month: MONTH, mode: "catchup" as const, ok: true },
    { name: "最終日の 3 日後の補完(catchup。上限ちょうど)", now: jstMsOf("20261103", 23), month: MONTH, mode: "catchup" as const, ok: true },
    { name: "手動(終わった月。ずっと後でもよい)", now: jstMsOf("20270301", 12), month: MONTH, mode: "manual" as const, ok: true },
  ])("受理: $name", async ({ now, month, mode, ok }) => {
    const h = harness({ start: now });
    expect(await h.core.requestMonthly({ month, mode })).toEqual({ accepted: ok });
  });

  it.each([
    { name: "不正な月(13 月)", now: T_2200, month: "202613", mode: "auto" as const, reason: "invalid-month" },
    { name: "不正な月(5 桁)", now: T_2200, month: "20261", mode: "manual" as const, reason: "invalid-month" },
    { name: "月の途中の自動(最終日ではない)", now: jstMsOf("20261030", 21), month: MONTH, mode: "auto" as const, reason: "not-ended" },
    { name: "来月の自動", now: T_2200, month: "202611", mode: "auto" as const, reason: "not-ended" },
    { name: "最終日の手動(今月の月報は最終日の自動作成でだけ作る)", now: T_2200, month: MONTH, mode: "manual" as const, reason: "not-ended" },
    { name: "月の途中の手動", now: jstMsOf("20261015", 12), month: MONTH, mode: "manual" as const, reason: "not-ended" },
    { name: "最終日の 4 日後の補完(古すぎる)", now: jstMsOf("20261104", 23), month: MONTH, mode: "catchup" as const, reason: "too-old" },
    { name: "最終日の 4 日後の自動(古すぎる。自動も補完と同じ上限)", now: jstMsOf("20261104", 23), month: MONTH, mode: "auto" as const, reason: "too-old" },
  ])("断る: $name → $reason", async ({ now, month, mode, reason }) => {
    const h = harness({ start: now });
    expect(await h.core.requestMonthly({ month, mode })).toEqual({ accepted: false, reason });
    // 断った依頼はジョブもアラームも作らない
    expect(h.kv.data.size).toBe(0);
    expect(h.alarms).toEqual([]);
  });

  it("月報が既にあれば exists、作成中なら in-progress(冪等)。失敗(failed)したジョブは再依頼できる", async () => {
    const h = harness();
    h.state.hasReport = true;
    expect(await h.core.requestMonthly({ month: MONTH, mode: "auto" })).toEqual({ accepted: false, reason: "exists" });
    h.state.hasReport = false;
    expect(await h.core.requestMonthly({ month: MONTH, mode: "auto" })).toEqual({ accepted: true });
    expect(await h.core.requestMonthly({ month: MONTH, mode: "auto" })).toEqual({ accepted: false, reason: "in-progress" });
    // 3 回失敗させて failed にする
    h.state.failRead = 99;
    for (let i = 0; i < MONTHLY_MAX_STEP_ATTEMPTS; i += 1) {
      await h.step();
      h.clock.t += MONTHLY_RETRY_DELAY_MS;
    }
    expect(h.core.getStatus(MONTH)).toMatchObject({ status: "failed" });
    h.state.failRead = 0;
    expect(await h.core.requestMonthly({ month: MONTH, mode: "catchup" })).toEqual({ accepted: true });
    expect(h.core.getStatus(MONTH)).toMatchObject({ status: "running", attempts: 0 });
  });

  it("依頼の完了の判定: 受理・exists・in-progress・too-old は完了、不正・まだ終わっていない月は完了ではない", () => {
    expect(isMonthlyRequestSettled({ accepted: true })).toBe(true);
    expect(isMonthlyRequestSettled({ accepted: false, reason: "exists" })).toBe(true);
    expect(isMonthlyRequestSettled({ accepted: false, reason: "in-progress" })).toBe(true);
    expect(isMonthlyRequestSettled({ accepted: false, reason: "too-old" })).toBe(true);
    expect(isMonthlyRequestSettled({ accepted: false, reason: "invalid-month" })).toBe(false);
    expect(isMonthlyRequestSettled({ accepted: false, reason: "not-ended" })).toBe(false);
    // 作り直しだけが返す理由(自動の依頼には返らない)は、完了として扱わない
    expect(isMonthlyRequestSettled({ accepted: false, reason: "not-exists" })).toBe(false);
    expect(isMonthlyRequestSettled({ accepted: false, reason: "daily-limit" })).toBe(false);
  });
});

describe("開始の時刻(startAt。21:00 の cron が『22:00 開始』を依頼する)", () => {
  it("startAt が未来(24 時間以内)なら、その時刻まで動かない。アラームも startAt に張る", async () => {
    const h = harness({ start: T_2100 });
    expect(await h.core.requestMonthly({ month: MONTH, mode: "auto", startAt: T_2200 })).toEqual({ accepted: true });
    expect(h.alarms).toEqual([T_2200]);
    expect(await h.step()).toEqual({ kind: "idle" }); // 21:00 のうちは何もしない
    expect(h.readCalls).toEqual([]);
    h.clock.t = T_2200;
    const o = await h.step();
    expect(o).toMatchObject({ kind: "ran", month: MONTH, phase: "read", result: "ok" });
    expect(h.readCalls).toHaveLength(1);
  });

  it("startAt が過去なら今すぐ(23:00 の cron の依頼。22:00 は過ぎている)", async () => {
    const h = harness({ start: jstMsOf(LAST_DAY, 23) });
    await h.core.requestMonthly({ month: MONTH, mode: "auto", startAt: T_2200 });
    expect(h.alarms).toEqual([jstMsOf(LAST_DAY, 23)]);
    expect(await h.step()).toMatchObject({ kind: "ran", phase: "read" });
  });

  it("startAt が 24 時間より先なら無視して今すぐ(遠い未来に月報を眠らせない)", async () => {
    const h = harness({ start: T_2100 });
    await h.core.requestMonthly({ month: MONTH, mode: "auto", startAt: T_2100 + 25 * 3_600_000 });
    expect(h.alarms).toEqual([T_2100]);
  });
});

describe("作成の流れ(読み出し → 文章 → 保存 → 通知)", () => {
  it("最終日の結果と日報がそろっていれば、読み出し・文章・保存・通知の 1 段階ずつで確定する(自動の作成は通知の段階を通る)。ジョブは残らない", async () => {
    const h = harness();
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const outcomes = await h.drain();
    expect(outcomes.map((o) => (o.kind === "ran" ? `${o.phase}:${o.result}` : o.kind))).toEqual(["read:ok", "generate:ok", "save:ok", "notify:ok", "idle"]);
    expect(h.statusCalls).toEqual([LAST_DAY]);
    expect(h.readCalls).toEqual([["20261001", LAST_DAY]]); // 月初〜月末
    expect(h.saved).toHaveLength(1);
    const r = h.saved[0]!;
    expect(r.month).toBe(MONTH);
    expect(r.raceCount).toBe(3);
    expect(r.totalStake).toBe(300);
    expect(r.totalReturn).toBe(800); // 10/03 の単勝 200 円が 1 着(払戻 400 円 × 200/100)。10/31 の 100 円は 2 着ではずれ
    expect(r.model).toBeNull();
    expect(r.summary).toBeNull();
    expect(r.llmCallsJson).toBeNull();
    expect(r.body).toMatchObject({ format: 1, month: MONTH, lastDayPending: false, narrative: null, narrativeRaw: null, note: MONTHLY_NOTE_NO_KEY, promptVersion: MONTHLY_PROMPT_VERSION });
    expect(r.body.stats.days.map((d) => d.date)).toEqual(["20261003", LAST_DAY]);
    expect(r.createdAt).toBe(new Date(r.createdAt).toISOString());
    expect(h.kv.data.size).toBe(0);
    expect(h.core.getStatus(MONTH)).toBeNull();
  });

  it("月の分析が 1 件も無ければ月報を作らない(no-analyses)。ジョブも残らない", async () => {
    const h = harness();
    h.state.stats = buildMonthStats({ races: [], bets: [], marks: [], results: [], combos: [], imports: [] }, { fromDate: "20261001", toDate: LAST_DAY });
    h.state.status = { raceCount: 0, noResultRaceCount: 0, hasDailyReport: false };
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(await h.step()).toMatchObject({ kind: "ran", phase: "read", result: "no-analyses" });
    expect(h.saved).toEqual([]);
    expect(h.kv.data.size).toBe(0);
  });

  it("保存が既にある(別の経路が先に作った)なら exists で終える。上書きしない", async () => {
    const h = harness();
    h.state.saveResult = "exists";
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const outcomes = await h.drain();
    expect(outcomes.map((o) => (o.kind === "ran" ? `${o.phase}:${o.result}` : o.kind))).toEqual(["read:ok", "generate:ok", "save:exists", "idle"]); // 通知の段階に進まない(送らない)
    expect(h.kv.data.size).toBe(0);
  });
});

describe("最終日の結果と日報を待つ", () => {
  it("最終日に結果が未取込のレースがあれば、読み出さずに間隔を空けて待つ(失敗に数えない)", async () => {
    const h = harness();
    h.state.status = { raceCount: 5, noResultRaceCount: 2, hasDailyReport: true };
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const first = await h.step();
    expect(first).toMatchObject({ kind: "ran", phase: "read", result: "waiting" });
    expect(h.readCalls).toEqual([]);
    expect(h.core.getStatus(MONTH)).toMatchObject({ phase: "read", status: "running", attempts: 0 });
    // 間隔が過ぎるまでは動かない
    expect(await h.step()).toEqual({ kind: "idle" });
    expect(h.alarms[h.alarms.length - 1]).toBe(T_2200 + MONTHLY_WAIT_INTERVAL_MS);
  });

  it("最終日に分析があるのに日報が無い間も待つ。そろったら読み出す", async () => {
    const h = harness();
    h.state.status = { raceCount: 5, noResultRaceCount: 0, hasDailyReport: false };
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(await h.step()).toMatchObject({ result: "waiting" });
    h.clock.t += MONTHLY_WAIT_INTERVAL_MS;
    h.state.status = SETTLED;
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
    expect(h.readCalls).toHaveLength(1);
    expect(h.statusCalls).toHaveLength(2);
  });

  it(`待つのは最大 ${MONTHLY_MAX_WAITS} 回(約 60 分)。それでもそろわなければ、そのまま作り、本文に「最終日は未確定」の印(lastDayPending)を残す`, async () => {
    const h = harness();
    h.state.status = { raceCount: 5, noResultRaceCount: 1, hasDailyReport: false };
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    for (let i = 0; i < MONTHLY_MAX_WAITS; i += 1) {
      expect(await h.step()).toMatchObject({ phase: "read", result: "waiting" });
      h.clock.t += MONTHLY_WAIT_INTERVAL_MS;
    }
    expect(h.readCalls).toEqual([]);
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
    await h.drain();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.body.lastDayPending).toBe(true);
  });

  it("最終日に分析が無い(開催の無い日)なら、日報が無くても待たない", async () => {
    const h = harness();
    h.state.status = { raceCount: 0, noResultRaceCount: 0, hasDailyReport: false };
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
    expect(h.statusCalls).toEqual([LAST_DAY]);
  });

  it("終わって久しい月(最終日の翌日 3:00 以降)の依頼は待たない(状態を問い合わせもしない)", async () => {
    const h = harness({ start: jstMsOf("20261102", 12) });
    h.state.status = { raceCount: 5, noResultRaceCount: 5, hasDailyReport: false }; // 待つ条件を満たしているが、待たない
    await h.core.requestMonthly({ month: MONTH, mode: "catchup" });
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
    expect(h.statusCalls).toEqual([]);
    await h.drain();
    expect(h.saved[0]!.body.lastDayPending).toBe(false);
  });

  it("日付をまたいで(最終日の翌日 0 時台)待ち続けているジョブも、待つ(翌日 3:00 まで)", async () => {
    const h = harness({ start: jstMsOf("20261101", 0, 30) });
    h.state.status = { raceCount: 5, noResultRaceCount: 1, hasDailyReport: true };
    await h.core.requestMonthly({ month: MONTH, mode: "catchup" });
    expect(await h.step()).toMatchObject({ phase: "read", result: "waiting" });
  });

  it("待ちの間の状態の問い合わせが失敗したら、段階の失敗として再試行する(読み出しには進まない)", async () => {
    const h = harness();
    h.state.failStatus = 1;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(await h.step()).toMatchObject({ phase: "read", result: "retry" });
    expect(h.readCalls).toEqual([]);
    h.clock.t += MONTHLY_RETRY_DELAY_MS;
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
  });
});

describe("失敗の扱い", () => {
  it(`読み出しの失敗は ${MONTHLY_RETRY_DELAY_MS / 1000} 秒後に再試行し、${MONTHLY_MAX_STEP_ATTEMPTS} 回で failed(アラームを張らない)。エラーの本文は警告に出さない`, async () => {
    const h = harness();
    h.state.failRead = 99;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const results: string[] = [];
    for (let i = 0; i < MONTHLY_MAX_STEP_ATTEMPTS; i += 1) {
      const o = await h.step();
      results.push(o.kind === "ran" ? o.result : o.kind);
      h.clock.t += MONTHLY_RETRY_DELAY_MS;
    }
    expect(results).toEqual(["retry", "retry", "failed"]);
    expect(h.core.getStatus(MONTH)).toEqual({ phase: "read", status: "failed", attempts: MONTHLY_MAX_STEP_ATTEMPTS });
    expect(await h.step()).toEqual({ kind: "idle" });
    expect(h.warns.length).toBe(MONTHLY_MAX_STEP_ATTEMPTS);
    // 例外の文面は警告に載るが、先頭 200 字に切る(redact 済み)。ここでは警告が月を示すことを固定する
    expect(h.warns.every((w) => w.includes(MONTH))).toBe(true);
  });

  it("保存の失敗は保存だけを再試行し、月の統計は読み直さない(読み出しは 1 回のまま)", async () => {
    const h = harness();
    h.state.failSave = 1;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
    h.clock.t += 1;
    expect(await h.step()).toMatchObject({ phase: "generate", result: "ok" });
    h.clock.t += 1;
    expect(await h.step()).toMatchObject({ phase: "save", result: "retry" });
    h.clock.t += MONTHLY_RETRY_DELAY_MS;
    expect(await h.step()).toMatchObject({ phase: "save", result: "ok" });
    expect(h.readCalls).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
  });
});

describe("再起動をまたいでも続く(状態は kv にある)", () => {
  it("別のコアのインスタンス(DO の再起動)が、同じ kv のジョブを続きから進める", async () => {
    const kv = memoryKv();
    const a = harness({ kv });
    await a.core.requestMonthly({ month: MONTH, mode: "auto" });
    await a.step(); // read まで進めて落ちたとする
    const b = harness({ kv, start: T_2200 + 10 });
    expect(b.core.getStatus(MONTH)).toMatchObject({ phase: "generate", status: "running" });
    expect(await b.step()).toMatchObject({ phase: "generate", result: "ok" });
    expect(await b.step()).toMatchObject({ phase: "save", result: "ok" });
    expect(b.saved).toHaveLength(1);
  });
});

const LABELS = (o: MonthlyStepOutcome[]): string[] => o.map((x) => (x.kind === "ran" ? `${x.phase}:${x.result}` : x.kind));
/** 終わった月(最終日の翌々日の昼)。手動・作り直しの依頼の時刻。 */
const T_NEXT = jstMsOf("20261102", 12);

describe("文章(generate): LLM の呼び出し(Issue #280)", () => {
  it("文章を作り、総括を summary に、構造を body.narrative に残す。モデル・LLM の記録・プロンプトの版も残す。プロンプトは月の確定値の節だけ(各レースのブロックを含まない)", async () => {
    const h = harness({ llm: true });
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.drain();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("2026年10月");
    expect(h.prompts[0]).toContain("## 開催日ごとの成績(確定値)");
    expect(h.prompts[0]).not.toContain("raceId=");
    expect(h.saved).toHaveLength(1);
    const r = h.saved[0]!;
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.summary).toBe("10 月は 3 レースを分析した。");
    expect(r.body.narrative).toEqual({ summary: "10 月は 3 レースを分析した。", good: ["良い点 1"], improve: ["改善点 1"], outlook: ["来月に見ておく数字"] });
    expect(r.body.narrativeRaw).toBeNull();
    expect(r.body.note).toBeNull();
    expect(r.body.promptVersion).toBe(MONTHLY_PROMPT_VERSION);
    const calls = parseLlmCalls(r.llmCallsJson);
    expect(calls).toHaveLength(1);
    expect(calls![0]).toMatchObject({ ok: true, inputTokens: 1000, outputTokens: 300, model: "claude-sonnet-5-5" });
  });

  it("LLM の API キーが無ければ(llm なし)呼ばずに、統計だけの月報を保存する(固定の理由つき)", async () => {
    const h = harness();
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.drain();
    expect(h.prompts).toEqual([]);
    expect(h.saved[0]).toMatchObject({ model: null, summary: null, llmCallsJson: null });
    expect(h.saved[0]!.body).toMatchObject({ narrative: null, narrativeRaw: null, note: MONTHLY_NOTE_NO_KEY });
  });

  it(`LLM の呼び出しの上限は ${MONTHLY_MAX_LLM_ATTEMPTS} 回: 1 回目が失敗しても ${MONTHLY_RETRY_DELAY_MS / 1000} 秒後に 2 回目で成功すれば文章を保存する。失敗は段階の失敗に数えない`, async () => {
    expect(MONTHLY_MAX_LLM_ATTEMPTS).toBe(2);
    const h = harness({ llm: true });
    h.state.llmFailures = 1;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
    h.clock.t += 1;
    expect(await h.step()).toMatchObject({ phase: "generate", result: "retry" });
    expect(h.prompts).toHaveLength(1);
    expect(h.core.getStatus(MONTH)).toEqual({ phase: "generate", status: "running", attempts: 0 }); // LLM の失敗は attempts に数えない
    expect(await h.step()).toEqual({ kind: "idle" }); // 待ち時間のうちは動かない
    h.clock.t += MONTHLY_RETRY_DELAY_MS;
    expect(await h.step()).toMatchObject({ phase: "generate", result: "ok" });
    expect(h.prompts).toHaveLength(2);
    await h.drain();
    const r = h.saved[0]!;
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.body.narrative).not.toBeNull();
    const calls = parseLlmCalls(r.llmCallsJson)!;
    expect(calls.map((c) => c.ok)).toEqual([false, true]); // 失敗した 1 回も記録に残る
  });

  it("2 回とも失敗したら、統計だけの月報を保存する(model は NULL・固定の理由)。呼び出しは 2 回で止まり、エラーの本文は警告に出さない", async () => {
    const h = harness({ llm: true });
    h.state.llmFailures = 99;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.step(); // read
    h.clock.t += 1;
    expect(await h.step()).toMatchObject({ phase: "generate", result: "retry" });
    h.clock.t += MONTHLY_RETRY_DELAY_MS;
    expect(await h.step()).toMatchObject({ phase: "generate", result: "ok" });
    await h.drain();
    expect(h.prompts).toHaveLength(MONTHLY_MAX_LLM_ATTEMPTS);
    const r = h.saved[0]!;
    expect(r).toMatchObject({ model: null, summary: null });
    expect(r.body).toMatchObject({ narrative: null, narrativeRaw: null, note: MONTHLY_NOTE_FAILED });
    expect(parseLlmCalls(r.llmCallsJson)!.map((c) => c.ok)).toEqual([false, false]);
    expect(h.warns.join("\n")).toContain("統計だけの月報にします");
    expect(h.warns.join("\n")).not.toContain("boom");
  });

  it("JSON として読めない応答は再試行せず、生の文章を narrativeRaw に残す(model は応答のもの・総括は先頭の 300 字)", async () => {
    const h = harness({ llm: true });
    h.state.llmText = "今月は" + "あ".repeat(400);
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.drain();
    expect(h.prompts).toHaveLength(1);
    const r = h.saved[0]!;
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.body).toMatchObject({ narrative: null, narrativeRaw: h.state.llmText, note: MONTHLY_NOTE_UNPARSED });
    expect(r.summary).toHaveLength(300);
    expect(h.state.llmText.startsWith(r.summary!.slice(0, 299))).toBe(true);
  });

  it("保存の失敗の再試行で LLM を呼び直さない(応答は成功した直後にジョブへ書く)", async () => {
    const h = harness({ llm: true });
    h.state.failSave = 1;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.step(); // read
    h.clock.t += 1;
    await h.step(); // generate
    h.clock.t += 1;
    expect(await h.step()).toMatchObject({ phase: "save", result: "retry" });
    h.clock.t += MONTHLY_RETRY_DELAY_MS;
    expect(await h.step()).toMatchObject({ phase: "save", result: "ok" });
    expect(h.prompts).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
  });

  describe("モデルは設定の analysisModel に従う(予想と同じ。日報の選び方を流用)", () => {
    const LIST: ModelInfoLite[] = [
      { id: "claude-sonnet-5-5", created_at: "2026-09-01T00:00:00Z" },
      { id: "claude-sonnet-6", created_at: "2026-10-01T00:00:00Z" },
      { id: "claude-opus-4-1", created_at: "2025-08-05T00:00:00Z" },
      { id: "claude-opus-4-7", created_at: "2026-04-01T00:00:00Z" },
    ];
    it.each([
      ["opus を設定したら、一覧の最新の Opus で送る", "opus", "claude-opus-4-7"],
      ["auto を設定したら自動選択(最新の Sonnet)で送る", "auto", "claude-sonnet-6"],
    ] as const)("%s", async (_name, analysisModel, expected) => {
      const h = harness({ llm: true, analysisModel, lister: async () => LIST });
      await h.core.requestMonthly({ month: MONTH, mode: "auto" });
      await h.drain();
      expect(h.models).toEqual([expected]);
    });

    it("モデル一覧を取れない(lister が無い)ときは、固定モデルで送る(月報は止まらない)", async () => {
      const h = harness({ llm: true, analysisModel: "opus" });
      await h.core.requestMonthly({ month: MONTH, mode: "auto" });
      await h.drain();
      expect(h.models).toEqual(["claude-sonnet-5-5"]);
      expect(h.saved).toHaveLength(1);
    });
  });
});

describe("Discord の通知(Issue #280): 送るのは自動の作成(auto・catchup)だけ", () => {
  it("auto: 保存の後に 1 回だけ送る。タイトルは月、説明は総括。基点があれば月報へのリンクを付ける", async () => {
    const h = harness({ llm: true, notifier: true, appBaseUrl: "https://example.com" });
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const outcomes = await h.drain();
    expect(LABELS(outcomes)).toEqual(["read:ok", "generate:ok", "save:ok", "notify:ok", "idle"]);
    expect(h.sent).toHaveLength(1);
    const embed = h.sent[0]!.embeds![0]!;
    expect(embed.title).toBe("月報 2026年10月");
    expect(embed.description).toBe("10 月は 3 レースを分析した。");
    expect((embed as { url?: string }).url).toBe("https://example.com/#report=202610");
    expect(h.kv.data.size).toBe(0);
  });

  it("基点が無ければリンクなしで送る。文章が無い月報(キー未登録)でも、固定の理由を説明にして送る", async () => {
    const h = harness({ notifier: true });
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect("url" in h.sent[0]!.embeds![0]!).toBe(false);
    expect(h.sent[0]!.embeds![0]!.description).toBe(MONTHLY_NOTE_NO_KEY);
  });

  it("catchup(月が明けた後の補完)も送る", async () => {
    const h = harness({ start: jstMsOf("20261101", 23), notifier: true });
    await h.core.requestMonthly({ month: MONTH, mode: "catchup" });
    await h.drain();
    expect(h.sent).toHaveLength(1);
  });

  it("manual(手動の作成)は送らない。通知の段階も通らない", async () => {
    const h = harness({ start: T_NEXT, llm: true, notifier: true });
    await h.core.requestMonthly({ month: MONTH, mode: "manual" });
    const outcomes = await h.drain();
    expect(LABELS(outcomes)).toEqual(["read:ok", "generate:ok", "save:ok", "idle"]);
    expect(h.saved).toHaveLength(1);
    expect(h.sent).toEqual([]);
    expect(h.kv.data.size).toBe(0);
  });

  it("送信が失敗しても再送せず、保存済みの月報を巻き戻さない(警告に失敗の分類だけ・本文は出さない)", async () => {
    const h = harness({ notifier: true });
    h.state.notifyFails = true;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const outcomes = await h.drain();
    expect(LABELS(outcomes)).toEqual(["read:ok", "generate:ok", "save:ok", "notify:failed", "idle"]);
    expect(h.sent).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
    expect(h.kv.data.size).toBe(0);
    expect(h.warns.join("\n")).toContain("Discord");
    expect(h.warns.join("\n")).not.toContain("discord down");
  });

  it("送る前に sending を書く: send が呼ばれた時点でジョブの notify は sending。送信の途中で落ちて引き継がれたジョブは、再送せずに終える", async () => {
    const kv = memoryKv();
    const first = harness({ kv, notifier: true });
    await first.core.requestMonthly({ month: MONTH, mode: "auto" });
    for (let i = 0; i < 3; i += 1) {
      await first.step(); // read, generate, save(通知の前まで)
      first.clock.t += 1;
    }
    const job = kv.get<Record<string, unknown>>(`job:${MONTH}`)!;
    expect(job["phase"]).toBe("notify");
    expect(job["notify"]).toBe("pending"); // 前提(空振り防止): 送る前は pending
    const seen: unknown[] = [];
    const watcher = new MonthlyReportCore({
      kv,
      now: () => first.clock.t,
      setAlarm: () => {},
      onWarn: () => {},
      loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
      source: { lastDayStatus: async () => SETTLED, readMonthStats: async () => first.state.stats },
      store: { hasReport: async () => false, saveReport: async () => "saved", replaceReport: async () => "replaced" },
      notifier: { send: async () => void seen.push(kv.get<Record<string, unknown>>(`job:${MONTH}`)?.["notify"]) },
    });
    await watcher.runNextStep();
    expect(seen).toEqual(["sending"]);

    // 送信の直前に落ちた状態: notify が sending のジョブを別のインスタンスが引き継ぐ
    const kv2 = memoryKv();
    const a = harness({ kv: kv2, notifier: true });
    await a.core.requestMonthly({ month: MONTH, mode: "auto" });
    for (let i = 0; i < 3; i += 1) {
      await a.step();
      a.clock.t += 1;
    }
    const job2 = kv2.get<Record<string, unknown>>(`job:${MONTH}`)!;
    expect(job2["phase"]).toBe("notify");
    kv2.put(`job:${MONTH}`, { ...job2, notify: "sending" });
    const b = harness({ kv: kv2, notifier: true, start: a.clock.t });
    await b.drain();
    expect(b.sent).toHaveLength(0);
    expect(kv2.data.has(`job:${MONTH}`)).toBe(false);
  });
});

describe("手動の作成(manual。Issue #280): 最終日の結果を待たない", () => {
  it("終わった月の手動の作成は、最終日の結果・日報が未取込でも待たずに作る(状態を問い合わせない・lastDayPending は立てない)", async () => {
    const h = harness({ start: jstMsOf("20261101", 1) }); // 最終日の翌日 1 時(自動・補完なら待つ時間帯)
    h.state.status = { raceCount: 5, noResultRaceCount: 5, hasDailyReport: false };
    await h.core.requestMonthly({ month: MONTH, mode: "manual" });
    expect(await h.step()).toMatchObject({ phase: "read", result: "ok" });
    expect(h.statusCalls).toEqual([]);
    await h.drain();
    expect(h.saved[0]!.body.lastDayPending).toBe(false);
  });

  it("月報が既にあれば exists(手動の作成は作り直さない)", async () => {
    const h = harness({ start: T_NEXT });
    h.state.hasReport = true;
    expect(await h.core.requestMonthly({ month: MONTH, mode: "manual" })).toEqual({ accepted: false, reason: "exists" });
    expect(h.kv.data.size).toBe(0);
  });

  it("手動の作成は作り直しの回数を消費しない", async () => {
    const h = harness({ start: T_NEXT });
    await h.core.requestMonthly({ month: MONTH, mode: "manual" });
    await h.drain();
    expect(h.kv.data.has("regen")).toBe(false);
  });
});

describe("作り直し(regenerate。Issue #280): 管理者が押したときだけ", () => {
  const regen = async (h: Harness): Promise<ReturnType<MonthlyReportCore["requestMonthly"]>> => h.core.requestMonthly({ month: MONTH, mode: "regenerate" as MonthlyMode });

  it("終わった月で月報がある場合だけ受理する。月報が無ければ not-exists、まだ終わっていない月は not-ended、作成中は in-progress", async () => {
    const none = harness({ start: T_NEXT });
    expect(await regen(none)).toEqual({ accepted: false, reason: "not-exists" });
    expect(none.kv.data.size).toBe(0);

    const current = harness({ start: T_2200 }); // 最終日の当日(今月の月報は翌日以降に作り直せる)
    current.state.hasReport = true;
    expect(await regen(current)).toEqual({ accepted: false, reason: "not-ended" });
    expect(current.kv.data.size).toBe(0);

    const h = harness({ start: T_NEXT });
    h.state.hasReport = true;
    expect(await regen(h)).toEqual({ accepted: true });
    expect(await regen(h)).toEqual({ accepted: false, reason: "in-progress" });
  });

  it("読み出し → 文章 → 保存(上書き)で確定し、通知の段階を通らない。saveReport(上書きしない保存)は呼ばない。Discord に送らない", async () => {
    const h = harness({ start: T_NEXT, llm: true, notifier: true });
    h.state.hasReport = true;
    await regen(h);
    const outcomes = await h.drain();
    expect(LABELS(outcomes)).toEqual(["read:ok", "generate:ok", "save:ok", "idle"]);
    expect(h.replaced).toHaveLength(1);
    expect(h.saved).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.replaced[0]!.model).toBe("claude-sonnet-5-5");
    expect(h.replaced[0]!.body.narrative).not.toBeNull();
    expect(h.kv.data.has(`job:${MONTH}`)).toBe(false);
  });

  it("作り直しは最終日の結果・日報を待たない(翌日の早朝でも、状態を問い合わせずに作る)", async () => {
    const h = harness({ start: jstMsOf("20261101", 1) });
    h.state.hasReport = true;
    h.state.status = { raceCount: 5, noResultRaceCount: 5, hasDailyReport: false };
    await regen(h);
    await h.drain();
    expect(h.statusCalls).toEqual([]);
    expect(h.replaced).toHaveLength(1);
    expect(h.replaced[0]!.body.lastDayPending).toBe(false);
  });

  it("作り直しのジョブの進行状況には regenerate: true が付く(通常の作成のジョブには付かない)", async () => {
    const h = harness({ start: T_NEXT });
    h.state.hasReport = true;
    await regen(h);
    expect(h.core.getStatus(MONTH)).toEqual({ phase: "read", status: "running", attempts: 0, regenerate: true });
    const normal = harness({ start: T_NEXT });
    await normal.core.requestMonthly({ month: MONTH, mode: "manual" });
    expect(normal.core.getStatus(MONTH)).toEqual({ phase: "read", status: "running", attempts: 0 });
    expect("regenerate" in normal.core.getStatus(MONTH)!).toBe(false);
  });

  it("置き換えを断られた(kept。文章のある前の月報を、文章の無い記録で潰さない)作り直しは、failed のジョブとして残し、アラームを張らない。本文は kv に残さない", async () => {
    const h = harness({ start: T_NEXT, llm: true });
    h.state.hasReport = true;
    h.state.replaceResult = "kept";
    h.state.llmFailures = 99;
    await regen(h);
    await h.step(); // read
    h.clock.t += 1;
    await h.step(); // generate(1 回目の失敗 → 再試行待ち)
    h.clock.t += MONTHLY_RETRY_DELAY_MS;
    await h.step(); // generate(2 回目の失敗 → 統計だけ)
    h.clock.t += 1;
    expect(await h.step()).toMatchObject({ phase: "save", result: "failed" });
    expect(h.replaced).toHaveLength(1); // 置き換えを試みた(DB が kept を返した)
    expect(h.core.getStatus(MONTH)).toEqual({ phase: "save", status: "failed", attempts: 0, regenerate: true });
    expect(h.warns.join("\n")).toContain("文章のある前の月報を残しました");
    const job = h.kv.get<Record<string, unknown>>(`job:${MONTH}`)!;
    expect(job["record"]).toBeNull();
    expect(job["calls"]).toEqual([]);
    expect(job["stats"] ?? null).toBeNull();
    expect(await h.step()).toEqual({ kind: "idle" });
  });

  it("月の分析が無い作り直しも、failed のジョブとして残す(前の月報には触れない)", async () => {
    const h = harness({ start: T_NEXT });
    h.state.hasReport = true;
    h.state.stats = buildMonthStats({ races: [], bets: [], marks: [], results: [], combos: [], imports: [] }, { fromDate: "20261001", toDate: LAST_DAY });
    await regen(h);
    expect(await h.step()).toMatchObject({ phase: "read", result: "no-analyses" });
    expect(h.replaced).toEqual([]);
    expect(h.core.getStatus(MONTH)).toMatchObject({ status: "failed", regenerate: true });
  });

  it("失敗した作り直しのジョブは、再度の作り直しを妨げない(in-progress は running のときだけ)", async () => {
    const h = harness({ start: T_NEXT });
    h.state.hasReport = true;
    h.state.replaceResult = "kept";
    await regen(h);
    await h.drain();
    expect(h.core.getStatus(MONTH)).toMatchObject({ status: "failed" });
    h.state.replaceResult = "replaced";
    expect(await regen(h)).toEqual({ accepted: true });
  });

  describe(`1 日(JST)に受理できる回数は全体で ${MONTHLY_REGEN_DAILY_LIMIT} 回(日報とは別枠)`, () => {
    it(`${MONTHLY_REGEN_DAILY_LIMIT} 回まで受理し、次は daily-limit。日付が変われば(JST)また受理する`, async () => {
      expect(MONTHLY_REGEN_DAILY_LIMIT).toBe(3);
      const h = harness({ start: T_NEXT });
      h.state.hasReport = true;
      for (let i = 0; i < MONTHLY_REGEN_DAILY_LIMIT; i += 1) {
        expect(await regen(h), `${i + 1} 回目`).toEqual({ accepted: true });
        await h.drain();
        expect(h.kv.data.has(`job:${MONTH}`)).toBe(false);
      }
      expect(h.replaced).toHaveLength(MONTHLY_REGEN_DAILY_LIMIT);
      expect(await regen(h)).toEqual({ accepted: false, reason: "daily-limit" });
      expect(h.kv.data.has(`job:${MONTH}`)).toBe(false); // 断った依頼はジョブを作らない
      h.clock.t += 24 * 3_600_000; // 翌日
      expect(await regen(h)).toEqual({ accepted: true });
    });

    it("受理したときだけ数える: 月報が無い・進行中で断った依頼は数えない。LLM が失敗した作り直しも返さない", async () => {
      const h = harness({ start: T_NEXT, llm: true });
      expect(await regen(h)).toEqual({ accepted: false, reason: "not-exists" });
      expect(h.kv.data.has("regen")).toBe(false);
      h.state.hasReport = true;
      expect(await regen(h)).toEqual({ accepted: true });
      expect(await regen(h)).toEqual({ accepted: false, reason: "in-progress" });
      expect(h.kv.get<{ count: number }>("regen")!.count).toBe(1);
      h.state.llmFailures = 99; // 失敗した作り直し
      await h.step(); // read
      h.clock.t += 1;
      await h.step(); // generate(失敗 1)
      h.clock.t += MONTHLY_RETRY_DELAY_MS;
      await h.step(); // generate(失敗 2 → 統計だけ)
      await h.drain();
      expect(h.kv.get<{ count: number }>("regen")!.count).toBe(1); // 返さない
    });

    it("回数の記録は月報の DO の kv の `regen`(日報の DO とは別の kv = 別枠)。日付が変わっていれば数え直す", async () => {
      const h = harness({ start: T_NEXT });
      h.state.hasReport = true;
      await regen(h);
      expect(h.kv.get<{ day: string; count: number }>("regen")).toEqual({ day: "20261102", count: 1 });
    });
  });
});

describe("Issue #446(H-5): ジョブ機構の確認(削除した特性テストから移した。時間・回数・件数は定数を参照せず、値で固定する)", () => {
  const ran = (phase: string, result: string) => ({ kind: "ran", month: MONTH, phase, result });
  const PENDING = { raceCount: 5, noResultRaceCount: 1, hasDailyReport: false } as const;

  it("最終日の結果を待つのは 10 分(600,000 ms)間隔で最大 6 回。7 回目は待たずに作り、lastDayPending を立て、Discord の注記に出す", async () => {
    const h = harness({ notifier: true });
    h.state.status = PENDING;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const t0 = h.clock.t;
    for (let i = 1; i <= 6; i += 1) {
      h.clock.t = t0 + (i - 1) * 600_000;
      expect(await h.step()).toEqual(ran("read", "waiting"));
      expect(h.alarms[h.alarms.length - 1]).toBe(t0 + i * 600_000);
      h.clock.t = t0 + i * 600_000 - 1;
      expect(await h.step()).toEqual({ kind: "idle" }); // 間隔の 1 ms 前は動かない
    }
    expect(h.readCalls).toEqual([]);
    h.clock.t = t0 + 6 * 600_000;
    expect(await h.step()).toEqual(ran("read", "ok")); // 7 回目は待たない
    expect(h.statusCalls).toHaveLength(7);
    await h.drain();
    expect(h.saved[0]!.body.lastDayPending).toBe(true);
    const fields = (h.sent[0]!.embeds![0] as { fields?: Array<{ name: string; value: string }> }).fields!;
    expect(fields.map((f) => f.name)).toContain("注記"); // 最終日が未確定の印は Discord にも出る
  });

  it.each([
    { name: "最終日の翌日 2:00(待つ窓の中)", now: jstMsOf("20261101", 2), waits: true },
    { name: "最終日の翌日 2:59:59.999(窓の終わりの 1 ms 前)", now: jstMsOf("20261101", 3) - 1, waits: true },
    { name: "最終日の翌日 3:00:00.000(窓の外)", now: jstMsOf("20261101", 3), waits: false },
    { name: "最終日の翌々日 2:00(窓の外。翌日 3:00 を過ぎている)", now: jstMsOf("20261102", 2), waits: false },
  ])("自動の作成で、最終日の結果が未取込のとき: $name は、待つ=$waits", async ({ now, waits }) => {
    const h = harness({ start: now });
    h.state.status = PENDING;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(await h.step()).toEqual(ran("read", waits ? "waiting" : "ok"));
    expect(h.statusCalls).toEqual(waits ? [LAST_DAY] : []);
  });

  it("段階の失敗は 60 秒(60,000 ms)後に再試行し、3 回目の失敗で failed(アラームを張らない)", async () => {
    const h = harness();
    h.state.failRead = 99;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    const t = h.clock.t;
    expect(await h.step()).toEqual(ran("read", "retry"));
    expect(h.alarms[h.alarms.length - 1]).toBe(t + 60_000); // 段階を終えた直後に、次の時刻へアラームを張る
    h.clock.t = t + 59_999;
    expect(await h.step()).toEqual({ kind: "idle" });
    h.clock.t = t + 60_000;
    expect(await h.step()).toEqual(ran("read", "retry"));
    expect(h.alarms[h.alarms.length - 1]).toBe(t + 120_000);
    h.clock.t = t + 120_000;
    const alarmsBefore = h.alarms.length;
    expect(await h.step()).toEqual(ran("read", "failed"));
    expect(h.core.getStatus(MONTH)).toEqual({ phase: "read", status: "failed", attempts: 3 });
    expect(h.alarms).toHaveLength(alarmsBefore);
  });

  it("LLM の失敗は 60 秒(60,000 ms)後に再試行する。LLM に送る max_tokens は 12,000。プロンプトは buildMonthlyPrompt の出力そのもの", async () => {
    const h = harness({ llm: true });
    h.state.llmFailures = 1;
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.step(); // read
    const t = h.clock.t;
    expect(await h.step()).toEqual(ran("generate", "retry"));
    expect(h.alarms[h.alarms.length - 1]).toBe(t + 60_000);
    h.clock.t = t + 59_999;
    expect(await h.step()).toEqual({ kind: "idle" });
    h.clock.t = t + 60_000;
    expect(await h.step()).toEqual(ran("generate", "ok"));
    expect(h.maxTokens).toEqual([12_000, 12_000]);
    const expected = buildMonthlyPrompt({ month: MONTH, stats: h.state.stats, lastDayPending: false });
    expect(h.prompts).toEqual([expected, expected]);
  });

  it("Discord に送る payload は embeds だけで、embed は 1 件", async () => {
    const h = harness({ notifier: true });
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect(Object.keys(h.sent[0]!)).toEqual(["embeds"]);
    expect(h.sent[0]!.embeds).toHaveLength(1);
  });

  it("保存の失敗の後に成功して通知の段階へ進むと、失敗の回数は 0 に戻る", async () => {
    const h = harness({ notifier: true });
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    await h.step(); // read
    await h.step(); // generate
    h.state.failSave = 1;
    expect(await h.step()).toEqual(ran("save", "retry"));
    expect(h.core.getStatus(MONTH)).toEqual({ phase: "save", status: "running", attempts: 1 });
    h.clock.t += 60_000;
    expect(await h.step()).toEqual(ran("save", "ok"));
    expect(h.core.getStatus(MONTH)).toEqual({ phase: "notify", status: "running", attempts: 0 });
  });

  it("段階を1つ終えた直後に、次のジョブの時刻へアラームを張る(次の起床を待たずに)", async () => {
    const h = harness();
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(h.alarms).toEqual([T_2200]); // 依頼の直後
    expect(await h.step()).toEqual(ran("read", "ok"));
    expect(h.alarms).toEqual([T_2200, T_2200]); // 段階を終えた直後(次の段階は今)
  });

  it("再起動(新しいインスタンス)で、期限がまだ来ていないジョブだけがあるときの空の起床は、そのジョブの時刻にアラームを張り直す", async () => {
    const kv = memoryKv();
    const first = harness({ kv });
    first.state.status = PENDING;
    await first.core.requestMonthly({ month: MONTH, mode: "auto" });
    await first.step(); // 待ちに入る(次の時刻は 10 分後)
    const t = first.clock.t;
    const second = harness({ kv, start: t });
    expect(second.alarms).toEqual([]);
    expect(await second.step()).toEqual({ kind: "idle" });
    expect(second.alarms).toEqual([t + 600_000]);
  });

  it("進行中の月の依頼は、作成済みかどうか(D1)を引かずに断る", async () => {
    const h = harness();
    await h.core.requestMonthly({ month: MONTH, mode: "auto" });
    expect(h.state.hasReportCalls).toBe(1);
    expect(await h.core.requestMonthly({ month: MONTH, mode: "auto" })).toEqual({ accepted: false, reason: "in-progress" });
    expect(h.state.hasReportCalls).toBe(1); // 増えない
  });
});
