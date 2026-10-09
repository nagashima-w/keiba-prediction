/**
 * 検証の集計の純ロジック(Issue #219〈web の検証画面(1)〉)。**`cloudflare:workers` を import しない**(Node でテストできる)。本物の `ctx.storage.kv`・時計・アラーム・D1・R2 は
 * `verify-do.ts`(DO `VerifyReportDO`)が配線する。
 *
 * ## 役割
 * 検証の集計は、分析・結果の**全件**を読む(D1 の読み取りは 1 回の再計算で数万〜十数万行。Free は 1 日 500 万行)うえ、行のデコードだけで Worker Free の CPU 10ms を超える。
 * そこで DO の中で、core の `computeVerifyReport`(exe と同じ関数)を回し、**結果を kv にキャッシュ**する。区分(全体/中央のみ/地方のみ)は 3 つ同時に計算して保存する
 * (区分の切替で D1 を読まない)。
 *
 * ## 流れ(`getReport`)
 * 1. 透かし(`readWatermark`。各表の `MAX(id)`/`MAX(rowid)`。各 1 行)と、発走時刻の補完待ち(`listPending`。カーソルより後の `start_time IS NULL`)を確認する。
 * 2. **補完待ちがあれば集計しない**(発走時刻を失ったまま計算すると、先読み疑いの判定が exe とずれる)。集計があれば、それを「補完中」の印つきで返し、無ければ `preparing`(残り件数)。
 *    補完は `runBackfillTick`(アラーム)が少しずつ行う。
 * 3. 集計が新しい(透かしが同じで TTL 内)ならそのまま返す。そうでなければ再計算するが、**費用の柵**(最短間隔・1 日の回数)に当たったら古い集計を返す(`stale`)。
 * 4. 再計算: `readAll`(7 文の batch)→ `buildVerifySource` → 3 区分の `computeVerifyReport`(`PRODUCTION_VERIFY_CONFIG` = exe の検証画面と同じ設定)。
 *    読んだ行に NULL の行が混ざっていたら(確認と読みの間に保存された)、キャッシュせず `preparing`(集計は exe と一致するときだけ出す)。
 *
 * ## 費用の柵(D1 の読み取り 500 万行/日)
 *  - 再計算は {@link VERIFY_MIN_INTERVAL_MS}(5 分)に 1 回まで、1 日(JST)に {@link VERIFY_DAILY_LIMIT} 回まで。キャッシュのヒット時の D1 の読みは、透かしと補完待ちの確認の 2 クエリだけ。
 *  - 数値の根拠は `docs/current-spec.md` の「クラウド版の検証画面」(ローカルでの実測)。
 *
 * ## 補完(`runBackfillTick`)
 * 1 回のアラームの問い合わせ数は {@link VERIFY_TICK_QUERY_LIMIT}(40)以内(Free の 1 呼び出し 50 クエリの手前。使用量 1 + 補完待ち 1 + 書き込みの batch 2 文 + R2 の get)。
 * R2 の Class B が柵に達していたら止めて、翌月 1 日の 00:05 UTC に再開する(`waiting-r2` 相当)。get の失敗・例外は退避の間隔で再試行し、連続 {@link VERIFY_MAX_ATTEMPTS} 回で止まる
 * (次の `getReport` が、最後の失敗から 10 分以上経っていれば張り直す)。保留(保存直後で詳細がまだ無い)は失敗に数えない。
 * カーソル(kv の `cursor`)は「これ以下の id はすべて補完済み」を表し、補完待ちの確認が全件の走査にならないようにする(解決した行の先頭からの連続した範囲まで進める)。
 */

import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG, type VerifyReport, type VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";
import { isReadAllowed, type R2Usage } from "./r2-fence";
import { buildVerifySource, countStartTimeGaps } from "./verify-read";
import type { PendingPage, PendingRow, ReadAllResult, ResolveOutcome, StartTimeResolution, Watermark } from "./verify-store";

/** 集計の有効期間(透かしが同じ間)。既存の行の更新〈`race_results` の UPSERT〉は透かしに出ないため、この時間で拾う。 */
export const VERIFY_TTL_MS = 60 * 60_000;
/** 再計算の最短間隔。 */
export const VERIFY_MIN_INTERVAL_MS = 5 * 60_000;
/**
 * 1 日(JST)の再計算の上限。1 回あたりの D1 読み取りの実測(`docs/current-spec.md`)から、500 万行/日の一部(他の用途の分を残す)に収まるように決める。
 */
export const VERIFY_DAILY_LIMIT = 24;
/** 1 回のアラームの問い合わせ数(D1 の文+R2 の操作)の上限。`MIGRATION_TICK_QUERY_LIMIT` と同じ。 */
export const VERIFY_TICK_QUERY_LIMIT = 40;
/** 補完が続くときの、次のアラームまでの間隔。 */
export const VERIFY_TICK_DELAY_MS = 1_000;
/** 保留(保存直後で詳細がまだ無い)だけが残るときの再試行の間隔。 */
export const VERIFY_DEFER_RETRY_MS = 60_000;
/** 連続して失敗してよい回数。超えたら止まる。 */
export const VERIFY_MAX_ATTEMPTS = 8;
/** 失敗後の再試行までの待ち。n 回目の失敗の後は `[n-1]`(最後の値を繰り返す)。 */
export const VERIFY_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
/** 失敗で止まったあと、`getReport` が張り直すまでに空ける時間。 */
const VERIFY_REARM_AFTER_MS = 10 * 60_000;
/** R2 の柵から再開する時刻を、月の変わり目からずらす分。 */
const RESUME_MARGIN_MS = 5 * 60_000;
/** 補完の 1 tick の問い合わせ数のうち、R2 の get 以外(使用量 1・補完待ち 1・書き込みの batch 2 文)。 */
const TICK_OVERHEAD_QUERIES = 4;
const JST_OFFSET_MS = 9 * 60 * 60_000;
/** kv に保存する集計の形式の版。形が変わったら上げる(古い集計は使わず再計算する)。 */
const CACHE_VERSION = 1;

/** `ctx.storage.kv`(同期 API)のうち、ここで使う部分。 */
export interface VerifyKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

/** D1・R2 の窓口(`D1VerifyStore` がこれを満たす。テストでは偽物)。 */
export interface VerifyStorePort {
  readWatermark(): Promise<Watermark>;
  listPending(cursor: number, limit: number): Promise<PendingPage>;
  readUsage(): Promise<R2Usage>;
  resolveStartTimes(rows: readonly PendingRow[]): Promise<ResolveOutcome>;
  commitStartTimes(resolved: readonly StartTimeResolution[], gets: number): Promise<number>;
  readAll(): Promise<ReadAllResult>;
}

export interface VerifyCoreDeps {
  readonly kv: VerifyKv;
  readonly now: () => number;
  /** アラームを張る(上書き。DO は 1 つしか張れない)。 */
  readonly setAlarm: (at: number) => void | Promise<void>;
  /** 張られているアラームの時刻(無ければ null)。 */
  readonly getAlarm: () => Promise<number | null>;
  readonly store: VerifyStorePort;
  readonly onWarn?: (message: string) => void;
}

/** 調整できる値(テスト用。本番は既定)。 */
export interface VerifyCoreOptions {
  readonly ttlMs?: number;
  readonly minIntervalMs?: number;
  readonly dailyLimit?: number;
  readonly tickQueryLimit?: number;
}

/** 診断(読んだ行数・所要時間・発走時刻を確認できなかった行)。画面にも API にも出す。 */
export interface VerifyDiag {
  /** D1 が報告した読み取り行数の合計(`meta.rows_read`)。Free の 500 万行/日の実測用。 */
  readonly rowsRead: number;
  /** 表ごとの読んだ行数。 */
  readonly counts: Readonly<Record<string, number>>;
  /** D1 の読みにかかった壁時計(ミリ秒)。 */
  readonly readMs: number;
  /** 3 区分の集計にかかった壁時計(ミリ秒)。 */
  readonly computeMs: number;
  /**
   * 発走時刻を確認できなかった分析(詳細が無い・壊れている)。`lost` はその数、`affecting` はそのうち**先読み判定が時刻に依る**(遮断済みでない)もの。
   * `affecting` > 0 のとき、exe には時刻があった旧い行が、web では「時刻なし」として判定される可能性がある。
   */
  readonly startTimeGaps: { readonly lost: number; readonly affecting: number };
}

interface CacheEntry {
  readonly v: number;
  readonly computedAt: number;
  readonly watermark: Watermark;
  readonly reports: Readonly<Record<VerifyVenueFilter, VerifyReport>>;
  readonly diag: VerifyDiag;
}

interface Runs {
  /** JST の日付(YYYY-MM-DD)。 */
  day: string;
  count: number;
  /** 最後に再計算した時刻。 */
  lastAt: number;
}

interface Backfill {
  /** 連続して失敗した tick の数(成功で 0)。 */
  attempts: number;
  lastFailureAt: number | null;
  /** R2 の柵で止まっているときの再開時刻。 */
  resumeAt: number | null;
}

export type StaleReason = "backfilling" | "min-interval" | "daily-limit";

export type VerifyResponse =
  | {
      readonly status: "ready";
      readonly venue: VerifyVenueFilter;
      readonly report: VerifyReport;
      /** 集計した時刻(ISO)。 */
      readonly computedAt: string;
      /** データの更新に追いついていない集計か(費用の柵・補完中)。 */
      readonly stale: boolean;
      readonly staleReason: StaleReason | null;
      /** 柵で再計算を待たされているとき、次に再計算できる時刻(ISO)。 */
      readonly nextRecomputeAt: string | null;
      readonly diag: VerifyDiag;
    }
  | {
      /** 発走時刻の補完中で、出せる集計がまだ無い。 */
      readonly status: "preparing";
      readonly remaining: number;
      /** 止まっている理由。`r2-fence`: R2 の読み出しの柵(翌月に再開)。`error`: 失敗が続いて止まった。 */
      readonly blocked: "r2-fence" | "error" | null;
      readonly resumeAt: string | null;
    }
  | {
      /** 1 日の再計算の上限に達していて、出せる集計も無い。 */
      readonly status: "throttled";
      readonly nextAt: string;
    };

export interface GetReportOptions {
  /** true なら、透かしが同じ・TTL 内でも再計算する(最短間隔・1 日の上限は守る)。 */
  readonly refresh?: boolean;
}

function sameWatermark(a: Watermark, b: Watermark): boolean {
  return a.analyses === b.analyses && a.results === b.results && a.comboPayouts === b.comboPayouts && a.comboImports === b.comboImports;
}

/** JST の日付(YYYY-MM-DD)。 */
function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 次の JST 0:00 の時刻(ms)。 */
function nextJstMidnight(ms: number): number {
  const day = jstDay(ms);
  return Date.parse(`${day}T00:00:00.000Z`) - JST_OFFSET_MS + 24 * 60 * 60_000;
}

/** 翌月 1 日 00:05 UTC。 */
function nextMonthResume(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0) + RESUME_MARGIN_MS;
}

export class VerifyCore {
  private readonly ttlMs: number;
  private readonly minIntervalMs: number;
  private readonly dailyLimit: number;
  private readonly tickQueryLimit: number;
  /** 計算中の Promise(同時の要求で再計算を共有する。DO のインスタンスの寿命の間だけ)。 */
  private inflight: Promise<CacheEntry | { readonly preparing: number }> | null = null;

  constructor(
    private readonly deps: VerifyCoreDeps,
    options: VerifyCoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? VERIFY_TTL_MS;
    this.minIntervalMs = options.minIntervalMs ?? VERIFY_MIN_INTERVAL_MS;
    this.dailyLimit = options.dailyLimit ?? VERIFY_DAILY_LIMIT;
    this.tickQueryLimit = options.tickQueryLimit ?? VERIFY_TICK_QUERY_LIMIT;
  }

  // -------------------------------------------------------------------------
  // 集計
  // -------------------------------------------------------------------------

  async getReport(venue: VerifyVenueFilter, options: GetReportOptions = {}): Promise<VerifyResponse> {
    const { kv, now, store } = this.deps;
    const watermark = await store.readWatermark();

    // 補完待ちの確認(カーソルより後の NULL の行だけを見る)。
    const cursor = kv.get<number>("cursor") ?? 0;
    const page = await store.listPending(cursor, 1);
    const cache = this.readCache();
    if (page.total > 0) {
      const backfill = await this.armBackfill();
      if (cache !== null) {
        return this.ready(cache, venue, "backfilling", null);
      }
      return { status: "preparing", remaining: page.total, blocked: backfill.blocked, resumeAt: backfill.resumeAt === null ? null : new Date(backfill.resumeAt).toISOString() };
    }
    if (watermark.analyses !== null && watermark.analyses > cursor) {
      kv.put("cursor", watermark.analyses);
    }

    const fresh = cache !== null && sameWatermark(cache.watermark, watermark) && now() - cache.computedAt < this.ttlMs && options.refresh !== true;
    if (cache !== null && fresh) {
      return this.ready(cache, venue, null, null);
    }

    const gate = this.gate();
    if (!gate.ok) {
      if (cache !== null) {
        return this.ready(cache, venue, gate.reason, gate.nextAt);
      }
      return { status: "throttled", nextAt: new Date(gate.nextAt).toISOString() };
    }

    this.inflight ??= this.recompute(watermark).finally(() => {
      this.inflight = null;
    });
    const result = await this.inflight;
    if ("preparing" in result) {
      await this.armBackfill();
      return { status: "preparing", remaining: result.preparing, blocked: null, resumeAt: null };
    }
    return this.ready(result, venue, null, null);
  }

  private readCache(): CacheEntry | null {
    const cache = this.deps.kv.get<CacheEntry>("cache");
    return cache !== undefined && cache.v === CACHE_VERSION ? cache : null;
  }

  private ready(cache: CacheEntry, venue: VerifyVenueFilter, reason: StaleReason | null, nextAt: number | null): VerifyResponse {
    return {
      status: "ready",
      venue,
      report: cache.reports[venue],
      computedAt: new Date(cache.computedAt).toISOString(),
      stale: reason !== null,
      staleReason: reason,
      nextRecomputeAt: nextAt === null ? null : new Date(nextAt).toISOString(),
      diag: cache.diag,
    };
  }

  /** 再計算してよいか(最短間隔・1 日の上限)。 */
  private gate(): { readonly ok: true } | { readonly ok: false; readonly reason: "min-interval" | "daily-limit"; readonly nextAt: number } {
    const { kv, now } = this.deps;
    const t = now();
    const runs = kv.get<Runs>("runs");
    if (runs === undefined) {
      return { ok: true };
    }
    if (runs.day === jstDay(t) && runs.count >= this.dailyLimit) {
      return { ok: false, reason: "daily-limit", nextAt: nextJstMidnight(t) };
    }
    if (t - runs.lastAt < this.minIntervalMs) {
      return { ok: false, reason: "min-interval", nextAt: runs.lastAt + this.minIntervalMs };
    }
    return { ok: true };
  }

  private async recompute(watermark: Watermark): Promise<CacheEntry | { readonly preparing: number }> {
    const { kv, now, store } = this.deps;
    const t0 = now();
    const read = await store.readAll();
    const t1 = now();
    // 確認と読みの間に保存された分析(start_time が NULL)が混ざっていたら、集計しない(exe とずれうる)。
    const unchecked = read.rows.analyses.filter((a) => a.startTime === null).length;
    if (unchecked > 0) {
      return { preparing: unchecked };
    }
    const source = buildVerifySource(read.rows);
    const reports = {
      all: computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "all"),
      central: computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central"),
      nar: computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "nar"),
    };
    const t2 = now();
    const entry: CacheEntry = {
      v: CACHE_VERSION,
      computedAt: t2,
      watermark,
      reports,
      diag: { rowsRead: read.rowsRead, counts: read.counts, readMs: t1 - t0, computeMs: t2 - t1, startTimeGaps: countStartTimeGaps(read.rows.analyses) },
    };
    kv.put("cache", entry);
    const prev = kv.get<Runs>("runs");
    const day = jstDay(t2);
    kv.put("runs", { day, count: prev !== undefined && prev.day === day ? prev.count + 1 : 1, lastAt: t2 } satisfies Runs);
    return entry;
  }

  // -------------------------------------------------------------------------
  // 発走時刻の補完
  // -------------------------------------------------------------------------

  private readBackfill(): Backfill {
    return this.deps.kv.get<Backfill>("backfill") ?? { attempts: 0, lastFailureAt: null, resumeAt: null };
  }

  /**
   * 補完待ちがあるときに、アラームを保証する(自己回復)。止まっている理由を返す。
   *  - R2 の柵で止まっている(`resumeAt` が未来): その時刻にアラームを張る。過ぎていたら止まっていないことにして、今張る。
   *  - 失敗で止まっている(連続 {@link VERIFY_MAX_ATTEMPTS} 回): 最後の失敗から 10 分以上経っていれば、回数を戻して今張る。経っていなければ張らない。
   *  - それ以外: アラームが無ければ今張る。
   */
  private async armBackfill(): Promise<{ readonly blocked: "r2-fence" | "error" | null; readonly resumeAt: number | null }> {
    const { kv, now, setAlarm, getAlarm } = this.deps;
    const t = now();
    const state = this.readBackfill();
    if (state.resumeAt !== null) {
      if (t < state.resumeAt) {
        if ((await getAlarm()) === null) await setAlarm(state.resumeAt);
        return { blocked: "r2-fence", resumeAt: state.resumeAt };
      }
      kv.put("backfill", { ...state, resumeAt: null } satisfies Backfill);
      await setAlarm(t);
      return { blocked: null, resumeAt: null };
    }
    if (state.attempts >= VERIFY_MAX_ATTEMPTS) {
      if (state.lastFailureAt !== null && t - state.lastFailureAt < VERIFY_REARM_AFTER_MS) {
        return { blocked: "error", resumeAt: null };
      }
      kv.put("backfill", { attempts: 0, lastFailureAt: state.lastFailureAt, resumeAt: null } satisfies Backfill);
      await setAlarm(t);
      return { blocked: null, resumeAt: null };
    }
    if ((await getAlarm()) === null) {
      await setAlarm(t);
    }
    return { blocked: null, resumeAt: null };
  }

  /** アラーム: 発走時刻の補完を 1 tick 進める。例外は握る(失敗は状態に記録し、退避の間隔で再試行する)。 */
  async runBackfillTick(): Promise<void> {
    const { kv, now, setAlarm, store, onWarn } = this.deps;
    const t = now();
    const state = this.readBackfill();
    try {
      const usage = await store.readUsage();
      if (!isReadAllowed(usage)) {
        const resumeAt = nextMonthResume(t);
        kv.put("backfill", { ...state, resumeAt } satisfies Backfill);
        await setAlarm(resumeAt);
        return;
      }
      const cursor = kv.get<number>("cursor") ?? 0;
      const limit = this.tickQueryLimit - TICK_OVERHEAD_QUERIES;
      const page = await store.listPending(cursor, limit);
      if (page.rows.length === 0) {
        kv.put("backfill", { attempts: 0, lastFailureAt: state.lastFailureAt, resumeAt: null } satisfies Backfill);
        return;
      }
      const outcome = await store.resolveStartTimes(page.rows);
      await store.commitStartTimes(outcome.resolved, outcome.gets);

      // カーソル: 先頭から連続して解決できた行の末尾まで(保留・失敗の行の手前で止める)。
      const resolvedIds = new Set(outcome.resolved.map((r) => r.id));
      let newCursor = cursor;
      for (const row of page.rows) {
        if (!resolvedIds.has(row.id)) break;
        newCursor = row.id;
      }
      if (newCursor !== cursor) kv.put("cursor", newCursor);

      if (outcome.failed.length > 0) {
        await this.recordFailure(state, t);
        return;
      }
      kv.put("backfill", { attempts: 0, lastFailureAt: state.lastFailureAt, resumeAt: null } satisfies Backfill);
      const remaining = page.total - outcome.resolved.length;
      if (remaining > 0) {
        // 残りが(このページの)保留だけなら間隔を空ける(保存直後の詳細を待つ)。他に進められる行があれば、すぐ続ける。
        const unresolvedInPage = page.rows.length - outcome.resolved.length;
        const onlyDeferred = page.total === page.rows.length && unresolvedInPage > 0 && unresolvedInPage === outcome.deferred.length;
        await setAlarm(t + (onlyDeferred ? VERIFY_DEFER_RETRY_MS : VERIFY_TICK_DELAY_MS));
      }
    } catch {
      // 例外の本文は状態に入れない(固定の文言だけ)。
      onWarn?.("検証の発走時刻の補完で例外が起きました(再試行します)");
      await this.recordFailure(state, t);
    }
  }

  private async recordFailure(state: Backfill, t: number): Promise<void> {
    const attempts = state.attempts + 1;
    this.deps.kv.put("backfill", { attempts, lastFailureAt: t, resumeAt: null } satisfies Backfill);
    if (attempts < VERIFY_MAX_ATTEMPTS) {
      const delay = VERIFY_BACKOFF_MS[Math.min(attempts - 1, VERIFY_BACKOFF_MS.length - 1)]!;
      await this.deps.setAlarm(t + delay);
    }
  }
}
