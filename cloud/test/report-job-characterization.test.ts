import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MessageSender, ModelInfoLite } from "@keiba/core/llm";
import { DailyReportCore, type DailyReportDeps, type ReportMode } from "../src/daily-report-core";
import { MonthlyReportCore, type MonthlyMode, type MonthlyReportDeps } from "../src/monthly-report-core";
import { jstMsOf } from "../src/monthly-month";
import { buildMonthStats, type MonthStats } from "../src/monthly-stats";
import type { PeriodRows } from "../src/period-stats";
import { DEFAULT_CLOUD_SETTINGS, type AnalysisModelId } from "../src/settings";
import type { DiscordPayload } from "../../packages/core/src/notify/discord";
import { fixtureNarrativeText, fixturePriorStats, fixtureRaceInputs, FIXTURE_DATE } from "./daily-report-fixtures";

/**
 * Issue #399(#390 R-8): 日報(`DailyReportCore`)と月報(`MonthlyReportCore`)の**ジョブ機構の特性テスト**。
 * 共通化(ジョブの保管・失敗の包み・LLM の試行・文章の解決)の前後で、外から見える振る舞いが 1 行も変わらないことを固定する。
 *
 * 方法: 外への口(kv・アラーム・警告・D1 の読み書き・LLM・Discord)を偽物にして、**起きたことを時系列の 1 本の記録**(trace)にし、場面ごとに全文を固定する。期待値は**共通化の前のコードの実出力**
 * (このテストを書いた時点で旧コードに対して緑にしたもの)。**`-u` で期待値を更新しない**(更新すると回帰が静かに通る)。
 *  - kv は `structuredClone` で複製する(実 DO の `ctx.storage.kv` と同じ。`undefined` のキーも残る)。既存の core テストの kv は JSON 往復なので、`undefined` のキーが増えても気づけない。
 *    ジョブを書くたびに、**ジョブのキー集合**(永続化される形)を、最初の書き込みは全部・以降は増減の差で記録する。
 *  - ジョブの書き込みは「段階 状態 試行 次の時刻」と、段階が持つ項目の要約で出す(`proj`)。時刻はテストの基準時刻からの差(ミリ秒)。
 *  - LLM の呼び出し・保存する記録・Discord への送信は、内容の指紋(JSON の sha1 の先頭 8 桁)と、その時点で kv に永続化されている状態(試行の数・`sending`)を出す。
 *    プロンプトの文面・記録の本文・embed の中身は、指紋で 1 文字も変わらないことを固定する(中身そのものの検査は既存の core・prompt・embed のテスト)。
 */

// ---- 記録 ----

const fp = (value: unknown): string => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 8);

class Rec {
  readonly lines: string[] = [];
  private readonly prevKeys = new Map<string, string[]>();
  constructor(readonly base: number, readonly clock: { t: number }) {}
  log(line: string): void {
    this.lines.push(line);
  }
  off(t: number): string {
    return `+${t - this.base}`;
  }
  /** ジョブの要約。段階が持たない項目(キーそのものが無いもの)は出さない。 */
  proj(job: Record<string, unknown>): string {
    const parts = [`${String(job.phase)} ${String(job.status)} a${String(job.attempts)} n${this.off(job.nextAt as number)}`];
    if ("waits" in job) parts.push(`w${String(job.waits)}`);
    if ("items" in job) parts.push(`i${(job.items as unknown[]).length} c${String(job.cursor)} d${(job.digests as unknown[]).length}`);
    if ("stats" in job) parts.push(`s:${job.stats === null ? "-" : "set"}`);
    if ("lastDayPending" in job) parts.push(`pend:${String(job.lastDayPending)}`);
    parts.push(`L${String(job.llmAttempts)}${job.llmGaveUp === true ? "G" : ""} t:${job.llmText === null ? "-" : "set"} m:${String(job.llmModel)} calls${(job.calls as unknown[]).length}`);
    parts.push(`rec:${job.record === null ? "-" : "set"} nt:${String(job.notify)}`);
    if ("rolling" in job) parts.push(`roll:${job.rolling === null ? "null" : job.rolling === undefined ? "undef" : "set"}`);
    return parts.join(" ");
  }
  kvPut(key: string, value: unknown): void {
    if (key.startsWith("job:")) {
      const job = value as Record<string, unknown>;
      const keys = Object.keys(job).sort();
      const prev = this.prevKeys.get(key);
      let delta: string;
      if (prev === undefined) {
        delta = `keys=[${keys.join(",")}] mode=${String(job.mode)}`;
      } else {
        const add = keys.filter((k) => !prev.includes(k));
        const del = prev.filter((k) => !keys.includes(k));
        delta = [...add.map((k) => `+${k}`), ...del.map((k) => `-${k}`)].join(" ");
      }
      this.prevKeys.set(key, keys);
      this.log(`kv.put ${key} ${this.proj(job)}${delta === "" ? "" : ` ${delta}`}`);
    } else if (key === "regen") {
      const q = value as { day: string; count: number };
      this.log(`kv.put regen ${q.day}/${q.count}`);
    } else {
      this.log(`kv.put ${key} ${JSON.stringify(value)}`);
    }
  }
  kvDelete(key: string): void {
    this.prevKeys.delete(key);
    this.log(`kv.delete ${key}`);
  }
}

function tracedKv(rec: Rec, store: Map<string, unknown>) {
  return {
    get: <T>(key: string): T | undefined => (store.has(key) ? (structuredClone(store.get(key)) as T) : undefined),
    put: (key: string, value: unknown): void => {
      store.set(key, structuredClone(value));
      rec.kvPut(key, store.get(key));
    },
    delete: (key: string): void => {
      store.delete(key);
      rec.kvDelete(key);
    },
  };
}

/** kv に今あるジョブの `llmAttempts`(LLM の呼び出しの最中に、永続化済みの試行の数を覗く)。ジョブが無ければ `none`。 */
function persistedAttempts(store: Map<string, unknown>): string {
  for (const [key, value] of store) {
    if (key.startsWith("job:")) return String((value as { llmAttempts: number }).llmAttempts);
  }
  return "none";
}
function persistedNotify(store: Map<string, unknown>): string {
  for (const [key, value] of store) {
    if (key.startsWith("job:")) return String((value as { notify: string }).notify);
  }
  return "none";
}

const text = (rec: Rec): string => rec.lines.join("\n");

/** モデル一覧(偽)。固定モデル(claude-sonnet-5-5)より新しい Sonnet を含め、自動選択と固定を区別できるようにする。 */
const MODEL_LIST: ModelInfoLite[] = [
  { id: "claude-sonnet-5-5", created_at: "2026-09-01T00:00:00Z" },
  { id: "claude-sonnet-6", created_at: "2026-10-01T00:00:00Z" },
  { id: "claude-opus-4-7", created_at: "2026-04-01T00:00:00Z" },
  { id: "claude-haiku-4-8", created_at: "2026-06-01T00:00:00Z" },
];

// ---- 日報 ----

const D0 = Date.parse("2026-10-10T11:00:00.000Z"); // JST 20:00(開催日 20261010 の夜)
const DATE = FIXTURE_DATE;

interface DailyOptions {
  readonly llm?: boolean;
  readonly notifier?: boolean;
  readonly refs?: number;
  readonly appBaseUrl?: string;
  readonly start?: number;
  readonly lister?: boolean;
  readonly analysisModel?: AnalysisModelId;
}

function dailyHarness(options: DailyOptions = {}) {
  const clock = { t: options.start ?? D0 };
  const rec = new Rec(D0, clock);
  const store = new Map<string, unknown>();
  const kv = tracedKv(rec, store);
  const inputs = fixtureRaceInputs();
  const state = {
    failList: 0,
    failRead: 0,
    failPeriod: 0,
    failSave: 0,
    failReplace: 0,
    hasReport: false,
    saveResult: "saved" as "saved" | "exists",
    replaceResult: "replaced" as "replaced" | "kept",
    emptyList: false,
    allMissing: false,
    llmFailures: 0,
    llmText: fixtureNarrativeText(),
    notifyFails: false,
    failSettings: false,
    listError: "D1 が落ちた(一覧) sk-ant-SECRETKEY123456",
  };
  const refs = Array.from({ length: options.refs ?? 3 }, (_, i) => (i < inputs.length ? { raceId: inputs[i]!.view.raceId, analysisId: inputs[i]!.view.id } : { raceId: `20260503089${i}`, analysisId: 900 + i }));
  const sender: MessageSender = async (params) => {
    rec.log(`llm.send persistedL=${persistedAttempts(store)} prompt=${fp(params.messages[0]!.content)} model=${params.model} maxTokens=${params.max_tokens}`);
    if (state.llmFailures > 0) {
      state.llmFailures -= 1;
      throw Object.assign(new Error("boom"), { status: 529 });
    }
    return { content: [{ type: "text", text: state.llmText }], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 300 } };
  };
  const deps: DailyReportDeps = {
    kv,
    now: () => clock.t,
    setAlarm: (at) => void rec.log(`alarm ${rec.off(at)}`),
    onWarn: (m) => void rec.log(`warn ${m}`),
    source: {
      listDayAnalyses: async (date) => {
        rec.log(`src.list ${date}`);
        if (state.failList > 0) {
          state.failList -= 1;
          throw new Error(state.listError);
        }
        return state.emptyList ? [] : refs;
      },
      readRaces: async (items) => {
        rec.log(`src.read ${items.length}`);
        if (state.failRead > 0) {
          state.failRead -= 1;
          throw new Error("D1 が落ちた(読み出し)");
        }
        return items.map((i) => (state.allMissing ? null : (inputs.find((x) => x.view.id === i.analysisId) ?? null)));
      },
      readPeriodStats: async (from, to) => {
        rec.log(`src.period ${from}..${to}`);
        if (state.failPeriod > 0) {
          state.failPeriod -= 1;
          throw new Error("D1 が落ちた(期間)");
        }
        return { ...fixturePriorStats(), fromDate: from, toDate: to };
      },
    },
    store: {
      hasReport: async (date) => {
        rec.log(`store.has ${date}`);
        return state.hasReport;
      },
      saveReport: async (record) => {
        rec.log(`store.save ${record.kaisaiDate} model=${String(record.model)} races=${record.raceCount} summary=${String(record.summary)?.slice(0, 20)} record=${fp(record)}`);
        if (state.failSave > 0) {
          state.failSave -= 1;
          throw new Error("D1 書き込み失敗");
        }
        return state.saveResult;
      },
      replaceReport: async (record) => {
        rec.log(`store.replace ${record.kaisaiDate} model=${String(record.model)} races=${record.raceCount} record=${fp(record)}`);
        if (state.failReplace > 0) {
          state.failReplace -= 1;
          throw new Error("D1 書き込み失敗(上書き)");
        }
        return state.replaceResult;
      },
    },
    loadSettings: async () => {
      if (state.failSettings) throw new Error("settings down sk-ant-SECRETKEY123456");
      return { ...DEFAULT_CLOUD_SETTINGS, analysisModel: options.analysisModel ?? DEFAULT_CLOUD_SETTINGS.analysisModel };
    },
    ...(options.llm === false ? {} : { llm: { sender, ...(options.lister === true ? { lister: async () => MODEL_LIST } : {}) } }),
    ...(options.notifier === false
      ? {}
      : {
          notifier: {
            send: async (payload: DiscordPayload) => {
              rec.log(`discord.send persistedNt=${persistedNotify(store)} embed=${fp(payload)}`);
              if (state.notifyFails) throw new Error("discord down");
            },
          },
        }),
    ...(options.appBaseUrl === undefined ? {} : { appBaseUrl: options.appBaseUrl }),
  };
  const core = new DailyReportCore(deps);
  return {
    rec,
    store,
    state,
    clock,
    core,
    async request(mode: ReportMode, date: string = DATE): Promise<void> {
      const r = await core.requestReport({ kaisaiDate: date, mode });
      rec.log(`request ${date} ${mode} -> ${r.accepted ? "accepted" : r.reason}`);
    },
    async step(): Promise<void> {
      const o = await core.runNextStep();
      rec.log(o.kind === "idle" ? "step idle" : `step ${o.kaisaiDate} ${o.phase} ${o.result}`);
    },
    advance(ms: number): void {
      clock.t += ms;
      rec.log(`clock ${rec.off(clock.t)}`);
    },
    /** 動かせるジョブが無くなるまで進める。idle でジョブが残っていれば `idleAdvance` だけ時計を進める。 */
    async settle(idleAdvance = 60_000, max = 60): Promise<void> {
      for (let i = 0; i < max; i += 1) {
        await this.step();
        if (rec.lines[rec.lines.length - 1] === "step idle") {
          if (!store.has("jobs")) return;
          this.advance(idleAdvance);
        } else {
          clock.t += 1000;
          rec.log(`clock ${rec.off(clock.t)}`);
        }
      }
      throw new Error("settle が終わらない");
    },
    status(date: string = DATE): void {
      rec.log(`status ${date} ${JSON.stringify(core.getStatus(date))}`);
    },
  };
}

// ---- 月報 ----

const MONTH = "202610";
const LAST_DAY = "20261031";
const M0 = jstMsOf(LAST_DAY, 22); // 最終日の 22:00
const M_NEXT = jstMsOf("20261102", 12); // 終わった月(手動・作り直しの対象)

function monthRows(): PeriodRows {
  return {
    races: [
      { analysisId: 1, raceId: "202605030801", kaisaiDate: "20261003", model: "m", promptVersion: "v1" },
      { analysisId: 3, raceId: "202605031001", kaisaiDate: LAST_DAY, model: "m", promptVersion: "v1" },
    ],
    bets: [{ analysisId: 1, betType: "win", comboKey: "01", stake: 200, odds: 4, ev: 1.2 }],
    marks: [{ analysisId: 1, umaban: 1, mark: "◎" }],
    results: [
      { raceId: "202605030801", umaban: 1, finishPosition: 1, winPayout: 400, placePayout: 150 },
      { raceId: "202605031001", umaban: 2, finishPosition: 1, winPayout: 500, placePayout: 150 },
    ],
    combos: [],
    imports: [],
  };
}
const monthStats = (): MonthStats => buildMonthStats(monthRows(), { fromDate: "20261001", toDate: LAST_DAY });
const emptyMonthStats = (): MonthStats => buildMonthStats({ races: [], bets: [], marks: [], results: [], combos: [], imports: [] }, { fromDate: "20261001", toDate: LAST_DAY });
const MONTH_NARRATIVE = (): string => JSON.stringify({ summary: "10 月は 2 レースを分析した。", good: ["良い点 1"], improve: ["改善点 1"], outlook: ["来月に見ておく数字"] });

interface MonthlyOptions {
  readonly llm?: boolean;
  readonly notifier?: boolean;
  readonly appBaseUrl?: string;
  readonly start?: number;
  readonly lister?: boolean;
  readonly analysisModel?: AnalysisModelId;
}

function monthlyHarness(options: MonthlyOptions = {}) {
  const clock = { t: options.start ?? M0 };
  const rec = new Rec(M0, clock);
  const store = new Map<string, unknown>();
  const kv = tracedKv(rec, store);
  const state = {
    status: { raceCount: 1, noResultRaceCount: 0, hasDailyReport: true },
    stats: monthStats(),
    failStatus: 0,
    failRead: 0,
    failSave: 0,
    hasReport: false,
    saveResult: "saved" as "saved" | "exists",
    replaceResult: "replaced" as "replaced" | "kept",
    llmFailures: 0,
    llmText: MONTH_NARRATIVE(),
    notifyFails: false,
    failSettings: false,
    readError: "D1 の詳細(月)",
  };
  const sender: MessageSender = async (params) => {
    rec.log(`llm.send persistedL=${persistedAttempts(store)} prompt=${fp(params.messages[0]!.content)} model=${params.model} maxTokens=${params.max_tokens}`);
    if (state.llmFailures > 0) {
      state.llmFailures -= 1;
      throw Object.assign(new Error("boom"), { status: 529 });
    }
    return { content: [{ type: "text", text: state.llmText }], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 300 } };
  };
  const deps: MonthlyReportDeps = {
    kv,
    now: () => clock.t,
    setAlarm: (at) => void rec.log(`alarm ${rec.off(at)}`),
    onWarn: (m) => void rec.log(`warn ${m}`),
    source: {
      lastDayStatus: async (date) => {
        rec.log(`src.status ${date}`);
        if (state.failStatus > 0) {
          state.failStatus -= 1;
          throw new Error("D1 の詳細 sk-ant-SECRETKEY123456");
        }
        return state.status;
      },
      readMonthStats: async (from, to) => {
        rec.log(`src.month ${from}..${to}`);
        if (state.failRead > 0) {
          state.failRead -= 1;
          throw new Error(state.readError);
        }
        return state.stats;
      },
    },
    store: {
      hasReport: async (month) => {
        rec.log(`store.has ${month}`);
        return state.hasReport;
      },
      saveReport: async (record) => {
        rec.log(`store.save ${record.month} model=${String(record.model)} races=${record.raceCount} summary=${String(record.summary)?.slice(0, 20)} record=${fp(record)}`);
        if (state.failSave > 0) {
          state.failSave -= 1;
          throw new Error("D1 書き込み失敗");
        }
        return state.saveResult;
      },
      replaceReport: async (record) => {
        rec.log(`store.replace ${record.month} model=${String(record.model)} races=${record.raceCount} record=${fp(record)}`);
        return state.replaceResult;
      },
    },
    loadSettings: async () => {
      if (state.failSettings) throw new Error("settings down sk-ant-SECRETKEY123456");
      return { ...DEFAULT_CLOUD_SETTINGS, analysisModel: options.analysisModel ?? DEFAULT_CLOUD_SETTINGS.analysisModel };
    },
    ...(options.llm === true ? { llm: { sender, ...(options.lister === true ? { lister: async () => MODEL_LIST } : {}) } } : {}),
    ...(options.notifier === true
      ? {
          notifier: {
            send: async (payload: DiscordPayload) => {
              rec.log(`discord.send persistedNt=${persistedNotify(store)} embed=${fp(payload)}`);
              if (state.notifyFails) throw new Error("discord down");
            },
          },
        }
      : {}),
    ...(options.appBaseUrl === undefined ? {} : { appBaseUrl: options.appBaseUrl }),
  };
  const core = new MonthlyReportCore(deps);
  return {
    rec,
    store,
    state,
    clock,
    core,
    async request(mode: MonthlyMode, extra: { startAt?: number; month?: string } = {}): Promise<void> {
      const month = extra.month ?? MONTH;
      const r = await core.requestMonthly({ month, mode, ...(extra.startAt === undefined ? {} : { startAt: extra.startAt }) });
      rec.log(`request ${month} ${mode}${extra.startAt === undefined ? "" : ` startAt${rec.off(extra.startAt)}`} -> ${r.accepted ? "accepted" : r.reason}`);
    },
    async step(): Promise<void> {
      const o = await core.runNextStep();
      rec.log(o.kind === "idle" ? "step idle" : `step ${o.month} ${o.phase} ${o.result}`);
    },
    advance(ms: number): void {
      clock.t += ms;
      rec.log(`clock ${rec.off(clock.t)}`);
    },
    async settle(idleAdvance = 60_000, max = 60): Promise<void> {
      for (let i = 0; i < max; i += 1) {
        await this.step();
        if (rec.lines[rec.lines.length - 1] === "step idle") {
          if (!store.has("jobs")) return;
          this.advance(idleAdvance);
        } else {
          clock.t += 1000;
          rec.log(`clock ${rec.off(clock.t)}`);
        }
      }
      throw new Error("settle が終わらない");
    },
    status(month: string = MONTH): void {
      rec.log(`status ${month} ${JSON.stringify(core.getStatus(month))}`);
    },
  };
}

// ============================================================================
// 日報
// ============================================================================

describe("日報のジョブ機構(特性テスト。共通化の前後で記録が 1 文字も変わらない)", () => {
  it("D1 正常: 9 件の一覧(読めるのは 3 件)を 8 件 + 1 件の 2 回に分けて収集し、rolling を読み、LLM 1 回・保存 1 回・通知 1 回で確定する(キー集合・書き込みの順・アラーム)", async () => {
    const h = dailyHarness({ refs: 9, appBaseUrl: "https://example.test" });
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i9 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 8
      kv.put job:20261010 gather running a0 n+1000 i9 c8 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.read 1
      kv.put job:20261010 generate running a0 n+2000 i9 c9 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +2000
      step 20261010 gather ok
      clock +3000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+2000 i9 c9 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+2000 i9 c9 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+2000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+3000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 generate ok
      clock +4000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=3a74f8ad
      kv.put job:20261010 notify running a0 n+4000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +4000
      step 20261010 save ok
      clock +5000
      kv.put job:20261010 notify running a0 n+4000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=92087f22
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +6000
      step idle"
    `);
  });

  it("D2a 段階の失敗(一覧): 60 秒ごとに 2 回再試行し、3 回目で failed(索引から外れ、アラームを張らない)。エラー本文のキーは伏せる。再依頼で最初からやり直せる", async () => {
    const h = dailyHarness();
    h.state.failList = 3;
    await h.request("auto");
    await h.settle();
    h.status();
    h.state.failList = 0;
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      warn 日報(20261010): list に失敗しました(試行 1 回): D1 が落ちた(一覧) sk-ant-***
      kv.put job:20261010 list running a1 n+60000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +60000
      step 20261010 list retry
      clock +1000
      alarm +60000
      step idle
      clock +61000
      src.list 20261010
      warn 日報(20261010): list に失敗しました(試行 2 回): D1 が落ちた(一覧) sk-ant-***
      kv.put job:20261010 list running a2 n+121000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +121000
      step 20261010 list retry
      clock +62000
      alarm +121000
      step idle
      clock +122000
      src.list 20261010
      warn 日報(20261010): list に失敗しました(試行 3 回): D1 が落ちた(一覧) sk-ant-***
      kv.put job:20261010 list failed a3 n+121000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      kv.delete jobs
      step 20261010 list failed
      clock +123000
      step idle
      status 20261010 {"phase":"list","status":"failed","attempts":3}
      store.has 20261010
      kv.put job:20261010 list running a0 n+123000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      kv.put jobs ["20261010"]
      alarm +123000
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+123000 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +123000
      step 20261010 list ok
      clock +124000
      src.read 3
      kv.put job:20261010 generate running a0 n+124000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +124000
      step 20261010 gather ok
      clock +125000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+124000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+124000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+124000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+125000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +125000
      step 20261010 generate ok
      clock +126000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=60a176f0
      kv.put job:20261010 notify running a0 n+126000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +126000
      step 20261010 save ok
      clock +127000
      kv.put job:20261010 notify running a0 n+126000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +128000
      step idle"
    `);
  });

  it("D2b 収集の失敗 1 回は再試行して続きから進む(収集済みの分は読み直さない)", async () => {
    const h = dailyHarness({ refs: 9 });
    h.state.failRead = 1;
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i9 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 8
      warn 日報(20261010): gather に失敗しました(試行 1 回): D1 が落ちた(読み出し)
      kv.put job:20261010 gather running a1 n+61000 i9 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +61000
      step 20261010 gather retry
      clock +2000
      alarm +61000
      step idle
      clock +62000
      src.read 8
      kv.put job:20261010 gather running a0 n+62000 i9 c8 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +62000
      step 20261010 gather ok
      clock +63000
      src.read 1
      kv.put job:20261010 generate running a0 n+63000 i9 c9 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +63000
      step 20261010 gather ok
      clock +64000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+63000 i9 c9 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+63000 i9 c9 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+63000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+64000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +64000
      step 20261010 generate ok
      clock +65000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=b57ccda5
      kv.put job:20261010 notify running a0 n+65000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +65000
      step 20261010 save ok
      clock +66000
      kv.put job:20261010 notify running a0 n+65000 i9 c9 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +67000
      step idle"
    `);
  });

  it("D2c 期間の再集計の失敗 1 回は generate の再試行になり、LLM はまだ呼ばれていない。成功後は rolling を永続化し、LLM の失敗の再試行では読み直さない", async () => {
    const h = dailyHarness();
    h.state.failPeriod = 1;
    h.state.llmFailures = 1;
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      warn 日報(20261010): generate に失敗しました(試行 1 回): D1 が落ちた(期間)
      kv.put job:20261010 generate running a1 n+62000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +62000
      step 20261010 generate retry
      clock +3000
      alarm +62000
      step idle
      clock +63000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a1 n+62000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a1 n+62000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      warn LLM の呼び出しに失敗しました(status=529)
      warn 日報(20261010): LLM の呼び出しに失敗しました(status=529。試行 1 回)
      kv.put job:20261010 generate running a1 n+123000 i3 c3 d3 L1 t:- m:null calls1 rec:- nt:pending roll:set
      alarm +123000
      step 20261010 generate retry
      clock +64000
      alarm +123000
      step idle
      clock +124000
      kv.put job:20261010 generate running a1 n+123000 i3 c3 d3 L2 t:- m:null calls1 rec:- nt:pending roll:set
      llm.send persistedL=2 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a1 n+123000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+124000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:pending roll:set
      alarm +124000
      step 20261010 generate ok
      clock +125000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=3cb51b01
      kv.put job:20261010 notify running a0 n+125000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:pending roll:set
      alarm +125000
      step 20261010 save ok
      clock +126000
      kv.put job:20261010 notify running a0 n+125000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +127000
      step idle"
    `);
  });

  it("D2d 保存の失敗は保存だけを再試行する。LLM を呼び直さない(応答を永続化済み)。保存した記録の指紋は再試行でも同じ", async () => {
    const h = dailyHarness();
    h.state.failSave = 2;
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      warn 日報(20261010): save に失敗しました(試行 1 回): D1 書き込み失敗
      kv.put job:20261010 save running a1 n+63000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +63000
      step 20261010 save retry
      clock +4000
      alarm +63000
      step idle
      clock +64000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      warn 日報(20261010): save に失敗しました(試行 2 回): D1 書き込み失敗
      kv.put job:20261010 save running a2 n+124000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +124000
      step 20261010 save retry
      clock +65000
      alarm +124000
      step idle
      clock +125000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      kv.put job:20261010 notify running a0 n+125000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +125000
      step 20261010 save ok
      clock +126000
      kv.put job:20261010 notify running a0 n+125000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +127000
      step idle"
    `);
  });

  it("D3a LLM が 1 回失敗: 60 秒後に 2 回目で成功する。呼ぶ前に試行(llmAttempts)が永続化されている(sender の中から kv を覗く)", async () => {
    const h = dailyHarness();
    h.state.llmFailures = 1;
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      warn LLM の呼び出しに失敗しました(status=529)
      warn 日報(20261010): LLM の呼び出しに失敗しました(status=529。試行 1 回)
      kv.put job:20261010 generate running a0 n+62000 i3 c3 d3 L1 t:- m:null calls1 rec:- nt:pending roll:set
      alarm +62000
      step 20261010 generate retry
      clock +3000
      alarm +62000
      step idle
      clock +63000
      kv.put job:20261010 generate running a0 n+62000 i3 c3 d3 L2 t:- m:null calls1 rec:- nt:pending roll:set
      llm.send persistedL=2 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+62000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+63000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:pending roll:set
      alarm +63000
      step 20261010 generate ok
      clock +64000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=c6c95e8f
      kv.put job:20261010 notify running a0 n+64000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:pending roll:set
      alarm +64000
      step 20261010 save ok
      clock +65000
      kv.put job:20261010 notify running a0 n+64000 i3 c3 d3 L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +66000
      step idle"
    `);
  });

  it("D3b LLM が 2 回失敗: 上限で諦め、統計だけの日報(固定の理由)を保存して通知する。警告に試行の数と『統計だけの日報にします』", async () => {
    const h = dailyHarness();
    h.state.llmFailures = 2;
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      warn LLM の呼び出しに失敗しました(status=529)
      warn 日報(20261010): LLM の呼び出しに失敗しました(status=529。試行 1 回)
      kv.put job:20261010 generate running a0 n+62000 i3 c3 d3 L1 t:- m:null calls1 rec:- nt:pending roll:set
      alarm +62000
      step 20261010 generate retry
      clock +3000
      alarm +62000
      step idle
      clock +63000
      kv.put job:20261010 generate running a0 n+62000 i3 c3 d3 L2 t:- m:null calls1 rec:- nt:pending roll:set
      llm.send persistedL=2 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      warn LLM の呼び出しに失敗しました(status=529)
      warn 日報(20261010): LLM の呼び出しに失敗しました(status=529。試行 2 回。統計だけの日報にします)
      kv.put job:20261010 generate running a0 n+63000 i3 c3 d3 L2G t:- m:null calls2 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+63000 i3 c3 d3 L2G t:- m:null calls2 rec:set nt:pending roll:set
      alarm +63000
      step 20261010 generate ok
      clock +64000
      store.save 20261010 model=null races=3 summary=null record=ff4e440f
      kv.put job:20261010 notify running a0 n+64000 i3 c3 d3 L2G t:- m:null calls2 rec:set nt:pending roll:set
      alarm +64000
      step 20261010 save ok
      clock +65000
      kv.put job:20261010 notify running a0 n+64000 i3 c3 d3 L2G t:- m:null calls2 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=d9e86710
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +66000
      step idle"
    `);
  });

  it("D3c キー未登録(llm なし)は LLM を呼ばず、統計だけの日報。応答が JSON として読めないときは生の文章を残し、再試行しない", async () => {
    const noKey = dailyHarness({ llm: false });
    await noKey.request("auto");
    await noKey.settle();
    const raw = dailyHarness();
    raw.state.llmText = "これは JSON ではない応答です。";
    await raw.request("auto");
    await raw.settle();
    expect(text(noKey.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L0 t:- m:null calls0 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=null races=3 summary=null record=9c05ffa7
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L0 t:- m:null calls0 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L0 t:- m:null calls0 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ed4b5d06
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
    expect(text(raw.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=これは JSON ではない応答です。 record=8da08e9f
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=42113fa5
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
  });

  it("D3d 読めない応答が長いとき: 総括は先頭 300 字(末尾がサロゲートペアの前半なら落として『…』)、生の文章は先頭 20,000 字に切る。設定(D1)を読めなくても既定のモデルの選択で LLM を呼ぶ(警告つき・鍵は出さない)", async () => {
    const long = dailyHarness();
    long.state.llmText = `${"あ".repeat(298)}😀${"い".repeat(50)}`;
    await long.request("auto");
    await long.settle();

    const huge = dailyHarness();
    huge.state.llmText = `  ${"x".repeat(25_000)}  `;
    await huge.request("auto");
    await huge.settle();

    const noSettings = dailyHarness();
    noSettings.state.failSettings = true;
    await noSettings.request("auto");
    await noSettings.settle();
    expect(text(long.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=ああああああああああああああああああああ record=6dad42a1
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=1d69f3e5
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
    expect(text(huge.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=xxxxxxxxxxxxxxxxxxxx record=29619b53
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=9f8a7626
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
    expect(text(noSettings.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      warn 日報: 設定を読めなかったため、既定のモデルの選択で続けます
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
  });

  it("D3e 切り詰めの境界: 総括の長さがちょうど 300 字なら切らない(301 字なら切る)。生の文章はちょうど 20,000 字なら切らない。サロゲートペアの前半の境界(U+10000 の D800・U+10FFFF の DBFF)も割らない", async () => {
    const texts = [`${"あ".repeat(300)}`, `${"あ".repeat(301)}`, `${"x".repeat(20_000)}`, `${"x".repeat(20_001)}`, `${"あ".repeat(298)}\u{10000}${"い".repeat(50)}`, `${"あ".repeat(298)}\u{10FFFF}${"い".repeat(50)}`];
    const lines: string[] = [];
    for (const llmText of texts) {
      const h = dailyHarness();
      h.state.llmText = llmText;
      await h.request("auto");
      await h.settle();
      lines.push(...h.rec.lines.filter((l) => l.startsWith("store.save")));
    }
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "store.save 20261010 model=claude-sonnet-5-5 races=3 summary=ああああああああああああああああああああ record=2a8b640c
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=ああああああああああああああああああああ record=e7d0d051
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=xxxxxxxxxxxxxxxxxxxx record=3ff8ec98
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=xxxxxxxxxxxxxxxxxxxx record=29619b53
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=ああああああああああああああああああああ record=a66af3a1
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=ああああああああああああああああああああ record=d04fb293"
    `);
  });

  it("D3f 長いエラー: 警告に出すエラーの本文は先頭 200 字まで(鍵は伏せる)", async () => {
    const h = dailyHarness();
    h.state.failList = 1;
    h.state.listError = `${"長".repeat(190)}sk-ant-${"K".repeat(60)}${"尾".repeat(100)}`;
    await h.request("auto");
    await h.step();
    expect(h.rec.lines.filter((l) => l.startsWith("warn")).join("\n")).toMatchInlineSnapshot(`"warn 日報(20261010): list に失敗しました(試行 1 回): 長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長sk-ant-***"`);
  });

  it("D3g モデルの選択: 設定の analysisModel とモデル一覧で送るモデルが決まる(opus は一覧の最新の Opus)。設定を読めないときは既定(auto = 最新の Sonnet)。一覧が無ければ固定モデル", async () => {
    const opus = dailyHarness({ lister: true, analysisModel: "opus" });
    await opus.request("auto");
    await opus.settle();
    const noSettings = dailyHarness({ lister: true, analysisModel: "opus" });
    noSettings.state.failSettings = true;
    await noSettings.request("auto");
    await noSettings.settle();
    const noLister = dailyHarness({ analysisModel: "opus" });
    await noLister.request("auto");
    await noLister.settle();
    const pick = (h: ReturnType<typeof dailyHarness>): string => h.rec.lines.filter((l) => l.startsWith("llm.send") || l.startsWith("warn")).join("\n");
    expect(pick(opus)).toMatchInlineSnapshot(`"llm.send persistedL=1 prompt=e7a6cf9a model=claude-opus-4-7 maxTokens=12000"`);
    expect(pick(noSettings)).toMatchInlineSnapshot(`
      "warn 日報: 設定を読めなかったため、既定のモデルの選択で続けます
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-6 maxTokens=12000"
    `);
    expect(pick(noLister)).toMatchInlineSnapshot(`"llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000"`);
  });

  it("D3h 再開: 応答を永続化した後で落ちたジョブ(generate・llmText あり)は LLM を呼び直さず、その応答で記録を作る。諦めた(llmGaveUp)ジョブは LLM を呼ばず統計だけ", async () => {
    const withText = dailyHarness();
    await withText.request("auto");
    await withText.step();
    await withText.step(); // list・gather まで。generate の前
    const key = `job:${DATE}`;
    const base = withText.store.get(key) as Record<string, unknown>;
    withText.rec.log(`resume-setup phase=${String(base.phase)}`);
    withText.store.set(key, { ...base, llmAttempts: 1, llmText: withText.state.llmText, llmModel: "claude-sonnet-5-5" });
    await withText.settle();

    const gaveUp = dailyHarness();
    await gaveUp.request("auto");
    await gaveUp.step();
    await gaveUp.step();
    const base2 = gaveUp.store.get(key) as Record<string, unknown>;
    gaveUp.store.set(key, { ...base2, llmAttempts: 2, llmGaveUp: true });
    await gaveUp.settle();
    expect(text(withText.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      src.read 3
      kv.put job:20261010 generate running a0 n+0 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 gather ok
      resume-setup phase=generate
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+0 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 save running a0 n+0 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls0 rec:set nt:pending roll:set
      alarm +0
      step 20261010 generate ok
      clock +1000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a3a5b157
      kv.put job:20261010 notify running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls0 rec:set nt:pending roll:set
      alarm +1000
      step 20261010 save ok
      clock +2000
      kv.put job:20261010 notify running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls0 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +3000
      step idle"
    `);
    expect(text(gaveUp.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      src.read 3
      kv.put job:20261010 generate running a0 n+0 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 gather ok
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+0 i3 c3 d3 L2G t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 save running a0 n+0 i3 c3 d3 L2G t:- m:null calls0 rec:set nt:pending roll:set
      alarm +0
      step 20261010 generate ok
      clock +1000
      store.save 20261010 model=null races=3 summary=null record=d3073731
      kv.put job:20261010 notify running a0 n+1000 i3 c3 d3 L2G t:- m:null calls0 rec:set nt:pending roll:set
      alarm +1000
      step 20261010 save ok
      clock +2000
      kv.put job:20261010 notify running a0 n+1000 i3 c3 d3 L2G t:- m:null calls0 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=d9e86710
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +3000
      step idle"
    `);
  });

  it("D4 保存の分岐: exists は上書きも通知もせず終える。manual は通知する。regenerate は replace で終え通知しない。kept(置き換え拒否)は abandon(llmText を残し、items・digests・record・calls を捨てる)", async () => {
    const exists = dailyHarness();
    exists.state.saveResult = "exists";
    await exists.request("auto");
    await exists.settle();

    const manual = dailyHarness();
    await manual.request("manual");
    await manual.settle();

    const replaced = dailyHarness();
    replaced.state.hasReport = true;
    await replaced.request("regenerate");
    await replaced.settle();
    replaced.status();

    const kept = dailyHarness();
    kept.state.hasReport = true;
    kept.state.replaceResult = "kept";
    await kept.request("regenerate");
    await kept.settle();
    kept.status();

    const failReplace = dailyHarness();
    failReplace.state.hasReport = true;
    failReplace.state.failReplace = 3;
    await failReplace.request("regenerate");
    await failReplace.settle();
    failReplace.status();
    expect(text(exists.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 save exists
      clock +4000
      step idle"
    `);
    expect(text(manual.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=manual
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 manual -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
    expect(text(replaced.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put regen 20261010/1
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 regenerate -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.replace 20261010 model=claude-sonnet-5-5 races=3 record=a70a1f74
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 save ok
      clock +4000
      step idle
      status 20261010 null"
    `);
    expect(text(kept.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put regen 20261010/1
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 regenerate -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.replace 20261010 model=claude-sonnet-5-5 races=3 record=a70a1f74
      warn 日報(20261010): 作り直しで LLM の文章を作れなかったため、文章のある前の日報を残しました
      kv.put job:20261010 save failed a0 n+2000 i0 c3 d0 L1 t:set m:claude-sonnet-5-5 calls0 rec:- nt:pending roll:set
      kv.delete jobs
      step 20261010 save failed
      clock +4000
      step idle
      status 20261010 {"phase":"save","status":"failed","attempts":0,"regenerate":true}"
    `);
    expect(text(failReplace.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put regen 20261010/1
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 regenerate -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.replace 20261010 model=claude-sonnet-5-5 races=3 record=a70a1f74
      warn 日報(20261010): save に失敗しました(試行 1 回): D1 書き込み失敗(上書き)
      kv.put job:20261010 save running a1 n+63000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +63000
      step 20261010 save retry
      clock +4000
      alarm +63000
      step idle
      clock +64000
      store.replace 20261010 model=claude-sonnet-5-5 races=3 record=a70a1f74
      warn 日報(20261010): save に失敗しました(試行 2 回): D1 書き込み失敗(上書き)
      kv.put job:20261010 save running a2 n+124000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +124000
      step 20261010 save retry
      clock +65000
      alarm +124000
      step idle
      clock +125000
      store.replace 20261010 model=claude-sonnet-5-5 races=3 record=a70a1f74
      warn 日報(20261010): save に失敗しました(試行 3 回): D1 書き込み失敗(上書き)
      kv.put job:20261010 save failed a3 n+124000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      kv.delete jobs
      step 20261010 save failed
      clock +126000
      step idle
      status 20261010 {"phase":"save","status":"failed","attempts":3,"regenerate":true}"
    `);
  });

  it("D5 分析が無い: 一覧 0 件は auto ならジョブを消す。regenerate なら abandon(failed で残る)。詳細が全件読めない(ダイジェスト 0 件)も同じ", async () => {
    const autoEmpty = dailyHarness();
    autoEmpty.state.emptyList = true;
    await autoEmpty.request("auto");
    await autoEmpty.settle();
    autoEmpty.status();

    const regenEmpty = dailyHarness();
    regenEmpty.state.hasReport = true;
    regenEmpty.state.emptyList = true;
    await regenEmpty.request("regenerate");
    await regenEmpty.settle();
    regenEmpty.status();

    const autoMissing = dailyHarness();
    autoMissing.state.allMissing = true;
    await autoMissing.request("auto");
    await autoMissing.settle();
    autoMissing.status();

    const regenMissing = dailyHarness();
    regenMissing.state.hasReport = true;
    regenMissing.state.allMissing = true;
    await regenMissing.request("regenerate");
    await regenMissing.settle();
    regenMissing.status();
    expect(text(autoEmpty.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 list no-analyses
      clock +1000
      step idle
      status 20261010 null"
    `);
    expect(text(regenEmpty.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put regen 20261010/1
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 regenerate -> accepted
      src.list 20261010
      kv.put job:20261010 list failed a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      kv.delete jobs
      step 20261010 list no-analyses
      clock +1000
      step idle
      status 20261010 {"phase":"list","status":"failed","attempts":0,"regenerate":true}"
    `);
    expect(text(autoMissing.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 gather no-analyses
      clock +2000
      step idle
      status 20261010 null"
    `);
    expect(text(regenMissing.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put regen 20261010/1
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 regenerate -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 gather failed a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      kv.delete jobs
      step 20261010 gather no-analyses
      clock +2000
      step idle
      status 20261010 {"phase":"gather","status":"failed","attempts":0,"regenerate":true}"
    `);
  });

  it("D6 通知: 送る前に sending を書く。送信失敗は分類だけ警告して再送しない。sending のまま再開したジョブは送らずに終える。notifier なしは保存して終わる", async () => {
    const fails = dailyHarness();
    fails.state.notifyFails = true;
    await fails.request("auto");
    await fails.settle();

    const resumed = dailyHarness();
    await resumed.request("auto");
    // save までを進め、notify に入る直前で『送信中に落ちた』状態(sending)を作って再開する(本物の kv を直接書く = 記録に出ない)
    for (let i = 0; i < 4; i += 1) {
      await resumed.step();
      resumed.clock.t += 1000;
    }
    const key = `job:${DATE}`;
    const job = resumed.store.get(key) as { phase: string; notify: string };
    resumed.rec.log(`resume-setup phase=${job.phase}`);
    resumed.store.set(key, { ...job, notify: "sending" });
    await resumed.settle();

    const none = dailyHarness({ notifier: false });
    await none.request("auto");
    await none.settle();
    expect(text(fails.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      warn Discord への日報の通知に失敗しました(20261010。分類: other。再送しません)
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify failed
      clock +5000
      step idle"
    `);
    expect(text(resumed.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      resume-setup phase=notify
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
    expect(text(none.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=a70a1f74
      kv.put job:20261010 notify running a0 n+3000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +3000
      step 20261010 save ok
      clock +4000
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 notify ok
      clock +5000
      step idle"
    `);
  });

  it("D7 複数のジョブ: nextAt の早い順(同時刻なら日付の昇順)に 1 段階ずつ動く。アラームは最も早い時刻(今より前にはしない)。動かせるジョブが無ければ idle でアラームを張らない", async () => {
    const h = dailyHarness();
    await h.step(); // ジョブ無し
    await h.request("auto", "20261010");
    h.advance(1000);
    await h.request("auto", "20261009"); // 後から依頼した(nextAt が遅い)ので、20261010 が先に 1 段階動く
    await h.step();
    await h.step();
    await h.step();
    h.state.failPeriod = 1;
    await h.step();
    await h.step();
    await h.step(); // 再試行待ちで idle(アラームだけ張る)
    h.advance(60_000);
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "step idle
      store.has 20261010
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 auto -> accepted
      clock +1000
      store.has 20261009
      kv.put job:20261009 list running a0 n+1000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261010","20261009"]
      alarm +1000
      request 20261009 auto -> accepted
      src.list 20261010
      kv.put job:20261010 gather running a0 n+1000 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 list ok
      src.list 20261009
      kv.put job:20261009 gather running a0 n+1000 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261009 list ok
      src.read 3
      kv.put job:20261009 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261009 gather ok
      src.period 20260912..20261008
      warn 日報(20261009): generate に失敗しました(試行 1 回): D1 が落ちた(期間)
      kv.put job:20261009 generate running a1 n+61000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261009 generate retry
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +1000
      step 20261010 generate ok
      clock +61000
      store.save 20261010 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=14d3ae95
      kv.put job:20261010 notify running a0 n+61000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +61000
      step 20261010 save ok
      clock +62000
      src.period 20260912..20261008
      kv.put job:20261009 generate running a1 n+61000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261009 generate running a1 n+61000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=4900a558 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261009 generate running a1 n+61000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261009 save running a0 n+62000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +62000
      step 20261009 generate ok
      clock +63000
      kv.put job:20261010 notify running a0 n+61000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=ec4ef6cd
      kv.delete job:20261010
      kv.put jobs ["20261009"]
      alarm +63000
      step 20261010 notify ok
      clock +64000
      store.save 20261009 model=claude-sonnet-5-5 races=3 summary=3 レースを分析し、結果のある 2 レー record=c0efac8e
      kv.put job:20261009 notify running a0 n+64000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +64000
      step 20261009 save ok
      clock +65000
      kv.put job:20261009 notify running a0 n+64000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending roll:set
      discord.send persistedNt=sending embed=9175dbe2
      kv.delete job:20261009
      kv.delete jobs
      step 20261009 notify ok
      clock +66000
      step idle"
    `);
  });

  it("D8 作り直しの回数枠: 3 回まで受理し 4 回目は daily-limit(ジョブも作らない)。regen の記録は日付とカウント。JST の日付が変われば数え直す。断った依頼(in-progress・not-exists)は数えない", async () => {
    const h = dailyHarness();
    h.state.hasReport = true;
    await h.request("regenerate", "20261010");
    await h.request("regenerate", "20261010"); // in-progress(数えない)
    await h.settle();
    await h.request("regenerate", "20261009");
    await h.settle();
    await h.request("regenerate", "20261008");
    await h.settle();
    await h.request("regenerate", "20261007"); // daily-limit
    h.state.hasReport = false;
    await h.request("regenerate", "20261006"); // not-exists(枠の判定より前)
    h.state.hasReport = true;
    h.advance(Date.parse("2026-10-10T15:00:00.000Z") - h.clock.t); // JST 10/11 0:00
    await h.request("regenerate", "20261007");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 20261010
      kv.put regen 20261010/1
      kv.put job:20261010 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261010"]
      alarm +0
      request 20261010 regenerate -> accepted
      request 20261010 regenerate -> in-progress
      src.list 20261010
      kv.put job:20261010 gather running a0 n+0 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 20261010 list ok
      clock +1000
      src.read 3
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +1000
      step 20261010 gather ok
      clock +2000
      src.period 20260913..20261009
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=e7a6cf9a model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261010 generate running a0 n+1000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261010 save running a0 n+2000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +2000
      step 20261010 generate ok
      clock +3000
      store.replace 20261010 model=claude-sonnet-5-5 races=3 record=a70a1f74
      kv.delete job:20261010
      kv.delete jobs
      step 20261010 save ok
      clock +4000
      step idle
      store.has 20261009
      kv.put regen 20261010/2
      kv.put job:20261009 list running a0 n+4000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261009"]
      alarm +4000
      request 20261009 regenerate -> accepted
      src.list 20261009
      kv.put job:20261009 gather running a0 n+4000 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +4000
      step 20261009 list ok
      clock +5000
      src.read 3
      kv.put job:20261009 generate running a0 n+5000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +5000
      step 20261009 gather ok
      clock +6000
      src.period 20260912..20261008
      kv.put job:20261009 generate running a0 n+5000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261009 generate running a0 n+5000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=4900a558 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261009 generate running a0 n+5000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261009 save running a0 n+6000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +6000
      step 20261009 generate ok
      clock +7000
      store.replace 20261009 model=claude-sonnet-5-5 races=3 record=a8b6211d
      kv.delete job:20261009
      kv.delete jobs
      step 20261009 save ok
      clock +8000
      step idle
      store.has 20261008
      kv.put regen 20261010/3
      kv.put job:20261008 list running a0 n+8000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261008"]
      alarm +8000
      request 20261008 regenerate -> accepted
      src.list 20261008
      kv.put job:20261008 gather running a0 n+8000 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +8000
      step 20261008 list ok
      clock +9000
      src.read 3
      kv.put job:20261008 generate running a0 n+9000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +9000
      step 20261008 gather ok
      clock +10000
      src.period 20260911..20261007
      kv.put job:20261008 generate running a0 n+9000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261008 generate running a0 n+9000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=793ec69c model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261008 generate running a0 n+9000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261008 save running a0 n+10000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +10000
      step 20261008 generate ok
      clock +11000
      store.replace 20261008 model=claude-sonnet-5-5 races=3 record=5e6e50eb
      kv.delete job:20261008
      kv.delete jobs
      step 20261008 save ok
      clock +12000
      step idle
      store.has 20261007
      request 20261007 regenerate -> daily-limit
      store.has 20261006
      request 20261006 regenerate -> not-exists
      clock +14400000
      store.has 20261007
      kv.put regen 20261011/1
      kv.put job:20261007 list running a0 n+14400000 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261007"]
      alarm +14400000
      request 20261007 regenerate -> accepted
      src.list 20261007
      kv.put job:20261007 gather running a0 n+14400000 i3 c0 d0 L0 t:- m:null calls0 rec:- nt:pending
      alarm +14400000
      step 20261007 list ok
      clock +14401000
      src.read 3
      kv.put job:20261007 generate running a0 n+14401000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending
      alarm +14401000
      step 20261007 gather ok
      clock +14402000
      src.period 20260910..20261006
      kv.put job:20261007 generate running a0 n+14401000 i3 c3 d3 L0 t:- m:null calls0 rec:- nt:pending roll:set +rolling
      kv.put job:20261007 generate running a0 n+14401000 i3 c3 d3 L1 t:- m:null calls0 rec:- nt:pending roll:set
      llm.send persistedL=1 prompt=398817b5 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:20261007 generate running a0 n+14401000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending roll:set
      kv.put job:20261007 save running a0 n+14402000 i3 c3 d3 L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending roll:set
      alarm +14402000
      step 20261007 generate ok
      clock +14403000
      store.replace 20261007 model=claude-sonnet-5-5 races=3 record=79884759
      kv.delete job:20261007
      kv.delete jobs
      step 20261007 save ok
      clock +14404000
      step idle"
    `);
  });

  it("D9 依頼の断り方と getStatus: 不正・未来・古すぎる(auto・catchup)・進行中・作成済みの断り。manual は古くても受理。状況は regenerate のときだけ regenerate: true", async () => {
    const h = dailyHarness();
    h.status();
    await h.request("auto", "2026101A");
    await h.request("auto", "20261031");
    await h.request("auto", "20261006"); // too-old(今日 10/10 の 4 日前)
    await h.request("catchup", "20261006");
    await h.request("auto", "20261007"); // 3 日前まで(含む)は受理
    await h.request("auto", "20261007"); // in-progress
    h.status("20261007");
    h.state.hasReport = true;
    await h.request("auto", "20261008"); // exists
    await h.request("manual", "20261001"); // 上限なし……だが hasReport=true なので exists
    h.state.hasReport = false;
    await h.request("manual", "20261001");
    h.status("20261001");
    h.state.hasReport = true;
    await h.request("regenerate", "20260901");
    h.status("20260901");
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "status 20261010 null
      request 2026101A auto -> invalid-date
      request 20261031 auto -> future-date
      request 20261006 auto -> too-old
      request 20261006 catchup -> too-old
      store.has 20261007
      kv.put job:20261007 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=auto
      kv.put jobs ["20261007"]
      alarm +0
      request 20261007 auto -> accepted
      request 20261007 auto -> in-progress
      status 20261007 {"phase":"list","status":"running","attempts":0}
      store.has 20261008
      request 20261008 auto -> exists
      store.has 20261001
      request 20261001 manual -> exists
      store.has 20261001
      kv.put job:20261001 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=manual
      kv.put jobs ["20261007","20261001"]
      alarm +0
      request 20261001 manual -> accepted
      status 20261001 {"phase":"list","status":"running","attempts":0}
      store.has 20260901
      kv.put regen 20261010/1
      kv.put job:20260901 list running a0 n+0 i0 c0 d0 L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,cursor,digests,items,kaisaiDate,llmAttempts,llmGaveUp,llmModel,llmText,mode,nextAt,notify,phase,record,status] mode=regenerate
      kv.put jobs ["20261007","20261001","20260901"]
      alarm +0
      request 20260901 regenerate -> accepted
      status 20260901 {"phase":"list","status":"running","attempts":0,"regenerate":true}"
    `);
  });
});

// ============================================================================
// 月報
// ============================================================================

describe("月報のジョブ機構(特性テスト。共通化の前後で記録が 1 文字も変わらない)", () => {
  it("M1 正常(auto): 最終日の状態を問い合わせ、読み出し・LLM・保存・通知の 1 段階ずつで確定する(キー集合・書き込みの順・アラーム)", async () => {
    const h = monthlyHarness({ llm: true, notifier: true, appBaseUrl: "https://example.test" });
    await h.request("auto");
    await h.settle();
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending
      discord.send persistedNt=sending embed=d9ebab16
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
  });

  it("M2 待ち: 結果が未取込の間は 10 分ごとに 6 回待ち(失敗に数えない・attempts は 0 に戻る)、7 回目は待たずに lastDayPending を立てて作る。日報が無い間も待つ", async () => {
    const noResult = monthlyHarness({ llm: true, notifier: true });
    noResult.state.status = { raceCount: 2, noResultRaceCount: 1, hasDailyReport: true };
    await noResult.request("auto");
    await noResult.settle(10 * 60_000);

    const noDaily = monthlyHarness({ llm: true });
    noDaily.state.status = { raceCount: 2, noResultRaceCount: 0, hasDailyReport: false };
    await noDaily.request("catchup");
    for (let i = 0; i < 3; i += 1) {
      await noDaily.step();
      noDaily.advance(10 * 60_000);
    }
    noDaily.state.status = { raceCount: 2, noResultRaceCount: 0, hasDailyReport: true };
    await noDaily.settle(10 * 60_000);

    const noRaces = monthlyHarness();
    noRaces.state.status = { raceCount: 0, noResultRaceCount: 0, hasDailyReport: false };
    await noRaces.request("auto");
    await noRaces.settle();
    expect(text(noResult.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      kv.put job:202610 read running a0 n+600000 w1 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +600000
      step 202610 read waiting
      clock +1000
      alarm +600000
      step idle
      clock +601000
      src.status 20261031
      kv.put job:202610 read running a0 n+1201000 w2 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +1201000
      step 202610 read waiting
      clock +602000
      alarm +1201000
      step idle
      clock +1202000
      src.status 20261031
      kv.put job:202610 read running a0 n+1802000 w3 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +1802000
      step 202610 read waiting
      clock +1203000
      alarm +1802000
      step idle
      clock +1803000
      src.status 20261031
      kv.put job:202610 read running a0 n+2403000 w4 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +2403000
      step 202610 read waiting
      clock +1804000
      alarm +2403000
      step idle
      clock +2404000
      src.status 20261031
      kv.put job:202610 read running a0 n+3004000 w5 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +3004000
      step 202610 read waiting
      clock +2405000
      alarm +3004000
      step idle
      clock +3005000
      src.status 20261031
      kv.put job:202610 read running a0 n+3605000 w6 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +3605000
      step 202610 read waiting
      clock +3006000
      alarm +3605000
      step idle
      clock +3606000
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+3606000 w6 s:set pend:true L0 t:- m:null calls0 rec:- nt:pending
      alarm +3606000
      step 202610 read ok
      clock +3607000
      kv.put job:202610 generate running a0 n+3606000 w6 s:set pend:true L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=c58a5950 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+3606000 w6 s:set pend:true L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+3607000 w6 s:set pend:true L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +3607000
      step 202610 generate ok
      clock +3608000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=8a364c0d
      kv.put job:202610 notify running a0 n+3608000 w6 s:set pend:true L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +3608000
      step 202610 save ok
      clock +3609000
      kv.put job:202610 notify running a0 n+3608000 w6 s:set pend:true L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending
      discord.send persistedNt=sending embed=02100780
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +3610000
      step idle"
    `);
    expect(text(noDaily.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=catchup
      kv.put jobs ["202610"]
      alarm +0
      request 202610 catchup -> accepted
      src.status 20261031
      kv.put job:202610 read running a0 n+600000 w1 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +600000
      step 202610 read waiting
      clock +600000
      src.status 20261031
      kv.put job:202610 read running a0 n+1200000 w2 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +1200000
      step 202610 read waiting
      clock +1200000
      src.status 20261031
      kv.put job:202610 read running a0 n+1800000 w3 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +1800000
      step 202610 read waiting
      clock +1800000
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+1800000 w3 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +1800000
      step 202610 read ok
      clock +1801000
      kv.put job:202610 generate running a0 n+1800000 w3 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+1800000 w3 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1801000 w3 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1801000
      step 202610 generate ok
      clock +1802000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=a15cf95e
      kv.put job:202610 notify running a0 n+1802000 w3 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1802000
      step 202610 save ok
      clock +1803000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +1804000
      step idle"
    `);
    expect(text(noRaces.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=null races=2 summary=null record=01d7313d
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
  });

  it("M3 待たない場合: 最終日の翌日 3:00(JST)以降の auto、manual、regenerate は最終日の状態を問い合わせない。2:59:59 は問い合わせる(境界)", async () => {
    const late = monthlyHarness({ start: jstMsOf("20261101", 3) });
    late.state.status = { raceCount: 2, noResultRaceCount: 1, hasDailyReport: false };
    await late.request("auto");
    await late.settle();

    const justBefore = monthlyHarness({ start: jstMsOf("20261101", 3) - 1000 });
    justBefore.state.status = { raceCount: 2, noResultRaceCount: 1, hasDailyReport: false };
    await justBefore.request("auto");
    await justBefore.step();

    const manual = monthlyHarness({ start: M_NEXT });
    manual.state.status = { raceCount: 2, noResultRaceCount: 1, hasDailyReport: false };
    await manual.request("manual");
    await manual.settle();

    const regen = monthlyHarness({ start: M_NEXT });
    regen.state.hasReport = true;
    regen.state.status = { raceCount: 2, noResultRaceCount: 1, hasDailyReport: false };
    await regen.request("regenerate");
    await regen.settle();
    expect(text(late.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+18000000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +18000000
      request 202610 auto -> accepted
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+18000000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +18000000
      step 202610 read ok
      clock +18001000
      kv.put job:202610 save running a0 n+18001000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +18001000
      step 202610 generate ok
      clock +18002000
      store.save 202610 model=null races=2 summary=null record=53685904
      kv.put job:202610 notify running a0 n+18002000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +18002000
      step 202610 save ok
      clock +18003000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +18004000
      step idle"
    `);
    expect(text(justBefore.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+17999000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +17999000
      request 202610 auto -> accepted
      src.status 20261031
      kv.put job:202610 read running a0 n+18599000 w1 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +18599000
      step 202610 read waiting"
    `);
    expect(text(manual.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=manual
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 manual -> accepted
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136800000
      step 202610 read ok
      clock +136801000
      kv.put job:202610 save running a0 n+136801000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +136801000
      step 202610 generate ok
      clock +136802000
      store.save 202610 model=null races=2 summary=null record=590fbf94
      kv.delete job:202610
      kv.delete jobs
      step 202610 save ok
      clock +136803000
      step idle"
    `);
    expect(text(regen.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put regen 20261102/1
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 regenerate -> accepted
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136800000
      step 202610 read ok
      clock +136801000
      kv.put job:202610 save running a0 n+136801000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +136801000
      step 202610 generate ok
      clock +136802000
      store.replace 202610 model=null races=2 record=590fbf94
      kv.delete job:202610
      kv.delete jobs
      step 202610 save ok
      clock +136803000
      step idle"
    `);
  });

  it("M4 段階の失敗: 読み出し・状態の問い合わせ・generate(統計が無い)・保存の失敗は 60 秒ごとに再試行、3 回で failed。保存の失敗の再試行では LLM を呼び直さない", async () => {
    const read = monthlyHarness();
    read.state.failRead = 3;
    await read.request("auto");
    await read.settle();
    read.status();

    const status = monthlyHarness({ llm: true });
    status.state.failStatus = 1;
    await status.request("auto");
    await status.settle();

    const noStats = monthlyHarness({ llm: true });
    await noStats.request("auto");
    await noStats.step(); // read
    const key = `job:${MONTH}`;
    noStats.store.set(key, { ...(noStats.store.get(key) as object), stats: null });
    await noStats.settle();
    noStats.status();

    const save = monthlyHarness({ llm: true });
    save.state.failSave = 2;
    await save.request("auto");
    await save.settle();
    expect(text(read.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      warn 月報(202610): read に失敗しました(試行 1 回): D1 の詳細(月)
      kv.put job:202610 read running a1 n+60000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +60000
      step 202610 read retry
      clock +1000
      alarm +60000
      step idle
      clock +61000
      src.status 20261031
      src.month 20261001..20261031
      warn 月報(202610): read に失敗しました(試行 2 回): D1 の詳細(月)
      kv.put job:202610 read running a2 n+121000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +121000
      step 202610 read retry
      clock +62000
      alarm +121000
      step idle
      clock +122000
      src.status 20261031
      src.month 20261001..20261031
      warn 月報(202610): read に失敗しました(試行 3 回): D1 の詳細(月)
      kv.put job:202610 read failed a3 n+121000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      kv.delete jobs
      step 202610 read failed
      clock +123000
      step idle
      status 202610 {"phase":"read","status":"failed","attempts":3}"
    `);
    expect(text(status.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      warn 月報(202610): read に失敗しました(試行 1 回): D1 の詳細 sk-ant-***
      kv.put job:202610 read running a1 n+60000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +60000
      step 202610 read retry
      clock +1000
      alarm +60000
      step idle
      clock +61000
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +61000
      step 202610 read ok
      clock +62000
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+62000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +62000
      step 202610 generate ok
      clock +63000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=7a2a93de
      kv.put job:202610 notify running a0 n+63000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +63000
      step 202610 save ok
      clock +64000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +65000
      step idle"
    `);
    expect(text(noStats.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      warn 月報(202610): generate に失敗しました(試行 1 回): 文章を作る月の統計がありません
      kv.put job:202610 generate running a1 n+60000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +60000
      step 202610 generate retry
      clock +1000
      alarm +60000
      step idle
      clock +61000
      warn 月報(202610): generate に失敗しました(試行 2 回): 文章を作る月の統計がありません
      kv.put job:202610 generate running a2 n+121000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +121000
      step 202610 generate retry
      clock +62000
      alarm +121000
      step idle
      clock +122000
      warn 月報(202610): generate に失敗しました(試行 3 回): 文章を作る月の統計がありません
      kv.put job:202610 generate failed a3 n+121000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      kv.delete jobs
      step 202610 generate failed
      clock +123000
      step idle
      status 202610 {"phase":"generate","status":"failed","attempts":3}"
    `);
    expect(text(save.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      warn 月報(202610): save に失敗しました(試行 1 回): D1 書き込み失敗
      kv.put job:202610 save running a1 n+62000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +62000
      step 202610 save retry
      clock +3000
      alarm +62000
      step idle
      clock +63000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      warn 月報(202610): save に失敗しました(試行 2 回): D1 書き込み失敗
      kv.put job:202610 save running a2 n+123000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +123000
      step 202610 save retry
      clock +64000
      alarm +123000
      step idle
      clock +124000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      kv.put job:202610 notify running a0 n+124000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +124000
      step 202610 save ok
      clock +125000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +126000
      step idle"
    `);
  });

  it("M5 LLM: 1 回失敗して 2 回目で成功(呼ぶ前に試行を永続化)。2 回失敗で諦め統計だけ。キー未登録。JSON として読めない応答は再試行せず生の文章を残す", async () => {
    const once = monthlyHarness({ llm: true });
    once.state.llmFailures = 1;
    await once.request("auto");
    await once.settle();

    const twice = monthlyHarness({ llm: true });
    twice.state.llmFailures = 2;
    await twice.request("auto");
    await twice.settle();

    const noKey = monthlyHarness({ notifier: true });
    await noKey.request("auto");
    await noKey.settle();

    const raw = monthlyHarness({ llm: true });
    raw.state.llmText = "これは JSON ではない応答です。";
    await raw.request("auto");
    await raw.settle();
    expect(text(once.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      warn LLM の呼び出しに失敗しました(status=529)
      warn 月報(202610): LLM の呼び出しに失敗しました(status=529。試行 1 回)
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L1 t:- m:null calls1 rec:- nt:pending
      alarm +61000
      step 202610 generate retry
      clock +2000
      alarm +61000
      step idle
      clock +62000
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L2 t:- m:null calls1 rec:- nt:pending
      llm.send persistedL=2 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L2 t:set m:claude-sonnet-5-5 calls2 rec:- nt:pending
      kv.put job:202610 save running a0 n+62000 w0 s:set pend:false L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:pending
      alarm +62000
      step 202610 generate ok
      clock +63000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=a0944559
      kv.put job:202610 notify running a0 n+63000 w0 s:set pend:false L2 t:set m:claude-sonnet-5-5 calls2 rec:set nt:pending
      alarm +63000
      step 202610 save ok
      clock +64000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +65000
      step idle"
    `);
    expect(text(twice.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      warn LLM の呼び出しに失敗しました(status=529)
      warn 月報(202610): LLM の呼び出しに失敗しました(status=529。試行 1 回)
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L1 t:- m:null calls1 rec:- nt:pending
      alarm +61000
      step 202610 generate retry
      clock +2000
      alarm +61000
      step idle
      clock +62000
      kv.put job:202610 generate running a0 n+61000 w0 s:set pend:false L2 t:- m:null calls1 rec:- nt:pending
      llm.send persistedL=2 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      warn LLM の呼び出しに失敗しました(status=529)
      warn 月報(202610): LLM の呼び出しに失敗しました(status=529。試行 2 回。統計だけの月報にします)
      kv.put job:202610 generate running a0 n+62000 w0 s:set pend:false L2G t:- m:null calls2 rec:- nt:pending
      kv.put job:202610 save running a0 n+62000 w0 s:set pend:false L2G t:- m:null calls2 rec:set nt:pending
      alarm +62000
      step 202610 generate ok
      clock +63000
      store.save 202610 model=null races=2 summary=null record=f8b2aa7d
      kv.put job:202610 notify running a0 n+63000 w0 s:set pend:false L2G t:- m:null calls2 rec:set nt:pending
      alarm +63000
      step 202610 save ok
      clock +64000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +65000
      step idle"
    `);
    expect(text(noKey.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=null races=2 summary=null record=01d7313d
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:sending
      discord.send persistedNt=sending embed=190338ab
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
    expect(text(raw.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=これは JSON ではない応答です。 record=dd3d9c7e
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
  });

  it("M5b 読めない応答が長いとき: 総括は先頭 300 字(末尾がサロゲートペアの前半なら落として『…』)、生の文章は先頭 20,000 字に切る。設定(D1)を読めなくても既定のモデルの選択で LLM を呼ぶ(警告つき・鍵は出さない)", async () => {
    const long = monthlyHarness({ llm: true });
    long.state.llmText = `${"あ".repeat(298)}😀${"い".repeat(50)}`;
    await long.request("auto");
    await long.settle();

    const huge = monthlyHarness({ llm: true });
    huge.state.llmText = `  ${"x".repeat(25_000)}  `;
    await huge.request("auto");
    await huge.settle();

    const noSettings = monthlyHarness({ llm: true });
    noSettings.state.failSettings = true;
    await noSettings.request("auto");
    await noSettings.settle();
    expect(text(long.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=ああああああああああああああああああああ record=26bbfeef
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
    expect(text(huge.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=xxxxxxxxxxxxxxxxxxxx record=663e5037
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
    expect(text(noSettings.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      warn 月報: 設定を読めなかったため、既定のモデルの選択で続けます
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
  });

  it("M5c 切り詰めの境界・長いエラー・モデルの選択・再開(日報の D3e〜D3h と同じ場面を月報で)", async () => {
    const texts = [`${"あ".repeat(300)}`, `${"あ".repeat(301)}`, `${"x".repeat(20_000)}`, `${"x".repeat(20_001)}`, `${"あ".repeat(298)}\u{10000}${"い".repeat(50)}`, `${"あ".repeat(298)}\u{10FFFF}${"い".repeat(50)}`];
    const lines: string[] = [];
    for (const llmText of texts) {
      const h = monthlyHarness({ llm: true });
      h.state.llmText = llmText;
      await h.request("auto");
      await h.settle();
      lines.push(...h.rec.lines.filter((l) => l.startsWith("store.save")));
    }
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "store.save 202610 model=claude-sonnet-5-5 races=2 summary=ああああああああああああああああああああ record=a2ed4ce2
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=ああああああああああああああああああああ record=f630b113
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=xxxxxxxxxxxxxxxxxxxx record=208aeed0
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=xxxxxxxxxxxxxxxxxxxx record=663e5037
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=ああああああああああああああああああああ record=fc41c8a8
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=ああああああああああああああああああああ record=7fbdf840"
    `);

    const pick = (h: ReturnType<typeof monthlyHarness>): string => h.rec.lines.filter((l) => l.startsWith("llm.send") || l.startsWith("warn")).join("\n");
    const opus = monthlyHarness({ llm: true, lister: true, analysisModel: "opus" });
    await opus.request("auto");
    await opus.settle();
    const noSettings = monthlyHarness({ llm: true, lister: true, analysisModel: "opus" });
    noSettings.state.failSettings = true;
    await noSettings.request("auto");
    await noSettings.settle();
    const noLister = monthlyHarness({ llm: true, analysisModel: "opus" });
    await noLister.request("auto");
    await noLister.settle();
    expect(pick(opus)).toMatchInlineSnapshot(`"llm.send persistedL=1 prompt=ae2b38d7 model=claude-opus-4-7 maxTokens=12000"`);
    expect(pick(noSettings)).toMatchInlineSnapshot(`
      "warn 月報: 設定を読めなかったため、既定のモデルの選択で続けます
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-6 maxTokens=12000"
    `);
    expect(pick(noLister)).toMatchInlineSnapshot(`"llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000"`);

    const key = `job:${MONTH}`;
    const withText = monthlyHarness({ llm: true });
    await withText.request("auto");
    await withText.step(); // read まで。generate の前
    const base = withText.store.get(key) as Record<string, unknown>;
    withText.rec.log(`resume-setup phase=${String(base.phase)}`);
    withText.store.set(key, { ...base, llmAttempts: 1, llmText: withText.state.llmText, llmModel: "claude-sonnet-5-5" });
    await withText.settle();
    const gaveUp = monthlyHarness({ llm: true });
    await gaveUp.request("auto");
    await gaveUp.step();
    const base2 = gaveUp.store.get(key) as Record<string, unknown>;
    gaveUp.store.set(key, { ...base2, llmAttempts: 2, llmGaveUp: true });
    await gaveUp.settle();
    expect(text(withText.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      resume-setup phase=generate
      kv.put job:202610 save running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls0 rec:set nt:pending
      alarm +0
      step 202610 generate ok
      clock +1000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=8354fa02
      kv.put job:202610 notify running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls0 rec:set nt:pending
      alarm +1000
      step 202610 save ok
      clock +2000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +3000
      step idle"
    `);
    expect(text(gaveUp.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      kv.put job:202610 save running a0 n+0 w0 s:set pend:false L2G t:- m:null calls0 rec:set nt:pending
      alarm +0
      step 202610 generate ok
      clock +1000
      store.save 202610 model=null races=2 summary=null record=1c5a584b
      kv.put job:202610 notify running a0 n+1000 w0 s:set pend:false L2G t:- m:null calls0 rec:set nt:pending
      alarm +1000
      step 202610 save ok
      clock +2000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +3000
      step idle"
    `);
  });

  it("M5d 長いエラー: 警告に出すエラーの本文は先頭 200 字まで(鍵は伏せる)", async () => {
    const h = monthlyHarness();
    h.state.failRead = 1;
    h.state.readError = `${"長".repeat(190)}sk-ant-${"K".repeat(60)}${"尾".repeat(100)}`;
    await h.request("auto");
    await h.step();
    expect(h.rec.lines.filter((l) => l.startsWith("warn")).join("\n")).toMatchInlineSnapshot(`"warn 月報(202610): read に失敗しました(試行 1 回): 長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長sk-ant-***"`);
  });

  it("M6 保存の分岐: exists は終える。manual は保存後に通知せず終える。catchup は通知する。regenerate は replace で通知しない。kept は abandon(stats・record・calls・llmText を捨てる)", async () => {
    const exists = monthlyHarness({ llm: true, notifier: true });
    exists.state.saveResult = "exists";
    await exists.request("auto");
    await exists.settle();

    const manual = monthlyHarness({ start: M_NEXT, llm: true, notifier: true });
    await manual.request("manual");
    await manual.settle();

    const catchup = monthlyHarness({ start: M_NEXT, llm: true, notifier: true });
    await catchup.request("catchup");
    await catchup.settle();

    const replaced = monthlyHarness({ start: M_NEXT, llm: true, notifier: true });
    replaced.state.hasReport = true;
    await replaced.request("regenerate");
    await replaced.settle();
    replaced.status();

    const kept = monthlyHarness({ start: M_NEXT, llm: true, notifier: true });
    kept.state.hasReport = true;
    kept.state.replaceResult = "kept";
    await kept.request("regenerate");
    await kept.settle();
    kept.status();
    expect(text(exists.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      kv.delete job:202610
      kv.delete jobs
      step 202610 save exists
      clock +3000
      step idle"
    `);
    expect(text(manual.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=manual
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 manual -> accepted
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136800000
      step 202610 read ok
      clock +136801000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+136801000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +136801000
      step 202610 generate ok
      clock +136802000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=43a776bd
      kv.delete job:202610
      kv.delete jobs
      step 202610 save ok
      clock +136803000
      step idle"
    `);
    expect(text(catchup.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=catchup
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 catchup -> accepted
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136800000
      step 202610 read ok
      clock +136801000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+136801000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +136801000
      step 202610 generate ok
      clock +136802000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=43a776bd
      kv.put job:202610 notify running a0 n+136802000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +136802000
      step 202610 save ok
      clock +136803000
      kv.put job:202610 notify running a0 n+136802000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending
      discord.send persistedNt=sending embed=a6822e29
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +136804000
      step idle"
    `);
    expect(text(replaced.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put regen 20261102/1
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 regenerate -> accepted
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136800000
      step 202610 read ok
      clock +136801000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+136801000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +136801000
      step 202610 generate ok
      clock +136802000
      store.replace 202610 model=claude-sonnet-5-5 races=2 record=43a776bd
      kv.delete job:202610
      kv.delete jobs
      step 202610 save ok
      clock +136803000
      step idle
      status 202610 null"
    `);
    expect(text(kept.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put regen 20261102/1
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 regenerate -> accepted
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136800000
      step 202610 read ok
      clock +136801000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+136801000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +136801000
      step 202610 generate ok
      clock +136802000
      store.replace 202610 model=claude-sonnet-5-5 races=2 record=43a776bd
      warn 月報(202610): 作り直しで LLM の文章を作れなかったため、文章のある前の月報を残しました
      kv.put job:202610 save failed a0 n+136801000 w0 s:- pend:false L1 t:- m:claude-sonnet-5-5 calls0 rec:- nt:pending
      kv.delete jobs
      step 202610 save failed
      clock +136803000
      step idle
      status 202610 {"phase":"save","status":"failed","attempts":0,"regenerate":true}"
    `);
  });

  it("M7 分析が無い月: auto はジョブを消す。regenerate は abandon(failed で残る)", async () => {
    const auto = monthlyHarness();
    auto.state.stats = emptyMonthStats();
    await auto.request("auto");
    await auto.settle();
    auto.status();

    const regen = monthlyHarness({ start: M_NEXT });
    regen.state.hasReport = true;
    regen.state.stats = emptyMonthStats();
    await regen.request("regenerate");
    await regen.settle();
    regen.status();
    expect(text(auto.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.delete job:202610
      kv.delete jobs
      step 202610 read no-analyses
      clock +1000
      step idle
      status 202610 null"
    `);
    expect(text(regen.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put regen 20261102/1
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 regenerate -> accepted
      src.month 20261001..20261031
      kv.put job:202610 read failed a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending
      kv.delete jobs
      step 202610 read no-analyses
      clock +136801000
      step idle
      status 202610 {"phase":"read","status":"failed","attempts":0,"regenerate":true}"
    `);
  });

  it("M8 通知: 送る前に sending を書く。送信失敗は分類だけ警告して再送しない。sending のまま再開したジョブは送らずに終える。notifier なしは保存して終わる", async () => {
    const fails = monthlyHarness({ llm: true, notifier: true });
    fails.state.notifyFails = true;
    await fails.request("auto");
    await fails.settle();

    const resumed = monthlyHarness({ llm: true, notifier: true });
    await resumed.request("auto");
    for (let i = 0; i < 3; i += 1) {
      await resumed.step();
      resumed.clock.t += 1000;
    }
    const key = `job:${MONTH}`;
    const job = resumed.store.get(key) as { phase: string };
    resumed.rec.log(`resume-setup phase=${job.phase}`);
    resumed.store.set(key, { ...job, notify: "sending" });
    await resumed.settle();

    const none = monthlyHarness({ llm: true });
    await none.request("auto");
    await none.settle();
    expect(text(fails.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:sending
      discord.send persistedNt=sending embed=a6822e29
      warn Discord への月報の通知に失敗しました(202610。分類: other。再送しません)
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify failed
      clock +4000
      step idle"
    `);
    expect(text(resumed.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      resume-setup phase=notify
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
    expect(text(none.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:- m:null calls0 rec:- nt:pending
      llm.send persistedL=1 prompt=ae2b38d7 model=claude-sonnet-5-5 maxTokens=12000
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:- nt:pending
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=claude-sonnet-5-5 races=2 summary=10 月は 2 レースを分析した。 record=64f29e05
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L1 t:set m:claude-sonnet-5-5 calls1 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
  });

  it("M9 複数のジョブと startAt: startAt が今〜24 時間先ならその時刻まで動かない(アラームも startAt)。過去・24 時間より先は今すぐ。nextAt の早い順(同時刻なら月の昇順)", async () => {
    const h = monthlyHarness({ start: M_NEXT });
    await h.step(); // ジョブ無し
    await h.request("manual", { month: "202609" });
    h.advance(1000);
    await h.request("manual", { month: "202608" }); // 後から依頼した(nextAt が遅い)ので、202609 が先に 1 段階動く
    await h.step();
    await h.step();
    await h.step();
    await h.step();
    await h.step();
    await h.step();
    await h.step();
    await h.step();

    const start = monthlyHarness({ start: M0 - 3_600_000 });
    await start.request("auto", { startAt: M0 });
    await start.step(); // まだ動かない(idle。アラームだけ)
    start.advance(3_600_000);
    await start.settle();

    const past = monthlyHarness();
    await past.request("auto", { startAt: M0 - 1000 });
    const far = monthlyHarness();
    await far.request("catchup", { startAt: M0 + 25 * 3_600_000 });
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "step idle
      store.has 202609
      kv.put job:202609 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=manual
      kv.put jobs ["202609"]
      alarm +136800000
      request 202609 manual -> accepted
      clock +136801000
      store.has 202608
      kv.put job:202608 read running a0 n+136801000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=manual
      kv.put jobs ["202609","202608"]
      alarm +136801000
      request 202608 manual -> accepted
      src.month 20260901..20260930
      kv.put job:202609 generate running a0 n+136801000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136801000
      step 202609 read ok
      src.month 20260801..20260831
      kv.put job:202608 generate running a0 n+136801000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136801000
      step 202608 read ok
      kv.put job:202608 save running a0 n+136801000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +136801000
      step 202608 generate ok
      store.save 202608 model=null races=2 summary=null record=3fb5552c
      kv.delete job:202608
      kv.put jobs ["202609"]
      alarm +136801000
      step 202608 save ok
      kv.put job:202609 save running a0 n+136801000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +136801000
      step 202609 generate ok
      store.save 202609 model=null races=2 summary=null record=8e3a3d6c
      kv.delete job:202609
      kv.delete jobs
      step 202609 save ok
      step idle
      step idle"
    `);
    expect(text(start.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto startAt+0 -> accepted
      alarm +0
      step idle
      clock +0
      src.status 20261031
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+0 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +0
      step 202610 read ok
      clock +1000
      kv.put job:202610 save running a0 n+1000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +1000
      step 202610 generate ok
      clock +2000
      store.save 202610 model=null races=2 summary=null record=01d7313d
      kv.put job:202610 notify running a0 n+2000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +2000
      step 202610 save ok
      clock +3000
      kv.delete job:202610
      kv.delete jobs
      step 202610 notify ok
      clock +4000
      step idle"
    `);
    expect(text(past.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto startAt+-1000 -> accepted"
    `);
    expect(text(far.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=catchup
      kv.put jobs ["202610"]
      alarm +0
      request 202610 catchup startAt+90000000 -> accepted"
    `);
  });

  it("M10 作り直しの回数枠(日報とは別): 3 回まで受理し 4 回目は daily-limit。regen の記録。JST の日付が変われば数え直す。断った依頼は数えない。manual は数えない", async () => {
    const h = monthlyHarness({ start: M_NEXT });
    h.state.hasReport = true;
    await h.request("regenerate", { month: "202610" });
    await h.request("regenerate", { month: "202610" }); // in-progress
    await h.settle();
    await h.request("regenerate", { month: "202609" });
    await h.settle();
    await h.request("regenerate", { month: "202608" });
    await h.settle();
    await h.request("regenerate", { month: "202607" }); // daily-limit
    h.state.hasReport = false;
    await h.request("regenerate", { month: "202606" }); // not-exists
    await h.request("manual", { month: "202605" }); // manual は数えない(限度に達していても受理)
    h.state.hasReport = true;
    h.advance(jstMsOf("20261103", 0) - h.clock.t);
    await h.request("regenerate", { month: "202607" });
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "store.has 202610
      kv.put regen 20261102/1
      kv.put job:202610 read running a0 n+136800000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202610"]
      alarm +136800000
      request 202610 regenerate -> accepted
      request 202610 regenerate -> in-progress
      src.month 20261001..20261031
      kv.put job:202610 generate running a0 n+136800000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136800000
      step 202610 read ok
      clock +136801000
      kv.put job:202610 save running a0 n+136801000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +136801000
      step 202610 generate ok
      clock +136802000
      store.replace 202610 model=null races=2 record=590fbf94
      kv.delete job:202610
      kv.delete jobs
      step 202610 save ok
      clock +136803000
      step idle
      store.has 202609
      kv.put regen 20261102/2
      kv.put job:202609 read running a0 n+136803000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202609"]
      alarm +136803000
      request 202609 regenerate -> accepted
      src.month 20260901..20260930
      kv.put job:202609 generate running a0 n+136803000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136803000
      step 202609 read ok
      clock +136804000
      kv.put job:202609 save running a0 n+136804000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +136804000
      step 202609 generate ok
      clock +136805000
      store.replace 202609 model=null races=2 record=da1c8578
      kv.delete job:202609
      kv.delete jobs
      step 202609 save ok
      clock +136806000
      step idle
      store.has 202608
      kv.put regen 20261102/3
      kv.put job:202608 read running a0 n+136806000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202608"]
      alarm +136806000
      request 202608 regenerate -> accepted
      src.month 20260801..20260831
      kv.put job:202608 generate running a0 n+136806000 w0 s:set pend:false L0 t:- m:null calls0 rec:- nt:pending
      alarm +136806000
      step 202608 read ok
      clock +136807000
      kv.put job:202608 save running a0 n+136807000 w0 s:set pend:false L0 t:- m:null calls0 rec:set nt:pending
      alarm +136807000
      step 202608 generate ok
      clock +136808000
      store.replace 202608 model=null races=2 record=775f8dec
      kv.delete job:202608
      kv.delete jobs
      step 202608 save ok
      clock +136809000
      step idle
      store.has 202607
      request 202607 regenerate -> daily-limit
      store.has 202606
      request 202606 regenerate -> not-exists
      store.has 202605
      kv.put job:202605 read running a0 n+136809000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=manual
      kv.put jobs ["202605"]
      alarm +136809000
      request 202605 manual -> accepted
      clock +180000000
      store.has 202607
      kv.put regen 20261103/1
      kv.put job:202607 read running a0 n+180000000 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202605","202607"]
      alarm +180000000
      request 202607 regenerate -> accepted"
    `);
  });

  it("M11 依頼の断り方と getStatus: 不正な月・終わっていない月(manual・regenerate は最終日も不可、auto・catchup は最終日から可)・古すぎる月・進行中・作成済みの断り。regenerate のときだけ regenerate: true", async () => {
    const h = monthlyHarness();
    h.status();
    await h.request("auto", { month: "202613" });
    await h.request("auto", { month: "202611" }); // not-ended(最終日 11/30 は今日 10/31 より後)
    await h.request("manual"); // not-ended(最終日 10/31 = 今日)
    h.state.hasReport = true;
    await h.request("regenerate"); // not-ended
    h.state.hasReport = false;
    await h.request("auto"); // 最終日の当日から受理
    await h.request("auto"); // in-progress
    h.status();
    h.state.hasReport = true;
    await h.request("catchup", { month: "202609" }); // 最終日 9/30 は今日 10/31 の 31 日前 -> too-old
    await h.request("manual", { month: "202609" }); // exists
    h.state.hasReport = true;
    await h.request("regenerate", { month: "202609" });
    h.status("202609");
    expect(text(h.rec)).toMatchInlineSnapshot(`
      "status 202610 null
      request 202613 auto -> invalid-month
      request 202611 auto -> not-ended
      request 202610 manual -> not-ended
      request 202610 regenerate -> not-ended
      store.has 202610
      kv.put job:202610 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=auto
      kv.put jobs ["202610"]
      alarm +0
      request 202610 auto -> accepted
      request 202610 auto -> in-progress
      status 202610 {"phase":"read","status":"running","attempts":0}
      request 202609 catchup -> too-old
      store.has 202609
      request 202609 manual -> exists
      store.has 202609
      kv.put regen 20261031/1
      kv.put job:202609 read running a0 n+0 w0 s:- pend:false L0 t:- m:null calls0 rec:- nt:pending keys=[attempts,calls,createdAt,lastDayPending,llmAttempts,llmGaveUp,llmModel,llmText,mode,month,nextAt,notify,phase,record,stats,status,waits] mode=regenerate
      kv.put jobs ["202610","202609"]
      alarm +0
      request 202609 regenerate -> accepted
      status 202609 {"phase":"read","status":"running","attempts":0,"regenerate":true}"
    `);
  });
});
