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
 * 4. 再計算: `readAll`(7 文の batch)→ `buildVerifySource` → 3 区分の `computeVerifyReport`(`PRODUCTION_VERIFY_CONFIG` = exe の検証画面と同じ設定)と、プロンプト版別の比較(`computePromptVersionSummaries`。全体のみ・画面が使う項目だけ。D1 は追加で読まない。Issue #220)。
 *    読んだ行に NULL の行が混ざっていたら(確認と読みの間に保存された)、キャッシュせず `preparing`(集計は exe と一致するときだけ出す)。
 *
 * ## 費用の柵(D1 の読み取り 500 万行/日)
 *  - 再計算は {@link VERIFY_MIN_INTERVAL_MS}(5 分)に 1 回まで、1 日(JST)に {@link VERIFY_DAILY_LIMIT} 回まで。キャッシュのヒット時の D1 の読みは、透かしと補完待ちの確認の 2 クエリだけ。
 *  - 数値の根拠は {@link VERIFY_DAILY_LIMIT} の JSDoc と `docs/current-spec.md` の「クラウド版の検証画面」(ローカルでの実測)。
 *
 * ## 補完(`runBackfillTick`)
 * 1 回のアラームの問い合わせ数は {@link VERIFY_TICK_QUERY_LIMIT}(40)以内(Free の 1 呼び出し 50 クエリの手前。使用量 1 + 補完待ち 1 + 書き込みの batch 2 文 + R2 の get)。
 * R2 の Class B が柵に達していたら止めて、翌月 1 日の 00:05 UTC に再開する(`waiting-r2` 相当)。get の失敗・例外は退避の間隔で再試行し、連続 {@link VERIFY_MAX_ATTEMPTS} 回で止まる
 * (次の `getReport` が、最後の失敗から 10 分以上経っていれば張り直す)。保留(R2 に詳細が無い行を、初めて見てから {@link VERIFY_MISSING_GRACE_MS} 待つ)は失敗に数えない。
 * カーソル(kv の `cursor`)は「これ以下の id はすべて補完済み」を表し、補完待ちの確認が全件の走査にならないようにする(解決した行の先頭からの連続した範囲まで進める)。
 */

import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG, type VerifyReport, type VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";
import { isReadAllowed, type R2Usage } from "./r2-fence";
import { buildVerifySource, countStartTimeGaps } from "./verify-read";
import { computePromptVersionSummaries, type PromptVersionSummary } from "./verify-versions";
import type { PendingPage, PendingRow, ReadAllResult, ResolveOutcome, StartTimeResolution, Watermark } from "./verify-store";

/** 集計の有効期間(透かしが同じ間)。既存の行の更新〈`race_results` の UPSERT〉は透かしに出ないため、この時間で拾う。 */
export const VERIFY_TTL_MS = 60 * 60_000;
/** 再計算の最短間隔。 */
export const VERIFY_MIN_INTERVAL_MS = 5 * 60_000;
/**
 * 1 日(JST)の再計算の上限。**根拠**: 1 回の再計算の D1 の読み取りは、読む表の行数の合計(ローカルの実測: 分析 2,225・馬 28,925・配分メタ 2,225・買い目 26,700・結果 20,814・組合せ払戻 10,408・取込印 7,806 の
 * 計 99,103 行で、D1 が報告した `meta.rows_read` もちょうど 99,103。`scripts/measure-verify.ts`〈買い目は 1 分析 12 件の仮定。本番の実数は未確認〉)。
 * 20 回 × 99,103 行 ≈ 198 万行で、Free の 500 万行/日の約 40%(他の用途〈一覧・詳細・移行・補完〉の分を残す)。本番の買い目が仮定より多ければ 1 回あたりが増える
 * (買い目が 1 分析 40 件なら 1 回約 16 万行で、20 回は約 320 万行〈約 64%〉)。最初の本番の呼び出しの `diag.rowsRead` で実値を確かめ、必要ならこの定数を下げる。
 */
export const VERIFY_DAILY_LIMIT = 20;
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
/**
 * R2 に詳細が無い行を '?' にするまでの猶予(その行を**初めて見てから**の時間)。保存は D1 が先・R2 が後(移行の保存も同じ)なので、「D1 に行があり R2 にまだ無い」瞬間がある。
 * 分析日時では判定できない(移行した分析の分析日時は exe の古い日時)ので、DO が初めて見た時刻(kv の `missingSince`)から数える。'?' は書くと直らないため、長めに待つ。
 */
export const VERIFY_MISSING_GRACE_MS = 30 * 60_000;
/** 失敗で止まったあと、`getReport` が張り直すまでに空ける時間。 */
const VERIFY_REARM_AFTER_MS = 10 * 60_000;
/** R2 の柵から再開する時刻を、月の変わり目からずらす分。 */
const RESUME_MARGIN_MS = 5 * 60_000;
/** 補完の 1 tick の問い合わせ数のうち、R2 の get 以外(使用量 1・補完待ち 1・書き込みの batch 2 文)。 */
const TICK_OVERHEAD_QUERIES = 4;
const JST_OFFSET_MS = 9 * 60 * 60_000;
/**
 * kv に保存する集計の形式の版。形が変わったら上げる(古い集計は使わず再計算する)。
 * 2: 版別比較(`promptVersions`。Issue #220)を足した。版 1 の集計は使わず、デプロイ後の最初の要求で再計算する(1 日の再計算の回数に数える)。
 */
const CACHE_VERSION = 2;

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
  /** 3 区分の集計にかかった壁時計(ミリ秒)。Issue #220 以降も意味は同じ(版別は `promptVersionsMs` に分ける)。 */
  readonly computeMs: number;
  /** プロンプト版別の比較の集計にかかった壁時計(ミリ秒。Issue #220)。 */
  readonly promptVersionsMs: number;
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
  /** プロンプト版別の比較(全体のみ。区分に依らない。画面が使う項目だけ)。Issue #220。 */
  readonly promptVersions: readonly PromptVersionSummary[];
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
      /** プロンプト版別の比較(Issue #220)。**区分(venue)に依らず全体**(exe の版別比較と同じ)。画面が使う項目だけを持つ。 */
      readonly promptVersions: readonly PromptVersionSummary[];
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

    // 透かしが同じなら、データは変わっていない=集計は最新(`stale` にしない)。TTL 切れ・「更新」で再計算を試みるが、柵に拒まれても古い集計とは言わない
    // (既存行の更新は透かしに出ないので、TTL で拾う試みをしているだけ)。柵に当たって `stale` になるのは、透かしが変わった(データが更新された)ときだけ。
    const unchanged = cache !== null && sameWatermark(cache.watermark, watermark);
    const fresh = unchanged && now() - cache.computedAt < this.ttlMs && options.refresh !== true;
    if (cache !== null && fresh) {
      return this.ready(cache, venue, null, null);
    }

    const gate = this.gate();
    if (!gate.ok) {
      if (cache !== null) {
        return unchanged ? this.ready(cache, venue, null, null) : this.ready(cache, venue, gate.reason, gate.nextAt);
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
      promptVersions: cache.promptVersions,
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
    const promptVersions = computePromptVersionSummaries(source);
    const t3 = now();
    const entry: CacheEntry = {
      v: CACHE_VERSION,
      computedAt: t3,
      watermark,
      reports,
      promptVersions,
      diag: { rowsRead: read.rowsRead, counts: read.counts, readMs: t1 - t0, computeMs: t2 - t1, promptVersionsMs: t3 - t2, startTimeGaps: countStartTimeGaps(read.rows.analyses) },
    };
    kv.put("cache", entry);
    const prev = kv.get<Runs>("runs");
    const day = jstDay(t3);
    kv.put("runs", { day, count: prev !== undefined && prev.day === day ? prev.count + 1 : 1, lastAt: t3 } satisfies Runs);
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
      // R2 に詳細が無かった行: 初めて見てから猶予(30 分)を過ぎていれば '?'、それまでは保留(NULL のまま)。このページの行の記録は作り直し、ほかの行の記録は残す。
      const since = { ...(kv.get<Record<string, number>>("missingSince") ?? {}) };
      for (const row of page.rows) delete since[String(row.id)];
      const resolved = [...outcome.resolved];
      const deferred: number[] = [];
      for (const id of outcome.missing) {
        const first = kv.get<Record<string, number>>("missingSince")?.[String(id)] ?? t;
        if (t - first >= VERIFY_MISSING_GRACE_MS) {
          resolved.push({ id, value: "?" });
        } else {
          since[String(id)] = first;
          deferred.push(id);
        }
      }
      await store.commitStartTimes(resolved, outcome.gets);
      kv.put("missingSince", since); // 書き込みが成功してから記録を更新する(失敗して再試行しても、初回観測時刻を失わない)

      // カーソル: 先頭から連続して解決できた行の末尾まで(保留・失敗の行の手前で止める)。
      const resolvedIds = new Set(resolved.map((r) => r.id));
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
      const remaining = page.total - resolved.length;
      if (remaining > 0) {
        // 残りが(このページの)保留だけなら間隔を空ける(詳細が R2 に現れるのを待つ)。他に進められる行があれば、すぐ続ける。
        const unresolvedInPage = page.rows.length - resolved.length;
        const onlyDeferred = page.total === page.rows.length && unresolvedInPage > 0 && unresolvedInPage === deferred.length;
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
