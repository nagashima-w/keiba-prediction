import { afterEach, describe, expect, it } from "vitest";

import {
  BABA_PAST_DAILY_ROWS_MAX,
  BABA_PAST_FAILURE_LIMIT,
  BABA_PAST_GAP_MS,
  BABA_PAST_ROWS_PER_PDF_MAX,
  isJraBabaPastBackfillEnabled,
  JraBabaPastBackfillCore,
  type BabaPastFetchFailure,
  type BabaPastPdfOutcome,
  type BabaPastYearOutcome,
  type JraBabaPastBackfillOptions,
} from "../src/jra-baba-past-backfill-core";
import type { BabaPastSaveInput, BabaPastStoreLike } from "../src/baba-past-repository";
import { buildPdf, layoutLines, type SynthBlock } from "./jra-baba-past-synth";
import { VENUE_BY_TRACK_CODE } from "../../packages/core/src/analysis/venue-codes";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #769: 過去の馬場の埋め戻しの段取り(`JraBabaPastBackfillCore`)。時計・アラーム・JRA への取得・D1 は偽物。DO の SQLite は本物の SQLite(node:sqlite)。
 * PDF・年の頁は、実物と同じ作りの合成(`jra-baba-past-synth.ts`)。時刻は JST で書く。
 */

/** 2026-11-<日> <時>:<分> JST のエポックミリ秒。 */
const jst = (day: number, h: number, mi = 0, s = 0): number => Date.UTC(2026, 10, day, h - 9, mi, s);

const SLUG_BY_CODE: Record<string, string> = { "05": "tokyo", "06": "nakayama", "09": "hanshin" };

const yearPage = (year: number, paths: readonly string[]): string =>
  `<html><head><title>${year}年の含水率・クッション値（馬場情報）　JRA</title></head><body>${paths.map((p) => `<li><a href="/keiba/baba/archive/${p}">第1回</a></li>`).join("")}</body></html>`;

const BLOCK: SynthBlock = {
  dateText: "（2021年1月29日～31日）",
  weekdays: ["金", "土", "日"],
  cushion: ["8.4", "8.8", "9.3"],
  turfGoal: ["18.6", "16.2", "14.6"],
  turfCorner4: ["18.8", "16.8", "14.5"],
  dirtGoal: ["12.8", "11.1", "10.2"],
  dirtCorner4: ["12.7", "11.1", "10.6"],
};
const pdfOf = (year: number, venueCode: string, kai: number, blocks: readonly SynthBlock[] = [BLOCK]): Uint8Array =>
  buildPdf(layoutLines(`${year}年第${kai}回${VENUE_BY_TRACK_CODE.get(venueCode)}競馬含水率・クッション値`, blocks));

class FakeStore implements BabaPastStoreLike {
  done = new Set<string>();
  filterCalls: string[][] = [];
  saves: BabaPastSaveInput[] = [];
  failSave = false;
  async filterDone(paths: readonly string[]): Promise<string[]> {
    this.filterCalls.push([...paths]);
    return paths.filter((p) => this.done.has(p));
  }
  async savePdf(input: BabaPastSaveInput): Promise<{ written: number; r2Key: string | null }> {
    if (this.failSave) throw new Error("D1 down");
    this.saves.push(input);
    this.done.add(input.path);
    return { written: input.rows.length + 2, r2Key: input.pdf === null ? null : `baba-past/${input.path}` };
  }
}

class Harness {
  sql: NodeSql = openNodeSql();
  now = jst(10, 20);
  alarm: number | null = null;
  store = new FakeStore();
  /** 年 → 年の頁の結果。 */
  years = new Map<number, BabaPastYearOutcome[]>();
  /** path → PDF の結果(順に使い、最後を使い続ける)。 */
  pdfs = new Map<string, BabaPastPdfOutcome[]>();
  fetched: { what: string; at: number }[] = [];
  logs: string[] = [];
  core!: JraBabaPastBackfillCore;
  constructor(readonly options: JraBabaPastBackfillOptions = { enabled: true }) {}

  start(): void {
    this.core = this.makeCore();
  }
  makeCore(): JraBabaPastBackfillCore {
    return new JraBabaPastBackfillCore(
      {
        sql: this.sql,
        now: () => this.now,
        setAlarm: (at) => {
          this.alarm = at;
        },
        getAlarm: async () => this.alarm,
        store: this.store,
        fetchYear: async (year) => {
          this.fetched.push({ what: `year:${year}`, at: this.now });
          const list = this.years.get(year) ?? [{ kind: "failed", reason: "http-404" }];
          return list.length > 1 ? list.shift()! : list[0]!;
        },
        fetchPdf: async (path) => {
          this.fetched.push({ what: path, at: this.now });
          const list = this.pdfs.get(path) ?? [{ kind: "failed", reason: "http-404" }];
          return list.length > 1 ? list.shift()! : list[0]!;
        },
        log: (line) => this.logs.push(line),
      },
      this.options,
    );
  }
  addYear(year: number, venueCodes: readonly string[], blocks?: readonly SynthBlock[]): string[] {
    const paths = venueCodes.map((code, i) => `${year}pdf/${SLUG_BY_CODE[code]}${String(i + 1).padStart(2, "0")}.pdf`);
    this.years.set(year, [{ kind: "page", html: yearPage(year, paths) }]);
    venueCodes.forEach((code, i) => this.pdfs.set(paths[i]!, [{ kind: "pdf", bytes: pdfOf(year, code, i + 1, blocks) }]));
    return paths;
  }
  /** 起きて 1 回動く。 */
  async wake(): Promise<void> {
    await this.core.runNextStep();
  }
  /** アラームの時刻まで時計を進めて 1 回動く。 */
  async tick(): Promise<void> {
    if (this.alarm !== null && this.alarm > this.now) this.now = this.alarm;
    await this.wake();
  }
  fetchedWhat(): string[] {
    return this.fetched.map((f) => f.what);
  }
}

let h: Harness | undefined;
afterEach(() => h?.sql.close());

const opts = (extra: Partial<JraBabaPastBackfillOptions> = {}): JraBabaPastBackfillOptions => ({ enabled: true, firstYear: 2021, lastYear: 2021, ...extra });

describe("止める var(\"1\" だけが有効。既定は止まっている)", () => {
  it("isJraBabaPastBackfillEnabled: 前後の空白を除いて \"1\" だけが true。未設定・\"0\"・\"true\"・空・\"10\" は false", () => {
    expect(isJraBabaPastBackfillEnabled("1")).toBe(true);
    expect(isJraBabaPastBackfillEnabled(" 1 ")).toBe(true);
    for (const v of [undefined, "0", "true", "", "10", "yes", "on"]) expect(isJraBabaPastBackfillEnabled(v), String(v)).toBe(false);
  });

  it("options を省くと(enabled が無いと)止まっている: アラームを張らず、起きても何も取らない", async () => {
    h = new Harness({});
    h.addYear(2021, ["05"]);
    h.start();
    await h.core.kick();
    expect(h.alarm).toBeNull();
    await h.wake();
    expect(h.fetched).toEqual([]);
  });

  it("enabled: false でも同じ", async () => {
    h = new Harness({ enabled: false });
    h.addYear(2021, ["05"]);
    h.start();
    await h.core.kick();
    await h.wake();
    expect(h.alarm).toBeNull();
    expect(h.fetched).toEqual([]);
  });
});

describe("kick・時間帯", () => {
  it("時間帯(JST 18:00〜翌 8:00)の中なら、いまの時刻にアラームを張る。すでにあれば張り直さない", async () => {
    h = new Harness(opts());
    h.addYear(2021, ["05"]);
    h.start();
    await h.core.kick();
    expect(h.alarm).toBe(h.now);
    const before = h.alarm;
    h.now += 1000;
    await h.core.kick();
    expect(h.alarm).toBe(before);
  });

  it("時間帯の外(JST 12:00)は、その日の 18:00 にアラームを張る。起きても取らず、時間帯の始まりまで待つ", async () => {
    h = new Harness(opts());
    h.addYear(2021, ["05"]);
    h.now = jst(10, 12);
    h.start();
    await h.core.kick();
    expect(h.alarm).toBe(jst(10, 18));
    await h.wake();
    expect(h.fetched).toEqual([]);
    expect(h.alarm).toBe(jst(10, 18));
    expect((await h.core.status()).waitReason).toBe("outside-window");
  });

  it("JST 8:00 ちょうどは時間帯の外(7:59:59 は中)", async () => {
    h = new Harness(opts());
    h.addYear(2021, ["05"]);
    h.now = jst(11, 8);
    h.start();
    await h.wake();
    expect(h.fetched).toEqual([]);
    h.now = jst(11, 7, 59, 59);
    await h.wake();
    expect(h.fetchedWhat()).toEqual(["year:2021"]);
  });
});

describe("1 回の起床で 1 本だけ取る(年の頁 → PDF を 1 本ずつ)", () => {
  it("最初の起床は年の頁だけ。PDF の名前を積み、次のアラームは 3,000ms 後。そのあとは 1 起床 1 本で、PDF の順に取る", async () => {
    h = new Harness(opts());
    const paths = h.addYear(2021, ["05", "06", "09"]);
    h.start();
    await h.wake();
    expect(h.fetchedWhat()).toEqual(["year:2021"]);
    expect(h.alarm).toBe(h.now + BABA_PAST_GAP_MS);
    expect(h.store.filterCalls).toEqual([paths]);
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.fetchedWhat()).toEqual(["year:2021", ...paths]);
    // 取得の開始の間隔は 3,000ms 以上
    const at = h.fetched.map((f) => f.at);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!, `間隔 ${i}`).toBeGreaterThanOrEqual(3000);
    expect(BABA_PAST_GAP_MS).toBeGreaterThanOrEqual(3000);
  });

  it("読めた PDF は、行(曜日・日付・値)と PDF のバイト列を保存に渡す。書いた行数を 1 日の行数に数える", async () => {
    h = new Harness(opts());
    const [path] = h.addYear(2021, ["05"]);
    h.start();
    await h.wake();
    await h.tick();
    expect(h.store.saves).toHaveLength(1);
    const s = h.store.saves[0]!;
    expect([s.path, s.year, s.venueCode, s.kai, s.result]).toEqual([path, 2021, "05", 1, "ok"]);
    expect(s.rows.map((r) => [r.kaisaiDate, r.weekday, r.cushion])).toEqual([["20210129", "金", 8.4], ["20210130", "土", 8.8], ["20210131", "日", 9.3]]);
    expect(s.pdf).not.toBeNull();
    expect(s.nowMs).toBe(h.now);
    expect((await h.core.status()).dayRows).toBe(3 + 2);
  });

  it("取り終えた PDF(保存済み)は積まず、取らない。全部取り終えていれば、次の年へ進む", async () => {
    h = new Harness(opts({ firstYear: 2021, lastYear: 2022 }));
    const p21 = h.addYear(2021, ["05", "06"]);
    const p22 = h.addYear(2022, ["09"]);
    h.store.done.add(p21[0]!);
    h.store.done.add(p21[1]!);
    h.start();
    await h.wake(); // 年の頁 2021
    await h.tick(); // 年の頁 2022(2021 は積むものが無い)
    await h.tick(); // 2022 の PDF
    expect(h.fetchedWhat()).toEqual(["year:2021", "year:2022", p22[0]]);
  });

  it("全部の年・PDF を終えたら finished: アラームを張らず、次の kick でも動かない", async () => {
    h = new Harness(opts());
    h.addYear(2021, ["05"]);
    h.start();
    await h.wake();
    await h.tick();
    await h.tick();
    const st = await h.core.status();
    expect(st.finished).toBe(true);
    expect(st.queued).toBe(0);
    h.alarm = null;
    await h.core.kick();
    expect(h.alarm).toBeNull();
    const n = h.fetched.length;
    await h.wake();
    expect(h.fetched.length).toBe(n);
  });

  it("DO を作り直しても(再起動)、続きから進む(年の頁を取り直さず、積んだ PDF から)", async () => {
    h = new Harness(opts());
    const paths = h.addYear(2021, ["05", "06"]);
    h.start();
    await h.wake();
    await h.tick();
    h.core = h.makeCore();
    await h.tick();
    expect(h.fetchedWhat()).toEqual(["year:2021", paths[0], paths[1]]);
  });

  it("年の範囲は options で変えられる(2018〜2020)。年の頁は年の順に取る", async () => {
    h = new Harness(opts({ firstYear: 2018, lastYear: 2020 }));
    for (const y of [2018, 2019, 2020]) h.addYear(y, ["05"]);
    h.start();
    await h.wake();
    expect(h.fetchedWhat()).toEqual(["year:2018"]);
    for (let i = 0; i < 5; i++) await h.tick();
    expect(h.fetchedWhat()).toEqual(["year:2018", "2018pdf/tokyo01.pdf", "year:2019", "2019pdf/tokyo01.pdf", "year:2020", "2020pdf/tokyo01.pdf"]);
  });

  it("年の範囲の既定は 2021〜2024", async () => {
    h = new Harness({ enabled: true });
    h.start();
    await h.wake();
    for (let i = 0; i < 6; i++) await h.tick();
    expect(h.fetchedWhat().filter((w) => w.startsWith("year:")).slice(0, 4)).toEqual(["year:2021", "year:2022", "year:2023", "year:2024"]);
    expect(h.fetchedWhat()).not.toContain("year:2025");
  });
});

describe("読めない形・取れない PDF は分類して記録し、止めない", () => {
  it("PDF でないバイト列は not-pdf、読めない形は shape-mismatch(行は渡さない・PDF のバイト列は渡す)。次の PDF へ進む", async () => {
    h = new Harness(opts());
    const [a, b, c] = h.addYear(2021, ["05", "06", "09"]);
    h.pdfs.set(a!, [{ kind: "pdf", bytes: new TextEncoder().encode("<html>x</html>") }]);
    h.pdfs.set(b!, [{ kind: "pdf", bytes: buildPdf(layoutLines("2021年第2回中山競馬含水率", [{ ...BLOCK, turfGoal: ["1.0", "2.0"] }])) }]);
    h.start();
    await h.wake();
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.store.saves.map((s) => [s.path, s.result, s.rows.length, s.pdf !== null])).toEqual([[a, "not-pdf", 0, true], [b, "shape-mismatch", 0, true], [c, "ok", 3, true]]);
  });

  it("PDF の見出し(年・回・場)が頁の PDF の名前と食い違うときは shape-mismatch(別の PDF の行を保存しない)", async () => {
    h = new Harness(opts());
    const [a] = h.addYear(2021, ["05"]);
    h.pdfs.set(a!, [{ kind: "pdf", bytes: pdfOf(2021, "06", 1) }]); // 見出しは中山
    h.start();
    await h.wake();
    await h.tick();
    expect(h.store.saves.map((s) => [s.result, s.rows.length])).toEqual([["shape-mismatch", 0]]);
  });

  it("PDF の見出しの回・年が頁の PDF の名前と食い違うときも shape-mismatch(場が合っていても)", async () => {
    h = new Harness(opts());
    const [a, b] = h.addYear(2021, ["05", "06"]);
    h.pdfs.set(a!, [{ kind: "pdf", bytes: pdfOf(2021, "05", 2) }]); // 回が違う(名前は 1 回)
    h.pdfs.set(b!, [{ kind: "pdf", bytes: buildPdf(layoutLines("2022年第2回中山競馬含水率・クッション値", [{ ...BLOCK, dateText: "（2022年1月28日～30日）" }])) }]); // 年が違う
    h.start();
    await h.wake();
    await h.tick();
    await h.tick();
    expect(h.store.saves.map((s) => [s.path, s.result, s.rows.length])).toEqual([[a, "shape-mismatch", 0], [b, "shape-mismatch", 0]]);
  });

  it("一時的な失敗が続いても、間に読めた起床があれば連続は 0 に戻る(2 回失敗 → 成功 → 2 回失敗では止まらない)", async () => {
    h = new Harness(opts());
    const [a, b] = h.addYear(2021, ["05", "06"]);
    const good = (code: string, kai: number): BabaPastPdfOutcome => ({ kind: "pdf", bytes: pdfOf(2021, code, kai) });
    h.pdfs.set(a!, [{ kind: "failed", reason: "timeout" }, { kind: "failed", reason: "timeout" }, good("05", 1)]);
    h.pdfs.set(b!, [{ kind: "failed", reason: "timeout" }, { kind: "failed", reason: "timeout" }, good("06", 2)]);
    h.start();
    await h.wake(); // 年の頁
    for (let i = 0; i < 3; i++) await h.tick(); // a: 失敗・失敗・成功
    expect(h.store.saves.map((s) => s.path)).toEqual([a]);
    await h.tick(); // b: 失敗(連続 1。ここで止まるなら連続が戻っていない)
    expect((await h.core.status()).waitReason).toBe("active");
    await h.tick(); // b: 失敗(連続 2)
    expect((await h.core.status()).waitReason).toBe("active");
    await h.tick();
    expect(h.store.saves.map((s) => s.path)).toEqual([a, b]);
  });

  it("1 本の PDF の行数が上限を超える(63 行)ときは shape-mismatch。上限ちょうど(60 行)は保存する", async () => {
    const maxRows = BABA_PAST_ROWS_PER_PDF_MAX - 2;
    expect(maxRows).toBeGreaterThan(40);
    // 21 塊 × 3 日 = 63 行(週ごとにずらした日付。月末をまたぐ週は終わりの月を書く)
    const weeks = Array.from({ length: 21 }, (_, i) => {
      const s = new Date(Date.UTC(2021, 0, 29 + 7 * i));
      const e = new Date(s.getTime() + 2 * 86_400_000);
      return { ...BLOCK, dateText: `（${s.getUTCFullYear()}年${s.getUTCMonth() + 1}月${s.getUTCDate()}日～${e.getUTCMonth() + 1}月${e.getUTCDate()}日）` };
    });
    h = new Harness(opts());
    h.addYear(2021, ["05"], weeks);
    h.start();
    await h.wake();
    await h.tick();
    expect(weeks.length * 3).toBeGreaterThan(maxRows);
    expect(h.store.saves.map((s) => [s.result, s.rows.length])).toEqual([["shape-mismatch", 0]]);
    h.sql.close();
    h = new Harness(opts());
    h.addYear(2021, ["05"], weeks.slice(0, maxRows / 3));
    h.start();
    await h.wake();
    await h.tick();
    expect(h.store.saves.map((s) => [s.result, s.rows.length])).toEqual([["ok", maxRows]]);
  });

  const permanent: BabaPastFetchFailure[] = ["http-404", "http-403", "http-410", "redirect", "too-large"];
  for (const reason of permanent) {
    it(`取得の失敗 ${reason} は、PDF なしで分類だけを記録し、同じ PDF を取り直さない`, async () => {
      h = new Harness(opts());
      const [a, b] = h.addYear(2021, ["05", "06"]);
      h.pdfs.set(a!, [{ kind: "failed", reason }]);
      h.start();
      await h.wake();
      await h.tick();
      await h.tick();
      expect(h.store.saves.map((s) => [s.path, s.result, s.pdf, s.rows.length])).toEqual([[a, reason, null, 0], [b, "ok", expect.anything(), 3]]);
      expect(h.fetchedWhat().filter((w) => w === a)).toHaveLength(1);
    });
  }

  const transient: BabaPastFetchFailure[] = ["timeout", "network", "http-500", "http-503", "http-408", "http-429"];
  for (const reason of transient) {
    it(`取得の失敗 ${reason} は記録せず、同じ PDF を次の起床で取り直す。取れたら保存する`, async () => {
      h = new Harness(opts());
      const [a] = h.addYear(2021, ["05"]);
      h.pdfs.set(a!, [{ kind: "failed", reason }, { kind: "pdf", bytes: pdfOf(2021, "05", 1) }]);
      h.start();
      await h.wake();
      await h.tick();
      expect(h.store.saves).toEqual([]);
      expect((await h.core.status()).queued).toBe(1);
      await h.tick();
      expect(h.store.saves.map((s) => s.result)).toEqual(["ok"]);
      expect(h.fetchedWhat().filter((w) => w === a)).toHaveLength(2);
    });
  }

  it("一時的な失敗が連続 3 回の起床で続いたら止まる(翌日 18:00 に再開)。読めた起床で連続は 0 に戻る", async () => {
    expect(BABA_PAST_FAILURE_LIMIT).toBe(3);
    h = new Harness(opts());
    const [a] = h.addYear(2021, ["05"]);
    h.pdfs.set(a!, [{ kind: "failed", reason: "timeout" }]);
    h.start();
    await h.wake(); // 年の頁(読めた)
    await h.tick(); // 失敗 1
    await h.tick(); // 失敗 2
    expect((await h.core.status()).waitReason).toBe("active");
    await h.tick(); // 失敗 3 → 止まる
    expect((await h.core.status()).waitReason).toBe("halted");
    expect(h.alarm).toBe(jst(11, 18));
    // 翌日 18:00 に再開(連続は 0 に戻っている)
    h.pdfs.set(a!, [{ kind: "pdf", bytes: pdfOf(2021, "05", 1) }]);
    await h.tick();
    expect(h.store.saves.map((s) => s.result)).toEqual(["ok"]);
    expect(h.fetched.at(-1)!.at).toBe(jst(11, 18));
  });

  it("保存(D1)が失敗したら例外にせず、10 分後に取り直す。PDF は積んだまま。連続 3 回で止まる", async () => {
    h = new Harness(opts());
    h.addYear(2021, ["05"]);
    h.start();
    await h.wake();
    h.store.failSave = true;
    const t0 = h.now;
    await h.tick();
    expect(h.alarm).toBe(t0 + BABA_PAST_GAP_MS + 10 * 60_000);
    expect((await h.core.status()).queued).toBe(1);
    await h.tick();
    await h.tick();
    expect((await h.core.status()).waitReason).toBe("halted");
    h.store.failSave = false;
    await h.tick();
    expect(h.store.saves.map((s) => s.result)).toEqual(["ok"]);
  });
});

describe("年の頁", () => {
  it("取れたが読めない年の頁(題名が違う)は、その年を飛ばして記録し、次の年へ進む", async () => {
    h = new Harness(opts({ firstYear: 2021, lastYear: 2022 }));
    h.years.set(2021, [{ kind: "page", html: "<html><head><title>エラー</title></head></html>" }]);
    h.addYear(2022, ["05"]);
    h.start();
    await h.wake();
    expect((await h.core.status()).years).toEqual({ "2021": "shape-mismatch" });
    await h.tick();
    expect(h.fetchedWhat()).toEqual(["year:2021", "year:2022"]);
    expect((await h.core.status()).years).toEqual({ "2021": "shape-mismatch", "2022": "ok" });
  });

  it("年の頁の取得の失敗: 一時的なもの(timeout・5xx)は取り直し(年は記録しない)、http-404 などは飛ばして記録する", async () => {
    h = new Harness(opts({ firstYear: 2021, lastYear: 2022 }));
    h.years.set(2021, [{ kind: "failed", reason: "http-503" }, { kind: "page", html: yearPage(2021, ["2021pdf/tokyo01.pdf"]) }]);
    h.years.set(2022, [{ kind: "failed", reason: "http-404" }]);
    h.pdfs.set("2021pdf/tokyo01.pdf", [{ kind: "pdf", bytes: pdfOf(2021, "05", 1) }]);
    h.start();
    await h.wake();
    expect((await h.core.status()).years).toEqual({});
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.fetchedWhat()).toEqual(["year:2021", "year:2021", "2021pdf/tokyo01.pdf", "year:2022"]);
    expect((await h.core.status()).years).toEqual({ "2021": "ok", "2022": "http-404" });
  });
});

describe("1 日の書き込み行数の上限(500 行)", () => {
  it("上限は 500 行。var で下げることだけできる(上限を超える値・不正な値は既定)", async () => {
    expect(BABA_PAST_DAILY_ROWS_MAX).toBe(500);
    for (const [given, expected] of [[100, 100], [501, 500], [0, 500], [-3, 500], [1.5, 500], [undefined, 500]] as const) {
      h = new Harness(opts(given === undefined ? {} : { dailyRows: given }));
      const [path] = h.addYear(2021, ["05"]);
      void path;
      h.start();
      // 上限の直前まで書いたことにする
      await h.wake();
      (h.core as unknown as { metaSet(k: string, v: string): void }).metaSet("day", "20261110");
      (h.core as unknown as { metaSet(k: string, v: string): void }).metaSet("day_rows", String(expected - BABA_PAST_ROWS_PER_PDF_MAX));
      const before = h.fetched.length;
      await h.tick();
      expect(h.fetched.length, `${String(given)}: 残りが 1 PDF の最大ちょうどなら取る`).toBe(before + 1);
      h.sql.close();
      h = new Harness(opts(given === undefined ? {} : { dailyRows: given }));
      h.addYear(2021, ["05"]);
      h.start();
      await h.wake();
      (h.core as unknown as { metaSet(k: string, v: string): void }).metaSet("day", "20261110");
      (h.core as unknown as { metaSet(k: string, v: string): void }).metaSet("day_rows", String(expected - BABA_PAST_ROWS_PER_PDF_MAX + 1));
      const b2 = h.fetched.length;
      await h.tick();
      expect(h.fetched.length, `${String(given)}: 残りが 1 PDF の最大に 1 足りなければ取らない`).toBe(b2);
      h.sql.close();
    }
    h = undefined;
  });

  it("残りが足りない起床は取らず、翌日 18:00 まで休む。日が変わると(JST の暦の日)数え直す", async () => {
    h = new Harness(opts({ dailyRows: BABA_PAST_ROWS_PER_PDF_MAX + 4 }));
    h.addYear(2021, ["05", "06", "09"]);
    h.start();
    await h.wake(); // 年の頁
    await h.tick(); // 1 本目: 3 行 + 2 = 5 行
    expect((await h.core.status()).dayRows).toBe(5);
    await h.tick(); // 残り 59 + 4 - 5 ... 残りが 1 PDF の最大 (60) 未満 → 休む
    expect((await h.core.status()).waitReason).toBe("daily-limit");
    expect(h.alarm).toBe(jst(11, 18));
    expect(h.store.saves).toHaveLength(1);
    await h.tick(); // 翌日
    expect(h.store.saves).toHaveLength(2);
    expect((await h.core.status()).dayRows).toBe(5);
  });

  it("日付の変わり目は JST: UTC では同じ日でも、JST の 0:00 を過ぎれば数え直す", async () => {
    h = new Harness(opts());
    h.addYear(2021, ["05", "06"]);
    h.now = jst(10, 23, 59, 50);
    h.start();
    await h.wake();
    await h.tick(); // 23:59:53
    expect((await h.core.status()).dayRows).toBe(5);
    h.now = jst(11, 0, 0, 10);
    await h.wake();
    expect((await h.core.status()).day).toBe("20261111");
    expect((await h.core.status()).dayRows).toBe(5); // 数え直して、2 本目の分だけ
  });
});

describe("ログ", () => {
  it("固定の文と数だけ。PDF の名前・URL・本文・例外のメッセージを出さない", async () => {
    h = new Harness(opts());
    h.addYear(2021, ["05"]);
    h.start();
    await h.wake();
    h.store.failSave = true;
    await h.tick();
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line, line).not.toMatch(/pdf|http|D1 down|jra\.go\.jp|tokyo/i);
      expect(line.startsWith("jra-baba-past-backfill:")).toBe(true);
    }
  });
});
