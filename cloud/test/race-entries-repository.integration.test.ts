import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1RaceEntriesStore } from "../src/race-entries-repository";
import type { RaceEntriesRecord, RaceEntryHorseRecord } from "../src/race-entries";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #799: 出馬表を D1 に貯める(`D1RaceEntriesStore`。migration 0050 の `race_entry_races`・`race_entry_horses`)。
 * ローカル(workerd)の D1 で、`wrangler d1 migrations apply --local`(CI と同じ実コマンド)で適用した表に対して確かめる。
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

const RACE_ID = "202603020211";

function horse(umaban: number, overrides: Partial<RaceEntryHorseRecord> = {}): RaceEntryHorseRecord {
  return {
    umaban,
    waku: Math.ceil(umaban / 2),
    horseId: `20230${String(umaban).padStart(5, "0")}`,
    jockeyId: `0${umaban}000`,
    trainerId: `0${umaban}100`,
    kinryo: 56.5,
    sex: "牡",
    age: 4,
    scratch: null,
    ...overrides,
  };
}

function record(overrides: { race?: Partial<RaceEntriesRecord["race"]>; horses?: readonly RaceEntryHorseRecord[] } = {}): RaceEntriesRecord {
  return {
    race: {
      raceId: RACE_ID,
      kaisaiDate: "20260628",
      venueCode: "03",
      courseType: "芝",
      distance: 2000,
      raceClass: "3勝クラス",
      grade: null,
      startTime: "15:45",
      savedAt: 1000,
      ...overrides.race,
    },
    horses: overrides.horses ?? [horse(1), horse(2), horse(3)],
  };
}

interface HorseRow {
  race_id: string;
  umaban: number;
  waku: number;
  horse_id: string;
  jockey_id: string | null;
  trainer_id: string | null;
  kinryo: number | null;
  sex: string | null;
  age: number | null;
  scratch: string | null;
  saved_at: number;
}

const horseRows = async (): Promise<HorseRow[]> =>
  (await local.db.prepare("SELECT race_id, umaban, waku, horse_id, jockey_id, trainer_id, kinryo, sex, age, scratch, saved_at FROM race_entry_horses ORDER BY race_id, umaban").all<HorseRow>()).results;
const raceRows = async (): Promise<Record<string, unknown>[]> =>
  (await local.db.prepare("SELECT * FROM race_entry_races ORDER BY race_id").all<Record<string, unknown>>()).results;

/** 流れた文ごとの rows_written を控える(D1 の `meta`)。 */
function recordingDb(real: D1Database): { db: Pick<D1Database, "prepare">; written: number[] } {
  const written: number[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      return {
        bind: (...values: unknown[]) => {
          const bound = stmt.bind(...values);
          return {
            run: async () => {
              const result = await bound.run();
              written.push(result.meta.rows_written ?? 0);
              return result;
            },
          };
        },
      };
    },
  } as unknown as Pick<D1Database, "prepare">;
  return { db, written };
}

describe("D1RaceEntriesStore(Issue #799)", () => {
  it("新しいレースは、レースの行 1 つと馬の行(全頭)が入る。各列が取り違えずに入る", async () => {
    await new D1RaceEntriesStore({ db: local.db }).save(record());
    expect(await raceRows()).toEqual([
      { race_id: RACE_ID, kaisai_date: "20260628", venue_code: "03", course_type: "芝", distance: 2000, race_class: "3勝クラス", grade: null, start_time: "15:45", saved_at: 1000 },
    ]);
    const rows = await horseRows();
    expect(rows).toHaveLength(3); // 前提: 空振りでない
    expect(rows[1]).toEqual({ race_id: RACE_ID, umaban: 2, waku: 1, horse_id: "2023000002", jockey_id: "02000", trainer_id: "02100", kinryo: 56.5, sex: "牡", age: 4, scratch: null, saved_at: 1000 });
  });

  it("騎手 ID・調教師 ID・クラス・発走時刻が null の行も入り、取消の馬(騎手などが null・scratch あり)も行として入る", async () => {
    await new D1RaceEntriesStore({ db: local.db }).save(
      record({
        race: { raceClass: null, startTime: null },
        horses: [horse(1, { jockeyId: null, trainerId: null }), horse(2, { jockeyId: null, trainerId: null, kinryo: null, sex: null, age: null, scratch: "取消" })],
      }),
    );
    const rows = await horseRows();
    expect(rows[0]).toMatchObject({ jockey_id: null, trainer_id: null, scratch: null });
    expect(rows[1]).toMatchObject({ kinryo: null, sex: null, age: null, scratch: "取消" });
    expect(await raceRows()).toEqual([expect.objectContaining({ race_class: null, start_time: null })]);
  });

  it("同じ値の再保存は 1 行も書かない(3 文とも rows_written が 0。saved_at も変わらない)", async () => {
    const { db, written } = recordingDb(local.db);
    const store = new D1RaceEntriesStore({ db });
    await store.save(record());
    expect(written).toHaveLength(3); // 前提: 1 レースは 3 文
    expect(written[0]! + written[1]!).toBeGreaterThan(0); // 前提: 初回は書く(下の 0 が空振りでない)
    await store.save(record({ race: { savedAt: 9000 } }));
    expect(written.slice(3)).toEqual([0, 0, 0]);
    expect((await horseRows()).every((r) => r.saved_at === 1000)).toBe(true);
    expect((await raceRows())[0]!["saved_at"]).toBe(1000);
  });

  it("値が変わった馬だけが更新される(斤量の変更。ほかの馬と saved_at はそのまま)。騎手の入れ替えや NULL との差も更新する", async () => {
    const { db, written } = recordingDb(local.db);
    const store = new D1RaceEntriesStore({ db });
    await store.save(record());
    await store.save(record({ race: { savedAt: 2000 }, horses: [horse(1), horse(2, { kinryo: 57 }), horse(3)] }));
    expect(written[4]).toBe(1); // 馬の文: 変わった 1 頭だけ
    const rows = await horseRows();
    expect(rows.map((r) => [r.umaban, r.kinryo, r.saved_at])).toEqual([
      [1, 56.5, 1000],
      [2, 57, 2000],
      [3, 56.5, 1000],
    ]);
    await store.save(record({ race: { savedAt: 3000 }, horses: [horse(1, { jockeyId: null }), horse(2, { kinryo: 57 }), horse(3, { jockeyId: "09999" })] }));
    const rows2 = await horseRows();
    expect(rows2[0]).toMatchObject({ jockey_id: null, saved_at: 3000 });
    expect(rows2[2]).toMatchObject({ jockey_id: "09999", saved_at: 3000 });
  });

  it("当日に取消になった馬は、scratch が書き換わる(馬の行は残る)", async () => {
    const store = new D1RaceEntriesStore({ db: local.db });
    await store.save(record());
    await store.save(record({ race: { savedAt: 2000 }, horses: [horse(1), horse(2, { jockeyId: null, trainerId: null, kinryo: null, sex: null, age: null, scratch: "取消" }), horse(3)] }));
    const rows = await horseRows();
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ umaban: 2, scratch: "取消", jockey_id: null, saved_at: 2000 });
  });

  it("出馬表から消えた馬の行は消す(そのレースだけ。別のレースの行は残る)", async () => {
    const store = new D1RaceEntriesStore({ db: local.db });
    const other = record({ race: { raceId: "202603020212" }, horses: [horse(1), horse(2)] });
    await store.save(record());
    await store.save(other);
    expect(await horseRows()).toHaveLength(5); // 前提: 5 行ある
    await store.save(record({ race: { savedAt: 2000 }, horses: [horse(1), horse(3)] }));
    const rows = await horseRows();
    expect(rows.map((r) => [r.race_id, r.umaban])).toEqual([
      [RACE_ID, 1],
      [RACE_ID, 3],
      ["202603020212", 1],
      ["202603020212", 2],
    ]);
  });

  it("レースの値(距離・発走時刻・クラス)が変わったら、レースの行も更新する", async () => {
    const store = new D1RaceEntriesStore({ db: local.db });
    await store.save(record());
    await store.save(record({ race: { savedAt: 2000, startTime: "15:50", raceClass: null } }));
    expect(await raceRows()).toEqual([expect.objectContaining({ start_time: "15:50", race_class: null, saved_at: 2000 })]);
  });

  it("開催日の索引で、その日のレースを引ける(別の日は出ない)", async () => {
    const store = new D1RaceEntriesStore({ db: local.db });
    await store.save(record());
    await store.save(record({ race: { raceId: "202603020301", kaisaiDate: "20260705" } }));
    const { results } = await local.db.prepare("SELECT race_id FROM race_entry_races WHERE kaisai_date = ? ORDER BY race_id").bind("20260628").all<{ race_id: string }>();
    expect(results).toEqual([{ race_id: RACE_ID }]);
    const plan = (await local.db.prepare("EXPLAIN QUERY PLAN SELECT race_id FROM race_entry_races WHERE kaisai_date = ?").bind("20260628").all<{ detail: string }>()).results;
    expect(plan.map((p) => p.detail).join("\n")).toContain("idx_race_entry_races_date");
  });

  it("D1 の失敗は投げる(握るのは呼び出し側)", async () => {
    const db = { prepare: () => { throw new Error("D1 の失敗(テスト)"); } } as unknown as Pick<D1Database, "prepare">;
    await expect(new D1RaceEntriesStore({ db }).save(record())).rejects.toThrow("D1 の失敗");
  });
});
