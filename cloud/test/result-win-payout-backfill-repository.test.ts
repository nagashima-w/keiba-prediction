import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COUNT_PAYOUT_BACKFILL_SQL, D1ResultStore, LIST_PAYOUT_BACKFILL_SQL, UNIMPORTED_MAX_LIMIT } from "../src/result-repository";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #556: 結果の補完の段階 4(単勝の払戻の補完)の列挙・集計(`listPayoutBackfillRaces`・`countPayoutBackfill`)と、補完モードの保存(`saveWinPayout`)を、ローカル(workerd)の D1 で確かめる。
 * 対象は「分析済みで、結果の行があり、そのレースの全馬の `win_payout` が NULL」のレース。それ以外(新しい日を 1 日だけ・レースID 昇順・除外・開催日の扱い)は段階 1〜3 と同じ。
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
});

const store = (): D1ResultStore => new D1ResultStore({ db: local.db });

async function addAnalysis(raceId: string, kaisaiDate: string | null, i = 0): Promise<void> {
  await local.db
    .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)")
    .bind(raceId, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, kaisaiDate)
    .run();
}
/** 結果の行を作る。`winPayouts[i]` が馬番 i+1 の win_payout(null は NULL)。 */
async function addResult(raceId: string, winPayouts: ReadonlyArray<number | null> = [null, null]): Promise<void> {
  for (let i = 0; i < winPayouts.length; i += 1) {
    await local.db
      .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_payout) VALUES (?, ?, ?, ?)")
      .bind(raceId, i + 1, i + 1, winPayouts[i])
      .run();
  }
}
const ids = (rows: ReadonlyArray<{ raceId: string }>): string[] => rows.map((r) => r.raceId);

describe("listPayoutBackfillRaces: 結果はあるが全馬の win_payout が NULL のレースの、最も新しい日(to 以前)", () => {
  it("境界(テーブル駆動): 全馬 NULL だけが対象。1 頭でも払戻がある・結果の行が無い・to より後・開催日 NULL は対象外", async () => {
    const cases: Array<{ name: string; raceId: string; date: string | null; payouts: ReadonlyArray<number | null> | null; listed: boolean }> = [
      { name: "全馬 NULL", raceId: "ALLNULL", date: "20261003", payouts: [null, null, null], listed: true },
      { name: "1 頭だけ NULL でない(1 着)", raceId: "ONEPAID", date: "20261003", payouts: [340, null, null], listed: false },
      { name: "最後の馬だけ NULL でない", raceId: "LASTPAID", date: "20261003", payouts: [null, null, 120], listed: false },
      { name: "同着(2 頭に払戻)", raceId: "DEADHEAT", date: "20261003", payouts: [340, 410, null], listed: false },
      { name: "結果の行が無い(段階 1 の対象)", raceId: "NORESULT", date: "20261003", payouts: null, listed: false },
      { name: "to より後", raceId: "AFTER", date: "20261005", payouts: [null, null], listed: false },
      { name: "開催日 NULL", raceId: "NULLDATE", date: null, payouts: [null, null], listed: false },
      { name: "払戻が 0(0 は NULL でない)", raceId: "ZEROPAID", date: "20261003", payouts: [0, null], listed: false },
    ];
    for (const c of cases) {
      await addAnalysis(c.raceId, c.date);
      if (c.payouts !== null) await addResult(c.raceId, c.payouts);
    }
    // 前提(空振り防止): 対象になるケースと対象外のケースが両方ある
    expect(cases.filter((c) => c.listed).length).toBeGreaterThan(0);
    expect(cases.filter((c) => !c.listed).length).toBeGreaterThan(0);
    const listed = ids(await store().listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: 50 }));
    expect(listed).toEqual(cases.filter((c) => c.listed).map((c) => c.raceId));
  });

  it("並びはレースID 昇順。同じレースの複数の分析は 1 件", async () => {
    await addAnalysis("B2", "20261003", 1);
    await addAnalysis("B1", "20261003", 2);
    await addAnalysis("B1", "20261003", 3);
    await addResult("B2");
    await addResult("B1");
    expect(await store().listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([
      { raceId: "B1", kaisaiDate: "20261003" },
      { raceId: "B2", kaisaiDate: "20261003" },
    ]);
  });

  it("新しい日が尽きれば(払戻が入った・除外)、次に新しい日に移る。除外のレースは返さない。limit で切る", async () => {
    await addAnalysis("N1", "20261003");
    await addResult("N1");
    await addAnalysis("O1", "20261001");
    await addResult("O1");
    expect(ids(await store().listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: 50 }))).toEqual(["N1"]);
    expect(ids(await store().listPayoutBackfillRaces({ to: "20261004", exclude: ["N1"], limit: 50 }))).toEqual(["O1"]);
    await local.db.prepare("UPDATE race_results SET win_payout = 250 WHERE race_id = 'N1' AND umaban = 1").run();
    expect(ids(await store().listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: 50 }))).toEqual(["O1"]);
    await addAnalysis("O2", "20261001");
    await addResult("O2");
    expect(ids(await store().listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: 1 }))).toEqual(["O1"]);
  });

  it("開催日が分かれていれば最小の日に属する", async () => {
    await addAnalysis("SPLIT", "20261003", 1);
    await addAnalysis("SPLIT", "20261001", 2);
    await addResult("SPLIT");
    expect(await store().listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([{ raceId: "SPLIT", kaisaiDate: "20261001" }]);
  });

  it("入力の検査: to が YYYYMMDD でない・limit が範囲外・exclude が文字列の配列でないは RangeError(D1 には発行しない)", async () => {
    const spy = spyDb(local.db);
    const s = new D1ResultStore({ db: spy.db });
    await expect(s.listPayoutBackfillRaces({ to: "2026-10-04", exclude: [], limit: 10 })).rejects.toThrow(RangeError);
    await expect(s.listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: 0 })).rejects.toThrow(RangeError);
    await expect(s.listPayoutBackfillRaces({ to: "20261004", exclude: [], limit: UNIMPORTED_MAX_LIMIT + 1 })).rejects.toThrow(RangeError);
    await expect(s.listPayoutBackfillRaces({ to: "20261004", exclude: [1 as unknown as string], limit: 10 })).rejects.toThrow(RangeError);
    expect(spy.prepared).toHaveLength(0);
  });
});

describe("countPayoutBackfill: dated・undated・stillNull", () => {
  it("dated = 対象で開催日が to 以前かつ除外でない / undated = 対象で開催日がすべて NULL / stillNull = 対象のうち除外 ID に入っているレース", async () => {
    await addAnalysis("A", "20261003");
    await addAnalysis("B", "20261002");
    await addAnalysis("C", "20261001"); // 除外(取得済みなのにまだ NULL)
    await addAnalysis("D", "20261005"); // to より後
    await addAnalysis("U", null);
    await addAnalysis("PAID", "20261003");
    await addAnalysis("NORES", "20261003");
    for (const id of ["A", "B", "C", "D", "U"]) await addResult(id);
    await addResult("PAID", [200, null]);
    expect(await store().countPayoutBackfill({ to: "20261004", exclude: ["C"] })).toStrictEqual({ dated: 2, undated: 1, stillNull: 1 });
    expect(await store().countPayoutBackfill({ to: "20261004", exclude: [] })).toStrictEqual({ dated: 3, undated: 1, stillNull: 0 });
  });

  it("空の D1 は全部 0。入力の検査は列挙と同じ(RangeError)", async () => {
    expect(await store().countPayoutBackfill({ to: "20261004", exclude: [] })).toStrictEqual({ dated: 0, undated: 0, stillNull: 0 });
    await expect(store().countPayoutBackfill({ to: "x", exclude: [] })).rejects.toThrow(RangeError);
    await expect(store().countPayoutBackfill({ to: "20261004", exclude: "A" as unknown as string[] })).rejects.toThrow(RangeError);
  });
});

describe("読み取り行数の上界(meta.rows_read。【記録】区分の見積りの再現)", () => {
  it("N = 600 件の分析(300 レース × 2、全部対象。各 2 頭)で、列挙 1 回の rows_read は 8N 以下・件数 1 回は 6N 以下(実測はローカルの D1 で列挙 4,498・件数 3,298。N に比例する)", async () => {
    const N = 600;
    for (let r = 0; r < N / 2; r += 1) {
      const id = `R${String(r).padStart(4, "0")}`;
      await addAnalysis(id, "20261001", r * 2);
      await addAnalysis(id, "20261001", r * 2 + 1);
      await addResult(id);
    }
    const list = await local.db.prepare(LIST_PAYOUT_BACKFILL_SQL).bind("20261004", "[]", 30).all();
    const count = await local.db.prepare(COUNT_PAYOUT_BACKFILL_SQL).bind("20261004", "[]", "[]").all();
    expect(list.results).toHaveLength(30); // 前提(空振り防止): 対象が実際に列挙されている
    expect(list.meta.rows_read).toBeGreaterThan(0);
    expect(count.meta.rows_read).toBeGreaterThan(0);
    expect(list.meta.rows_read!).toBeLessThanOrEqual(8 * N);
    expect(count.meta.rows_read!).toBeLessThanOrEqual(6 * N);
  });
});

describe("saveWinPayout: 単勝の払戻を、win_payout が NULL の行にだけ書く", () => {
  async function rows(raceId: string): Promise<string> {
    return JSON.stringify((await local.db.prepare("SELECT * FROM race_results WHERE race_id = ? ORDER BY umaban").bind(raceId).all()).results);
  }

  it("NULL の行に書き、書いた行数を rowsWritten で返す。他の列(着順・複勝払戻・オッズ・人気・scratched)は変えない", async () => {
    await addAnalysis("202603020211", "20261003");
    await store().saveResult("202603020211", [
      { umaban: 1, finishPosition: 1, placePayout: 150, ninki: 1, winOdds: 3.4, wakuban: 1 },
      { umaban: 2, finishPosition: 2, placePayout: 210, ninki: 2, winOdds: 5.1, wakuban: 2 },
    ]);
    const before = await rows("202603020211");
    expect(before).toContain('"win_payout":null'); // 前提(空振り防止): 全馬 NULL から始まる
    const out = await store().saveWinPayout("202603020211", [
      { umaban: 1, finishPosition: 1, winPayout: 340 },
      { umaban: 2, finishPosition: 2, winPayout: null },
    ]);
    expect(out.rowsWritten).toBe(1);
    const after = JSON.parse(await rows("202603020211")) as Array<Record<string, unknown>>;
    expect(after.map((r) => r.win_payout)).toEqual([340, null]);
    const beforeRows = JSON.parse(before) as Array<Record<string, unknown>>;
    for (let i = 0; i < after.length; i += 1) {
      const { win_payout: _a, ...restAfter } = after[i]!;
      const { win_payout: _b, ...restBefore } = beforeRows[i]!;
      expect(restAfter).toEqual(restBefore);
    }
  });

  it("同着(1 着 2 頭)は、両馬に別々の払戻が入る", async () => {
    await addResult("DH", [null, null, null]);
    const out = await store().saveWinPayout("DH", [
      { umaban: 1, finishPosition: 1, winPayout: 340 },
      { umaban: 2, finishPosition: 1, winPayout: 410 },
      { umaban: 3, finishPosition: 3, winPayout: null },
    ]);
    expect(out.rowsWritten).toBe(2);
    const got = (await local.db.prepare("SELECT umaban, win_payout FROM race_results WHERE race_id = 'DH' ORDER BY umaban").all()).results as Array<{ umaban: number; win_payout: number | null }>;
    expect(got.map((r) => r.win_payout)).toEqual([340, 410, null]);
  });

  it("既にある払戻は上書きしない(別の値を渡しても、同じ値を渡しても rowsWritten は 0)。冪等", async () => {
    await addResult("PAID", [250, null]);
    const before = await rows("PAID");
    expect(before).toContain('"win_payout":250'); // 前提(空振り防止)
    expect((await store().saveWinPayout("PAID", [{ umaban: 1, finishPosition: 1, winPayout: 999 }])).rowsWritten).toBe(0);
    expect((await store().saveWinPayout("PAID", [{ umaban: 1, finishPosition: 1, winPayout: 250 }])).rowsWritten).toBe(0);
    expect(await rows("PAID")).toBe(before);
    // 同じ入力を 2 回: 1 回目で書き、2 回目は 0
    await addResult("TWICE", [null, null]);
    const entries = [{ umaban: 2, finishPosition: 1, winPayout: 480 }];
    expect((await store().saveWinPayout("TWICE", entries)).rowsWritten).toBe(1);
    expect((await store().saveWinPayout("TWICE", entries)).rowsWritten).toBe(0);
  });

  it("結果の行が無い馬番・レースには行を作らない", async () => {
    await addResult("ONLY1", [null]);
    expect((await store().saveWinPayout("ONLY1", [{ umaban: 5, finishPosition: 1, winPayout: 300 }])).rowsWritten).toBe(0);
    expect((await store().saveWinPayout("NOSUCH", [{ umaban: 1, finishPosition: 1, winPayout: 300 }])).rowsWritten).toBe(0);
    const n = (await local.db.prepare("SELECT COUNT(*) AS n FROM race_results").first<{ n: number }>())!.n;
    expect(n).toBe(1);
  });

  it("非 null の winPayout が 1 頭も無い入力(NaN・無限大・省略を含む)は、D1 に何も発行しない", async () => {
    const spy = spyDb(local.db);
    const s = new D1ResultStore({ db: spy.db });
    expect(
      await s.saveWinPayout("X", [
        { umaban: 1, finishPosition: 1, winPayout: null },
        { umaban: 2, finishPosition: 2 },
        { umaban: 3, finishPosition: 3, winPayout: Number.NaN },
        { umaban: 4, finishPosition: 4, winPayout: Number.POSITIVE_INFINITY },
      ]),
    ).toStrictEqual({ rowsWritten: 0 });
    expect(await s.saveWinPayout("X", [])).toStrictEqual({ rowsWritten: 0 });
    expect(spy.prepared).toHaveLength(0);
  });

  it("補完モードの保存を saveWinOdds → saveScratched → saveWinPayout と続けても、保存済みの結果に対しては全部 rowsWritten 0 で行は変わらない", async () => {
    const ENTRIES = [
      { umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 340, ninki: 1, winOdds: 3.4, wakuban: 1 },
      { umaban: 2, finishPosition: 2, placePayout: 210, winPayout: null, ninki: 2, winOdds: 5.1, wakuban: 2 },
      { umaban: 3, finishPosition: null, scratched: true, ninki: null, winOdds: null, wakuban: 3 },
    ] as const;
    await store().saveResult("202603020212", ENTRIES.map((e) => ({ ...e })));
    const before = await rows("202603020212");
    expect(before).toContain("340"); // 前提(空振り防止): 払戻が実際に保存されている
    expect((await store().saveWinOdds("202603020212", ENTRIES.map((e) => ({ ...e })))).rowsWritten).toBe(0);
    expect((await store().saveScratched("202603020212", ENTRIES.map((e) => ({ ...e })))).rowsWritten).toBe(0);
    expect((await store().saveWinPayout("202603020212", ENTRIES.map((e) => ({ ...e })))).rowsWritten).toBe(0);
    expect(await rows("202603020212")).toBe(before);
  });
});
