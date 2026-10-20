/**
 * 日報(`DailyReportCore`)と月報(`MonthlyReportCore`)の**ジョブ機構が共有する部品**(Issue #399〈#390 R-8〉)。**葉のモジュール**: `daily-report-core.ts`・`monthly-report-core.ts` を import しない
 * (core が本モジュールを import するので、逆向きに import すると実行時に循環する)。`cloudflare:workers`・SQL・Discord の送信口・グローバルの `fetch` を持たない。
 * 中身は両 core に**同じ文面で重複していたもの**をそのまま移した。挙動は変えていない(`test/report-job-characterization.test.ts` が、移す前の実出力で固定している)。
 *
 * ## ここに置いたもの
 *  - 文字列の小物: {@link cut}(サロゲートペアを割らない切り詰め)・{@link errorText}(警告に出すエラー。鍵を伏せて先頭 200 字)・{@link RAW_MAX_CHARS}・{@link RAW_SUMMARY_CHARS}。
 *  - ジョブの保管: {@link ReportJobStore}(kv のジョブ `job:<鍵>` と動かすジョブの索引 `jobs`・期限の来たジョブの選択・段階の失敗の包み〈再試行と failed〉・終わり方〈finish・abandon〉・アラーム)。
 *  - 作り直しの 1 日の回数の枠: {@link takeRegenQuota}(kv のキー `regen`。日報と月報は別の DO の kv なので別枠)。
 *  - LLM: {@link callReportLlm}(設定の読み → 送信 → 応答)・{@link attemptLlm}(試行を**呼ぶ前に**永続化し、応答を成功の直後に書く。上限で諦める)。
 *  - 文章の解決: {@link resolveNarrative}(キー無し・失敗・読めない応答・成功の 4 通りから、`narrative`・`narrativeRaw`・`note`・`summary` を決める)。
 *
 * ## 各 core に残したもの(共通化しなかった理由)
 *  - 依頼の検証(日付・月の検証が別物)・段階の中身(日報の list/gather と rolling、月報の待ち)・`buildRecord` の組み立て。
 *  - `runSave`・`runNotify`: 静的ガード(`scripts/test/cloud-config-guard.test.ts`)が、各 core のソースの中の `notifier.send(`・`phase: "notify"` の位置を見て
 *    「通知に入る経路は 1 本だけ。作り直し・手動の作成はそこを通らない」を固定している。ここに動かすとその検査の前提が変わるので、動かさない。
 */
import { AnthropicLlmClient } from "@keiba/core/llm";
import { jstKaisaiDate } from "./auto-run-plan";
import type { LlmCallRecord } from "./llm-calls";
import { createCallLog, createMeteredSender, redactSecrets, withErrorLog, type ModelSelectorFor } from "./llm-run";
import type { CloudLlm } from "./llm-sender";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "./settings";

/** 生の文章を残す上限と、総括に使う先頭の長さ。 */
export const RAW_MAX_CHARS = 20_000;
export const RAW_SUMMARY_CHARS = 300;

/** 文字列を `max` 文字に切る(切ったら末尾に `…`)。末尾がサロゲートペアの前半なら落として割らない。 */
export function cut(text: string, max: number): string {
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
export function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200);
}

// ---- 作り直しの回数の枠 ----

/** 作り直しの回数の記録(kv のキー `regen`)。日付が変わっていれば数え直すので、古い記録の掃除は要らない。 */
const REGEN_KEY = "regen";
interface RegenQuota {
  /** 受理した日(JST の YYYYMMDD。開催日ではなく、依頼した日)。 */
  day: string;
  count: number;
}

/** {@link takeRegenQuota} が使う kv の部分(同期)。 */
export interface RegenQuotaKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

/** DO のストレージ(`ctx.storage.kv`)のうち、ジョブの保管に使う部分(同期)。 */
export interface JobKv extends RegenQuotaKv {
  delete(key: string): void;
}

/**
 * 作り直しの 1 日(JST)の回数の枠を 1 つ取る。上限に達していれば `false`(数えない)。取れたら記録を 1 増やして `true`。
 * **同期関数**: 呼び出し側は、最後の `await` のあと、ジョブを積むのと同じ同期の区間で呼ぶ(並行した依頼が上限を超えない)。
 */
export function takeRegenQuota(kv: RegenQuotaKv, now: number, limit: number): boolean {
  const day = jstKaisaiDate(now);
  const quota = kv.get<RegenQuota>(REGEN_KEY);
  const used = quota !== undefined && quota.day === day ? quota.count : 0;
  if (used >= limit) {
    return false;
  }
  kv.put(REGEN_KEY, { day, count: used + 1 } satisfies RegenQuota);
  return true;
}

// ---- LLM ----

/** LLM の呼び出しに要る外への口(core の deps から渡す)。`llm` が無ければ呼ばない(統計だけの記録)。 */
export interface ReportLlmDeps {
  readonly llm: CloudLlm | undefined;
  readonly selectors: ModelSelectorFor | undefined;
  readonly now: () => number;
  readonly onWarn: (message: string) => void;
  readonly loadSettings: () => Promise<CloudSettings>;
}

/** LLM に 1 回送った結果。失敗の `description` は固定の語だけ(`status=529`・`種別=other` ほか。API のエラー本文・鍵は含まない)。 */
export type ReportLlmResult =
  | { readonly ok: true; readonly text: string; readonly model: string | null; readonly calls: LlmCallRecord[] }
  | { readonly ok: false; readonly description: string; readonly calls: LlmCallRecord[] };

/**
 * LLM を 1 回呼ぶ。設定(D1)を読めなければ既定のモデルの選択で続ける(警告 `<noun>: 設定を読めなかったため、既定のモデルの選択で続けます`)。
 * 投げずに、成功・失敗を {@link ReportLlmResult} で返す(呼び出しの記録つき)。
 */
export async function callReportLlm(deps: ReportLlmDeps, options: { readonly noun: string; readonly maxTokens: number }, prompt: string): Promise<ReportLlmResult> {
  const llm = deps.llm!;
  const log = createCallLog();
  let settings: CloudSettings = DEFAULT_CLOUD_SETTINGS;
  try {
    settings = await deps.loadSettings();
  } catch {
    deps.onWarn(`${options.noun}: 設定を読めなかったため、既定のモデルの選択で続けます`);
  }
  const sender = createMeteredSender(withErrorLog(llm.sender, deps.onWarn), log, deps.now);
  const selector = deps.selectors?.(settings.analysisModel);
  const client = new AnthropicLlmClient({ maxTokens: options.maxTokens }, { sender, ...(selector === undefined ? {} : { modelSelector: selector }), onWarn: deps.onWarn });
  try {
    const done = await client.completeDetailed(prompt);
    return { ok: true, text: done.text, model: done.model ?? null, calls: log.calls() as LlmCallRecord[] };
  } catch (error) {
    const calls = log.calls() as LlmCallRecord[];
    return { ok: false, description: calls[calls.length - 1]?.error ?? "種別=other", calls };
  }
}

/** {@link attemptLlm} が読み書きするジョブの項目(日報・月報のジョブの共通部分。**永続化される形そのもの**で、項目名・型を変えない)。 */
export interface LlmJobFields {
  nextAt: number;
  llmAttempts: number;
  llmText: string | null;
  llmModel: string | null;
  llmGaveUp: boolean;
  calls: LlmCallRecord[];
}

export interface AttemptLlmOptions {
  /** 警告の頭の語(`日報`・`月報`)。 */
  readonly noun: string;
  /** ジョブの鍵(開催日・月)。警告の `日報(<鍵>)` に入る。 */
  readonly key: string;
  readonly maxTokens: number;
  /** LLM の呼び出しの上限(これに達したら諦めて統計だけの記録にする)。 */
  readonly maxAttempts: number;
  /** 失敗後の再試行までの待ち(ミリ秒)。 */
  readonly retryDelayMs: number;
}

/**
 * LLM の 1 回の試行(`generate` 段階の中心)。呼べる状態(`llm` がある・応答がまだ無い・諦めていない)でなければ何もせず `retry: false` で返す。
 *  1. 試行の数を 1 増やして**呼ぶ前に永続化する**(`put`)。落ちても無限に続かない。プロンプトは永続化の**後**に作る(`buildPrompt` を、この関数の中で呼ぶ)。
 *  2. 成功: 応答(`llmText`・`llmModel`・呼び出しの記録)を**成功した直後に永続化する**(保存の失敗の再試行で LLM を呼び直さない)。
 *  3. 失敗: 試行が上限に達していれば諦める(`llmGaveUp`。次の時刻は今)。達していなければ `retryDelayMs` 後に再試行する(`retry: true`)。警告は固定の語だけ。
 * 戻り値のジョブは永続化済み。
 */
export async function attemptLlm<J extends LlmJobFields>(
  deps: ReportLlmDeps,
  options: AttemptLlmOptions,
  job: J,
  buildPrompt: () => string,
  put: (job: J) => void,
): Promise<{ readonly job: J; readonly retry: boolean }> {
  if (deps.llm === undefined || job.llmText !== null || job.llmGaveUp) {
    return { job, retry: false };
  }
  // 試行は呼ぶ前に永続化する(落ちても無限に続かない)。
  let current: J = { ...job, llmAttempts: job.llmAttempts + 1 };
  put(current);
  const outcome = await callReportLlm(deps, options, buildPrompt());
  if (outcome.ok) {
    // 応答は成功した直後に書く(保存の失敗の再試行で LLM を呼び直さない)。
    current = { ...current, llmText: outcome.text, llmModel: outcome.model, calls: [...current.calls, ...outcome.calls] };
    put(current);
    return { job: current, retry: false };
  }
  const giveUp = current.llmAttempts >= options.maxAttempts;
  deps.onWarn(`${options.noun}(${options.key}): LLM の呼び出しに失敗しました(${outcome.description}。試行 ${current.llmAttempts} 回${giveUp ? `。統計だけの${options.noun}にします` : ""})`);
  current = { ...current, llmGaveUp: giveUp, calls: [...current.calls, ...outcome.calls], nextAt: giveUp ? deps.now() : deps.now() + options.retryDelayMs };
  put(current);
  return { job: current, retry: !giveUp };
}

// ---- 文章の解決 ----

/** {@link resolveNarrative} の結果。ジョブの記録(本文)にそのまま入れる 4 項目。 */
export interface ResolvedNarrative<N> {
  readonly narrative: N | null;
  /** 応答が構造として読めなかったときの生の文章。 */
  readonly narrativeRaw: string | null;
  /** 文章が無い・生の文章のときの理由(固定文言)。 */
  readonly note: string | null;
  readonly summary: string | null;
}

/**
 * LLM の応答から、本文に載せる文章を決める。
 *  - キーが無い(`hasLlm` が false): 文章なし。理由は `notes.noKey`。
 *  - 応答が無い(LLM を使えなかった): 文章なし。理由は `notes.failed`。
 *  - 応答が構造として読めない(`parse` が null): 生の文章(先頭 {@link RAW_MAX_CHARS} 字)を残し、総括には先頭 {@link RAW_SUMMARY_CHARS} 字を使う。理由は `notes.unparsed`。
 *  - 読めた: その構造と総括。理由なし。
 */
export function resolveNarrative<N extends { readonly summary: string }>(input: {
  readonly hasLlm: boolean;
  readonly llmText: string | null;
  readonly parse: (text: string) => N | null;
  readonly notes: { readonly noKey: string; readonly failed: string; readonly unparsed: string };
}): ResolvedNarrative<N> {
  if (!input.hasLlm) {
    return { narrative: null, narrativeRaw: null, note: input.notes.noKey, summary: null };
  }
  if (input.llmText === null) {
    return { narrative: null, narrativeRaw: null, note: input.notes.failed, summary: null };
  }
  const narrative = input.parse(input.llmText);
  if (narrative === null) {
    return { narrative: null, narrativeRaw: cut(input.llmText.trim(), RAW_MAX_CHARS), note: input.notes.unparsed, summary: cut(input.llmText.trim(), RAW_SUMMARY_CHARS) };
  }
  return { narrative, narrativeRaw: null, note: null, summary: narrative.summary };
}

// ---- ジョブの保管 ----

/** 動かすジョブの索引(鍵の配列)の kv のキーと、ジョブ本体のキー(`job:<鍵>`)。**永続化されている形**で、変えない。 */
const JOBS_KEY = "jobs";
const jobKey = (key: string): string => `job:${key}`;

/** {@link ReportJobStore} が読み書きするジョブの項目(日報・月報のジョブの共通部分。永続化される形そのもの)。 */
export interface StoredJobFields {
  readonly mode: string;
  readonly status: "running" | "failed";
  readonly attempts: number;
  readonly nextAt: number;
}

export interface JobStoreDeps {
  readonly kv: JobKv;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly onWarn: (message: string) => void;
}

/** 段階の失敗の包み({@link ReportJobStore.failStep})の設定。 */
export interface StepFailureOptions {
  /** 警告の頭の語(`日報`・`月報`)。 */
  readonly noun: string;
  /** 連続の失敗の上限。達したらジョブは failed。 */
  readonly maxAttempts: number;
  /** 失敗後の再試行までの待ち(ミリ秒)。 */
  readonly retryDelayMs: number;
}

/**
 * ジョブの保管。kv の `job:<鍵>`(ジョブ本体)と `jobs`(動かすジョブの鍵の索引)を持ち、期限の来たジョブの選択・段階の失敗の扱い・終わり方・アラームを引き受ける。
 * 鍵(開催日・月)は `keyOf` で取る(ジョブの中の項目名は日報が `kaisaiDate`、月報が `month` で、**永続化されている形なので変えない**)。
 * 段階の中身・状態の遷移は各 core にある(ここは遷移を知らない)。
 */
export class ReportJobStore<J extends StoredJobFields> {
  constructor(
    private readonly deps: JobStoreDeps,
    private readonly keyOf: (job: J) => string,
  ) {}

  get(key: string): J | undefined {
    return this.deps.kv.get<J>(jobKey(key));
  }

  put(job: J): void {
    this.deps.kv.put(jobKey(this.keyOf(job)), job);
  }

  /** ジョブを消し、動かすジョブの索引から外す。 */
  finish(key: string): void {
    this.deps.kv.delete(jobKey(key));
    this.removeFromIndex(key);
  }

  /**
   * 作り直しを、前の記録を残したまま失敗として終える。`cleared` は捨てる本文(ダイジェスト・記録・LLM の記録など。**何を捨てるかは日報と月報で違う**ので、呼び出し側が渡す)。
   * kv を肥大させないために本文を捨て、動かすジョブの一覧から外す(アラームを張らない)。
   */
  abandon(job: J, cleared: Partial<J>): void {
    this.put({ ...job, status: "failed", ...cleared });
    this.removeFromIndex(this.keyOf(job));
  }

  /**
   * 記録を作れずに終わる(その日・月の分析が見つからない)。通常の作成はジョブを消すだけ。作り直しは前の記録が残っていて、消すと画面が結果を知れないので、
   * `failed` のジョブとして残す({@link abandon})。
   */
  endWithoutReport(job: J, cleared: Partial<J>): void {
    if (job.mode === "regenerate") {
      this.abandon(job, cleared);
    } else {
      this.finish(this.keyOf(job));
    }
  }

  addToIndex(key: string): void {
    const index = this.index();
    if (!index.includes(key)) {
      this.deps.kv.put(JOBS_KEY, [...index, key]);
    }
  }

  removeFromIndex(key: string): void {
    const rest = this.index().filter((k) => k !== key);
    if (rest.length === 0) {
      this.deps.kv.delete(JOBS_KEY);
    } else {
      this.deps.kv.put(JOBS_KEY, rest);
    }
  }

  /** 時刻が来ている(`nextAt` が今以前の)動かせるジョブのうち、最も早いもの(同じ時刻なら鍵の昇順)。無ければ undefined。 */
  pickDue(): J | undefined {
    const now = this.deps.now();
    return this.running()
      .filter((j) => j.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt || (this.keyOf(a) < this.keyOf(b) ? -1 : 1))[0];
  }

  /**
   * 段階の失敗: 試行を数えて再試行、上限で failed(索引から外す)。エラーの本文はログにだけ(鍵を伏せて先頭 200 字)。状態には残さない。
   * 警告 → ジョブの書き込み → (failed なら)索引から外す、の順。
   */
  failStep(job: J, phase: string, error: unknown, options: StepFailureOptions): "retry" | "failed" {
    const key = this.keyOf(job);
    const attempts = job.attempts + 1;
    this.deps.onWarn(`${options.noun}(${key}): ${phase} に失敗しました(試行 ${attempts} 回): ${errorText(error)}`);
    if (attempts >= options.maxAttempts) {
      this.put({ ...job, attempts, status: "failed" });
      this.removeFromIndex(key);
      return "failed";
    }
    this.put({ ...job, attempts, nextAt: this.deps.now() + options.retryDelayMs });
    return "retry";
  }

  /** 動かせるジョブの最も早い時刻にアラームを張る(無ければ張らない。今より前にはしない)。 */
  async rearm(): Promise<void> {
    const jobs = this.running();
    if (jobs.length === 0) {
      return;
    }
    await this.deps.setAlarm(Math.max(Math.min(...jobs.map((j) => j.nextAt)), this.deps.now()));
  }

  private index(): string[] {
    return this.deps.kv.get<string[]>(JOBS_KEY) ?? [];
  }

  private running(): J[] {
    const jobs: J[] = [];
    for (const key of this.index()) {
      const job = this.get(key);
      if (job !== undefined && job.status === "running") {
        jobs.push(job);
      }
    }
    return jobs;
  }
}
