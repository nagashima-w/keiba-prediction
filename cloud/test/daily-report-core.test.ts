import { describe, expect, it } from "vitest";
import type { MessageSender, ModelInfoLite } from "@keiba/core/llm";
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import {
  DailyReportCore,
  isRequestSettled,
  REPORT_MAX_LLM_ATTEMPTS,
  REPORT_MAX_STEP_ATTEMPTS,
  REPORT_NOTE_FAILED,
  REPORT_NOTE_NO_KEY,
  REPORT_NOTE_UNPARSED,
  REPORT_READ_CHUNK,
  REPORT_REGEN_DAILY_LIMIT,
  REPORT_RETRY_DELAY_MS,
  type DailyReportDeps,
  type DailyReportKv,
  type RaceInput,
  type ReportRecord,
  type ReportSource,
  type ReportStore,
  type StepOutcome,
} from "../src/daily-report-core";
import { REPORT_PROMPT_VERSION } from "../src/daily-report-prompt";
import { buildPeriodStats, buildRollingSummary, type PeriodStats } from "../src/period-stats";
import { buildDayStats, buildRaceDigest } from "../src/daily-report-digest";
import { DEFAULT_CLOUD_SETTINGS, type AnalysisModelId } from "../src/settings";
import type { DiscordPayload } from "../../packages/core/src/notify/discord";

/**
 * Issue #235: 日報の作成の流れ(`DailyReportCore`)。D1・R2・LLM・Discord・時計・アラームは偽物で、
 * 一覧 → 収集(複数回に分ける)→ 生成(LLM 1 回)→ 保存 → 通知 の進め方・冪等性・失敗の扱いを確かめる。
 */

const T0 = Date.parse("2026-10-10T11:00:00.000Z"); // JST 20:00(開催日 20261010 の夜)
const DATE = "20261010";

function memoryKv(): DailyReportKv & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => (data.has(key) ? (JSON.parse(JSON.stringify(data.get(key))) as T) : undefined),
    put: (key: string, value: unknown) => void data.set(key, JSON.parse(JSON.stringify(value))),
    delete: (key: string) => void data.delete(key),
  };
}

function horse(umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}

const raceIdOf = (n: number): string => `2026050308${String(n).padStart(2, "0")}`;

function raceInput(n: number, withResult = true): RaceInput {
  const raceId = raceIdOf(n);
  const view: AnalysisView = {
    id: 100 + n, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber: n, raceName: `テスト${n}S`, grade: null, startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result", placeBasis: "top3" },
    horses: [horse(1, { mark: "◎" }), horse(2, { mark: "〇" })], detail: "present",
    allocation: { route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok", bets: [{ betType: "win", comboKey: "01", stake: 200, odds: 3, ev: 1.1 }] },
  };
  const result: RaceResultData | undefined = withResult
    ? { horses: [{ umaban: 1, finishPosition: 1, winPayout: 350, placePayout: 130 }, { umaban: 2, finishPosition: 2, winPayout: null, placePayout: 120 }, { umaban: 3, finishPosition: 3, winPayout: null, placePayout: 150 }], combos: {} }
    : undefined;
  return { view, result };
}

const NARRATIVE_JSON = (races: string[] = []): string =>
  JSON.stringify({ summary: "20 レースを分析しました。", good: ["◎の取りこぼしが少ない"], improve: ["荒れたレースが弱い"], races: races.map((raceId) => ({ raceId, comment: "振り返り" })) });

/** 直前 27 日の統計(偽)。数字は明示(賭け金 40,000 円・払戻 34,000 円・開催 6 日)。 */
function priorStats(over: Partial<PeriodStats> = {}): PeriodStats {
  return {
    ...buildPeriodStats({ races: [], bets: [], marks: [], results: [], combos: [], imports: [] }, { fromDate: "20260913", toDate: "20261009" }),
    dayCount: 6, raceCount: 120, resultRaceCount: 118, noResultRaceCount: 2, betRaceCount: 110, totalStake: 40000, totalReturn: 34000, recoveryRate: 0.85,
    judgedBetCount: 300, hitBetCount: 24, expectedBetCount: 300, expectedHits: 21.5, expectedBaseHits: 24, maxPayout: 9000, maxPayoutStake: 300,
    ...over,
  };
}

interface Harness {
  readonly core: DailyReportCore;
  readonly kv: ReturnType<typeof memoryKv>;
  readonly clock: { t: number };
  readonly alarms: number[];
  readonly warns: string[];
  readonly saved: ReportRecord[];
  /** `replaceReport`(作り直しの上書き。Issue #268)に渡された記録。 */
  readonly replaced: ReportRecord[];
  readonly sent: DiscordPayload[];
  readonly prompts: string[];
  /** LLM に送ったリクエストのモデル ID(送った順)。 */
  readonly models: string[];
  /** LLM に送ったリクエストの max_tokens(送った順)。 */
  readonly maxTokens: number[];
  readonly readCalls: number[];
  /** 期間の再集計の呼び出し(from, to)。 */
  readonly periodCalls: Array<[string, string]>;
  readonly state: { period: PeriodStats; failPeriod: number; analyses: { raceId: string; analysisId: number }[]; inputs: Map<number, RaceInput>; failRead: number; failSave: number; hasReport: boolean; llmFailures: number; llmText: string; notifyFails: boolean; saveResult: "saved" | "exists"; allMissing: boolean; hasReportCalls: number; replaceResult: "replaced" | "kept"; failReplace: number };
  step(): Promise<StepOutcome>;
  drain(max?: number): Promise<StepOutcome[]>;
}

function harness(options: { raceCount?: number; llm?: boolean; notifier?: boolean; appBaseUrl?: string; kv?: ReturnType<typeof memoryKv>; analysisModel?: AnalysisModelId; lister?: () => Promise<ReadonlyArray<ModelInfoLite>>; start?: number } = {}): Harness {
  const kv = options.kv ?? memoryKv();
  const clock = { t: options.start ?? T0 };
  const alarms: number[] = [];
  const warns: string[] = [];
  const saved: ReportRecord[] = [];
  const replaced: ReportRecord[] = [];
  const sent: DiscordPayload[] = [];
  const prompts: string[] = [];
  const models: string[] = [];
  const maxTokens: number[] = [];
  const readCalls: number[] = [];
  const periodCalls: Array<[string, string]> = [];
  const raceCount = options.raceCount ?? 20;
  const state: Harness["state"] = {
    period: priorStats(),
    failPeriod: 0,
    analyses: Array.from({ length: raceCount }, (_, i) => ({ raceId: raceIdOf(i + 1), analysisId: 101 + i })),
    inputs: new Map(Array.from({ length: raceCount }, (_, i) => [101 + i, raceInput(i + 1, i !== 3)])),
    failRead: 0,
    failSave: 0,
    hasReport: false,
    llmFailures: 0,
    llmText: NARRATIVE_JSON(),
    notifyFails: false,
    saveResult: "saved",
    allMissing: false,
    hasReportCalls: 0,
    replaceResult: "replaced",
    failReplace: 0,
  };
  const source: ReportSource = {
    listDayAnalyses: async () => state.analyses,
    readRaces: async (items) => {
      readCalls.push(items.length);
      if (state.failRead > 0) {
        state.failRead -= 1;
        throw new Error("D1 が落ちた");
      }
      return items.map((i) => (state.allMissing ? null : (state.inputs.get(i.analysisId) ?? null)));
    },
    readPeriodStats: async (fromDate, toDate) => {
      periodCalls.push([fromDate, toDate]);
      if (state.failPeriod > 0) {
        state.failPeriod -= 1;
        throw new Error("D1 が落ちた(期間)");
      }
      return { ...state.period, fromDate, toDate };
    },
  };
  const store: ReportStore = {
    hasReport: async () => {
      state.hasReportCalls += 1;
      return state.hasReport;
    },
    saveReport: async (record) => {
      if (state.failSave > 0) {
        state.failSave -= 1;
        throw new Error("D1 書き込み失敗");
      }
      if (state.saveResult === "exists") {
        return "exists";
      }
      saved.push(record);
      state.hasReport = true;
      return "saved";
    },
    replaceReport: async (record) => {
      if (state.failReplace > 0) {
        state.failReplace -= 1;
        throw new Error("D1 書き込み失敗(上書き)");
      }
      if (state.replaceResult === "kept") {
        return "kept";
      }
      replaced.push(record);
      return "replaced";
    },
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
  const deps: DailyReportDeps = {
    kv,
    now: () => clock.t,
    setAlarm: (at) => void alarms.push(at),
    onWarn: (m) => void warns.push(m),
    source,
    store,
    loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS, analysisModel: options.analysisModel ?? DEFAULT_CLOUD_SETTINGS.analysisModel }),
    ...(options.llm === false ? {} : { llm: { sender, ...(options.lister === undefined ? {} : { lister: options.lister }) } }),
    ...(options.notifier === false
      ? {}
      : {
          notifier: {
            send: async (payload: DiscordPayload) => {
              sent.push(payload);
              if (state.notifyFails) {
                throw new Error("discord down");
              }
            },
          },
        }),
    ...(options.appBaseUrl === undefined ? {} : { appBaseUrl: options.appBaseUrl }),
  };
  const core = new DailyReportCore(deps);
  return {
    core, kv, clock, alarms, warns, saved, replaced, sent, prompts, models, maxTokens, readCalls, periodCalls, state,
    step: () => core.runNextStep(),
    async drain(max = 60) {
      const outcomes: StepOutcome[] = [];
      for (let i = 0; i < max; i += 1) {
        const o = await core.runNextStep();
        outcomes.push(o);
        if (o.kind === "idle") break;
        clock.t += 1000;
      }
      return outcomes;
    },
  };
}

describe("requestReport", () => {
  it("今日以前の開催日は受け付け、アラームを今に設定する。未来・不正な日付は受け付けない(状態は作らない)", async () => {
    const h = harness();
    expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" })).toStrictEqual({ accepted: true });
    expect(h.alarms).toEqual([T0]);
    const other = harness();
    expect(await other.core.requestReport({ kaisaiDate: "20261011", mode: "manual" })).toStrictEqual({ accepted: false, reason: "future-date" });
    expect(await other.core.requestReport({ kaisaiDate: "20261340", mode: "manual" })).toStrictEqual({ accepted: false, reason: "invalid-date" });
    expect(await other.core.requestReport({ kaisaiDate: "2026-10-10", mode: "manual" })).toStrictEqual({ accepted: false, reason: "invalid-date" });
    expect(other.kv.data.size).toBe(0);
    expect(other.alarms).toEqual([]);
  });

  it("進行中の日は受け付けない(in-progress)。作成済みの日は受け付けない(exists。1 日 1 回で確定)", async () => {
    const h = harness();
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" })).toStrictEqual({ accepted: false, reason: "in-progress" });
    await h.drain();
    expect(h.saved).toHaveLength(1);
    expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" })).toStrictEqual({ accepted: false, reason: "exists" });
  });
});

describe("一連の流れ(list → gather → generate → save → notify)", () => {
  it("20 レースを、収集は REPORT_READ_CHUNK 件ずつに分けて読み、LLM は 1 回、保存は 1 回、通知は 1 回", async () => {
    const h = harness({ appBaseUrl: "https://example.com" });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    const outcomes = await h.drain();
    expect(h.readCalls).toEqual([8, 8, 4]); // 20 件を 8・8・4 に分ける
    expect(REPORT_READ_CHUNK).toBe(8);
    expect(Math.max(...h.readCalls)).toBeLessThanOrEqual(REPORT_READ_CHUNK);
    expect(h.prompts).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    const phases = outcomes.filter((o) => o.kind === "ran").map((o) => (o as { phase: string }).phase);
    expect(phases).toEqual(["list", "gather", "gather", "gather", "generate", "save", "notify"]);
    expect(outcomes[outcomes.length - 1]).toStrictEqual({ kind: "idle" });
    expect(h.kv.data.size).toBe(0); // 終わったジョブは消える(日報は D1 が正)
  });

  it("保存する日報: 件数・統計(結果なしのレースを数える)・文章・モデル・レース別の行", async () => {
    const h = harness();
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const r = h.saved[0]!;
    expect(r.kaisaiDate).toBe(DATE);
    expect(r.raceCount).toBe(20);
    expect(r.summary).toBe("20 レースを分析しました。");
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.totalStake).toBe(19 * 200); // 結果なしの 1 レース(4 番目)の買い目は判定不能で賭け金に入れない
    expect(r.totalReturn).toBe(19 * 700);
    expect(r.body.stats.noResultRaceCount).toBe(1);
    expect(r.body.stats.resultRaceCount).toBe(19);
    expect(r.body.narrative?.good).toEqual(["◎の取りこぼしが少ない"]);
    expect(r.body.note).toBeNull();
    expect(r.body.races).toHaveLength(20);
    expect(r.body.races[0]).toMatchObject({ raceId: raceIdOf(1), hasResult: true, top3: [{ umaban: 1, finishPosition: 1 }, { umaban: 2 }, { umaban: 3 }] });
    expect(r.body.races[3]).toMatchObject({ raceId: raceIdOf(4), hasResult: false, top3: [] });
    expect(JSON.parse(r.llmCallsJson!)).toHaveLength(1);
  });

  it("レース別コメントは、今日のレースの raceId のものを body.races に付ける", async () => {
    const h = harness({ raceCount: 3 });
    h.state.llmText = NARRATIVE_JSON([raceIdOf(2)]);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const races = h.saved[0]!.body.races;
    expect(races.map((x) => x.comment)).toEqual([null, "振り返り", null]);
  });

  it("プロンプトに全レースの raceId と確定した統計が入る", async () => {
    const h = harness({ raceCount: 3 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    for (let n = 1; n <= 3; n += 1) {
      expect(h.prompts[0]).toContain(raceIdOf(n));
    }
    expect(h.prompts[0]).toContain("2026年10月10日(土)");
  });

  it("通知は Discord の embed を 1 件。リンクは基点があるときだけ付く", async () => {
    const withLink = harness({ raceCount: 2, appBaseUrl: "https://example.com" });
    await withLink.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await withLink.drain();
    const embed = withLink.sent[0]!.embeds![0]! as { title?: string; url?: string; description?: string };
    expect(embed.title).toBe("日報 2026年10月10日(土)");
    expect(embed.url).toBe("https://example.com/#report=20261010");
    expect(embed.description).toBe("20 レースを分析しました。");
    const noLink = harness({ raceCount: 2 });
    await noLink.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await noLink.drain();
    expect("url" in (noLink.sent[0]!.embeds![0]! as object)).toBe(false);
  });

  it("その日の分析が無ければ、日報は作らず(保存も通知も LLM も無し)、ジョブは消える", async () => {
    const h = harness();
    h.state.analyses = [];
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    const outcomes = await h.drain();
    expect(outcomes[0]).toStrictEqual({ kind: "ran", kaisaiDate: DATE, phase: "list", result: "no-analyses" });
    expect(h.saved).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
    expect(h.kv.data.size).toBe(0);
  });

  it("分析の読み出しで見つからなかったレース(null)は飛ばして続ける", async () => {
    const h = harness({ raceCount: 3 });
    h.state.inputs.delete(102);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.saved[0]!.raceCount).toBe(2);
  });
});

describe("LLM が使えない・失敗したとき", () => {
  it("キー未登録(llm なし)は、LLM を呼ばず統計だけの日報を保存し、Discord には固定の理由と成績を送る", async () => {
    const h = harness({ llm: false, raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const r = h.saved[0]!;
    expect(h.prompts).toHaveLength(0);
    expect(r.body.narrative).toBeNull();
    expect(r.body.note).toBe(REPORT_NOTE_NO_KEY);
    expect(r.model).toBeNull();
    expect(r.summary).toBeNull();
    expect(r.llmCallsJson).toBeNull();
    expect((h.sent[0]!.embeds![0] as { description?: string }).description).toBe(REPORT_NOTE_NO_KEY);
  });

  it(`LLM が失敗したら ${REPORT_RETRY_DELAY_MS / 1000} 秒後に 1 回だけ再試行する。再試行で成功すれば文章つきで保存する`, async () => {
    const h = harness({ raceCount: 2 });
    h.state.llmFailures = 1;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 3; i += 1) await h.step(); // list, gather, generate(失敗)
    expect(h.prompts).toHaveLength(1);
    const before = h.alarms[h.alarms.length - 1]!;
    expect(before).toBeGreaterThanOrEqual(h.clock.t + REPORT_RETRY_DELAY_MS - 1);
    expect(await h.step()).toStrictEqual({ kind: "idle" }); // まだ時刻が来ていない
    h.clock.t = before;
    await h.drain();
    expect(h.prompts).toHaveLength(2);
    expect(h.saved[0]!.body.narrative).not.toBeNull();
  });

  it(`LLM が ${REPORT_MAX_LLM_ATTEMPTS} 回続けて失敗したら、統計だけの日報にして固定の理由を残す(API のエラー本文は残さない)`, async () => {
    const h = harness({ raceCount: 2 });
    h.state.llmFailures = 99;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 30; i += 1) {
      await h.step();
      h.clock.t += REPORT_RETRY_DELAY_MS;
    }
    expect(h.prompts).toHaveLength(REPORT_MAX_LLM_ATTEMPTS);
    const r = h.saved[0]!;
    expect(r.body.narrative).toBeNull();
    expect(r.body.note).toBe(REPORT_NOTE_FAILED);
    expect(JSON.stringify(r)).not.toContain("boom");
    expect(JSON.parse(r.llmCallsJson!)).toHaveLength(REPORT_MAX_LLM_ATTEMPTS);
  });

  it("応答が JSON として読めなければ、生の文章を narrativeRaw に残し、総括には先頭を使う(固定の注記つき)", async () => {
    const h = harness({ raceCount: 2 });
    h.state.llmText = "今日は良い一日でした。".repeat(100);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const r = h.saved[0]!;
    expect(r.body.narrative).toBeNull();
    expect(r.body.narrativeRaw).toContain("今日は良い一日でした。");
    expect(r.body.note).toBe(REPORT_NOTE_UNPARSED);
    expect(r.summary!.startsWith("今日は良い一日でした。")).toBe(true);
    expect(r.summary!.length).toBeLessThanOrEqual(400);
  });
});

describe("冪等性・失敗の扱い", () => {
  it("保存に失敗しても、再試行では LLM を呼び直さない(応答を保持している)", async () => {
    const h = harness({ raceCount: 2 });
    h.state.failSave = 1;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 4; i += 1) await h.step(); // list, gather, generate, save(失敗)
    expect(h.saved).toHaveLength(0);
    expect(h.prompts).toHaveLength(1);
    h.clock.t += REPORT_RETRY_DELAY_MS;
    await h.drain();
    expect(h.saved).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it("収集の読み出しが失敗したら間隔を空けて再試行する。上限を超えたらジョブは failed になり、アラームは張らない。手動の再依頼で最初からやり直せる", async () => {
    const h = harness({ raceCount: 2 });
    h.state.failRead = 99;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 12; i += 1) {
      await h.step();
      h.clock.t += REPORT_RETRY_DELAY_MS;
    }
    expect(h.readCalls).toHaveLength(REPORT_MAX_STEP_ATTEMPTS);
    expect(h.core.getStatus(DATE)).toMatchObject({ status: "failed", phase: "gather" });
    const alarmsAfterFail = h.alarms.length;
    expect(await h.step()).toStrictEqual({ kind: "idle" });
    expect(h.alarms).toHaveLength(alarmsAfterFail);
    expect(h.saved).toHaveLength(0);
    // 手動で再依頼すると、最初からやり直す
    h.state.failRead = 0;
    expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" })).toStrictEqual({ accepted: true });
    await h.drain();
    expect(h.saved).toHaveLength(1);
  });

  it("失敗の状態に、エラーの本文は残さない(固定の語だけ)", async () => {
    const h = harness({ raceCount: 2 });
    h.state.failRead = 99;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 12; i += 1) {
      await h.step();
      h.clock.t += REPORT_RETRY_DELAY_MS;
    }
    expect(JSON.stringify([...h.kv.data.values()])).not.toContain("D1 が落ちた");
    expect(JSON.stringify(h.core.getStatus(DATE))).not.toContain("D1 が落ちた");
  });

  it("通知は多くとも 1 回: 送信が失敗しても再送しない。送信中に落ちた(sending のまま)ジョブは、再起動後に送らずに終える", async () => {
    const h = harness({ raceCount: 2 });
    h.state.notifyFails = true;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect(h.saved).toHaveLength(1); // 日報は保存済み(通知の失敗は日報を巻き戻さない)
    expect(h.kv.data.size).toBe(0);
    expect(h.warns.join("\n")).toContain("Discord");

    // 送信の直前に落ちた状態を再現: notify が sending のジョブを、別のインスタンスが引き継ぐ。
    const kv = memoryKv();
    const first = harness({ raceCount: 2, kv });
    await first.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 4; i += 1) await first.step(); // list, gather, generate, save(notify の前まで)
    const job = kv.get<Record<string, unknown>>(`job:${DATE}`)!;
    expect(job["phase"]).toBe("notify");
    kv.put(`job:${DATE}`, { ...job, notify: "sending" });
    const second = harness({ raceCount: 2, kv });
    await second.drain();
    expect(second.sent).toHaveLength(0);
    expect(kv.data.has(`job:${DATE}`)).toBe(false);
  });

  it("通知の仕組みが無い(notifier なし)なら、保存して終わる", async () => {
    const h = harness({ raceCount: 2, notifier: false });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.saved).toHaveLength(1);
    expect(h.kv.data.size).toBe(0);
  });

  it("保存の時点で、既に同じ日の日報があれば(別経路が先に作った)、上書きせず通知も送らない", async () => {
    const h = harness({ raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    h.state.saveResult = "exists"; // 保存の直前に他が作った状態
    await h.drain();
    expect(h.sent).toHaveLength(0);
    expect(h.kv.data.size).toBe(0);
  });

  it("2 日分のジョブは別々に進み、アラームは最も早い時刻に張る", async () => {
    const h = harness({ raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: "20261009", mode: "auto" });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await h.drain();
    expect(h.saved.map((r) => r.kaisaiDate).sort()).toEqual(["20261009", DATE]);
  });
});

describe("getStatus", () => {
  it("ジョブが無ければ null。あれば段階と状態を返す(固定の語と数だけ)", async () => {
    const h = harness({ raceCount: 2 });
    expect(h.core.getStatus(DATE)).toBeNull();
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    expect(h.core.getStatus(DATE)).toStrictEqual({ phase: "list", status: "running", attempts: 0 });
    await h.step();
    expect(h.core.getStatus(DATE)).toMatchObject({ phase: "gather", status: "running" });
  });
});

describe("R2: auto・catchup の依頼は、JST の今日から 3 日前までの開催日に限る(manual は上限なし)", () => {
  // 基準: JST 2026-10-10 20:00(T0)。今日 = 20261010、3 日前 = 20261007。
  it.each([
    ["今日", "20261010", "auto", true],
    ["3 日前(受ける)", "20261007", "auto", true],
    ["4 日前(断る)", "20261006", "auto", false],
    ["ずっと前(断る)", "20200101", "auto", false],
    ["3 日前(catchup も受ける)", "20261007", "catchup", true],
    ["4 日前(catchup も断る)", "20261006", "catchup", false],
    ["4 日前でも manual は受ける", "20261006", "manual", true],
    ["ずっと前でも manual は受ける", "20200101", "manual", true],
  ] as const)("%s: %s を %s で依頼 → 受理=%s", async (_name, kaisaiDate, mode, accepted) => {
    const h = harness();
    const result = await h.core.requestReport({ kaisaiDate, mode });
    expect(result).toStrictEqual(accepted ? { accepted: true } : { accepted: false, reason: "too-old" });
    // 断ったときは状態もアラームも作らない(LLM・D1 に出ない)
    expect(h.kv.data.size).toBe(accepted ? 2 : 0);
    expect(h.alarms.length).toBe(accepted ? 1 : 0);
  });

  it("JST の日付の切り替わりで境界が動く: 23:59:59(JST 10/10)は 10/7 を受け、0:00(JST 10/11)は 10/7 を断って 10/8 を受ける", async () => {
    const before = harness({ start: Date.parse("2026-10-10T14:59:59.000Z") });
    expect(await before.core.requestReport({ kaisaiDate: "20261007", mode: "auto" })).toStrictEqual({ accepted: true });
    expect(await before.core.requestReport({ kaisaiDate: "20261006", mode: "auto" })).toStrictEqual({ accepted: false, reason: "too-old" });
    const after = harness({ start: Date.parse("2026-10-10T15:00:00.000Z") });
    expect(await after.core.requestReport({ kaisaiDate: "20261007", mode: "auto" })).toStrictEqual({ accepted: false, reason: "too-old" });
    expect(await after.core.requestReport({ kaisaiDate: "20261008", mode: "auto" })).toStrictEqual({ accepted: true });
  });

  it("月またぎ: 10/2 の 3 日前は 9/29(受ける)、その前の 9/28 は断る", async () => {
    const h = harness({ start: Date.parse("2026-10-02T03:00:00.000Z") });
    expect(await h.core.requestReport({ kaisaiDate: "20260929", mode: "auto" })).toStrictEqual({ accepted: true });
    expect(await h.core.requestReport({ kaisaiDate: "20260928", mode: "auto" })).toStrictEqual({ accepted: false, reason: "too-old" });
  });

  it("古さの判定は、作成済みの判定(D1 の hasReport)より前: 古い日の依頼は D1 を引かない。新しい日は引く(対照)", async () => {
    const h = harness();
    await h.core.requestReport({ kaisaiDate: "20261006", mode: "auto" });
    expect(h.state.hasReportCalls).toBe(0);
    await h.core.requestReport({ kaisaiDate: "20261007", mode: "auto" });
    expect(h.state.hasReportCalls).toBe(1);
  });
});

describe("L1〜L4: 日報の LLM は設定の analysisModel を使う", () => {
  const LIST: ModelInfoLite[] = [
    { id: "claude-sonnet-4-5", created_at: "2025-09-29T00:00:00Z" },
    { id: "claude-sonnet-5-5", created_at: "2026-09-01T00:00:00Z" },
    { id: "claude-sonnet-6", created_at: "2026-10-01T00:00:00Z" }, // 固定モデル(claude-sonnet-5-5)より新しい Sonnet(自動選択と固定を区別するため)
    { id: "claude-opus-4-1", created_at: "2025-08-05T00:00:00Z" },
    { id: "claude-opus-4-7", created_at: "2026-04-01T00:00:00Z" },
    { id: "claude-haiku-4-5", created_at: "2025-10-01T00:00:00Z" },
    { id: "claude-haiku-4-8", created_at: "2026-06-01T00:00:00Z" },
  ];
  const run = async (analysisModel: AnalysisModelId | undefined, withLister: boolean) => {
    const h = harness({ raceCount: 2, ...(analysisModel === undefined ? {} : { analysisModel }), ...(withLister ? { lister: async () => LIST } : {}) });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    return h;
  };

  it.each([
    ["L1: opus を設定したら、一覧の最新の Opus で送る", "opus", "claude-opus-4-7"],
    ["L2: haiku を設定したら、一覧の最新の Haiku で送る", "haiku", "claude-haiku-4-8"],
    ["L3: sonnet を設定したら、一覧の最新の Sonnet で送る", "sonnet", "claude-sonnet-6"],
    ["L4: auto を設定したら自動選択(最新の Sonnet)で送る", "auto", "claude-sonnet-6"],
  ] as const)("%s", async (_name, analysisModel, expected) => {
    const h = await run(analysisModel, true);
    expect(h.models).toEqual([expected]);
  });

  it("系統の最新が一覧に無い(opus を設定したが一覧に Opus が無い)ときは、固定モデルで送る", async () => {
    const h = harness({ raceCount: 2, analysisModel: "opus", lister: async () => LIST.filter((m) => !m.id.includes("opus")) });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.models).toEqual(["claude-sonnet-5-5"]);
  });

  it("モデル一覧を取れない(lister が無い・失敗する)ときは、固定モデルで送る(日報は止まらない)", async () => {
    const none = await run("opus", false);
    expect(none.models).toEqual(["claude-sonnet-5-5"]);
    const failing = harness({ raceCount: 2, analysisModel: "opus", lister: async () => { throw new Error("list failed"); } });
    await failing.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await failing.drain();
    expect(failing.models).toEqual(["claude-sonnet-5-5"]);
    expect(failing.saved).toHaveLength(1);
  });
});

describe("C9: 通知は送る前に sending を書く(送信の途中で落ちても二度送らない)", () => {
  it("send が呼ばれた時点で、ジョブの notify はすでに sending(送る前に書いている)", async () => {
    const kv = memoryKv();
    const h = harness({ raceCount: 2, kv, notifier: false });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 4; i += 1) await h.step(); // list, gather, generate, save → notify の直前
    const before = kv.get<Record<string, unknown>>(`job:${DATE}`)!;
    expect(before["phase"]).toBe("notify");
    expect(before["notify"]).toBe("pending"); // 前提(空振り防止): 送る前は pending
    const seenDuringSend: unknown[] = [];
    const core = new DailyReportCore({
      kv,
      now: () => h.clock.t,
      setAlarm: () => {},
      onWarn: () => {},
      source: { listDayAnalyses: async () => [], readRaces: async () => [], readPeriodStats: async () => priorStats() },
      store: { hasReport: async () => false, saveReport: async () => "saved", replaceReport: async () => "replaced" },
      loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
      notifier: { send: async () => void seenDuringSend.push(kv.get<Record<string, unknown>>(`job:${DATE}`)?.["notify"]) },
    });
    await core.runNextStep();
    expect(seenDuringSend).toEqual(["sending"]);
  });

  it("送信の途中で落ちた(send の最中に別のインスタンスが同じジョブを引き継いだ)想定で再実行しても、二度送らない", async () => {
    const kv = memoryKv();
    const h = harness({ raceCount: 2, kv, notifier: false });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 4; i += 1) await h.step();
    const sentByRestarted: DiscordPayload[] = [];
    const build = (send: (p: DiscordPayload) => Promise<void>) =>
      new DailyReportCore({
        kv,
        now: () => h.clock.t,
        setAlarm: () => {},
        onWarn: () => {},
        source: { listDayAnalyses: async () => [], readRaces: async () => [], readPeriodStats: async () => priorStats() },
        store: { hasReport: async () => false, saveReport: async () => "saved", replaceReport: async () => "replaced" },
        loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
        notifier: { send },
      });
    // 1 つ目のインスタンスは、送信の途中(応答待ち)で止まる。そのあいだに 2 つ目のインスタンス(再起動後)が同じジョブを実行する。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = build(async () => {
      await gate;
    });
    const firstRun = first.runNextStep();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = build(async (p) => {
      sentByRestarted.push(p);
    });
    await second.runNextStep();
    release();
    await firstRun;
    expect(sentByRestarted).toHaveLength(0); // sending を見て、再送しない
  });
});

describe("C7(Issue #255): LLM の試行は、呼ぶ前に永続化する(呼び出しの最中に落ちても、試行の数が戻らず、無限に続かない)", () => {
  it("応答を待っている最中(別インスタンスから見て)に llmAttempts が 1 になっている。再起動後の失敗で上限(2 回)に達し、統計だけの日報で終える", async () => {
    expect(REPORT_MAX_LLM_ATTEMPTS).toBe(2); // 前提: 上限は 2 回(1 回落ちたあとの 1 回で上限に達する)
    const kv = memoryKv();
    const h = harness({ raceCount: 2, kv, notifier: false });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.step(); // list
    await h.step(); // gather
    const before = kv.get<Record<string, unknown>>(`job:${DATE}`)!;
    expect(before["phase"]).toBe("generate"); // 前提(空振り防止): 次は生成の段階
    expect(before["llmAttempts"]).toBe(0);
    expect(before["llmText"]).toBeNull();

    const saved: ReportRecord[] = [];
    const build = (sender: MessageSender) =>
      new DailyReportCore({
        kv,
        now: () => h.clock.t,
        setAlarm: () => {},
        onWarn: () => {},
        source: { listDayAnalyses: async () => [], readRaces: async () => [], readPeriodStats: async () => priorStats() },
        store: {
          hasReport: async () => false,
          replaceReport: async () => "replaced",
          saveReport: async (r) => {
            saved.push(r);
            return "saved";
          },
        },
        loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
        llm: { sender },
      });

    // 1 つ目のインスタンス: LLM の応答を待ったまま戻らない(DO が落ちた・追い出された想定。応答は来ない)。
    let senderCalled!: () => void;
    const called = new Promise<void>((resolve) => (senderCalled = resolve));
    const hung = build(
      () =>
        new Promise(() => {
          senderCalled();
        }),
    );
    void hung.runNextStep();
    await called;
    const during = kv.get<Record<string, unknown>>(`job:${DATE}`)!;
    expect(during["phase"]).toBe("generate");
    expect(during["llmText"]).toBeNull(); // 前提: まだ応答は無い
    expect(during["llmAttempts"]).toBe(1); // 呼ぶ前に書いてある(これを呼んだあとに書く実装だと 0 のまま)

    // 2 つ目のインスタンス(再起動後): 同じジョブを引き継ぐ。試行は 1 から数え続け、この呼び出しの失敗で上限に達する。
    let secondCalls = 0;
    const restarted = build(async () => {
      secondCalls += 1;
      throw Object.assign(new Error("boom"), { status: 529 });
    });
    for (let i = 0; i < 4 && saved.length === 0; i += 1) {
      await restarted.runNextStep();
      h.clock.t += REPORT_RETRY_DELAY_MS;
    }
    expect(secondCalls).toBe(1); // 試行は積み上がっているので、再起動後の呼び出しは 1 回だけで諦める(0 から数え直すと 2 回呼ぶ)
    expect(saved).toHaveLength(1);
    expect(saved[0]!.body.narrative).toBeNull();
    expect(saved[0]!.body.note).toBe(REPORT_NOTE_FAILED);
  });
});

describe("Z2: 分析は列挙されたが詳細が全件読めなかった(ダイジェスト 0 件)ときは、LLM を呼ばず・保存せず・通知せずに終える", () => {
  it("読み出しが全件 null なら no-analyses で終わり、ジョブは消える", async () => {
    const h = harness({ raceCount: 3 });
    h.state.allMissing = true;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    const outcomes = await h.drain();
    const gather = outcomes.filter((o) => o.kind === "ran" && o.phase === "gather");
    expect(gather.map((o) => (o as { result: string }).result)).toEqual(["no-analyses"]);
    expect(h.prompts).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.kv.data.size).toBe(0);
  });

  it("一部が null でも、1 件でも読めれば続ける(対照)", async () => {
    const h = harness({ raceCount: 3 });
    h.state.inputs.delete(101);
    h.state.inputs.delete(102);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.raceCount).toBe(1);
  });
});

describe("isRequestSettled: 日単位の DO が依頼を完了として扱うか(too-old は完了=印を書いて再依頼しない)", () => {
  it.each([
    [{ accepted: true }, true],
    [{ accepted: false, reason: "exists" }, true],
    [{ accepted: false, reason: "in-progress" }, true],
    [{ accepted: false, reason: "too-old" }, true],
    [{ accepted: false, reason: "invalid-date" }, false],
    [{ accepted: false, reason: "future-date" }, false],
  ] as const)("%j → %s", (result, expected) => {
    expect(isRequestSettled(result as never)).toBe(expected);
  });
});


describe("Issue #264: 直近 4 週の累計(直前 27 日を再集計して、その日の統計に足す)", () => {
  it("generate の段階で、その日を除く直前 27 日 [D−27, D−1] を 1 回だけ読む。段階の並びは変わらない(段階を足さない)", async () => {
    const h = harness({ raceCount: 3 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    const outcomes = await h.drain();
    expect(h.periodCalls).toEqual([["20260913", "20261009"]]);
    const phases = outcomes.filter((o) => o.kind === "ran").map((o) => (o as { phase: string }).phase);
    expect(phases).toEqual(["list", "gather", "generate", "save", "notify"]);
  });

  it("LLM に渡すプロンプトに、直前 27 日と 28 日累計の確定値が入る(読み出しは LLM の呼び出しより前)", async () => {
    const h = harness({ raceCount: 3 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("## 直前 27 日(その日を除く)の成績(確定値)");
    expect(h.prompts[0]).toContain("賭け金 40,000円・払戻 34,000円・回収率 85.0%");
    expect(h.prompts[0]).toContain("## 直近 28 日の累計(その日を含む)の成績(確定値)");
    expect(h.prompts[0]).toContain("2026年9月13日〜2026年10月10日");
  });

  it("保存する日報の本文に rolling(LLM に渡した数字そのもの)と promptVersion を残す。28 日累計 = 直前 27 日 + その日の統計", async () => {
    const h = harness({ raceCount: 3 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const body = h.saved[0]!.body;
    expect(body.promptVersion).toBe(REPORT_PROMPT_VERSION);
    const expected = buildRollingSummary(DATE, body.stats, { ...priorStats(), fromDate: "20260913", toDate: "20261009" });
    expect(body.rolling).toStrictEqual(expected);
    // 前提(空振り防止): 足し算が働いている(その日の賭け金が 0 でなく、累計が直前 27 日より大きい)
    expect(body.stats.totalStake).toBeGreaterThan(0);
    expect(body.rolling!.total.totalStake).toBe(40000 + body.stats.totalStake);
    expect(body.rolling!.total.totalStake).toBeGreaterThan(body.rolling!.prior.totalStake);
    expect(body.rolling!.total.fromDate).toBe("20260913");
    expect(body.rolling!.total.toDate).toBe(DATE);
    // 統計(その日)は従来どおり日報の統計のまま
    expect(body.stats).toStrictEqual(buildDayStats([...Array(3)].map((_, i) => buildRaceDigest(raceInput(i + 1, i !== 3).view, raceInput(i + 1, i !== 3).result))));
  });

  it("キー未登録(LLM なし)の統計だけの日報にも rolling を残す(画面と Discord が出す)", async () => {
    const h = harness({ raceCount: 2, llm: false });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.prompts).toHaveLength(0);
    expect(h.periodCalls).toHaveLength(1);
    expect(h.saved[0]!.body.rolling).toBeDefined();
    expect(h.saved[0]!.body.promptVersion).toBe(REPORT_PROMPT_VERSION);
  });

  it("読み出しに失敗したら、LLM を呼ばずに間隔を空けて再試行する。上限を超えたらジョブは failed になり、4 週の累計なしの日報は保存しない", async () => {
    const h = harness({ raceCount: 2 });
    h.state.failPeriod = 99;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    for (let i = 0; i < 12; i += 1) {
      await h.step();
      h.clock.t += REPORT_RETRY_DELAY_MS;
    }
    expect(h.periodCalls).toHaveLength(REPORT_MAX_STEP_ATTEMPTS);
    expect(h.core.getStatus(DATE)).toMatchObject({ status: "failed", phase: "generate" });
    expect(h.prompts).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(JSON.stringify(h.kv.get(`job:${DATE}`))).not.toContain("D1 が落ちた"); // ジョブの状態にエラーの本文は残さない
  });

  it("一過性の失敗(1 回)なら、再試行で成功して日報は 4 週の累計つきで保存される", async () => {
    const h = harness({ raceCount: 2 });
    h.state.failPeriod = 1;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.step(); // list
    await h.step(); // gather
    expect(await h.step()).toMatchObject({ kind: "ran", phase: "generate", result: "retry" }); // 1 回目の読み出しが失敗
    expect(h.prompts).toHaveLength(0);
    h.clock.t += REPORT_RETRY_DELAY_MS;
    await h.drain();
    expect(h.periodCalls).toHaveLength(2);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.body.rolling).toBeDefined();
  });

  it("読んだ累計はジョブに永続化し、LLM の再試行では読み直さない(同じ数字で再試行する)。収集の前のジョブ(rolling が無い形)でも generate が読む", async () => {
    const h = harness({ raceCount: 2 });
    h.state.llmFailures = 1;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.step(); // list
    await h.step(); // gather
    const before = h.kv.get<Record<string, unknown>>(`job:${DATE}`)!;
    expect(before["phase"]).toBe("generate");
    expect(before["rolling"] ?? null).toBeNull(); // この時点のジョブに累計は無い(旧版が積んだジョブと同じ形)
    expect(h.periodCalls).toHaveLength(0);
    await h.step(); // generate: 累計を読み、LLM は 1 回目が失敗
    expect(h.periodCalls).toHaveLength(1);
    expect(h.kv.get<Record<string, unknown>>(`job:${DATE}`)!["rolling"]).toBeTruthy();
    h.state.period = priorStats({ totalStake: 1 }); // 読み直せば数字が変わる状況にしておく
    h.clock.t += REPORT_RETRY_DELAY_MS;
    await h.drain();
    expect(h.periodCalls).toHaveLength(1); // LLM の再試行で読み直していない
    expect(h.saved[0]!.body.rolling!.prior.totalStake).toBe(40000); // 最初に読んだ数字のまま
  });

  it("Discord の embed に、直近 28 日の累計の field が付く", async () => {
    const h = harness({ raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const fields = (h.sent[0]!.embeds![0]! as { fields?: Array<{ name: string; value: string }> }).fields!;
    const f = fields.find((x) => x.name.includes("直近 28 日"));
    expect(f).toBeDefined();
    expect(f!.value).toContain("回収率");
  });
});

describe("Issue #264 デプロイをまたぐジョブ: 旧コードが永続化した状態を、新コードが読んでも落ちない", () => {
  it("save 段階までを旧コードが作った record(stats に見込みの項目が無く、rolling・promptVersion も無い)でも、notify は Discord に送れる(failed にならない)", async () => {
    const h = harness({ raceCount: 2, appBaseUrl: "https://example.com" });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    // list → gather → generate → save まで進め、notify の手前で止める
    for (let i = 0; i < 4; i += 1) await h.step();
    const job = h.kv.get<{ phase: string; record: { body: Record<string, unknown> } }>(`job:${DATE}`)!;
    expect(job.phase).toBe("notify"); // 前提: 次は通知の段階
    const stats = job.record.body["stats"] as Record<string, unknown>;
    for (const key of ["expectedBetCount", "expectedHits", "expectedBaseHits", "maxPayout", "maxPayoutStake"]) {
      expect(key in stats, `前提: 新しい項目 ${key} を持っている(これから消す)`).toBe(true);
      delete stats[key];
    }
    delete job.record.body["rolling"];
    delete job.record.body["promptVersion"];
    h.kv.put(`job:${DATE}`, job);
    h.clock.t += 1000;
    const outcome = await h.step();
    expect(outcome).toMatchObject({ kind: "ran", phase: "notify", result: "ok" });
    expect(h.sent).toHaveLength(1);
    const embed = h.sent[0]!.embeds![0]! as { fields?: Array<{ name: string; value: string }> };
    expect(embed.fields!.map((f) => f.name)).not.toContain("直近 28 日の累計(その日を含む)");
    expect(embed.fields!.find((f) => f.name === "成績")!.value).not.toContain("見込み");
    expect(h.core.getStatus(DATE)).toBeNull(); // 終わったジョブは消える(failed で残らない)
  });

  it("gather までを旧コードが作ったダイジェスト(買い目に ev が無い)でも、generate は落ちず、見込みは『確率を導ける買い目なし』になる", async () => {
    const h = harness({ raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.step(); // list
    await h.step(); // gather
    const job = h.kv.get<{ phase: string; digests: Array<{ bets: Array<Record<string, unknown>> }> }>(`job:${DATE}`)!;
    expect(job.phase).toBe("generate");
    let stripped = 0;
    for (const d of job.digests) {
      for (const b of d.bets) {
        expect("ev" in b, "前提: 新コードのダイジェストは買い目に ev を持つ(これから消す)").toBe(true);
        delete b["ev"];
        stripped += 1;
      }
    }
    expect(stripped).toBeGreaterThan(0);
    h.kv.put(`job:${DATE}`, job);
    await h.drain();
    expect(h.saved).toHaveLength(1);
    const body = h.saved[0]!.body;
    expect(body.stats.judgedBetCount).toBeGreaterThan(0); // 前提: 判定できた買い目はある
    expect(body.stats.expectedBetCount).toBe(0);
    expect(body.stats.expectedHits).toBe(0);
    expect(h.sent).toHaveLength(1);
  });
});

describe("Issue #272: 日報の「もしも」(印の定型の買い方と惜しかったレース)", () => {
  /** R1 を、◎1〇2 が 1・2 着でワイド 1-2(払戻 800 円)が出たが、実際は単勝しか買っていないレースに差し替える(惜しかったレース)。 */
  function nearMissRace(h: Harness): void {
    const base = raceInput(1);
    h.state.inputs.set(101, {
      view: base.view,
      result: { ...base.result!, combos: { wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }] } } },
    });
  }
  const priorWithWhatIf = (): PeriodStats => {
    const zero = { betCount: 0, hitCount: 0, stake: 0, payout: 0, refundCount: 0, unjudgedCount: 0, inapplicableCount: 0 };
    return priorStats({ whatIf: { win: { ...zero, betCount: 40, hitCount: 8, stake: 4000, payout: 3200 }, place: zero, wide: zero, quinella: zero, trio: zero } });
  };

  it("本文の stats.whatIf に型ごとの成績、rolling.total.whatIf に 直前 27 日 + その日 を残す。惜しかったレースは nearMisses に残す", async () => {
    const h = harness({ raceCount: 3 });
    h.state.period = priorWithWhatIf();
    nearMissRace(h);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const body = h.saved[0]!.body;
    // その日: 3 レースとも◎が 1 着(単勝 350 円)。ワイドは R1 だけ組合せ払戻があり的中、R2・R3 は取込印なしで判定不能
    expect(body.stats.whatIf!["win"]).toEqual({ betCount: 3, hitCount: 3, stake: 300, payout: 1050, refundCount: 0, unjudgedCount: 0, inapplicableCount: 0 });
    expect(body.stats.whatIf!["wide"]).toEqual({ betCount: 1, hitCount: 1, stake: 100, payout: 800, refundCount: 0, unjudgedCount: 2, inapplicableCount: 0 });
    expect(body.stats.whatIf!["trio"]).toEqual({ betCount: 0, hitCount: 0, stake: 0, payout: 0, refundCount: 0, unjudgedCount: 0, inapplicableCount: 3 });
    // 累計 = 直前 27 日(40 点・8 的中)+ その日(3 点・3 的中)
    expect(body.rolling!.total.whatIf!["win"]).toEqual({ betCount: 43, hitCount: 11, stake: 4300, payout: 4250, refundCount: 0, unjudgedCount: 0, inapplicableCount: 0 });
    expect(body.nearMisses).toEqual({ total: 1, shown: [{ raceId: raceIdOf(1), templateId: "wide", payout: 800 }] });
  });

  it("LLM に渡すプロンプトに、節(その日・累計・惜しかったレース)と規則の 1 文が入る。版が上がっている", async () => {
    const h = harness({ raceCount: 3 });
    h.state.period = priorWithWhatIf();
    nearMissRace(h);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("## 印の定型の買い方(「もしも」。確定値。各 100 円)");
    expect(h.prompts[0]).toContain("- ◎単勝: 判定できた 43 レース中 11 的中");
    expect(h.prompts[0]).toContain(`${raceIdOf(1)}`);
    expect(h.prompts[0]).toContain("◎-〇ワイドが的中していた(定型の払戻 800円)・実際の買い目: 賭け金 200円・払戻 700円");
    expect(h.prompts[0]!.split("\n").filter((l) => l.includes("「もしも」(印の定型の買い方)の成績は"))).toHaveLength(1);
    expect(h.saved[0]!.body.promptVersion).toBe("report-2026-10-12.2");
  });

  it("Discord の要約に、『もしも』と『惜しかったレース』の field が出る(レース名つき)", async () => {
    const h = harness({ raceCount: 3 });
    h.state.period = priorWithWhatIf();
    nearMissRace(h);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    expect(h.sent).toHaveLength(1);
    const fields = (h.sent[0]!.embeds![0]! as { fields?: Array<{ name: string; value: string }> }).fields!;
    expect(fields.find((f) => f.name === "もしも(印の定型・各100円)")!.value).toContain("◎単勝: その日 3/3 350.0%・28日 11/43 98.8%");
    const near = fields.find((f) => f.name === "惜しかったレース(全 1 件)")!;
    expect(near.value).toBe("東京1R テスト1S(15:45 芝1600m良): ◎-〇ワイド 800円");
  });

  it("デプロイをまたいだ旧形のジョブ(ダイジェストに templates が無い)は、『もしも』なしで確定する。落ちず、節も field も nearMisses も出さない", async () => {
    const h = harness({ raceCount: 3 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.step(); // list
    await h.step(); // gather
    const key = `job:${DATE}`;
    const job = h.kv.data.get(key) as { phase: string; digests: Array<Record<string, unknown>> };
    expect(job.phase).toBe("generate");
    expect(job.digests).toHaveLength(3);
    expect(job.digests.every((d) => Array.isArray(d["templates"]))).toBe(true); // 前提: 新コードは templates を積む
    h.kv.put(key, { ...job, digests: job.digests.map(({ templates: _templates, ...rest }) => rest) });
    await h.drain();
    const body = h.saved[0]!.body;
    expect(body.stats.raceCount).toBe(3);
    expect(body.stats.whatIf).toBeNull();
    expect(body.rolling!.total.whatIf).toBeNull();
    expect(body.nearMisses).toBeUndefined();
    expect(h.prompts[0]).not.toContain("印の定型の買い方");
    expect(((h.sent[0]!.embeds![0]! as { fields?: Array<{ name: string }> }).fields ?? []).map((f) => f.name).join("|")).not.toMatch(/もしも|惜しかった/);
  });
});


describe("Issue #268: 管理者による日報の作り直し(mode: regenerate)", () => {
  /** 日報が既にある日を作り直す準備(日報が D1 にある状態)。 */
  function regenHarness(options: Parameters<typeof harness>[0] = {}): Harness {
    const h = harness(options);
    h.state.hasReport = true;
    return h;
  }

  /** 再試行の待ち(REPORT_RETRY_DELAY_MS)も時計を進めて、動かせるジョブが無くなるまで進める。 */
  async function settle(h: Harness): Promise<StepOutcome[]> {
    const outcomes: StepOutcome[] = [];
    for (let i = 0; i < 200; i += 1) {
      const o = await h.step();
      outcomes.push(o);
      if (o.kind === "idle") {
        if (h.kv.get("jobs") === undefined) break;
        h.clock.t += REPORT_RETRY_DELAY_MS;
      } else {
        h.clock.t += 1000;
      }
    }
    return outcomes;
  }

  /** 作り直しを依頼して最後まで進める。 */
  async function regenerateOnce(h: Harness, date: string = DATE): Promise<Awaited<ReturnType<Harness["core"]["requestReport"]>>> {
    const result = await h.core.requestReport({ kaisaiDate: date, mode: "regenerate" });
    await settle(h);
    return result;
  }

  const quotaOf = (h: Harness): { day: string; count: number } | undefined => h.kv.get<{ day: string; count: number }>("regen");

  describe("依頼の受け付け", () => {
    it("前提: 1 日の上限は 3 回", () => {
      expect(REPORT_REGEN_DAILY_LIMIT).toBe(3);
    });

    it("日報がある日は受け付け、アラームを今に設定する。ジョブは作り直しとして状況に出る(regenerate: true)", async () => {
      const h = regenHarness();
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: true });
      expect(h.alarms).toEqual([T0]);
      expect(h.core.getStatus(DATE)).toStrictEqual({ phase: "list", status: "running", attempts: 0, regenerate: true });
    });

    it("通常の作成のジョブの状況には regenerate を付けない(キーそのものが無い)", async () => {
      const h = harness();
      await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
      const status = h.core.getStatus(DATE)!;
      expect(status).toStrictEqual({ phase: "list", status: "running", attempts: 0 });
      expect("regenerate" in status).toBe(false);
    });

    it("日報が無い日は not-exists で断る(作成の入口の仕事)。状態も回数も作らない", async () => {
      const h = harness(); // hasReport = false
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "not-exists" });
      expect(h.kv.data.size).toBe(0);
      expect(h.alarms).toEqual([]);
    });

    it("作成中の日は in-progress で断る。断った依頼は回数に数えない", async () => {
      const h = regenHarness();
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: true });
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "in-progress" });
      expect(quotaOf(h)).toStrictEqual({ day: DATE, count: 1 });
    });

    it("未来・不正な日付は受け付けない。回数に数えない", async () => {
      const h = regenHarness();
      expect(await h.core.requestReport({ kaisaiDate: "20261011", mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "future-date" });
      expect(await h.core.requestReport({ kaisaiDate: "20261340", mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "invalid-date" });
      expect(h.kv.data.size).toBe(0);
    });

    it("古い日(JST の今日から 30 日前)も受け付ける(manual と同じで、日付の古さの上限はない)", async () => {
      const h = regenHarness();
      expect(await h.core.requestReport({ kaisaiDate: "20260910", mode: "regenerate" })).toStrictEqual({ accepted: true });
    });

    it("isRequestSettled: 新しい理由 not-exists・daily-limit は完了として扱わない(auto は送らないが、型の網羅として固定する)", () => {
      expect(isRequestSettled({ accepted: false, reason: "not-exists" })).toBe(false);
      expect(isRequestSettled({ accepted: false, reason: "daily-limit" })).toBe(false);
    });
  });

  describe("1 日の回数の上限(全体・JST の日付・受理したときだけ数える)", () => {
    it("3 回まで受理し、4 回目は daily-limit で断る(ジョブも作らない)。断った依頼(in-progress・not-exists)は数えない", async () => {
      const h = regenHarness();
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: true });
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "in-progress" }); // 数えない
      await settle(h);
      h.state.hasReport = false;
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "not-exists" }); // 数えない
      h.state.hasReport = true;
      // ここまでの受理は 1 回。断った依頼を数えていたら、下の 2 回の受理が揃わない
      expect(await regenerateOnce(h)).toStrictEqual({ accepted: true });
      expect(await regenerateOnce(h)).toStrictEqual({ accepted: true });
      expect(h.replaced).toHaveLength(3);
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "daily-limit" });
      expect(h.core.getStatus(DATE)).toBeNull();
      expect(quotaOf(h)).toStrictEqual({ day: DATE, count: 3 });
    });

    it("上限は日付(開催日)ごとではなく全体: 別の開催日の作り直しも合わせて 3 回", async () => {
      const h = regenHarness();
      await regenerateOnce(h, "20261008");
      await regenerateOnce(h, "20261009");
      await regenerateOnce(h, DATE);
      expect(h.replaced.map((r) => r.kaisaiDate)).toEqual(["20261008", "20261009", DATE]);
      expect(await h.core.requestReport({ kaisaiDate: "20261007", mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "daily-limit" });
    });

    it("失敗した作り直しも数える(LLM の費用が発生しうる)。失敗したジョブがあっても新しい依頼は受け付ける", async () => {
      const h = regenHarness();
      h.state.replaceResult = "kept";
      await regenerateOnce(h);
      expect(h.core.getStatus(DATE)).toMatchObject({ status: "failed" });
      expect(quotaOf(h)).toStrictEqual({ day: DATE, count: 1 });
      h.state.replaceResult = "replaced";
      expect(await regenerateOnce(h)).toStrictEqual({ accepted: true });
      expect(h.replaced).toHaveLength(1);
      expect(h.core.getStatus(DATE)).toBeNull();
      expect(quotaOf(h)).toStrictEqual({ day: DATE, count: 2 });
    });

    it("JST の 0 時で数え直す(UTC の 0 時ではない): JST 23:59:59 は同じ日、JST 0:00 から新しい日", async () => {
      const h = regenHarness();
      await regenerateOnce(h);
      await regenerateOnce(h);
      await regenerateOnce(h);
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "daily-limit" });
      h.clock.t = Date.parse("2026-10-10T14:59:59.000Z"); // JST 23:59:59
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: false, reason: "daily-limit" });
      h.clock.t = Date.parse("2026-10-10T15:00:00.000Z"); // JST 翌日 0:00(UTC では同じ日の 15 時)
      expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" })).toStrictEqual({ accepted: true });
      expect(quotaOf(h)).toStrictEqual({ day: "20261011", count: 1 });
    });

    it("通常の作成(manual)は回数に数えず、上限に達していても制限されない", async () => {
      const h = harness({ raceCount: 2 });
      await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
      await h.drain();
      expect(quotaOf(h)).toBeUndefined();
      h.kv.put("regen", { day: DATE, count: 3 }); // 上限に達した状態
      h.state.hasReport = false;
      expect(await h.core.requestReport({ kaisaiDate: "20261009", mode: "manual" })).toStrictEqual({ accepted: true });
    });
  });

  describe("作り直しの流れ", () => {
    it("list → gather → generate → save で終わり、通知に進まない。D1 には replaceReport だけを使う(saveReport は呼ばない)", async () => {
      const h = regenHarness({ appBaseUrl: "https://example.com" });
      await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" });
      const outcomes = await h.drain();
      const phases = outcomes.filter((o) => o.kind === "ran").map((o) => (o as { phase: string }).phase);
      expect(phases).toEqual(["list", "gather", "gather", "gather", "generate", "save"]);
      expect(h.replaced).toHaveLength(1);
      expect(h.saved).toHaveLength(0);
      expect(h.prompts).toHaveLength(1);
      expect(h.kv.get("job:" + DATE)).toBeUndefined(); // 終わったジョブは消える
      expect(h.core.getStatus(DATE)).toBeNull();
    });

    it("Discord に送らない(通知の経路が無い)。対照: 同じ入力の通常の作成(manual)は 1 回送る", async () => {
      const control = harness({ appBaseUrl: "https://example.com" });
      await control.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
      await control.drain();
      expect(control.sent).toHaveLength(1); // 対照: 送れる構成であること(0 回が自明に成り立たない)
      const h = regenHarness({ appBaseUrl: "https://example.com" });
      await regenerateOnce(h);
      expect(h.replaced).toHaveLength(1); // 作り直しは最後まで走った
      expect(h.sent).toHaveLength(0);
    });

    it("作り直した日報は通常の作成と同じ本文(4 週の累計・もしも・惜しかったレース・文章)を作る。前の日報から引き継がない", async () => {
      const control = harness();
      await control.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
      await control.drain();
      const h = regenHarness();
      await regenerateOnce(h);
      const created = control.saved[0]!;
      const regenerated = h.replaced[0]!;
      expect(regenerated.body).toStrictEqual(created.body);
      expect(regenerated.body.rolling).toBeDefined(); // 4 週の累計(#264)
      expect(regenerated.body.nearMisses).toBeDefined(); // 惜しかったレース(#272)
      expect(regenerated.body.stats.whatIf).not.toBeNull(); // もしも(#272)
      expect(regenerated.summary).toBe(created.summary);
      expect(h.periodCalls).toHaveLength(1); // 直前 27 日を、作り直しの時点で再集計する
      expect(h.periodCalls).toStrictEqual(control.periodCalls);
    });

    it("作り直した記録の作成時刻は、作り直した時刻になる", async () => {
      const h = regenHarness();
      h.clock.t = Date.parse("2026-10-10T12:00:00.000Z");
      await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" });
      await h.drain();
      expect(Date.parse(h.replaced[0]!.createdAt)).toBeGreaterThanOrEqual(Date.parse("2026-10-10T12:00:00.000Z"));
    });
  });

  describe("失敗しても前の日報は消えない(コアは replaceReport 以外で D1 を書かない)", () => {
    it("保存(replaceReport)が上限まで失敗したら failed。書いていないので前の日報は残る。状況に regenerate: true が残る", async () => {
      const h = regenHarness();
      h.state.failReplace = 99;
      await regenerateOnce(h);
      expect(h.replaced).toHaveLength(0);
      expect(h.saved).toHaveLength(0);
      expect(h.core.getStatus(DATE)).toStrictEqual({ phase: "save", status: "failed", attempts: REPORT_MAX_STEP_ATTEMPTS, regenerate: true });
      expect(h.sent).toHaveLength(0);
    });

    it("保存の失敗の再試行で、LLM は呼び直さない(応答を永続化している)", async () => {
      const h = regenHarness();
      h.state.failReplace = 1;
      await regenerateOnce(h);
      expect(h.prompts).toHaveLength(1);
      expect(h.replaced).toHaveLength(1);
    });

    it("置き換えなかった(kept: 前の日報の方が良い)ときは failed にして、通知もしない。動かすジョブの一覧から外れる", async () => {
      const h = regenHarness();
      h.state.replaceResult = "kept";
      await h.core.requestReport({ kaisaiDate: DATE, mode: "regenerate" });
      const outcomes = await h.drain();
      const last = outcomes.filter((o) => o.kind === "ran").at(-1);
      expect(last).toMatchObject({ phase: "save", result: "failed" });
      expect(h.core.getStatus(DATE)).toMatchObject({ phase: "save", status: "failed", regenerate: true });
      expect(h.replaced).toHaveLength(0);
      expect(h.sent).toHaveLength(0);
      expect(h.kv.get("jobs")).toBeUndefined();
      expect(h.warns.some((w) => w.includes("前の日報"))).toBe(true);
    });

    it("LLM が使えなかった作り直しは、文章なしの記録(model: null)を replaceReport に渡す(置き換えるかどうかは D1 の側の規則)", async () => {
      const h = regenHarness();
      h.state.llmFailures = 99;
      await regenerateOnce(h);
      expect(h.replaced).toHaveLength(1);
      expect(h.replaced[0]!.model).toBeNull();
      expect(h.replaced[0]!.body.note).toBe(REPORT_NOTE_FAILED);
      expect(h.prompts).toHaveLength(REPORT_MAX_LLM_ATTEMPTS);
    });

    it("その日の分析が見つからないとき(list が 0 件)は、LLM を呼ばず、置き換えず、作り直しの失敗として残す", async () => {
      const h = regenHarness();
      h.state.analyses = [];
      await regenerateOnce(h);
      expect(h.prompts).toHaveLength(0);
      expect(h.replaced).toHaveLength(0);
      expect(h.core.getStatus(DATE)).toMatchObject({ status: "failed", regenerate: true });
    });

    it("分析は列挙されたが詳細が全件読めなかった(ダイジェスト 0 件)ときも同じ", async () => {
      const h = regenHarness();
      h.state.allMissing = true;
      await regenerateOnce(h);
      expect(h.prompts).toHaveLength(0);
      expect(h.replaced).toHaveLength(0);
      expect(h.core.getStatus(DATE)).toMatchObject({ status: "failed", regenerate: true });
    });

    it("失敗した作り直しのジョブは本文を抱え込まない(kv を肥大させない)", async () => {
      const h = regenHarness();
      h.state.replaceResult = "kept";
      await regenerateOnce(h);
      const job = h.kv.get<{ digests: unknown[]; items: unknown[]; record: unknown; calls: unknown[] }>("job:" + DATE)!;
      expect(job).toBeDefined();
      expect(job.digests).toEqual([]);
      expect(job.items).toEqual([]);
      expect(job.record).toBeNull();
      expect(job.calls).toEqual([]);
    });
  });
});

describe("Issue #278: 日報の返還(取消・除外の馬への買い目)", () => {
  /** R1 を、◎の 1 番(単勝 200 円)が取消・除外のレースに差し替える。 */
  function scratchedRace(h: Harness): void {
    const base = raceInput(1);
    h.state.inputs.set(101, {
      view: base.view,
      result: { horses: [{ umaban: 1, finishPosition: null, winPayout: null, placePayout: null, scratched: true }, { umaban: 2, finishPosition: 1, winPayout: 350, placePayout: 130, scratched: false }, { umaban: 3, finishPosition: 2, winPayout: null, placePayout: 150, scratched: false }], combos: {} },
    });
  }

  it("取消の馬への買い目は返還として、日報の本文(レース行・統計・券種別・もしも)・LLM のプロンプト・版・Discord に出る", async () => {
    const h = harness({ raceCount: 3 });
    scratchedRace(h);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.drain();
    const body = h.saved[0]!.body;
    const row = body.races.find((r) => r.raceId === raceIdOf(1))!;
    expect(row).toMatchObject({ judgedBetCount: 1, hitCount: 0, refundedBetCount: 1, totalStake: 200, totalReturn: 200 });
    expect(body.races.filter((r) => r.raceId !== raceIdOf(1)).every((r) => r.refundedBetCount === 0)).toBe(true);
    expect(body.stats.refundedBetCount).toBe(1);
    expect(body.stats.refundedStake).toBe(200);
    expect(body.stats.byBetType["win"]!.refundCount).toBe(1);
    expect(body.rolling!.total.refundedBetCount).toBe(1); // 直前 27 日(偽)は返還なし + その日の 1 点
    expect(body.stats.whatIf!["win"]!.refundCount).toBe(1); // ◎が取消の型(単勝)は返還
    expect(h.prompts[0]).toContain("→ 返還 200円");
    expect(h.prompts[0]).toContain("取消・除外");
    expect(body.promptVersion).toBe(REPORT_PROMPT_VERSION);
    const fields = (h.sent[0]!.embeds![0]! as { fields?: Array<{ name: string; value: string }> }).fields!;
    expect(fields.find((f) => f.name === "成績")!.value).toContain("うち返還 1 点");
  });

  it("デプロイをまたいだ旧形のジョブ(rolling に返還の項目が無い)でも、落ちずに確定する", async () => {
    const h = harness({ raceCount: 3 });
    scratchedRace(h);
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    await h.step();
    await h.step();
    const key = `job:${DATE}`;
    const job = h.kv.data.get(key) as { phase: string; digests: Array<{ refundedBetCount?: number; refundedStake?: number }> };
    expect(job.phase).toBe("generate");
    h.kv.put(key, { ...job, digests: job.digests.map(({ refundedBetCount: _c, refundedStake: _s, ...rest }) => rest) });
    await h.drain();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.body.stats.refundedBetCount).toBe(1); // 件数は買い目(status)から数え直すので、旧形のダイジェストでも同じ
  });
});

describe("Issue #446(H-5): ジョブ機構の確認(削除した特性テストから移した。時間・回数・件数は定数を参照せず、値で固定する)", () => {
  const ran = (phase: string, result: string) => ({ kind: "ran", kaisaiDate: DATE, phase, result });

  it("段階は list → gather → generate → save → notify の順に、それぞれ result: ok で進む。9 件は 8 件 + 1 件に分け、9 件目も読む。段階が進むと失敗の回数は 0 に戻る", async () => {
    const h = harness({ raceCount: 9 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    expect(await h.step()).toEqual(ran("list", "ok"));
    h.state.failRead = 1;
    expect(await h.step()).toEqual(ran("gather", "retry")); // 1 つ目の 8 件の読み出しが失敗
    expect(h.core.getStatus(DATE)).toEqual({ phase: "gather", status: "running", attempts: 1 });
    h.clock.t += 60_000;
    expect(await h.step()).toEqual(ran("gather", "ok")); // 8 件
    expect(h.core.getStatus(DATE)).toEqual({ phase: "gather", status: "running", attempts: 0 }); // 成功で 0 に戻る
    expect(await h.step()).toEqual(ran("gather", "ok")); // 残りの 1 件(9 件目)
    expect(h.readCalls).toEqual([8, 8, 1]);
    expect(h.core.getStatus(DATE)).toEqual({ phase: "generate", status: "running", attempts: 0 });
    h.state.failPeriod = 1;
    expect(await h.step()).toEqual(ran("generate", "retry"));
    expect(h.core.getStatus(DATE)).toEqual({ phase: "generate", status: "running", attempts: 1 });
    h.clock.t += 60_000;
    expect(await h.step()).toEqual(ran("generate", "ok"));
    expect(h.core.getStatus(DATE)).toEqual({ phase: "save", status: "running", attempts: 0 });
    h.state.failSave = 1;
    expect(await h.step()).toEqual(ran("save", "retry"));
    h.clock.t += 60_000;
    expect(await h.step()).toEqual(ran("save", "ok"));
    expect(h.core.getStatus(DATE)).toEqual({ phase: "notify", status: "running", attempts: 0 });
    expect(await h.step()).toEqual(ran("notify", "ok"));
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.raceCount).toBe(9); // 9 件目まで読んで数えている
    expect(h.core.getStatus(DATE)).toBeNull();
  });

  it("段階の失敗は 60 秒(60,000 ms)後に再試行し、3 回目の失敗で failed(アラームを張らない)", async () => {
    const h = harness({ raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await h.step(); // list
    h.state.failRead = 99;
    const t = h.clock.t;
    expect(await h.step()).toEqual(ran("gather", "retry"));
    expect(h.alarms[h.alarms.length - 1]).toBe(t + 60_000);
    h.clock.t = t + 59_999;
    expect(await h.step()).toEqual({ kind: "idle" }); // 待ちが過ぎるまでは動かない
    h.clock.t = t + 60_000;
    expect(await h.step()).toEqual(ran("gather", "retry"));
    expect(h.alarms[h.alarms.length - 1]).toBe(t + 120_000);
    h.clock.t = t + 120_000;
    const alarmsBefore = h.alarms.length;
    expect(await h.step()).toEqual(ran("gather", "failed"));
    expect(h.core.getStatus(DATE)).toEqual({ phase: "gather", status: "failed", attempts: 3 });
    expect(h.alarms).toHaveLength(alarmsBefore); // failed のジョブにはアラームを張らない
  });

  it("LLM の失敗は 60 秒(60,000 ms)後に再試行する。LLM に送る max_tokens は 12,000", async () => {
    const h = harness({ raceCount: 2 });
    h.state.llmFailures = 1;
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await h.step(); // list
    await h.step(); // gather
    const t = h.clock.t;
    expect(await h.step()).toEqual(ran("generate", "retry")); // LLM が失敗
    expect(h.alarms[h.alarms.length - 1]).toBe(t + 60_000);
    h.clock.t = t + 59_999;
    expect(await h.step()).toEqual({ kind: "idle" });
    h.clock.t = t + 60_000;
    expect(await h.step()).toEqual(ran("generate", "ok"));
    expect(h.maxTokens).toEqual([12_000, 12_000]);
  });

  it("再起動(新しいインスタンス)で、期限がまだ来ていないジョブだけがあるときの空の起床は、そのジョブの時刻にアラームを張り直す", async () => {
    const kv = memoryKv();
    const first = harness({ raceCount: 2, kv });
    await first.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await first.step(); // list
    first.state.failRead = 1;
    await first.step(); // gather が失敗 → 次の時刻は 60 秒後
    const t = first.clock.t;
    const second = harness({ raceCount: 2, kv, start: t });
    expect(second.alarms).toEqual([]);
    expect(await second.step()).toEqual({ kind: "idle" });
    expect(second.alarms).toEqual([t + 60_000]);
  });

  it("進行中の日の依頼は、作成済みかどうか(D1)を引かずに断る", async () => {
    const h = harness({ raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" });
    expect(h.state.hasReportCalls).toBe(1);
    expect(await h.core.requestReport({ kaisaiDate: DATE, mode: "auto" })).toEqual({ accepted: false, reason: "in-progress" });
    expect(h.state.hasReportCalls).toBe(1); // 増えない
  });

  it("保存する日報のレース行: 会場・R・レース名・発走・印(印のある馬だけ)・見送りの注記を、そのまま持つ。本文の format は 1、開催日は依頼の日", async () => {
    const h = harness({ raceCount: 2 });
    const first = h.state.inputs.get(101)!;
    // 1 レース目: 印のない馬(3 番)を足す。2 レース目: 買い目なしの見送り(理由コードつき)にする。
    h.state.inputs.set(101, { ...first, view: { ...first.view, horses: [...first.view.horses, horse(3)] } });
    const second = h.state.inputs.get(102)!;
    h.state.inputs.set(102, { ...second, view: { ...second.view, allocation: { ...second.view.allocation!, bets: [], skipReasonCode: "no-positive-ev" } } });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await h.drain();
    const body = h.saved[0]!.body;
    expect(body.format).toBe(1);
    expect(body.kaisaiDate).toBe(DATE);
    const row1 = body.races.find((r) => r.raceId === raceIdOf(1))!;
    expect(row1).toMatchObject({ venueName: "東京", raceNumber: 1, raceName: "テスト1S", startTime: "15:45", allocationNote: null });
    expect(row1.marks).toEqual([
      { mark: "◎", umaban: 1, name: "馬1", finishPosition: 1 },
      { mark: "〇", umaban: 2, name: "馬2", finishPosition: 2 },
    ]);
    const row2 = body.races.find((r) => r.raceId === raceIdOf(2))!;
    expect(row2).toMatchObject({ venueName: "東京", raceNumber: 2, raceName: "テスト2S", startTime: "15:45", allocationNote: "買い目なし(見送り: no-positive-ev)" });
  });

  it("記録の model は、文章(構造化も生の文章も)があるときだけ応答のモデル。LLM が使えなかった記録は null", async () => {
    const parsed = harness({ raceCount: 2 });
    await parsed.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await parsed.drain();
    expect(parsed.saved[0]!.model).toBe("claude-sonnet-5-5");

    const unparsed = harness({ raceCount: 2 });
    unparsed.state.llmText = "JSON ではない文章です。";
    await unparsed.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await unparsed.drain();
    expect(unparsed.saved[0]!.body.narrative).toBeNull();
    expect(unparsed.saved[0]!.model).toBe("claude-sonnet-5-5");

    const failed = harness({ raceCount: 2 });
    failed.state.llmFailures = 99;
    await failed.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await failed.drain(); // 1 回目の失敗 → 60 秒待ち
    failed.clock.t += 60_000;
    await failed.drain(); // 2 回目の失敗 → 諦めて統計だけの日報
    expect(failed.saved[0]!.model).toBeNull();
  });

  it("読めない応答の日報も、Discord には総括(生の文章の先頭)を説明として送る(文章がないときの固定の理由ではなく)", async () => {
    const h = harness({ raceCount: 2 });
    h.state.llmText = "JSON ではない文章です。";
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    const outcomes = await h.drain();
    expect(outcomes.filter((o) => o.kind === "ran").map((o) => (o as { phase: string; result: string }).phase + ":" + (o as { result: string }).result)).toContain("notify:ok");
    expect(h.sent).toHaveLength(1);
    const embed = h.sent[0]!.embeds![0] as { description?: string };
    expect(embed.description).toBe("JSON ではない文章です。");
  });

  it("Discord に送る payload は embeds だけで、embed は 1 件", async () => {
    const h = harness({ raceCount: 2 });
    await h.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect(Object.keys(h.sent[0]!)).toEqual(["embeds"]);
    expect(h.sent[0]!.embeds).toHaveLength(1);
  });

  it("通知の仕組みが無い日報の notify は ok で、警告を出さない。送信が失敗したときは failed(警告 1 件・再送しない)", async () => {
    const none = harness({ raceCount: 2, notifier: false });
    await none.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    const noneOutcomes = await none.drain();
    expect(noneOutcomes).toContainEqual(ran("notify", "ok"));
    expect(none.warns.filter((w) => w.includes("Discord"))).toEqual([]);

    const failing = harness({ raceCount: 2 });
    failing.state.notifyFails = true;
    await failing.core.requestReport({ kaisaiDate: DATE, mode: "manual" });
    const failingOutcomes = await failing.drain();
    expect(failingOutcomes).toContainEqual(ran("notify", "failed"));
    expect(failing.sent).toHaveLength(1);
    expect(failing.warns.filter((w) => w.startsWith("Discord への日報の通知に失敗しました(20261010。分類: "))).toHaveLength(1);
  });
});
