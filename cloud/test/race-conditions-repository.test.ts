import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1RaceConditionsStore } from "../src/race-conditions-repository";
import { toRaceConditionRecord } from "../src/race-conditions";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #421 段階 1: レースの条件を D1 に貯める(`D1RaceConditionsStore`。migration 0022 の `race_conditions`)。
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

interface Row {
  race_id: string;
  weight_type: string | null;
  fillies_only: number;
  saved_at: number;
}

async function rows(): Promise<Row[]> {
  return (await local.db.prepare("SELECT race_id, weight_type, fillies_only, saved_at FROM race_conditions ORDER BY race_id").all<Row>()).results;
}

/** 書き込んだ SQL の rows_written を読む(D1 の `meta`)。 */
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

describe("D1RaceConditionsStore(Issue #421 段階 1)", () => {
  it("新しいレースは 1 行入る(種別・牝馬限定・時刻。牝馬限定は 1/0)", async () => {
    const store = new D1RaceConditionsStore({ db: local.db });
    await store.save({ raceId: "202603020211", weightType: "ハンデ", filliesOnly: false, savedAt: 1000 });
    await store.save({ raceId: "202606040901", weightType: "馬齢", filliesOnly: true, savedAt: 2000 });
    expect(await rows()).toEqual([
      { race_id: "202603020211", weight_type: "ハンデ", fillies_only: 0, saved_at: 1000 },
      { race_id: "202606040901", weight_type: "馬齢", fillies_only: 1, saved_at: 2000 },
    ]);
  });

  it("種別が決まらなかったレース(weightType=null)は weight_type が NULL で入る", async () => {
    await new D1RaceConditionsStore({ db: local.db }).save({ raceId: "202603020211", weightType: null, filliesOnly: false, savedAt: 1000 });
    expect(await rows()).toEqual([{ race_id: "202603020211", weight_type: null, fillies_only: 0, saved_at: 1000 }]);
  });

  it("同じ値の再保存は行を書かない(rows_written が 0 で、saved_at も変わらない)。値が違えば書き換わる", async () => {
    const { db, written } = recordingDb(local.db);
    const store = new D1RaceConditionsStore({ db });
    const record = { raceId: "202603020211", weightType: "ハンデ" as const, filliesOnly: false, savedAt: 1000 };
    await store.save(record);
    expect(written[0]).toBeGreaterThan(0); // 前提: 初回は書く(0 でないので、下の 0 が空振りでない)
    await store.save({ ...record, savedAt: 9000 });
    expect(written[1]).toBe(0);
    expect((await rows())[0]!.saved_at).toBe(1000);
    // 種別が変われば更新する。
    await store.save({ ...record, weightType: "別定", savedAt: 9100 });
    expect(written[2]).toBeGreaterThan(0);
    expect(await rows()).toEqual([{ race_id: "202603020211", weight_type: "別定", fillies_only: 0, saved_at: 9100 }]);
    // 牝馬限定だけが変わっても更新する。
    await store.save({ ...record, weightType: "別定", filliesOnly: true, savedAt: 9200 });
    expect(await rows()).toEqual([{ race_id: "202603020211", weight_type: "別定", fillies_only: 1, saved_at: 9200 }]);
    // NULL との差も更新する(値 → NULL、NULL → 値。`!=` で比べると NULL が絡む遷移を取りこぼす)。
    await store.save({ ...record, weightType: null, filliesOnly: true, savedAt: 9300 });
    expect((await rows())[0]!.weight_type).toBeNull();
    await store.save({ ...record, weightType: "馬齢", filliesOnly: true, savedAt: 9400 });
    expect((await rows())[0]!.weight_type).toBe("馬齢");
  });

  it("同じ NULL の再保存も行を書かない(NULL 同士は「違う」とみなさない)", async () => {
    const { db, written } = recordingDb(local.db);
    const store = new D1RaceConditionsStore({ db });
    await store.save({ raceId: "202603020211", weightType: null, filliesOnly: true, savedAt: 1000 });
    expect(written[0]).toBeGreaterThan(0);
    await store.save({ raceId: "202603020211", weightType: null, filliesOnly: true, savedAt: 2000 });
    expect(written[1]).toBe(0);
  });

  it("D1 の失敗は投げる(握るのは呼び出し側)", async () => {
    const db = { prepare: () => { throw new Error("D1 の失敗(テスト)"); } } as unknown as Pick<D1Database, "prepare">;
    await expect(new D1RaceConditionsStore({ db }).save({ raceId: "202603020211", weightType: null, filliesOnly: false, savedAt: 1 })).rejects.toThrow("D1 の失敗");
  });
});

describe("toRaceConditionRecord(出馬表の race → 記録)", () => {
  it("牝馬限定を読めたレースは記録を作る(種別が無ければ null)", () => {
    expect(toRaceConditionRecord("202603020211", { weightType: "ハンデ", filliesOnly: false }, 5)).toEqual({ raceId: "202603020211", weightType: "ハンデ", filliesOnly: false, savedAt: 5 });
    expect(toRaceConditionRecord("202603020211", { filliesOnly: true }, 5)).toEqual({ raceId: "202603020211", weightType: null, filliesOnly: true, savedAt: 5 });
  });

  it("条件の欄を読めなかった(地方・RaceData02 無し。filliesOnly がキー無し)なら null(行を作らない)", () => {
    expect(toRaceConditionRecord("202654071210", {}, 5)).toBeNull();
    // 種別だけがあっても filliesOnly が無ければ作らない(NOT NULL を満たせない)。
    expect(toRaceConditionRecord("202603020211", { weightType: "定量" }, 5)).toBeNull();
  });
});
