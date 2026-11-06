import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { JraEntryHorse } from "../src/jra-entries-parse";
import { ENTRY_CHUNK_HORSES, D1JraEntriesStore, type JraEntriesDb } from "../src/jra-entries-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #639: JRA の出馬表の保存(`D1JraEntriesStore`。migration 0038 の 4 表)。
 * ローカル(workerd)の D1 で、`wrangler d1 migrations apply --local` と同じ表に対して確かめる。本番の D1 には触れない。
 */

installFetchTrap();

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

const DATE = "20261108";
const RACE_A = "202605050211";
const RACE_B = "202605050210";

const horse = (id: string, over: Partial<JraEntryHorse> = {}): JraEntryHorse => ({
  horseId: id,
  name: `馬${id}`,
  umaban: 1,
  blinker: false,
  reductionKg: 0,
  foreignMark: false,
  sire: "父A",
  dam: "母A",
  damSire: "母父A",
  owner: "馬主A",
  breeder: "牧場A",
  ...over,
});

async function all(sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  return (await local.db.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
}

describe("claim(試みの先行記録)", () => {
  it("同じ試みの 2 回目は exists、別の試みは claimed。結果の列は NULL・complete は 0", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    expect(await store.claim(DATE, "05", 1, 1_000)).toBe("claimed");
    expect(await store.claim(DATE, "05", 1, 2_000)).toBe("exists");
    expect(await store.claim(DATE, "05", 2, 3_000)).toBe("claimed");
    expect(await store.claim(DATE, "06", 1, 3_000)).toBe("claimed");
    const rows = await all("SELECT kaisai_date, venue_code, attempt, attempted_at, finished_at, result, complete FROM jra_entry_fetches ORDER BY venue_code, attempt");
    expect(rows).toEqual([
      { kaisai_date: DATE, venue_code: "05", attempt: 1, attempted_at: 1_000, finished_at: null, result: null, complete: 0 },
      { kaisai_date: DATE, venue_code: "05", attempt: 2, attempted_at: 3_000, finished_at: null, result: null, complete: 0 },
      { kaisai_date: DATE, venue_code: "06", attempt: 1, attempted_at: 3_000, finished_at: null, result: null, complete: 0 },
    ]);
  });
  it("その場に complete = 1 の回があれば、別の試みでも done(行は作らない)。別の場・別の日は影響されない", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.claim(DATE, "05", 1, 1_000);
    await store.finish(DATE, "05", 1, { finishedAt: 2_000, result: "ok", racesTotal: 12, racesSaved: 12, horsesSkipped: 0, requests: 13, elapsedMs: 21_000, complete: true });
    expect(await store.claim(DATE, "05", 2, 3_000)).toBe("done");
    expect(await all("SELECT attempt FROM jra_entry_fetches WHERE venue_code = '05'")).toEqual([{ attempt: 1 }]);
    expect(await store.claim(DATE, "06", 1, 3_000)).toBe("claimed");
    expect(await store.claim("20261107", "05", 1, 3_000)).toBe("claimed");
  });
  it("finish は結果の列を書く(complete なしの回は 0 のまま)", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.claim(DATE, "05", 1, 1_000);
    await store.finish(DATE, "05", 1, { finishedAt: 2_000, result: "partial", racesTotal: 12, racesSaved: 9, horsesSkipped: 2, requests: 13, elapsedMs: 21_500, complete: false });
    expect(await all("SELECT finished_at, result, races_total, races_saved, horses_skipped, requests, elapsed_ms, complete FROM jra_entry_fetches")).toEqual([
      { finished_at: 2_000, result: "partial", races_total: 12, races_saved: 9, horses_skipped: 2, requests: 13, elapsed_ms: 21_500, complete: 0 },
    ]);
  });
});

describe("saveRaces(馬・馬主・出走時の情報の保存)", () => {
  it("3 表に書く: 馬(血統・生産者)・馬主・レースごとの出走時の情報(ブリンカー無しの行も入る)", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.saveRaces(DATE, [
      { raceId: RACE_A, horses: [horse("2022105710", { umaban: 1 }), horse("2018104638", { umaban: 18, blinker: true, reductionKg: 3, foreignMark: true, name: "ミステリーウェイ" })] },
      { raceId: RACE_B, horses: [horse("2020105786", { umaban: null, owner: "(株)サラブレッドクラブ・ラフィアン" })] },
    ]);
    expect(await all("SELECT * FROM horse_profiles WHERE horse_id = '2022105710'")).toEqual([
      { horse_id: "2022105710", name: "馬2022105710", sire: "父A", dam: "母A", dam_sire: "母父A", breeder: "牧場A", source: "jra", first_seen_on: DATE, updated_on: DATE },
    ]);
    expect((await all("SELECT horse_id FROM horse_profiles ORDER BY horse_id")).map((r) => r["horse_id"])).toEqual(["2018104638", "2020105786", "2022105710"]);
    expect(await all("SELECT horse_id, owner, source, first_seen_on, last_seen_on FROM horse_owner_history ORDER BY horse_id")).toEqual([
      { horse_id: "2018104638", owner: "馬主A", source: "jra", first_seen_on: DATE, last_seen_on: DATE },
      { horse_id: "2020105786", owner: "(株)サラブレッドクラブ・ラフィアン", source: "jra", first_seen_on: DATE, last_seen_on: DATE },
      { horse_id: "2022105710", owner: "馬主A", source: "jra", first_seen_on: DATE, last_seen_on: DATE },
    ]);
    expect(await all("SELECT race_id, horse_id, source, umaban, blinker, reduction_kg, foreign_mark, updated_on FROM race_horse_entries ORDER BY race_id, horse_id")).toEqual([
      { race_id: RACE_B, horse_id: "2020105786", source: "jra", umaban: null, blinker: 0, reduction_kg: 0, foreign_mark: 0, updated_on: DATE },
      { race_id: RACE_A, horse_id: "2018104638", source: "jra", umaban: 18, blinker: 1, reduction_kg: 3, foreign_mark: 1, updated_on: DATE },
      { race_id: RACE_A, horse_id: "2022105710", source: "jra", umaban: 1, blinker: 0, reduction_kg: 0, foreign_mark: 0, updated_on: DATE },
    ]);
  });

  it("同じ内容を取り直しても、1 行も書かない(書き込みの行数が増えない)", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    const races = [{ raceId: RACE_A, horses: [horse("2022105710"), horse("2018104638", { umaban: 2, blinker: true })] }];
    const first = await store.saveRaces(DATE, races);
    expect(first.rowsWritten).toBe(6); // 馬 2 + 馬主 2 + 出走時の情報 2
    const again = await store.saveRaces(DATE, races);
    expect(again.rowsWritten).toBe(0);
    const nextDay = await store.saveRaces("20261109", races); // 別の日に取り直しても、変わらない値なら書かない(日付だけを理由に書かない)…馬主の last_seen_on だけは進む
    expect(nextDay.rowsWritten).toBe(2);
    expect(await all("SELECT updated_on FROM horse_profiles")).toEqual([{ updated_on: DATE }, { updated_on: DATE }]);
    expect(await all("SELECT updated_on FROM race_horse_entries")).toEqual([{ updated_on: DATE }, { updated_on: DATE }]);
    expect(await all("SELECT first_seen_on, last_seen_on FROM horse_owner_history")).toEqual([
      { first_seen_on: DATE, last_seen_on: "20261109" },
      { first_seen_on: DATE, last_seen_on: "20261109" },
    ]);
  });

  it("値が変われば更新する: ブリンカー・馬番・減量は出走時の情報、血統・生産者は馬の行(updated_on が進み、first_seen_on は変わらない)", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.saveRaces(DATE, [{ raceId: RACE_A, horses: [horse("2022105710", { umaban: null, blinker: false })] }]);
    await store.saveRaces("20261109", [{ raceId: RACE_A, horses: [horse("2022105710", { umaban: 4, blinker: true, reductionKg: 2, sire: "父B", breeder: "牧場B" })] }]);
    expect(await all("SELECT umaban, blinker, reduction_kg, updated_on FROM race_horse_entries")).toEqual([{ umaban: 4, blinker: 1, reduction_kg: 2, updated_on: "20261109" }]);
    expect(await all("SELECT sire, dam, breeder, first_seen_on, updated_on FROM horse_profiles")).toEqual([{ sire: "父B", dam: "母A", breeder: "牧場B", first_seen_on: DATE, updated_on: "20261109" }]);
  });

  it("読めなかった項目(空)は NULL で入り、既に入っている値を消さない", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.saveRaces(DATE, [{ raceId: RACE_A, horses: [horse("2022105710", { sire: "", dam: "", damSire: "", breeder: "", owner: "" })] }]);
    expect(await all("SELECT sire, dam, dam_sire, breeder FROM horse_profiles")).toEqual([{ sire: null, dam: null, dam_sire: null, breeder: null }]);
    expect(await all("SELECT * FROM horse_owner_history")).toEqual([]); // 馬主が空なら履歴は作らない
    await store.saveRaces("20261109", [{ raceId: RACE_A, horses: [horse("2022105710")] }]);
    expect(await all("SELECT sire, breeder FROM horse_profiles")).toEqual([{ sire: "父A", breeder: "牧場A" }]);
    await store.saveRaces("20261110", [{ raceId: RACE_A, horses: [horse("2022105710", { sire: "", breeder: "" })] }]);
    expect(await all("SELECT sire, breeder, updated_on FROM horse_profiles")).toEqual([{ sire: "父A", breeder: "牧場A", updated_on: "20261109" }]);
    // 別の項目が変わって行を更新するときも、読めなかった項目(空)は既存の値のまま(COALESCE)
    await store.saveRaces("20261111", [{ raceId: RACE_A, horses: [horse("2022105710", { sire: "", dam: "", breeder: "牧場C" })] }]);
    expect(await all("SELECT sire, dam, dam_sire, breeder, updated_on FROM horse_profiles")).toEqual([{ sire: "父A", dam: "母A", dam_sire: "母父A", breeder: "牧場C", updated_on: "20261111" }]);
  });

  it("馬主が変われば別の行が増える(履歴)。前の馬主の行は残り、last_seen_on は進まない", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.saveRaces(DATE, [{ raceId: RACE_A, horses: [horse("2022105710", { owner: "旧馬主" })] }]);
    await store.saveRaces("20261201", [{ raceId: RACE_B, horses: [horse("2022105710", { owner: "新馬主" })] }]);
    expect(await all("SELECT owner, first_seen_on, last_seen_on FROM horse_owner_history ORDER BY owner")).toEqual([
      { owner: "新馬主", first_seen_on: "20261201", last_seen_on: "20261201" },
      { owner: "旧馬主", first_seen_on: DATE, last_seen_on: DATE },
    ]);
  });

  it("古い日付の取得(過去の分の後追い)は first_seen_on を前に倒し、last_seen_on は進めない。馬の行の first_seen_on も前に倒す", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.saveRaces("20261108", [{ raceId: RACE_A, horses: [horse("2022105710")] }]);
    await store.saveRaces("20250105", [{ raceId: "202506010111", horses: [horse("2022105710")] }]);
    expect(await all("SELECT first_seen_on, last_seen_on FROM horse_owner_history")).toEqual([{ first_seen_on: "20250105", last_seen_on: "20261108" }]);
    expect(await all("SELECT first_seen_on, updated_on FROM horse_profiles")).toEqual([{ first_seen_on: "20250105", updated_on: "20261108" }]);
  });

  it("古い日付の取得は、新しい日付の値を上書きしない(血統・名前・出どころ・updated_on は新しいまま)", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    await store.saveRaces("20261108", [{ raceId: RACE_A, horses: [horse("2022105710", { name: "新しい名", sire: "新父", breeder: "新牧場" })] }]);
    await store.saveRaces("20250105", [{ raceId: "202506010111", horses: [horse("2022105710", { name: "古い名", sire: "旧父", breeder: "旧牧場" })] }]);
    expect(await all("SELECT name, sire, breeder, source, first_seen_on, updated_on FROM horse_profiles")).toEqual([
      { name: "新しい名", sire: "新父", breeder: "新牧場", source: "jra", first_seen_on: "20250105", updated_on: "20261108" },
    ]);
  });

  it("別の出どころ(source)で書かれた行も、同じ表で扱える(#640 の取り込みが同じ表に入る)", async () => {
    await local.db.prepare("INSERT INTO horse_profiles (horse_id, name, sire, source, first_seen_on, updated_on) VALUES ('2022105710', '馬', '父Z', 'netkeiba', '20250101', '20250101')").run();
    const store = new D1JraEntriesStore({ db: local.db });
    await store.saveRaces(DATE, [{ raceId: RACE_A, horses: [horse("2022105710")] }]);
    expect(await all("SELECT sire, source, first_seen_on, updated_on FROM horse_profiles")).toEqual([{ sire: "父A", source: "jra", first_seen_on: "20250101", updated_on: DATE }]);
  });

  it("0 レースなら D1 に出ない", async () => {
    const store = new D1JraEntriesStore({ db: local.db });
    expect(await store.saveRaces(DATE, [])).toEqual({ rowsWritten: 0 });
  });
});

describe("saveRaces の文の数と大きさ(D1 の 1 回の呼び出しの文は 50 まで、束縛値は 100KB 未満)", () => {
  /** batch の文の数と、束縛した値の最大の長さを記録する窓口。 */
  function recordingDb(real: D1Database): { db: JraEntriesDb; batches: number[]; maxParam: { n: number }; prepares: number[] } {
    const batches: number[] = [];
    const prepares: number[] = [];
    const maxParam = { n: 0 };
    const db: JraEntriesDb = {
      prepare(sql: string) {
        prepares.push(1);
        const stmt = real.prepare(sql);
        return {
          bind(...values: unknown[]) {
            for (const v of values) {
              if (typeof v === "string") maxParam.n = Math.max(maxParam.n, new TextEncoder().encode(v).byteLength);
            }
            return stmt.bind(...values);
          },
        } as unknown as D1PreparedStatement;
      },
      async batch(statements) {
        batches.push(statements.length);
        return real.batch(statements);
      },
    };
    return { db, batches, maxParam, prepares };
  }

  it("12 レース × 18 頭(216 頭)でも batch は 1 回・文は 3 × チャンク数で、50 を超えない。束縛値は 60KB 未満", async () => {
    const rec = recordingDb(local.db);
    const store = new D1JraEntriesStore({ db: rec.db });
    // 日本語の長い名前(64 字)で最大に近い大きさにする。
    const long = (c: string): string => c.repeat(64);
    const races = Array.from({ length: 12 }, (_, r) => ({
      raceId: `2026050502${String(r + 1).padStart(2, "0")}`,
      horses: Array.from({ length: 18 }, (_, i) =>
        horse(String(2020100000 + r * 18 + i), { name: long("名"), sire: long("父"), dam: long("母"), damSire: long("祖"), owner: long("主"), breeder: long("産"), umaban: i + 1 }),
      ),
    }));
    const result = await store.saveRaces(DATE, races);
    const chunks = Math.ceil(216 / ENTRY_CHUNK_HORSES);
    expect(rec.batches).toEqual([3 * chunks]);
    expect(3 * chunks).toBe(18);
    expect(3 * chunks).toBeLessThan(50);
    expect(rec.maxParam.n).toBeLessThan(60_000);
    expect(rec.maxParam.n).toBeGreaterThan(10_000); // 空振りでない(最大に近い大きさを実際に束縛した)
    expect(result.rowsWritten).toBe(216 * 3);
    expect((await all("SELECT COUNT(*) AS n FROM race_horse_entries"))[0]).toEqual({ n: 216 });
  });
});
