import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { GateResult } from "../src/gate-core";
import { buildOikiriArchiveOptions, OIKIRI_ARCHIVE_REQUEST_INTERVAL_MS, RaceArchiveFetchCore, type ArchiveFetchOptions, type ArchiveNotice } from "../src/race-archive-fetch-core";
import type { RaceArchiveCatalogEntry } from "../src/race-archive-repository";
import type { RaceOikiriInput, SaveRaceOikiriResult } from "../src/race-oikiri-repository";
import { oikiriUrl } from "../../packages/core/src/scraper/urls";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { pathFromMeta } from "./meta-path.js";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #731: 過去(2021〜)の中央のレースの追い切りの評価を取る(`RaceArchiveFetchCore` を `oikiri: true` で動かす)。
 * 時計・アラーム・gate・保存・通知・目録は偽物、状態は本物の SQLite。実サイトには出ない。中央・地方の結果の取得の挙動は
 * `race-archive-fetch-core.test.ts`・`race-archive-fetch-core-nar.test.ts` が固定している(こちらは追い切りだけ)。
 */

const loadFixture = (name: string): string => readFileSync(pathFromMeta(`../../fixtures/${name}`, import.meta.url), "utf-8");
const JST = 9 * 3600_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const jst = (y: number, month: number, day: number, hour: number, minute = 0): number => Date.UTC(y, month - 1, day, hour, minute) - JST;
/** 既定の「今」: 2026-11-12(木)0:00 JST(対象の開催日より後)。 */
const T0 = jst(2026, 11, 12, 0);

/** 実物(2021-01-30 東京 1R の追い切り。16 頭)。どのレースの URL にも、この中身を返す(パーサは race_id を見ない)。 */
const PAGE = loadFixture("oikiri_202105010101.html");
const NO_TABLE_PAGE = "<html><body><div>追い切りのデータがありません</div></body></html>";

const enc = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};
const ok = (html: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html", body: enc(html), queuedMs: 0, elapsedMs: 1 });
const status = (code: number): GateResult => ({ kind: "response", status: code, contentType: "text/html", body: enc(""), queuedMs: 0, elapsedMs: 1 });
const urlOf = (raceId: string): string => oikiriUrl(parseRaceId(raceId));

const cat = (raceId: string, kind: "central" | "nar", raceDate: string): RaceArchiveCatalogEntry => ({ raceId, kind, raceDate, parserVersion: 1, r2Key: `race-results/${raceId}.json.gz`, rawBytes: 1, fetchedAt: "2026-11-01T00:00:00.000Z", runsVersion: null });
const CENTRAL_A = cat("202105010101", "central", "2021-01-30");
const CENTRAL_B = cat("202105010102", "central", "2021-01-30");
const CENTRAL_C = cat("202205010101", "central", "2022-01-29");
const NAR_X = cat("202146110310", "nar", "2021-11-03");

class World {
  now = T0;
  alarm: number | null = null;
  readonly sql: NodeSql = openNodeSql();
  readonly fetchLog: string[] = [];
  readonly saved: RaceOikiriInput[] = [];
  readonly notices: ArchiveNotice[] = [];
  readonly routes = new Map<string, GateResult>();
  readonly pageCalls: { after: string; limit: number }[] = [];
  catalog: RaceArchiveCatalogEntry[] = [];
  /** 全レースに返す既定の応答(routes に無い URL)。 */
  defaultResponse: GateResult = ok(PAGE);
  saveResult: SaveRaceOikiriResult = { status: "saved", dbSizeBytes: 24_000_000 };
  saveThrows = false;
  catalogThrowsOnce = false;
  catalogEntryCalls = 0;
  planCalls = 0;
  plan: { stage: string; venues: { venue: string; state: string; listed: number | null }[] } = { stage: "done", venues: [{ venue: "central", state: "ok", listed: 0 }] };
  core: RaceArchiveFetchCore;

  constructor(options: ArchiveFetchOptions = {}) {
    this.core = new RaceArchiveFetchCore(
      {
        sql: { exec: (q: string, ...b: unknown[]) => { const c = this.sql.exec(q, ...b); return { toArray: () => c.toArray() }; } },
        now: () => this.now,
        setAlarm: (at) => { this.alarm = at; },
        getAlarm: async () => this.alarm,
        gate: {
          status: async () => ({ blockedUntil: null, consecutiveRefusals: 0, lastStartAt: null, pending: 0 }),
          fetchRaw: async (url) => { this.fetchLog.push(url); return this.routes.get(url) ?? this.defaultResponse; },
        },
        planProgress: async () => { this.planCalls += 1; return this.plan; },
        archive: {
          saveRaceArchive: async () => { throw new Error("追い切りの取得は結果の保存を呼ばない"); },
          getCatalogEntry: async () => { this.catalogEntryCalls += 1; return null; },
        },
        oikiri: {
          listCatalogPage: async (after, limit) => {
            this.pageCalls.push({ after, limit });
            if (this.catalogThrowsOnce) { this.catalogThrowsOnce = false; throw new Error("D1 の障害"); }
            return this.catalog.filter((e) => e.raceId > after).sort((a, b) => (a.raceId < b.raceId ? -1 : 1)).slice(0, limit);
          },
          saveRaceOikiri: async (input) => {
            if (this.saveThrows) throw new Error("D1 の障害");
            if (this.saveResult.status !== "skipped") this.saved.push(input);
            return this.saveResult;
          },
        },
        notify: async (n) => { this.notices.push(n); },
        log: () => undefined,
      },
      // 開始時刻は外す。間隔は小さくして試験が長くならないようにする(本番の 20 秒は buildOikiriArchiveOptions の試験で固定)。
      { oikiri: true, notBeforeMs: 0, intervalMs: 1500, windowEndMin: 1440, ...options },
    );
  }

  async runUntil(untilMs: number, maxSteps = 5000): Promise<void> {
    let steps = 0;
    while (this.alarm !== null && this.alarm <= untilMs && steps < maxSteps) {
      this.now = Math.max(this.now, this.alarm);
      this.alarm = null;
      await this.core.runNextStep();
      steps += 1;
    }
    expect(steps, "ステップ数の暴走がない").toBeLessThan(maxSteps);
  }
  raceRows(): { race_id: string; date: string; status: string; last_class: string | null; nights: number }[] {
    return this.sql.exec("SELECT race_id, date, status, last_class, nights FROM ra_race ORDER BY race_id").toArray() as never;
  }
}

const worlds: World[] = [];
const mk = (options?: ArchiveFetchOptions): World => {
  const w = new World(options);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) w.sql.close();
});

describe("追い切りの取得(oikiri: true)の通し(目録から流し込み → 追い切りのページ → 保存)", () => {
  it("中央の 2 レースだけを流し込み、追い切りの URL を新しい日から取り、race_oikiri 向けに 16 頭ずつ保存する。地方・結果の保存・目録の存在確認は使わない", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A, NAR_X, CENTRAL_C, CENTRAL_B];
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);

    // 流し込みは中央だけ(地方を含めると 3 件になる)
    expect(w.raceRows().map((r) => r.race_id)).toEqual(["202105010101", "202105010102", "202205010101"]);
    expect(w.raceRows().every((r) => r.status === "done")).toBe(true);
    // 取った URL は追い切りのページだけ(race ホスト)。新しい日(2022-01-29)から
    expect(w.fetchLog).toEqual([urlOf("202205010101"), urlOf("202105010101"), urlOf("202105010102")]);
    expect(w.fetchLog.every((u) => u.startsWith("https://race.netkeiba.com/race/oikiri.html?race_id="))).toBe(true);
    // 保存: 日付は目録の YYYY-MM-DD、16 頭、読めなかった行は 0。馬 ID とランクの取り違えを検出するため 1 頭目を固定
    expect(w.saved.map((s) => s.raceId)).toEqual(["202205010101", "202105010101", "202105010102"]);
    expect(w.saved.map((s) => s.raceDate)).toEqual(["2022-01-29", "2021-01-30", "2021-01-30"]);
    expect(w.saved.every((s) => s.entries.length === 16 && s.skippedRows === 0)).toBe(true);
    expect(w.saved[1]!.entries[0]).toMatchObject({ umaban: 1, horseId: "2018101424", rank: "C", critic: "目立たず" });
    // 結果の取得用の目録の存在確認は呼ばない(追い切りは結果の目録とは別の仕事)
    expect(w.catalogEntryCalls).toBe(0);
    const st = await w.core.getStatus();
    expect(st.totals.races).toMatchObject({ pending: 0, done: 3, skipped: 0, dead: 0 });
  });

  it("目録が 200 件を超えても、1 回の起床で目録を読むのは 1 ページ(200 件)だけ。カーソルで続きを読み、全件を入れる", async () => {
    const w = mk({ nightlyLimit: 1 });
    const ids: string[] = [];
    for (let place = 1; place <= 10; place += 1) for (let day = 1; day <= 12; day += 1) for (let race = 1; race <= 12; race += 1) ids.push(`2021${String(place).padStart(2, "0")}01${String(day).padStart(2, "0")}${String(race).padStart(2, "0")}`);
    w.catalog = ids.slice(0, 450).map((id) => cat(id, "central", "2021-01-30"));
    // race_id が 12 桁で一意であることを前提にする
    expect(new Set(w.catalog.map((e) => e.raceId)).size).toBe(450);
    expect(w.catalog.every((e) => e.raceId.length === 12)).toBe(true);
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.raceRows()).toHaveLength(450);
    expect(w.pageCalls.map((c) => c.limit)).toEqual([200, 200, 200]);
    expect(w.pageCalls[0]!.after).toBe("");
    expect(w.pageCalls[1]!.after).toBe(w.catalog[199]!.raceId);
    expect(w.pageCalls[2]!.after).toBe(w.catalog[399]!.raceId);
  });

  it("全部取り終えたあと、次の晩は目録を読み直して新しく増えたレースだけを取る(取り終えたレースは取り直さない)", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A, CENTRAL_B];
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.fetchLog).toHaveLength(2);
    w.catalog = [CENTRAL_A, CENTRAL_B, CENTRAL_C];
    await w.runUntil(T0 + DAY + 2 * HOUR);
    expect(w.fetchLog).toEqual([urlOf("202105010101"), urlOf("202105010102"), urlOf("202205010101")]);
    expect(w.saved).toHaveLength(3);
  });

  it("今日(その晩)の開催日のレースは取らない(発走前のページを取らず、翌日以降に取る)", async () => {
    const w = mk();
    w.catalog = [cat("202605010101", "central", "2026-11-12")];
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.fetchLog).toHaveLength(0);
    expect(w.raceRows()).toHaveLength(1);
    expect((await w.core.getStatus()).waitReason).toBe("caught-up");
    await w.runUntil(T0 + DAY + 2 * HOUR);
    expect(w.fetchLog).toEqual([urlOf("202605010101")]);
  });
});

describe("追い切りの取得: 読めないページ・空の馬", () => {
  it("追い切りの表が無いページ(200)は skipped(no-table)にして、以後取り直さない。保存しない。理由は skippedByClass に数える", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A];
    w.defaultResponse = ok(`<html><body>${NO_TABLE_PAGE}</body></html>`);
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.raceRows().map((r) => [r.status, r.last_class])).toEqual([["skipped", "no-table"]]);
    expect(w.saved).toHaveLength(0);
    await w.runUntil(T0 + 3 * DAY);
    expect(w.fetchLog).toHaveLength(1);
    expect((await w.core.getStatus()).skippedByClass).toEqual({ "no-table": 1 });
  });

  it("表はあるが読める行が 0 のページは skipped(no-entries)", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A];
    w.defaultResponse = ok(PAGE.replaceAll('class="Umaban">', 'class="Umaban">9'));
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.raceRows().map((r) => [r.status, r.last_class])).toEqual([["skipped", "no-entries"]]);
    expect(w.saved).toHaveLength(0);
  });

  it("途中で切れたページ(</html> が無い)・空の応答は invalid-page の失敗で pending のまま。3 晩試して駄目なら dead。保存しない", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A];
    w.defaultResponse = ok(PAGE.slice(0, PAGE.indexOf("</html>")));
    await w.core.kick();
    await w.runUntil(T0 + 5 * DAY);
    expect(w.fetchLog).toHaveLength(3); // 1 晩に 1 回ずつ、3 晩で諦める
    expect(w.raceRows().map((r) => [r.status, r.last_class, r.nights])).toEqual([["dead", "invalid-page", 3]]);
    expect(w.saved).toHaveLength(0);
    const w2 = mk();
    w2.catalog = [CENTRAL_A];
    w2.defaultResponse = ok("");
    await w2.core.kick();
    await w2.runUntil(T0 + 2 * HOUR);
    expect(w2.raceRows().map((r) => [r.status, r.last_class])).toEqual([["pending", "invalid-page"]]);
  });

  it("評語・ランクが空の馬は null のまま保存し、馬番が範囲外の行は捨てて skippedRows に数える", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A];
    // 馬番 1: 評語とランクを空に / 馬番 2: 馬番を 0(範囲外)に
    const html = PAGE.replace('class="Training_Critic">目立たず<', 'class="Training_Critic"><').replace('class="Rank_目立たず">C<', 'class="Rank_目立たず"><').replace('class="Umaban">2<', 'class="Umaban">0<');
    expect(html).not.toBe(PAGE);
    w.defaultResponse = ok(html);
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.saved).toHaveLength(1);
    const s = w.saved[0]!;
    expect(s.skippedRows).toBe(1);
    expect(s.entries).toHaveLength(15);
    expect(s.entries[0]).toMatchObject({ umaban: 1, horseId: "2018101424", rank: null, critic: null });
    expect(s.entries.some((e) => e.umaban === 2)).toBe(false);
    expect(w.raceRows()[0]!.status).toBe("done");
  });
});

describe("追い切りの取得: 上限・時間帯・開催日の朝", () => {
  it("1 晩の上限(nightlyLimit)を守る: 3 件で止まり、次の晩に続きを取る。上限を無視すると 5 件取ってしまう", async () => {
    const w = mk({ nightlyLimit: 3 });
    w.catalog = [0, 1, 2, 3, 4].map((i) => cat(`20210501010${i + 1}`, "central", "2021-01-30"));
    await w.core.kick();
    await w.runUntil(T0 + 12 * HOUR);
    expect(w.fetchLog).toHaveLength(3);
    expect((await w.core.getStatus()).waitReason).toBe("night-limit");
    await w.runUntil(T0 + DAY + 12 * HOUR);
    expect(w.fetchLog).toHaveLength(5);
    expect(new Set(w.fetchLog).size).toBe(5);
  });

  it("時間帯の外(既定の 8:30 まで)では取らない。時間帯の終わりを 1440 にした終日の設定なら 10:00 にも取る", async () => {
    const day = mk({ windowEndMin: 8 * 60 + 30 });
    day.catalog = [CENTRAL_A];
    day.now = T0 + 10 * HOUR;
    await day.core.kick();
    await day.runUntil(T0 + 20 * HOUR);
    expect(day.fetchLog).toHaveLength(0);
    expect(day.alarm).toBe(T0 + DAY); // 次に動くのは翌日 0:00(時間帯の始まり)
    const all = mk(); // windowEndMin: 1440
    all.catalog = [CENTRAL_A];
    all.now = T0 + 10 * HOUR;
    await all.core.kick();
    await all.runUntil(T0 + 12 * HOUR);
    expect(all.fetchLog).toHaveLength(1);
  });

  it("中央の開催日(計画が開催日)の朝も休まず取る: 計画の判定(日単位の DO)は一度も呼ばず、理由は kaisai-day にならない。skipCentralRaceDay: true を渡しても同じ", async () => {
    for (const options of [{}, { skipCentralRaceDay: true }] as ArchiveFetchOptions[]) {
      const w = mk(options);
      w.catalog = [CENTRAL_A];
      w.plan = { stage: "done", venues: [{ venue: "central", state: "ok", listed: 36 }] }; // 開催日
      await w.core.kick();
      await w.runUntil(T0 + 2 * HOUR);
      expect(w.fetchLog, JSON.stringify(options)).toHaveLength(1);
      expect(w.planCalls).toBe(0);
      expect((await w.core.getStatus()).waitReason).not.toBe("kaisai-day");
    }
  });

  it("リクエストの間隔(intervalMs)を空ける: 2 件目は 1 件目の開始から間隔以上あとに取る", async () => {
    const w = mk({ intervalMs: 20_000 });
    w.catalog = [CENTRAL_A, CENTRAL_B];
    const starts: number[] = [];
    await w.core.kick();
    // 1 ステップずつ進めて、取得ごとの時刻を記録する
    let seen = 0;
    for (let i = 0; i < 40 && w.alarm !== null; i += 1) {
      w.now = Math.max(w.now, w.alarm);
      w.alarm = null;
      await w.core.runNextStep();
      if (w.fetchLog.length > seen) {
        seen = w.fetchLog.length;
        starts.push(w.now);
      }
    }
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(20_000);
  });
});

describe("追い切りの取得: 止まり方(既存の流儀のまま)", () => {
  it.each([400, 403, 429])("HTTP %i で止める: 保存せず、次の晩に自動再開する状態(night-stopped)になり、追い切り用の通知(scope=oikiri)を 1 件送る", async (code) => {
    const w = mk();
    w.catalog = [CENTRAL_A, CENTRAL_B];
    w.defaultResponse = status(code);
    await w.core.kick();
    await w.runUntil(T0 + 6 * HOUR);
    expect(w.fetchLog).toHaveLength(1);
    expect(w.saved).toHaveLength(0);
    const st = await w.core.getStatus();
    expect(st.state).toBe("night-stopped");
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toMatchObject({ kind: "refused", httpStatus: code, scope: "oikiri" });
  });

  it("D1 が上限を超えた(保存が skipped)ら capacity-stopped で止まり、手で再開するまで動かさない。通知は scope=oikiri", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A, CENTRAL_B];
    w.saveResult = { status: "skipped", reason: "db-size", dbSizeBytes: 401_000_000 };
    await w.core.kick();
    await w.runUntil(T0 + 6 * HOUR);
    expect(w.fetchLog).toHaveLength(1);
    expect((await w.core.getStatus()).state).toBe("capacity-stopped");
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toMatchObject({ kind: "capacity", reason: "db-size", scope: "oikiri" });
  });

  it("保存の例外は save-failed の失敗として数え(pending のまま)、止まらずに次のレースへ進む", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A, CENTRAL_B];
    w.saveThrows = true;
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.fetchLog).toHaveLength(2);
    expect(w.raceRows().map((r) => [r.status, r.last_class])).toEqual([["pending", "save-failed"], ["pending", "save-failed"]]);
  });

  it("目録の読み出しの例外は、その起床の失敗(10 分後に再試行)で、状態を壊さない。直れば続きを取る", async () => {
    const w = mk();
    w.catalog = [CENTRAL_A];
    w.catalogThrowsOnce = true;
    await w.core.kick();
    await w.runUntil(T0 + 2 * HOUR);
    expect(w.pageCalls.length).toBeGreaterThanOrEqual(2); // 1 回目は例外、2 回目(10 分後)で読めた
    expect(w.fetchLog).toHaveLength(1);
    expect(w.saved).toHaveLength(1);
  });
});

describe("buildOikiriArchiveOptions(追い切り用の DO の設定)", () => {
  it("既定: 追い切りモード・間隔 20 秒・時間帯は終日(1440)・上限なし・止めない(開催日の朝を休む設定は持たない: コアが休む判定をしない)", () => {
    const o = buildOikiriArchiveOptions({});
    expect(o).toMatchObject({ oikiri: true, intervalMs: OIKIRI_ARCHIVE_REQUEST_INTERVAL_MS, windowEndMin: 1440 });
    expect(OIKIRI_ARCHIVE_REQUEST_INTERVAL_MS).toBe(20_000);
    expect(o.nightlyLimit).toBeUndefined();
    expect(o.disabled).toBeUndefined();
    expect(o.skipCentralRaceDay).toBeUndefined();
    expect(o.kind).toBeUndefined();
  });

  it("var: 上限 30 は nightlyLimit、\"0\" は停止、時間帯・間隔・行数の予算の上書き、不正な値は無視する。中央・地方の var は読まない", () => {
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_NIGHTLY_LIMIT: "30" }).nightlyLimit).toBe(30);
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_NIGHTLY_LIMIT: "0" }).disabled).toBe(true);
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_NIGHTLY_LIMIT: "abc" })).toMatchObject({ windowEndMin: 1440 });
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_NIGHTLY_LIMIT: "abc" }).nightlyLimit).toBeUndefined();
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_WINDOW_END_MIN: "510" }).windowEndMin).toBe(510);
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_MIN_INTERVAL_MS: "5000" }).intervalMs).toBe(5000);
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_MIN_INTERVAL_MS: "100" }).intervalMs).toBe(20_000);
    expect(buildOikiriArchiveOptions({ RACE_ARCHIVE_OIKIRI_NIGHTLY_ROWS_LIMIT: "500000" }).nightlyRowsLimit).toBe(500000);
    const foreign = buildOikiriArchiveOptions({ RACE_ARCHIVE_NIGHTLY_LIMIT: "0", RACE_ARCHIVE_NAR_NIGHTLY_LIMIT: "0", RACE_ARCHIVE_WINDOW_END_MIN: "60" } as never);
    expect(foreign.disabled).toBeUndefined();
    expect(foreign.windowEndMin).toBe(1440);
  });
});
