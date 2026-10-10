/**
 * 日報(Issue #235)の作成の流れ。**純ロジック**: `cloudflare:workers` を import しない。ストレージ(kv)・時計・アラーム・D1/R2 の読み出し・D1 への保存・LLM・Discord は
 * 引数で受けるので、Node の vitest でテストできる。本物の配線は `daily-report-do.ts`(DO `DailyReportDO`)。
 *
 * ## 役割
 * 「その日に発走前の分析をした全レースの予想と結果」から、決定的な統計(`daily-report-digest.ts`)と、LLM による振り返りの文章(良かった点・改善点)を作り、
 * D1 に日付ごとに保存し、Discord に要約を送る。日報は記録と振り返りの材料で、プロンプトを自動で変えない(`docs/prompt-improvement-plan.md`)。
 *
 * ## 起動(いつ作るか)
 * このコアは「作る」依頼({@link DailyReportCore.requestReport})を受けるだけで、**いつ作るかは決めない**(時刻・曜日の決め打ちをしない)。依頼は次の 3 経路:
 *  - `auto`: 日単位の DO `RaceDay` が「その日が静かになった」(計画が確定し、計画中のレースが無く、発走前のタスクが終わり、結果の取り込みが終端〈取り込み済みか諦め〉になった)ときに 1 回依頼する。
 *  - `catchup`: 23 時の cron(再実行。Issue #249)が、前日以前(最大 3 日)の分析があるのに日報が無い日を依頼する(取り残しの補完)。
 *  - `manual`: `POST /api/reports/run`(画面のボタン)。
 * 1 日 1 回で確定し、作成後に取り込まれた結果や追加の分析は反映しない。
 *
 * ## 段階(1 回のアラームで 1 段階だけ進める)
 * `list`(その日の分析を、レースごとに最新の 1 件に絞って列挙)→ `gather`({@link REPORT_READ_CHUNK} レースずつ読んでダイジェスト化)→ `generate`(LLM を 1 回)→
 * `save`(D1 に保存)→ `notify`(Discord に 1 回)。段階を分ける理由: Workers Free の「1 呼び出し 50 サブリクエスト」。1 レースの読み出しは約 4(分析の詳細の D1 の batch・
 * R2 の get・読み出しの回数の記録・配分の batch)なので、{@link REPORT_READ_CHUNK}(8)レースで約 33 に収める(結果の読み出し 1 を含む)。
 *
 * ## 冪等性・失敗
 *  - 状態はジョブ(kv の `job:<開催日>`)に置く。LLM の応答は**成功した直後に**ジョブへ書き、保存の失敗の再試行で LLM を呼び直さない。
 *  - 段階の失敗は {@link REPORT_RETRY_DELAY_MS} 後に再試行、{@link REPORT_MAX_STEP_ATTEMPTS} 回で `failed`(アラームを張らない。手動の再依頼で最初からやり直せる)。
 *  - LLM は {@link REPORT_MAX_LLM_ATTEMPTS} 回まで。使えなければ統計だけの日報を保存する(固定の理由つき)。API のエラーの本文・鍵は状態にもログにも残さない。
 *  - 通知は**多くとも 1 回**(送る前に `sending` を書く。落ちたら再送せずに終える)。通知の失敗は日報を巻き戻さない。
 */
import { AnthropicLlmClient } from "@keiba/core/llm";
import { isRealYmd } from "../client/date";
import { jstKaisaiDate } from "./auto-run-plan";
import { buildDayStats, buildRaceDigest, type DayStats, type DigestTopHorse, type RaceDigest } from "./daily-report-digest";
import { buildReportEmbed } from "./daily-report-embed";
import { buildReportPrompt, parseNarrative, raceTitle, REPORT_MAX_TOKENS, type Narrative } from "./daily-report-prompt";
import { serializeLlmCalls, type LlmCallRecord } from "./llm-calls";
import { createCallLog, createCloudModelSelectors, createMeteredSender, redactSecrets, withErrorLog, type ModelSelectorFor } from "./llm-run";
import type { CloudLlm } from "./llm-sender";
import { buildReportLink } from "./notify-link";
import { classifyNotifyError, type DiscordNotifier } from "./notify-send";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "./settings";
import type { AnalysisView } from "./analysis-view";
import type { RaceResultData } from "./daily-report-bets";

/** 日報の DO の固定名(単一インスタンス)。依頼する側(handler.ts・scheduled.ts・race-day-do.ts)が同じ名前を使う。 */
export const DAILY_REPORT_NAME = "main";

/**
 * auto・catchup の依頼を受ける開催日の古さの上限(日)。JST の今日から、この日数前まで(含む)。それより古い日は `too-old` で断る(LLM・D1 に出ない)。
 * 理由: 日単位の DO は、過去日でも(結果の補完・掃除のアラームで)静かな状態で起こされると日報を依頼するので、上限が無いと古い日の日報が次々に作られ、LLM の費用が増える。
 * manual(利用者が日付を指定して押す)は上限なし。
 */
export const REPORT_MAX_AGE_DAYS = 3;

/** 1 回のアラームで読むレース数。1 レース約 4 サブリクエスト + 結果の読み出し 1 で約 33(Free の 50 の手前)。 */
export const REPORT_READ_CHUNK = 8;
/** 失敗後の再試行までの待ち(ミリ秒)。 */
export const REPORT_RETRY_DELAY_MS = 60_000;
/** list・gather・save の連続失敗の上限。超えたらジョブは failed。 */
export const REPORT_MAX_STEP_ATTEMPTS = 3;
/** LLM の呼び出しの上限(1 回の呼び出しの上限時間は sender の 180 秒)。超えたら統計だけの日報。 */
export const REPORT_MAX_LLM_ATTEMPTS = 2;

/** 文章が無いときの理由(固定文言)。 */
export const REPORT_NOTE_NO_KEY = "LLM の API キーが未登録のため、統計だけの日報です";
export const REPORT_NOTE_FAILED = "LLM を使えなかったため、統計だけの日報です";
export const REPORT_NOTE_UNPARSED = "LLM の応答を構造として読めなかったため、生の文章を載せています";

/** 生の文章を残す上限と、総括に使う先頭の長さ。 */
const RAW_MAX_CHARS = 20_000;
const RAW_SUMMARY_CHARS = 300;

// ---- 外への口(ポート) ----

/** DO のストレージ(`ctx.storage.kv`)のうち使う部分(同期)。 */
export interface DailyReportKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

/** 1 レースのダイジェストの材料。 */
export interface RaceInput {
  readonly view: AnalysisView;
  /** 結果が取り込まれていなければ undefined。 */
  readonly result: RaceResultData | undefined;
}

export interface DayAnalysisRef {
  readonly raceId: string;
  readonly analysisId: number;
}

export interface ReportSource {
  /** その開催日の分析を、レースごとに最新の 1 件に絞って返す(レース ID 昇順。開催日が NULL の分析は含まない)。 */
  listDayAnalyses(kaisaiDate: string): Promise<readonly DayAnalysisRef[]>;
  /** 指定した分析の材料(items と同じ順。分析が見つからなければ null)。 */
  readRaces(items: readonly DayAnalysisRef[]): Promise<ReadonlyArray<RaceInput | null>>;
}

export interface ReportStore {
  hasReport(kaisaiDate: string): Promise<boolean>;
  /** 日報を保存する。同じ日が既にあれば上書きせず `exists`。 */
  saveReport(record: ReportRecord): Promise<"saved" | "exists">;
}

// ---- 日報の形 ----

export interface ReportRaceRow {
  readonly raceId: string;
  readonly analysisId: number;
  readonly title: string;
  readonly venueName: string | null;
  readonly raceNumber: number | null;
  readonly raceName: string | null;
  readonly startTime: string | null;
  readonly llmUsed: boolean;
  readonly hasResult: boolean;
  readonly top3: readonly DigestTopHorse[];
  /** 印の付いた馬と着順。 */
  readonly marks: readonly { readonly mark: string; readonly umaban: number; readonly name: string | null; readonly finishPosition: number | null }[];
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly judgedBetCount: number;
  readonly hitCount: number;
  readonly unjudgedBetCount: number;
  readonly allocationNote: string | null;
  /** LLM のレース別の一言。 */
  readonly comment: string | null;
}

/** D1 の `daily_reports.body_json` の中身。 */
export interface ReportBody {
  readonly format: 1;
  readonly kaisaiDate: string;
  readonly stats: DayStats;
  readonly races: readonly ReportRaceRow[];
  readonly narrative: Narrative | null;
  /** 応答が構造として読めなかったときの生の文章。 */
  readonly narrativeRaw: string | null;
  /** 文章が無い・生の文章のときの理由(固定文言)。 */
  readonly note: string | null;
}

export interface ReportRecord {
  readonly kaisaiDate: string;
  /** 作成時刻(ISO 8601 UTC)。 */
  readonly createdAt: string;
  /** 文章を書いたモデル。文章が無ければ null。 */
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
  readonly body: ReportBody;
  readonly llmCallsJson: string | null;
}

// ---- 依頼・状態 ----

export type ReportMode = "auto" | "catchup" | "manual";

export type RequestReportResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "invalid-date" | "future-date" | "too-old" | "in-progress" | "exists" };

/**
 * 日単位の DO(auto の依頼)が、依頼の結果を「完了」として扱うか(依頼済みの印を書き、再依頼しない)。受理・作成済み(exists)・進行中(in-progress)・古すぎる日(too-old)は完了。
 * 日付が不正・未来(invalid-date・future-date)は、日付の食い違いなので完了にしない(警告を残し、次の起床で再び依頼する)。
 */
export function isRequestSettled(result: RequestReportResult): boolean {
  return result.accepted || result.reason === "exists" || result.reason === "in-progress" || result.reason === "too-old";
}

export type ReportPhase = "list" | "gather" | "generate" | "save" | "notify";

export interface ReportStatus {
  readonly phase: ReportPhase;
  readonly status: "running" | "failed";
  readonly attempts: number;
}

export type StepOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "ran"; readonly kaisaiDate: string; readonly phase: ReportPhase; readonly result: "ok" | "retry" | "failed" | "no-analyses" | "exists" };

interface Job {
  kaisaiDate: string;
  mode: ReportMode;
  createdAt: number;
  phase: ReportPhase;
  status: "running" | "failed";
  attempts: number;
  nextAt: number;
  items: DayAnalysisRef[];
  cursor: number;
  digests: RaceDigest[];
  llmAttempts: number;
  llmText: string | null;
  llmModel: string | null;
  llmGaveUp: boolean;
  calls: LlmCallRecord[];
  record: ReportRecord | null;
  notify: "pending" | "sending";
}

const JOBS_KEY = "jobs";
const jobKey = (kaisaiDate: string): string => `job:${kaisaiDate}`;

export interface DailyReportDeps {
  readonly kv: DailyReportKv;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly onWarn: (message: string) => void;
  readonly source: ReportSource;
  readonly store: ReportStore;
  /** 設定(D1)。使うのは `analysisModel` だけ。読めなければ既定値で続ける。 */
  readonly loadSettings: () => Promise<CloudSettings>;
  /** LLM の依存。**キーが無ければ渡さない**(統計だけの日報)。 */
  readonly llm?: CloudLlm;
  /** Discord への送信。無ければ通知しない。 */
  readonly notifier?: DiscordNotifier;
  /** 日報へのリンクの基点(検証済みのオリジン)。無ければリンクなしで通知する。 */
  readonly appBaseUrl?: string;
}

function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let head = text.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}…`;
}

/** 開催日(YYYYMMDD)を日数だけずらす(JST の暦日。`Date.UTC` の正規化で月またぎも合う)。 */
function shiftKaisaiDate(kaisaiDate: string, deltaDays: number): string {
  const d = new Date(Date.UTC(Number(kaisaiDate.slice(0, 4)), Number(kaisaiDate.slice(4, 6)) - 1, Number(kaisaiDate.slice(6, 8))) + deltaDays * 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export class DailyReportCore {
  private readonly selectors: ModelSelectorFor | undefined;

  constructor(private readonly deps: DailyReportDeps) {
    this.selectors = deps.llm === undefined ? undefined : createCloudModelSelectors(deps.llm, deps.onWarn);
  }

  // ---- 依頼 ----

  async requestReport(input: { readonly kaisaiDate: string; readonly mode: ReportMode }): Promise<RequestReportResult> {
    const { kaisaiDate } = input;
    if (!/^[0-9]{8}$/.test(kaisaiDate) || !isRealYmd(kaisaiDate)) {
      return { accepted: false, reason: "invalid-date" };
    }
    const today = jstKaisaiDate(this.deps.now());
    if (kaisaiDate > today) {
      return { accepted: false, reason: "future-date" };
    }
    if (input.mode !== "manual" && kaisaiDate < shiftKaisaiDate(today, -REPORT_MAX_AGE_DAYS)) {
      return { accepted: false, reason: "too-old" };
    }
    const existing = this.deps.kv.get<Job>(jobKey(kaisaiDate));
    if (existing !== undefined && existing.status === "running") {
      return { accepted: false, reason: "in-progress" };
    }
    if (await this.deps.store.hasReport(kaisaiDate)) {
      return { accepted: false, reason: "exists" };
    }
    // await を挟んだので、ここで同じ日のジョブが積まれていないかを見直す(並行した依頼の二重のジョブを作らない)。
    const again = this.deps.kv.get<Job>(jobKey(kaisaiDate));
    if (again !== undefined && again.status === "running") {
      return { accepted: false, reason: "in-progress" };
    }
    const now = this.deps.now();
    const job: Job = {
      kaisaiDate, mode: input.mode, createdAt: now, phase: "list", status: "running", attempts: 0, nextAt: now,
      items: [], cursor: 0, digests: [], llmAttempts: 0, llmText: null, llmModel: null, llmGaveUp: false, calls: [], record: null, notify: "pending",
    };
    this.putJob(job);
    this.addToIndex(kaisaiDate);
    await this.rearm();
    return { accepted: true };
  }

  getStatus(kaisaiDate: string): ReportStatus | null {
    const job = this.deps.kv.get<Job>(jobKey(kaisaiDate));
    return job === undefined ? null : { phase: job.phase, status: job.status, attempts: job.attempts };
  }

  // ---- アラーム ----

  /** 時刻が来ているジョブを 1 つ選び、1 段階だけ進める。 */
  async runNextStep(): Promise<StepOutcome> {
    const now = this.deps.now();
    const due = this.runningJobs()
      .filter((j) => j.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt || (a.kaisaiDate < b.kaisaiDate ? -1 : 1))[0];
    if (due === undefined) {
      await this.rearm();
      return { kind: "idle" };
    }
    const outcome = await this.runPhase(due);
    await this.rearm();
    return outcome;
  }

  private async runPhase(job: Job): Promise<StepOutcome> {
    const phase = job.phase;
    const ran = (result: "ok" | "retry" | "failed" | "no-analyses" | "exists"): StepOutcome => ({ kind: "ran", kaisaiDate: job.kaisaiDate, phase, result });
    try {
      switch (phase) {
        case "list":
          return ran(await this.runList(job));
        case "gather":
          return ran(await this.runGather(job));
        case "generate":
          return ran(await this.runGenerate(job));
        case "save":
          return ran(await this.runSave(job));
        case "notify":
          return ran(await this.runNotify(job));
      }
    } catch (error) {
      // 段階の失敗: 試行を数えて再試行、上限で failed。エラーの本文はログにだけ(redact して先頭 200 字)。状態には残さない。
      const attempts = job.attempts + 1;
      this.deps.onWarn(`日報(${job.kaisaiDate}): ${phase} に失敗しました(試行 ${attempts} 回): ${errorText(error)}`);
      if (attempts >= REPORT_MAX_STEP_ATTEMPTS) {
        this.putJob({ ...job, attempts, status: "failed" });
        this.removeFromIndex(job.kaisaiDate);
        return ran("failed");
      }
      this.putJob({ ...job, attempts, nextAt: this.deps.now() + REPORT_RETRY_DELAY_MS });
      return ran("retry");
    }
  }

  private async runList(job: Job): Promise<"ok" | "no-analyses"> {
    const items = [...(await this.deps.source.listDayAnalyses(job.kaisaiDate))];
    if (items.length === 0) {
      this.finish(job.kaisaiDate);
      return "no-analyses";
    }
    this.putJob({ ...job, items, cursor: 0, phase: "gather", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async runGather(job: Job): Promise<"ok" | "no-analyses"> {
    const slice = job.items.slice(job.cursor, job.cursor + REPORT_READ_CHUNK);
    const inputs = await this.deps.source.readRaces(slice);
    const digests = [...job.digests];
    for (const input of inputs) {
      if (input !== null) {
        digests.push(buildRaceDigest(input.view, input.result));
      }
    }
    const cursor = job.cursor + slice.length;
    if (cursor < job.items.length) {
      this.putJob({ ...job, digests, cursor, attempts: 0, nextAt: this.deps.now() });
      return "ok";
    }
    if (digests.length === 0) {
      this.finish(job.kaisaiDate);
      return "no-analyses";
    }
    this.putJob({ ...job, digests, cursor, phase: "generate", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async runGenerate(job: Job): Promise<"ok" | "retry"> {
    const digests = [...job.digests].sort((a, b) => (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0));
    const stats = buildDayStats(digests);
    let current = job;
    if (this.deps.llm !== undefined && current.llmText === null && !current.llmGaveUp) {
      // 試行は呼ぶ前に永続化する(落ちても無限に続かない)。
      current = { ...current, llmAttempts: current.llmAttempts + 1 };
      this.putJob(current);
      const outcome = await this.callLlm(buildReportPrompt({ kaisaiDate: job.kaisaiDate, digests, stats }));
      if (outcome.ok) {
        // 応答は成功した直後に書く(保存の失敗の再試行で LLM を呼び直さない)。
        current = { ...current, llmText: outcome.text, llmModel: outcome.model, calls: [...current.calls, ...outcome.calls] };
        this.putJob(current);
      } else {
        const giveUp = current.llmAttempts >= REPORT_MAX_LLM_ATTEMPTS;
        this.deps.onWarn(`日報(${job.kaisaiDate}): LLM の呼び出しに失敗しました(${outcome.description}。試行 ${current.llmAttempts} 回${giveUp ? "。統計だけの日報にします" : ""})`);
        current = { ...current, llmGaveUp: giveUp, calls: [...current.calls, ...outcome.calls], nextAt: giveUp ? this.deps.now() : this.deps.now() + REPORT_RETRY_DELAY_MS };
        this.putJob(current);
        if (!giveUp) {
          return "retry";
        }
      }
    }
    const record = this.buildRecord(current, digests, stats);
    this.putJob({ ...current, record, phase: "save", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async callLlm(prompt: string): Promise<{ ok: true; text: string; model: string | null; calls: LlmCallRecord[] } | { ok: false; description: string; calls: LlmCallRecord[] }> {
    const llm = this.deps.llm!;
    const log = createCallLog();
    let settings: CloudSettings = DEFAULT_CLOUD_SETTINGS;
    try {
      settings = await this.deps.loadSettings();
    } catch {
      this.deps.onWarn("日報: 設定を読めなかったため、既定のモデルの選択で続けます");
    }
    const sender = createMeteredSender(withErrorLog(llm.sender, this.deps.onWarn), log, this.deps.now);
    const selector = this.selectors?.(settings.analysisModel);
    const client = new AnthropicLlmClient({ maxTokens: REPORT_MAX_TOKENS }, { sender, ...(selector === undefined ? {} : { modelSelector: selector }), onWarn: this.deps.onWarn });
    try {
      const done = await client.completeDetailed(prompt);
      return { ok: true, text: done.text, model: done.model ?? null, calls: log.calls() as LlmCallRecord[] };
    } catch (error) {
      const calls = log.calls() as LlmCallRecord[];
      return { ok: false, description: calls[calls.length - 1]?.error ?? "種別=other", calls };
    }
  }

  private buildRecord(job: Job, digests: readonly RaceDigest[], stats: DayStats): ReportRecord {
    const knownIds = new Set(digests.map((d) => d.raceId));
    let narrative: Narrative | null = null;
    let narrativeRaw: string | null = null;
    let note: string | null = null;
    let summary: string | null = null;
    if (this.deps.llm === undefined) {
      note = REPORT_NOTE_NO_KEY;
    } else if (job.llmText === null) {
      note = REPORT_NOTE_FAILED;
    } else {
      narrative = parseNarrative(job.llmText, knownIds);
      if (narrative === null) {
        narrativeRaw = cut(job.llmText.trim(), RAW_MAX_CHARS);
        summary = cut(job.llmText.trim(), RAW_SUMMARY_CHARS);
        note = REPORT_NOTE_UNPARSED;
      } else {
        summary = narrative.summary;
      }
    }
    const comments = new Map((narrative?.races ?? []).map((r) => [r.raceId, r.comment] as const));
    const races: ReportRaceRow[] = digests.map((d) => ({
      raceId: d.raceId,
      analysisId: d.analysisId,
      title: raceTitle(d),
      venueName: d.venueName,
      raceNumber: d.raceNumber,
      raceName: d.raceName,
      startTime: d.startTime,
      llmUsed: d.llmUsed,
      hasResult: d.hasResult,
      top3: d.top3,
      marks: d.horses.filter((h) => h.mark !== null).map((h) => ({ mark: h.mark!, umaban: h.umaban, name: h.name, finishPosition: h.finishPosition })),
      totalStake: d.totalStake,
      totalReturn: d.totalReturn,
      judgedBetCount: d.judgedBetCount,
      hitCount: d.hitCount,
      unjudgedBetCount: d.unjudgedBetCount,
      allocationNote: d.allocationNote,
      comment: comments.get(d.raceId) ?? null,
    }));
    return {
      kaisaiDate: job.kaisaiDate,
      createdAt: new Date(this.deps.now()).toISOString(),
      model: narrative !== null || narrativeRaw !== null ? job.llmModel : null,
      raceCount: digests.length,
      totalStake: stats.totalStake,
      totalReturn: stats.totalReturn,
      summary,
      body: { format: 1, kaisaiDate: job.kaisaiDate, stats, races, narrative, narrativeRaw, note },
      llmCallsJson: serializeLlmCalls(job.calls.length === 0 ? null : job.calls),
    };
  }

  private async runSave(job: Job): Promise<"ok" | "exists"> {
    if (job.record === null) {
      throw new Error("保存する日報がありません");
    }
    const saved = await this.deps.store.saveReport(job.record);
    if (saved === "exists") {
      // 別の経路が先に作った。上書きも通知もしない。
      this.finish(job.kaisaiDate);
      return "exists";
    }
    this.putJob({ ...job, phase: "notify", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async runNotify(job: Job): Promise<"ok" | "failed"> {
    const record = job.record;
    if (this.deps.notifier === undefined || record === null || job.notify === "sending") {
      // 通知の仕組みが無い、または送信中に落ちた(再送しない)。
      this.finish(job.kaisaiDate);
      return "ok";
    }
    const body = record.body;
    const narrative = body.narrative ?? (record.summary === null ? null : { summary: record.summary, good: [], improve: [], races: [] });
    const link = this.deps.appBaseUrl === undefined ? undefined : buildReportLink(this.deps.appBaseUrl, job.kaisaiDate);
    const embed = buildReportEmbed({ kaisaiDate: job.kaisaiDate, stats: body.stats, narrative, note: body.note, link });
    // 送る前に sending を書く(ここまで同期。落ちても再送しない)。
    this.putJob({ ...job, notify: "sending" });
    let ok = true;
    try {
      await this.deps.notifier.send({ embeds: [embed] });
    } catch (error) {
      ok = false;
      this.deps.onWarn(`Discord への日報の通知に失敗しました(${job.kaisaiDate}。分類: ${classifyNotifyError(error)}。再送しません)`);
    }
    this.finish(job.kaisaiDate);
    return ok ? "ok" : "failed";
  }

  // ---- ジョブの保存 ----

  private putJob(job: Job): void {
    this.deps.kv.put(jobKey(job.kaisaiDate), job);
  }

  private finish(kaisaiDate: string): void {
    this.deps.kv.delete(jobKey(kaisaiDate));
    this.removeFromIndex(kaisaiDate);
  }

  private index(): string[] {
    return this.deps.kv.get<string[]>(JOBS_KEY) ?? [];
  }

  private addToIndex(kaisaiDate: string): void {
    const index = this.index();
    if (!index.includes(kaisaiDate)) {
      this.deps.kv.put(JOBS_KEY, [...index, kaisaiDate]);
    }
  }

  private removeFromIndex(kaisaiDate: string): void {
    const rest = this.index().filter((d) => d !== kaisaiDate);
    if (rest.length === 0) {
      this.deps.kv.delete(JOBS_KEY);
    } else {
      this.deps.kv.put(JOBS_KEY, rest);
    }
  }

  private runningJobs(): Job[] {
    const jobs: Job[] = [];
    for (const date of this.index()) {
      const job = this.deps.kv.get<Job>(jobKey(date));
      if (job !== undefined && job.status === "running") {
        jobs.push(job);
      }
    }
    return jobs;
  }

  /** 動かせるジョブの最も早い時刻にアラームを張る(無ければ張らない)。 */
  private async rearm(): Promise<void> {
    const jobs = this.runningJobs();
    if (jobs.length === 0) {
      return;
    }
    await this.deps.setAlarm(Math.max(Math.min(...jobs.map((j) => j.nextAt)), this.deps.now()));
  }
}
