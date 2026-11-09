import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { D1JraHorseStore, JRA_HORSE_SOURCE } from "../src/jra-horse-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #697: 馬の頁から取った属性の保存(`D1JraHorseStore`。migration 0038 の `horse_profiles`)と、対象の馬の読み出し(`horse_runs` の主キーの範囲読み)。
 * ローカル(workerd)の D1 で確かめる。本番の D1 には触れない。
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

async function all(sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  return (await local.db.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
}

async function addRuns(horseId: string, raceKeys: string[]): Promise<void> {
  for (const k of raceKeys) {
    await local.db.prepare("INSERT INTO horse_runs (horse_id, race_key, parser_version, first_seen_at, data) VALUES (?, ?, 1, 0, '[]')").bind(horseId, k).run();
  }
}

describe("listHorseIdsAfter(horse_runs の馬の ID を、主キーの順に範囲で読む)", () => {
  it("カーソルより大きい ID を、重複なく昇順で、件数の上限まで返す(1 頭に複数走あっても 1 回)", async () => {
    await addRuns("2018100001", ["a", "b", "c"]);
    await addRuns("2018100002", ["a"]);
    await addRuns("2018100003", ["a", "b"]);
    await addRuns("2018100004", ["a"]);
    const store = new D1JraHorseStore({ db: local.db });
    expect(await store.listHorseIdsAfter("", 3)).toEqual(["2018100001", "2018100002", "2018100003"]);
    expect(await store.listHorseIdsAfter("2018100001", 2)).toEqual(["2018100002", "2018100003"]);
    expect(await store.listHorseIdsAfter("2018100003", 10)).toEqual(["2018100004"]);
    expect(await store.listHorseIdsAfter("2018100004", 10)).toEqual([]);
  });
});

describe("filterMissing(horse_profiles にいない馬だけ)", () => {
  it("出馬表から入った馬(source=jra)も、すでにいる馬として除く。順序は引数の順", async () => {
    await local.db.prepare("INSERT INTO horse_profiles (horse_id, name, sire, dam, dam_sire, breeder, source, first_seen_on, updated_on) VALUES ('2018100002', 'あ', NULL, NULL, NULL, NULL, 'jra', '20261101', '20261101')").run();
    const store = new D1JraHorseStore({ db: local.db });
    expect(await store.filterMissing(["2018100001", "2018100002", "2018100003"])).toEqual(["2018100001", "2018100003"]);
    expect(await store.filterMissing([])).toEqual([]);
  });
});

describe("insertProfiles(source=jra_horse で書く。既存の行は上書きしない)", () => {
  const p = (id: string, name: string) => ({ horseId: id, name, sire: "父", dam: "母", damSire: "母父", breeder: "牧場" });

  it("新しい馬は jra_horse で入り、first_seen_on と updated_on は取得した日。書いた行数を返す。馬主の表は触らない", async () => {
    const store = new D1JraHorseStore({ db: local.db });
    const changes = await store.insertProfiles([p("2018100001", "馬A"), p("2018100002", "馬B")], "20261109");
    expect(changes).toBe(2);
    expect(JRA_HORSE_SOURCE).toBe("jra_horse");
    expect(await all("SELECT horse_id, name, sire, dam, dam_sire, breeder, source, first_seen_on, updated_on FROM horse_profiles ORDER BY horse_id")).toEqual([
      { horse_id: "2018100001", name: "馬A", sire: "父", dam: "母", dam_sire: "母父", breeder: "牧場", source: "jra_horse", first_seen_on: "20261109", updated_on: "20261109" },
      { horse_id: "2018100002", name: "馬B", sire: "父", dam: "母", dam_sire: "母父", breeder: "牧場", source: "jra_horse", first_seen_on: "20261109", updated_on: "20261109" },
    ]);
    expect(await all("SELECT COUNT(*) AS n FROM horse_owner_history")).toEqual([{ n: 0 }]);
    expect(await all("SELECT COUNT(*) AS n FROM race_horse_entries")).toEqual([{ n: 0 }]);
  });

  it("出馬表から入った行(source=jra)は、どの列も上書きしない。書いた行数は 0(1 日の枠に数えない)", async () => {
    await local.db.prepare("INSERT INTO horse_profiles (horse_id, name, sire, dam, dam_sire, breeder, source, first_seen_on, updated_on) VALUES ('2018100001', '元の名', '元父', NULL, NULL, '元牧場', 'jra', '20261101', '20261102')").run();
    const store = new D1JraHorseStore({ db: local.db });
    const changes = await store.insertProfiles([p("2018100001", "別の名前"), p("2018100002", "馬B")], "20261109");
    expect(changes, "既存の 1 頭は書かず、新しい 1 頭だけ書く").toBe(1);
    expect(await all("SELECT horse_id, name, sire, dam, breeder, source, first_seen_on, updated_on FROM horse_profiles WHERE horse_id = '2018100001'")).toEqual([
      { horse_id: "2018100001", name: "元の名", sire: "元父", dam: null, breeder: "元牧場", source: "jra", first_seen_on: "20261101", updated_on: "20261102" },
    ]);
  });

  it("空の配列は何もしない(0 を返す)。null の列は NULL のまま入る", async () => {
    const store = new D1JraHorseStore({ db: local.db });
    expect(await store.insertProfiles([], "20261109")).toBe(0);
    expect(await store.insertProfiles([{ horseId: "2018100009", name: "馬", sire: null, dam: null, damSire: null, breeder: null }], "20261109")).toBe(1);
    expect(await all("SELECT sire, dam, dam_sire, breeder FROM horse_profiles")).toEqual([{ sire: null, dam: null, dam_sire: null, breeder: null }]);
  });
});
