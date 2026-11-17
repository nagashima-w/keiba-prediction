/**
 * JRA の「過去の含水率・クッション値」(年ごとの頁と、開催ごとの PDF)から、過去の馬場の公表値を貯める段取り(Issue #769)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。
 * 本物の `ctx.storage.sql`・時計・アラーム・D1・R2・JRA への取得を配線するのは `jra-baba-past-backfill-do.ts`(DO `JraBabaPastBackfillDO`)。構造は `jra-blinker-backfill-core.ts`(#698)を写した。
 * **netkeiba にも gate にも出ない**(JRA の公式サイトと D1・R2 だけ)。PDF の読み取りは `jra-baba-past-pdf.ts`、年の頁の読み取りは `jra-baba-past-links.ts`(どちらも純関数)。
 *
 * ## 何をするか
 *  - 年(既定 2021〜2024。{@link JraBabaPastBackfillOptions.firstYear}・{@link JraBabaPastBackfillOptions.lastYear} で変える。2018〜2020 も同じ口で、範囲を変えるだけ)の頁を 1 本ずつ取り、PDF の一覧を DO の SQLite の `bp_queue` に積む。
 *    頁に載っている PDF だけを積む(連番の推測はしない)。保存済み(D1 の `baba_past_pdfs` に行がある)の PDF は積まない(`BabaPastStoreLike.filterDone`。主キーの引き)。
 *  - 積んだ PDF を、**1 回の起床で 1 本**取り、読み、D1 に書く(`savePdf`。行・PDF の記録・R2 への控えを 1 つの batch)。次の起床は {@link BABA_PAST_GAP_MS} 後。
 *  - 読めない形(PDF でない・展開できない・文字が無い・形の不一致・見出しが名前と食い違う・行が多すぎる)は、**分類だけを `baba_past_pdfs` に記録して先へ進む**(止めない・壊れた値を入れない)。
 *    記録した PDF は再取得しない(PDF は R2 にあるので、パーサを直したあとは JRA へ取り直さずに読み直せる)。
 *  - 一時的な失敗(timeout・network・5xx・408・429)は記録せず、同じ PDF を次の起床で取り直す。連続 {@link BABA_PAST_FAILURE_LIMIT} 回の起床で一時的な失敗か読めない年の頁が続いたら止まる(翌日 18:00 に自動で再開)。
 *    取得で決まった失敗(404・403・リダイレクト・大きすぎる)は、PDF なしで分類を記録して先へ進む。
 *  - 全部の年を終えて積んだ PDF が空になったら `finished` にして止まる(アラームを張らず、次の kick でも何もしない)。
 *
 * ## いつ動くか・上限
 *  - **止める var は "1" だけが有効**({@link isJraBabaPastBackfillEnabled}。`JRA_BABA_PAST_BACKFILL_ENABLED`)。未設定・それ以外は止まっている(アラームを張らず、起きても何もしない)。最初は止めて公開し、確かめてから "1" にする。
 *  - **JST 18:00〜翌 8:00** だけ(`jra-blinker-backfill-core.ts` の時間帯と同じ。JRA の開催日の朝の取得と重ならない)。
 *  - **1 日(JST)の書き込みは {@link BABA_PAST_DAILY_ROWS_MAX} 行まで**(D1 の `meta.changes` の合計。var で下げることだけできる)。次の PDF を取る前に「残り ≥ {@link BABA_PAST_ROWS_PER_PDF_MAX}(1 PDF の最大)」を確かめる。足りなければ翌日 18:00 まで休む。
 *  - 1 本ごとの間隔は {@link BABA_PAST_GAP_MS}(3 秒以上。JRA の調査の決まり)。
 *
 * ## ログ
 * 固定の文と数(書いた行数・結果の区分)だけ。PDF の名前・URL・応答の本文・例外のメッセージは出さない。
 */
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";
import { inBlinkerBackfillWindow, nextBlinkerBackfillStart, nextBlinkerDayEvening } from "./jra-blinker-backfill-core";
import { parseBabaPastPdf } from "./jra-baba-past-pdf";
import { parseBabaPastYearPage, type BabaPastLink } from "./jra-baba-past-links";
import type { BabaPastStoreLike } from "./baba-past-repository";
import type { SqlLike } from "./sql-like";
import { shouldRearm } from "./stale-alarm";

/** 単一インスタンスの固定名。cron の `scheduled` が引く。 */
export const JRA_BABA_PAST_BACKFILL_NAME = "main";
/** 起床と起床の間隔(取得の開始から開始まで 3 秒以上)。 */
export const BABA_PAST_GAP_MS = 3_000;
/** 1 日(JST)の書き込み行数の上限(var で下げることだけできる)。 */
export const BABA_PAST_DAILY_ROWS_MAX = 500;
/** 1 PDF で書く行の最大(`baba_past` の行 60 + `baba_past_pdfs` 1 + `r2_ops` 1)。PDF の行数がこれを超えるときは shape-mismatch。 */
export const BABA_PAST_ROWS_PER_PDF_MAX = 62;
export const BABA_PAST_FAILURE_LIMIT = 3;
export const BABA_PAST_ERROR_RETRY_MS = 10 * 60_000;
/** 取る年の既定の範囲。 */
export const BABA_PAST_FIRST_YEAR = 2021;
export const BABA_PAST_LAST_YEAR = 2024;

/** 止める var の判定(`JRA_BABA_PAST_BACKFILL_ENABLED`)。**前後の空白を除いて文字列 `"1"` だけ**が有効。未設定・それ以外は止まっている。 */
export function isJraBabaPastBackfillEnabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "1";
}

/** 取得の失敗の分類(固定の語)。 */
export type BabaPastFetchFailure = "timeout" | "network" | "redirect" | "too-large" | `http-${number}`;

export type BabaPastYearOutcome = { readonly kind: "page"; readonly html: string } | { readonly kind: "failed"; readonly reason: BabaPastFetchFailure };
export type BabaPastPdfOutcome = { readonly kind: "pdf"; readonly bytes: Uint8Array } | { readonly kind: "failed"; readonly reason: BabaPastFetchFailure };

export interface JraBabaPastBackfillOptions {
  /** `true` のときだけ動く(既定は止まっている)。 */
  readonly enabled?: boolean;
  /** 1 日の書き込み行数の上限(下げる方向の上書き。上限を超える値・不正な値は既定の上限)。 */
  readonly dailyRows?: number;
  readonly firstYear?: number;
  readonly lastYear?: number;
}

export interface JraBabaPastBackfillDeps {
  /** DO の SQLite(`ctx.storage.sql`)。表 `bp_meta`・`bp_years`・`bp_queue` を `CREATE TABLE IF NOT EXISTS` で作る。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly store: BabaPastStoreLike;
  /** 年の頁を 1 本取る(URL は取得口の中にだけある。例外は投げない。失敗は分類に落とす)。 */
  readonly fetchYear: (year: number) => Promise<BabaPastYearOutcome>;
  /** PDF を 1 本取る(`path` は年の頁から読んだ `archive/` からの相対)。例外は投げない。 */
  readonly fetchPdf: (path: string) => Promise<BabaPastPdfOutcome>;
  readonly log: (line: string) => void;
}

/** 管理者の読み取り口に出す進み具合(PDF の名前・URL は含まない)。 */
export interface BabaPastBackfillStatus {
  readonly enabled: boolean;
  /** 取る年の範囲(両端を含む)。 */
  readonly firstYear: number;
  readonly lastYear: number;
  readonly finished: boolean;
  readonly waitReason: string | null;
  /** 数えている日(JST。YYYYMMDD)と、その日に書いた行数。 */
  readonly day: string | null;
  readonly dayRows: number;
  /** 積んで、まだ取っていない PDF の数。 */
  readonly queued: number;
  /** 年の頁の状態(`ok` か、飛ばした理由の分類)。 */
  readonly years: Readonly<Record<string, string>>;
}

const DAY_MS = 86_400_000;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Error" : "non-error";
}

function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 一時的な失敗(あとで取り直す)か。 */
export function isTransientFailure(reason: BabaPastFetchFailure): boolean {
  if (reason === "timeout" || reason === "network") return true;
  if (!reason.startsWith("http-")) return false;
  const status = Number(reason.slice(5));
  return status === 408 || status === 429 || status >= 500;
}

type Unit = { readonly kind: "pdf"; readonly link: BabaPastLink } | { readonly kind: "year"; readonly year: number } | { readonly kind: "finished" };

export class JraBabaPastBackfillCore {
  private readonly deps: JraBabaPastBackfillDeps;
  private readonly enabled: boolean;
  private readonly dailyRows: number;
  private readonly firstYear: number;
  private readonly lastYear: number;
  private readonly metaCache = new Map<string, string | null>();

  constructor(deps: JraBabaPastBackfillDeps, options: JraBabaPastBackfillOptions = {}) {
    this.deps = deps;
    this.enabled = options.enabled === true;
    this.dailyRows =
      options.dailyRows !== undefined && Number.isInteger(options.dailyRows) && options.dailyRows >= 1 ? Math.min(options.dailyRows, BABA_PAST_DAILY_ROWS_MAX) : BABA_PAST_DAILY_ROWS_MAX;
    this.firstYear = options.firstYear ?? BABA_PAST_FIRST_YEAR;
    this.lastYear = options.lastYear ?? BABA_PAST_LAST_YEAR;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bp_years (year INTEGER PRIMARY KEY, state TEXT NOT NULL)");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bp_queue (ord INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, year INTEGER NOT NULL, venue_code TEXT NOT NULL, kai INTEGER NOT NULL)");
  }

  // ---- 状態の読み書き(主キーの引きだけ) ----

  private metaGet(key: string): string | null {
    const cached = this.metaCache.get(key);
    if (cached !== undefined) return cached;
    const rows = this.deps.sql.exec("SELECT value FROM bp_meta WHERE key = ?", key).toArray() as { value: string }[];
    const value = rows[0]?.value ?? null;
    this.metaCache.set(key, value);
    return value;
  }

  /** 値が変わるときだけ書く(DO の SQLite の書き込み行数を減らす)。 */
  private metaSet(key: string, value: string): void {
    if (this.metaGet(key) === value) return;
    this.deps.sql.exec("INSERT INTO bp_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    this.metaCache.set(key, value);
  }

  private metaNum(key: string): number {
    const n = Number(this.metaGet(key));
    return Number.isFinite(n) ? n : 0;
  }

  /** 管理者の読み取り口用。年は高々数本、積んだ PDF は高々数百本の小さな表。 */
  async status(): Promise<BabaPastBackfillStatus> {
    const years: Record<string, string> = {};
    for (let y = this.firstYear; y <= this.lastYear; y++) {
      const row = (this.deps.sql.exec("SELECT state FROM bp_years WHERE year = ?", y).toArray() as { state: string }[])[0];
      if (row !== undefined) years[String(y)] = row.state;
    }
    const queued = (this.deps.sql.exec("SELECT COUNT(*) AS n FROM bp_queue").toArray() as { n: number }[])[0]?.n ?? 0;
    return {
      enabled: this.enabled,
      firstYear: this.firstYear,
      lastYear: this.lastYear,
      finished: this.metaGet("finished") === "1",
      waitReason: this.metaGet("wait_reason"),
      day: this.metaGet("day"),
      dayRows: this.metaNum("day_rows"),
      queued,
      years,
    };
  }

  // ---- アラーム ----

  /** アラームが無ければ張る(cron の `scheduled` が呼ぶ)。止まっている・終わっていれば張らない。 */
  async kick(): Promise<void> {
    if (!this.enabled) return;
    if (this.metaGet("finished") === "1") return;
    const now = this.deps.now();
    if (!shouldRearm(await this.deps.getAlarm(), now, (iso) => this.deps.log(`jra-baba-past-backfill: stale alarm at=${iso} re-armed`))) return;
    await this.deps.setAlarm(nextBlinkerBackfillStart(now));
  }

  /** アラーム: 次の起床を 1 回実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.step();
    } catch (error) {
      this.deps.log(`jra-baba-past-backfill: step failed error=${errorKind(error)}`);
      try {
        if (this.countFailure()) {
          await this.halt();
        } else {
          await this.deps.setAlarm(this.deps.now() + BABA_PAST_ERROR_RETRY_MS);
        }
      } catch {
        // アラームを張れなければ、cron の kick が張り直す。
      }
    }
  }

  /** 失敗の連続を 1 つ増やす。上限に達したら true(連続は 0 に戻す)。 */
  private countFailure(): boolean {
    const streak = this.metaNum("streak") + 1;
    if (streak >= BABA_PAST_FAILURE_LIMIT) {
      this.metaSet("streak", "0");
      return true;
    }
    this.metaSet("streak", String(streak));
    return false;
  }

  private async halt(): Promise<void> {
    this.metaSet("wait_reason", "halted");
    this.deps.log("jra-baba-past-backfill: halted (consecutive failures); resumes next evening");
    await this.deps.setAlarm(nextBlinkerDayEvening(this.deps.now()));
  }

  // ---- 次にやること ----

  private nextUnit(): Unit {
    const row = (this.deps.sql.exec("SELECT path, year, venue_code, kai FROM bp_queue ORDER BY ord LIMIT 1").toArray() as { path: string; year: number; venue_code: string; kai: number }[])[0];
    if (row !== undefined) return { kind: "pdf", link: { path: row.path, year: row.year, venueCode: row.venue_code, kai: row.kai } };
    for (let year = this.firstYear; year <= this.lastYear; year++) {
      const done = (this.deps.sql.exec("SELECT 1 AS one FROM bp_years WHERE year = ?", year).toArray() as unknown[])[0];
      if (done === undefined) return { kind: "year", year };
    }
    return { kind: "finished" };
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
    if (this.dailyRows - this.metaNum("day_rows") < BABA_PAST_ROWS_PER_PDF_MAX) {
      this.metaSet("wait_reason", "daily-limit");
      await deps.setAlarm(start - (((start + JST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS + DAY_MS + 18 * 60 * 60_000);
      return;
    }

    const unit = this.nextUnit();
    if (unit.kind === "finished") {
      this.metaSet("finished", "1");
      this.metaSet("wait_reason", "finished");
      deps.log("jra-baba-past-backfill: finished");
      return; // 最後まで進んだ: アラームを張らず、次の kick でも何もしない。
    }

    let failedWake = false;
    if (unit.kind === "year") {
      failedWake = await this.runYear(unit.year);
    } else {
      failedWake = await this.runPdf(unit.link);
    }
    if (failedWake) {
      if (this.countFailure()) {
        await this.halt();
        return;
      }
    } else {
      this.metaSet("streak", "0");
    }
    this.metaSet("wait_reason", "active");
    await deps.setAlarm(deps.now() + BABA_PAST_GAP_MS);
  }

  /** 年の頁を 1 本取って、PDF を積む。起床が失敗(連続に数える)なら true。 */
  private async runYear(year: number): Promise<boolean> {
    const { deps } = this;
    const outcome = await deps.fetchYear(year);
    if (outcome.kind === "failed") {
      if (isTransientFailure(outcome.reason)) {
        deps.log("jra-baba-past-backfill: wake unit=page outcome=retry");
        return true;
      }
      deps.sql.exec("INSERT INTO bp_years (year, state) VALUES (?, ?) ON CONFLICT(year) DO NOTHING", year, outcome.reason);
      deps.log("jra-baba-past-backfill: wake unit=page outcome=skipped");
      return true;
    }
    const parsed = parseBabaPastYearPage(outcome.html, year);
    if (!parsed.ok) {
      deps.sql.exec("INSERT INTO bp_years (year, state) VALUES (?, ?) ON CONFLICT(year) DO NOTHING", year, parsed.result);
      deps.log("jra-baba-past-backfill: wake unit=page outcome=skipped");
      return true;
    }
    const done = new Set(await deps.store.filterDone(parsed.links.map((l) => l.path)));
    let queued = 0;
    for (const l of parsed.links) {
      if (done.has(l.path)) continue;
      deps.sql.exec("INSERT INTO bp_queue (path, year, venue_code, kai) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING", l.path, l.year, l.venueCode, l.kai);
      queued += 1;
    }
    deps.sql.exec("INSERT INTO bp_years (year, state) VALUES (?, 'ok') ON CONFLICT(year) DO NOTHING", year);
    deps.log(`jra-baba-past-backfill: wake unit=page outcome=queued listed=${parsed.links.length} queued=${queued} skipped=${parsed.skipped}`);
    return false;
  }

  /** PDF を 1 本取って、読み、書く。起床が失敗(連続に数える)なら true。 */
  private async runPdf(link: BabaPastLink): Promise<boolean> {
    const { deps } = this;
    const outcome = await deps.fetchPdf(link.path);
    const base = { path: link.path, year: link.year, venueCode: link.venueCode, kai: link.kai };
    if (outcome.kind === "failed") {
      if (isTransientFailure(outcome.reason)) {
        deps.log("jra-baba-past-backfill: wake unit=file outcome=retry");
        return true;
      }
      const r = await deps.store.savePdf({ ...base, result: outcome.reason, rows: [], pdf: null, nowMs: deps.now() });
      this.finishPdf(link.path, r.written);
      deps.log(`jra-baba-past-backfill: wake unit=file outcome=recorded written=${r.written}`);
      return false;
    }
    const parsed = await parseBabaPastPdf(outcome.bytes);
    let result: string;
    let rows: Awaited<ReturnType<typeof parseBabaPastPdf>> extends infer R ? (R extends { ok: true; rows: infer X } ? X : never) : never = [];
    if (!parsed.ok) {
      result = parsed.result;
    } else if (parsed.year !== link.year || parsed.kai !== link.kai || parsed.venueCode !== link.venueCode || parsed.rows.length > BABA_PAST_ROWS_PER_PDF_MAX - 2) {
      result = "shape-mismatch";
    } else {
      result = "ok";
      rows = parsed.rows;
    }
    const r = await deps.store.savePdf({ ...base, result, rows, pdf: outcome.bytes, nowMs: deps.now() });
    this.finishPdf(link.path, r.written);
    deps.log(`jra-baba-past-backfill: wake unit=file outcome=${result === "ok" ? "saved" : "recorded"} written=${r.written}`);
    return false;
  }

  /** 書き込みが済んだ PDF を積みから外し、1 日の行数に数える(書けなかったら呼ばれない: 例外のまま抜ける)。 */
  private finishPdf(path: string, written: number): void {
    this.deps.sql.exec("DELETE FROM bp_queue WHERE path = ?", path);
    this.metaSet("day_rows", String(this.metaNum("day_rows") + written));
  }
}
