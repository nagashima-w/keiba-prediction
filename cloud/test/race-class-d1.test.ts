import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1ResultStore } from "../src/result-repository";
import { D1VerifyStore } from "../src/verify-store";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #426(#389 の案 B): レースのクラス `analyses.race_class`(migration 0024)の書き込み 2 経路を、ローカル(workerd)の実 D1 で確かめる。
 *  - スナップショット側: 検証の DO の補完(`D1VerifyStore.commitStartTimes`。発走時刻・条件と同じ 1 文)。新しい分析の `race.raceClass` を写す。
 *  - 結果側: 結果の取り込み(`D1ResultStore.saveRaceClass`)。結果ページの `RaceData02` から読んだクラスを、そのレースの分析の行すべてに書く。
 * 2 経路は**どちらが先でも、先に入った値を NULL や別の値で消さない**(先着。NULL の列だけを埋める)。
 * ★限界(本番との差): ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しない。
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
const RACE_A = "202603020211";
const RACE_B = "202603020210";

function mkRecord(raceId: string): AnalysisRecord {
  return {
    raceId,
    analyzedAt: "2026-10-01T00:00:00.000Z",
    kaisaiDate: "20261001",
    promptVersion: "v-test",
    raceSnapshot: { race: { raceName: "x" } },
    horses: [{ umaban: 1, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null }],
  };
}
const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => NOW });
const verifyStore = () => new D1VerifyStore({ db: local.db, bucket: local.r2, now: () => NOW });
const resultStore = () => new D1ResultStore({ db: local.db });
const classOf = async (id: number): Promise<string | null> => (await local.db.prepare("SELECT race_class AS c FROM analyses WHERE id = ?").bind(id).first<{ c: string | null }>())!.c;
const FACTS = { courseType: "芝", distance: 1800, trackCondition: "良", grade: null, raceName: "x" };

describe("migration 0024: analyses.race_class", () => {
  it("TEXT・NULL 可の列があり、既存の行は NULL(未確認)のまま", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    const info = (await local.db.prepare("SELECT name, type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('analyses') WHERE name = 'race_class'").all<{ name: string; type: string; nn: number; d: unknown }>()).results;
    expect(info).toEqual([{ name: "race_class", type: "TEXT", nn: 0, d: null }]);
    expect(await classOf(1)).toBeNull();
  });
});

describe("D1ResultStore.saveRaceClass(結果側の書き込み)", () => {
  it("そのレースの分析の行すべてに書き、ほかのレースの行には書かない。書いた行数を返す", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await analyses().saveAnalysis(mkRecord(RACE_B));
    const out = await resultStore().saveRaceClass(RACE_A, "オープン");
    expect(out.rowsWritten).toBe(2);
    expect([await classOf(1), await classOf(2), await classOf(3)]).toEqual(["オープン", "オープン", null]);
  });

  it("冪等: 2 回目は何も書かない(rowsWritten 0)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    expect((await resultStore().saveRaceClass(RACE_A, "未勝利")).rowsWritten).toBe(1);
    expect((await resultStore().saveRaceClass(RACE_A, "未勝利")).rowsWritten).toBe(0);
    expect(await classOf(1)).toBe("未勝利");
  });

  it("★入っている値は上書きしない(違う値を渡しても元のまま。先着)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await resultStore().saveRaceClass(RACE_A, "1勝クラス");
    const out = await resultStore().saveRaceClass(RACE_A, "2勝クラス");
    expect(out.rowsWritten).toBe(0);
    expect(await classOf(1)).toBe("1勝クラス");
  });

  it("クラスが無い(null・undefined・空文字)なら D1 に何も発行しない。分析の無いレースは 0 行", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    const spy = spyDb(local.db);
    const store = new D1ResultStore({ db: spy.db });
    for (const value of [null, undefined, ""]) {
      expect((await store.saveRaceClass(RACE_A, value)).rowsWritten).toBe(0);
    }
    expect(spy.prepared).toHaveLength(0);
    expect(spy.batches).toHaveLength(0);
    // 対照: 値があれば発行する(上の「何も発行しない」が空振りでない)。分析の無いレースは書く行が無い。
    expect((await store.saveRaceClass("202603020299", "新馬")).rowsWritten).toBe(0);
    expect(spy.prepared.length + spy.batches.length).toBeGreaterThan(0);
    expect(await classOf(1)).toBeNull();
  });
});

describe("検証の補完(commitStartTimes)がスナップショットのクラスを写す", () => {
  it("新しい分析(cond_read NULL): facts.raceClass を race_class に書く。D1 は従来どおり 1 回の batch(2 文)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    const spy = spyDb(local.db);
    await new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW }).commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: { ...FACTS, raceClass: "オープン" } }]);
    expect(spy.batches).toEqual([2]);
    expect(await classOf(1)).toBe("オープン");
  });

  it("スナップショットにクラスが無い(キー無し)・読めなかった(facts: null)ときは NULL のまま", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await analyses().saveAnalysis(mkRecord(RACE_B));
    await verifyStore().commitStartTimes([{ id: 1, value: "" }, { id: 2, value: "" }], 0, [{ id: 1, facts: FACTS }, { id: 2, facts: null }]);
    expect([await classOf(1), await classOf(2)]).toEqual([null, null]);
  });

  it("確認済み(cond_read が NULL でない)の既存分には、スナップショットの値を写さない(発走時刻が NULL で UPDATE 自体は走る行でも、クラスは NULL のまま)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await local.db.prepare("UPDATE analyses SET cond_read = 1 WHERE id = 1").run(); // 条件は確認済み。発走時刻は NULL のまま(UPDATE の対象になる)
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 0, [{ id: 1, facts: { ...FACTS, raceClass: "新馬" } }]);
    const row = (await local.db.prepare("SELECT start_time AS t, cond_read AS c, race_class AS r FROM analyses WHERE id = 1").first<{ t: string | null; c: number; r: string | null }>())!;
    expect(row.t).toBe("15:45"); // 前提(空振り防止): UPDATE は実際に走った
    expect(row.c).toBe(1);
    expect(row.r).toBeNull();
  });
});

describe("検証の補完の通し(R2 の詳細のスナップショット → race_class)", () => {
  it("スナップショットの race.raceClass を、listPending → resolveStartTimes → commitStartTimes の通しで race_class に写す。クラスの無いスナップショットは NULL のまま", async () => {
    await analyses().saveAnalysis({ ...mkRecord(RACE_A), raceSnapshot: { race: { raceName: "ラジオNIKKEI賞", courseType: "芝", distance: 1800, raceClass: "オープン" } } });
    await analyses().saveAnalysis({ ...mkRecord(RACE_B), raceSnapshot: { race: { raceName: "旧い分析", courseType: "芝", distance: 1800 } } });
    const s = verifyStore();
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    // 前提(空振り防止): 1 件目の事実にクラスがあり、2 件目には無い
    expect(out.conditions?.[0]?.facts?.raceClass).toBe("オープン");
    expect(out.conditions?.[1]?.facts).not.toBeNull();
    expect("raceClass" in out.conditions![1]!.facts!).toBe(false);
    await s.commitStartTimes(out.resolved, out.gets, out.conditions);
    expect([await classOf(1), await classOf(2)]).toEqual(["オープン", null]);
  });
});

describe("★2 経路の順序(どちらが先でも、先に入った値を消さない)", () => {
  it("結果側が先 → スナップショット側が NULL(クラスなし): 結果側の値が残る(NULL で消さない)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await resultStore().saveRaceClass(RACE_A, "3勝クラス");
    expect(await classOf(1)).toBe("3勝クラス"); // 前提(空振り防止): 結果側の値が実際に入っている
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: FACTS }]);
    expect(await classOf(1)).toBe("3勝クラス");
    expect((await local.db.prepare("SELECT cond_read AS c FROM analyses WHERE id = 1").first<{ c: number }>())!.c).toBe(1); // 条件の写しは進んでいる
  });

  it("結果側が先 → スナップショット側が別の値: 結果側の値が残る(先着)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await resultStore().saveRaceClass(RACE_A, "オープン");
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: { ...FACTS, raceClass: "2勝クラス" } }]);
    expect(await classOf(1)).toBe("オープン");
  });

  it("結果側が先 → スナップショット側が『読めなかった』(facts: null、cond_read=0): 結果側の値が残る", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await resultStore().saveRaceClass(RACE_A, "未勝利");
    await verifyStore().commitStartTimes([{ id: 1, value: "?" }], 0, [{ id: 1, facts: null }]);
    expect(await classOf(1)).toBe("未勝利");
  });

  it("スナップショット側が先 → 結果側: スナップショットの値が残る(結果側は NULL の列だけを埋める)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: { ...FACTS, raceClass: "新馬" } }]);
    expect(await classOf(1)).toBe("新馬"); // 前提
    const out = await resultStore().saveRaceClass(RACE_A, "未勝利");
    expect(out.rowsWritten).toBe(0);
    expect(await classOf(1)).toBe("新馬");
  });

  it("スナップショット側が先でクラスなし(NULL)→ 結果側: 結果側の値で埋まる", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: FACTS }]);
    expect(await classOf(1)).toBeNull(); // 前提
    await resultStore().saveRaceClass(RACE_A, "1勝クラス");
    expect(await classOf(1)).toBe("1勝クラス");
  });
});
