/**
 * JRA の過去の結果の頁から、2021-01〜2026-11-06 の中央のレースでブリンカーを着けていた馬を埋め戻す段取り(Issue #698。親は #695)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。
 * 本物の `ctx.storage.sql`・時計・アラーム・D1・JRA への取得を配線するのは `jra-blinker-backfill-do.ts`(DO `JraBlinkerBackfillDO`)。構造は `jra-horse-backfill-core.ts`(#697)を写した。
 * **netkeiba にも gate にも出ない**(JRA の公式サイトと D1 だけ)。
 *
 * ## 何をするか
 *  - 道筋は過去検索の頁(1 回)→ 月の頁(2021-01 から 2026-11 まで 1 か月ずつ)→ 場日の頁 → 結果の頁(1 レース 1 本)。ページの読み方は `jra-result-links.ts`・`jra-result-parse.ts`。
 *    2026-11-07 以降の場日は取らない(出馬表の取得〈#639〉が持つ)。
 *  - 進み方は 結果 → 場日 → 月 の深さ優先。場日の頁から拾った結果の cname と、月の頁から拾った場日の cname は、DO の SQLite の `bb_races`・`bb_days` に持つ(D1 には書かない)。
 *    途中で起床が切れても、再起動しても、続きから進む。月の位置は `bb_meta.month`、過去検索の表は `bb_meta.param_table`。
 *  - 場日の頁を読んだら、そのレースの ID の配列を 1 回だけ束縛して D1 に尋ね、取り終えたレースの結果は取らない(`PastBlinkerStoreLike.filterDone`。主キーの引き)。
 *  - 取れたレースは、起床の終わりにまとめて 1 回の batch で書く(`saveRaces`。レースの行と、着けていた馬の行)。着けていない馬の行は書かない
 *    (「取り終えたレースにいて、馬の表に行が無い = 着けていない」。頁の馬の ID が 1 つでも取れなければ、そのレースは丸ごと読めない扱いで何も書かない〈`jra-result-parse.ts`〉)。
 *  - 最後の月まで進んで、積んだ頁が空になったら `finished` にして止まる(アラームを張らず、次の kick でも何もしない)。
 *
 * ## いつ動くか・上限(#697 と同じ形)
 *  - **JST 18:00〜翌 8:00** だけ。起きている途中で 8:00 を過ぎたら、その先は取らない。
 *  - 1 回の起床は**取得の本数が最大 {@link BLINKER_BACKFILL_PER_WAKE}(頁の種類を問わない)**で、さらに**取得と D1 の呼び出しの合計が {@link BLINKER_BACKFILL_SUBREQUEST_MAX} 以下**
 *    (Free の 1 回の呼び出しの上限 50 に収める。場日ごとの D1 の確認と、終わりの書き込みの分を残して取る)。間隔は開始から開始まで {@link BLINKER_BACKFILL_GAP_MS}。起床の終わりから {@link BLINKER_BACKFILL_NEXT_DELAY_MS} 後に次のアラーム。
 *  - **1 日(JST)の書き込みは 2 つの表の `meta.changes` の合計で {@link BLINKER_BACKFILL_DAILY_ROWS_MAX} 行まで**(var で下げることだけできる)。次のレースを取る前に、
 *    「残りの枠 − この起床で書く予定の行 ≥ {@link BLINKER_BACKFILL_ROWS_PER_RACE_MAX}(1 レースの最大 = レース 1 + 18 頭)」を確かめるので、上限を超えて書かない。足りなければ翌日 18:00 まで休む。
 *  - 無効(var が `"0"`): アラームを張らず、起きても何もしない。
 *
 * ## 失敗
 *  - 誤りの頁・読めない頁・場日にレースが無い・月に場日が無い・大きすぎる頁は、DO の SQLite の `bb_skip` に記録して飛ばす。
 *  - timeout・network・redirect・HTTP の失敗は記録せず、次の起床で同じ頁をもう一度取る。**同じ頁の失敗が {@link BLINKER_BACKFILL_MAX_TRIES} 回に達したら諦めて `gave-up` で飛ばす**(1 頁のために終われなくなるのを防ぐ)。
 *  - **連続 {@link BLINKER_BACKFILL_FAILURE_LIMIT} 回の起床で 1 頁も読めなかったら止まる**(翌日 18:00 に自動で再開)。「読めた」は、頁として理解できたもの(場日にレースが無い・月に場日が無い、も含む)。
 *    取得に失敗した頁・誤りの頁・読めない頁だけの起床は数える。アラームの中の例外(D1 の失敗など)は 10 分後に再試行し、同じく連続に数える。書けなかった起床は、取り終えの印も飛ばす記録(結果の頁)も進めない。
 *
 * ## ログ
 * 固定の文と数(取った数・書いた行数・飛ばした数・失敗した数)だけ。cname・URL・応答の本文・例外のメッセージは出さない。
 */
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";
import { monthCname, parseDayRaces, parseMonthDays, parseParamTable, PAST_SEARCH_CNAME } from "./jra-result-links";
import { parseResultPage } from "./jra-result-parse";
import type { PastBlinkerStoreLike, SavedPastRace } from "./past-blinker-repository";
import type { SqlLike } from "./sql-like";
import { shouldRearm } from "./stale-alarm";

/** 単一インスタンスの固定名。cron の `scheduled` が引く。 */
export const JRA_BLINKER_BACKFILL_NAME = "main";
export const BLINKER_BACKFILL_WINDOW_START_MIN = 18 * 60;
export const BLINKER_BACKFILL_WINDOW_END_MIN = 8 * 60;
/** 1 回の起床で取る頁の最大数(頁の種類を問わない)。 */
export const BLINKER_BACKFILL_PER_WAKE = 40;
/** 1 回の起床の、取得と D1 の呼び出しの合計の上限。 */
export const BLINKER_BACKFILL_SUBREQUEST_MAX = 48;
/** 次の取得を始める前に残しておく D1 の呼び出し(場日の確認 1 + 終わりの書き込み 1)。 */
const SUBREQUEST_RESERVE = 2;
export const BLINKER_BACKFILL_GAP_MS = 3_000;
export const BLINKER_BACKFILL_NEXT_DELAY_MS = 30_000;
/** 1 日(JST)の書き込み行数の上限(var で下げることだけできる)。 */
export const BLINKER_BACKFILL_DAILY_ROWS_MAX = 14_000;
/** 1 レースで書く行の最大(レースの行 1 + 印の馬 18)。 */
export const BLINKER_BACKFILL_ROWS_PER_RACE_MAX = 19;
export const BLINKER_BACKFILL_FAILURE_LIMIT = 3;
export const BLINKER_BACKFILL_MAX_TRIES = 10;
export const BLINKER_BACKFILL_ERROR_RETRY_MS = 10 * 60_000;

/** 取る範囲: 月は 2021-01〜2026-11、日は 2026-11-06 まで(それ以降は出馬表の取得が持つ)。 */
export const BLINKER_BACKFILL_FIRST_MONTH = "202101";
export const BLINKER_BACKFILL_LAST_MONTH = "202611";
export const BLINKER_BACKFILL_LAST_DATE = "20261106";

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** 止める設定の判定(Worker の var `JRA_BLINKER_BACKFILL_ENABLED`)。**文字列 `"0"`(前後の空白は無視)だけ**が無効。未設定・それ以外は有効。 */
export function isJraBlinkerBackfillDisabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "0";
}

/** JRA への 1 本の取得の結果(取得口が分類して返す)。 */
export type ResultFetchOutcome = { readonly kind: "page"; readonly html: string } | { readonly kind: "failed"; readonly reason: "timeout" | "network" | "redirect" | "http" | "too-large" };

export interface JraBlinkerBackfillOptions {
  readonly disabled?: boolean;
  /** 1 日の書き込み行数の上限(下げる方向の上書き。上限を超える値・不正な値は既定の上限)。 */
  readonly dailyRows?: number;
}

export interface JraBlinkerBackfillDeps {
  /** DO の SQLite(`ctx.storage.sql`)。表 `bb_meta`・`bb_days`・`bb_races`・`bb_skip` を `CREATE TABLE IF NOT EXISTS` で作る。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly store: PastBlinkerStoreLike;
  /** 過去の結果の頁を 1 本取る(cname を渡す。URL・メソッドは取得口の中にだけある。例外は投げない。失敗は分類に落とす)。 */
  readonly fetchPage: (cname: string) => Promise<ResultFetchOutcome>;
  readonly log: (line: string, level: "info" | "error") => void;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Error" : "non-error";
}

function msOfJstDay(ms: number): number {
  return (((ms + JST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

/** 時間帯の中か(JST 18:00 以上、または 8:00 未満)。 */
export function inBlinkerBackfillWindow(ms: number): boolean {
  const t = msOfJstDay(ms);
  return t >= BLINKER_BACKFILL_WINDOW_START_MIN * MIN_MS || t < BLINKER_BACKFILL_WINDOW_END_MIN * MIN_MS;
}

/** いま以降で最初に時間帯に入る時刻(中ならいま)。 */
export function nextBlinkerBackfillStart(ms: number): number {
  if (inBlinkerBackfillWindow(ms)) return ms;
  return ms - msOfJstDay(ms) + BLINKER_BACKFILL_WINDOW_START_MIN * MIN_MS;
}

/** 翌日(JST)の 18:00。 */
export function nextBlinkerDayEvening(ms: number): number {
  return ms - msOfJstDay(ms) + DAY_MS + BLINKER_BACKFILL_WINDOW_START_MIN * MIN_MS;
}

function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

function nextMonth(yyyymm: string): string {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  return m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, "0")}`;
}

type SkipReason = "param-error" | "unparsable" | "too-large" | "gave-up" | "no-days" | "no-races" | "no-param";

type Unit =
  | { readonly kind: "race"; readonly cname: string; readonly raceId: string; readonly tries: number }
  | { readonly kind: "day"; readonly cname: string; readonly tries: number }
  | { readonly kind: "param" }
  | { readonly kind: "month"; readonly month: string }
  | { readonly kind: "finished" }
  | { readonly kind: "none" };

export class JraBlinkerBackfillCore {
  private readonly deps: JraBlinkerBackfillDeps;
  private readonly disabled: boolean;
  private readonly dailyRows: number;
  private readonly metaCache = new Map<string, string | null>();

  constructor(deps: JraBlinkerBackfillDeps, options: JraBlinkerBackfillOptions = {}) {
    this.deps = deps;
    this.disabled = options.disabled === true;
    this.dailyRows =
      options.dailyRows !== undefined && Number.isInteger(options.dailyRows) && options.dailyRows >= 1 ? Math.min(options.dailyRows, BLINKER_BACKFILL_DAILY_ROWS_MAX) : BLINKER_BACKFILL_DAILY_ROWS_MAX;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bb_days (ord INTEGER PRIMARY KEY, cname TEXT NOT NULL UNIQUE, tries INTEGER NOT NULL DEFAULT 0)");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bb_races (ord INTEGER PRIMARY KEY, cname TEXT NOT NULL UNIQUE, race_id TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0)");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bb_skip (cname TEXT PRIMARY KEY, reason TEXT NOT NULL, day TEXT NOT NULL) WITHOUT ROWID");
  }

  // ---- 状態の読み書き(主キーの引きだけ) ----

  private metaGet(key: string): string | null {
    const cached = this.metaCache.get(key);
    if (cached !== undefined) return cached;
    const rows = this.deps.sql.exec("SELECT value FROM bb_meta WHERE key = ?", key).toArray() as { value: string }[];
    const value = rows[0]?.value ?? null;
    this.metaCache.set(key, value);
    return value;
  }

  /** 値が変わるときだけ書く(DO の SQLite の書き込み行数を減らす)。 */
  private metaSet(key: string, value: string): void {
    if (this.metaGet(key) === value) return;
    this.deps.sql.exec("INSERT INTO bb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    this.metaCache.set(key, value);
  }

  private metaNum(key: string): number {
    const n = Number(this.metaGet(key));
    return Number.isFinite(n) ? n : 0;
  }

  private recordSkip(cname: string, reason: SkipReason, day: string): void {
    this.deps.sql.exec("INSERT INTO bb_skip (cname, reason, day) VALUES (?, ?, ?) ON CONFLICT(cname) DO NOTHING", cname, reason, day);
  }

  // ---- アラーム ----

  /** アラームが無ければ張る(cron の `scheduled` が呼ぶ)。終わっていれば張らない。 */
  async kick(): Promise<void> {
    if (this.disabled) return;
    if (this.metaGet("finished") === "1") return;
    const now = this.deps.now();
    if (!shouldRearm(await this.deps.getAlarm(), now, (iso) => this.deps.log(`jra-blinker-backfill: stale alarm at=${iso} re-armed`, "info"))) return;
    await this.deps.setAlarm(nextBlinkerBackfillStart(now));
  }

  /** アラーム: 次の起床を 1 回実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    if (this.disabled) return;
    try {
      await this.step();
    } catch (error) {
      this.deps.log(`jra-blinker-backfill: step failed error=${errorKind(error)}`, "error");
      try {
        if (this.countFailure()) {
          await this.halt();
        } else {
          await this.deps.setAlarm(this.deps.now() + BLINKER_BACKFILL_ERROR_RETRY_MS);
        }
      } catch {
        // アラームを張れなければ、cron の kick が張り直す。
      }
    }
  }

  /** 失敗の連続を 1 つ増やす。上限に達したら true(連続は 0 に戻す)。 */
  private countFailure(): boolean {
    const streak = this.metaNum("streak") + 1;
    if (streak >= BLINKER_BACKFILL_FAILURE_LIMIT) {
      this.metaSet("streak", "0");
      return true;
    }
    this.metaSet("streak", String(streak));
    return false;
  }

  private async halt(): Promise<void> {
    this.metaSet("wait_reason", "halted");
    this.deps.log("jra-blinker-backfill: halted (no page could be read in consecutive wakes); resumes next evening", "error");
    await this.deps.setAlarm(nextBlinkerDayEvening(this.deps.now()));
  }

  // ---- 次にやること ----

  private firstRow<T>(query: string, ...bindings: unknown[]): T | null {
    return (this.deps.sql.exec(query, ...bindings).toArray() as T[])[0] ?? null;
  }

  /** 次の 1 本。この起床で扱い済み(`handled`)の cname は選ばない。積んだ頁が全部扱い済みなら none、空で最後の月を終えていれば finished。 */
  private nextUnit(handled: ReadonlySet<string>): Unit {
    const skipJson = JSON.stringify([...handled]);
    const race = this.firstRow<{ cname: string; race_id: string; tries: number }>(
      "SELECT cname, race_id, tries FROM bb_races WHERE cname NOT IN (SELECT value FROM json_each(?)) ORDER BY ord LIMIT 1",
      skipJson,
    );
    if (race !== null) return { kind: "race", cname: race.cname, raceId: race.race_id, tries: race.tries };
    const day = this.firstRow<{ cname: string; tries: number }>("SELECT cname, tries FROM bb_days WHERE cname NOT IN (SELECT value FROM json_each(?)) ORDER BY ord LIMIT 1", skipJson);
    if (day !== null) return { kind: "day", cname: day.cname, tries: day.tries };
    if (this.metaGet("param_table") === null) return { kind: "param" };
    const month = this.metaGet("month") ?? BLINKER_BACKFILL_FIRST_MONTH;
    if (month > BLINKER_BACKFILL_LAST_MONTH) {
      const left = this.firstRow<{ one: number }>("SELECT 1 AS one FROM bb_races LIMIT 1") ?? this.firstRow<{ one: number }>("SELECT 1 AS one FROM bb_days LIMIT 1");
      return left === null ? { kind: "finished" } : { kind: "none" };
    }
    return { kind: "month", month };
  }

  private async step(): Promise<void> {
    const { deps } = this;
    const start = deps.now();
    if (this.metaGet("finished") === "1") return;
    if (!inBlinkerBackfillWindow(start)) {
      this.metaSet("wait_reason", "outside-window");
      await deps.setAlarm(nextBlinkerBackfillStart(start));
      return;
    }
    const day = jstDay(start);
    if (this.metaGet("day") !== day) {
      this.metaSet("day", day);
      this.metaSet("day_rows", "0");
    }
    const remaining = this.dailyRows - this.metaNum("day_rows");
    if (remaining < BLINKER_BACKFILL_ROWS_PER_RACE_MAX) {
      this.metaSet("wait_reason", "daily-limit");
      await deps.setAlarm(nextBlinkerDayEvening(start));
      return;
    }

    const handled = new Set<string>();
    const pending: SavedPastRace[] = [];
    const pendingCnames: string[] = [];
    const raceSkips: { cname: string; reason: SkipReason }[] = [];
    let pendingRows = 0;
    let fetches = 0;
    let subrequests = 0;
    let readable = 0;
    let failed = 0;
    let skipped = 0;
    let reachedEnd = false;
    let lastStartAt: number | null = null;

    for (;;) {
      if (fetches >= BLINKER_BACKFILL_PER_WAKE) break;
      if (subrequests + 1 + SUBREQUEST_RESERVE > BLINKER_BACKFILL_SUBREQUEST_MAX) break;
      if (!inBlinkerBackfillWindow(deps.now())) break;
      const unit = this.nextUnit(handled);
      if (unit.kind === "finished") {
        reachedEnd = true;
        break;
      }
      if (unit.kind === "none") break;
      if (unit.kind === "race" && remaining - pendingRows < BLINKER_BACKFILL_ROWS_PER_RACE_MAX) break;

      const cname = unit.kind === "race" || unit.kind === "day" ? unit.cname : unit.kind === "param" ? PAST_SEARCH_CNAME : this.monthCnameOf(unit.month);
      if (cname === null && unit.kind === "month") {
        // 過去検索の表に無い月: 飛ばして次の月へ。
        this.recordSkip(`month:${unit.month}`, "no-param", day);
        skipped += 1;
        this.metaSet("month", nextMonth(unit.month));
        continue;
      }
      if (cname === null) break; // 型の絞り込み用(月以外は cname を必ず持つ)

      if (lastStartAt !== null) {
        const wait = BLINKER_BACKFILL_GAP_MS - (deps.now() - lastStartAt);
        if (wait > 0) await deps.sleep(wait);
        if (!inBlinkerBackfillWindow(deps.now())) break;
      }
      lastStartAt = deps.now();
      fetches += 1;
      subrequests += 1;
      const outcome = await deps.fetchPage(cname);
      if (unit.kind === "race" || unit.kind === "day") handled.add(cname);

      // 取得の失敗: 記録せず次の起床で取り直す。同じ頁の失敗が上限に達したら諦めて飛ばす。too-large は取り直さない。
      if (outcome.kind === "failed") {
        const tooLarge = outcome.reason === "too-large";
        const tries = this.bumpTries(unit);
        if (tooLarge || tries >= BLINKER_BACKFILL_MAX_TRIES) {
          const reason: SkipReason = tooLarge ? "too-large" : "gave-up";
          skipped += 1;
          this.skipUnit(unit, reason, day, raceSkips);
        } else {
          failed += 1;
        }
        continue;
      }

      if (unit.kind === "param") {
        const parsed = parseParamTable(outcome.html);
        if (!parsed.ok) {
          failed += 1;
          continue;
        }
        const needed: Record<string, string> = {};
        for (let m = BLINKER_BACKFILL_FIRST_MONTH; m <= BLINKER_BACKFILL_LAST_MONTH; m = nextMonth(m)) {
          const code = parsed.table.get(m.slice(2));
          if (code !== undefined) needed[m] = code;
        }
        this.metaSet("param_table", JSON.stringify(needed));
        readable += 1;
      } else if (unit.kind === "month") {
        const parsed = parseMonthDays(outcome.html, unit.month);
        if (parsed.ok) {
          readable += 1;
          for (const d of parsed.days) {
            if (d.date > BLINKER_BACKFILL_LAST_DATE) continue;
            deps.sql.exec("INSERT INTO bb_days (cname) VALUES (?) ON CONFLICT(cname) DO NOTHING", d.cname);
          }
        } else {
          if (parsed.reason === "no-days") readable += 1;
          this.recordSkip(`month:${unit.month}`, parsed.reason, day);
          skipped += 1;
        }
        this.metaSet("month", nextMonth(unit.month));
        this.metaSet("month_tries", "0");
      } else if (unit.kind === "day") {
        const parsed = parseDayRaces(outcome.html, unit.cname);
        if (parsed.ok) {
          readable += 1;
          subrequests += 1;
          const done = new Set(await deps.store.filterDone(parsed.races.map((r) => r.raceId)));
          for (const r of parsed.races) {
            if (done.has(r.raceId)) continue;
            deps.sql.exec("INSERT INTO bb_races (cname, race_id) VALUES (?, ?) ON CONFLICT(cname) DO NOTHING", r.cname, r.raceId);
          }
          deps.sql.exec("DELETE FROM bb_days WHERE cname = ?", unit.cname);
        } else {
          if (parsed.reason === "no-races") readable += 1;
          this.skipUnit(unit, parsed.reason, day, raceSkips);
          skipped += 1;
        }
      } else {
        const parsed = parseResultPage(outcome.html);
        if (parsed.ok) {
          readable += 1;
          pending.push({ raceId: unit.raceId, headCount: parsed.headCount, blinkerHorseIds: parsed.blinkerHorseIds });
          pendingCnames.push(unit.cname);
          pendingRows += 1 + parsed.blinkerHorseIds.length;
        } else {
          raceSkips.push({ cname: unit.cname, reason: parsed.reason });
          skipped += 1;
        }
      }
    }

    // 書く(失敗したら例外のまま抜ける: 取り終えの印も、結果の頁を飛ばす記録も進めない)。
    const written = pending.length > 0 ? await deps.store.saveRaces(pending, day) : 0;
    const settled = [...pendingCnames, ...raceSkips.map((s) => s.cname)];
    if (settled.length > 0) deps.sql.exec("DELETE FROM bb_races WHERE cname IN (SELECT value FROM json_each(?))", JSON.stringify(settled));
    for (const s of raceSkips) this.recordSkip(s.cname, s.reason, day);
    this.metaSet("day_rows", String(this.metaNum("day_rows") + written));
    deps.log(`jra-blinker-backfill: wake fetched=${fetches} saved=${written} skipped=${skipped} failed=${failed}`, "info");

    if (fetches > 0) {
      if (readable === 0) {
        if (this.countFailure()) {
          await this.halt();
          return;
        }
      } else {
        this.metaSet("streak", "0");
      }
    }

    if (reachedEnd) {
      this.metaSet("finished", "1");
      this.metaSet("wait_reason", "finished");
      deps.log("jra-blinker-backfill: finished", "info");
      return; // 最後まで進んだ: アラームを張らず、次の kick でも何もしない。
    }
    this.metaSet("wait_reason", "active");
    await deps.setAlarm(deps.now() + BLINKER_BACKFILL_NEXT_DELAY_MS);
  }

  /** 月の頁の cname。過去検索の表に無い月は null。 */
  private monthCnameOf(month: string): string | null {
    const table = JSON.parse(this.metaGet("param_table") ?? "{}") as Record<string, string>;
    const code = table[month];
    return code === undefined ? null : monthCname(month, code);
  }

  /** 失敗の回数を 1 つ増やして返す。過去検索の頁は数えない(飛ばせないので、止める仕組みに任せる)。 */
  private bumpTries(unit: Unit): number {
    if (unit.kind === "race") {
      this.deps.sql.exec("UPDATE bb_races SET tries = tries + 1 WHERE cname = ?", unit.cname);
      return unit.tries + 1;
    }
    if (unit.kind === "day") {
      this.deps.sql.exec("UPDATE bb_days SET tries = tries + 1 WHERE cname = ?", unit.cname);
      return unit.tries + 1;
    }
    if (unit.kind === "month") {
      const tries = this.metaNum("month_tries") + 1;
      this.metaSet("month_tries", String(tries));
      return tries;
    }
    return 0;
  }

  /** 頁を飛ばす。結果の頁は D1 の書き込みのあとに記録する(`raceSkips`)。場日・月はすぐ記録して先へ進む。 */
  private skipUnit(unit: Unit, reason: SkipReason, day: string, raceSkips: { cname: string; reason: SkipReason }[]): void {
    if (unit.kind === "race") {
      raceSkips.push({ cname: unit.cname, reason });
    } else if (unit.kind === "day") {
      this.recordSkip(unit.cname, reason, day);
      this.deps.sql.exec("DELETE FROM bb_days WHERE cname = ?", unit.cname);
    } else if (unit.kind === "month") {
      this.recordSkip(`month:${unit.month}`, reason, day);
      this.metaSet("month", nextMonth(unit.month));
      this.metaSet("month_tries", "0");
    }
  }
}
