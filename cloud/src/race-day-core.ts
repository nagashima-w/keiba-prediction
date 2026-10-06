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
import { DEFAULT_RESULTS_TTL_MS, scrapeRace, type ScrapeTtlConfig } from "../../packages/core/src/scraper/scrape-race";
import { parseKaisaiDate, parseRaceId } from "../../packages/core/src/scraper/ids";
import { DoSqlCacheStore } from "./do-cache-store";
import { createGateHttpClient, GateRefusedError, type GateLike } from "./gate-fetch";
import { runCloudAnalysis, type CloudAnalysisResult } from "./pipeline";
import type { SqlLike } from "./sql-like";

/** 取得ステップの試行回数の上限。 */
export const MAX_ATTEMPTS = 3;
/** 取得ステップの再試行までの間隔(ミリ秒)。 */
export const RETRY_DELAY_MS = 60_000;
/**
 * キャッシュ行の保持期間(ミリ秒)。使う鮮度の最長(戦績 24 時間)より長くする(短いと、まだヒットしうる行を消す)。
 * 仕事が無くなったときに、これを超えた行だけを掃除する。
 */
export const CACHE_RETENTION_MS = DEFAULT_RESULTS_TTL_MS + 2 * 60 * 60 * 1000;

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

export interface RaceDayDeps {
  readonly sql: SqlLike;
  readonly now: () => number;
  /** ゲート(NetkeibaGate の `fetchRaw`)。RaceDay の中で直列化する。 */
  readonly gate: GateLike;
  /** 次のアラームの時刻(エポックミリ秒)を設定する。単一のアラームなので、設定は上書き。 */
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly onWarn: (message: string) => void;
}

export interface ScheduleInput {
  readonly raceId: string;
  readonly kaisaiDate: string;
}

export type ScheduleResult =
  | { readonly accepted: true; readonly raceId: string; readonly status: "queued" }
  | { readonly accepted: false; readonly raceId: string; readonly status: TaskStatus };

export type StepOutcome =
  | { readonly kind: "idle" }
  | {
      readonly kind: "ran";
      readonly raceId: string;
      readonly step: "fetch" | "compute";
      readonly result: "ok" | "retry" | "failed";
    };

export interface BoardRace {
  readonly raceId: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly queuedAt: number;
  readonly updatedAt: number;
  /** 朝の prior を計算した時刻(無ければ null)。 */
  readonly computedAt: number | null;
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
  status: TaskStatus;
  attempts: number;
  queued_at: number;
  updated_at: number;
  error: string | null;
}

export class RaceDayCore {
  private readonly sql: SqlLike;
  private readonly now: () => number;
  private readonly setAlarm: (at: number) => void | Promise<void>;
  private readonly onWarn: (message: string) => void;
  private readonly cache: DoSqlCacheStore;
  private readonly networkFetcher: CachedFetcher;
  private readonly cacheOnly: CachedFetcher;

  constructor(deps: RaceDayDeps) {
    this.sql = deps.sql;
    this.now = deps.now;
    this.setAlarm = deps.setAlarm;
    this.onWarn = deps.onWarn;
    this.sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_tasks (
         race_id TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL,
         queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT)`,
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS race_day_morning_prior (race_id TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, result_json TEXT NOT NULL)",
    );
    this.cache = new DoSqlCacheStore({ sql: this.sql, now: this.now });
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

  private task(raceId: string): TaskRow | null {
    const rows = this.sql.exec("SELECT * FROM race_day_tasks WHERE race_id = ?", raceId).toArray() as TaskRow[];
    return rows[0] ?? null;
  }

  private updateTask(raceId: string, status: TaskStatus, attempts: number, error: string | null): void {
    this.sql.exec(
      "UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ?",
      status,
      attempts,
      error,
      this.now(),
      raceId,
    );
  }

  // ---- 公開(RPC)----

  /**
   * レースの朝の準備を予約する。予約だけをして戻る(取得はしない)。
   * @throws 無効な raceId・開催日、DO の開催日と違う日、raceId の年と開催日の年が違う
   */
  async schedule(input: ScheduleInput): Promise<ScheduleResult> {
    const raceId = parseRaceId(input.raceId);
    const kaisaiDate = parseKaisaiDate(input.kaisaiDate);
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    if (raceId.slice(0, 4) !== kaisaiDate.slice(0, 4)) {
      throw new Error(`レースID(${raceId})の年と開催日(${kaisaiDate})の年が一致しません`);
    }
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    const existing = this.task(raceId);
    if (existing !== null && (existing.status === "queued" || existing.status === "fetched")) {
      return { accepted: false, raceId, status: existing.status };
    }
    const now = this.now();
    this.sql.exec(
      `INSERT INTO race_day_tasks (race_id, status, attempts, queued_at, updated_at, error) VALUES (?, 'queued', 0, ?, ?, NULL)
       ON CONFLICT(race_id) DO UPDATE SET status = 'queued', attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at, error = NULL`,
      raceId,
      now,
      now,
    );
    await this.setAlarm(now);
    return { accepted: true, raceId, status: "queued" };
  }

  /** その日のレースの状態の一覧(レースID 昇順)。 */
  getBoard(): Board {
    const rows = this.sql
      .exec(
        `SELECT t.race_id, t.status, t.attempts, t.queued_at, t.updated_at, t.error, p.computed_at
           FROM race_day_tasks t LEFT JOIN race_day_morning_prior p ON p.race_id = t.race_id ORDER BY t.race_id`,
      )
      .toArray() as (TaskRow & { computed_at: number | null })[];
    return {
      kaisaiDate: this.metaGet("kaisai_date"),
      races: rows.map((r) => ({
        raceId: r.race_id,
        status: r.status,
        attempts: r.attempts,
        error: r.error,
        queuedAt: r.queued_at,
        updatedAt: r.updated_at,
        computedAt: r.computed_at,
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
   * 実行するのは、(1)取得済みで計算待ちのレース、なければ (2)取得待ちのレース(試行回数の少ない順、予約の古い順、レースID 順)。
   */
  async runNextStep(): Promise<StepOutcome> {
    const next = this.pickNext();
    if (next === null) {
      this.purgeCache();
      return { kind: "idle" };
    }
    const outcome =
      next.status === "fetched" ? await this.runCompute(next) : await this.runFetch(next);
    await this.armAlarm();
    return outcome;
  }

  private pickNext(): TaskRow | null {
    const fetched = this.sql
      .exec("SELECT * FROM race_day_tasks WHERE status = 'fetched' ORDER BY queued_at, race_id LIMIT 1")
      .toArray() as TaskRow[];
    if (fetched[0] !== undefined) {
      return fetched[0];
    }
    const queued = this.sql
      .exec("SELECT * FROM race_day_tasks WHERE status = 'queued' ORDER BY attempts, queued_at, race_id LIMIT 1")
      .toArray() as TaskRow[];
    return queued[0] ?? null;
  }

  /** 続きの仕事があればアラームを設定する(再試行待ちだけなら遅らせる)。無ければ設定せず、キャッシュを掃除する。 */
  private async armAlarm(): Promise<void> {
    const rows = this.sql
      .exec("SELECT status, attempts FROM race_day_tasks WHERE status IN ('queued', 'fetched')")
      .toArray() as { status: TaskStatus; attempts: number }[];
    if (rows.length === 0) {
      this.purgeCache();
      return;
    }
    const immediate = rows.some((r) => r.status === "fetched" || r.attempts === 0);
    await this.setAlarm(this.now() + (immediate ? 0 : RETRY_DELAY_MS));
  }

  private purgeCache(): void {
    try {
      this.cache.purgeOlderThan(CACHE_RETENTION_MS);
    } catch (error) {
      this.onWarn(`取得キャッシュの掃除に失敗しました: ${errorMessage(error)}`);
    }
  }

  private async runFetch(task: TaskRow): Promise<StepOutcome> {
    const attempts = task.attempts + 1;
    // 試行回数は取得の前に永続化する(取得の途中でクラッシュしても、再実行が無限に続かない)。
    this.updateTask(task.race_id, "queued", attempts, task.error);
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
      this.updateTask(task.race_id, "fetched", attempts, null);
      return { kind: "ran", raceId: task.race_id, step: "fetch", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      if (isFatalFetchError(error) || attempts >= MAX_ATTEMPTS) {
        this.updateTask(task.race_id, "failed", attempts, message);
        this.onWarn(`朝の取得に失敗しました(${task.race_id}。試行 ${attempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, step: "fetch", result: "failed" };
      }
      this.updateTask(task.race_id, "queued", attempts, message);
      return { kind: "ran", raceId: task.race_id, step: "fetch", result: "retry" };
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
        scrape: async (id) => {
          const race = await scrapeRace(
            id,
            { fetcher: this.cacheOnly, now: () => new Date(this.now()), ttl: CACHE_ONLY_TTL },
            { includeComboOdds: false },
          );
          const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
          if (missing.length > 0) {
            throw new Error(`キャッシュに戦績がありません(${missing.length} 頭分)。取得をやり直してください`);
          }
          return race;
        },
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
      this.updateTask(task.race_id, "done", task.attempts, null);
      return { kind: "ran", raceId: task.race_id, step: "compute", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      this.updateTask(task.race_id, "failed", task.attempts, message);
      this.onWarn(`朝の prior の計算に失敗しました(${task.race_id}): ${message}`);
      return { kind: "ran", raceId: task.race_id, step: "compute", result: "failed" };
    }
  }
}
