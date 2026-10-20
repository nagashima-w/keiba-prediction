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
 *  - `regenerate`: 同じ `POST /api/reports/run` に `regenerate: true` を付けた、管理者の作り直し(Issue #268)。**日報がある日だけ**を、いまの分析と結果で作り直して上書きする(下の「作り直し」)。
 * 通常の作成は 1 日 1 回で確定し、作成後に取り込まれた結果や追加の分析は反映しない(上書きしない)。作り直しだけがそれを上書きする。
 *
 * ## 段階(1 回のアラームで 1 段階だけ進める)
 * `list`(その日の分析を、レースごとに最新の 1 件に絞って列挙)→ `gather`({@link REPORT_READ_CHUNK} レースずつ読んでダイジェスト化)→ `generate`(直前 27 日の再集計を 1 回読み〈Issue #264。D1 の batch 1 回=サブリクエスト 1〉、その日の統計に足して「直近 28 日の累計」にしてから、LLM を 1 回)→
 * `save`(D1 に保存)→ `notify`(Discord に 1 回)。段階を分ける理由: Workers Free の「1 呼び出し 50 サブリクエスト」。1 レースの読み出しは約 4(分析の詳細の D1 の batch・
 * R2 の get・読み出しの回数の記録・配分の batch)なので、{@link REPORT_READ_CHUNK}(8)レースで約 33 に収める(結果の読み出し 1 を含む)。
 *
 * ## 冪等性・失敗
 *  - 状態はジョブ(kv の `job:<開催日>`)に置く。LLM の応答は**成功した直後に**ジョブへ書き、保存の失敗の再試行で LLM を呼び直さない。
 *  - 段階の失敗は {@link REPORT_RETRY_DELAY_MS} 後に再試行、{@link REPORT_MAX_STEP_ATTEMPTS} 回で `failed`(アラームを張らない。手動の再依頼で最初からやり直せる)。
 *  - LLM は {@link REPORT_MAX_LLM_ATTEMPTS} 回まで。使えなければ統計だけの日報を保存する(固定の理由つき)。API のエラーの本文・鍵は状態にもログにも残さない。
 *  - 通知は**多くとも 1 回**(送る前に `sending` を書く。落ちたら再送せずに終える)。通知の失敗は日報を巻き戻さない。
 *
 * ## 作り直し(Issue #268。ユーザーの決定: 自動の作り直しはしない。管理者が押したときだけ)
 *  - 同じ段階(list → gather → generate → save)を通り、`rolling`(4 週の累計)・`stats.whatIf`・`nearMisses` を**作り直す時点の D1 から再計算**する(前の日報から何も引き継がない)。
 *  - **保存(save)だけが D1 を書く**。それまでの失敗では前の日報は変わらない。save は {@link ReportStore.replaceReport}(1 文の UPSERT)で、上書きの途中の状態が無い。
 *  - **Discord には送らない**。通知に入る経路は `runSave` が `phase: "notify"` を書く 1 本だけで、作り直しはそこを通らず `finish` する(`runNotify` の送信が、日報の通知の唯一の送信箇所)。
 *  - 1 日(JST)に受理できる回数は全体で {@link REPORT_REGEN_DAILY_LIMIT} 回(LLM の費用を守る)。受理したときだけ数え、失敗した作り直しも返さない。
 *  - 置き換えを断られた(`kept`。LLM の文章がある前の日報を、文章の無い新しい記録で潰さない規則)・分析が見つからない作り直しは、`failed` のジョブとして残す(画面が「前の日報のまま」と出せる)。
 */
import { isRealYmd } from "../client/date";
import { jstKaisaiDate } from "./auto-run-plan";
import { buildDayStats, buildRaceDigest, type DayStats, type DigestTopHorse, type RaceDigest } from "./daily-report-digest";
import { buildReportEmbed } from "./daily-report-embed";
import { buildReportPrompt, parseNarrative, raceTitle, REPORT_MAX_TOKENS, REPORT_PROMPT_VERSION, type Narrative } from "./daily-report-prompt";
import { pickNearMisses, type NearMissSummary } from "./daily-report-whatif";
import { buildRollingSummary, rollingPriorWindow, type PeriodStats, type RollingSummary } from "./period-stats";
import { addDaysToKaisaiDate } from "./result-dispatch";
import { serializeLlmCalls, type LlmCallRecord } from "./llm-calls";
import { createCloudModelSelectors, type ModelSelectorFor } from "./llm-run";
import type { CloudLlm } from "./llm-sender";
import { buildReportLink } from "./notify-link";
import { classifyNotifyError, type DiscordNotifier } from "./notify-send";
import { attemptLlm, ReportJobStore, resolveNarrative, takeRegenQuota, type ReportLlmDeps } from "./report-job-support";
import type { CloudSettings } from "./settings";
import type { AnalysisView } from "./analysis-view";
import type { RaceResultData } from "./daily-report-bets";

/** 日報の DO の固定名(単一インスタンス)。依頼する側(handler.ts・scheduled.ts・race-day-do.ts)が同じ名前を使う。 */
export const DAILY_REPORT_NAME = "main";

/**
 * auto・catchup の依頼を受ける開催日の古さの上限(日)。JST の今日から、この日数前まで(含む)。それより古い日は `too-old` で断る(LLM・D1 に出ない)。
 * 理由: 日単位の DO は、過去日でも(結果の補完・掃除のアラームで)静かな状態で起こされると日報を依頼するので、上限が無いと古い日の日報が次々に作られ、LLM の費用が増える。
 * manual・regenerate(利用者が日付を指定して押す)は上限なし。
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
/**
 * 作り直し(mode: regenerate。Issue #268)を受理できる回数の、JST の 1 日あたりの上限(**開催日ごとではなく全体**)。1 回の作り直しは LLM を最大 {@link REPORT_MAX_LLM_ATTEMPTS} 回呼ぶので、
 * 誤操作の連打で課金しないための柵。同じ日の連打は `in-progress` が既に防ぐ。受理したときだけ数える(断った依頼は数えない)。
 */
export const REPORT_REGEN_DAILY_LIMIT = 3;
/** 文章が無いときの理由(固定文言)。 */
export const REPORT_NOTE_NO_KEY = "LLM の API キーが未登録のため、統計だけの日報です";
export const REPORT_NOTE_FAILED = "LLM を使えなかったため、統計だけの日報です";
export const REPORT_NOTE_UNPARSED = "LLM の応答を構造として読めなかったため、生の文章を載せています";

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
  /**
   * 期間 `[fromDate, toDate]`(開催日 YYYYMMDD。両端を含む)の統計を D1 から再集計する(Issue #264。レースごとに最新の分析・日報の 1 日の統計と同じ集計)。
   * 日報は、その日を除く直前 27 日をこれで読み、その日の統計に足して「直近 28 日の累計」にする。読めなければ例外(段階の再試行に任せる)。
   */
  readPeriodStats(fromDate: string, toDate: string): Promise<PeriodStats>;
}

export interface ReportStore {
  hasReport(kaisaiDate: string): Promise<boolean>;
  /** 日報を保存する。同じ日が既にあれば上書きせず `exists`。 */
  saveReport(record: ReportRecord): Promise<"saved" | "exists">;
  /**
   * 作り直し(Issue #268)の保存: 同じ日の日報を**1 文で**置き換える(途中の状態が無く、失敗すれば前の日報のまま)。
   * ただし、前の日報に LLM の文章があり、新しい記録に文章が無い(`model` が null)ときは置き換えず `kept`(良い日報を、LLM が使えなかった作り直しで潰さない)。
   * 前の日報が無ければ(消えていれば)通常の保存と同じに作る。
   */
  replaceReport(record: ReportRecord): Promise<"replaced" | "kept">;
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
  /** 判定できた買い目のうち返還(Issue #278。取消・除外の馬への買い目)の点数。`judgedBetCount`・`totalStake`・`totalReturn` に含まれる内訳で、`hitCount` には入らない。この項目を持つ前の日報には無い。 */
  readonly refundedBetCount: number;
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
  /**
   * 直前 27 日と直近 28 日の累計(Issue #264。LLM に渡した数字そのもの。画面と Discord が出す)。**この項目を持つ前の日報には無い**。
   */
  readonly rolling?: RollingSummary;
  /**
   * 惜しかったレース(Issue #272。組合せ券種の型が的中したのに、同じ組合せを買っていなかったレース。その日だけ)。LLM に渡した件と同じ。
   * **この項目を持つ前の日報、デプロイをまたいだ旧形のジョブで作った日報には無い**(`stats.whatIf` が null の日も無い)。
   */
  readonly nearMisses?: NearMissSummary;
  /** 日報を書いたプロンプトの版(`REPORT_PROMPT_VERSION`)。持つ前の日報には無い(= 「偶然」の定型の前提を渡していた版)。 */
  readonly promptVersion?: string;
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

export type ReportMode = "auto" | "catchup" | "manual" | "regenerate";

/**
 * 依頼の結果。`not-exists`(作り直しの依頼で、その日の日報が無い。作るのは通常の作成の仕事)・`daily-limit`(作り直しの 1 日の回数の上限。{@link REPORT_REGEN_DAILY_LIMIT})は、
 * 作り直し(Issue #268)だけが返す。
 */
export type RequestReportResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "invalid-date" | "future-date" | "too-old" | "in-progress" | "exists" | "not-exists" | "daily-limit" };

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
  /** 作り直し(Issue #268)のジョブにだけ付く(`true`)。通常の作成のジョブにはキーそのものが無い。画面は、日報がある日のジョブがこれを持つときだけ「作り直し」として扱う。 */
  readonly regenerate?: true;
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
  /** 直近 28 日の累計(Issue #264)。generate の段階で 1 回読んで永続化する(LLM の再試行で読み直さない)。無い・null は未読(旧版が積んだジョブも同じ)。 */
  rolling?: RollingSummary | null;
  calls: LlmCallRecord[];
  record: ReportRecord | null;
  notify: "pending" | "sending";
}


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

export class DailyReportCore {
  private readonly selectors: ModelSelectorFor | undefined;
  /** LLM の呼び出しに要る口(`report-job-support.ts` の {@link attemptLlm} に渡す)。 */
  private readonly llmDeps: ReportLlmDeps;
  /** ジョブの保管(kv の `job:<鍵>` と索引・期限の来たジョブの選択・段階の失敗の包み・終わり方・アラーム。`report-job-support.ts`)。 */
  private readonly jobs: ReportJobStore<Job>;

  constructor(private readonly deps: DailyReportDeps) {
    this.selectors = deps.llm === undefined ? undefined : createCloudModelSelectors(deps.llm, deps.onWarn);
    this.llmDeps = { llm: deps.llm, selectors: this.selectors, now: deps.now, onWarn: deps.onWarn, loadSettings: deps.loadSettings };
    this.jobs = new ReportJobStore<Job>(deps, (job) => job.kaisaiDate);
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
    if ((input.mode === "auto" || input.mode === "catchup") && kaisaiDate < addDaysToKaisaiDate(today, -REPORT_MAX_AGE_DAYS)) {
      return { accepted: false, reason: "too-old" };
    }
    const regenerate = input.mode === "regenerate";
    const existing = this.jobs.get(kaisaiDate);
    if (existing !== undefined && existing.status === "running") {
      return { accepted: false, reason: "in-progress" };
    }
    const hasReport = await this.deps.store.hasReport(kaisaiDate);
    if (regenerate ? !hasReport : hasReport) {
      // 通常の作成は日報がある日を断る(exists)。作り直しは逆に、日報が無い日を断る(not-exists。作成の入口の仕事)。
      return { accepted: false, reason: regenerate ? "not-exists" : "exists" };
    }
    // await を挟んだので、ここで同じ日のジョブが積まれていないかを見直す(並行した依頼の二重のジョブを作らない)。
    const again = this.jobs.get(kaisaiDate);
    if (again !== undefined && again.status === "running") {
      return { accepted: false, reason: "in-progress" };
    }
    const now = this.deps.now();
    // 1 日の回数(Issue #268)。**最後の await のあと、ジョブを積むのと同じ同期の区間**で確かめて数える(並行した依頼が上限を超えない)。ここまでの断りは数えない。
    if (regenerate && !takeRegenQuota(this.deps.kv, now, REPORT_REGEN_DAILY_LIMIT)) {
      return { accepted: false, reason: "daily-limit" };
    }
    const job: Job = {
      kaisaiDate, mode: input.mode, createdAt: now, phase: "list", status: "running", attempts: 0, nextAt: now,
      items: [], cursor: 0, digests: [], llmAttempts: 0, llmText: null, llmModel: null, llmGaveUp: false, calls: [], record: null, notify: "pending",
    };
    this.jobs.put(job);
    this.jobs.addToIndex(kaisaiDate);
    await this.jobs.rearm();
    return { accepted: true };
  }

  getStatus(kaisaiDate: string): ReportStatus | null {
    const job = this.jobs.get(kaisaiDate);
    return job === undefined ? null : { phase: job.phase, status: job.status, attempts: job.attempts, ...(job.mode === "regenerate" ? { regenerate: true as const } : {}) };
  }

  // ---- アラーム ----

  /** 時刻が来ているジョブを 1 つ選び、1 段階だけ進める。 */
  async runNextStep(): Promise<StepOutcome> {
    const due = this.jobs.pickDue();
    if (due === undefined) {
      await this.jobs.rearm();
      return { kind: "idle" };
    }
    const outcome = await this.runPhase(due);
    await this.jobs.rearm();
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
      // 段階の失敗: 試行を数えて再試行、上限で failed(手順は `report-job-support.ts` の failStep)。
      return ran(this.jobs.failStep(job, phase, error, { noun: "日報", maxAttempts: REPORT_MAX_STEP_ATTEMPTS, retryDelayMs: REPORT_RETRY_DELAY_MS }));
    }
  }

  private async runList(job: Job): Promise<"ok" | "no-analyses"> {
    const items = [...(await this.deps.source.listDayAnalyses(job.kaisaiDate))];
    if (items.length === 0) {
      this.endWithoutReport(job);
      return "no-analyses";
    }
    this.jobs.put({ ...job, items, cursor: 0, phase: "gather", attempts: 0, nextAt: this.deps.now() });
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
      this.jobs.put({ ...job, digests, cursor, attempts: 0, nextAt: this.deps.now() });
      return "ok";
    }
    if (digests.length === 0) {
      this.endWithoutReport(job);
      return "no-analyses";
    }
    this.jobs.put({ ...job, digests, cursor, phase: "generate", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async runGenerate(job: Job): Promise<"ok" | "retry"> {
    const digests = [...job.digests].sort((a, b) => (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0));
    const stats = buildDayStats(digests);
    let current = job;
    if (current.rolling === undefined || current.rolling === null) {
      // 直近 28 日の累計(Issue #264): その日を除く直前 27 日を再集計して、その日の統計に足す。LLM の前に読み、永続化する(LLM の再試行で読み直さない)。
      // 読めなければ投げる(段階の再試行 → 上限で failed)。4 週の累計なしの日報を静かに確定させない(日報は 1 日 1 回で上書きできない)。
      const window = rollingPriorWindow(job.kaisaiDate);
      const prior = await this.deps.source.readPeriodStats(window.fromDate, window.toDate);
      current = { ...current, rolling: buildRollingSummary(job.kaisaiDate, stats, prior) };
      this.jobs.put(current);
    }
    // LLM の試行(呼ぶ前に試行を永続化し、応答は成功の直後に永続化する。手順は `report-job-support.ts` の attemptLlm)。
    const attempt = await attemptLlm(
      this.llmDeps,
      { noun: "日報", key: job.kaisaiDate, maxTokens: REPORT_MAX_TOKENS, maxAttempts: REPORT_MAX_LLM_ATTEMPTS, retryDelayMs: REPORT_RETRY_DELAY_MS },
      current,
      () => buildReportPrompt({ kaisaiDate: job.kaisaiDate, digests, stats, rolling: current.rolling!, nearMisses: stats.whatIf === null ? null : pickNearMisses(digests) }),
      (next) => this.jobs.put(next),
    );
    if (attempt.retry) {
      return "retry";
    }
    current = attempt.job;
    const record = this.buildRecord(current, digests, stats);
    this.jobs.put({ ...current, record, phase: "save", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private buildRecord(job: Job, digests: readonly RaceDigest[], stats: DayStats): ReportRecord {
    const knownIds = new Set(digests.map((d) => d.raceId));
    const { narrative, narrativeRaw, note, summary } = resolveNarrative<Narrative>({
      hasLlm: this.deps.llm !== undefined,
      llmText: job.llmText,
      parse: (llmText) => parseNarrative(llmText, knownIds),
      notes: { noKey: REPORT_NOTE_NO_KEY, failed: REPORT_NOTE_FAILED, unparsed: REPORT_NOTE_UNPARSED },
    });
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
      // 買い目の状態から数える(この項目を持つ前に積まれた、デプロイをまたいだジョブのダイジェストにも対応する)。
      refundedBetCount: d.bets.filter((b) => b.status === "refund").length,
      unjudgedBetCount: d.unjudgedBetCount,
      allocationNote: d.allocationNote,
      comment: comments.get(d.raceId) ?? null,
    }));
    // 惜しかったレース(Issue #272)。その日の定型の成績を作れなかった(旧形のダイジェスト)日は出さない。
    const nearMisses = stats.whatIf === null ? null : pickNearMisses(digests);
    return {
      kaisaiDate: job.kaisaiDate,
      createdAt: new Date(this.deps.now()).toISOString(),
      model: narrative !== null || narrativeRaw !== null ? job.llmModel : null,
      raceCount: digests.length,
      totalStake: stats.totalStake,
      totalReturn: stats.totalReturn,
      summary,
      body: { format: 1, kaisaiDate: job.kaisaiDate, stats, races, narrative, narrativeRaw, note, ...(job.rolling === undefined || job.rolling === null ? {} : { rolling: job.rolling }), ...(nearMisses === null ? {} : { nearMisses }), promptVersion: REPORT_PROMPT_VERSION },
      llmCallsJson: serializeLlmCalls(job.calls.length === 0 ? null : job.calls),
    };
  }

  private async runSave(job: Job): Promise<"ok" | "exists" | "failed"> {
    if (job.record === null) {
      throw new Error("保存する日報がありません");
    }
    if (job.mode === "regenerate") {
      // 作り直し(Issue #268): 1 文の UPSERT で置き換える。**通知に進まない**(`phase: "notify"` を書かずに終える。Discord に再送しない)。
      const replaced = await this.deps.store.replaceReport(job.record);
      if (replaced === "kept") {
        this.deps.onWarn(`日報(${job.kaisaiDate}): 作り直しで LLM の文章を作れなかったため、文章のある前の日報を残しました`);
        this.abandon(job);
        return "failed";
      }
      this.jobs.finish(job.kaisaiDate);
      return "ok";
    }
    const saved = await this.deps.store.saveReport(job.record);
    if (saved === "exists") {
      // 別の経路が先に作った。上書きも通知もしない。
      this.jobs.finish(job.kaisaiDate);
      return "exists";
    }
    this.jobs.put({ ...job, phase: "notify", attempts: 0, nextAt: this.deps.now() });
    return "ok";
  }

  private async runNotify(job: Job): Promise<"ok" | "failed"> {
    const record = job.record;
    if (this.deps.notifier === undefined || record === null || job.notify === "sending") {
      // 通知の仕組みが無い、または送信中に落ちた(再送しない)。
      this.jobs.finish(job.kaisaiDate);
      return "ok";
    }
    const body = record.body;
    const narrative = body.narrative ?? (record.summary === null ? null : { summary: record.summary, good: [], improve: [], races: [] });
    const link = this.deps.appBaseUrl === undefined ? undefined : buildReportLink(this.deps.appBaseUrl, job.kaisaiDate);
    const embed = buildReportEmbed({ kaisaiDate: job.kaisaiDate, stats: body.stats, narrative, note: body.note, link, rolling: body.rolling, nearMisses: body.nearMisses, races: body.races });
    // 送る前に sending を書く(ここまで同期。落ちても再送しない)。
    this.jobs.put({ ...job, notify: "sending" });
    let ok = true;
    try {
      await this.deps.notifier.send({ embeds: [embed] });
    } catch (error) {
      ok = false;
      this.deps.onWarn(`Discord への日報の通知に失敗しました(${job.kaisaiDate}。分類: ${classifyNotifyError(error)}。再送しません)`);
    }
    this.jobs.finish(job.kaisaiDate);
    return ok ? "ok" : "failed";
  }

  // ---- ジョブの保存 ----

  /**
   * 日報を作れずに終わる(その日の分析が見つからない)。通常の作成はジョブを消すだけ。作り直しは前の日報が残っているので、消すと画面が結果を知れない: `failed` のジョブとして残す({@link abandon})。
   */
  private endWithoutReport(job: Job): void {
    this.jobs.endWithoutReport(job, this.abandonedFields());
  }

  /** 作り直しを、前の日報を残したまま失敗として終える。本文は捨てて、kv を肥大させない。動かすジョブの一覧から外す(アラームを張らない)。 */
  private abandon(job: Job): void {
    this.jobs.abandon(job, this.abandonedFields());
  }

  /** 作り直しを諦めるときに捨てるジョブの本文(ダイジェスト・記録・LLM の記録。`llmText` は残す)。 */
  private abandonedFields(): Partial<Job> {
    return { items: [], digests: [], record: null, calls: [] };
  }
}
