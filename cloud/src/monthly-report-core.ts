/**
 * 月報(Issue #265。段階 A = #279・段階 B = #280)の作成の流れ。**純ロジック**: `cloudflare:workers` を import しない。ストレージ(kv)・時計・アラーム・D1 の読み出しと保存・LLM・Discord は
 * 引数で受けるので、Node の vitest でテストできる。本物の配線は `monthly-report-do.ts`(DO `MonthlyReportDO`)。
 *
 * ## 役割
 * 当月 1 日〜最終日(ユーザーの決定・2026-10-13)の予想と結果を D1 から再集計し(`D1MonthlySource.readMonthStats`。日報の 28 日累計と同じ `readPeriodStats` の経路 + 日ごと・版ごとの行)、
 * LLM による振り返りの文章(総括・良かった点・改善点・来月に向けて)を足して、D1 に月ごとに 1 行で保存し、Discord に要約を送る。月報は記録と振り返りの材料で、プロンプトを自動で変えない。
 * LLM に渡すのは月の確定値の節だけ(各レースのブロックと日報の総括は渡さない。`monthly-report-prompt.ts`)。モデルは予想と同じ(設定の `analysisModel`。日報の選び方を流用)。
 *
 * ## 起動(いつ作るか)
 * このコアは「作る」依頼({@link MonthlyReportCore.requestMonthly})を受けるだけで、**いつ作るかは決めない**(決めるのは `monthly-report-plan.ts` と `scheduled.ts`・手動の入口)。依頼は次の 4 経路:
 *  - `auto`: 最終日の cron(21:00)が `startAt`(同日 22:00 JST)つきで依頼する。23:00 の cron も同じ依頼を出す(冪等。21:00 の依頼が落ちたときの保険)。
 *  - `catchup`: 月が明けて 3 日以内の 23:00 の cron が、前月の取り残しを依頼する。
 *  - `manual`: `POST /api/monthly-reports/run`(管理者)。終わった月(最終日が今日より前)で月報が無い月だけ。**今月の月報は、最終日の自動作成でだけ作る**(ユーザーの決定)。
 *  - `regenerate`: 同じ入口に `regenerate: true` を付けた、管理者の作り直し(日報の #268 と同じ形)。**終わった月で月報がある月だけ**を、いまの分析と結果で作り直して上書きする(下の「作り直し」)。
 * 通常の作成は 1 月 1 回で確定し、上書きしない。作り直しだけがそれを上書きする。
 * **Discord に送るのは auto と catchup だけ**(ユーザーの決定)。手動の作成と作り直しでは送らない。
 *
 * ## 段階(1 回のアラームで 1 段階だけ進める)
 * `read`(最終日の結果と日報を待つ → 月の統計を D1 から 1 回読む)→ `generate`(LLM を 1 回)→ `save`(D1 に保存)→ `notify`(Discord に 1 回。auto・catchup だけ)。
 *  - **待ち**(最終日の結果の取り込みと、その日の日報の確定。**auto と catchup だけ**): `read` の先頭で D1 に 1 回だけ軽く問い合わせ({@link LastDayStatus})、最終日の分析のうち結果が未取込のレースがある、または
 *    最終日に分析があるのに日報が無いなら、{@link MONTHLY_WAIT_INTERVAL_MS} 後にもう一度確かめる(失敗に数えない)。最大 {@link MONTHLY_MAX_WAITS} 回(約 60 分)待ってもそろわなければ、そのまま作り、
 *    本文の `lastDayPending` に印を残す。待つのは**最終日の翌日 3:00(JST)まで**(それ以降の依頼は、すでに終わって久しい月の補完なので待たない)。
 *    **手動の作成と作り直しは待たない**(管理者が押した時点の分析と結果で作る。ユーザーの決定)。
 *  - 月の再集計は D1 の batch 1 回(サブリクエスト 1)。結果は統計(日ごと・版ごとの行を含む)にして kv に残す(小さい)。
 *  - `generate` の 1 回のアラームのサブリクエストは、設定の読み出し 1・モデル一覧 1・messages.create 最大 2(自動選択のモデルが拒否されたときの固定モデルでの再送)で、多くとも 4(Free の 50 に対して余裕がある)。
 *
 * ## 冪等性・失敗
 *  - 状態はジョブ(kv の `job:<YYYYMM>`)に置く。読み出しの結果・LLM の応答は**成功した直後に**ジョブへ書き、保存の失敗の再試行で読み直さず、LLM を呼び直さない。
 *  - 段階の失敗は {@link MONTHLY_RETRY_DELAY_MS} 後に再試行、{@link MONTHLY_MAX_STEP_ATTEMPTS} 回で `failed`(アラームを張らない。再依頼で最初からやり直せる)。
 *  - LLM は {@link MONTHLY_MAX_LLM_ATTEMPTS} 回まで(日報の `REPORT_MAX_LLM_ATTEMPTS` と同じ。ユーザーの決定)。使えなければ統計だけの月報を保存する(固定の理由つき)。
 *    **JSON として読めない応答は再試行せず**、生の文章を `narrativeRaw` に残す(日報と同じ)。API のエラーの本文・鍵は状態にもログにも残さない。
 *  - 通知は**多くとも 1 回**(送る前に `sending` を書く。落ちたら再送せずに終える)。通知の失敗は月報を巻き戻さない。
 *
 * ## 作り直し(Issue #280。ユーザーの決定: 自動の作り直しはしない。管理者が押したときだけ)
 *  - 同じ段階(read → generate → save)を通り、統計は作り直す時点の D1 から再計算する(前の月報から何も引き継がない)。
 *  - **保存(save)だけが D1 を書く**。それまでの失敗では前の月報は変わらない。save は {@link MonthlyStore.replaceReport}(1 文の UPSERT)で、上書きの途中の状態が無い。
 *  - **Discord には送らない**。通知に入る経路は `runSave` が `phase: "notify"` を書く 1 本だけで、作り直し・手動の作成はそこを通らず `finish` する。
 *  - 1 日(JST)に受理できる回数は全体で {@link MONTHLY_REGEN_DAILY_LIMIT} 回(LLM の費用を守る。**日報の枠とは別**: この DO の kv に持つ)。受理したときだけ数え、失敗した作り直しも返さない。
 *  - 置き換えを断られた(`kept`。LLM の文章がある前の月報を、文章の無い新しい記録で潰さない規則)・分析が見つからない作り直しは、`failed` のジョブとして残す(画面が「前の月報のまま」と出せる)。
 */
import { AnthropicLlmClient } from "@keiba/core/llm";
import { isRealYmd } from "../client/date";
import { jstKaisaiDate } from "./auto-run-plan";
import { buildMonthlyEmbed } from "./monthly-report-embed";
import { jstMsOf, isValidMonth, monthRange } from "./monthly-month";
import { buildMonthlyPrompt, MONTHLY_MAX_TOKENS, MONTHLY_PROMPT_VERSION, parseMonthlyNarrative, type MonthlyNarrative } from "./monthly-report-prompt";
import { serializeLlmCalls, type LlmCallRecord } from "./llm-calls";
import { createCallLog, createCloudModelSelectors, createMeteredSender, redactSecrets, withErrorLog, type ModelSelectorFor } from "./llm-run";
import type { CloudLlm } from "./llm-sender";
import type { MonthStats } from "./monthly-stats";
import { buildMonthlyLink } from "./notify-link";
import { classifyNotifyError, type DiscordNotifier } from "./notify-send";
import { addDaysToKaisaiDate } from "./result-dispatch";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "./settings";

/** 月報の DO の固定名(単一インスタンス)。依頼する側(scheduled.ts・handler.ts)が同じ名前を使う。 */
export const MONTHLY_REPORT_NAME = "main";

/** auto・catchup の依頼を受ける、最終日からの古さの上限(日)。日報の `REPORT_MAX_AGE_DAYS` と同じ。それより古い月は `too-old` で断る(manual・regenerate は上限なし)。 */
export const MONTHLY_MAX_AGE_DAYS = 3;
/** 最終日の結果・日報を待つ間隔(ミリ秒)と、待つ回数の上限(約 60 分)。 */
export const MONTHLY_WAIT_INTERVAL_MS = 10 * 60_000;
export const MONTHLY_MAX_WAITS = 6;
/** 待ちを許す期限: 最終日の翌日のこの時(JST)まで。 */
export const MONTHLY_WAIT_UNTIL_JST_HOUR = 3;
/** `startAt` として受け入れる、今からの先の上限(ミリ秒)。これより先は無視して今すぐ始める(月報のジョブを遠い未来に眠らせない)。 */
export const MONTHLY_START_AT_MAX_AHEAD_MS = 24 * 3_600_000;
/** 失敗後の再試行までの待ち(ミリ秒)と、連続の失敗の上限。超えたらジョブは failed。 */
export const MONTHLY_RETRY_DELAY_MS = 60_000;
export const MONTHLY_MAX_STEP_ATTEMPTS = 3;
/** LLM の呼び出しの上限(1 回の呼び出しの上限時間は sender の 180 秒)。日報の `REPORT_MAX_LLM_ATTEMPTS` と同じ。超えたら統計だけの月報。 */
export const MONTHLY_MAX_LLM_ATTEMPTS = 2;
/**
 * 作り直し(mode: regenerate)を受理できる回数の、JST の 1 日あたりの上限(全体)。日報の `REPORT_REGEN_DAILY_LIMIT` と同じ値だが、**別の枠**(日報の DO とこの DO は別の kv)。
 * 1 回の作り直しは LLM を最大 {@link MONTHLY_MAX_LLM_ATTEMPTS} 回呼ぶので、誤操作の連打で課金しないための柵。同じ月の連打は `in-progress` が既に防ぐ。受理したときだけ数える。
 */
export const MONTHLY_REGEN_DAILY_LIMIT = 3;
/** 作り直しの回数の記録(kv のキー `regen`)。日付が変わっていれば数え直すので、古い記録の掃除は要らない。 */
const REGEN_KEY = "regen";
interface RegenQuota {
  /** 受理した日(JST の YYYYMMDD。依頼した日)。 */
  day: string;
  count: number;
}

/** 文章が無いときの理由(固定文言)。 */
export const MONTHLY_NOTE_NO_KEY = "LLM の API キーが未登録のため、統計だけの月報です";
export const MONTHLY_NOTE_FAILED = "LLM を使えなかったため、統計だけの月報です";
export const MONTHLY_NOTE_UNPARSED = "LLM の応答を構造として読めなかったため、生の文章を載せています";

/** 生の文章を残す上限と、総括に使う先頭の長さ(日報と同じ)。 */
const RAW_MAX_CHARS = 20_000;
const RAW_SUMMARY_CHARS = 300;

// ---- 外への口(ポート) ----

/** DO のストレージ(`ctx.storage.kv`)のうち使う部分(同期)。 */
export interface MonthlyReportKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

/** 最終日 1 日分の状態(待つかどうかの判断材料)。 */
export interface LastDayStatus {
  /** 最終日の分析のレース数(レースごとに最新の 1 件)。 */
  readonly raceCount: number;
  /** そのうち、結果(`race_results`)の行が 1 つも無いレース数。 */
  readonly noResultRaceCount: number;
  /** 最終日の日報があるか。 */
  readonly hasDailyReport: boolean;
}

export interface MonthlySource {
  /** 最終日 1 日分の状態(軽い問い合わせ。読めなければ例外 = 段階の再試行)。 */
  lastDayStatus(date: string): Promise<LastDayStatus>;
  /** 月 `[fromDate, toDate]` の統計を D1 から再集計する(日ごと・版ごとの行つき)。読めなければ例外(段階の再試行に任せる)。 */
  readMonthStats(fromDate: string, toDate: string): Promise<MonthStats>;
}

export interface MonthlyStore {
  hasReport(month: string): Promise<boolean>;
  /** 月報を保存する。同じ月が既にあれば上書きせず `exists`。 */
  saveReport(record: MonthlyReportRecord): Promise<"saved" | "exists">;
  /**
   * 作り直しの保存: 同じ月の月報を**1 文で**置き換える(途中の状態が無く、失敗すれば前の月報のまま)。
   * ただし、前の月報に LLM の文章があり、新しい記録に文章が無い(`model` が null)ときは置き換えず `kept`(良い月報を、LLM が使えなかった作り直しで潰さない)。
   * 前の月報が無ければ(消えていれば)通常の保存と同じに作る。
   */
  replaceReport(record: MonthlyReportRecord): Promise<"replaced" | "kept">;
}

// ---- 月報の形 ----

/** D1 の `monthly_reports.body_json` の中身。 */
export interface MonthlyReportBody {
  readonly format: 1;
  readonly month: string;
  readonly stats: MonthStats;
  /** 最終日の結果・日報がそろうのを待ちきれずに作った(最終日の分が一部未反映かもしれない)。 */
  readonly lastDayPending: boolean;
  /** LLM の文章。使えなかった・読めなかったときは null。 */
  readonly narrative: MonthlyNarrative | null;
  /** 応答が構造として読めなかったときの生の文章。 */
  readonly narrativeRaw: string | null;
  /** 文章が無い・生の文章のときの理由(固定文言)。 */
  readonly note: string | null;
  /** 月報を書いたプロンプトの版(`MONTHLY_PROMPT_VERSION`)。 */
  readonly promptVersion: string;
}

export interface MonthlyReportRecord {
  readonly month: string;
  /** 作成時刻(ISO 8601 UTC)。 */
  readonly createdAt: string;
  /** 文章を書いたモデル。文章(または生の文章)が無ければ null。 */
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
  readonly body: MonthlyReportBody;
  readonly llmCallsJson: string | null;
}

// ---- 依頼・状態 ----

export type MonthlyMode = "auto" | "catchup" | "manual" | "regenerate";

/**
 * 依頼の結果。`not-exists`(作り直しの依頼で、その月の月報が無い。作るのは通常の作成の仕事)・`daily-limit`(作り直しの 1 日の回数の上限。{@link MONTHLY_REGEN_DAILY_LIMIT})は、
 * 作り直しだけが返す。
 */
export type RequestMonthlyResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "invalid-month" | "not-ended" | "too-old" | "in-progress" | "exists" | "not-exists" | "daily-limit" };

/**
 * 依頼の結果を「完了」として扱うか(cron が再依頼しない)。受理・作成済み・進行中・古すぎる月は完了。月が不正・まだ終わっていない月は、暦の食い違いなので完了にしない。
 * 作り直しだけが返す理由(`not-exists`・`daily-limit`)は、自動の依頼には返らないので完了にしない。
 */
export function isMonthlyRequestSettled(result: RequestMonthlyResult): boolean {
  return result.accepted || result.reason === "exists" || result.reason === "in-progress" || result.reason === "too-old";
}

export type MonthlyPhase = "read" | "generate" | "save" | "notify";

export interface MonthlyStatus {
  readonly phase: MonthlyPhase;
  readonly status: "running" | "failed";
  readonly attempts: number;
  /** 作り直し(Issue #280)のジョブにだけ付く(`true`)。通常の作成のジョブにはキーそのものが無い。 */
  readonly regenerate?: true;
}

type StepResult = "ok" | "retry" | "failed" | "waiting" | "no-analyses" | "exists";

export type MonthlyStepOutcome = { readonly kind: "idle" } | { readonly kind: "ran"; readonly month: string; readonly phase: MonthlyPhase; readonly result: StepResult };

interface Job {
  month: string;
  mode: MonthlyMode;
  createdAt: number;
  phase: MonthlyPhase;
  status: "running" | "failed";
  /** 段階の連続の失敗の数(待ち・LLM の失敗は数えない)。 */
  attempts: number;
  /** 最終日の結果・日報を待った回数。 */
  waits: number;
  nextAt: number;
  /** read が読んだ月の統計(generate が使う)。 */
  stats: MonthStats | null;
  lastDayPending: boolean;
  llmAttempts: number;
  llmText: string | null;
  llmModel: string | null;
  llmGaveUp: boolean;
  calls: LlmCallRecord[];
  record: MonthlyReportRecord | null;
  notify: "pending" | "sending";
}

const JOBS_KEY = "jobs";
const jobKey = (month: string): string => `job:${month}`;

export interface MonthlyReportDeps {
  readonly kv: MonthlyReportKv;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly onWarn: (message: string) => void;
  readonly source: MonthlySource;
  readonly store: MonthlyStore;
  /** 設定(D1)。使うのは `analysisModel` だけ。読めなければ既定値で続ける。 */
  readonly loadSettings: () => Promise<CloudSettings>;
  /** LLM の依存。**キーが無ければ渡さない**(統計だけの月報)。 */
  readonly llm?: CloudLlm;
  /** Discord への送信。無ければ通知しない。 */
  readonly notifier?: DiscordNotifier;
  /** 月報へのリンクの基点(検証済みのオリジン)。無ければリンクなしで通知する。 */
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

/** 警告に出すエラーの文字列。API キーの形(`sk-ant-`)は伏せ、先頭 200 字に切る。 */
function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export class MonthlyReportCore {
  private readonly selectors: ModelSelectorFor | undefined;

  constructor(private readonly deps: MonthlyReportDeps) {
    this.selectors = deps.llm === undefined ? undefined : createCloudModelSelectors(deps.llm, deps.onWarn);
  }

  // ---- 依頼 ----

  async requestMonthly(input: { readonly month: string; readonly mode: MonthlyMode; readonly startAt?: number }): Promise<RequestMonthlyResult> {
    const { month, mode } = input;
    if (!isValidMonth(month) || !isRealYmd(`${month}01`)) {
      return { accepted: false, reason: "invalid-month" };
    }
    const today = jstKaisaiDate(this.deps.now());
    const lastDay = monthRange(month).toDate;
    const regenerate = mode === "regenerate";
    // 手動・作り直しは終わった月だけ(最終日が今日より前)。今月の月報は、最終日の自動作成でだけ作る。自動・補完は最終日の当日から。
    if (mode === "manual" || regenerate ? lastDay >= today : lastDay > today) {
      return { accepted: false, reason: "not-ended" };
    }
    if ((mode === "auto" || mode === "catchup") && lastDay < addDaysToKaisaiDate(today, -MONTHLY_MAX_AGE_DAYS)) {
      return { accepted: false, reason: "too-old" };
    }
    const existing = this.deps.kv.get<Job>(jobKey(month));
    if (existing !== undefined && existing.status === "running") {
      return { accepted: false, reason: "in-progress" };
    }
    const hasReport = await this.deps.store.hasReport(month);
    if (regenerate ? !hasReport : hasReport) {
      // 通常の作成は月報がある月を断る(exists)。作り直しは逆に、月報が無い月を断る(not-exists。作成の入口の仕事)。
      return { accepted: false, reason: regenerate ? "not-exists" : "exists" };
    }
    // await を挟んだので、ここで同じ月のジョブが積まれていないかを見直す(並行した依頼の二重のジョブを作らない)。
    const again = this.deps.kv.get<Job>(jobKey(month));
    if (again !== undefined && again.status === "running") {
      return { accepted: false, reason: "in-progress" };
    }
    const now = this.deps.now();
    if (regenerate) {
      // 1 日の回数。**最後の await のあと、ジョブを積むのと同じ同期の区間**で確かめて数える(並行した依頼が上限を超えない)。ここまでの断りは数えない。
      const day = jstKaisaiDate(now);
      const quota = this.deps.kv.get<RegenQuota>(REGEN_KEY);
      const used = quota !== undefined && quota.day === day ? quota.count : 0;
      if (used >= MONTHLY_REGEN_DAILY_LIMIT) {
        return { accepted: false, reason: "daily-limit" };
      }
      this.deps.kv.put(REGEN_KEY, { day, count: used + 1 } satisfies RegenQuota);
    }
    const startAt = input.startAt;
    const nextAt = startAt !== undefined && startAt > now && startAt <= now + MONTHLY_START_AT_MAX_AHEAD_MS ? startAt : now;
    this.putJob({
      month, mode, createdAt: now, phase: "read", status: "running", attempts: 0, waits: 0, nextAt,
      stats: null, lastDayPending: false, llmAttempts: 0, llmText: null, llmModel: null, llmGaveUp: false, calls: [], record: null, notify: "pending",
    });
    this.addToIndex(month);
    await this.rearm();
    return { accepted: true };
  }

  getStatus(month: string): MonthlyStatus | null {
    const job = this.deps.kv.get<Job>(jobKey(month));
    return job === undefined ? null : { phase: job.phase, status: job.status, attempts: job.attempts, ...(job.mode === "regenerate" ? { regenerate: true as const } : {}) };
  }

  // ---- アラーム ----

  /** 時刻が来ているジョブを 1 つ選び、1 段階だけ進める。 */
  async runNextStep(): Promise<MonthlyStepOutcome> {
    const now = this.deps.now();
    const due = this.runningJobs()
      .filter((j) => j.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt || (a.month < b.month ? -1 : 1))[0];
    if (due === undefined) {
      await this.rearm();
      return { kind: "idle" };
    }
    const outcome = await this.runPhase(due);
    await this.rearm();
    return outcome;
  }

  private async runPhase(job: Job): Promise<MonthlyStepOutcome> {
    const phase = job.phase;
    const ran = (result: StepResult): MonthlyStepOutcome => ({ kind: "ran", month: job.month, phase, result });
    try {
      switch (phase) {
        case "read":
          return ran(await this.runRead(job));
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
      this.deps.onWarn(`月報(${job.month}): ${phase} に失敗しました(試行 ${attempts} 回): ${errorText(error)}`);
      if (attempts >= MONTHLY_MAX_STEP_ATTEMPTS) {
        this.putJob({ ...job, attempts, status: "failed" });
        this.removeFromIndex(job.month);
        return ran("failed");
      }
      this.putJob({ ...job, attempts, nextAt: this.deps.now() + MONTHLY_RETRY_DELAY_MS });
      return ran("retry");
    }
  }

  private async runRead(job: Job): Promise<"ok" | "waiting" | "no-analyses"> {
    const { fromDate, toDate } = monthRange(job.month);
    let lastDayPending = false;
    // 待つのは自動・補完だけ(手動の作成と作り直しは、押した時点の分析と結果で作る)。
    const waits = job.mode === "auto" || job.mode === "catchup";
    if (waits && this.deps.now() < jstMsOf(addDaysToKaisaiDate(toDate, 1), MONTHLY_WAIT_UNTIL_JST_HOUR)) {
      // 最終日の結果の取り込みと、その日の日報の確定を待つ(軽い問い合わせ。本体の再集計は待ちのたびに読まない)。
      const status = await this.deps.source.lastDayStatus(toDate);
      const pending = status.noResultRaceCount > 0 || (status.raceCount > 0 && !status.hasDailyReport);
      if (pending) {
        if (job.waits < MONTHLY_MAX_WAITS) {
          this.putJob({ ...job, waits: job.waits + 1, attempts: 0, nextAt: this.deps.now() + MONTHLY_WAIT_INTERVAL_MS });
          return "waiting";
        }
        lastDayPending = true; // 待ちきれなかった: そのまま作り、印を残す
      }
    }
    const stats = await this.deps.source.readMonthStats(fromDate, toDate);
    if (stats.raceCount === 0) {
      this.endWithoutReport(job); // その月に分析したレースが無い: 月報は作らない
      return "no-analyses";
    }
    this.putJob({ ...job, stats, lastDayPending, phase: "generate", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async runGenerate(job: Job): Promise<"ok" | "retry"> {
    const stats = job.stats;
    if (stats === null) {
      throw new Error("文章を作る月の統計がありません");
    }
    let current = job;
    if (this.deps.llm !== undefined && current.llmText === null && !current.llmGaveUp) {
      // 試行は呼ぶ前に永続化する(落ちても無限に続かない)。
      current = { ...current, llmAttempts: current.llmAttempts + 1 };
      this.putJob(current);
      const outcome = await this.callLlm(buildMonthlyPrompt({ month: job.month, stats, lastDayPending: job.lastDayPending }));
      if (outcome.ok) {
        // 応答は成功した直後に書く(保存の失敗の再試行で LLM を呼び直さない)。
        current = { ...current, llmText: outcome.text, llmModel: outcome.model, calls: [...current.calls, ...outcome.calls] };
        this.putJob(current);
      } else {
        const giveUp = current.llmAttempts >= MONTHLY_MAX_LLM_ATTEMPTS;
        this.deps.onWarn(`月報(${job.month}): LLM の呼び出しに失敗しました(${outcome.description}。試行 ${current.llmAttempts} 回${giveUp ? "。統計だけの月報にします" : ""})`);
        current = { ...current, llmGaveUp: giveUp, calls: [...current.calls, ...outcome.calls], nextAt: giveUp ? this.deps.now() : this.deps.now() + MONTHLY_RETRY_DELAY_MS };
        this.putJob(current);
        if (!giveUp) {
          return "retry";
        }
      }
    }
    const record = this.buildRecord(current, stats);
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
      this.deps.onWarn("月報: 設定を読めなかったため、既定のモデルの選択で続けます");
    }
    const sender = createMeteredSender(withErrorLog(llm.sender, this.deps.onWarn), log, this.deps.now);
    const selector = this.selectors?.(settings.analysisModel);
    const client = new AnthropicLlmClient({ maxTokens: MONTHLY_MAX_TOKENS }, { sender, ...(selector === undefined ? {} : { modelSelector: selector }), onWarn: this.deps.onWarn });
    try {
      const done = await client.completeDetailed(prompt);
      return { ok: true, text: done.text, model: done.model ?? null, calls: log.calls() as LlmCallRecord[] };
    } catch (error) {
      const calls = log.calls() as LlmCallRecord[];
      return { ok: false, description: calls[calls.length - 1]?.error ?? "種別=other", calls };
    }
  }

  private buildRecord(job: Job, stats: MonthStats): MonthlyReportRecord {
    let narrative: MonthlyNarrative | null = null;
    let narrativeRaw: string | null = null;
    let note: string | null = null;
    let summary: string | null = null;
    if (this.deps.llm === undefined) {
      note = MONTHLY_NOTE_NO_KEY;
    } else if (job.llmText === null) {
      note = MONTHLY_NOTE_FAILED;
    } else {
      narrative = parseMonthlyNarrative(job.llmText);
      if (narrative === null) {
        narrativeRaw = cut(job.llmText.trim(), RAW_MAX_CHARS);
        summary = cut(job.llmText.trim(), RAW_SUMMARY_CHARS);
        note = MONTHLY_NOTE_UNPARSED;
      } else {
        summary = narrative.summary;
      }
    }
    return {
      month: job.month,
      createdAt: new Date(this.deps.now()).toISOString(),
      model: narrative !== null || narrativeRaw !== null ? job.llmModel : null,
      raceCount: stats.raceCount,
      totalStake: stats.totalStake,
      totalReturn: stats.totalReturn,
      summary,
      body: { format: 1, month: job.month, stats, lastDayPending: job.lastDayPending, narrative, narrativeRaw, note, promptVersion: MONTHLY_PROMPT_VERSION },
      llmCallsJson: serializeLlmCalls(job.calls.length === 0 ? null : job.calls),
    };
  }

  private async runSave(job: Job): Promise<"ok" | "exists" | "failed"> {
    if (job.record === null) {
      throw new Error("保存する月報がありません");
    }
    if (job.mode === "regenerate") {
      // 作り直し: 1 文の UPSERT で置き換える。**通知に進まない**(`phase: "notify"` を書かずに終える。Discord に送らない)。
      const replaced = await this.deps.store.replaceReport(job.record);
      if (replaced === "kept") {
        this.deps.onWarn(`月報(${job.month}): 作り直しで LLM の文章を作れなかったため、文章のある前の月報を残しました`);
        this.abandon(job);
        return "failed";
      }
      this.finish(job.month);
      return "ok";
    }
    const saved = await this.deps.store.saveReport(job.record);
    if (saved === "exists") {
      // 別の経路が先に作った。上書きも通知もしない。
      this.finish(job.month);
      return "exists";
    }
    if (job.mode === "manual") {
      // 手動の作成は Discord に送らない(自動の作成の通知とは別。ユーザーの決定)。
      this.finish(job.month);
      return "ok";
    }
    this.putJob({ ...job, phase: "notify", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async runNotify(job: Job): Promise<"ok" | "failed"> {
    const record = job.record;
    if (this.deps.notifier === undefined || record === null || job.notify === "sending") {
      // 通知の仕組みが無い、または送信中に落ちた(再送しない)。
      this.finish(job.month);
      return "ok";
    }
    const body = record.body;
    const link = this.deps.appBaseUrl === undefined ? undefined : buildMonthlyLink(this.deps.appBaseUrl, job.month);
    const embed = buildMonthlyEmbed({ month: job.month, stats: body.stats, narrative: body.narrative, note: body.note, link, lastDayPending: body.lastDayPending });
    // 送る前に sending を書く(ここまで同期。落ちても再送しない)。
    this.putJob({ ...job, notify: "sending" });
    let ok = true;
    try {
      await this.deps.notifier.send({ embeds: [embed] });
    } catch (error) {
      ok = false;
      this.deps.onWarn(`Discord への月報の通知に失敗しました(${job.month}。分類: ${classifyNotifyError(error)}。再送しません)`);
    }
    this.finish(job.month);
    return ok ? "ok" : "failed";
  }

  // ---- ジョブの保存 ----

  /**
   * 月報を作れずに終わる(その月の分析が見つからない)。通常の作成はジョブを消すだけ。
   * 作り直しは前の月報が残っているので、消すと画面が結果を知れない: `failed` のジョブとして残す({@link abandon})。
   */
  private endWithoutReport(job: Job): void {
    if (job.mode === "regenerate") {
      this.abandon(job);
    } else {
      this.finish(job.month);
    }
  }

  /** 作り直しを、前の月報を残したまま失敗として終える。本文(統計・記録・LLM の記録)は捨てて、kv を肥大させない。動かすジョブの一覧から外す(アラームを張らない)。 */
  private abandon(job: Job): void {
    this.putJob({ ...job, status: "failed", stats: null, record: null, calls: [], llmText: null });
    this.removeFromIndex(job.month);
  }

  private putJob(job: Job): void {
    this.deps.kv.put(jobKey(job.month), job);
  }

  private finish(month: string): void {
    this.deps.kv.delete(jobKey(month));
    this.removeFromIndex(month);
  }

  private index(): string[] {
    return this.deps.kv.get<string[]>(JOBS_KEY) ?? [];
  }

  private addToIndex(month: string): void {
    const index = this.index();
    if (!index.includes(month)) {
      this.deps.kv.put(JOBS_KEY, [...index, month]);
    }
  }

  private removeFromIndex(month: string): void {
    const rest = this.index().filter((m) => m !== month);
    if (rest.length === 0) {
      this.deps.kv.delete(JOBS_KEY);
    } else {
      this.deps.kv.put(JOBS_KEY, rest);
    }
  }

  private runningJobs(): Job[] {
    const jobs: Job[] = [];
    for (const month of this.index()) {
      const job = this.deps.kv.get<Job>(jobKey(month));
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
