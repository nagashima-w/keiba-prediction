import { describe, expect, it } from "vitest";
import { VerifyCore, type VerifyCoreDeps, type VerifyKv, type VerifyStorePort } from "../src/verify-core";
import type { PendingPage, ReadAllResult, Watermark } from "../src/verify-store";
import type { VerifyReadRows } from "../src/verify-read";
import type { VerifyCloseRows } from "../src/verify-close";
import { NO_DATE_DAY, PARTS_VERSION } from "../src/verify-parts";
import { compareAssembled, normalizeForCompare } from "../src/verify-parts";
import { manyDayRows, rowsOfDay } from "./verify-parts-support";

/**
 * Issue #628: 差分の集計の並走(`VerifyCore.runPartsTick`)。画面に出す集計(`cache`)は今のまま変えず、開催日ごとの部分を作って突き合わせ、記録する。
 * D1 は偽物(行の集合と変更の印を持ち、読んだ行数を数える)。
 */
const T0 = Date.parse("2026-10-10T03:00:00.000Z");

function memoryKv(): VerifyKv & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    put: (key: string, value: unknown) => void data.set(key, JSON.parse(JSON.stringify(value))),
    delete: (key: string) => data.delete(key),
  };
}

function setup(rows: VerifyReadRows, opts: { withParts?: boolean } = {}) {
  const db = { rows, close: { meta: [], bets: [] } as VerifyCloseRows, seq: 0, marks: new Map<string, { date: string | null; seq: number }>(), watermark: 1 };
  const log = { readDay: [] as string[], partsRowsRead: 0, markCalls: 0, statements: 0, readAll: 0, inflightDays: 0, maxInflightDays: 0 };
  /** 週 1 回の突き合わせ(Issue #723)の試験用: 補完待ちの件数・readAll の中で起こす書き込み。 */
  const hooks = { pending: 0, onReadAll: null as (() => void) | null };
  const touch = (raceId: string): void => {
    const date = db.rows.analyses.find((a) => a.raceId === raceId)?.kaisaiDate ?? null;
    db.seq += 1;
    db.marks.set(raceId, { date, seq: db.seq });
    db.watermark += 1;
  };
  for (const raceId of new Set(rows.analyses.map((a) => a.raceId))) touch(raceId);
  const failure = { readDay: false, readAll: false };
  const port: VerifyStorePort = {
    async readWatermark(): Promise<Watermark> {
      return { analyses: db.watermark, results: db.watermark, comboPayouts: null, comboImports: null };
    },
    async listPending(): Promise<PendingPage> {
      return { rows: [], total: hooks.pending };
    },
    async readUsage() {
      return { classA: 0, classB: 0 };
    },
    async resolveStartTimes() {
      return { resolved: [], missing: [], failed: [], gets: 0 };
    },
    async commitStartTimes() {
      return 0;
    },
    async readAll(): Promise<ReadAllResult> {
      log.readAll += 1;
      if (failure.readAll) throw new Error("D1_ERROR");
      const snapshot = db.rows;
      hooks.onReadAll?.();
      return { rows: snapshot, rowsRead: 1, counts: { analyses: db.rows.analyses.length }, close: db.close };
    },
    ...(opts.withParts === false
      ? {}
      : {
          async readMaxSeq() {
            log.statements += 1;
            return db.seq;
          },
          async readMarks(after: number, limit: number) {
            log.markCalls += 1;
            const marks = [...db.marks.entries()].map(([raceId, m]) => ({ raceId, kaisaiDate: m.date, seq: m.seq })).filter((m) => m.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
            log.partsRowsRead += marks.length;
            return { marks, rowsRead: marks.length };
          },
          async readDays() {
            const days = [...new Set(db.rows.analyses.map((a) => a.kaisaiDate ?? NO_DATE_DAY))].sort();
            log.partsRowsRead += db.rows.analyses.length;
            return { days, rowsRead: db.rows.analyses.length };
          },
          async readDay(day: string) {
            if (failure.readDay) throw new Error("D1_ERROR");
            log.readDay.push(day);
            // 同時に読んでいる日の数(部分を並行に書かないことの検査用)。await をいくつかまたぐ。
            log.inflightDays += 1;
            log.maxInflightDays = Math.max(log.maxInflightDays, log.inflightDays);
            for (let i = 0; i < 5; i += 1) await Promise.resolve();
            log.inflightDays -= 1;
            const r = rowsOfDay(db.rows, day === NO_DATE_DAY ? null : day);
            const n = r.analyses.length + r.horses.length + r.allocationMeta.length + r.bets.length + r.results.length;
            log.partsRowsRead += n;
            const ids = new Set(r.analyses.map((a) => a.id));
            return { rows: r, close: { meta: db.close.meta.filter((m) => ids.has(m.analysisId)), bets: db.close.bets.filter((b) => ids.has(b.analysisId)) }, rowsRead: n };
          },
        }),
  };
  const kv = memoryKv();
  const clock = { now: T0 };
  let alarm: number | null = null;
  const alarms: number[] = [];
  const warns: string[] = [];
  const deps: VerifyCoreDeps = {
    kv,
    now: () => clock.now,
    setAlarm: (at) => {
      alarm = at;
      alarms.push(at);
    },
    getAlarm: async () => alarm,
    store: port,
    onWarn: (m) => warns.push(m),
  };
  const core = new VerifyCore(deps);
  /** アラームが張られている間、parts の tick を回す(上限つき)。 */
  async function drain(max = 200): Promise<number> {
    let n = 0;
    while (alarm !== null && n < max) {
      alarm = null;
      clock.now += 1_000;
      await core.runPartsTick();
      n += 1;
    }
    return n;
  }
  return { core, db, kv, log, touch, clock, warns, alarms, drain, failure, hooks, getAlarm: () => alarm, setAlarmDirect: (at: number | null) => (alarm = at) };
}

/** 今の db の行を「全件を読む形」(差分の読みを持たない読み取り口)で集計した応答と、差分の道の応答を、3 区分で突き合わせる(件数・集合は完全一致、小数は相対 1e-12)。 */
async function expectSameAsFullRead(t: ReturnType<typeof setup>): Promise<void> {
  const legacy = setup(t.db.rows, { withParts: false });
  legacy.db.close = t.db.close;
  for (const venue of ["all", "central", "nar"] as const) {
    const a = await t.core.getReport(venue);
    const b = await legacy.core.getReport(venue);
    if (a.status !== "ready" || b.status !== "ready") throw new Error("ready のはず");
    expect(a.stale).toBe(false);
    const pick = (r: typeof a) => normalizeForCompare({ report: r.report, promptVersions: r.promptVersions, closeComparison: r.closeComparison, breakdown: r.breakdown, startTimeGaps: r.diag.startTimeGaps });
    expect(compareAssembled(pick(b), pick(a))).toEqual([]);
  }
}

const check = (kv: ReturnType<typeof memoryKv>) => (kv.get("partsCheck") as { checked: number; matched: number; mismatched: number; skipped: number } | undefined) ?? { checked: 0, matched: 0, mismatched: 0, skipped: 0 };

describe("差分の集計の並走: 初回(全部の作り直し)と突き合わせ", () => {
  it("画面の集計は並走の有無で変わらない。作り直しの後、突き合わせは 1 回行われ、ずれは 0 件。診断に件数が出る", async () => {
    const rows = manyDayRows(6, 4);
    const withParts = setup(rows);
    const without = setup(rows, { withParts: false });
    const a = await withParts.core.getReport("all");
    const b = await without.core.getReport("all");
    if (a.status !== "ready" || b.status !== "ready") throw new Error("ready のはず");
    const ticks = await withParts.drain();
    expect(ticks).toBeGreaterThan(1); // 前提: 少しずつ(1 tick に全部を読まない)進めた
    expect(withParts.log.readDay.length).toBe(7); // 6 日 + NULL の日
    expect(new Set(withParts.log.readDay).size).toBe(7);
    expect(check(withParts.kv)).toMatchObject({ checked: 1, matched: 1, mismatched: 0 });
    expect(a.report).toEqual(b.report);
    expect(a.promptVersions).toEqual(b.promptVersions);
    expect(a.breakdown).toEqual(b.breakdown);
    const after = await withParts.core.getReport("all");
    if (after.status !== "ready") throw new Error("ready のはず");
    expect(after.diag).toMatchObject({ partsCheck: { checked: 1, matched: 1, mismatched: 0, skipped: 0 } });
    expect(withParts.warns).toEqual([]);
  });

  it("1 回の tick に読む開催日は 4 日まで(1 呼び出しの文数を守る)", async () => {
    const t = setup(manyDayRows(10, 2));
    await t.core.getReport("all");
    t.setAlarmDirect(null);
    t.clock.now += 1000;
    await t.core.runPartsTick();
    expect(t.log.readDay.length).toBeLessThanOrEqual(4);
    expect(t.log.readDay.length).toBeGreaterThan(0);
  });

  it("再計算の柵(1 日の回数)に数えない: 作り直しの tick は柵の記録(runs)に触れない", async () => {
    const t = setup(manyDayRows(3, 2));
    await t.core.getReport("all");
    const runs = JSON.stringify(t.kv.get("runs"));
    await t.drain();
    expect(JSON.stringify(t.kv.get("runs"))).toBe(runs);
  });

  it("部分の形の版が違う保存は捨てて、全部を作り直す(版を上げた直後)", async () => {
    const t = setup(manyDayRows(3, 2));
    await t.core.getReport("all");
    await t.drain();
    expect(t.log.readDay).toHaveLength(4);
    const meta = t.kv.get<{ v: number }>("pm")!;
    expect(meta.v).toBe(PARTS_VERSION);
    t.kv.put("pm", { ...meta, v: PARTS_VERSION - 1 });
    t.log.readDay.length = 0;
    t.setAlarmDirect(T0);
    await t.drain();
    expect(t.log.readDay).toHaveLength(4);
  });
});

describe("差分の集計の並走: 差分の読みと突き合わせ", () => {
  it("印の付いたレースの日だけを読み直す。古い開催日を増やしても、差分の読み取り行数は増えない", async () => {
    const measure = async (days: number): Promise<{ read: string[]; rows: number; diagRows: number }> => {
      const rows = manyDayRows(days, 4);
      const t = setup(rows);
      await t.core.getReport("all");
      await t.drain();
      t.log.readDay.length = 0;
      t.log.partsRowsRead = 0;
      // 最後の日(古くない日)のレースに変更の印だけが付く(中身も 1 行変える)
      const target = rows.analyses.find((a) => a.kaisaiDate === "20260102")!;
      t.touch(target.raceId);
      t.clock.now += 6 * 60_000;
      await t.core.getReport("all");
      await t.drain();
      expect(check(t.kv)).toMatchObject({ checked: 1, matched: 1, mismatched: 0 }); // 差分の道の集計は突き合わせの対象外(最初の全件読みの 1 回だけ)
      const res = await t.core.getReport("all");
      if (res.status !== "ready") throw new Error("ready のはず");
      expect(res.stale).toBe(false);
      await expectSameAsFullRead(t);
      return { read: [...t.log.readDay], rows: t.log.partsRowsRead, diagRows: res.diag.rowsRead };
    };
    const small = await measure(5);
    const large = await measure(25);
    expect(small.read).toEqual(["20260102"]);
    expect(large.read).toEqual(["20260102"]);
    expect(small.rows).toBeGreaterThan(0); // 前提: 日を読んだ
    expect(large.rows).toBe(small.rows);
    expect(small.diagRows).toBeGreaterThan(0);
    expect(large.diagRows).toBe(small.diagRows); // 診断の読んだ行数は、その回に読んだ量(古い開催日の数に依らない)
  });

  it("開催日が NULL のレースの印は捨てず、NULL の日を作り直す", async () => {
    const rows = manyDayRows(2, 2);
    const t = setup(rows);
    await t.core.getReport("all");
    await t.drain();
    t.log.readDay.length = 0;
    t.touch(rows.analyses.find((a) => a.kaisaiDate === null)!.raceId);
    t.clock.now += 6 * 60_000;
    await t.core.getReport("all");
    await t.drain();
    expect(t.log.readDay).toEqual([NO_DATE_DAY]);
    expect(check(t.kv)).toMatchObject({ mismatched: 0 });
    await expectSameAsFullRead(t);
  });

  it.each([
    ["開催日が NULL から日付に変わる", null, "20260105"],
    ["日付から別の日付に変わる", "20260102", "20260105"],
  ] as const)("%s: 旧い日と新しい日の両方を作り直し、二重に数えず、突き合わせが一致する", async (_name, from, to) => {
    const rows = manyDayRows(5, 3);
    const t = setup(rows);
    await t.core.getReport("all");
    await t.drain();
    expect(check(t.kv)).toMatchObject({ checked: 1, matched: 1 });
    const target = rows.analyses.find((a) => (a.kaisaiDate ?? null) === from)!.raceId;
    // 前提: そのレースの分析は 1 日にしか無く、新しい日にまだ無い
    expect(rows.analyses.filter((a) => a.raceId === target).every((a) => (a.kaisaiDate ?? null) === from)).toBe(true);
    t.db.rows = { ...rows, analyses: rows.analyses.map((a) => (a.raceId === target ? { ...a, kaisaiDate: to } : a)) };
    t.touch(target); // 印の日は新しい日
    t.log.readDay.length = 0;
    t.clock.now += 6 * 60_000;
    await t.core.getReport("all");
    await t.drain();
    expect(new Set(t.log.readDay)).toEqual(new Set([from ?? NO_DATE_DAY, to]));
    expect(check(t.kv)).toMatchObject({ mismatched: 0 });
    await expectSameAsFullRead(t); // 二重に数えない
  });

  it("kv の 1 値は 100KB 以下(レースが多くても。「レース → 日」の索引はレースごとのキー)。索引は日の部分の入れ替えで外れたレースのぶんが消える", async () => {
    const rows = manyDayRows(45, 110, 7, true); // 4,900 レース前後(索引を 1 つの値にすれば 100KB を超える数)
    const t = setup(rows);
    await t.core.getReport("all");
    await t.drain(2000);
    const raceCount = new Set(rows.analyses.map((a) => a.raceId)).size;
    const index = [...t.kv.data.keys()].filter((k) => k.startsWith("prd:"));
    expect(index).toHaveLength(raceCount);
    expect(raceCount).toBeGreaterThan(4000);
    expect(JSON.stringify(Object.fromEntries(index.map((k) => [k, t.kv.data.get(k)]))).length).toBeGreaterThan(100_000); // 前提: 1 つにまとめると上限を超える
    for (const [key, value] of t.kv.data) {
      if (key === "cache") continue; // 既存の集計(今の形のまま。本件の対象外)
      expect(JSON.stringify(value).length, key).toBeLessThanOrEqual(100_000);
    }
    // 日の部分を作り直して、レースが外れる(分析が消える)と、そのレースの索引も消える
    const gone = rows.analyses.find((a) => a.kaisaiDate === "20260103")!.raceId;
    t.db.rows = { ...rows, analyses: rows.analyses.filter((a) => a.raceId !== gone) };
    t.touch(gone);
    t.clock.now += 6 * 60_000;
    await t.core.getReport("all");
    await t.drain(50);
    expect(t.kv.data.has(`prd:${gone}`)).toBe(false);
    expect([...t.kv.data.keys()].filter((k) => k.startsWith("prd:"))).toHaveLength(raceCount - 1);
  });

  it("突き合わせは今の集計(kv から structured clone で読むので undefined・NaN を保ちうる)も JSON と同じ形にそろえてから比べる(本番でだけ偽のずれが出ない)", async () => {
    const t = setup(manyDayRows(3, 3));
    await t.core.getReport("all");
    // 今の集計に、JSON では消える/null になる値(undefined のキー・NaN)を入れる(structured clone の kv の再現)。内容は JSON にすれば同じ。
    const cache = t.kv.data.get("cache") as { closeByVenue: Record<string, unknown>; reports: { all: Record<string, unknown> } };
    expect(cache.closeByVenue["all"]).toBeNull(); // 前提: 差分の集計側も null(close の行が空)
    cache.closeByVenue["all"] = Number.NaN;
    cache.reports.all["__undefinedKey"] = undefined;
    await t.drain();
    expect(check(t.kv)).toMatchObject({ checked: 1, matched: 1, mismatched: 0 });
  });

  it("発走時刻の欠落の件数(startTimeGaps)も突き合わせの対象。今の集計の値が違うと、そのパスがずれとして出る(Issue #626)", async () => {
    const t = setup(manyDayRows(3, 3));
    await t.core.getReport("all");
    const cache = t.kv.data.get("cache") as { diag: { startTimeGaps: { lost: number; affecting: number } } };
    // 前提: 書き換える前の値は、差分の集計側と一致しうる形(数値のオブジェクト)
    expect(typeof cache.diag.startTimeGaps.lost).toBe("number");
    cache.diag.startTimeGaps = { lost: cache.diag.startTimeGaps.lost + 7, affecting: cache.diag.startTimeGaps.affecting + 7 };
    await t.drain();
    expect(check(t.kv)).toMatchObject({ checked: 1, matched: 0, mismatched: 1 });
    expect(JSON.stringify((check(t.kv) as { lastPaths?: string[] }).lastPaths)).toContain("startTimeGaps");
  });

  it("印の無い変更(結果の行の書き換え)は、差分の道の画面には出ない(部分は印で読み直すため。見つけるのは段階 4 の週 1 の突き合わせ)。印を付ければ次の再計算で出る", async () => {
    const rows = manyDayRows(3, 4);
    const t = setup(rows);
    const first = await t.core.getReport("all");
    await t.drain();
    if (first.status !== "ready") throw new Error("ready のはず");
    // 印を付けずに結果を変える(全件の読みには反映され、部分には反映されない)
    t.db.rows = { ...rows, results: rows.results.map((r) => (r.placePayout === null ? r : { ...r, placePayout: r.placePayout + 500 })) };
    t.db.watermark += 1;
    t.clock.now += 6 * 60_000;
    const res = await t.core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.report).toEqual(first.report); // 前提: 部分を読み直していない=画面は変わらない
    const legacy = setup(t.db.rows, { withParts: false });
    const full = await legacy.core.getReport("all");
    if (full.status !== "ready") throw new Error("ready のはず");
    expect(full.report).not.toEqual(res.report); // 前提: 印があれば違う値になる変更だった
    for (const raceId of new Set(rows.analyses.map((a) => a.raceId))) t.touch(raceId);
    t.clock.now += 6 * 60_000;
    await t.core.getReport("all");
    await t.drain();
    t.clock.now += 6 * 60_000;
    await expectSameAsFullRead(t);
  });

  it("再計算と差分の間にデータが動いた(印が進んだ)ときは、比べずに見送る(ずれに数えない)", async () => {
    const rows = manyDayRows(2, 2);
    const t = setup(rows);
    await t.core.getReport("all");
    t.touch(rows.analyses[0]!.raceId); // 再計算の後に、別の書き込み
    await t.drain();
    expect(check(t.kv)).toMatchObject({ checked: 0, mismatched: 0, skipped: 1 });
    const after = await t.core.getReport("all");
    if (after.status !== "ready") throw new Error("ready のはず");
    expect(after.diag).toMatchObject({ partsCheck: { skipped: 1 } });
  });
});

describe("差分の集計の並走: 失敗を画面に出さない・alarm の共存", () => {
  it("D1 の読みが失敗しても、tick は例外を投げず、画面の集計は返る。警告を出し、再試行の alarm を張る", async () => {
    const t = setup(manyDayRows(2, 2));
    const res = await t.core.getReport("all");
    expect(res.status).toBe("ready");
    t.failure.readDay = true;
    t.setAlarmDirect(null);
    await expect(t.core.runPartsTick()).resolves.toBeUndefined();
    expect(t.warns.some((w) => w.includes("差分"))).toBe(true);
    expect(t.getAlarm()).not.toBeNull();
    expect((await t.core.getReport("all")).status).toBe("ready");
  });

  it("再計算の中の maxSeq の読みが失敗しても、画面の集計は返る", async () => {
    const t = setup(manyDayRows(2, 2));
    const port = (t.core as unknown as { deps: VerifyCoreDeps }).deps.store;
    (port as { readMaxSeq: () => Promise<number> }).readMaxSeq = async () => {
      throw new Error("D1_ERROR");
    };
    const res = await t.core.getReport("all");
    expect(res.status).toBe("ready");
  });

  it("補完の alarm が先にあるとき、parts の alarm はそれを遅らせない。parts の alarm が先なら前倒しする", async () => {
    const t = setup(manyDayRows(10, 2));
    await t.core.getReport("all"); // parts の alarm(再計算の直後)が張られる
    const first = t.getAlarm();
    expect(first).not.toBeNull();
    // 補完の alarm(30 秒後)が先に張られている状態で tick が終わる
    t.setAlarmDirect(t.clock.now + 500);
    await t.core.runPartsTick();
    expect(t.getAlarm()).toBe(t.clock.now + 500);
    // 補完の alarm が遅いなら、parts の alarm で前倒しされる
    t.setAlarmDirect(t.clock.now + 600_000);
    await t.core.runPartsTick();
    expect(t.getAlarm()!).toBeLessThan(t.clock.now + 600_000);
  });

  it("補完待ちが残っている間は、parts の tick は何も読まない(補完前の発走時刻・条件で部分を作らない)", async () => {
    const t = setup(manyDayRows(2, 2));
    await t.core.getReport("all");
    (t.core as unknown as { deps: VerifyCoreDeps }).deps.store.listPending = async () => ({ rows: [], total: 3 });
    t.log.readDay.length = 0;
    await t.core.runPartsTick();
    expect(t.log.readDay).toEqual([]);
  });

  it("差分の読みを持たない読み取り口(既存の偽物)では何もしない", async () => {
    const t = setup(manyDayRows(2, 2), { withParts: false });
    await t.core.getReport("all");
    expect(t.getAlarm()).toBeNull();
    await t.core.runPartsTick();
    expect(t.kv.get("pm")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #721: 再計算を開催日ごとの部分から組み立てる(画面の値は全件を読む形と同じ)
// ---------------------------------------------------------------------------

/** 初回の全件読みと、tick の作り直しを済ませた状態にする。 */
async function warmed(rows: VerifyReadRows) {
  const t = setup(rows);
  await t.core.getReport("all");
  await t.drain();
  t.clock.now += 6 * 60_000;
  return t;
}

const closeFor = (rows: VerifyReadRows): VerifyCloseRows => ({
  meta: rows.analyses.flatMap((a) => [1, 2].map((round) => ({ analysisId: a.id, round, status: "ok", route: "mixed", skipReasonCode: null, reason: null }))),
  bets: rows.analyses.flatMap((a) => [1, 2].map((round) => ({ analysisId: a.id, round, betType: "place", comboKey: "01", stake: 100 * round }))),
});

describe("再計算を部分から組み立てる(Issue #721): 画面の値は全件を読む形と同じ", () => {
  it("結果の行の書き換え(印あり)が、画面に出る", async () => {
    const rows = manyDayRows(3, 4);
    const t = await warmed(rows);
    const dayRaces = new Set(rows.analyses.filter((a) => a.kaisaiDate === "20260102").map((a) => a.raceId));
    t.db.rows = { ...rows, results: rows.results.map((r) => (r.placePayout === null || !dayRaces.has(r.raceId) ? r : { ...r, placePayout: r.placePayout + 500 })) };
    expect(dayRaces.size).toBeGreaterThan(0); // 前提
    for (const id of dayRaces) t.touch(id);
    t.log.readAll = 0;
    await expectSameAsFullRead(t);
    expect(t.log.readAll).toBe(0); // 全件は読んでいない
  });

  it("組合せ払戻だけの保存(結果の行は空)が、画面に出る", async () => {
    const base = manyDayRows(3, 4);
    const target = base.analyses.find((a) => a.kaisaiDate === "20260102")!;
    const rows = { ...base, bets: [...base.bets, { analysisId: target.id, betType: "quinella", comboKey: "01-02", stake: 100, odds: 10, ev: 1.2 }] };
    const t = await warmed(rows);
    t.db.rows = { ...rows, comboPayouts: [{ raceId: target.raceId, betType: "quinella", comboKey: "01-02", payout: 1230 }], comboImports: [{ raceId: target.raceId, betType: "quinella" }] };
    t.touch(target.raceId);
    const before = await setup(rows, { withParts: false }).core.getReport("all");
    const after = await setup(t.db.rows, { withParts: false }).core.getReport("all");
    if (before.status !== "ready" || after.status !== "ready") throw new Error("ready のはず");
    expect(after.report).not.toEqual(before.report); // 前提: この保存で値が変わる
    await expectSameAsFullRead(t);
  });

  it("締切直前の再計算の保存が、画面に出る(比較は null でない)", async () => {
    const rows = manyDayRows(3, 4);
    const t = setup(rows);
    t.db.close = closeFor(rows);
    await t.core.getReport("all");
    await t.drain();
    t.clock.now += 6 * 60_000;
    const target = rows.analyses.find((a) => a.kaisaiDate === "20260103")!;
    t.db.close = { meta: t.db.close.meta, bets: [...t.db.close.bets, { analysisId: target.id, round: 2, betType: "place", comboKey: "02", stake: 700 }] };
    t.touch(target.raceId);
    const res = await t.core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.closeComparison).not.toBeNull();
    await expectSameAsFullRead(t);
  });

  it("開催日が NULL の日・複数日の変更でも一致する(変更の日が 4 日以内)", async () => {
    const rows = manyDayRows(4, 3);
    const t = await warmed(rows);
    for (const id of new Set(rows.analyses.filter((a) => a.kaisaiDate === null || a.kaisaiDate === "20260101" || a.kaisaiDate === "20260102").map((a) => a.raceId))) t.touch(id);
    await expectSameAsFullRead(t);
  });
});

describe("再計算を部分から組み立てる(Issue #721): 柵の数え方と追いつけないとき", () => {
  it("完全な初回は全件を読み、再計算の回数(runs)でなく別枠(rebuilds)に数える。部分が揃った後の再計算は runs に数える", async () => {
    const t = setup(manyDayRows(3, 2));
    await t.core.getReport("all");
    expect(t.log.readAll).toBe(1);
    expect(t.kv.get("runs")).toBeUndefined();
    expect(t.kv.get<{ count: number }>("rebuilds")?.count).toBe(1);
    await t.drain();
    t.clock.now += 6 * 60_000;
    t.touch([...new Set(t.db.rows.analyses.map((a) => a.raceId))][0]!);
    await t.core.getReport("all");
    expect(t.log.readAll).toBe(1); // 全件は読まない
    expect(t.kv.get<{ count: number }>("runs")?.count).toBe(1);
    expect(t.kv.get<{ count: number }>("rebuilds")?.count).toBe(1);
  });

  it("全件読みへの切り戻しは 1 日 3 回まで。4 回目は throttled(日が変われば数え直す)", async () => {
    const t = setup(manyDayRows(2, 2));
    const reset = (): void => {
      t.kv.delete?.("cache");
      t.kv.delete?.("pm");
    };
    for (let i = 1; i <= 3; i += 1) {
      reset();
      const r = await t.core.getReport("all");
      expect(r.status).toBe("ready");
      expect(t.kv.get<{ count: number }>("rebuilds")?.count).toBe(i);
    }
    reset();
    const blocked = await t.core.getReport("all");
    expect(blocked).toMatchObject({ status: "throttled", reason: "daily-limit" });
    expect(t.log.readAll).toBe(3);
    t.clock.now += 24 * 3_600_000;
    reset();
    expect((await t.core.getReport("all")).status).toBe("ready");
  });

  it("5 日以上が変わって 1 回で追いつけないときは、古い集計を backfilling の stale で返し、runs に数えず、tick に任せる。追いつけば画面が更新される", async () => {
    const rows = manyDayRows(6, 2);
    const t = await warmed(rows);
    const runsBefore = JSON.stringify(t.kv.get("runs"));
    const cacheBefore = JSON.stringify(t.kv.get("cache"));
    for (const id of new Set(rows.analyses.map((a) => a.raceId))) t.touch(id);
    t.log.readDay.length = 0;
    const res = await t.core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res).toMatchObject({ stale: true, staleReason: "backfilling" });
    expect(t.log.readDay.length).toBe(4);
    expect(JSON.stringify(t.kv.get("runs"))).toBe(runsBefore);
    expect(JSON.stringify(t.kv.get("cache"))).toBe(cacheBefore);
    expect(t.getAlarm()).not.toBeNull();
    await t.drain();
    t.clock.now += 6 * 60_000;
    await expectSameAsFullRead(t);
  });

  it("部分の形の版を上げた直後は、旧い集計を返して tick に作り直しを任せる(全件は読まず、runs にも数えない)", async () => {
    const t = await warmed(manyDayRows(3, 2));
    const meta = t.kv.get<{ v: number }>("pm")!;
    t.kv.put("pm", { ...meta, v: PARTS_VERSION - 1 });
    const runsBefore = JSON.stringify(t.kv.get("runs"));
    t.log.readAll = 0;
    const res = await t.core.getReport("all", { refresh: true });
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res).toMatchObject({ stale: true, staleReason: "backfilling" });
    expect(t.log.readAll).toBe(0);
    expect(JSON.stringify(t.kv.get("runs"))).toBe(runsBefore);
    expect(t.getAlarm()).not.toBeNull();
  });

  it("保存の欠け(塊が無い)は全件読みに落とさず、その日を作り直し対象に戻して stale で返す。作り直した後は一致する", async () => {
    const t = await warmed(manyDayRows(3, 2));
    const key = [...t.kv.data.keys()].find((k) => k.startsWith("pd:20260102:all:"))!;
    t.kv.delete?.(key);
    t.log.readAll = 0;
    const res = await t.core.getReport("all", { refresh: true });
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res).toMatchObject({ stale: true, staleReason: "backfilling" });
    expect(t.log.readAll).toBe(0);
    expect(t.kv.get<{ dirty: string[] }>("pm")!.dirty).toContain("20260102");
    await t.drain();
    t.clock.now += 6 * 60_000;
    await expectSameAsFullRead(t);
  });

  it("補完前の行(発走時刻が NULL)を含む日は部分を作らず preparing を返す(今の再計算と同じ守り)", async () => {
    const rows = manyDayRows(3, 2);
    const t = await warmed(rows);
    const target = rows.analyses.find((a) => a.kaisaiDate === "20260102")!;
    t.db.rows = { ...rows, analyses: rows.analyses.map((a) => (a.id === target.id ? { ...a, startTime: null } : a)) };
    t.touch(target.raceId);
    const partBefore = JSON.stringify(t.kv.get("pd:20260102:m"));
    const res = await t.core.getReport("all");
    expect(res.status).toBe("preparing");
    expect(JSON.stringify(t.kv.get("pd:20260102:m"))).toBe(partBefore);
  });
});

describe("再計算を部分から組み立てる(Issue #721): 診断と並行", () => {
  it("診断の rowsRead は、その回に読んだ量(印 + 読んだ日)。counts はその回の内訳", async () => {
    const rows = manyDayRows(4, 3);
    const t = await warmed(rows);
    const id = rows.analyses.find((a) => a.kaisaiDate === "20260102")!.raceId;
    t.touch(id);
    t.log.partsRowsRead = 0;
    const res = await t.core.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    expect(res.diag.rowsRead).toBe(t.log.partsRowsRead);
    expect(res.diag.rowsRead).toBeGreaterThan(0);
    expect(res.diag.counts).toMatchObject({ marks: 1, days: 1 });
  });

  it("再計算と tick が並行しても、部分を同時に書かない(読む日が同時に 2 つにならない)。pm は壊れず、追いついた後は全件を読む形と一致する", async () => {
    const rows = manyDayRows(5, 2);
    const t = await warmed(rows);
    for (const id of new Set(rows.analyses.filter((a) => ["20260101", "20260102", "20260103"].includes(a.kaisaiDate ?? "")).map((a) => a.raceId))) t.touch(id);
    t.log.maxInflightDays = 0;
    await Promise.all([t.core.getReport("all"), t.core.runPartsTick(), t.core.runPartsTick()]);
    expect(t.log.maxInflightDays).toBe(1);
    await t.drain();
    const pm = t.kv.get<{ dirty: string[]; days: string[] }>("pm")!;
    expect(pm.dirty).toEqual([]);
    expect(new Set(pm.days).size).toBe(pm.days.length);
    t.clock.now += 6 * 60_000;
    await expectSameAsFullRead(t);
  });
});

/**
 * Issue #723(#616 の段階 4): 週 1 回、全部を読む集計(readAll)と、開催日ごとの部分から組んだ集計を突き合わせる。
 * 起こし方: cron が 23 時台に `requestWeeklyCheck` を呼び(前回から JST の日付で 7 日以上のときだけアラームを張る)、アラームの中で `runWeeklyCheck` が走る。
 */
describe("週 1 回の全件の突き合わせ(Issue #723)", () => {
  const jst = (s: string): number => Date.parse(`${s}+09:00`);
  type T = ReturnType<typeof setup>;
  const ready = async (): Promise<T> => {
    const t = setup(manyDayRows(4, 2));
    expect((await t.core.getReport("all")).status).toBe("ready");
    await t.drain();
    expect(check(t.kv)).toMatchObject({ checked: 1, matched: 1 }); // 前提: 部分が揃い、再計算ごとの突き合わせは済んでいる
    return t;
  };
  const weekly = (kv: T["kv"]) => (kv.get("partsCheck") ?? {}) as { checked: number; matched: number; mismatched: number; skipped: number; lastFullAt?: number; lastFullRowsRead?: number; lastFullMs?: number; lastPaths: string[] };
  const screen = (kv: T["kv"]): string => JSON.stringify(["cache", "runs", "rebuilds", "partsBase"].map((k) => kv.get(k) ?? null));
  /** DO の `alarm()` と同じ順(補完 → 部分 → 週 1 回)で、アラームが張られている間(上限つき)回す。 */
  const runAlarms = async (t: T): Promise<void> => {
    for (let i = 0; i < 40 && t.getAlarm() !== null; i += 1) {
      t.setAlarmDirect(null);
      await t.core.runBackfillTick();
      const progressed = await t.core.runPartsTickWithProgress();
      await t.core.runWeeklyCheck({ afterWork: progressed });
      t.clock.now += 1_000;
    }
  };
  /** 時刻を合わせて、kick → アラーム(追いつきの再試行を含む)までを行う。 */
  const night = async (t: T, when: string): Promise<void> => {
    t.clock.now = jst(when);
    t.setAlarmDirect(null);
    await t.core.requestWeeklyCheck();
    await runAlarms(t);
  };

  it("週の境界: 前回から JST の日付で 7 日未満ならアラームを張らず、7 日以上で張る。23 時台の kick だけを受ける(21 時台・22 時台は張らない)", async () => {
    const t = await ready();
    t.kv.put("partsCheck", { ...weekly(t.kv), lastFullAt: jst("2026-10-10T23:50:00") });
    const armed = async (when: string): Promise<boolean> => {
      t.clock.now = jst(when);
      t.setAlarmDirect(null);
      await t.core.requestWeeklyCheck();
      return t.getAlarm() !== null;
    };
    expect(await armed("2026-10-16T23:05:00")).toBe(false); // 6 日
    expect(await armed("2026-10-17T21:05:00")).toBe(false); // 7 日だが 21 時台
    expect(await armed("2026-10-17T22:59:00")).toBe(false);
    expect(await armed("2026-10-17T23:05:00")).toBe(true); // 日付の差が 7(24 時間×7 には 45 分足りない)
    t.setAlarmDirect(null);
    expect(await armed("2026-10-18T23:59:00")).toBe(true);
    expect(await armed("2026-10-19T00:05:00")).toBe(false); // 0 時台
  });

  it("前回の記録が無ければ(初回)23 時台の kick で張る。kick が無ければ、アラームが鳴っても突き合わせない(readAll を読まない)", async () => {
    const t = await ready();
    expect(weekly(t.kv).lastFullAt).toBeUndefined();
    const reads = t.log.readAll;
    t.clock.now = jst("2026-10-12T10:00:00");
    await t.core.runWeeklyCheck();
    expect(t.log.readAll).toBe(reads);
    await night(t, "2026-10-12T23:05:00");
    expect(t.log.readAll).toBe(reads + 1);
  });

  it("一致: 記録が増え(checked・matched・lastFullAt・読んだ行数・所要時間)、画面の集計・再計算の回数・基準の印は 1 つも変わらない", async () => {
    const t = await ready();
    const before = screen(t.kv);
    const reads = t.log.readAll;
    await night(t, "2026-10-12T23:05:00");
    expect(t.log.readAll).toBe(reads + 1);
    expect(weekly(t.kv)).toMatchObject({ checked: 2, matched: 2, mismatched: 0, skipped: 0, lastFullRowsRead: 1 });
    expect(weekly(t.kv).lastFullAt).toBeGreaterThanOrEqual(jst("2026-10-12T23:05:00"));
    expect(weekly(t.kv).lastFullAt).toBeLessThan(jst("2026-10-12T23:06:00"));
    expect(typeof weekly(t.kv).lastFullMs).toBe("number");
    expect(screen(t.kv)).toBe(before);
    expect(t.warns).toEqual([]);
    // 1 回の kick で 1 回だけ(アラームがもう一度鳴っても読まない)
    await t.core.runWeeklyCheck();
    expect(t.log.readAll).toBe(reads + 1);
  });

  it("ずれ(印を付けない書き込み): mismatched・lastPaths・警告(固定文+件数+例。値は含めない)、部分を全部の日で置き直し(古い塊は消え、版は同じ)、画面の集計は変えない。tick で部分が揃い、翌週は一致する", async () => {
    const t = await ready();
    const before = screen(t.kv);
    const first = t.db.rows.results[0]!.raceId;
    t.db.rows = { ...t.db.rows, results: t.db.rows.results.map((r) => (r.raceId === first ? { ...r, placePayout: r.placePayout === null ? null : r.placePayout + 1000 } : r)) }; // 印なし
    t.clock.now = jst("2026-10-12T23:05:00");
    await t.core.requestWeeklyCheck();
    await t.core.runWeeklyCheck(); // 1 回目のアラーム(部分の tick の前)だけ: 置き直した直後の状態を確かめる
    const w = weekly(t.kv);
    expect(w).toMatchObject({ checked: 2, matched: 1, mismatched: 1, });
    expect(w.lastFullAt).toBeGreaterThanOrEqual(jst("2026-10-12T23:05:00"));
    expect(w.lastPaths.length).toBeGreaterThan(0);
    expect(t.warns.filter((m) => m.includes("突き合わせのずれ")).length).toBe(1);
    expect(t.warns.join("")).not.toMatch(/1[0-9]{3}/); // 値(払戻)は含めない
    const pm = t.kv.get("pm") as { v: number; dirty: string[]; days: string[] };
    expect(pm.v).toBe(PARTS_VERSION);
    expect(pm.dirty).toHaveLength(5); // 4 日 + 開催日が NULL の日
    expect(pm.days).toEqual([]);
    expect([...t.kv.data.keys()].filter((k) => k.startsWith("pd:"))).toEqual([]); // 古い塊は消えている
    expect(t.getAlarm()).not.toBeNull();
    expect(screen(t.kv)).toBe(before);
    await t.drain();
    expect((t.kv.get("pm") as { dirty: string[]; days: string[] }).dirty).toEqual([]);
    expect((t.kv.get("pm") as { days: string[] }).days).toHaveLength(5);
    await night(t, "2026-10-19T23:05:00");
    expect(weekly(t.kv)).toMatchObject({ checked: 3, matched: 2, mismatched: 1, }); // 作り直した部分は全件の読みと一致する
    expect(screen(t.kv)).toBe(before);
  });

  describe("見送り(ずれに数えない・記録を進めない・翌晩に再試行する)", () => {
    const expectSkipped = (t: T, before: string): void => {
      expect(weekly(t.kv)).toMatchObject({ checked: 1, matched: 1, mismatched: 0, skipped: 1 });
      expect(weekly(t.kv).lastFullAt).toBeUndefined();
      expect(screen(t.kv)).toBe(before);
      expect(t.warns).toEqual([]);
    };
    const retry = async (t: T): Promise<void> => {
      await night(t, "2026-10-13T23:05:00");
      expect(weekly(t.kv)).toMatchObject({ checked: 2, matched: 2, skipped: 1 });
      expect(weekly(t.kv).lastFullAt).toBeGreaterThanOrEqual(jst("2026-10-13T23:05:00"));
    };

    it("全件を読んでいる間に印が進んだ(読んだ時点と部分が違うかもしれない): 比べずに見送り、翌晩に再試行して一致する", async () => {
      const t = await ready();
      const before = screen(t.kv);
      t.hooks.onReadAll = () => {
        t.hooks.onReadAll = null;
        t.touch(t.db.rows.analyses[0]!.raceId);
      };
      await night(t, "2026-10-12T23:05:00");
      expectSkipped(t, before);
      await retry(t);
    });

    it("部分が追いついていない(印が進んでいる): 全件を読まずに部分の追いつきを待ち、追いついたら同じ晩のうちに突き合わせる(見送りに数えない)", async () => {
      const t = await ready();
      const before = screen(t.kv);
      t.touch(t.db.rows.analyses[0]!.raceId);
      const reads = t.log.readAll;
      t.clock.now = jst("2026-10-12T23:05:00");
      t.setAlarmDirect(null);
      await t.core.requestWeeklyCheck();
      await t.core.runWeeklyCheck(); // 1 回目のアラーム(部分の tick の前): 追いついていないので全件は読まない
      expect(t.log.readAll).toBe(reads);
      expect(t.getAlarm()).not.toBeNull(); // 再試行のために張り直している
      await runAlarms(t);
      expect(t.log.readAll).toBe(reads + 1);
      expect(weekly(t.kv)).toMatchObject({ checked: 2, matched: 2, skipped: 0 });
      expect(weekly(t.kv).lastFullAt).toBeDefined();
      expect(screen(t.kv)).toBe(before);
    });

    it("部分がいつまでも追いつかない(D1 の読みが失敗し続ける): 再試行を重ねたあと見送る(skipped+1・記録は進めない)。翌晩にまた依頼される", async () => {
      const t = await ready();
      const before = screen(t.kv);
      t.touch(t.db.rows.analyses[0]!.raceId);
      t.failure.readDay = true;
      const reads = t.log.readAll;
      await night(t, "2026-10-12T23:05:00");
      expect(t.log.readAll).toBe(reads);
      expect(weekly(t.kv).skipped).toBe(1);
      expect(weekly(t.kv).lastFullAt).toBeUndefined();
      expect(screen(t.kv)).toBe(before);
      t.failure.readDay = false;
      t.setAlarmDirect(null);
      await night(t, "2026-10-13T23:05:00");
      expect(weekly(t.kv)).toMatchObject({ skipped: 1, matched: 2 });
    });

    it("発走時刻の補完待ちがある間: 全件を読まずに見送る", async () => {
      const t = await ready();
      const before = screen(t.kv);
      t.hooks.pending = 3;
      const reads = t.log.readAll;
      await night(t, "2026-10-12T23:05:00");
      expect(t.log.readAll).toBe(reads);
      expectSkipped(t, before);
      t.hooks.pending = 0;
      await retry(t);
    });

    it("全件の読みに未確認の分析(発走時刻が NULL)が混ざった: 見送る", async () => {
      const t = await ready();
      const before = screen(t.kv);
      const rows = t.db.rows;
      t.db.rows = { ...rows, analyses: rows.analyses.map((a, i) => (i === 0 ? { ...a, startTime: null } : a)) };
      await night(t, "2026-10-12T23:05:00");
      expect(t.log.readAll).toBeGreaterThan(0);
      expectSkipped(t, before);
      t.db.rows = rows;
      await retry(t);
    });
  });

  it("同じアラームで部分の tick が進んだ回(afterWork)は、全件を読まずに依頼を残し、次のアラームを張る。次のアラームで突き合わせる", async () => {
    const t = await ready();
    t.clock.now = jst("2026-10-12T23:05:00");
    t.setAlarmDirect(null);
    await t.core.requestWeeklyCheck();
    t.setAlarmDirect(null);
    const reads = t.log.readAll;
    await t.core.runWeeklyCheck({ afterWork: true });
    expect(t.log.readAll).toBe(reads);
    expect(t.getAlarm()).not.toBeNull();
    expect(weekly(t.kv).checked).toBe(1);
    await t.core.runWeeklyCheck({ afterWork: false });
    expect(t.log.readAll).toBe(reads + 1);
    expect(weekly(t.kv)).toMatchObject({ checked: 2, matched: 2 });
  });

  it("D1 の読みが失敗しても例外を投げない。警告を出し、記録は進めない(翌晩に再試行する)", async () => {
    const t = await ready();
    t.failure.readAll = true;
    await expect(night(t, "2026-10-12T23:05:00")).resolves.toBeUndefined();
    expect(t.warns.some((m) => m.includes("週 1 回"))).toBe(true);
    expect(weekly(t.kv).lastFullAt).toBeUndefined();
    t.failure.readAll = false;
    await night(t, "2026-10-13T23:05:00");
    expect(weekly(t.kv)).toMatchObject({ matched: 2 });
    expect(weekly(t.kv).lastFullAt).toBeGreaterThanOrEqual(jst("2026-10-13T23:05:00"));
  });
});
