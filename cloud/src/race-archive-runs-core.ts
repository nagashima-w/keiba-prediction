/**
 * 過去の結果を horse_runs に入れる毎晩の変換(Issue #590〈#549-B3-2〉。親は #549)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。
 * 本物の `ctx.storage.sql`・時計・アラーム・目録と R2 の読み出し・変換の書き込み・通知を配線するのは `race-archive-runs-do.ts`(DO `RaceArchiveRunsDO`)。
 * 構造は `race-archive-fetch-core.ts`(毎晩の取得)を写した: 依存を引数で受け、状態は DO の SQLite(`CREATE TABLE IF NOT EXISTS`)、アラームの中の失敗は握って再試行する。
 * **netkeiba にも gate にも出ない**(R2 と D1 を読み書きするだけ)。
 *
 * ## 何をするか
 * 目録(`race_archive`)を主キー(race_id)順のカーソルで読み、**未変換のレース**(`runs_version` が NULL か現行の `RESULT_RUN_VERSION` より小さい)を
 * 1 ステップあたり最大 {@link ARCHIVE_RUNS_STEP_RACES} 件、R2 から一括で読み、`convertRaceArchives`(#588。D1 の batch 1 回)で `horse_runs` に書いて済み印を付ける。
 * 走査の範囲(Issue #613): 通常は未変換(`runs_version` が NULL)の行だけを部分索引(migration 0036)から読む。版({@link RESULT_RUN_VERSION})を上げた直後の 1 周だけは全行を読んで、版の古い行を拾う(`scanScope`)。
 * 取得が進むと目録が増えるので、周(目録の末尾まで)が終わるたびに先頭から見直す。**変換があった周のあとは続けて見直し、何も変換しなかった周のあとは 1 時間休む**({@link ARCHIVE_RUNS_IDLE_MS})。
 *
 * ## いつ動くか(ユーザーの決定。#590)
 *  - **JST 1:00 以上 8:30 未満**だけ。21:00・23:00 の事前分析(戦績 API の保存)と重ならないようにする(#552 の【記録】6: 戦績 API の保存の読みと書きの間に結果ページ由来の行が書かれると、
 *    新規の挿入が捨てられて、その回の `rowsNew` が大きく出る。次の保存で直る。時間帯を分けるだけで受け入れる)。取得の DO(0:00〜8:30)とは別のアラームで、止め合わない。
 *  - **1 晩の書き込み行数の上限**: 既定 {@link ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT}(60,000 行。2026-11-09 のユーザーの決定〈#704〉で 30,000 から上げた。D1 の Free の 1 日 10 万行を超えると、その日は発走前の分析も保存できなくなる)。
 *    変換の結果の `rowsWritten`(batch の各文の `rows_written` の合計)に、1 ステップの Class B の計数 1 行({@link ARCHIVE_RUNS_READ_COUNT_ROWS})を足して数える。**上限を超えるのは最後の 1 ステップぶん**(約 300 行)だけ。下げる方向の上書き(Worker の var)だけ受ける。
 *  - 無効(var が `"0"`): アラームを張らず、起きても何もしない。
 *
 * ## 失敗と止まり方(すべて、次の晩に自動で再開する。手での再開の口は無い)
 *  - R2 の get の例外・R2 に無い・壊れている: そのレースの失敗に数え(`rr_fail`)、**その晩はもう試さず**、{@link ARCHIVE_RUNS_MAX_NIGHTS} 晩試して駄目なら諦める(`gaveUp`)。ほかのレースは進む。
 *  - 変換の batch の例外: 次のステップは 1 レースずつに切り分け(`solo`)、1 件だけの失敗はそのレースの失敗に数える。成功するとまとめに戻る。
 *  - 失敗(読み出しまたは変換)が連続 {@link ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT} ステップになったら、その晩は止めて通知する(`failures`)。
 *  - `capacity`: 変換の結果の D1 の大きさ(`meta.size_after`)が上限(400,000,000 バイト。取得の DO と同じ値)を超えた。次の晩の最初に大きさを読み直し、**超えている・読めないあいだは止まったまま**(通知は繰り返さない)。下回れば再開する。
 *  - `r2-fence`: R2 の Class B の柵に達した(一括の読み出しが `skipped`)。次の晩に 1 回確かめ、まだ柵なら止まったまま(通知は繰り返さない)。
 *  - 変換を拒否したレース(頭数の宣言と行数が合わない等)は**失敗に数えない**。理由の分類を数えるだけ(`rejectedByClass`)。
 *  - **通知は止まったときの最初の 1 回だけ**(成功するまで同じ理由では再送しない)。送信が失敗したら 10 分後に再送し、3 回で諦める(状態は変わらない)。
 *
 * ## D1 の行数の見積もり(`test/race-archive-runs-budget.integration.test.ts` がローカル D1 の `meta` で測る。48 レース・768 走・3 ステップの実測)
 *  - 書き込み: 1 レースあたり 走数(1 走 1 行。horse_runs は WITHOUT ROWID で副索引なし)+ 印 1 + 1 ステップあたり Class B の計数 1 = 実測 819 行(= 768 + 48 + 3)。書き直しは版が同じなら 0 行。
 *    1 晩の上限 L(既定 60,000)なら、変換できるのは約 L / 17 ≒ 3,529 レース(約 5.6 万走)。
 *  - 読み取り: 1 走あたり 約 3 行(新規の挿入の照合 1 + 書き直しの照合 約 2)+ 1 レースあたり 約 3(印)+ 目録の列挙 1 ステップ最大 100 行。実測 2,689 行(うち目録の列挙 232、horse_runs 2,307、印 144)。
 *    L = 60,000 の晩で約 20 万行(D1 の Free の 1 日 500 万行の約 3.9%)。目録の 1 周(約 1.7 万行)を 1 時間おきに見直しても 1 晩 約 21 万行を超えない。
 *
 * ## 状態(DO の SQLite)
 * `rr_meta`(キー・値)・`rr_fail`(失敗したレース)・`rr_reject`(拒否したレースの分類)。いずれも `WITHOUT ROWID`。**変わらない値は書かない**。
 * **起床の経路の SQL は、すべて主キーの SEARCH になる**(表の全部を読む SCAN・一時 B-tree の並べ替えを流さない。テストが `EXPLAIN QUERY PLAN` で固定する。#593 の事故を踏まえた決まり)。
 * 表の全体を数える SQL は状態の読み取り(`getStatus`。管理者の口)だけにある。
 * 目録の件数(総数・印の版ごと)は D1 から読む(`catalogCounts`。状態の読み取りのときだけ。目録の全件走査になるので管理者の口でだけ呼ぶ)。
 *
 * ## 例外を投げない
 * アラームの中の失敗は握って再試行する。ログは固定の分類名と数だけ(例外の文面・ページの本文は出さない)。
 */
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";
import { RESULT_RUN_VERSION } from "../../packages/core/src/scraper/race-record-to-runs";
import { nextArchiveWindowStart, inArchiveWindow } from "./race-archive-fetch-core";
import { CATALOG_PAGE_MAX, DB_SIZE_LIMIT_BYTES, READ_BATCH_MAX, type CatalogScope, type RaceArchiveCatalogEntry, type ReadRaceArchivesResult } from "./race-archive-repository";
import type { ConvertBatchResult, ConvertTarget } from "./race-archive-runs";
import type { SqlLike } from "./sql-like";
import { shouldRearm } from "./stale-alarm";

/** 変換の DO の固定名(単一インスタンス)。cron の `scheduled` と管理者の口が引く。 */
export const RACE_ARCHIVE_RUNS_NAME = "main";
/** 時間帯の開始(JST の 0 時からの分。含む)。1:00。 */
export const ARCHIVE_RUNS_WINDOW_START_MIN = 60;
/** 時間帯の終了(JST の 0 時からの分。含まない)。8:30。 */
export const ARCHIVE_RUNS_WINDOW_END_MIN = 8 * 60 + 30;
/** 1 晩の書き込み行数の既定の上限(ユーザーの決定。最初は 30,000 で始め、2026-11-09 に 60,000 へ上げた。#704)。 */
export const ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT = 60_000;
/** 1 晩の書き込み行数の上限の、上書きできる最大(これを超える値は無視して既定)。 */
export const ARCHIVE_RUNS_NIGHTLY_ROWS_MAX = 100_000;
/** 1 ステップで変換するレースの数の上限(一括の読み出しの上限 {@link READ_BATCH_MAX} の内側。R2 の get 20 + D1 の数文で、Free の 1 呼び出し 50 に収まる)。 */
export const ARCHIVE_RUNS_STEP_RACES = 20;
/** 目録を 1 回に読む行数(変換するのは、このうち未変換の先頭 {@link ARCHIVE_RUNS_STEP_RACES} 件)。 */
export const ARCHIVE_RUNS_PAGE_SIZE = 100;
/** 変換したステップのあと、次のステップまでの間隔。 */
export const ARCHIVE_RUNS_STEP_DELAY_MS = 1000;
/** 変換するものが無かった(読み飛ばしただけの)ステップのあと、次のステップまでの間隔。 */
export const ARCHIVE_RUNS_SCAN_DELAY_MS = 200;
/** 何も変換しなかった周のあと、見直すまでの間隔。 */
export const ARCHIVE_RUNS_IDLE_MS = 60 * 60_000;
/** 1 ステップの一括の読み出しが D1 に書く行数(`r2_ops` の Class B の計数 1 行)。1 晩の書き込み行数に数える。 */
export const ARCHIVE_RUNS_READ_COUNT_ROWS = 1;
/** 個別のレースを諦めるまでの晩数。 */
export const ARCHIVE_RUNS_MAX_NIGHTS = 3;
/** 連続でこのステップ数だけ失敗したら、その晩は止める。 */
export const ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT = 10;
/** アラームの中の失敗のあと、再試行する間隔。通知の再送の間隔も同じ。 */
export const ARCHIVE_RUNS_ERROR_RETRY_MS = 10 * 60_000;
/** 通知の送信を試す回数の上限。 */
export const ARCHIVE_RUNS_NOTICE_MAX_ATTEMPTS = 3;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** 取得を止める設定の判定(Worker の var `RACE_ARCHIVE_RUNS_NIGHTLY_LIMIT`)。**文字列 `"0"`(前後の空白は無視)だけ**が無効。 */
export function isArchiveRunsDisabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "0";
}

export type ArchiveRunsStopReason = "failures" | "capacity" | "r2-fence";

/** 通知する出来事。文面は `notify-embeds.ts` で組む。 */
export type RunsNotice =
  | { readonly kind: "failures"; readonly count: number; readonly at: number; readonly resumeAt: number }
  | { readonly kind: "capacity"; readonly dbSizeBytes: number | null; readonly at: number }
  | { readonly kind: "r2-fence"; readonly at: number; readonly resumeAt: number };

export interface ArchiveRunsOptions {
  readonly disabled?: boolean;
  /** 1 晩の書き込み行数の上限(下げる方向の上書き)。 */
  readonly nightlyRows?: number;
  readonly windowStartMin?: number;
  readonly windowEndMin?: number;
  readonly stepRaces?: number;
  readonly pageSize?: number;
  /** D1 の大きさの上限(バイト)。既定は取得の DO と同じ {@link DB_SIZE_LIMIT_BYTES}。 */
  readonly maxDbBytes?: number;
}

export interface ArchiveRunsDeps {
  /** DO の SQLite(`ctx.storage.sql`)。表 `rr_meta`・`rr_fail`・`rr_reject` を `CREATE TABLE IF NOT EXISTS` で作る。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly archive: {
    listCatalogPage(afterRaceId: string, limit: number, scope: CatalogScope): Promise<RaceArchiveCatalogEntry[]>;
    readRaceArchives(raceIds: readonly string[]): Promise<ReadRaceArchivesResult>;
  };
  /** 変換して書く(`convertRaceArchives`)。失敗は throw。 */
  readonly convert: (targets: readonly ConvertTarget[], now: Date) => Promise<ConvertBatchResult>;
  /** D1 の大きさ(`meta.size_after`)。読めなければ null。 */
  readonly dbSize: () => Promise<number | null>;
  /** 目録の件数(総数と、印の版ごと。印が NULL のものは `null` のキー)。状態の読み取りのときだけ呼ぶ。 */
  readonly catalogCounts: () => Promise<{ readonly total: number; readonly byVersion: Readonly<Record<string, number>> }>;
  readonly notify: (notice: RunsNotice) => Promise<void>;
  readonly log: (line: string, level: "info" | "error") => void;
}

export interface RaceArchiveRunsStatus {
  readonly state: "disabled" | "running" | "stopped";
  /** `active`・`outside-window`・`night-limit`・`caught-up`・`stopped`・`disabled` など。 */
  readonly waitReason: string;
  readonly stopReason: ArchiveRunsStopReason | null;
  readonly nextRunAt: number | null;
  readonly night: { readonly date: string | null; readonly rows: number; readonly races: number; readonly failed: number };
  readonly nightlyRowLimit: number;
  readonly cursor: string;
  /** 目録の総数と、印の版ごとの件数(印が無いものは `null` のキー)。 */
  readonly catalog: { readonly total: number; readonly byVersion: Readonly<Record<string, number>> };
  /** 失敗が続いていて、まだ試すレースの数。 */
  readonly failing: number;
  /** {@link ARCHIVE_RUNS_MAX_NIGHTS} 晩試して諦めたレースの数。 */
  readonly gaveUp: number;
  /** 変換を拒否したレースの、理由の分類ごとの数。 */
  readonly rejectedByClass: Readonly<Record<string, number>>;
  readonly totals: { readonly races: number; readonly rows: number };
  readonly dbSizeBytes: number | null;
  readonly lastStop: { readonly reason: ArchiveRunsStopReason; readonly at: number } | null;
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

/** 変換の拒否の理由(core の文面)を、状態に数える分類にする。文面そのものは状態に持たない。 */
export function classifyRejection(reason: string): string {
  if (reason.includes("合いません")) return "count-mismatch";
  if (reason.includes("読めません")) return "declared-unreadable";
  return "other";
}

export class RaceArchiveRunsCore {
  private readonly deps: ArchiveRunsDeps;
  private readonly disabled: boolean;
  private readonly nightlyRows: number;
  private readonly startMin: number;
  private readonly endMin: number;
  private readonly stepRaces: number;
  private readonly pageSize: number;
  private readonly maxDbBytes: number;

  constructor(deps: ArchiveRunsDeps, options: ArchiveRunsOptions = {}) {
    this.deps = deps;
    this.disabled = options.disabled === true;
    this.nightlyRows = options.nightlyRows !== undefined && Number.isInteger(options.nightlyRows) && options.nightlyRows >= 1 ? Math.min(options.nightlyRows, ARCHIVE_RUNS_NIGHTLY_ROWS_MAX) : ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT;
    this.startMin = options.windowStartMin ?? ARCHIVE_RUNS_WINDOW_START_MIN;
    this.endMin = options.windowEndMin ?? ARCHIVE_RUNS_WINDOW_END_MIN;
    this.stepRaces = Math.min(options.stepRaces ?? ARCHIVE_RUNS_STEP_RACES, READ_BATCH_MAX);
    this.pageSize = Math.min(options.pageSize ?? ARCHIVE_RUNS_PAGE_SIZE, CATALOG_PAGE_MAX);
    this.maxDbBytes = options.maxDbBytes ?? DB_SIZE_LIMIT_BYTES;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS rr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS rr_fail (race_id TEXT PRIMARY KEY, nights INTEGER NOT NULL, last_night TEXT NOT NULL, last_class TEXT NOT NULL) WITHOUT ROWID");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS rr_reject (race_id TEXT PRIMARY KEY, class TEXT NOT NULL) WITHOUT ROWID");
  }

  // ---- 状態の読み書き ----

  private readonly metaCache = new Map<string, string | null>();

  private metaGet(key: string): string | null {
    const cached = this.metaCache.get(key);
    if (cached !== undefined) return cached;
    const rows = this.deps.sql.exec("SELECT value FROM rr_meta WHERE key = ?", key).toArray() as { value: string }[];
    const value = rows[0]?.value ?? null;
    this.metaCache.set(key, value);
    return value;
  }

  /** 値が変わるときだけ書く(DO の SQLite の書き込み行数を減らす)。 */
  private metaSet(key: string, value: string): void {
    if (this.metaGet(key) === value) return;
    this.deps.sql.exec("INSERT INTO rr_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    this.metaCache.set(key, value);
  }

  private metaDelete(...keys: string[]): void {
    for (const key of keys) {
      if (this.metaGet(key) !== null) {
        this.deps.sql.exec("DELETE FROM rr_meta WHERE key = ?", key);
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

  // ---- アラーム ----

  private noticeRetryAt(): number | null {
    return this.metaGet("pending_notice") !== null ? this.metaNum("notice_retry_at") : null;
  }

  /** アラームを `at` に張る。通知の再送がそれより早ければ、再送の時刻に張る。 */
  private async arm(at: number | null): Promise<void> {
    const retry = this.noticeRetryAt();
    const target = at === null ? retry : retry !== null && retry < at ? retry : at;
    if (target !== null) await this.deps.setAlarm(target);
  }

  /** アラームが無ければ張る(cron の `scheduled` と状態の読み取りが呼ぶ)。 */
  async kick(): Promise<void> {
    if (this.disabled) return;
    const now = this.deps.now();
    if (!shouldRearm(await this.deps.getAlarm(), now, (iso) => this.deps.log(`race-archive-runs: stale alarm at=${iso} re-armed`, "info"))) return;
    await this.arm(nextArchiveWindowStart(now, this.startMin, this.endMin));
  }

  /** アラーム: 次のステップを 1 つ実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    if (this.disabled) return;
    try {
      await this.step();
    } catch (error) {
      this.deps.log(`race-archive-runs: step failed error=${errorKind(error)}`, "error");
      try {
        await this.deps.setAlarm(this.deps.now() + ARCHIVE_RUNS_ERROR_RETRY_MS);
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

  private stopReason(): ArchiveRunsStopReason | null {
    const m = this.metaGet("stop_reason");
    return m === "failures" || m === "capacity" || m === "r2-fence" ? m : null;
  }

  private async step(): Promise<void> {
    const now = this.deps.now();
    await this.flushNotice(now);
    if (!inArchiveWindow(now, this.startMin, this.endMin)) {
      this.setWait("outside-window");
      await this.arm(nextArchiveWindowStart(now, this.startMin, this.endMin));
      return;
    }
    const night = jstDate(now);
    this.rollover(night);

    // 止まっているとき: 同じ晩は動かさない。次の晩に、理由ごとに確かめ直して再開する。
    const stopped = this.stopReason();
    if (stopped !== null) {
      if (this.metaGet("stop_night") === night) {
        this.setWait("stopped");
        await this.arm(nextNightStart(now, this.startMin));
        return;
      }
      if (stopped === "capacity") {
        const size = await this.deps.dbSize();
        this.metaSet("stop_night", night);
        if (size === null || size > this.maxDbBytes) {
          this.metaSet("db_size", size === null ? "" : String(size));
          this.setWait("stopped");
          await this.arm(nextNightStart(now, this.startMin));
          return;
        }
        this.metaSet("db_size", String(size));
      }
      this.metaDelete("stop_reason", "stop_night");
    }

    if (this.metaNum("night_rows") >= this.nightlyRows) {
      this.setWait("night-limit");
      await this.arm(nextNightStart(now, this.startMin));
      return;
    }

    // 次の候補: 目録を主キー順に読み、未変換で、今夜まだ失敗していない・諦めていないものを選ぶ。
    const take = this.metaGet("solo") === "1" ? 1 : this.stepRaces;
    const cursor = this.metaGet("cursor") ?? "";
    const scope = this.scanScope();
    if (cursor === "") this.beginPass(scope);
    const page = await this.deps.archive.listCatalogPage(cursor, this.pageSize, scope);
    if (page.length === 0) {
      await this.endOfPass(now);
      return;
    }
    const unconverted = page.filter((e) => e.runsVersion === null || e.runsVersion < RESULT_RUN_VERSION);
    const blocked = this.blockedIds(
      unconverted.map((e) => e.raceId),
      night,
    );
    const candidates: RaceArchiveCatalogEntry[] = [];
    let lastScanned = cursor;
    let staleBlocked = 0;
    for (const e of page) {
      lastScanned = e.raceId;
      if (e.runsVersion !== null && e.runsVersion < RESULT_RUN_VERSION && blocked.has(e.raceId)) staleBlocked += 1;
      if ((e.runsVersion === null || e.runsVersion < RESULT_RUN_VERSION) && !blocked.has(e.raceId)) {
        candidates.push(e);
        if (candidates.length >= take) break;
      }
    }
    this.metaSet("cursor", lastScanned);
    if (staleBlocked > 0) this.metaSet("pass_stale_blocked", String(this.metaNum("pass_stale_blocked") + staleBlocked));
    if (candidates.length === 0) {
      this.setWait("active");
      await this.arm(now + ARCHIVE_RUNS_SCAN_DELAY_MS);
      return;
    }

    await this.convertStep(candidates, now, night, cursor);
  }

  /**
   * 目録の走査の範囲(Issue #613)。通常は未変換(印が NULL)だけを部分索引から読む(`pending`)。
   * ただし**この版({@link RESULT_RUN_VERSION})で、版の古い行(印が NULL でなく版より小さい)を見直す全走査をまだ完了していない**間は、全行を読む(`all`)。
   * 版の古い行が生まれるのは版を上げたときだけ(保存は印を NULL に戻す)なので、版ごとに 1 周の全走査を済ませれば、以後は `pending` で足りる。
   */
  private scanScope(): CatalogScope {
    return this.metaGet("stale_checked_version") === String(RESULT_RUN_VERSION) ? "pending" : "all";
  }

  /** 周の頭(カーソルが空)で呼ぶ。`all` の周は、先頭から始めた周であること(と版)を覚える。途中から再開した周は、完了の印を付けない。 */
  private beginPass(scope: CatalogScope): void {
    if (scope === "all") {
      this.metaSet("pass_all_version", String(RESULT_RUN_VERSION));
      this.metaSet("pass_stale_blocked", "0");
    } else {
      this.metaDelete("pass_all_version", "pass_stale_blocked");
    }
  }

  /** 版の古い行(印が NULL でない)の変換が失敗した。この周の全走査は完了にしない(同じ周のうちに、のちに blocked として読まれるとは限らないため)。 */
  private noteStaleLeft(entry: RaceArchiveCatalogEntry | undefined): void {
    if (entry !== undefined && entry.runsVersion !== null && entry.runsVersion < RESULT_RUN_VERSION) {
      this.metaSet("pass_stale_blocked", String(this.metaNum("pass_stale_blocked") + 1));
    }
  }

  /** 今夜もう失敗した、または諦めたレース(失敗の記録から)。 */
  private blockedIds(ids: readonly string[], night: string): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    const rows = this.deps.sql
      .exec(`SELECT race_id AS id, nights, last_night AS lastNight FROM rr_fail WHERE race_id IN (${ids.map(() => "?").join(", ")})`, ...ids)
      .toArray() as { id: string; nights: number; lastNight: string }[];
    for (const r of rows) {
      if (r.nights >= ARCHIVE_RUNS_MAX_NIGHTS || r.lastNight === night) out.add(r.id);
    }
    return out;
  }

  private async endOfPass(now: number): Promise<void> {
    this.metaSet("cursor", "");
    const converted = this.metaNum("pass_converted");
    this.metaSet("pass_converted", "0");
    // 先頭から読み切った全走査の周で、版の古い行が失敗・諦めで残っていなければ、この版の全走査は完了(以後は未変換だけを読む)。
    if (this.metaGet("pass_all_version") === String(RESULT_RUN_VERSION) && this.metaNum("pass_stale_blocked") === 0) {
      this.metaSet("stale_checked_version", String(RESULT_RUN_VERSION));
    }
    this.metaDelete("pass_all_version", "pass_stale_blocked");
    if (converted === 0) {
      this.setWait("caught-up");
      await this.arm(now + ARCHIVE_RUNS_IDLE_MS);
      return;
    }
    this.setWait("active");
    await this.arm(now + ARCHIVE_RUNS_SCAN_DELAY_MS);
  }

  private async convertStep(candidates: readonly RaceArchiveCatalogEntry[], now: number, night: string, cursorBefore: string): Promise<void> {
    const read = await this.deps.archive.readRaceArchives(candidates.map((c) => c.raceId));
    if (read.status === "skipped") {
      await this.stop("r2-fence", now, null);
      return;
    }
    const targets: ConvertTarget[] = [];
    let readFailures = 0;
    for (const c of candidates) {
      const item = read.items.find((i) => i.raceId === c.raceId);
      if (item === undefined || item.outcome.status !== "found") {
        readFailures += 1;
        this.recordFailure(c.raceId, night, item?.outcome.status === "missing" ? "r2-missing" : "r2-error");
        this.noteStaleLeft(c);
        continue;
      }
      targets.push({ raceId: c.raceId, rawBytes: c.rawBytes, parserVersion: c.parserVersion, record: item.outcome.archive.record });
    }
    if (readFailures > 0) this.metaSet("night_failed", String(this.metaNum("night_failed") + readFailures));

    if (targets.length === 0) {
      await this.afterStep(now, false, readFailures > 0);
      return;
    }
    let result: ConvertBatchResult;
    try {
      result = await this.deps.convert(targets, new Date(now));
    } catch (error) {
      this.deps.log(`race-archive-runs: convert failed class=convert-failed error=${errorKind(error)} races=${targets.length}`, "error");
      if (targets.length === 1) {
        this.recordFailure(targets[0]!.raceId, night, "convert-failed");
        this.noteStaleLeft(candidates.find((c) => c.raceId === targets[0]!.raceId));
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
    let converted = 0;
    let rows = 0;
    for (const o of result.outcomes) {
      if (o.status === "converted") {
        converted += 1;
        rows += o.runs;
      } else {
        this.deps.sql.exec("INSERT INTO rr_reject (race_id, class) VALUES (?, ?) ON CONFLICT(race_id) DO UPDATE SET class = excluded.class", o.raceId, classifyRejection(o.reason));
      }
    }
    this.clearFailures(result.outcomes.map((o) => o.raceId));
    this.metaSet("night_rows", String(this.metaNum("night_rows") + result.rowsWritten + ARCHIVE_RUNS_READ_COUNT_ROWS));
    this.metaSet("night_races", String(this.metaNum("night_races") + result.outcomes.length));
    this.metaSet("total_races", String(this.metaNum("total_races") + converted));
    this.metaSet("total_rows", String(this.metaNum("total_rows") + rows));
    this.metaSet("pass_converted", String(this.metaNum("pass_converted") + result.markedRaces));
    if (result.dbSizeBytes !== null) this.metaSet("db_size", String(result.dbSizeBytes));
    this.metaDelete("notified_reason");

    if (result.dbSizeBytes === null || result.dbSizeBytes > this.maxDbBytes) {
      await this.stop("capacity", now, result.dbSizeBytes);
      return;
    }
    await this.afterStep(now, true, readFailures > 0);
  }

  /** 1 ステップの終わり: 連続失敗を数え、次のアラームを張る。 */
  private async afterStep(now: number, converted: boolean, failed: boolean): Promise<void> {
    if (converted) {
      this.metaSet("consecutive", "0");
    } else if (failed) {
      const streak = this.metaNum("consecutive") + 1;
      this.metaSet("consecutive", String(streak));
      if (streak >= ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT) {
        await this.stop("failures", now, null, streak);
        return;
      }
    }
    this.setWait("active");
    await this.arm(now + ARCHIVE_RUNS_STEP_DELAY_MS);
  }

  private recordFailure(raceId: string, night: string, cls: string): void {
    this.deps.sql.exec(
      "INSERT INTO rr_fail (race_id, nights, last_night, last_class) VALUES (?, 1, ?, ?) ON CONFLICT(race_id) DO UPDATE SET nights = nights + 1, last_night = excluded.last_night, last_class = excluded.last_class",
      raceId,
      night,
      cls,
    );
  }

  /** 変換できた(または拒否で決着した)レースの失敗の記録を、1 文でまとめて消す(主キーの SEARCH。記録が無ければ 0 行の書き込み)。 */
  private clearFailures(raceIds: readonly string[]): void {
    if (raceIds.length > 0) {
      this.deps.sql.exec(`DELETE FROM rr_fail WHERE race_id IN (${raceIds.map(() => "?").join(", ")})`, ...raceIds);
    }
  }

  /** 止める。次の晩の開始に張る。通知は、この理由で前に通知していなければ 1 回だけ。 */
  private async stop(reason: ArchiveRunsStopReason, now: number, dbSizeBytes: number | null, count = 0): Promise<void> {
    const resumeAt = nextNightStart(now, this.startMin);
    this.metaSet("stop_reason", reason);
    this.metaSet("stop_night", jstDate(now));
    this.metaSet("last_stop", JSON.stringify({ reason, at: now }));
    this.setWait("stopped");
    this.deps.log(`race-archive-runs: stopped reason=${reason}`, "error");
    if (this.metaGet("notified_reason") !== reason) {
      this.metaSet("notified_reason", reason);
      const notice: RunsNotice = reason === "failures" ? { kind: "failures", count, at: now, resumeAt } : reason === "capacity" ? { kind: "capacity", dbSizeBytes, at: now } : { kind: "r2-fence", at: now, resumeAt };
      this.queueNotice(notice);
      await this.flushNotice(now);
    }
    await this.arm(resumeAt);
  }

  // ---- 通知 ----

  private queueNotice(notice: RunsNotice): void {
    this.metaSet("pending_notice", JSON.stringify(notice));
    this.metaSet("notice_attempts", "0");
    this.metaSet("notice_retry_at", "0");
  }

  private async flushNotice(now: number): Promise<void> {
    const raw = this.metaGet("pending_notice");
    if (raw === null || now < this.metaNum("notice_retry_at")) return;
    const attempts = this.metaNum("notice_attempts") + 1;
    try {
      await this.deps.notify(JSON.parse(raw) as RunsNotice);
      this.metaDelete("pending_notice", "notice_attempts", "notice_retry_at");
    } catch (error) {
      this.deps.log(`race-archive-runs: notify failed attempt=${attempts} error=${errorKind(error)}`, "error");
      if (attempts >= ARCHIVE_RUNS_NOTICE_MAX_ATTEMPTS) {
        this.metaDelete("pending_notice", "notice_attempts", "notice_retry_at");
      } else {
        this.metaSet("notice_attempts", String(attempts));
        this.metaSet("notice_retry_at", String(now + ARCHIVE_RUNS_ERROR_RETRY_MS));
      }
    }
  }

  // ---- 観測 ----

  /** 進捗の読み取り(状態は変えない)。目録の件数は D1 から読む(全件走査。管理者の口でだけ呼ぶ)。 */
  async getStatus(): Promise<RaceArchiveRunsStatus> {
    const rejected = this.deps.sql.exec("SELECT class AS cls, COUNT(*) AS n FROM rr_reject GROUP BY class").toArray() as { cls: string; n: number }[];
    const dbSize = this.metaGet("db_size");
    const lastStopRaw = this.metaGet("last_stop");
    const stopReason = this.stopReason();
    return {
      state: this.disabled ? "disabled" : stopReason !== null ? "stopped" : "running",
      waitReason: this.disabled ? "disabled" : (this.metaGet("wait_reason") ?? "none"),
      stopReason: this.disabled ? null : stopReason,
      nextRunAt: this.disabled ? null : await this.deps.getAlarm(),
      night: { date: this.metaGet("night_date"), rows: this.metaNum("night_rows"), races: this.metaNum("night_races"), failed: this.metaNum("night_failed") },
      nightlyRowLimit: this.nightlyRows,
      cursor: this.metaGet("cursor") ?? "",
      catalog: await this.deps.catalogCounts(),
      failing: this.count("SELECT COUNT(*) AS n FROM rr_fail WHERE nights < ?", ARCHIVE_RUNS_MAX_NIGHTS),
      gaveUp: this.count("SELECT COUNT(*) AS n FROM rr_fail WHERE nights >= ?", ARCHIVE_RUNS_MAX_NIGHTS),
      rejectedByClass: Object.fromEntries(rejected.map((r) => [r.cls, r.n])),
      totals: { races: this.metaNum("total_races"), rows: this.metaNum("total_rows") },
      dbSizeBytes: dbSize === null || dbSize === "" ? null : Number(dbSize),
      lastStop: lastStopRaw === null ? null : (JSON.parse(lastStopRaw) as RaceArchiveRunsStatus["lastStop"]),
    };
  }
}
