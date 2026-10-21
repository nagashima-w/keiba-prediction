import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COUNT_CLASS_BACKFILL_SQL, D1ResultStore, LIST_CLASS_BACKFILL_SQL, UNIMPORTED_MAX_LIMIT } from "../src/result-repository";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #426-b: 結果の補完の段階 3(レースのクラス)の列挙・集計・分布(`listClassBackfillRaces`・`countClassBackfill`・`classDistribution`)を、ローカル(workerd)の D1 で確かめる。
 * 対象は「分析済みで、結果の行があり、そのレースの分析の行に `race_class` が NULL のものがある」レース。それ以外(新しい日を 1 日だけ・レースID 昇順・除外・開催日の扱い)は段階 1・2 と同じ。
 * あわせて、段階 3 が使う補完モードの保存(`saveWinOdds`・`saveScratched`)が、保存済みの結果に対して書き込み 0 であること(`saveRaceClass` だけが書くこと)を実 D1 で固定する。
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

async function addAnalysis(raceId: string, kaisaiDate: string | null, raceClass: string | null = null, i = 0): Promise<void> {
  await local.db
    .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, race_class) VALUES (?, ?, 0, ?, ?)")
    .bind(raceId, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, kaisaiDate, raceClass)
    .run();
}
async function addResult(raceId: string, horses = 2): Promise<void> {
  for (let i = 1; i <= horses; i += 1) {
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES (?, ?, ?)").bind(raceId, i, i).run();
  }
}
const ids = (rows: ReadonlyArray<{ raceId: string }>): string[] => rows.map((r) => r.raceId);

describe("listClassBackfillRaces: 結果はあるがクラスが NULL のレースの、最も新しい日(to 以前)", () => {
  it("結果の行があり race_class が NULL のレースだけを返す。結果なし・クラスあり・to より後・開催日 NULL は返さない", async () => {
    await addAnalysis("NEED2", "20261003");
    await addAnalysis("NEED1", "20261003");
    await addAnalysis("NORESULT", "20261003"); // 結果が無い = 段階 1 の対象
    await addAnalysis("HASCLASS", "20261003", "オープン");
    await addAnalysis("AFTER", "20261005");
    await addAnalysis("NULLDATE", null);
    for (const id of ["NEED2", "NEED1", "HASCLASS", "AFTER", "NULLDATE"]) await addResult(id);
    expect(await store().listClassBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([
      { raceId: "NEED1", kaisaiDate: "20261003" },
      { raceId: "NEED2", kaisaiDate: "20261003" },
    ]);
  });

  it("同じレースの分析のうち 1 行でもクラスが NULL なら対象。全部クラスありなら対象外。同じレースは 1 件", async () => {
    await addAnalysis("MIXED", "20261003", "新馬", 1);
    await addAnalysis("MIXED", "20261003", null, 2);
    await addAnalysis("MIXED", "20261003", null, 3);
    await addAnalysis("FULL", "20261003", "未勝利", 4);
    await addAnalysis("FULL", "20261003", "未勝利", 5);
    await addResult("MIXED");
    await addResult("FULL");
    expect(ids(await store().listClassBackfillRaces({ to: "20261004", exclude: [], limit: 50 }))).toEqual(["MIXED"]);
  });

  it("新しい日が尽きれば(クラスが入った・除外)、次に新しい日に移る。除外のレースは返さない。limit で切る", async () => {
    await addAnalysis("N1", "20261003");
    await addResult("N1");
    await addAnalysis("O1", "20261001");
    await addResult("O1");
    expect(ids(await store().listClassBackfillRaces({ to: "20261004", exclude: [], limit: 50 }))).toEqual(["N1"]);
    expect(ids(await store().listClassBackfillRaces({ to: "20261004", exclude: ["N1"], limit: 50 }))).toEqual(["O1"]);
    await local.db.prepare("UPDATE analyses SET race_class = '1勝クラス' WHERE race_id = 'N1'").run();
    expect(ids(await store().listClassBackfillRaces({ to: "20261004", exclude: [], limit: 50 }))).toEqual(["O1"]);
    await addAnalysis("O2", "20261001");
    await addResult("O2");
    expect(ids(await store().listClassBackfillRaces({ to: "20261004", exclude: [], limit: 1 }))).toEqual(["O1"]);
  });

  it("開催日が分かれていれば最小の日に属する。開催日が NULL の分析と混ざるレースは、NULL を無視した最小の日", async () => {
    await addAnalysis("SPLIT", "20261003", null, 1);
    await addAnalysis("SPLIT", "20261001", null, 2);
    await addResult("SPLIT");
    expect(await store().listClassBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([{ raceId: "SPLIT", kaisaiDate: "20261001" }]);
  });

  it("入力の検査: to が YYYYMMDD でない・limit が範囲外・exclude が文字列の配列でないは RangeError(D1 には発行しない)", async () => {
    const spy = spyDb(local.db);
    const s = new D1ResultStore({ db: spy.db });
    await expect(s.listClassBackfillRaces({ to: "2026-10-04", exclude: [], limit: 10 })).rejects.toThrow(RangeError);
    await expect(s.listClassBackfillRaces({ to: "20261004", exclude: [], limit: 0 })).rejects.toThrow(RangeError);
    await expect(s.listClassBackfillRaces({ to: "20261004", exclude: [], limit: UNIMPORTED_MAX_LIMIT + 1 })).rejects.toThrow(RangeError);
    await expect(s.listClassBackfillRaces({ to: "20261004", exclude: [1 as unknown as string], limit: 10 })).rejects.toThrow(RangeError);
    expect(spy.prepared).toHaveLength(0);
  });
});

describe("countClassBackfill: dated・undated・stillNull", () => {
  it("dated = 対象で開催日が to 以前かつ除外でない / undated = 対象で開催日がすべて NULL / stillNull = 対象のうち除外 ID に入っているレース", async () => {
    await addAnalysis("A", "20261003");
    await addAnalysis("B", "20261002");
    await addAnalysis("C", "20261001"); // 除外(取得済みなのにまだ NULL)
    await addAnalysis("D", "20261005"); // to より後
    await addAnalysis("U", null);
    await addAnalysis("HAS", "20261003", "オープン");
    await addAnalysis("NORES", "20261003");
    for (const id of ["A", "B", "C", "D", "U", "HAS"]) await addResult(id);
    expect(await store().countClassBackfill({ to: "20261004", exclude: ["C"] })).toStrictEqual({ dated: 2, undated: 1, stillNull: 1 });
    expect(await store().countClassBackfill({ to: "20261004", exclude: [] })).toStrictEqual({ dated: 3, undated: 1, stillNull: 0 });
  });

  it("空の D1 は全部 0。入力の検査は列挙と同じ(RangeError)", async () => {
    expect(await store().countClassBackfill({ to: "20261004", exclude: [] })).toStrictEqual({ dated: 0, undated: 0, stillNull: 0 });
    await expect(store().countClassBackfill({ to: "x", exclude: [] })).rejects.toThrow(RangeError);
    await expect(store().countClassBackfill({ to: "20261004", exclude: "A" as unknown as string[] })).rejects.toThrow(RangeError);
  });
});

describe("classDistribution: race_class の値ごとのレース数(上位 40)", () => {
  it("同じレースの複数の分析は 1 レースと数える。NULL は含めない。レース数の降順・同数は値の昇順", async () => {
    await addAnalysis("R1", "20261001", "未勝利", 1);
    await addAnalysis("R1", "20261001", "未勝利", 2);
    await addAnalysis("R2", "20261001", "未勝利", 3);
    await addAnalysis("R3", "20261001", "C1", 4);
    await addAnalysis("R4", "20261001", "A2B1", 5);
    await addAnalysis("R5", "20261001", null, 6);
    expect(await store().classDistribution()).toStrictEqual([
      { value: "未勝利", races: 2 },
      { value: "A2B1", races: 1 },
      { value: "C1", races: 1 },
    ]);
  });

  it("上位 40 件で切る(41 種あれば 40 件)", async () => {
    for (let i = 0; i < 41; i += 1) await addAnalysis(`R${i}`, "20261001", `V${String(i).padStart(2, "0")}`, i);
    const out = await store().classDistribution();
    expect(out).toHaveLength(40);
    expect(out[0]).toStrictEqual({ value: "V00", races: 1 });
  });
});

describe("読み取り行数の上界(meta.rows_read。見積りの再現)", () => {
  it("N = 600 件の分析(300 レース × 2、全部対象)で、列挙 1 回の rows_read は 5N 以下・件数 1 回は 3N 以下(索引なしの race_class を見る分の全走査を含む。実測は列挙 2,700・件数 1,500)", async () => {
    const N = 600;
    for (let r = 0; r < N / 2; r += 1) {
      const id = `R${String(r).padStart(4, "0")}`;
      await addAnalysis(id, "20261001", null, r * 2);
      await addAnalysis(id, "20261001", null, r * 2 + 1);
      await addResult(id);
    }
    // rows_read は D1 の meta から読む(生の prepare で実行して測る)。SQL は本番のものをそのまま使う。
    const list = await local.db.prepare(LIST_CLASS_BACKFILL_SQL).bind("20261004", "[]", 30).all();
    const count = await local.db.prepare(COUNT_CLASS_BACKFILL_SQL).bind("20261004", "[]", "[]").all();
    expect(list.results).toHaveLength(30); // 前提(空振り防止): 対象が実際に列挙されている
    expect(list.meta.rows_read).toBeGreaterThan(0);
    expect(count.meta.rows_read).toBeGreaterThan(0);
    expect(list.meta.rows_read!).toBeLessThanOrEqual(5 * N);
    expect(count.meta.rows_read!).toBeLessThanOrEqual(3 * N);
  });
});

describe("補完モードの保存(段階 3 が winOddsOnly の依頼で行うこと)は、保存済みの結果に対して書き込み 0", () => {
  const ENTRIES = [
    { umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 340, ninki: 1, winOdds: 3.4, wakuban: 1 },
    { umaban: 2, finishPosition: 2, placePayout: 210, winPayout: null, ninki: 2, winOdds: 5.1, wakuban: 2 },
    { umaban: 3, finishPosition: null, scratched: true, ninki: null, winOdds: null, wakuban: 3 },
  ] as const;

  it("saveResult 済みのレースに saveWinOdds・saveScratched を続けて呼んでも rowsWritten は 0 で行は変わらず、続く saveRaceClass だけが書く", async () => {
    await addAnalysis("202603020211", "20261003");
    await store().saveResult("202603020211", ENTRIES.map((e) => ({ ...e })));
    const before = JSON.stringify((await local.db.prepare("SELECT * FROM race_results WHERE race_id = '202603020211' ORDER BY umaban").all()).results);
    expect(before).toContain("3.4"); // 前提(空振り防止): オッズが実際に保存されている
    const odds = await store().saveWinOdds("202603020211", ENTRIES.map((e) => ({ ...e })));
    const scratched = await store().saveScratched("202603020211", ENTRIES.map((e) => ({ ...e })));
    expect(odds.rowsWritten).toBe(0);
    expect(scratched.rowsWritten).toBe(0);
    expect(JSON.stringify((await local.db.prepare("SELECT * FROM race_results WHERE race_id = '202603020211' ORDER BY umaban").all()).results)).toBe(before);
    expect((await store().saveRaceClass("202603020211", "オープン")).rowsWritten).toBe(1);
  });
});
