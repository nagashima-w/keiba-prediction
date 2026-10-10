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
  REPORT_RETRY_DELAY_MS,
  type DailyReportDeps,
  type DailyReportKv,
  type RaceInput,
  type ReportRecord,
  type ReportSource,
  type ReportStore,
  type StepOutcome,
} from "../src/daily-report-core";
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
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], ...over };
}

const raceIdOf = (n: number): string => `2026050308${String(n).padStart(2, "0")}`;

function raceInput(n: number, withResult = true): RaceInput {
  const raceId = raceIdOf(n);
  const view: AnalysisView = {
    id: 100 + n, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber: n, raceName: `テスト${n}S`, startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良" },
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

interface Harness {
  readonly core: DailyReportCore;
  readonly kv: ReturnType<typeof memoryKv>;
  readonly clock: { t: number };
  readonly alarms: number[];
  readonly warns: string[];
  readonly saved: ReportRecord[];
  readonly sent: DiscordPayload[];
  readonly prompts: string[];
  /** LLM に送ったリクエストのモデル ID(送った順)。 */
  readonly models: string[];
  readonly readCalls: number[];
  readonly state: { analyses: { raceId: string; analysisId: number }[]; inputs: Map<number, RaceInput>; failRead: number; failSave: number; hasReport: boolean; llmFailures: number; llmText: string; notifyFails: boolean; saveResult: "saved" | "exists"; allMissing: boolean; hasReportCalls: number };
  step(): Promise<StepOutcome>;
  drain(max?: number): Promise<StepOutcome[]>;
}

function harness(options: { raceCount?: number; llm?: boolean; notifier?: boolean; appBaseUrl?: string; kv?: ReturnType<typeof memoryKv>; analysisModel?: AnalysisModelId; lister?: () => Promise<ReadonlyArray<ModelInfoLite>>; start?: number } = {}): Harness {
  const kv = options.kv ?? memoryKv();
  const clock = { t: options.start ?? T0 };
  const alarms: number[] = [];
  const warns: string[] = [];
  const saved: ReportRecord[] = [];
  const sent: DiscordPayload[] = [];
  const prompts: string[] = [];
  const models: string[] = [];
  const readCalls: number[] = [];
  const raceCount = options.raceCount ?? 20;
  const state: Harness["state"] = {
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
  };
  const sender: MessageSender = async (params) => {
    prompts.push(params.messages[0]!.content);
    models.push(params.model);
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
    core, kv, clock, alarms, warns, saved, sent, prompts, models, readCalls, state,
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
      source: { listDayAnalyses: async () => [], readRaces: async () => [] },
      store: { hasReport: async () => false, saveReport: async () => "saved" },
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
        source: { listDayAnalyses: async () => [], readRaces: async () => [] },
        store: { hasReport: async () => false, saveReport: async () => "saved" },
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
