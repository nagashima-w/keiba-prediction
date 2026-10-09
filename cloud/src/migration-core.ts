/**
 * exe から移したファイルの取り込みの状態機械(Issue #216・#167-B1。親は #167)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。
 * 本物の `ctx.storage.kv`・時計・アラーム・R2 のファイルの読み書きは `migration-do.ts`(DO `CloudMigration`)が配線する。
 *
 * ## 流れ
 * 1. **受け付け**(`start`): Worker が、アップロードされた gzip を R2 にそのまま置いてから呼ぶ(Worker は本文を解釈しない。Workers Free の CPU は 10ms)。
 *    取り込み中(検証中・取り込み中・予算待ち・R2 待ち)なら `busy`。完了・失敗のあとは新しいアップロードを受け付ける(前の失敗のファイルはここで削除する)。
 * 2. **検証**(状態 `verifying`): **書き始める前に**ファイル全体を 1 回流して、フッタまで通す(`verifyMigrationFile`。途中で切れた・壊れたファイルは何も書かずに `failed`)。
 * 3. **取り込み**(状態 `importing`): アラームごとに少しずつ。毎回ファイルを先頭から流し、前回の位置(展開後のバイトオフセット)までを**解釈せずに捨てて**続きから進む。
 *    塊に分けて R2 に置き直さない理由: 追加の R2 書き込みが約 100 回・後始末が要る・実装が複雑になるのに対し、流し直しの CPU は 1 回あたり数百 ms と見込まれるため(実測は `docs/current-spec.md`)。
 *    - 分析: 既存の保存経路(`D1AnalysisStore.saveMigratedAnalysis`)。取り込み済み(exe の id)は飛ばす。exe の id が同じで race_id・分析日時が違うものは**衝突**として飛ばして数える(失敗にしない・上書きしない)。
 *    - 結果: 既存の行を優先(`D1ResultStore.saveMigratedResult`)。
 * 4. **完了**(`completed`): アップロードされたファイルを R2 から削除する。状態の記録(件数・衝突)は次のアップロードまで残る。
 *
 * ## 予算(Free の制約)
 *  - **1 回のアラームの問い合わせ数**: D1 の文(batch は文の数)+ R2 の操作が {@link MIGRATION_TICK_QUERY_LIMIT}(40)以内。Free の「1 回の呼び出しで 50 クエリ」を超えないため。
 *    本番の数え方〈batch を 1 と数えるか〉は未確認で、ローカルでは強制されない。保守的に文ごとに数える。数え方が分かったら定数を上げる。
 *  - **D1 の書き込み行数**: 1 日 {@link MIGRATION_DAILY_ROW_LIMIT}(6 万行。Free は 10 万行/日で、通常の運用のぶんを残す)。**D1 が報告する `meta.rows_written` の合計**で数える
 *    (索引の更新を含む)。達したら `waiting-budget` で、翌 UTC 日の 00:05 に再開する(D1 の日次の枠は UTC 0:00 に戻る。定時の cron〈UTC 0:00〉と同時刻にぶつけない)。
 *  - **R2 の操作回数の柵**(#173): 書き込み(Class A)か読み出し(Class B)が柵に達していたら、**「要約だけ保存」にせず**止めて `waiting-r2`、翌月 1 日の 00:05 UTC に再開する(詳細が永久に欠けるため)。
 *
 * ## 中断・失敗
 *  - 位置・件数は 1 件ごとに kv へ保存する。DO が再起動しても、続きから進む。
 *  - アラームの途中で中断した(`inflight`)ときの次のアラームでは、取り込み済みの分析の詳細(R2)を作り直す(D1 の batch と R2 の put の間で止まった分析の詳細が、永久に欠けないため)。
 *  - 取り込み中のエラーは再試行する({@link MIGRATION_RETRY_DELAYS_MS} の間隔)。連続 {@link MIGRATION_MAX_ATTEMPTS} 回で `failed`(ファイルは残す)。**例外の本文は状態に入れない**(固定の文言と種類名だけ)。
 *  - 形式違反(検証後に起きるのは内部の不整合)は再試行しても直らないので、すぐ `failed`。
 */

import { MigrationFormatError, parseMigrationLine, type MigrationLine } from "../../packages/core/src/ev/cloud-migration-format";
import type { D1AnalysisStore } from "./analysis-repository";
import { toAnalysisImport, toResultImport } from "./migration-convert";
import { MigrationFileError, readLines, type RawLine } from "./migration-reader";
import { verifyMigrationFile } from "./migration-verify";
import type { D1ResultStore } from "./result-repository";

/** 1 日(UTC)に移行が D1 に書いてよい行数(`meta.rows_written` の合計)。Free の 10 万行/日のうち、通常の運用のぶんを残す。 */
export const MIGRATION_DAILY_ROW_LIMIT = 60_000;
/** 1 回のアラームで発行する問い合わせ数(D1 の文+R2 の操作)の上限。Free の 1 呼び出し 50 クエリの手前。 */
export const MIGRATION_TICK_QUERY_LIMIT = 40;
/** 1 回のアラームの壁時計の上限(ミリ秒)。 */
export const MIGRATION_TICK_WALL_MS = 20_000;
/** 取り込みが続くとき、次のアラームまでの間隔(ミリ秒)。 */
export const MIGRATION_TICK_DELAY_MS = 1_000;
/** 予算待ち・R2 待ちからの再開を、日付・月の変わり目からずらす分(ミリ秒)。 */
export const MIGRATION_RESUME_MARGIN_MS = 5 * 60_000;
/** 連続して失敗してよい回数。超えたら failed。 */
export const MIGRATION_MAX_ATTEMPTS = 8;
/** 失敗後の再試行までの待ち(ミリ秒)。n 回目の失敗の後は `[n-1]`(最後の値を繰り返す)。 */
export const MIGRATION_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
/** 分析 1 件の問い合わせ数の見積もり(使用量 1 + batch 7 + R2 の put 1 + 再試行の余裕 1)。取り込む件数を決めるときに使い、実際の数は保存の結果から数え直す。 */
const ANALYSIS_QUERY_ESTIMATE = 10;
/** 結果 1 レースの問い合わせ数の見積もり(batch の最大 4 文)。 */
const RESULT_QUERY_ESTIMATE = 4;
/** 1 回のアラームで先読みする行数の上限。 */
const MAX_PLANNED_LINES = 60;
/** 衝突の記録に残す件数の上限。 */
const MAX_CONFLICT_SAMPLES = 5;

export type MigrationState = "idle" | "verifying" | "importing" | "waiting-budget" | "waiting-r2" | "completed" | "failed";

/** `ctx.storage.kv`(同期 API)のうち、ここで使う部分。 */
export interface MigrationKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

export interface MigrationCoreDeps {
  readonly kv: MigrationKv;
  readonly now: () => number;
  /** アラームを張る(上書き。DO は 1 つしか張れない)。 */
  readonly setAlarm: (at: number) => void | Promise<void>;
  /** アップロードされたファイル(gzip)を R2 から開く。無ければ null。 */
  readonly openFile: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
  readonly deleteFile: (key: string) => Promise<void>;
  readonly analyses: Pick<D1AnalysisStore, "findMigrated" | "saveMigratedAnalysis" | "repairDetail" | "getR2Usage" | "countR2Read">;
  readonly results: Pick<D1ResultStore, "saveMigratedResult">;
  readonly onWarn?: (message: string) => void;
}

/** 調整できる値(テスト用。本番は既定)。 */
export interface MigrationCoreOptions {
  readonly dailyRowLimit?: number;
  readonly tickQueryLimit?: number;
  readonly tickWallMs?: number;
}

/** 状態(kv の `job`)。 */
interface Job {
  readonly key: string;
  readonly size: number;
  readonly uploadedAt: number;
  state: Exclude<MigrationState, "idle">;
  exportedAt: string | null;
  appVersion: string | null;
  totalAnalyses: number | null;
  totalResults: number | null;
  /** 次に処理する行の、展開後のバイトオフセット。 */
  offset: number;
  analysesProcessed: number;
  analysesImported: number;
  analysesAlreadyImported: number;
  conflicts: number;
  conflictSamples: string[];
  resultsProcessed: number;
  resumeAt: number | null;
  failure: { phase: "verify" | "import"; message: string } | null;
  /** 連続して失敗したアラームの数。成功で 0。 */
  attempts: number;
  /** アラームの処理の途中(正常に終わっていない)。次のアラームで取り込み済みの詳細を作り直す。 */
  inflight: boolean;
  lastTick: { at: number; queries: number; rows: number; lines: number; ms: number } | null;
  /** 検証の実績(展開後のバイト数・行数・壁時計のミリ秒)。 */
  verified: { bytes: number; lines: number; ms: number } | null;
  updatedAt: number;
}

interface Budget {
  day: string;
  rows: number;
}

export interface MigrationStatus {
  readonly state: MigrationState;
  readonly upload: { readonly size: number; readonly uploadedAt: string; readonly exportedAt: string | null; readonly appVersion: string | null } | null;
  readonly analyses: { readonly total: number | null; readonly processed: number; readonly imported: number; readonly alreadyImported: number; readonly conflicts: number };
  readonly results: { readonly total: number | null; readonly processed: number };
  /** 予算待ち・R2 待ち・失敗後の再試行の再開時刻(ISO)。 */
  readonly resumeAt: string | null;
  readonly failure: { readonly phase: "verify" | "import"; readonly message: string } | null;
  /** 衝突(exe の id が同じで race_id か分析日時が違う)の例(最大 5 件)。 */
  readonly conflictSamples: readonly string[];
  /** 連続して失敗したアラームの数(0 なら正常)。 */
  readonly attempts: number;
  /** 今日(UTC)の D1 の書き込み行数の使用量と上限。 */
  readonly budget: { readonly day: string; readonly usedRows: number; readonly limitRows: number };
  /** 検証の実績(展開後のバイト数・行数・壁時計のミリ秒)。 */
  readonly verified: { readonly bytes: number; readonly lines: number; readonly ms: number } | null;
  /** 直近のアラームの実績(問い合わせ数・書き込み行数・行数・ミリ秒)。 */
  readonly lastTick: { readonly at: string; readonly queries: number; readonly rows: number; readonly lines: number; readonly ms: number } | null;
  readonly updatedAt: string | null;
}

/**
 * 環境変数(Worker の vars・secrets)で上書きする値の読み取り。**1 以上の整数で、上限 `max` 以下の文字列だけ**採用し、それ以外(未設定・空・小数・負・上限超え)は無視して null。
 * 本番の既定を変える手段ではなく、**ローカルの測定・テストと、利用者が上限を下げたいとき**のため(上限を `max` で頭打ちにして、Free の枠を超える値は受け付けない)。
 */
export function parseLimitOverride(value: string | undefined, max: number): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,8}$/.test(value.trim())) {
    return null;
  }
  const n = Number(value.trim());
  return n <= max ? n : null;
}

/** D1 の Free の書き込み行数の上限(1 日)。移行の 1 日の上限の環境変数による上書きの上限。 */
export const D1_FREE_DAILY_WRITE_ROWS = 100_000;
/** D1 の Free の 1 回の呼び出しあたりのクエリ数の上限。 */
export const FREE_QUERIES_PER_INVOCATION = 50;

export type StartResult = { readonly accepted: true } | { readonly accepted: false; readonly reason: "busy" };

const KEY_JOB = "job";
const KEY_BUDGET = "budget";

const BUSY_STATES: readonly MigrationState[] = ["verifying", "importing", "waiting-budget", "waiting-r2"];

/** UTC の日付(YYYYMMDD)。 */
export function utcDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 次の UTC 日の 00:05。 */
export function nextDayResumeAt(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) + MIGRATION_RESUME_MARGIN_MS;
}

/** 翌月 1 日の 00:05(UTC)。 */
export function nextMonthResumeAt(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0) + MIGRATION_RESUME_MARGIN_MS;
}

/** ログ・状態に出してよいエラーの種類名(英数字と `_` の 1〜40 文字だけ)。 */
function errorKind(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(error.name)) {
    return error.name;
  }
  return error instanceof Error ? "UnknownError" : "non-error";
}

/** 先読みした 1 行(解釈済み)。 */
interface PlannedItem {
  readonly raw: RawLine;
  readonly line: MigrationLine;
}

export class MigrationCore {
  private readonly deps: MigrationCoreDeps;
  private readonly dailyRowLimit: number;
  private readonly tickQueryLimit: number;
  private readonly tickWallMs: number;

  constructor(deps: MigrationCoreDeps, options: MigrationCoreOptions = {}) {
    this.deps = deps;
    this.dailyRowLimit = options.dailyRowLimit ?? MIGRATION_DAILY_ROW_LIMIT;
    this.tickQueryLimit = options.tickQueryLimit ?? MIGRATION_TICK_QUERY_LIMIT;
    this.tickWallMs = options.tickWallMs ?? MIGRATION_TICK_WALL_MS;
  }

  private loadJob(): Job | null {
    return this.deps.kv.get<Job>(KEY_JOB) ?? null;
  }

  private saveJob(job: Job): void {
    job.updatedAt = this.deps.now();
    this.deps.kv.put(KEY_JOB, job);
  }

  private loadBudget(now: number): Budget {
    const stored = this.deps.kv.get<Budget>(KEY_BUDGET);
    const day = utcDay(now);
    return stored !== undefined && stored.day === day ? { ...stored } : { day, rows: 0 };
  }

  private saveBudget(budget: Budget): void {
    this.deps.kv.put(KEY_BUDGET, budget);
  }

  // -------------------------------------------------------------------------
  // 受け付けと観測
  // -------------------------------------------------------------------------

  /**
   * アップロードされたファイル(R2 の `key`)の取り込みを始める。取り込み中なら `busy`(状態は変えない。呼び出し側が、置いたファイルを消す)。
   * 前の完了・失敗の記録は置き換える(前の失敗のファイルが別のキーで残っていれば、削除する)。
   */
  async start(input: { readonly key: string; readonly size: number }): Promise<StartResult> {
    const previous = this.loadJob();
    if (previous !== null && BUSY_STATES.includes(previous.state)) {
      return { accepted: false, reason: "busy" };
    }
    if (previous !== null && previous.key !== input.key) {
      await this.deps.deleteFile(previous.key).catch(() => undefined);
    }
    const now = this.deps.now();
    this.saveJob({
      key: input.key,
      size: input.size,
      uploadedAt: now,
      state: "verifying",
      exportedAt: null,
      appVersion: null,
      totalAnalyses: null,
      totalResults: null,
      offset: 0,
      analysesProcessed: 0,
      analysesImported: 0,
      analysesAlreadyImported: 0,
      conflicts: 0,
      conflictSamples: [],
      resultsProcessed: 0,
      resumeAt: null,
      failure: null,
      attempts: 0,
      inflight: false,
      lastTick: null,
      verified: null,
      updatedAt: now,
    });
    await this.deps.setAlarm(now);
    return { accepted: true };
  }

  /** 進捗(状態は変えない)。 */
  getStatus(): MigrationStatus {
    const job = this.loadJob();
    const now = this.deps.now();
    const budget = this.loadBudget(now);
    const budgetView = { day: budget.day, usedRows: budget.rows, limitRows: this.dailyRowLimit };
    if (job === null) {
      return {
        state: "idle",
        upload: null,
        analyses: { total: null, processed: 0, imported: 0, alreadyImported: 0, conflicts: 0 },
        results: { total: null, processed: 0 },
        resumeAt: null,
        failure: null,
        conflictSamples: [],
        attempts: 0,
        budget: budgetView,
        verified: null,
        lastTick: null,
        updatedAt: null,
      };
    }
    return {
      state: job.state,
      upload: { size: job.size, uploadedAt: new Date(job.uploadedAt).toISOString(), exportedAt: job.exportedAt, appVersion: job.appVersion },
      analyses: { total: job.totalAnalyses, processed: job.analysesProcessed, imported: job.analysesImported, alreadyImported: job.analysesAlreadyImported, conflicts: job.conflicts },
      results: { total: job.totalResults, processed: job.resultsProcessed },
      resumeAt: job.resumeAt === null ? null : new Date(job.resumeAt).toISOString(),
      failure: job.failure,
      conflictSamples: job.conflictSamples,
      attempts: job.attempts,
      budget: budgetView,
      verified: job.verified ?? null,
      lastTick: job.lastTick === null ? null : { ...job.lastTick, at: new Date(job.lastTick.at).toISOString() },
      updatedAt: new Date(job.updatedAt).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // アラーム
  // -------------------------------------------------------------------------

  /** アラーム: 次のステップを 1 つ実行する。例外は投げない(失敗は状態に記録する)。 */
  async runNextStep(): Promise<void> {
    const job = this.loadJob();
    if (job === null || job.state === "completed" || job.state === "failed") {
      return;
    }
    const now = this.deps.now();
    if ((job.state === "waiting-budget" || job.state === "waiting-r2") && job.resumeAt !== null && now < job.resumeAt) {
      await this.deps.setAlarm(job.resumeAt);
      return;
    }
    try {
      if (job.state === "verifying") {
        await this.verify(job);
      } else {
        await this.importTick(job);
      }
    } catch (error) {
      await this.onStepError(job, error);
    }
  }

  private async fail(job: Job, phase: "verify" | "import", message: string, deleteFile: boolean): Promise<void> {
    job.state = "failed";
    job.failure = { phase, message };
    job.resumeAt = null;
    job.inflight = false;
    this.saveJob(job);
    if (deleteFile) {
      await this.deps.deleteFile(job.key).catch(() => undefined);
    }
  }

  /** ステップの例外: 形式違反は直らないので即 failed。それ以外は再試行(上限まで)。 */
  private async onStepError(job: Job, error: unknown): Promise<void> {
    const phase = job.state === "verifying" ? "verify" : "import";
    if (error instanceof MigrationFormatError) {
      await this.fail(job, phase, error.message, phase === "verify");
      return;
    }
    if (job.state !== "verifying") {
      job.attempts += 1; // 検証の回数は verify() が開始のたびに数えている
    }
    this.deps.onWarn?.(`migration: step failed state=${job.state} attempt=${job.attempts} error=${errorKind(error)}`);
    if (job.attempts >= MIGRATION_MAX_ATTEMPTS) {
      await this.fail(job, phase, `エラーが続いたため止めました(${errorKind(error)})。再度アップロードすると、取り込み済みの分は飛ばして続きから取り込みます`, false);
      return;
    }
    const delay = MIGRATION_RETRY_DELAYS_MS[Math.min(job.attempts - 1, MIGRATION_RETRY_DELAYS_MS.length - 1)]!;
    this.saveJob(job);
    await this.deps.setAlarm(this.deps.now() + delay);
  }

  // -------------------------------------------------------------------------
  // 検証
  // -------------------------------------------------------------------------

  private async verify(job: Job): Promise<void> {
    // 検証の途中で DO が落ち続けても(CPU・メモリ)、無限に繰り返さない: 開始のたびに数え、成功で戻す。
    job.attempts += 1;
    this.saveJob(job);
    if (job.attempts > 3) {
      await this.fail(job, "verify", "検証を繰り返しましたが完了しませんでした(ファイルが大きすぎる可能性があります)", true);
      return;
    }
    const stream = await this.deps.openFile(job.key);
    if (stream === null) {
      await this.fail(job, "verify", "アップロードされたファイルが見つかりません。もう一度アップロードしてください", false);
      return;
    }
    await this.deps.analyses.countR2Read(); // 検証の読み出し 1 回(Class B)。柵の確認は取り込みのアラームで行う(検証は 1 回だけの読み出し)。
    const verifyStartedAt = this.deps.now();
    const verified = await verifyMigrationFile(stream);
    job.verified = { bytes: verified.bytes, lines: verified.lines, ms: this.deps.now() - verifyStartedAt };
    job.exportedAt = verified.header.exportedAt;
    job.appVersion = verified.header.appVersion;
    job.totalAnalyses = verified.footer.analysisLines;
    job.totalResults = verified.footer.resultLines;
    job.state = "importing";
    job.attempts = 0;
    job.offset = 0;
    this.saveJob(job);
    await this.deps.setAlarm(this.deps.now());
  }

  // -------------------------------------------------------------------------
  // 取り込み
  // -------------------------------------------------------------------------

  private async importTick(job: Job): Promise<void> {
    const startedAt = this.deps.now();
    const recovering = job.inflight;
    let queries = 0;
    let rows = 0;
    let lines = 0;

    // 1. R2 の柵(書き込み・読み出しのどちらも)。達していたら、何も書かずに翌月まで待つ。
    const usage = await this.deps.analyses.getR2Usage();
    queries += 1;
    if (!usage.writeAllowed || !usage.readAllowed) {
      await this.waitFor(job, "waiting-r2", nextMonthResumeAt(startedAt));
      return;
    }
    // 2. 今日の予算。
    const budget = this.loadBudget(startedAt);
    if (budget.rows >= this.dailyRowLimit) {
      await this.waitFor(job, "waiting-budget", nextDayResumeAt(startedAt));
      return;
    }

    job.state = "importing";
    job.resumeAt = null;
    job.inflight = true;
    this.saveJob(job);

    // 3. ファイルを開き(R2 の読み出し 1)、読み出しを数え(D1 の書き込み 1 行・問い合わせ 1)、この回に処理する行を先読みする(問い合わせ数の上限に収まる範囲)。
    const stream = await this.deps.openFile(job.key);
    queries += 1;
    if (stream === null) {
      await this.fail(job, "import", "アップロードされたファイルが見つかりません。もう一度アップロードしてください", false);
      return;
    }
    await this.deps.analyses.countR2Read();
    queries += 1;
    rows += 1;
    budget.rows += 1;
    // 取り込み済みの確認(findMigrated)の分を見込む。
    const { planned, reachedEnd } = await this.plan(stream, job.offset, this.tickQueryLimit - queries - 1);
    const exeIds = planned.flatMap((p) => (p.line.type === "analysis" ? [p.line.analysis["id"] as number] : []));
    const existing = await this.deps.analyses.findMigrated(exeIds);
    queries += exeIds.length === 0 ? 0 : 1;

    // 4. 1 行ずつ処理する。位置と件数は 1 件ごとに保存する。
    let stoppedEarly = false;
    let waiting = false;
    let failure: Error | null = null;
    for (const item of planned) {
      if (budget.rows >= this.dailyRowLimit) {
        stoppedEarly = true;
        waiting = true;
        await this.waitFor(job, "waiting-budget", nextDayResumeAt(startedAt));
        break;
      }
      if (this.deps.now() - startedAt > this.tickWallMs) {
        stoppedEarly = true;
        break;
      }
      const cost = item.line.type === "analysis" ? ANALYSIS_QUERY_ESTIMATE : item.line.type === "result" ? RESULT_QUERY_ESTIMATE : 0;
      if (lines > 0 && queries + cost > this.tickQueryLimit) {
        stoppedEarly = true;
        break;
      }
      const outcome = await this.processItem(job, item.line, existing, recovering);
      queries += outcome.queries;
      rows += outcome.rows;
      budget.rows += outcome.rows;
      if (outcome.stop === "waiting-r2") {
        stoppedEarly = true;
        waiting = true;
        this.saveBudget(budget);
        await this.waitFor(job, "waiting-r2", nextMonthResumeAt(this.deps.now()));
        break;
      }
      if (outcome.error !== undefined) {
        // D1 の行はできたが、続けられない(R2 への書き込みの失敗)。使った行数を記録して、ステップの失敗として再試行する(inflight が残るので、次は詳細を作り直す)。
        failure = outcome.error;
        break;
      }
      job.offset = item.raw.end;
      lines += 1;
      this.saveJob(job);
      this.saveBudget(budget);
    }
    job.lastTick = { at: startedAt, queries, rows, lines, ms: this.deps.now() - startedAt };
    this.saveBudget(budget);
    if (failure !== null) {
      this.saveJob(job);
      throw failure;
    }
    if (waiting) {
      return;
    }
    if (reachedEnd && !stoppedEarly) {
      await this.complete(job);
      return;
    }
    job.attempts = 0;
    job.inflight = false;
    this.saveJob(job);
    await this.deps.setAlarm(this.deps.now() + MIGRATION_TICK_DELAY_MS);
  }

  /** 状態を待機にして、再開時刻にアラームを張る。 */
  private async waitFor(job: Job, state: "waiting-budget" | "waiting-r2", resumeAt: number): Promise<void> {
    job.state = state;
    job.resumeAt = resumeAt;
    job.inflight = false;
    job.attempts = 0;
    this.saveJob(job);
    await this.deps.setAlarm(resumeAt);
  }

  private async complete(job: Job): Promise<void> {
    job.state = "completed";
    job.resumeAt = null;
    job.failure = null;
    job.attempts = 0;
    job.inflight = false;
    this.saveJob(job);
    await this.deps.deleteFile(job.key).catch(() => undefined);
  }

  /** 先頭から `offset` まで捨てて、問い合わせ数 `queryRoom` に収まる範囲の行を先読みする。 */
  private async plan(stream: ReadableStream<Uint8Array>, offset: number, queryRoom: number): Promise<{ planned: PlannedItem[]; reachedEnd: boolean }> {
    const planned: PlannedItem[] = [];
    let used = 0;
    let reachedEnd = true;
    try {
      for await (const raw of readLines(stream, offset)) {
        const line = parseMigrationLine(raw.text);
        const cost = line.type === "analysis" ? ANALYSIS_QUERY_ESTIMATE : line.type === "result" ? RESULT_QUERY_ESTIMATE : 0;
        if (planned.length >= MAX_PLANNED_LINES || (planned.some((p) => p.line.type === "analysis" || p.line.type === "result") && used + cost > queryRoom)) {
          reachedEnd = false;
          break;
        }
        planned.push({ raw, line });
        used += cost;
      }
    } catch (error) {
      if (error instanceof MigrationFileError) {
        throw new MigrationFormatError(error.message);
      }
      throw error;
    }
    return { planned, reachedEnd };
  }

  /** 1 行を処理する。戻り値の queries・rows は、その行で使った分。`error` は、D1 には書けたが続けられない失敗(呼び出し側が、使った分を数えてから投げ直す)。 */
  private async processItem(
    job: Job,
    line: MigrationLine,
    existing: ReadonlyMap<number, { readonly id: number; readonly raceId: string; readonly analyzedAt: string }>,
    recovering: boolean,
  ): Promise<{ queries: number; rows: number; stop?: "waiting-r2"; error?: Error }> {
    switch (line.type) {
      case "header":
      case "footer":
        return { queries: 0, rows: 0 };
      case "analysis": {
        const imp = toAnalysisImport(line);
        const ref = existing.get(imp.exeId);
        if (ref !== undefined) {
          if (ref.raceId !== imp.record.raceId || ref.analyzedAt !== imp.record.analyzedAt) {
            job.conflicts += 1;
            if (job.conflictSamples.length < MAX_CONFLICT_SAMPLES) {
              job.conflictSamples.push(`exe の分析 id ${imp.exeId}(${imp.record.raceId}・${imp.record.analyzedAt})は、取り込み済みの別の分析(${ref.raceId}・${ref.analyzedAt})と id が同じため飛ばした`);
            }
            job.analysesProcessed += 1;
            return { queries: 0, rows: 0 };
          }
          let queries = 0;
          let rows = 0;
          if (recovering) {
            // 前回の処理が途中で止まった可能性: 詳細(R2)を作り直す(D1 の batch と R2 の put の間で止まった分析のため)。
            const repaired = await this.deps.analyses.repairDetail(ref.id, imp.record);
            queries += repaired.queries;
            rows += repaired.kind === "fenced" ? 0 : 1; // Class A のカウンタの更新
            if (repaired.kind === "fenced") {
              return { queries, rows, stop: "waiting-r2" };
            }
            if (repaired.kind === "failed") {
              return { queries, rows, error: new Error("R2 への書き込みに失敗しました") };
            }
          }
          job.analysesAlreadyImported += 1;
          job.analysesProcessed += 1;
          return { queries, rows };
        }
        const saved = await this.deps.analyses.saveMigratedAnalysis(imp);
        if (saved.kind === "fenced") {
          return { queries: saved.queries, rows: 0, stop: "waiting-r2" };
        }
        if (saved.detail === "failed") {
          // D1 の行はできている。次のアラーム(inflight が残る)で、詳細を作り直す。
          return { queries: saved.queries, rows: saved.rowsWritten, error: new Error("R2 への書き込みに失敗しました") };
        }
        job.analysesImported += 1;
        job.analysesProcessed += 1;
        return { queries: saved.queries, rows: saved.rowsWritten };
      }
      case "result": {
        const out = await this.deps.results.saveMigratedResult(toResultImport(line));
        job.resultsProcessed += 1;
        return { queries: out.queries, rows: out.rowsWritten };
      }
    }
  }
}
