import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { D1PastBlinkerStore, FILTER_DONE_SQL, INSERT_BLINKER_HORSES_SQL, INSERT_RACES_SQL, PAST_BLINKER_SOURCE } from "../src/past-blinker-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #698: 過去のレースのブリンカー着用の保存(`D1PastBlinkerStore`。migration 0044 の `past_blinker_races`・`past_blinker_horses`)。
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

describe("saveRaces(2 つの表を 1 batch で書く)", () => {
  it("レースの行(頭数・印の数・取得日)と、着けていた馬の行だけを書く。着けていない馬の行は書かない。返す行数は 2 つの表の書き込みの合計(meta.changes)", async () => {
    const store = new D1PastBlinkerStore({ db: local.db });
    const written = await store.saveRaces(
      [
        { raceId: "202106010101", headCount: 16, blinkerHorseIds: ["2018103271", "2018102803"] },
        { raceId: "202106010102", headCount: 12, blinkerHorseIds: [] },
      ],
      "20261110",
    );
    expect(written).toBe(2 + 2); // レース 2 行 + 馬 2 行
    expect(await all("SELECT race_id, fetched_on, head_count, blinker_count FROM past_blinker_races ORDER BY race_id")).toEqual([
      { race_id: "202106010101", fetched_on: "20261110", head_count: 16, blinker_count: 2 },
      { race_id: "202106010102", fetched_on: "20261110", head_count: 12, blinker_count: 0 },
    ]);
    expect(await all("SELECT race_id, horse_id, source, fetched_on FROM past_blinker_horses ORDER BY horse_id")).toEqual([
      { race_id: "202106010101", horse_id: "2018102803", source: PAST_BLINKER_SOURCE, fetched_on: "20261110" },
      { race_id: "202106010101", horse_id: "2018103271", source: PAST_BLINKER_SOURCE, fetched_on: "20261110" },
    ]);
    expect(PAST_BLINKER_SOURCE).toBe("jra_result");
    // 取り終えたレースにいて、馬の表に行が無い = 着けていなかった(blinker_count = 馬の表の行数)
    const counts = await all("SELECT r.race_id, r.blinker_count AS n, (SELECT COUNT(*) FROM past_blinker_horses h WHERE h.race_id = r.race_id) AS m FROM past_blinker_races r");
    expect(counts.every((c) => c["n"] === c["m"])).toBe(true);
  });

  it("同じレースをもう一度書いても、行は増えず、既存の行を書き換えない(書いた行数 0)", async () => {
    const store = new D1PastBlinkerStore({ db: local.db });
    await store.saveRaces([{ raceId: "202106010101", headCount: 16, blinkerHorseIds: ["2018103271"] }], "20261110");
    const again = await store.saveRaces([{ raceId: "202106010101", headCount: 99, blinkerHorseIds: ["2018103271"] }], "20261111");
    expect(again).toBe(0);
    expect(await all("SELECT head_count, fetched_on FROM past_blinker_races")).toEqual([{ head_count: 16, fetched_on: "20261110" }]);
    expect(await all("SELECT fetched_on FROM past_blinker_horses")).toEqual([{ fetched_on: "20261110" }]);
  });

  it("空の配列は何も書かず 0。馬のいないレースだけの組でも、レースの行は書く", async () => {
    const store = new D1PastBlinkerStore({ db: local.db });
    expect(await store.saveRaces([], "20261110")).toBe(0);
    expect(await store.saveRaces([{ raceId: "202106010103", headCount: 10, blinkerHorseIds: [] }], "20261110")).toBe(1);
    expect(await all("SELECT COUNT(*) AS n FROM past_blinker_horses")).toEqual([{ n: 0 }]);
  });

  it("batch は 1 つのトランザクション: 馬の表の書き込みが失敗したら、レースの行も残らない(「行が無い = 着けていない」を崩さない)", async () => {
    const store = new D1PastBlinkerStore({ db: local.db });
    // source が NOT NULL の列に NULL が入るように、馬の ID を null にした不正な入力で馬の表の INSERT を失敗させる
    await expect(store.saveRaces([{ raceId: "202106010101", headCount: 2, blinkerHorseIds: [null as unknown as string] }], "20261110")).rejects.toThrow();
    expect(await all("SELECT COUNT(*) AS n FROM past_blinker_races")).toEqual([{ n: 0 }]);
    expect(await all("SELECT COUNT(*) AS n FROM past_blinker_horses")).toEqual([{ n: 0 }]);
  });
});

describe("filterDone(取り終えたレースの確認。json_each に束縛した配列から、主キーを引く)", () => {
  it("取り終えたレースの ID だけを、渡した順で返す。空の配列は空(D1 を呼ばない)", async () => {
    const store = new D1PastBlinkerStore({ db: local.db });
    await store.saveRaces([{ raceId: "202106010102", headCount: 1, blinkerHorseIds: [] }, { raceId: "202106010104", headCount: 1, blinkerHorseIds: ["2018103271"] }], "20261110");
    expect(await store.filterDone(["202106010101", "202106010102", "202106010103", "202106010104"])).toEqual(["202106010102", "202106010104"]);
    expect(await store.filterDone([])).toEqual([]);
  });

  it("馬の表にだけ行がある(レース表に無い)レースは、取り終えたことにならない", async () => {
    await local.db.prepare("INSERT INTO past_blinker_horses (race_id, horse_id, source, fetched_on) VALUES ('202106010105', '2018103271', 'jra_result', '20261110')").run();
    expect(await new D1PastBlinkerStore({ db: local.db }).filterDone(["202106010105"])).toEqual([]);
  });
});

describe("実行計画(全走査をしない)", () => {
  async function plan(sql: string, ...binds: unknown[]): Promise<string[]> {
    return (await all(`EXPLAIN QUERY PLAN ${sql}`, ...binds)).map((r) => String(r["detail"]));
  }
  it("filterDone は past_blinker_races の主キーの引き(SEARCH)で、その表の SCAN が無い", async () => {
    const details = await plan(FILTER_DONE_SQL, '["202106010101"]');
    expect(details.some((d) => /SEARCH r\b.*USING PRIMARY KEY \(race_id=\?\)/.test(d)), details.join(" / ")).toBe(true);
    expect(details.filter((d) => /SCAN (r|past_blinker_races)\b/.test(d)), details.join(" / ")).toEqual([]);
  });
  it("2 つの INSERT は json_each の読みだけで、既存の表の全走査が無い", async () => {
    for (const sql of [INSERT_BLINKER_HORSES_SQL, INSERT_RACES_SQL]) {
      const details = await plan(sql, "[]", "20261110");
      expect(details.filter((d) => /SCAN (past_blinker_races|past_blinker_horses)\b/.test(d)), details.join(" / ")).toEqual([]);
    }
  });
});
