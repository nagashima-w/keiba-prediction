import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1VerifyStore } from "../src/verify-store";
import { VerifyCore, type VerifyKv } from "../src/verify-core";
import { verifyRaceMarkStatement } from "../src/verify-race-mark";
import { NO_DATE_DAY } from "../src/verify-parts";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #628: 差分の集計の D1 の読み(`D1VerifyStore.readMaxSeq`・`readMarks`・`readDays`・`readDay`)を、ローカル(workerd)の D1 で確かめる。
 * 読んだ行数は D1 が報告する `meta.rows_read`(偽物の数え方ではない)。
 */
let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run();
});

const NOW = new Date("2026-10-10T12:00:00.000Z");
const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => NOW });
const store = () => new D1VerifyStore({ db: local.db, bucket: local.r2, now: () => NOW });

function record(raceNo: number, kaisaiDate: string | null): AnalysisRecord {
  return {
    raceId: `2026060308${String(10 + raceNo).padStart(2, "0")}`,
    analyzedAt: "2026-10-01T00:00:00.000Z",
    kaisaiDate,
    promptVersion: "v-test",
    raceSnapshot: { race: { raceName: "x" } },
    horses: [1, 2, 3].map((umaban) => ({ umaban, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1 + umaban / 10, isPositive: true, contributions: null, mark: null })),
  };
}

/** `days` 日ぶん、1 日 `perDay` レースを保存し、補完済みにして、全レースに結果を入れる。 */
async function seed(days: number, perDay: number): Promise<void> {
  let n = 0;
  for (let d = 0; d < days; d += 1) {
    for (let r = 0; r < perDay; r += 1) {
      n += 1;
      await analyses().saveAnalysis(record(n, `202610${String(1 + d).padStart(2, "0")}`));
    }
  }
  await local.db.prepare("UPDATE analyses SET start_time = '09:00', cond_read = 0").run();
  await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout) SELECT race_id, 1, 1, 150, 300 FROM analyses").run();
  await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout) SELECT race_id, 2, 2, 130, NULL FROM analyses").run();
}

describe("差分の集計の D1 の読み", () => {
  it("1 日の読みが返す行数と rows_read は、ほかの開催日の数に依らない。日の読みは全件の読みの、その日の分と同じ行", async () => {
    await seed(3, 3);
    const small = await store().readDay("20261002");
    await local.reset();
    await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run();
    await seed(12, 3);
    const large = await store().readDay("20261002");
    expect(small.rows.analyses).toHaveLength(3); // 前提: その日の分析を読んだ
    expect(small.rows.horses).toHaveLength(9);
    expect(small.rows.results).toHaveLength(6);
    expect(small.rowsRead).toBeGreaterThan(0);
    expect(large.rowsRead).toBe(small.rowsRead);
    const all = await store().readAll();
    expect(all.rows.analyses.length).toBe(36); // 全件の読みは日の数に比例して増える(対比)
    expect(all.rowsRead).toBeGreaterThan(large.rowsRead * 3);
  });

  it("印: readMaxSeq は印の最大値、readMarks は seq より後の印だけ(開催日が NULL の印は null で返す)", async () => {
    expect(await store().readMaxSeq()).toBe(0);
    await seed(2, 2);
    const max = await store().readMaxSeq();
    expect(max).toBeGreaterThanOrEqual(4);
    const after = await store().readMarks(max - 1, 100);
    expect(after.marks).toHaveLength(1);
    expect(after.rowsRead).toBe(1); // 古い印は読まない
    await analyses().saveAnalysis(record(99, null));
    const marks = await store().readMarks(max, 100);
    expect(marks.marks.map((m) => m.kaisaiDate)).toEqual([null]);
  });

  it("readDays は開催日の一覧(NULL の分析があれば none)。NULL の日の読みはその分析だけ", async () => {
    await seed(2, 1);
    await analyses().saveAnalysis(record(50, null));
    expect((await store().readDays()).days).toEqual([NO_DATE_DAY, "20261001", "20261002"]);
    expect((await store().readDay(NO_DATE_DAY)).rows.analyses.map((a) => a.kaisaiDate)).toEqual([null]);
  });
});

describe("差分の集計の通し(実 D1 + VerifyCore)", () => {
  function core() {
    const data = new Map<string, unknown>();
    const kv: VerifyKv = { get: <T>(k: string) => data.get(k) as T | undefined, put: (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))), delete: (k) => data.delete(k) };
    let alarm: number | null = null;
    const clock = { t: NOW.getTime() };
    const warns: string[] = [];
    const c = new VerifyCore({ kv, now: () => clock.t, setAlarm: (at) => void (alarm = at), getAlarm: async () => alarm, store: store(), onWarn: (m) => warns.push(m) }, {});
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 50 && alarm !== null; i += 1) {
        alarm = null;
        await c.runPartsTick();
      }
    };
    const alarms = async (): Promise<void> => {
      for (let i = 0; i < 50 && alarm !== null; i += 1) {
        alarm = null;
        const progressed = await c.runPartsTickWithProgress();
        await c.runWeeklyCheck({ afterWork: progressed });
        clock.t += 1_000;
      }
    };
    const night = async (when: string): Promise<void> => {
      clock.t = Date.parse(`${when}+09:00`);
      await c.requestWeeklyCheck();
      await alarms();
    };
    return { c, kv, drain, warns, clock, night };
  }

  it("全件の集計と、日ごとの部分の集計が一致する(開催日が NULL の分析を含む)。印だけの更新は、その日だけ読み直して一致のまま", async () => {
    await seed(6, 3);
    await analyses().saveAnalysis(record(77, null));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00', cond_read = 0 WHERE kaisai_date IS NULL").run();
    const { c, kv, drain, warns, clock } = core();
    const res = await c.getReport("all");
    expect(res.status).toBe("ready");
    if (res.status === "ready") expect(res.report.includedAnalysisCount).toBeGreaterThan(10); // 前提: 空の集計ではない
    await drain();
    expect(kv.get("partsCheck")).toMatchObject({ checked: 1, matched: 1, mismatched: 0, skipped: 0 });
    expect(warns).toEqual([]);
    // 印だけの更新(中身は変わらない): 全件の再計算の後、その 1 日だけが読み直されて、また一致する。
    await local.db.batch([verifyRaceMarkStatement(local.db, "202606030811")]);
    clock.t += 6 * 60_000;
    const again = await c.getReport("all", { refresh: true });
    expect(again.status).toBe("ready");
    await drain();
    // 2 回目は差分の道(部分から組み立てた集計)なので、突き合わせの対象外(1 回目の全件読みの 1 回だけ)。
    expect(kv.get("partsCheck")).toMatchObject({ checked: 1, matched: 1, mismatched: 0 });
    if (again.status !== "ready" || res.status !== "ready") throw new Error("ready のはず");
    expect(again.report).toEqual(res.report);
  });

  it("週 1 回の突き合わせ(Issue #723): 実 D1 の全件の読みと部分の集計が一致する。印を付けずに書いた行は、次の週にずれとして見つかり、部分が作り直されて、その次の週は一致する", async () => {
    await seed(6, 3);
    const { c, kv, drain, warns, night } = core();
    expect((await c.getReport("all")).status).toBe("ready");
    await drain();
    expect(kv.get("partsCheck")).toMatchObject({ checked: 1, matched: 1, mismatched: 0 }); // 前提: 部分が揃っている
    const screen = (): string => JSON.stringify(["cache", "runs", "rebuilds", "partsBase"].map((k) => kv.get(k) ?? null));
    const before = screen();
    await night("2026-10-12T23:05:00");
    const w1 = kv.get("partsCheck") as { checked: number; matched: number; mismatched: number; lastFullRowsRead: number; lastFullAt: number };
    expect(w1).toMatchObject({ checked: 2, matched: 2, mismatched: 0 });
    expect(w1.lastFullRowsRead).toBeGreaterThan(18); // 前提: 実際に全件(分析 18 行より多い)を読んだ行数が D1 の meta から入っている
    expect(screen()).toBe(before);
    expect(warns).toEqual([]);
    // 印を付けない書き込み(印の文を通さない DELETE。そのレースの結果が消え、全件の集計だけが変わる)
    await local.db.prepare("DELETE FROM race_results WHERE race_id = (SELECT MIN(race_id) FROM analyses)").run();
    await night("2026-10-19T23:05:00");
    const w2 = kv.get("partsCheck") as { checked: number; matched: number; mismatched: number; lastPaths: string[] };
    expect(w2).toMatchObject({ checked: 3, matched: 2, mismatched: 1 });
    expect(w2.lastPaths.length).toBeGreaterThan(0);
    expect(warns.filter((m) => m.includes("突き合わせのずれ"))).toHaveLength(1);
    expect(screen()).toBe(before);
    await drain(); // 作り直し
    await night("2026-10-26T23:05:00");
    expect(kv.get("partsCheck")).toMatchObject({ checked: 4, matched: 3, mismatched: 1 });
  });

  /** 差分の読みを持たない窓口(全件を読む形)で、今の行を集計する。 */
  async function fullReadReport() {
    const real = store();
    const noParts = new Proxy(real, {
      get: (target, key) => {
        if (key === "readMaxSeq" || key === "readMarks" || key === "readDays" || key === "readDay") return undefined;
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const data = new Map<string, unknown>();
    const kv: VerifyKv = { get: <T>(k: string) => data.get(k) as T | undefined, put: (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))) };
    const c = new VerifyCore({ kv, now: () => NOW.getTime(), setAlarm: () => undefined, getAlarm: async () => null, store: noParts }, {});
    const res = await c.getReport("all");
    if (res.status !== "ready") throw new Error("ready のはず");
    return res;
  }

  it("再計算の diag.rowsRead(その回に読んだ量)は、古い開催日が 2 日でも 10 日でも同じ。値は全件を読む形と一致する(本物の D1 の meta.rows_read)", async () => {
    const measure = async (oldDays: number): Promise<{ rowsRead: number; analysesRead: number; same: boolean }> => {
      await local.reset();
      await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run();
      await seed(oldDays + 1, 3); // 最後の 1 日(20261001 + oldDays)だけを後で変える
      const { c, drain, clock } = core();
      await c.getReport("all");
      await drain();
      clock.t += 6 * 60_000;
      const changed = `202610${String(1 + oldDays).padStart(2, "0")}`;
      await local.db.prepare("UPDATE race_results SET place_payout = place_payout + 50 WHERE race_id IN (SELECT race_id FROM analyses WHERE kaisai_date = ?)").bind(changed).run();
      const raceId = (await local.db.prepare("SELECT race_id FROM analyses WHERE kaisai_date = ? LIMIT 1").bind(changed).first<{ race_id: string }>())!.race_id;
      await local.db.batch([verifyRaceMarkStatement(local.db, raceId)]);
      const res = await c.getReport("all", { refresh: true }); // 結果の行の書き換えは透かしに出ないので、更新の要求(または TTL)で拾う
      if (res.status !== "ready") throw new Error("ready のはず");
      const full = await fullReadReport();
      return { rowsRead: res.diag.rowsRead, analysesRead: res.diag.counts["analyses"] ?? -1, same: JSON.stringify(res.report) === JSON.stringify(full.report) };
    };
    const small = await measure(2);
    const large = await measure(10);
    expect(small.rowsRead).toBeGreaterThan(0); // 前提: 日を読んだ
    expect(small.analysesRead).toBe(3); // 前提: 変えた日の分析だけを読んだ(古い日は読まない)
    expect(large.rowsRead).toBe(small.rowsRead);
    expect(small.same).toBe(true);
    expect(large.same).toBe(true);
  });
});
