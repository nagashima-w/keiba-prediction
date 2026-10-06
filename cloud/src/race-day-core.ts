/**
 * 日単位の Durable Object `RaceDay` の中身(Issue #177〈#164-b〉)。**純ロジック**: `cloudflare:workers` を import しない。
 * ストレージ(`ctx.storage.sql`)・時計・ゲート・アラームの設定を引数で受けるので、Node の vitest で(本物の SQLite の意味論で)テストできる。
 * DO のラッパ(`race-day-do.ts`)は、これらを本物に配線するだけ。
 *
 * ## 役割
 * 開催日(`idFromName(kaisaiDate)`)ごとに1つの DO が、その日の全レースの**朝の準備**を直列に処理する(gate の待ち行列の上限 8 に当たらない)。
 *  - **ステップ1(取得 `fetch`)**: `scrapeRace`(変更なし。組合せオッズは取らない。単勝・複勝のオッズを1本取る)でキャッシュを埋める。中央16頭の
 *    冷えた状態で gate への取得は **19 本**(出馬表 1・戦績 16・調教 1・単勝複勝 1)。
 *  - **ステップ2(計算 `compute`)**: **ネットワークに出ず**、キャッシュだけで `runCloudAnalysis(analyze: null, allocationSettings: null)` を走らせ、
 *    朝の prior(`AnalysisResult`)を **DO のストレージにだけ**置く(**D1・R2 には書かない**。ユーザー判断 2026-10-06: 保存するのは発走前の分析だけ)。
 *    取得のあとで TTL が切れても読めるよう、キャッシュの鮮度を実質無期限にして読む。キャッシュに戦績が無ければ(掃除された等)、ネットワークに出ず失敗にする
 *    (`scrapeRace` は戦績の失敗を警告にして続けるので、戦績なしの prior を黙って作らないよう検出する)。
 *  - 2つのステップは**別々のアラーム呼び出し**で動かす(1呼び出しの中のサブリクエスト数〈Free は 50〉を抑える・再試行でネットワークを撃ち直さない)。
 *    1回の `runNextStep` は1レースの1ステップだけを行い、続きがあればアラームを設定して戻る。
 *
 * ## 予約(schedule)
 * 予約だけをして戻る(`setAlarm(now)`)。本処理はアラームの中(`runNextStep`)。同じレースが実行中(queued・fetched)なら受け付けない。
 * DO は1つの開催日だけを扱う(最初の予約の開催日に固定し、別の日・raceId の年と違う日は拒否する)。
 *
 * ## 失敗と再試行
 * 取得ステップは、失敗(gate の拒否・通信の失敗・戦績の取りこぼし)なら試行回数 {@link MAX_ATTEMPTS} まで、{@link RETRY_DELAY_MS} 後に再試行する
 * (取れたぶんはキャッシュにあるので、取れなかったぶんだけを取り直す)。**ブレーカーが開いている(blocked)・許可リスト外**は再試行せず直ちに失敗にする
 * (30 分のブレーカーの間に撃ち直さない)。計算ステップの失敗は決定的なので、再試行しない。
 * アラームは少なくとも1回は実行される(失敗時は再実行される)ので、状態(status・attempts)は各ステップの前後に永続化する。
 *
 * ## gate は同時に1本
 * {@link serializeGate} で、RaceDay から gate への呼び出しを直列にする(gate 自身も直列化するが、待ち行列の上限 8 に当たらないよう、呼び出し側でも1本にする)。
 */
import { CachedFetcher, type TextFetcher } from "../../packages/core/src/scraper/cached-fetcher";
import { HttpError } from "../../packages/core/src/scraper/http-client";
import { DEFAULT_RESULTS_TTL_MS, scrapeRace, type RaceFetcher, type ScrapeTtlConfig } from "../../packages/core/src/scraper/scrape-race";
import { parseKaisaiDate, parseRaceId } from "../../packages/core/src/scraper/ids";
import { checkRaceDate } from "./race-date";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { DoSqlCacheStore } from "./do-cache-store";
import { createGateHttpClient, GateRefusedError, type GateLike } from "./gate-fetch";
import { runCloudAnalysis, type CloudAnalysisResult } from "./pipeline";
import { coerceCloudSettings, type CloudSettings } from "./settings";
import type { SqlLike } from "./sql-like";

/** 掃除の時刻(エポックミリ秒)を永続化するキー。 */
const PURGE_DUE_KEY = "purge_due_at";

/**
 * 1日(1つの DO)に受け付けるレースの数の上限。中央は 1日 最大 36 レース(3場 × 12R)。地方を手動で足しても余裕のある値。
 * 手動起動の入口(#180)から、netkeiba への取得が際限なく積まれないための歯止め(すでにあるレースの再予約は数えない)。
 */
export const MAX_TASKS_PER_DAY = 100;

/** 取得ステップの試行回数の上限。 */
export const MAX_ATTEMPTS = 3;
/** 取得ステップの再試行までの間隔(ミリ秒)。 */
export const RETRY_DELAY_MS = 60_000;
/**
 * キャッシュ行の保持期間(ミリ秒)。使う鮮度の最長(戦績 24 時間)より長くする(短いと、まだヒットしうる行を消す)。
 * 仕事が無くなったら、`now + CACHE_RETENTION_MS + PURGE_MARGIN_MS` に**掃除専用のアラーム**を1回だけ設定し、そのアラームで、これを超えた行だけを消す。
 */
export const CACHE_RETENTION_MS = DEFAULT_RESULTS_TTL_MS + 2 * 60 * 60 * 1000;

/**
 * 掃除専用のアラームを、保持期間より少し後ろに置く余裕(ミリ秒)。最後のステップで入った行も、掃除の時刻には保持期間を**超えて**いる
 * (掃除は「経過が保持期間を超えた行」だけを消す。ちょうどは残るので、余裕が無いと最後の行が残る)。
 */
export const PURGE_MARGIN_MS = 60_000;

/** 計算ステップが、取得済みのキャッシュを鮮度に関係なく読むための TTL(実質無期限)。 */
const FOREVER_MS = Number.MAX_SAFE_INTEGER;
const CACHE_ONLY_TTL: ScrapeTtlConfig = {
  shutubaMs: FOREVER_MS,
  resultsMs: FOREVER_MS,
  oikiriMs: FOREVER_MS,
  oddsMs: FOREVER_MS,
  raceListMs: FOREVER_MS,
};

export type TaskStatus = "queued" | "fetched" | "done" | "failed";

/** 朝の取得と prior(`morning`。D1・R2 には書かない)・発走前の分析(`pre_race`。LLM なし。D1・R2 に保存する。Issue #178)。 */
export type TaskMode = "morning" | "pre_race";

/**
 * 発走前の分析の保存先(D1・R2。DO のラッパが `D1AnalysisStore` で実装する)。**朝(morning)のタスクでは呼ばない。**
 *  - `findByAnalyzedAt`: 同じレース・同じ分析時刻の分析が保存済みなら、その id(無ければ null)。計算ステップの再実行(アラームは at-least-once)で、
 *    保存したあとにクラッシュした場合に、2件目を保存しないための確認(分析時刻はタスクに永続化した固定の値)。
 *  - `save`: 保存して、採番 id と R2 の詳細の状態を返す。
 *  - `countChildren`: 保存した分析の子の行(馬・買い目)の件数。子の行が正しい親 id に紐づいたかを、最初の実保存から確かめるため(#175 の `max(id)` の前提)。
 */
export interface AnalysisSink {
  save(record: AnalysisRecord): Promise<{ readonly id: number; readonly detail: "stored" | "failed" | "skipped" }>;
  findByAnalyzedAt(raceId: string, analyzedAt: string): Promise<number | null>;
  countChildren(analysisId: number): Promise<{ readonly horses: number; readonly bets: number }>;
}

export interface RaceDayDeps {
  readonly sql: SqlLike;
  readonly now: () => number;
  /** ゲート(NetkeibaGate の `fetchRaw`)。RaceDay の中で直列化する。 */
  readonly gate: GateLike;
  /** 次のアラームの時刻(エポックミリ秒)を設定する。単一のアラームなので、設定は上書き。 */
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly onWarn: (message: string) => void;
  /** 発走前の分析の保存先(D1・R2)。無ければ、発走前の予約を拒否する。朝のタスクでは呼ばない。 */
  readonly sink?: AnalysisSink;
  /** 設定(D1 の1行)の読み出し。発走前の取得ステップで1回だけ呼び、スナップショットをタスクに保存する。 */
  readonly loadSettings?: () => Promise<CloudSettings>;
}

export interface ScheduleInput {
  readonly raceId: string;
  readonly kaisaiDate: string;
  /** 省略時は `morning`。 */
  readonly mode?: TaskMode;
}

export type ScheduleResult =
  | { readonly accepted: true; readonly raceId: string; readonly mode: TaskMode; readonly status: "queued" }
  | { readonly accepted: false; readonly raceId: string; readonly mode: TaskMode; readonly status: TaskStatus };

export type StepOutcome =
  /** 実行する仕事が無かった。`purged` は、掃除専用のアラームで消したキャッシュの行数(掃除をしたときだけ)。 */
  | { readonly kind: "idle"; readonly purged?: number }
  | {
      readonly kind: "ran";
      readonly raceId: string;
      readonly mode: TaskMode;
      readonly step: "fetch" | "compute";
      readonly result: "ok" | "retry" | "failed";
    };

export interface BoardRace {
  readonly raceId: string;
  readonly mode: TaskMode;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly queuedAt: number;
  readonly updatedAt: number;
  /** 朝の prior を計算した時刻(無ければ null。発走前のタスクは常に null)。 */
  readonly computedAt: number | null;
  /** 発走前の分析で保存した D1 の分析 id(未保存・朝のタスクは null)。 */
  readonly analysisId: number | null;
  /** R2 の詳細の状態(`stored`・`failed`・`skipped`。未保存・朝のタスクは null)。 */
  readonly detail: "stored" | "failed" | "skipped" | null;
  /** 保存した子の行(馬・買い目)の件数が、保存したレコードと一致したか(確認していなければ null)。 */
  readonly childrenOk: boolean | null;
}

export interface Board {
  readonly kaisaiDate: string | null;
  readonly races: readonly BoardRace[];
}

export interface MorningPrior {
  readonly computedAt: number;
  readonly result: CloudAnalysisResult;
}

/** gate への呼び出しを直列にする(FIFO。前の呼び出しが失敗しても次は進む)。 */
export function serializeGate(gate: GateLike): GateLike {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    fetchRaw(url) {
      const run = tail.then(() => gate.fetchRaw(url));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** オッズ・組合せオッズの取得先(中央の `api_get_jra_odds`・地方の `odds/index.html`)。発走前の計算ステップは、これらだけ、取得ステップの開始以降のキャッシュに限る。 */
const ODDS_URL_PATTERN = /api_get_jra_odds|\/odds\/index\.html/;

/** 計算ステップで、オッズのキャッシュが今回の取得より古い(前回の実行の残り)ときに投げる。 */
class StaleOddsError extends Error {
  constructor(url: string) {
    super(`オッズのキャッシュが今回の取得より前のものです(使いません): ${url}`);
    this.name = "StaleOddsError";
  }
}

/** 計算ステップで、キャッシュに無いものをネットワークに取りに行かないための取得器(呼ばれたら投げる)。 */
class CacheMissError extends Error {
  constructor(url: string) {
    super(`キャッシュに無い取得先です(計算ステップはネットワークに出ません): ${url}`);
    this.name = "CacheMissError";
  }
}

const cacheOnlyFetcher: TextFetcher = {
  fetchText: async (url) => {
    throw new CacheMissError(url);
  },
};

function errorMessage(error: unknown): string {
  if (error instanceof HttpError && error.cause instanceof GateRefusedError) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 再試行しても直らない失敗(ブレーカーが開いている・許可リスト外)。 */
function isFatalFetchError(error: unknown): boolean {
  if (error instanceof HttpError && error.cause instanceof GateRefusedError) {
    return error.cause.reason === "blocked" || error.cause.reason === "disallowed-url";
  }
  return false;
}

interface TaskRow {
  race_id: string;
  mode: TaskMode;
  status: TaskStatus;
  attempts: number;
  compute_attempts: number;
  queued_at: number;
  updated_at: number;
  error: string | null;
  analyzed_at: number | null;
  fetch_started_at: number | null;
  settings_json: string | null;
  analysis_id: number | null;
  detail: "stored" | "failed" | "skipped" | null;
  children_ok: number | null;
}

const TASK_MODES: readonly TaskMode[] = ["morning", "pre_race"];

export class RaceDayCore {
  private readonly sql: SqlLike;
  private readonly now: () => number;
  private readonly setAlarm: (at: number) => void | Promise<void>;
  private readonly onWarn: (message: string) => void;
  private readonly sink: AnalysisSink | undefined;
  private readonly loadSettings: (() => Promise<CloudSettings>) | undefined;
  private readonly cache: DoSqlCacheStore;
  private readonly networkFetcher: CachedFetcher;
  private readonly cacheOnly: CachedFetcher;

  constructor(deps: RaceDayDeps) {
    this.sql = deps.sql;
    this.now = deps.now;
    this.setAlarm = deps.setAlarm;
    this.onWarn = deps.onWarn;
    this.sink = deps.sink;
    this.loadSettings = deps.loadSettings;
    this.sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // タスクは (race_id, mode) ごと。mode: morning(朝の取得と prior)・pre_race(発走前の分析。Issue #178)。
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_tasks (
         race_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'morning', status TEXT NOT NULL, attempts INTEGER NOT NULL,
         compute_attempts INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT,
         analyzed_at INTEGER, fetch_started_at INTEGER, settings_json TEXT, analysis_id INTEGER, detail TEXT, children_ok INTEGER,
         PRIMARY KEY (race_id, mode))`,
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS race_day_morning_prior (race_id TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, result_json TEXT NOT NULL)",
    );
    this.cache = new DoSqlCacheStore({ sql: this.sql, now: this.now, onWarn: this.onWarn });
    // RaceDay から gate への呼び出しは直列(同時に1本)。HttpClient は間隔 0・再試行 0(間隔制御は gate だけが行う)。
    const httpClient = createGateHttpClient(serializeGate(deps.gate), { onWarn: deps.onWarn });
    this.networkFetcher = new CachedFetcher({ fetcher: httpClient, cache: this.cache });
    this.cacheOnly = new CachedFetcher({ fetcher: cacheOnlyFetcher, cache: this.cache });
  }

  // ---- 状態の読み書き ----

  private metaGet(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }

  private task(raceId: string, mode: TaskMode): TaskRow | null {
    const rows = this.sql.exec("SELECT * FROM race_day_tasks WHERE race_id = ? AND mode = ?", raceId, mode).toArray() as TaskRow[];
    return rows[0] ?? null;
  }

  private updateTask(task: Pick<TaskRow, "race_id" | "mode">, status: TaskStatus, attempts: number, error: string | null): void {
    this.sql.exec(
      "UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ?",
      status,
      attempts,
      error,
      this.now(),
      task.race_id,
      task.mode,
    );
  }

  /** タスクの追加の列(発走前の分析の状態)を更新する。列名は固定の集合だけ(呼び出し側のコードで決まる値)。 */
  private setTaskFields(task: Pick<TaskRow, "race_id" | "mode">, fields: Partial<Pick<TaskRow, "compute_attempts" | "analyzed_at" | "fetch_started_at" | "settings_json" | "analysis_id" | "detail" | "children_ok">>): void {
    for (const [column, value] of Object.entries(fields)) {
      this.sql.exec(`UPDATE race_day_tasks SET ${column} = ?, updated_at = ? WHERE race_id = ? AND mode = ?`, value ?? null, this.now(), task.race_id, task.mode);
    }
  }

  // ---- 公開(RPC)----

  /**
   * レースの朝の準備(`morning`。既定)または発走前の分析(`pre_race`)を予約する。予約だけをして戻る(取得はしない)。
   * @throws 無効な raceId・開催日・mode、DO の開催日と違う日、raceId の年と開催日の年が違う(地方は月日も)、1日の上限、発走前の分析の保存先が無い構成
   */
  async schedule(input: ScheduleInput): Promise<ScheduleResult> {
    const mode = input.mode ?? "morning";
    if (!TASK_MODES.includes(mode)) {
      throw new Error(`mode は morning か pre_race です(渡された値: ${String(mode).slice(0, 32)})`);
    }
    const raceId = parseRaceId(input.raceId);
    const kaisaiDate = parseKaisaiDate(input.kaisaiDate);
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    // 年(どのレースでも)・月日(地方のレースID。中央は日付を含まない)の整合。入口(handler.ts)でも確かめているが、RPC を直接呼ばれても守る。
    const consistent = checkRaceDate(raceId, kaisaiDate);
    if (!consistent.ok) {
      throw new Error(consistent.message);
    }
    if (mode === "pre_race" && (this.sink === undefined || this.loadSettings === undefined)) {
      throw new Error("発走前の分析の保存先(D1・R2)・設定が、この構成にはありません");
    }
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    const existing = this.task(raceId, mode);
    if (existing !== null && (existing.status === "queued" || existing.status === "fetched")) {
      return { accepted: false, raceId, mode, status: existing.status };
    }
    if (existing === null) {
      const count = (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks").toArray() as { n: number }[])[0]?.n ?? 0;
      if (count >= MAX_TASKS_PER_DAY) {
        throw new Error(`この開催日に受け付けられるレース数の上限(${MAX_TASKS_PER_DAY})に達しています`);
      }
    }
    const now = this.now();
    // 新しい実行: 発走前の分析の状態(分析時刻・設定のスナップショット・保存結果)も作り直す(前の実行の保存結果を、新しい実行の結果として扱わない)。
    this.sql.exec(
      `INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok)
       VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at,
         error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL`,
      raceId,
      mode,
      now,
      now,
    );
    await this.setAlarm(now);
    return { accepted: true, raceId, mode, status: "queued" };
  }

  /** その日のレースの状態の一覧(レースID 昇順、同じレースは morning → pre_race)。 */
  getBoard(): Board {
    const rows = this.sql
      .exec(
        `SELECT t.*, p.computed_at
           FROM race_day_tasks t LEFT JOIN race_day_morning_prior p ON p.race_id = t.race_id AND t.mode = 'morning' ORDER BY t.race_id, t.mode`,
      )
      .toArray() as (TaskRow & { computed_at: number | null })[];
    return {
      kaisaiDate: this.metaGet("kaisai_date"),
      races: rows.map((r) => ({
        raceId: r.race_id,
        mode: r.mode,
        status: r.status,
        attempts: r.attempts,
        error: r.error,
        queuedAt: r.queued_at,
        updatedAt: r.updated_at,
        computedAt: r.computed_at,
        analysisId: r.analysis_id,
        detail: r.detail,
        childrenOk: r.children_ok === null ? null : r.children_ok === 1,
      })),
    };
  }

  /** 朝の prior(無ければ null)。 */
  getMorningPrior(raceId: string): MorningPrior | null {
    const rows = this.sql
      .exec("SELECT computed_at, result_json FROM race_day_morning_prior WHERE race_id = ?", raceId)
      .toArray() as { computed_at: number; result_json: string }[];
    const row = rows[0];
    return row === undefined ? null : { computedAt: row.computed_at, result: JSON.parse(row.result_json) as CloudAnalysisResult };
  }

  // ---- アラームの本処理 ----

  /**
   * 次のステップを1つだけ実行する(1レースの取得 or 計算)。続きの仕事があれば、アラームを設定してから戻る。
   * 実行するのは、(1)取得済みで計算待ちのタスク、なければ (2)取得待ちのタスク(試行回数の少ない順、予約の古い順、レースID 順)。
   */
  async runNextStep(): Promise<StepOutcome> {
    const next = this.pickNext();
    if (next === null) {
      return this.wakeWithoutWork();
    }
    const outcome = await this.runStep(next);
    await this.armAlarm();
    return outcome;
  }

  private runStep(task: TaskRow): Promise<StepOutcome> {
    if (task.mode === "pre_race") {
      return task.status === "fetched" ? this.runPreRaceCompute(task) : this.runPreRaceFetch(task);
    }
    return task.status === "fetched" ? this.runCompute(task) : this.runFetch(task);
  }

  /**
   * 実行する仕事が無いときに起きた(= 掃除専用のアラーム。または早く起きた)。
   * 掃除の時刻になっていれば、保持期間を超えたキャッシュの行だけを消し、**アラームは再設定しない**(以後は新しい予約が来るまで何も起きない)。
   * まだ掃除の時刻前なら、何も消さず、同じ時刻にアラームを設定し直す(早く起きても掃除を取りこぼさない)。掃除の予約が無ければ何もしない。
   */
  private async wakeWithoutWork(): Promise<StepOutcome> {
    const dueText = this.metaGet(PURGE_DUE_KEY);
    if (dueText === null) {
      return { kind: "idle" };
    }
    const due = Number(dueText);
    if (this.now() < due) {
      await this.setAlarm(due);
      return { kind: "idle" };
    }
    this.sql.exec("DELETE FROM race_day_meta WHERE key = ?", PURGE_DUE_KEY);
    return { kind: "idle", purged: this.purgeCache() };
  }

  private pickNext(): TaskRow | null {
    const fetched = this.sql
      .exec("SELECT * FROM race_day_tasks WHERE status = 'fetched' ORDER BY compute_attempts, queued_at, race_id, mode LIMIT 1")
      .toArray() as TaskRow[];
    if (fetched[0] !== undefined) {
      return fetched[0];
    }
    const queued = this.sql
      .exec("SELECT * FROM race_day_tasks WHERE status = 'queued' ORDER BY attempts, queued_at, race_id, mode LIMIT 1")
      .toArray() as TaskRow[];
    return queued[0] ?? null;
  }

  /**
   * 続きの仕事があればアラームを設定する(再試行待ちだけなら遅らせる)。
   * **仕事が無くなったら、掃除専用のアラームを、保持期間 + 余裕の後に設定する**(掃除の時刻を永続化する。前の掃除の予約は上書きされる)。
   * 取得キャッシュは、仕事が無くなった時点ではどの行も新しい(保持期間の内側)ので、その場では何も消えない。アラームを設定しないと、
   * その日の DO は二度と起きず、期限切れの行が永久に残る(レビュー指摘)。
   */
  private async armAlarm(): Promise<void> {
    const rows = this.sql
      .exec("SELECT status, attempts, compute_attempts FROM race_day_tasks WHERE status IN ('queued', 'fetched')")
      .toArray() as { status: TaskStatus; attempts: number; compute_attempts: number }[];
    if (rows.length === 0) {
      const due = this.now() + CACHE_RETENTION_MS + PURGE_MARGIN_MS;
      this.sql.exec(
        "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        PURGE_DUE_KEY,
        String(due),
      );
      await this.setAlarm(due);
      return;
    }
    // すぐ動かせる仕事(初回の取得・初回の計算)があれば now。再試行待ちだけなら遅らせる。
    const immediate = rows.some((r) => (r.status === "fetched" ? r.compute_attempts === 0 : r.attempts === 0));
    await this.setAlarm(this.now() + (immediate ? 0 : RETRY_DELAY_MS));
  }

  /** 保持期間を超えたキャッシュの行を消し、消した件数を返す(失敗したら警告だけ出して 0)。 */
  private purgeCache(): number {
    try {
      return this.cache.purgeOlderThan(CACHE_RETENTION_MS);
    } catch (error) {
      this.onWarn(`取得キャッシュの掃除に失敗しました: ${errorMessage(error)}`);
      return 0;
    }
  }

  // ---- 朝(morning) ----

  private async runFetch(task: TaskRow): Promise<StepOutcome> {
    const attempts = task.attempts + 1;
    // 試行回数は取得の前に永続化する(取得の途中でクラッシュしても、再実行が無限に続かない)。
    this.updateTask(task, "queued", attempts, task.error);
    try {
      const race = await scrapeRace(
        parseRaceId(task.race_id),
        { fetcher: this.networkFetcher, now: () => new Date(this.now()) },
        { includeComboOdds: false },
      );
      const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
      if (missing.length > 0) {
        throw new Error(`戦績を取得できなかった馬が ${missing.length} 頭います(${missing[0]!.message})`);
      }
      this.updateTask(task, "fetched", attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      if (isFatalFetchError(error) || attempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", attempts, message);
        this.onWarn(`朝の取得に失敗しました(${task.race_id}。試行 ${attempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "failed" };
      }
      this.updateTask(task, "queued", attempts, message);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "retry" };
    }
  }

  private async runCompute(task: TaskRow): Promise<StepOutcome> {
    const kaisaiDate = this.metaGet("kaisai_date");
    try {
      if (kaisaiDate === null) {
        throw new Error("開催日が未確定です");
      }
      const raceId = parseRaceId(task.race_id);
      const result = await runCloudAnalysis(raceId, parseKaisaiDate(kaisaiDate), {
        scrape: (id) => this.scrapeFromCache(id, false),
        analyze: null,
        // 朝の prior は D1・R2 に保存しない(DO のストレージにだけ置く)。ここは何も書かない。
        saveAnalysis: () => undefined,
        allocationSettings: null,
        now: () => new Date(this.now()),
        llmSkipReason: "朝の prior(LLM は発走前だけ)",
      });
      this.sql.exec(
        `INSERT INTO race_day_morning_prior (race_id, computed_at, result_json) VALUES (?, ?, ?)
         ON CONFLICT(race_id) DO UPDATE SET computed_at = excluded.computed_at, result_json = excluded.result_json`,
        task.race_id,
        this.now(),
        JSON.stringify(result),
      );
      this.updateTask(task, "done", task.attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "compute", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      this.updateTask(task, "failed", task.attempts, message);
      this.onWarn(`朝の prior の計算に失敗しました(${task.race_id}): ${message}`);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "compute", result: "failed" };
    }
  }

  /**
   * キャッシュだけから `scrapeRace` する(ネットワークに出ない。鮮度は実質無期限)。戦績が1頭でも無ければ投げる(戦績なしの分析を黙って作らない)。
   * `oddsSince`(発走前の分析の取得ステップの開始時刻)を渡すと、**オッズ・組合せオッズは、その時刻以降に取得したキャッシュだけ**を使う
   * (それより古いもの〈前回の発走前の実行で残った、保持 26 時間のキャッシュ〉は、無いものとして扱う)。古い組合せが「今のオッズ」として配分に使われるのを防ぐ。
   * 無い組合せは、exe で組合せの取得が失敗したときと同じく、`scrapeRace` が警告にして、その券種を除く。単勝・複勝のオッズが古い(無い)ときは投げる(必須のデータ)。
   */
  private async scrapeFromCache(raceId: Parameters<typeof scrapeRace>[0], includeComboOdds: boolean, oddsSince?: number) {
    const fetcher: RaceFetcher =
      oddsSince === undefined
        ? this.cacheOnly
        : {
            fetchText: async (url, options) => {
              if (ODDS_URL_PATTERN.test(url)) {
                const entry = this.cache.get(url);
                if (entry === undefined || entry.fetchedAt < oddsSince) {
                  throw new StaleOddsError(url);
                }
                return entry.value;
              }
              return this.cacheOnly.fetchText(url, options);
            },
          };
    const race = await scrapeRace(
      raceId,
      { fetcher, now: () => new Date(this.now()), ttl: CACHE_ONLY_TTL },
      { includeComboOdds },
    );
    const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
    if (missing.length > 0) {
      throw new Error(`キャッシュに戦績がありません(${missing.length} 頭分)。取得をやり直してください`);
    }
    return race;
  }

  // ---- 発走前(pre_race。Issue #178)----

  /**
   * 発走前の取得ステップ: 設定を1回だけ読んでタスクに保存し(スナップショット)、出馬表(取消・天候・馬場を反映。TTL 10 分)・オッズ(**常にキャッシュを迂回**)・
   * 組合せオッズ(設定が ON のときだけ。同じくキャッシュを迂回)を取り直す。戦績・調教は朝のキャッシュがあればそれを使う(無ければ取る)。
   */
  private async runPreRaceFetch(task: TaskRow): Promise<StepOutcome> {
    const attempts = task.attempts + 1;
    this.updateTask(task, "queued", attempts, task.error);
    // 取得ステップの開始時刻は、最初の試行のときに1回だけ永続化する(再試行では進めない)。計算ステップは、オッズ・組合せを、この時刻以降に取得したものだけ使う。
    // 再試行(2・3回目)でも最初の試行の時刻のままなので、最初の試行で取れた組合せを、再試行で取れなくても捨てない。
    if (task.fetch_started_at === null) {
      this.setTaskFields(task, { fetch_started_at: this.now() });
    }
    try {
      let settings: CloudSettings;
      if (task.settings_json !== null) {
        settings = coerceCloudSettings(JSON.parse(task.settings_json));
      } else {
        settings = await this.loadSettings!();
        this.setTaskFields(task, { settings_json: JSON.stringify(settings) });
      }
      const race = await scrapeRace(
        parseRaceId(task.race_id),
        { fetcher: this.networkFetcher, now: () => new Date(this.now()) },
        { includeComboOdds: settings.includeComboOdds, bypassOddsCache: true },
      );
      const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
      if (missing.length > 0) {
        throw new Error(`戦績を取得できなかった馬が ${missing.length} 頭います(${missing[0]!.message})`);
      }
      this.updateTask(task, "fetched", attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      if (isFatalFetchError(error) || attempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", attempts, message);
        this.onWarn(`発走前の取得に失敗しました(${task.race_id}。試行 ${attempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "failed" };
      }
      this.updateTask(task, "queued", attempts, message);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "retry" };
    }
  }

  /**
   * 発走前の計算・保存ステップ: **ネットワークに出ず**(gate は0回)、キャッシュだけで prior → EV → 配分を作り、`AnalysisSink` で D1・R2 に保存する。LLM なし(#179)。
   * 冪等(アラームは少なくとも1回は実行される): 分析時刻(`analyzed_at`)を最初の実行でタスクに永続化し、保存の前に「同じレース・同じ分析時刻の分析が
   * 保存済みか」を確かめる。保存結果(id・R2 の状態)は保存の直後にタスクへ書く。すでに id があれば、計算も保存もしない。
   * 保存先の失敗は、試行回数の上限(3)まで遅らせて再試行する(保存済みなら、再試行で2件目を作らない)。
   */
  private async runPreRaceCompute(task: TaskRow): Promise<StepOutcome> {
    const sink = this.sink!;
    const computeAttempts = task.compute_attempts + 1;
    // 試行回数・分析時刻は、計算の前に永続化する(再実行が無限に続かない・再実行でも同じ分析時刻)。
    const analyzedAtMs = task.analyzed_at ?? this.now();
    this.setTaskFields(task, { compute_attempts: computeAttempts, analyzed_at: analyzedAtMs });
    try {
      const kaisaiDate = this.metaGet("kaisai_date");
      if (kaisaiDate === null || task.settings_json === null) {
        throw new Error("開催日または設定のスナップショットが未確定です");
      }
      if (task.fetch_started_at === null) {
        throw new Error("取得ステップの開始時刻が未確定です");
      }
      const oddsSince = task.fetch_started_at;
      const settings = coerceCloudSettings(JSON.parse(task.settings_json));
      let analysisId = task.analysis_id;
      let expected: { horses: number; bets: number } | null = null;
      let scrapeWarnings: readonly { readonly kind: string; readonly message: string }[] = [];
      if (analysisId === null) {
        const raceId = parseRaceId(task.race_id);
        await runCloudAnalysis(raceId, parseKaisaiDate(kaisaiDate), {
          scrape: async (id) => {
            const race = await this.scrapeFromCache(id, settings.includeComboOdds, oddsSince);
            scrapeWarnings = race.meta.warnings;
            return race;
          },
          analyze: null,
          saveAnalysis: async (record) => {
            expected = { horses: record.horses.length, bets: record.allocation?.bets.length ?? 0 };
            const existing = await sink.findByAnalyzedAt(record.raceId, record.analyzedAt);
            if (existing !== null) {
              analysisId = existing;
              this.setTaskFields(task, { analysis_id: existing });
              return;
            }
            const saved = await sink.save(record);
            analysisId = saved.id;
            // 保存の直後に結果を書く(以降の再実行は、保存も計算もしない)。
            this.setTaskFields(task, { analysis_id: saved.id, detail: saved.detail });
          },
          allocationSettings: {
            bankroll: settings.bankroll,
            perRaceCap: settings.perRaceCap,
            kellyFraction: settings.kellyFraction,
            includeComboOdds: settings.includeComboOdds,
            includeWideInAllocation: settings.includeWideInAllocation,
            includeTrioInAllocation: settings.includeTrioInAllocation,
            includeQuinellaInAllocation: settings.includeQuinellaInAllocation,
            includeExactaInAllocation: settings.includeExactaInAllocation,
            includeTrifectaInAllocation: settings.includeTrifectaInAllocation,
            includeBracketQuinellaInAllocation: settings.includeBracketQuinellaInAllocation,
          },
          evConfig: { threshold: settings.evThreshold },
          now: () => new Date(analyzedAtMs),
          // 当日傾向の読み出し(D1)は、結果の取込(#182)ができるまで空。LLM なしの経路では呼ばれない(#179 で LLM を使うときに効く)。
          getRaceResultDetails: async () => new Map(),
          llmSkipReason: "LLM は未対応(#179)",
        });
        // 取得時の警告(取消馬・組合せオッズの取得失敗〈その券種は配分に入っていない〉など)を、警告として残す。
        for (const warning of scrapeWarnings) {
          this.onWarn(`発走前の分析(${task.race_id}): ${warning.kind}: ${warning.message}`);
        }
        // 保存した子の行(馬・買い目)が、正しい親 id に、保存したレコードの件数だけ紐づいたかを確かめる(最初の実保存で、max(id) の前提を確かめる)。
        if (analysisId !== null && expected !== null) {
          const exp: { horses: number; bets: number } = expected;
          const kids = await sink.countChildren(analysisId);
          const ok = kids.horses === exp.horses && kids.bets === exp.bets;
          this.setTaskFields(task, { children_ok: ok ? 1 : 0 });
          if (!ok) {
            this.onWarn(
              `保存した分析(id ${analysisId})の子の行の件数が一致しません(馬 ${kids.horses}/${exp.horses}・買い目 ${kids.bets}/${exp.bets})。max(id) の前提を確かめてください`,
            );
          }
        }
      }
      this.updateTask(task, "done", task.attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "compute", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      if (computeAttempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", task.attempts, message);
        this.onWarn(`発走前の計算・保存に失敗しました(${task.race_id}。試行 ${computeAttempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "compute", result: "failed" };
      }
      this.updateTask(task, "fetched", task.attempts, message);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "compute", result: "retry" };
    }
  }
}
