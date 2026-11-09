/**
 * 騎手・調教師の「市場の予測との差」の指標を毎晩作る段取り(Issue #642。親は #548)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。
 * 本物の `ctx.storage.sql`・時計・アラーム・D1 と R2 の読み書き・集計を配線するのは `market-edge-do.ts`(DO `RaceMarketEdgeDO`)。
 * 構造は `race-archive-runs-core.ts`(毎晩の変換)を写した: 依存を引数で受け、状態は DO の SQLite(`CREATE TABLE IF NOT EXISTS`)、アラームの中の失敗は握って再試行する。
 * **netkeiba にも gate にも出ない**(R2 と D1 を読み書きするだけ)。取得の DO・変換の DO とは別のインスタンス・別のアラームなので、互いに止め合わない。
 *
 * ## 何をするか
 *  1. **取り込み**: 目録(`race_archive`)の未処理の中央のレース(`market_version` が NULL。部分索引から読む)を、主キー順のカーソルで読む。
 *     窓(計算する日から 2 年)より古いレースは R2 を読まず印だけ付ける。窓の中のレースを 1 ステップ最大 {@link MARKET_EDGE_STEP_RACES} 件、R2 から一括で読み、
 *     市場の行(`buildMarketRow`)にして D1 の `race_market_rows` に書き、取り込みの印を同じ batch で付ける。使えないレース(計算に入る馬が 4 頭以下)は行を作らず印だけ付ける。
 *  2. **集計**: 未処理が尽きた周の終わり(取り込みが一通り終わった時点)で、**その日(JST)まだ集計していなければ 1 回**、`aggregate`(窓の市場の行を読み、係数を当て直し、
 *     指標を置き換える)を呼ぶ。取り込みが途中の晩(1 晩の上限に当たった晩など)は集計しない(初回の埋め戻しの間、表は空のまま。ユーザーの決定)。
 *
 * ## いつ動くか(ユーザーの決定。#642)
 *  - **JST 3:00 以上 8:30 未満**だけ。取得の DO(0:00〜8:30)・変換の DO(1:00〜8:30)の後。開催日の朝も動かす(netkeiba にも gate にも出ないため)。
 *  - **1 晩の書き込み行数の上限**: 既定 {@link MARKET_EDGE_NIGHTLY_ROWS_DEFAULT}(20,000 行)。取り込みの書き込み行数(`rowsWritten`)に、1 ステップの Class B の計数 1 行を足して数え、
 *    集計の書き込み行数も足す。**上限を超えるのは最後の 1 ステップぶん**。D1 の Free の 1 日 10 万行に対し、変換の DO(既定 3 万行)・取得の DO・事前分析の保存と合わせて収まる大きさ。
 *  - 無効(var が `"0"`): アラームを張らず、起きても何もしない。
 *
 * ## 失敗と止まり方(すべて、次の晩に自動で再開する。手での再開の口は無い。Discord には知らせない〈ログのみ〉)
 *  - R2 の get の例外・R2 に無い・壊れている: そのレースの失敗に数え(`me_fail`)、**その晩はもう試さず**、{@link MARKET_EDGE_MAX_NIGHTS} 晩試して駄目なら諦める。ほかのレースは進む。
 *  - 保存の batch の例外: 次のステップは 1 レースずつに切り分け(`solo`)、1 件だけの失敗はそのレースの失敗に数える。成功するとまとめに戻る。
 *  - 失敗が連続 {@link MARKET_EDGE_CONSECUTIVE_FAILURE_LIMIT} ステップになったら、その晩は止める(`failures`)。R2 の柵(`r2-fence`)・D1 の大きさ(`capacity`)でも、その晩は止める。
 *  - アラームの中の例外(集計の失敗を含む): 握って 10 分後に再試行する。
 *
 * ## DO の SQLite の読み取り
 * 起床のたびに表の全部を読む SQL は無い(状態は `me_meta` の主キー引きと、`me_fail` の主キー引きだけ)。表の全体を数える SQL は状態の読み取り(`getStatus`)だけにある。
 */
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";
import type { RaceRecord } from "../../packages/core/src/scraper/race-record";
import type { MarketAggregateResult } from "./market-edge-aggregate";
import { buildMarketRow, marketWindowCutoff, type MarketRow } from "./market-edge-calc";
import type { MarketPendingEntry } from "./market-edge-repository";
import { inArchiveWindow, nextArchiveWindowStart } from "./race-archive-fetch-core";
import { CATALOG_PAGE_MAX, DB_SIZE_LIMIT_BYTES, READ_BATCH_MAX, type ReadRaceArchivesResult } from "./race-archive-repository";
import type { SqlLike } from "./sql-like";
import { shouldRearm } from "./stale-alarm";

/** 単一インスタンスの固定名。cron の `scheduled` が引く。 */
export const RACE_MARKET_EDGE_NAME = "main";
/** 時間帯の開始(JST の 0 時からの分。含む)。3:00。 */
export const MARKET_EDGE_WINDOW_START_MIN = 3 * 60;
/** 時間帯の終了(JST の 0 時からの分。含まない)。8:30。 */
export const MARKET_EDGE_WINDOW_END_MIN = 8 * 60 + 30;
/** 1 晩の書き込み行数の既定と、var で上げられる上限。 */
export const MARKET_EDGE_NIGHTLY_ROWS_DEFAULT = 20_000;
export const MARKET_EDGE_NIGHTLY_ROWS_MAX = 100_000;
/** 1 ステップで取り込むレースの数(R2 の get を並列に出す数)。 */
export const MARKET_EDGE_STEP_RACES = 20;
/** 目録の 1 回の読み(未処理の列挙)の件数。窓より古い印だけのレースもここで拾うので、取り込みの件数より大きい。 */
export const MARKET_EDGE_PAGE_SIZE = 100;
/** 1 ページの件数の上限。`blockedIds` が race_id を `IN (?, …)` に束縛するので、DO の SQLite の束縛値の上限(100 個)を超えさせない(Issue #626〈#648〉)。 */
export const MARKET_EDGE_PAGE_SIZE_MAX = 100;
export const MARKET_EDGE_STEP_DELAY_MS = 1000;
export const MARKET_EDGE_SCAN_DELAY_MS = 200;
/** 取り込むものが無かった周のあと、見直すまで休む時間。 */
export const MARKET_EDGE_IDLE_MS = 60 * 60_000;
/** 1 ステップの R2 の一括読みの Class B の計数が D1 に書く行数。 */
export const MARKET_EDGE_READ_COUNT_ROWS = 1;
/** 同じレースを何晩試して諦めるか。 */
export const MARKET_EDGE_MAX_NIGHTS = 3;
export const MARKET_EDGE_CONSECUTIVE_FAILURE_LIMIT = 10;
export const MARKET_EDGE_ERROR_RETRY_MS = 10 * 60_000;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** 止める設定の判定(Worker の var `RACE_MARKET_EDGE_NIGHTLY_LIMIT`)。**文字列 `"0"`(前後の空白は無視)だけ**が無効。 */
export function isMarketEdgeDisabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "0";
}

export type MarketEdgeStopReason = "failures" | "capacity" | "r2-fence";

export interface MarketEdgeOptions {
  readonly disabled?: boolean;
  /** 1 晩の書き込み行数の上限(下げる方向の上書き)。 */
  readonly nightlyRows?: number;
  readonly windowStartMin?: number;
  readonly windowEndMin?: number;
  readonly stepRaces?: number;
  readonly pageSize?: number;
  /** D1 の大きさの上限(バイト)。既定は取得の DO と同じ。 */
  readonly maxDbBytes?: number;
}

export interface MarketEdgeDeps {
  /** DO の SQLite(`ctx.storage.sql`)。表 `me_meta`・`me_fail` を `CREATE TABLE IF NOT EXISTS` で作る。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly store: {
    listPendingPage(afterRaceId: string, limit: number): Promise<MarketPendingEntry[]>;
    markSkipped(raceIds: readonly string[]): Promise<{ rowsWritten: number }>;
    saveRows(rows: readonly MarketRow[], doneRaceIds: readonly string[]): Promise<{ rowsWritten: number; dbSizeBytes: number | null }>;
  };
  readonly archive: {
    readRaceArchives(raceIds: readonly string[]): Promise<ReadRaceArchivesResult>;
  };
  /** 窓の市場の行から指標を作って置き換える(`aggregateMarketEdges`)。失敗は throw。 */
  readonly aggregate: (today: string) => Promise<MarketAggregateResult>;
  readonly log: (line: string, level: "info" | "error") => void;
}

export interface LastCalc {
  /** 計算した日(JST) */
  readonly date: string;
  readonly status: "written" | "fit-failed";
  readonly races?: number;
  readonly horses?: number;
  readonly jockeys?: number;
  readonly trainers?: number;
  readonly converged?: boolean;
  readonly usedPreviousCoef?: boolean;
  readonly rowsWritten?: number;
  readonly broken?: number;
}

export interface RaceMarketEdgeStatus {
  readonly state: "disabled" | "running" | "stopped";
  /** `active`・`outside-window`・`night-limit`・`caught-up`・`stopped`・`disabled` など。 */
  readonly waitReason: string;
  readonly stopReason: MarketEdgeStopReason | null;
  readonly nextRunAt: number | null;
  readonly night: { readonly date: string | null; readonly rows: number; readonly races: number; readonly failed: number };
  readonly nightlyRowLimit: number;
  readonly cursor: string;
  /** 失敗が続いていて、まだ試すレースの数。 */
  readonly failing: number;
  /** {@link MARKET_EDGE_MAX_NIGHTS} 晩試して諦めたレースの数。 */
  readonly gaveUp: number;
  readonly totals: { readonly races: number; readonly rows: number };
  readonly dbSizeBytes: number | null;
  readonly lastCalc: LastCalc | null;
  readonly lastStop: { readonly reason: MarketEdgeStopReason; readonly at: number } | null;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Error" : "non-error";
}

/** JST の日付(YYYY-MM-DD)。 */
function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 次の晩(次の JST 0 時)の時間帯の開始。 */
function nextNightStart(ms: number, startMin: number): number {
  const t = (((ms + JST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return ms - t + DAY_MS + startMin * MIN_MS;
}

export class RaceMarketEdgeCore {
  private readonly deps: MarketEdgeDeps;
  private readonly disabled: boolean;
  private readonly nightlyRows: number;
  private readonly startMin: number;
  private readonly endMin: number;
  private readonly stepRaces: number;
  private readonly pageSize: number;
  private readonly maxDbBytes: number;

  constructor(deps: MarketEdgeDeps, options: MarketEdgeOptions = {}) {
    this.deps = deps;
    this.disabled = options.disabled === true;
    this.nightlyRows = options.nightlyRows !== undefined && Number.isInteger(options.nightlyRows) && options.nightlyRows >= 1 ? Math.min(options.nightlyRows, MARKET_EDGE_NIGHTLY_ROWS_MAX) : MARKET_EDGE_NIGHTLY_ROWS_DEFAULT;
    this.startMin = options.windowStartMin ?? MARKET_EDGE_WINDOW_START_MIN;
    this.endMin = options.windowEndMin ?? MARKET_EDGE_WINDOW_END_MIN;
    this.stepRaces = Math.min(options.stepRaces ?? MARKET_EDGE_STEP_RACES, READ_BATCH_MAX);
    this.pageSize = Math.min(options.pageSize ?? MARKET_EDGE_PAGE_SIZE, MARKET_EDGE_PAGE_SIZE_MAX, CATALOG_PAGE_MAX);
    this.maxDbBytes = options.maxDbBytes ?? DB_SIZE_LIMIT_BYTES;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS me_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS me_fail (race_id TEXT PRIMARY KEY, nights INTEGER NOT NULL, last_night TEXT NOT NULL, last_class TEXT NOT NULL) WITHOUT ROWID");
  }

  // ---- 状態の読み書き ----

  private readonly metaCache = new Map<string, string | null>();

  private metaGet(key: string): string | null {
    const cached = this.metaCache.get(key);
    if (cached !== undefined) return cached;
    const rows = this.deps.sql.exec("SELECT value FROM me_meta WHERE key = ?", key).toArray() as { value: string }[];
    const value = rows[0]?.value ?? null;
    this.metaCache.set(key, value);
    return value;
  }

  /** 値が変わるときだけ書く(DO の SQLite の書き込み行数を減らす)。 */
  private metaSet(key: string, value: string): void {
    if (this.metaGet(key) === value) return;
    this.deps.sql.exec("INSERT INTO me_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    this.metaCache.set(key, value);
  }

  private metaDelete(...keys: string[]): void {
    for (const key of keys) {
      if (this.metaGet(key) !== null) {
        this.deps.sql.exec("DELETE FROM me_meta WHERE key = ?", key);
        this.metaCache.set(key, null);
      }
    }
  }

  private metaNum(key: string, fallback = 0): number {
    const raw = this.metaGet(key);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private count(sql: string, ...binds: unknown[]): number {
    return ((this.deps.sql.exec(sql, ...binds).toArray() as { n: number }[])[0]?.n ?? 0) as number;
  }

  private setWait(reason: string): void {
    this.metaSet("wait_reason", reason);
  }

  private addNightRows(n: number): void {
    this.metaSet("night_rows", String(this.metaNum("night_rows") + n));
  }

  // ---- アラーム ----

  /** アラームが無ければ張る(cron の `scheduled` と状態の読み取りが呼ぶ)。 */
  async kick(): Promise<void> {
    if (this.disabled) return;
    const now = this.deps.now();
    if (!shouldRearm(await this.deps.getAlarm(), now, (iso) => this.deps.log(`race-market-edge: stale alarm at=${iso} re-armed`, "info"))) return;
    await this.deps.setAlarm(nextArchiveWindowStart(now, this.startMin, this.endMin));
  }

  /** アラーム: 次のステップを 1 つ実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    if (this.disabled) return;
    try {
      await this.step();
    } catch (error) {
      this.deps.log(`race-market-edge: step failed error=${errorKind(error)}`, "error");
      try {
        await this.deps.setAlarm(this.deps.now() + MARKET_EDGE_ERROR_RETRY_MS);
      } catch {
        // アラームを張れなければ、cron の kick が張り直す。
      }
    }
  }

  private rollover(night: string): void {
    if (this.metaGet("night_date") === night) return;
    this.metaSet("night_date", night);
    this.metaSet("night_rows", "0");
    this.metaSet("night_races", "0");
    this.metaSet("night_failed", "0");
    this.metaSet("consecutive", "0");
  }

  private stopReason(): MarketEdgeStopReason | null {
    const m = this.metaGet("stop_reason");
    return m === "failures" || m === "capacity" || m === "r2-fence" ? m : null;
  }

  private async step(): Promise<void> {
    const now = this.deps.now();
    if (!inArchiveWindow(now, this.startMin, this.endMin)) {
      this.setWait("outside-window");
      await this.deps.setAlarm(nextArchiveWindowStart(now, this.startMin, this.endMin));
      return;
    }
    const night = jstDate(now);
    this.rollover(night);

    // 止まっているとき: 同じ晩は動かさない。次の晩に再開する(理由が残っていれば、次の保存でまた止まる)。
    if (this.stopReason() !== null) {
      if (this.metaGet("stop_night") === night) {
        this.setWait("stopped");
        await this.deps.setAlarm(nextNightStart(now, this.startMin));
        return;
      }
      this.metaDelete("stop_reason", "stop_night");
    }

    if (this.metaNum("night_rows") >= this.nightlyRows) {
      this.setWait("night-limit");
      await this.deps.setAlarm(nextNightStart(now, this.startMin));
      return;
    }

    const take = this.metaGet("solo") === "1" ? 1 : this.stepRaces;
    const cursor = this.metaGet("cursor") ?? "";
    const page = await this.deps.store.listPendingPage(cursor, this.pageSize);
    if (page.length === 0) {
      await this.endOfPass(now, night);
      return;
    }

    // 窓より古いレースは印だけ付ける。窓の中のうち、今夜まだ失敗していない・諦めていないものを、取り込みの候補にする。
    const windowFrom = marketWindowCutoff(night);
    const inWindowIds = page.filter((e) => e.raceDate >= windowFrom).map((e) => e.raceId);
    const blocked = this.blockedIds(inWindowIds, night);
    const old: string[] = [];
    const candidates: MarketPendingEntry[] = [];
    let lastScanned = cursor;
    for (const e of page) {
      lastScanned = e.raceId;
      if (e.raceDate < windowFrom) {
        old.push(e.raceId);
      } else if (!blocked.has(e.raceId)) {
        candidates.push(e);
        if (candidates.length >= take) break;
      }
    }
    if (old.length > 0) {
      const skipped = await this.deps.store.markSkipped(old);
      this.addNightRows(skipped.rowsWritten);
    }
    this.metaSet("cursor", lastScanned);
    if (candidates.length === 0) {
      this.setWait("active");
      await this.deps.setAlarm(now + MARKET_EDGE_SCAN_DELAY_MS);
      return;
    }
    await this.importStep(candidates, now, night, cursor);
  }

  /** 今夜もう失敗した、または諦めたレース(失敗の記録から)。 */
  private blockedIds(ids: readonly string[], night: string): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    const rows = this.deps.sql
      .exec(`SELECT race_id AS id, nights, last_night AS lastNight FROM me_fail WHERE race_id IN (${ids.map(() => "?").join(", ")})`, ...ids)
      .toArray() as { id: string; nights: number; lastNight: string }[];
    for (const r of rows) {
      if (r.nights >= MARKET_EDGE_MAX_NIGHTS || r.lastNight === night) out.add(r.id);
    }
    return out;
  }

  private async importStep(candidates: readonly MarketPendingEntry[], now: number, night: string, cursorBefore: string): Promise<void> {
    const read = await this.deps.archive.readRaceArchives(candidates.map((c) => c.raceId));
    if (read.status === "skipped") {
      await this.stop("r2-fence", now);
      return;
    }
    const rows: MarketRow[] = [];
    const done: string[] = [];
    let readFailures = 0;
    for (const c of candidates) {
      const item = read.items.find((i) => i.raceId === c.raceId);
      if (item === undefined || item.outcome.status !== "found") {
        readFailures += 1;
        this.recordFailure(c.raceId, night, item?.outcome.status === "missing" ? "r2-missing" : "r2-error");
        continue;
      }
      const row = buildMarketRow(item.outcome.archive.record as RaceRecord);
      if (row !== null) rows.push(row);
      done.push(c.raceId);
    }
    if (readFailures > 0) this.metaSet("night_failed", String(this.metaNum("night_failed") + readFailures));

    if (done.length === 0) {
      await this.afterStep(now, false, readFailures > 0);
      return;
    }
    let saved: { rowsWritten: number; dbSizeBytes: number | null };
    try {
      saved = await this.deps.store.saveRows(rows, done);
    } catch (error) {
      this.deps.log(`race-market-edge: save failed class=save-failed error=${errorKind(error)} races=${done.length}`, "error");
      if (done.length === 1) {
        this.recordFailure(done[0]!, night, "save-failed");
        this.metaSet("night_failed", String(this.metaNum("night_failed") + 1));
      } else {
        // 切り分けのため、同じレースから 1 件ずつやり直す(カーソルを戻す)。
        this.metaSet("cursor", cursorBefore);
      }
      this.metaSet("solo", "1");
      await this.afterStep(now, false, true);
      return;
    }
    this.metaSet("solo", "0");
    this.clearFailures(done);
    this.addNightRows(saved.rowsWritten + MARKET_EDGE_READ_COUNT_ROWS);
    this.metaSet("night_races", String(this.metaNum("night_races") + done.length));
    this.metaSet("total_races", String(this.metaNum("total_races") + done.length));
    this.metaSet("total_rows", String(this.metaNum("total_rows") + rows.length));
    this.metaSet("pass_processed", String(this.metaNum("pass_processed") + done.length));
    if (saved.dbSizeBytes !== null) this.metaSet("db_size", String(saved.dbSizeBytes));

    if (saved.dbSizeBytes === null || saved.dbSizeBytes > this.maxDbBytes) {
      await this.stop("capacity", now);
      return;
    }
    await this.afterStep(now, true, readFailures > 0);
  }

  /** 未処理が尽きた周の終わり。その日まだ集計していなければ集計する。取り込みがあった周のあとは続けて見直し、無かった周のあとは 1 時間休む。 */
  private async endOfPass(now: number, night: string): Promise<void> {
    this.metaSet("cursor", "");
    const processed = this.metaNum("pass_processed");
    this.metaSet("pass_processed", "0");
    if (this.metaGet("calc_date") !== night) {
      const result = await this.deps.aggregate(night);
      if (result.status === "written") {
        this.metaSet("calc_date", night);
        this.addNightRows(result.rowsWritten);
        const { status: _status, ...detail } = result;
        void _status;
        this.metaSet("last_calc", JSON.stringify({ date: night, status: "written", ...detail } satisfies LastCalc));
      } else if (result.status === "fit-failed") {
        this.metaSet("calc_date", night);
        this.metaSet("last_calc", JSON.stringify({ date: night, status: "fit-failed" } satisfies LastCalc));
        this.deps.log("race-market-edge: aggregate fit-failed (no previous coef)", "error");
      }
      // no-rows: 記録せず、次の見直しでもう一度確かめる。
    }
    if (processed === 0) {
      this.setWait("caught-up");
      await this.deps.setAlarm(now + MARKET_EDGE_IDLE_MS);
      return;
    }
    this.setWait("active");
    await this.deps.setAlarm(now + MARKET_EDGE_SCAN_DELAY_MS);
  }

  /** 1 ステップの終わり: 連続失敗を数え、次のアラームを張る。 */
  private async afterStep(now: number, imported: boolean, failed: boolean): Promise<void> {
    if (imported) {
      this.metaSet("consecutive", "0");
    } else if (failed) {
      const streak = this.metaNum("consecutive") + 1;
      this.metaSet("consecutive", String(streak));
      if (streak >= MARKET_EDGE_CONSECUTIVE_FAILURE_LIMIT) {
        await this.stop("failures", now);
        return;
      }
    }
    this.setWait("active");
    await this.deps.setAlarm(now + MARKET_EDGE_STEP_DELAY_MS);
  }

  private recordFailure(raceId: string, night: string, cls: string): void {
    this.deps.sql.exec(
      "INSERT INTO me_fail (race_id, nights, last_night, last_class) VALUES (?, 1, ?, ?) ON CONFLICT(race_id) DO UPDATE SET nights = nights + 1, last_night = excluded.last_night, last_class = excluded.last_class",
      raceId,
      night,
      cls,
    );
  }

  /** 取り込めたレースの失敗の記録を、1 文でまとめて消す(主キーの SEARCH。記録が無ければ 0 行の書き込み)。 */
  private clearFailures(raceIds: readonly string[]): void {
    if (raceIds.length > 0) {
      this.deps.sql.exec(`DELETE FROM me_fail WHERE race_id IN (${raceIds.map(() => "?").join(", ")})`, ...raceIds);
    }
  }

  /** 止める。次の晩の開始に張る。通知はしない(ログのみ)。 */
  private async stop(reason: MarketEdgeStopReason, now: number): Promise<void> {
    this.metaSet("stop_reason", reason);
    this.metaSet("stop_night", jstDate(now));
    this.metaSet("last_stop", JSON.stringify({ reason, at: now }));
    this.setWait("stopped");
    this.deps.log(`race-market-edge: stopped reason=${reason}`, "error");
    await this.deps.setAlarm(nextNightStart(now, this.startMin));
  }

  // ---- 観測 ----

  /** 進捗の読み取り(状態は変えない)。 */
  async getStatus(): Promise<RaceMarketEdgeStatus> {
    const dbSize = this.metaGet("db_size");
    const lastStopRaw = this.metaGet("last_stop");
    const lastCalcRaw = this.metaGet("last_calc");
    const stopReason = this.stopReason();
    return {
      state: this.disabled ? "disabled" : stopReason !== null ? "stopped" : "running",
      waitReason: this.disabled ? "disabled" : (this.metaGet("wait_reason") ?? "none"),
      stopReason: this.disabled ? null : stopReason,
      nextRunAt: this.disabled ? null : await this.deps.getAlarm(),
      night: { date: this.metaGet("night_date"), rows: this.metaNum("night_rows"), races: this.metaNum("night_races"), failed: this.metaNum("night_failed") },
      nightlyRowLimit: this.nightlyRows,
      cursor: this.metaGet("cursor") ?? "",
      failing: this.count("SELECT COUNT(*) AS n FROM me_fail WHERE nights < ?", MARKET_EDGE_MAX_NIGHTS),
      gaveUp: this.count("SELECT COUNT(*) AS n FROM me_fail WHERE nights >= ?", MARKET_EDGE_MAX_NIGHTS),
      totals: { races: this.metaNum("total_races"), rows: this.metaNum("total_rows") },
      dbSizeBytes: dbSize === null || dbSize === "" ? null : Number(dbSize),
      lastCalc: lastCalcRaw === null ? null : (JSON.parse(lastCalcRaw) as LastCalc),
      lastStop: lastStopRaw === null ? null : (JSON.parse(lastStopRaw) as RaceMarketEdgeStatus["lastStop"]),
    };
  }
}
