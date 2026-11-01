/**
 * 過去の結果の毎晩の取得(Issue #554〈#549-A3〉。親は #549)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。
 * 本物の `ctx.storage.sql`・時計・アラーム・gate・計画・保存・通知を配線するのは `race-archive-fetch-do.ts`(DO `RaceArchiveFetchDO`。#554 の A3-3)。
 * 構造は `result-backfill-core.ts`(結果の補完)を写した: 依存を引数で受け、状態は DO の SQLite(`CREATE TABLE IF NOT EXISTS` なので DO の migration は要らない)、
 * アラームの中の失敗は握って 10 分後に再試行する。
 *
 * ## 何をするか
 * 中央の過去 5 年(2021-11〜今月。{@link ARCHIVE_FROM_MONTH})の結果ページを、**カレンダー → 開催日の一覧 → 結果ページ**の順に、新しい月・新しい開催日から 1 件ずつ取り、
 * `buildRaceRecord` で読んで `saveRaceArchive`(R2 → D1 の目録)に渡す。取り終えた後は、新しい開催(今日より前の確定済みの開催日)を毎晩追いかける。地方は対象外。
 * 取得は gate(`NetkeibaGate`)の `fetchRaw` だけを通る(許可リスト・直列化・最小間隔 2 秒・ブレーカー)。**そのうえでこの取得はリクエストどうしを {@link ARCHIVE_REQUEST_INTERVAL_MS}(5 秒)以上あける**。
 *
 * ## いつ動くか(ユーザーの決定。#554)
 *  - **{@link ARCHIVE_NOT_BEFORE_MS}(2026-11-04 0:00 JST)より前には、gate にも計画にも触れない**(アラームをその時刻に張るだけ)。
 *  - **JST 0:00 以上 8:30 未満**だけ({@link ARCHIVE_WINDOW_START_MIN}〜{@link ARCHIVE_WINDOW_END_MIN})。発走前の分析(9:05 ごろから)と重ならないようにする。
 *  - **中央の開催日の、その日の朝は取らない**(本番の出馬表・オッズの取得を巻き込まないため)。判定は計画(`getPlanProgress` の中央の行。21:00 の cron が前の晩に立てる): {@link classifyCentralDay}。
 *    開催日 → 休む / 開催日ではない → 取る / **判定不能 → 休む**(10 分おきに引き直し、8:30 まで分からなければその晩は取らない)。カレンダーから集めた開催日(`ra_day`)に今日があれば、計画が何と言っても休む(**休む方向にだけ働く補助**)。
 *  - **今日より前の開催日だけ**取る(当日は結果が途中のことがあり、保存すると取り直さないため)。
 *  - 1 晩の件数の上限は置かない(既定)。下げる方向だけの上書き {@link ArchiveFetchOptions.nightlyLimit}(Worker の var)を用意する。
 *
 * ## gate を巻き込まない(本番の取得が同じ gate を使う)
 * 1 リクエストごとに、出す前に `gate.status()` を読む:
 *  1. ブレーカーが開いている(`blockedUntil`)→ 出さない。解除の 1 分後まで待つ(**自分の停止ではない**。通知もしない)。
 *  2. 拒否の連続回数が 1 以上で、最後の開始から 30 分以内 → 出さない(誰かが直前に拒否された。自分が 2 回目になってブレーカーを開かせない、解除後の最初の 1 回を担って再オープンさせない)。
 *     最後の開始から 30 分以上たっていれば古い拒否とみなして進む。
 *  3. 待ち(進行中 + 待ち)が 2 件以上 → 30 秒後に見直す。
 * **関所の拒否の数が古いまま残る経路(受け入れている)**: 自分が拒否されて止まったあと、関所の「拒否の連続回数」は 1 のまま残る。次の晩の最初のリクエスト(自動再開)の前に、最後の開始から 30 分以上たっているので「古い拒否」とみなして出し、
 * そこでまた拒否されると、連続回数が 2 になって関所のブレーカーが 30 分開く。本番の取得(出馬表・オッズ・分析)は 9:05 以降で、この取得の時間帯(0:00〜8:30)と重ならないので、巻き込まれるのは夜間の補完くらいで、受け入れる。
 * 出したあとの応答が **HTTP 400・403・429**(`bad-response` に付く受信済みのステータスも同じ)なら、**その場で止める**({@link stopRefused})。再試行しない。
 *
 * ## 止まり方(状態 {@link ArchiveState})
 *  - `night-stopped`: 拒否された(1 回目)・R2 の柵。**次の晩の 0:00 に自動で再開する**。拒否は自動再開の権利を 1 度使う。柵は権利を使わない。
 *    柵は月単位なので、解けるまで毎晩 1 リクエストを出して確かめる(保存が `skipped` で戻り、また止まる)。**通知は止まった最初の 1 回だけ**(保存に成功すると、次の柵でまた 1 回送る)。
 *  - `manual-stopped`: 自動で再開したあとにまた拒否された。**手で再開するまで動かさない**({@link RaceArchiveFetchCore.resume})。
 *  - `capacity-stopped`: D1 が 400MB を超えた・大きさが読めない(`saveRaceArchive` の `skipped`)。手で再開するまで動かさない。
 *  - 拒否以外の失敗のうち 5xx・network・timeout・bad-response・保存の例外・読み取りの例外(`process-error`)が**その晩に連続 {@link ARCHIVE_CONSECUTIVE_FAILURE_LIMIT} 件**(9 件では止まらず、10 件で止まる)になったら、その晩だけ止めて通知する
 *    (状態は `running` のまま。止められたとは数えず、次の晩は普通に動く)。**404・検査の不合格・それ以外の 4xx は数えない**(古いページが 404 だらけでも、1 晩 10 件で止まらない。連続回数を増やしも戻しもしない)。
 *  - 自動再開の権利は、**再開したあとの最初のリクエストを出すときに使い**、**その晩を拒否なしで走り切ったら戻る**(別の機会の停止でもう 1 度自動で再開する。オーケストレーターの判断)。
 *    再開した晩が開催日の朝などで 1 件も取らなかったときは、権利は使われないまま、次に取った晩が「再開した晩」になる。手で再開したときも戻す。
 * 通知({@link ArchiveNotice})は状態を書いたあとに送る。送信が失敗したら 10 分後に再送し、3 回で諦める(状態は変わらない)。
 *
 * ## 個別のレース・日・月の失敗
 *  - 404・その他の HTTP エラー・検査の不合格(0 バイト・文字化け・頭数と行数の不一致・表なし)・保存の例外: **その晩はもう取らず**(他へ進む)、**3 晩**試して駄目なら諦める(`dead`)。
 *  - `buildRaceRecord` が読めないと言った結果(結果未確定・構造異常など): **記録したうえで以後は取らない**(`skipped`。分類は {@link ArchiveStatus.skippedByClass})。
 *  - 目録(`race_archive`)にあるレースは取らない(`done`・`existing`)。
 *
 * ## 状態(DO の SQLite)
 * `ra_meta`(キー・値)・`ra_month`・`ra_day`・`ra_race`(いずれも `WITHOUT ROWID`。主キーの索引を別に持たず、1 行の書き込みが 1 行で済む)。**変わらない値は書かない**(`metaSet` は値が変わるときだけ書く。DO の SQLite の書き込み行数を減らすため)。カレンダー・一覧のページは保存しない(待ち行列が SQLite に残るので、DO が作り直されても取り直さない)。
 * カレンダーは毎晩、今月と先月を取り直す(新しい開催日を足す)。それ以前の月は 1 回取れば終わり。
 *
 * ## 例外を投げない
 * アラームの中の失敗は握って、10 分後に再試行する。ログは固定の分類名と数だけ(例外の文面・ページの本文は出さない)。
 */
import { JST_OFFSET_MS, nextJstMidnight } from "../../packages/core/src/common/jst";
import { historyCalendarUrl, historyListUrl, parseCalendarKaisaiDates, parseListRaceIds, validateHistoryPage, type HistoryStage } from "../../packages/core/src/scraper/history-pages";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { buildRaceRecord, type BuildResult } from "../../packages/core/src/scraper/race-record";
import { raceResultUrl } from "../../packages/core/src/scraper/urls";
import { jstKaisaiDate } from "./auto-run-plan";
import type { GateResult } from "./gate-core";
import type { RaceArchiveCatalogEntry, SaveRaceArchiveResult } from "./race-archive-repository";
import type { RaceArchiveFetchStatus } from "./race-archive-fetch-types";
import type { SqlLike } from "./sql-like";

/** 過去の結果の取得の DO(`RaceArchiveFetchDO`)の固定名(単一インスタンス)。cron の `scheduled` と管理者の口(`/api/race-archive`)が引く。 */
export const RACE_ARCHIVE_FETCH_NAME = "main";
/** 1 晩の件数の上書き(Worker の var `RACE_ARCHIVE_NIGHTLY_LIMIT`)の上限。これを超える値は無視する(事実上の上限なし)。 */
export const ARCHIVE_NIGHTLY_LIMIT_MAX = 100_000;

/**
 * 取得を止める設定の判定(Worker の var `RACE_ARCHIVE_NIGHTLY_LIMIT`。★binding の名前〈`RACE_ARCHIVE_FETCH`〉とは別の名前にする。同じ名前の var は binding と衝突する)。**文字列 `"0"`(前後の空白は無視)だけ**が「無効」。それ以外(未設定・空・数でない値・`"00"` など)は無効にしない
 * (誤記で止まったまま気づかない、または誤記で意図せず切り替わる、のどちらも避けるため、完全一致にする。`isBackfillDisabled` と同じ流儀)。
 */
export function isArchiveFetchDisabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "0";
}

/** 取得を始める時刻(2026-11-04 0:00 JST = 2026-11-03T15:00:00Z)。これより前には gate にも計画にも触れない(ユーザーの決定)。 */
export const ARCHIVE_NOT_BEFORE_MS = Date.UTC(2026, 10, 3, 15, 0, 0);
/** 時間帯の開始(JST の 0 時からの分。含む)。 */
export const ARCHIVE_WINDOW_START_MIN = 0;
/** 時間帯の終了(JST の 0 時からの分。含まない)。8:30。 */
export const ARCHIVE_WINDOW_END_MIN = 8 * 60 + 30;
/** リクエストどうしの最低間隔(ミリ秒。開始から開始まで)。gate の 2 秒に加えて、この取得はさらにあける(ユーザーの決定)。 */
export const ARCHIVE_REQUEST_INTERVAL_MS = 5000;
/** 取る範囲の最初の月(中央の過去 5 年。#532)。 */
export const ARCHIVE_FROM_MONTH = "2021-11";
/** gate の待ち(進行中 + 待ち)がこの数以上なら出さない。 */
export const ARCHIVE_GATE_BUSY_PENDING = 2;
/** gate が混んでいるとき、見直す間隔。 */
export const ARCHIVE_GATE_BUSY_DELAY_MS = 30_000;
/** 拒否の連続回数が 1 以上のとき、「直前」とみなす期間(最後の開始からこの間)。 */
export const ARCHIVE_GATE_REFUSAL_RECENT_MS = 30 * 60_000;
/** ブレーカーの解除のあと、少し待つ時間。 */
export const ARCHIVE_BREAKER_MARGIN_MS = 60_000;
/** gate の待ち行列が満杯のとき、見直す間隔。 */
export const ARCHIVE_QUEUE_FULL_DELAY_MS = 60_000;
/** 開催日の判定が不能なとき、引き直す間隔。 */
export const ARCHIVE_PLAN_RECHECK_MS = 10 * 60_000;
/** アラームの中の失敗(D1・RPC)のあと、再試行する間隔。通知の再送の間隔も同じ。 */
export const ARCHIVE_ERROR_RETRY_MS = 10 * 60_000;
/** その晩に連続でこの件数だけ失敗(拒否以外)したら、その晩は止める。 */
export const ARCHIVE_CONSECUTIVE_FAILURE_LIMIT = 10;
/** 個別のレース・日・月を諦めるまでの晩数。 */
export const ARCHIVE_MAX_NIGHTS = 3;
/** 通知の送信を試す回数の上限。 */
export const ARCHIVE_NOTICE_MAX_ATTEMPTS = 3;
/** gate への 1 回の呼び出しを待つ上限(`GATE_FETCH_TIMEOUT_MS` と同じ)。 */
export const ARCHIVE_FETCH_TIMEOUT_MS = 60_000;
/** 1 ステップの中で、目録にあるレースを飛ばして進む回数の上限(使い切ったら次のステップに続ける)。 */
const MAX_SKIPS_PER_STEP = 200;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** 止められた(アクセス制限の疑い)とみなす HTTP ステータス。 */
const RESTRICTED_STATUSES: ReadonlySet<number> = new Set([400, 403, 429]);

export type ArchiveState = "disabled" | "running" | "night-stopped" | "manual-stopped" | "capacity-stopped";

export interface ArchiveFetchOptions {
  /** 止める(`kick` はアラームを張らず、アラームが起きても何もしない)。状態は `disabled`。smoke・CI で netkeiba に出ないことを保証する、または利用者が止めるため。 */
  readonly disabled?: boolean;
  /** 1 晩のリクエスト数の上限(下げる方向の上書き)。省略は上限なし。 */
  readonly nightlyLimit?: number;
  readonly notBeforeMs?: number;
  readonly windowStartMin?: number;
  readonly windowEndMin?: number;
  readonly intervalMs?: number;
  /** 取る範囲の最初の月(`YYYY-MM`)。 */
  readonly fromMonth?: string;
  readonly fetchTimeoutMs?: number;
}

/** `RaceDay` の `getPlanProgress()` のうち、開催日の判定が使う部分。 */
export interface PlanProgressLike {
  readonly stage: string;
  readonly venues: readonly { readonly venue: string; readonly state: string; readonly listed: number | null }[];
}

/** gate の `status()` のうち、使う部分。 */
export interface ArchiveGateStatus {
  readonly blockedUntil: number | null;
  readonly consecutiveRefusals: number;
  readonly lastStartAt: number | null;
  readonly pending: number;
}

/** 通知する出来事。文面は DO 側(`notify-embeds.ts`)で組む。 */
export type ArchiveNotice =
  | {
      readonly kind: "refused";
      readonly httpStatus: number;
      readonly stage: HistoryStage;
      readonly at: number;
      /** 次の晩に自動で再開するか(false = 手で再開するまで動かさない)。 */
      readonly willAutoResume: boolean;
      readonly resumeAt: number | null;
      readonly nightSaved: number;
      readonly totalDone: number;
    }
  | { readonly kind: "capacity"; readonly reason: "db-size" | "db-size-unknown"; readonly dbSizeBytes: number | null; readonly at: number; readonly totalDone: number }
  | { readonly kind: "r2-fence"; readonly at: number; readonly resumeAt: number }
  | { readonly kind: "failures"; readonly count: number; readonly lastClass: string; readonly at: number; readonly resumeAt: number };

export interface RaceArchiveFetchDeps {
  /** DO の SQLite(`ctx.storage.sql`)。表 `ra_meta`・`ra_month`・`ra_day`・`ra_race` を `CREATE TABLE IF NOT EXISTS` で作る。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  /** netkeiba への取得の出口(NetkeibaGate)の、使う部分。 */
  readonly gate: {
    status(): Promise<ArchiveGateStatus>;
    fetchRaw(url: string): Promise<GateResult>;
  };
  /** 開催日の計画の読み取り(その日の `RaceDay` の `getPlanProgress`)。失敗は throw(判定不能として扱う)。 */
  readonly planProgress: (kaisaiDate: string) => Promise<PlanProgressLike>;
  /** 保存と目録の読み取り(`D1RaceArchiveStore`)。 */
  readonly archive: {
    saveRaceArchive(input: { readonly record: Extract<BuildResult, { ok: true }>["record"]; readonly html: string }): Promise<SaveRaceArchiveResult>;
    getCatalogEntry(raceId: string): Promise<RaceArchiveCatalogEntry | null>;
  };
  /** 通知(Discord)。失敗は throw(10 分後に再送、3 回で諦める)。 */
  readonly notify: (notice: ArchiveNotice) => Promise<void>;
  readonly log: (line: string, level: "info" | "error") => void;
  /** 結果ページの読み取り。省略は `buildRaceRecord`(テストが差し替える)。 */
  readonly buildRecord?: (html: string, raceId: string, kind: "central") => BuildResult;
  /** カレンダーの開催日の抽出・一覧の race_id の抽出。省略は core の関数(テストが、想定外の例外を投げる読み取りに差し替える)。 */
  readonly parseCalendarDates?: (html: string, month: string) => string[];
  readonly parseListIds?: (html: string) => string[];
}

export type CentralDayKind = "kaisai" | "not-kaisai" | "unknown";

/**
 * 計画の中央の行から、その日が中央の開催日かを決める。中央の一覧が取れて(`state=ok`)1 件以上 → 開催日 / 取れて 0 件 → 開催日ではない /
 * それ以外(取得の失敗・pending・`listed` が NULL〈救済で戻した〉・中央の行がない)→ 判定不能。
 */
export function classifyCentralDay(progress: PlanProgressLike): CentralDayKind {
  const central = progress.venues.find((v) => v.venue === "central");
  if (central === undefined || central.state !== "ok" || central.listed === null) {
    return "unknown";
  }
  return central.listed > 0 ? "kaisai" : "not-kaisai";
}

function msOfJstDay(ms: number): number {
  return (((ms + JST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

/** 時間帯の中か(JST の 0 時からの分で、開始を含み終了を含まない)。 */
export function inArchiveWindow(ms: number, startMin: number, endMin: number): boolean {
  const t = msOfJstDay(ms);
  return t >= startMin * MIN_MS && t < endMin * MIN_MS;
}

/** いま以降で最初に時間帯に入る時刻(時間帯の中ならいま)。 */
export function nextArchiveWindowStart(ms: number, startMin: number, endMin: number): number {
  if (inArchiveWindow(ms, startMin, endMin)) {
    return ms;
  }
  const t = msOfJstDay(ms);
  const midnight = ms - t;
  return t < startMin * MIN_MS ? midnight + startMin * MIN_MS : midnight + DAY_MS + startMin * MIN_MS;
}

/** 次の晩(次の JST 0 時)の時間帯の開始。 */
function nextNightStart(ms: number, startMin: number): number {
  return nextJstMidnight(ms) + startMin * MIN_MS;
}

/** `YYYY-MM` の列(両端を含む)。 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** `YYYYMMDD` → `YYYY-MM`。 */
const monthOfDate = (date: string): string => `${date.slice(0, 4)}-${date.slice(4, 6)}`;

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Error" : "non-error";
}

/** 「その晩に連続 {@link ARCHIVE_CONSECUTIVE_FAILURE_LIMIT} 件」の失敗に数える分類か。 */
function countsTowardPause(cls: string): boolean {
  return /^http-5\d\d$/.test(cls) || cls === "network-error" || cls === "timeout" || cls === "bad-response" || cls === "save-failed" || cls === "process-error";
}

type Work =
  | { readonly kind: "month"; readonly id: string }
  | { readonly kind: "day"; readonly id: string }
  | { readonly kind: "race"; readonly id: string; readonly date: string };

const STAGE_OF: Record<Work["kind"], HistoryStage> = { month: "calendar", day: "list", race: "result" };

export class RaceArchiveFetchCore {
  private readonly deps: RaceArchiveFetchDeps;
  private readonly disabled: boolean;
  private readonly nightlyLimit: number | null;
  private readonly notBefore: number;
  private readonly startMin: number;
  private readonly endMin: number;
  private readonly intervalMs: number;
  private readonly fromMonth: string;
  private readonly fetchTimeoutMs: number;

  constructor(deps: RaceArchiveFetchDeps, options: ArchiveFetchOptions = {}) {
    this.deps = deps;
    this.disabled = options.disabled === true;
    this.nightlyLimit = options.nightlyLimit ?? null;
    this.notBefore = options.notBeforeMs ?? ARCHIVE_NOT_BEFORE_MS;
    this.startMin = options.windowStartMin ?? ARCHIVE_WINDOW_START_MIN;
    this.endMin = options.windowEndMin ?? ARCHIVE_WINDOW_END_MIN;
    this.intervalMs = options.intervalMs ?? ARCHIVE_REQUEST_INTERVAL_MS;
    this.fromMonth = options.fromMonth ?? ARCHIVE_FROM_MONTH;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? ARCHIVE_FETCH_TIMEOUT_MS;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS ra_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    deps.sql.exec(
      `CREATE TABLE IF NOT EXISTS ra_month (
         month TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', fetched_on TEXT, nights INTEGER NOT NULL DEFAULT 0, last_night TEXT, last_class TEXT) WITHOUT ROWID`,
    );
    deps.sql.exec(
      `CREATE TABLE IF NOT EXISTS ra_day (
         date TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', nights INTEGER NOT NULL DEFAULT 0, last_night TEXT, last_class TEXT) WITHOUT ROWID`,
    );
    deps.sql.exec(
      `CREATE TABLE IF NOT EXISTS ra_race (
         race_id TEXT PRIMARY KEY, date TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', nights INTEGER NOT NULL DEFAULT 0, last_night TEXT, last_class TEXT) WITHOUT ROWID`,
    );
  }

  // ---- 状態の読み書き ----

  /** ra_meta の読み出しの控え(このインスタンスだけが書くので、書いたときに更新する)。値が無いキーは null。 */
  private readonly metaCache = new Map<string, string | null>();

  private metaGet(key: string): string | null {
    const cached = this.metaCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const rows = this.deps.sql.exec("SELECT value FROM ra_meta WHERE key = ?", key).toArray() as { value: string }[];
    const value = rows[0]?.value ?? null;
    this.metaCache.set(key, value);
    return value;
  }

  /** 値が変わるときだけ書く(DO の SQLite の書き込み行数を減らす。1 晩 6,000 件を超える取得で、変わらない値を毎回書かない)。 */
  private metaSet(key: string, value: string): void {
    if (this.metaGet(key) === value) {
      return;
    }
    this.deps.sql.exec("INSERT INTO ra_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    this.metaCache.set(key, value);
  }

  private metaDelete(...keys: string[]): void {
    for (const key of keys) {
      if (this.metaGet(key) !== null) {
        this.deps.sql.exec("DELETE FROM ra_meta WHERE key = ?", key);
        this.metaCache.set(key, null);
      }
    }
  }

  private metaNum(key: string, fallback = 0): number {
    const raw = this.metaGet(key);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private mode(): Exclude<ArchiveState, "disabled"> {
    const m = this.metaGet("mode");
    return m === "night-stopped" || m === "manual-stopped" || m === "capacity-stopped" ? m : "running";
  }

  private count(sql: string, ...binds: unknown[]): number {
    return ((this.deps.sql.exec(sql, ...binds).toArray() as { n: number }[])[0]?.n ?? 0) as number;
  }

  // ---- アラーム ----

  /** 通知の再送が待っていれば、その時刻。 */
  private noticeRetryAt(): number | null {
    return this.metaGet("pending_notice") !== null ? this.metaNum("notice_retry_at") : null;
  }

  /** アラームを `at` に張る。通知の再送がそれより早ければ、再送の時刻に張る。`at` が null なら再送のためだけに張る(無ければ張らない)。 */
  private async arm(at: number | null): Promise<void> {
    const retry = this.noticeRetryAt();
    const target = at === null ? retry : retry !== null && retry < at ? retry : at;
    if (target !== null) {
      await this.deps.setAlarm(target);
    }
  }

  /** 次に動いてよい時刻(開始時刻の後の、時間帯の中)。 */
  private runAt(now: number): number {
    return nextArchiveWindowStart(Math.max(now, this.notBefore), this.startMin, this.endMin);
  }

  private setWait(reason: string): void {
    this.metaSet("wait_reason", reason);
  }

  /** アラームが無ければ張る(cron の `scheduled` と状態の読み取りが呼ぶ)。 */
  async kick(): Promise<void> {
    if (this.disabled || (await this.deps.getAlarm()) !== null) {
      return;
    }
    const now = this.deps.now();
    switch (this.mode()) {
      case "manual-stopped":
      case "capacity-stopped":
        await this.arm(null);
        return;
      case "night-stopped":
        await this.arm(Math.max(this.metaNum("resume_at"), this.runAt(now)));
        return;
      default:
        await this.arm(this.runAt(now));
    }
  }

  /** 手で再開する(止まっていなければ何もしない)。自動再開の権利も戻す。 */
  async resume(): Promise<{ readonly resumed: boolean; readonly previous: ArchiveState }> {
    if (this.disabled) {
      return { resumed: false, previous: "disabled" };
    }
    const previous = this.mode();
    if (previous === "running") {
      return { resumed: false, previous };
    }
    this.metaSet("mode", "running");
    this.metaSet("resume_at", "0");
    this.metaSet("auto_resume_used", "0");
    this.metaSet("resumed_night", "");
    this.metaSet("resume_armed", "0");
    this.metaSet("fence_notified", "0");
    this.deps.log(`race-archive: resume from=${previous}`, "info");
    await this.deps.setAlarm(this.runAt(this.deps.now()));
    return { resumed: true, previous };
  }

  // ---- 1 ステップ ----

  /** アラーム: 次のステップを 1 つ実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    if (this.disabled) {
      return;
    }
    try {
      await this.step();
    } catch (error) {
      this.deps.log(`race-archive: step failed error=${errorKind(error)}`, "error");
      try {
        await this.deps.setAlarm(this.deps.now() + ARCHIVE_ERROR_RETRY_MS);
      } catch {
        // アラームを張れなければ、cron の kick が張り直す。
      }
    }
  }

  private async step(): Promise<void> {
    const now = this.deps.now();
    if (now < this.notBefore) {
      this.setWait("before-start");
      await this.deps.setAlarm(this.notBefore);
      return;
    }
    await this.flushNotice(now);
    const night = jstKaisaiDate(now);
    this.rollover(night);

    const mode = this.mode();
    if (mode === "manual-stopped" || mode === "capacity-stopped") {
      this.setWait("stopped");
      await this.arm(null);
      return;
    }
    if (mode === "night-stopped") {
      const resumeAt = this.metaNum("resume_at");
      if (now < resumeAt) {
        this.setWait("stopped-until-next-night");
        await this.arm(resumeAt);
        return;
      }
      if (this.metaGet("stop_kind") === "refused") {
        // 権利を使うのは、再開したあとに**最初のリクエストを出すとき**(execute)。再開した晩が開催日の朝などで 1 件も取らなかったときに、権利が戻らなくなるのを避ける。
        this.metaSet("resume_armed", "1");
      }
      this.metaSet("mode", "running");
      this.deps.log(`race-archive: auto-resume night=${night}`, "info");
    }

    if (!inArchiveWindow(now, this.startMin, this.endMin)) {
      this.setWait("outside-window");
      await this.arm(this.runAt(now));
      return;
    }
    if (this.metaGet("paused_night") === night) {
      this.setWait("paused-failures");
      await this.arm(nextNightStart(now, this.startMin));
      return;
    }

    const rest = await this.restDecision(now, night);
    if (rest === "kaisai") {
      this.setWait("kaisai-day");
      await this.arm(nextNightStart(now, this.startMin));
      return;
    }
    if (rest === "unknown") {
      this.setWait("day-undetermined");
      await this.arm(nextArchiveWindowStart(now + ARCHIVE_PLAN_RECHECK_MS, this.startMin, this.endMin));
      return;
    }

    if (this.nightlyLimit !== null && this.metaNum("night_requests") >= this.nightlyLimit) {
      this.setWait("night-limit");
      await this.arm(nextNightStart(now, this.startMin));
      return;
    }
    const lastReqAt = this.metaNum("last_req_at", Number.NEGATIVE_INFINITY);
    if (now - lastReqAt < this.intervalMs) {
      this.setWait("interval");
      await this.arm(lastReqAt + this.intervalMs);
      return;
    }

    const gate = await this.deps.gate.status();
    if (gate.blockedUntil !== null) {
      this.setWait("gate-breaker");
      await this.arm(gate.blockedUntil + ARCHIVE_BREAKER_MARGIN_MS);
      return;
    }
    if (gate.consecutiveRefusals >= 1 && gate.lastStartAt !== null && now - gate.lastStartAt < ARCHIVE_GATE_REFUSAL_RECENT_MS) {
      this.setWait("gate-refusing");
      await this.arm(gate.lastStartAt + ARCHIVE_GATE_REFUSAL_RECENT_MS);
      return;
    }
    if (gate.pending >= ARCHIVE_GATE_BUSY_PENDING) {
      this.setWait("gate-busy");
      await this.arm(now + ARCHIVE_GATE_BUSY_DELAY_MS);
      return;
    }

    this.seedMonths(night);
    for (let skips = 0; skips <= MAX_SKIPS_PER_STEP; skips += 1) {
      const work = this.nextWork(night);
      if (work === null) {
        this.setWait("caught-up");
        await this.arm(nextNightStart(now, this.startMin));
        return;
      }
      if (work.kind === "race") {
        const entry = await this.deps.archive.getCatalogEntry(work.id);
        if (entry !== null) {
          this.deps.sql.exec("UPDATE ra_race SET status = 'done', last_class = 'existing' WHERE race_id = ?", work.id);
          this.closeDayIfDone(work.date);
          continue;
        }
      }
      await this.execute(work, night);
      return;
    }
    await this.arm(now);
  }

  /** 夜が替わったときの繰り越し: 再開した晩を拒否なしで走り切っていれば自動再開の権利を戻し、その晩の数を 0 にする。 */
  private rollover(night: string): void {
    const previous = this.metaGet("night_date");
    if (previous === night) {
      return;
    }
    if (previous !== null && this.mode() === "running" && this.metaGet("resumed_night") === previous && this.metaNum("night_requests") >= 1) {
      this.metaSet("auto_resume_used", "0");
      this.metaSet("resumed_night", "");
    }
    this.metaSet("night_date", night);
    this.metaSet("night_requests", "0");
    this.metaSet("night_saved", "0");
    this.metaSet("night_failed", "0");
    this.metaSet("fail_streak", "0");
  }

  /** その晩、取ってよいか(夜ごとに 1 回判定してその晩は使い回す。判定不能は 10 分おきに引き直す)。 */
  private async restDecision(now: number, night: string): Promise<"go" | "kaisai" | "unknown"> {
    if (this.metaGet("rest_date") === night) {
      const cached = this.metaGet("rest_result");
      if (cached === "kaisai") return "kaisai";
      if (cached === "not-kaisai") return "go";
      if (now < this.metaNum("rest_retry_at")) return "unknown";
    }
    let kind: CentralDayKind;
    try {
      kind = classifyCentralDay(await this.deps.planProgress(night));
    } catch (error) {
      this.deps.log(`race-archive: plan-probe failed night=${night} error=${errorKind(error)}`, "error");
      kind = "unknown";
    }
    // カレンダーで集めた開催日に今日があれば、計画が何と言っても休む(休む方向だけの補助)。
    if (kind !== "kaisai" && this.count("SELECT COUNT(*) AS n FROM ra_day WHERE date = ?", night) > 0) {
      kind = "kaisai";
    }
    this.metaSet("rest_date", night);
    this.metaSet("rest_result", kind);
    this.metaSet("rest_retry_at", String(now + ARCHIVE_PLAN_RECHECK_MS));
    return kind === "not-kaisai" ? "go" : kind;
  }

  private seedMonths(night: string): void {
    if (this.metaGet("months_seeded") === night) {
      return;
    }
    for (const month of monthsBetween(this.fromMonth, monthOfDate(night))) {
      this.deps.sql.exec("INSERT OR IGNORE INTO ra_month (month) VALUES (?)", month);
    }
    this.metaSet("months_seeded", night);
  }

  /** 次にやること: 月(カレンダー)→ レース(結果)→ 日(一覧)の順。いずれも新しいものから。その晩に試して駄目だったものは除く。 */
  private nextWork(night: string): Work | null {
    const cur = monthOfDate(night);
    const prev = previousMonth(cur);
    const month = (
      this.deps.sql
        .exec(
          `SELECT month FROM ra_month
           WHERE COALESCE(last_night, '') <> ? AND status <> 'dead' AND (status = 'pending' OR (month IN (?, ?) AND COALESCE(fetched_on, '') <> ?))
           ORDER BY month DESC LIMIT 1`,
          night,
          cur,
          prev,
          night,
        )
        .toArray() as { month: string }[]
    )[0];
    if (month !== undefined) {
      return { kind: "month", id: month.month };
    }
    const race = (
      this.deps.sql
        .exec("SELECT race_id, date FROM ra_race WHERE status = 'pending' AND date < ? AND COALESCE(last_night, '') <> ? ORDER BY date DESC, seq ASC LIMIT 1", night, night)
        .toArray() as { race_id: string; date: string }[]
    )[0];
    if (race !== undefined) {
      return { kind: "race", id: race.race_id, date: race.date };
    }
    const day = (
      this.deps.sql
        .exec("SELECT date FROM ra_day WHERE status = 'pending' AND date < ? AND COALESCE(last_night, '') <> ? ORDER BY date DESC LIMIT 1", night, night)
        .toArray() as { date: string }[]
    )[0];
    return day === undefined ? null : { kind: "day", id: day.date };
  }

  private urlOf(work: Work): string {
    switch (work.kind) {
      case "month":
        return historyCalendarUrl("central", work.id);
      case "day":
        return historyListUrl("central", work.id);
      default:
        return raceResultUrl(parseRaceId(work.id));
    }
  }

  private async fetchWithTimeout(url: string): Promise<GateResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GateResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "refused", reason: "timeout", message: "gate の呼び出しが時間内に終わりませんでした" }), this.fetchTimeoutMs);
    });
    try {
      return await Promise.race([this.deps.gate.fetchRaw(url), timeout]);
    } catch {
      return { kind: "refused", reason: "network-error", message: "gate の呼び出しに失敗しました" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 1 リクエストを出して、結果を処理する。 */
  private async execute(work: Work, night: string): Promise<void> {
    let url: string;
    try {
      url = this.urlOf(work);
    } catch (error) {
      // 不正な ID(`parseRaceId` が投げる等)。リクエストは出さず、その晩はもう取らない。
      this.deps.log(`race-archive: url failed stage=${STAGE_OF[work.kind]} error=${errorKind(error)}`, "error");
      if (!(await this.failed(work, night, "process-error", this.deps.now()))) {
        await this.arm(this.deps.now());
      }
      return;
    }
    const startedAt = this.deps.now();
    this.metaSet("last_req_at", String(startedAt));
    this.setWait("active");
    const result = await this.fetchWithTimeout(url);
    const after = Math.max(this.deps.now(), startedAt);
    const next = Math.max(after, startedAt + this.intervalMs);

    if (result.kind === "refused") {
      if (result.reason === "blocked") {
        this.setWait("gate-breaker");
        await this.arm((result.blockedUntil ?? after + 5 * MIN_MS) + ARCHIVE_BREAKER_MARGIN_MS);
        return;
      }
      if (result.reason === "queue-full") {
        this.setWait("gate-busy");
        await this.arm(after + ARCHIVE_QUEUE_FULL_DELAY_MS);
        return;
      }
      if (result.reason === "disallowed-url") {
        // 実装の誤り(許可リスト外の URL を組み立てた)。その晩は止める。
        this.deps.log(`race-archive: disallowed-url stage=${STAGE_OF[work.kind]}`, "error");
        this.metaSet("paused_night", night);
        await this.arm(nextNightStart(after, this.startMin));
        return;
      }
    }
    this.bump("night_requests");
    if (this.metaGet("resume_armed") === "1") {
      // 自動再開の最初のリクエスト。権利を使い、この晩を「再開した晩」にする(この晩を拒否なしで走り切れば、次の晩に権利が戻る)。拒否の判定(下)より前に付ける。
      this.metaSet("auto_resume_used", "1");
      this.metaSet("resumed_night", night);
      this.metaSet("resume_armed", "0");
    }

    if (result.kind === "response" && RESTRICTED_STATUSES.has(result.status)) {
      await this.stopRefused(result.status, STAGE_OF[work.kind], after);
      return;
    }
    if (result.kind === "refused" && result.status !== undefined && RESTRICTED_STATUSES.has(result.status)) {
      await this.stopRefused(result.status, STAGE_OF[work.kind], after);
      return;
    }

    let outcome: "ok" | "failed" | "stopped";
    if (result.kind === "refused") {
      outcome = (await this.failed(work, night, result.reason, after)) ? "stopped" : "failed";
    } else if (result.status !== 200) {
      outcome = (await this.failed(work, night, `http-${result.status}`, after)) ? "stopped" : "failed";
    } else {
      try {
        outcome = await this.process(work, night, new TextDecoder("utf-8").decode(new Uint8Array(result.body)), after);
      } catch (error) {
        // 読み取り(`buildRaceRecord` は想定外の例外をそのまま投げ直す)・保存後の記録の例外。握らないと、対象に印が付かず、同じページを 10 分おきに延々と取り直す。
        // 404 と同じく、その晩はもう取らず、3 晩で諦める(`dead`)。
        this.deps.log(`race-archive: process failed stage=${STAGE_OF[work.kind]} error=${errorKind(error)}`, "error");
        outcome = (await this.failed(work, night, "process-error", after)) ? "stopped" : "failed";
      }
    }
    if (outcome === "stopped") {
      return;
    }
    await this.arm(next);
  }

  private bump(key: string): number {
    const n = this.metaNum(key) + 1;
    this.metaSet(key, String(n));
    return n;
  }

  /**
   * 取れたページの処理。戻り値: `ok` = 完了 / `failed` = そのものの失敗(記録済み)/ `stopped` = 状態が止まり(拒否ではない停止を含む)、アラームも張り済み。
   */
  private async process(work: Work, night: string, text: string, at: number): Promise<"ok" | "failed" | "stopped"> {
    const problem = validateHistoryPage("central", STAGE_OF[work.kind], text);
    if (problem !== null) {
      return (await this.failed(work, night, "invalid-page", at)) ? "stopped" : "failed";
    }
    switch (work.kind) {
      case "month": {
        for (const date of (this.deps.parseCalendarDates ?? parseCalendarKaisaiDates)(text, work.id)) {
          this.deps.sql.exec("INSERT OR IGNORE INTO ra_day (date) VALUES (?)", date);
        }
        this.deps.sql.exec("UPDATE ra_month SET status = 'done', fetched_on = ?, last_class = NULL WHERE month = ?", night, work.id);
        this.metaSet("fail_streak", "0");
        return "ok";
      }
      case "day": {
        (this.deps.parseListIds ?? ((html: string) => parseListRaceIds(html, "central")))(text).forEach((id, seq) => {
          this.deps.sql.exec("INSERT OR IGNORE INTO ra_race (race_id, date, seq) VALUES (?, ?, ?)", id, work.id, seq);
        });
        this.deps.sql.exec("UPDATE ra_day SET status = 'listed', last_class = NULL WHERE date = ?", work.id);
        this.closeDayIfDone(work.id);
        this.metaSet("fail_streak", "0");
        return "ok";
      }
      default:
        return this.processResult(work, night, text, at);
    }
  }

  private async processResult(work: Extract<Work, { kind: "race" }>, night: string, html: string, at: number): Promise<"ok" | "failed" | "stopped"> {
    const built = (this.deps.buildRecord ?? buildRaceRecord)(html, work.id, "central");
    if (!built.ok) {
      this.deps.sql.exec("UPDATE ra_race SET status = 'skipped', last_class = ?, last_night = ? WHERE race_id = ?", built.category, night, work.id);
      this.closeDayIfDone(work.date);
      this.metaSet("fail_streak", "0");
      return "ok";
    }
    let saved: SaveRaceArchiveResult;
    try {
      saved = await this.deps.archive.saveRaceArchive({ record: built.record, html });
    } catch (error) {
      this.deps.log(`race-archive: save failed error=${errorKind(error)}`, "error");
      return (await this.failed(work, night, "save-failed", at)) ? "stopped" : "failed";
    }
    if (saved.status === "skipped") {
      if (saved.reason === "r2-fence") {
        await this.stopNight("r2-fence", at);
      } else {
        await this.stopCapacity(saved.reason, saved.dbSizeBytes, at);
      }
      return "stopped";
    }
    this.deps.sql.exec("UPDATE ra_race SET status = 'done', last_class = NULL WHERE race_id = ?", work.id);
    this.closeDayIfDone(work.date);
    this.bump("night_saved");
    this.metaSet("db_size", String(saved.dbSizeBytes));
    this.metaSet("fail_streak", "0");
    this.metaSet("fence_notified", "0");
    return "ok";
  }

  /** その日のレースが残っていなければ、日を完了にする。 */
  private closeDayIfDone(date: string): void {
    if (this.count("SELECT COUNT(*) AS n FROM ra_race WHERE date = ? AND status = 'pending'", date) === 0) {
      this.deps.sql.exec("UPDATE ra_day SET status = 'done' WHERE date = ? AND status = 'listed'", date);
    }
  }

  /**
   * 個別の失敗を記録する(その晩はもう取らない。{@link ARCHIVE_MAX_NIGHTS} 晩目で諦める)。連続失敗が上限に達したら、その晩を止めて通知する(戻り値 true = 止めた)。
   */
  private async failed(work: Work, night: string, cls: string, at: number): Promise<boolean> {
    const dead = `CASE WHEN status = 'pending' AND nights + (CASE WHEN COALESCE(last_night, '') <> ? THEN 1 ELSE 0 END) >= ${ARCHIVE_MAX_NIGHTS} THEN 'dead' ELSE status END`;
    const bumpNights = "nights + (CASE WHEN COALESCE(last_night, '') <> ? THEN 1 ELSE 0 END)";
    if (work.kind === "month") {
      this.deps.sql.exec(`UPDATE ra_month SET status = ${dead}, nights = ${bumpNights}, last_night = ?, last_class = ? WHERE month = ?`, night, night, night, cls, work.id);
    } else if (work.kind === "day") {
      this.deps.sql.exec(`UPDATE ra_day SET status = ${dead}, nights = ${bumpNights}, last_night = ?, last_class = ? WHERE date = ?`, night, night, night, cls, work.id);
    } else {
      this.deps.sql.exec(`UPDATE ra_race SET status = ${dead}, nights = ${bumpNights}, last_night = ?, last_class = ? WHERE race_id = ?`, night, night, night, cls, work.id);
    }
    this.bump("night_failed");
    // 「連続で失敗」に数えるのは、netkeiba 側の不調か、こちらの処理の失敗だけ(5xx・network・timeout・保存の例外・読み取りの例外)。
    // 404・検査の不合格・それ以外の 4xx は数えない(古いページが 404 だらけでも、1 晩 10 件で止まらない)。数えない失敗は連続回数を増やしも戻しもしない。
    const streak = countsTowardPause(cls) ? this.bump("fail_streak") : this.metaNum("fail_streak");
    this.deps.log(`race-archive: failed stage=${STAGE_OF[work.kind]} class=${cls} streak=${streak}`, "error");
    if (!countsTowardPause(cls) || streak < ARCHIVE_CONSECUTIVE_FAILURE_LIMIT) {
      return false;
    }
    const resumeAt = Math.max(nextNightStart(at, this.startMin), this.notBefore);
    this.metaSet("paused_night", night);
    this.setWait("paused-failures");
    this.queueNotice({ kind: "failures", count: streak, lastClass: cls, at, resumeAt });
    await this.flushNotice(this.deps.now());
    await this.arm(resumeAt);
    return true;
  }

  // ---- 停止 ----

  private nightStopResumeAt(at: number): number {
    return Math.max(nextNightStart(at, this.startMin), this.notBefore);
  }

  /** 止められた(HTTP 400・403・429)。その場で止める。自動再開の権利があれば次の晩に再開、無ければ手で再開するまで動かさない。 */
  private async stopRefused(httpStatus: number, stage: HistoryStage, at: number): Promise<void> {
    const willAutoResume = this.metaGet("auto_resume_used") !== "1";
    const resumeAt = willAutoResume ? this.nightStopResumeAt(at) : null;
    this.recordStop("refused", `http-${httpStatus}`, at, resumeAt);
    this.metaSet("mode", willAutoResume ? "night-stopped" : "manual-stopped");
    this.metaSet("resume_at", String(resumeAt ?? 0));
    this.deps.log(`race-archive: refused status=${httpStatus} stage=${stage} auto-resume=${String(willAutoResume)}`, "error");
    this.queueNotice({ kind: "refused", httpStatus, stage, at, willAutoResume, resumeAt, nightSaved: this.metaNum("night_saved"), totalDone: this.totalDone() });
    await this.flushNotice(this.deps.now());
    await this.arm(resumeAt);
  }

  /** R2 の柵に達した。次の晩に自動で再開する(自動再開の権利は使わない)。 */
  private async stopNight(kind: "r2-fence", at: number): Promise<void> {
    const resumeAt = this.nightStopResumeAt(at);
    this.recordStop(kind, kind, at, resumeAt);
    this.metaSet("mode", "night-stopped");
    this.metaSet("resume_at", String(resumeAt));
    this.deps.log(`race-archive: stopped kind=${kind}`, "error");
    // 柵は月単位なので、毎晩 1 リクエストを出して確かめる(次の晩に自動で再開し、また柵で止まる)。通知は止まった最初の 1 回だけ(保存に成功すると、また 1 回送る)。
    if (this.metaGet("fence_notified") !== "1") {
      this.metaSet("fence_notified", "1");
      this.queueNotice({ kind: "r2-fence", at, resumeAt });
      await this.flushNotice(this.deps.now());
    }
    await this.arm(resumeAt);
  }

  /** D1 が上限を超えた・大きさが読めない。手で再開するまで動かさない。 */
  private async stopCapacity(reason: "db-size" | "db-size-unknown", dbSizeBytes: number | null, at: number): Promise<void> {
    this.recordStop("capacity", reason, at, null);
    this.metaSet("mode", "capacity-stopped");
    this.metaSet("resume_at", "0");
    if (dbSizeBytes !== null) {
      this.metaSet("db_size", String(dbSizeBytes));
    }
    this.deps.log(`race-archive: capacity-stopped reason=${reason}`, "error");
    this.queueNotice({ kind: "capacity", reason, dbSizeBytes, at, totalDone: this.totalDone() });
    await this.flushNotice(this.deps.now());
    await this.arm(null);
  }

  private recordStop(kind: string, detail: string, at: number, resumeAt: number | null): void {
    this.metaSet("stop_kind", kind);
    this.metaSet("last_stop", JSON.stringify({ kind, detail, at, resumeAt }));
  }

  private totalDone(): number {
    return this.count("SELECT COUNT(*) AS n FROM ra_race WHERE status = 'done'");
  }

  // ---- 通知 ----

  private queueNotice(notice: ArchiveNotice): void {
    this.metaSet("pending_notice", JSON.stringify(notice));
    this.metaSet("notice_attempts", "0");
    this.metaSet("notice_retry_at", "0");
  }

  /** 待っている通知を送る。失敗したら 10 分後に再送し、{@link ARCHIVE_NOTICE_MAX_ATTEMPTS} 回で諦める。 */
  private async flushNotice(now: number): Promise<void> {
    const raw = this.metaGet("pending_notice");
    if (raw === null || now < this.metaNum("notice_retry_at")) {
      return;
    }
    const attempts = this.metaNum("notice_attempts") + 1;
    try {
      await this.deps.notify(JSON.parse(raw) as ArchiveNotice);
      this.metaDelete("pending_notice", "notice_attempts", "notice_retry_at");
    } catch (error) {
      this.deps.log(`race-archive: notify failed attempt=${attempts} error=${errorKind(error)}`, "error");
      if (attempts >= ARCHIVE_NOTICE_MAX_ATTEMPTS) {
        this.metaDelete("pending_notice", "notice_attempts", "notice_retry_at");
      } else {
        this.metaSet("notice_attempts", String(attempts));
        this.metaSet("notice_retry_at", String(now + ARCHIVE_ERROR_RETRY_MS));
      }
    }
  }

  // ---- 観測 ----

  /** 進捗の読み取り(状態は変えない)。 */
  async getStatus(): Promise<RaceArchiveFetchStatus> {
    const races = (status: string): number => this.count("SELECT COUNT(*) AS n FROM ra_race WHERE status = ?", status);
    const days = (status: string): number => this.count("SELECT COUNT(*) AS n FROM ra_day WHERE status = ?", status);
    const months = (status: string): number => this.count("SELECT COUNT(*) AS n FROM ra_month WHERE status = ?", status);
    const skipped = this.deps.sql.exec("SELECT last_class AS cls, COUNT(*) AS n FROM ra_race WHERE status = 'skipped' GROUP BY last_class").toArray() as { cls: string | null; n: number }[];
    const lastStopRaw = this.metaGet("last_stop");
    const lastReq = this.metaGet("last_req_at");
    const dbSize = this.metaGet("db_size");
    return {
      state: this.disabled ? "disabled" : this.mode(),
      waitReason: this.disabled ? "disabled" : (this.metaGet("wait_reason") ?? "none"),
      nextRunAt: this.disabled ? null : await this.deps.getAlarm(),
      notBeforeMs: this.notBefore,
      night: { date: this.metaGet("night_date"), requests: this.metaNum("night_requests"), saved: this.metaNum("night_saved"), failed: this.metaNum("night_failed") },
      totals: {
        months: { pending: months("pending"), done: months("done"), dead: months("dead") },
        days: { pending: days("pending"), listed: days("listed"), done: days("done"), dead: days("dead") },
        races: { pending: races("pending"), done: races("done"), existing: this.count("SELECT COUNT(*) AS n FROM ra_race WHERE status = 'done' AND last_class = 'existing'"), skipped: races("skipped"), dead: races("dead") },
      },
      skippedByClass: Object.fromEntries(skipped.map((r) => [r.cls ?? "", r.n])),
      lastStop: lastStopRaw === null ? null : (JSON.parse(lastStopRaw) as RaceArchiveFetchStatus["lastStop"]),
      autoResume: { used: this.metaGet("auto_resume_used") === "1", resumedNight: this.metaGet("resumed_night") || null },
      dbSizeBytes: dbSize === null ? null : Number(dbSize),
      lastRequestAt: lastReq === null ? null : Number(lastReq),
    };
  }
}
