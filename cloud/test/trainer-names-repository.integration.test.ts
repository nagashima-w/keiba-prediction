import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { chunkPairs, collectTrainerPairs, D1TrainerNamesStore, TRAINER_NAMES_CHUNK, recordSql, type TrainerNamePair } from "../src/trainer-names-repository";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #540: 出馬表の調教師名と調教師 ID の組 `trainer_names` の書き込み(先着。同じ組の再書き込みは行を書かない)。
 * ローカル(workerd)の D1 に、`wrangler d1 migrations apply --local` で適用した表に対して確かめる。本番の D1 には触れない。
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

const pair = (trainerName: string, trainerId: string): TrainerNamePair => ({ trainerName, trainerId });
const rowsOf = async (): Promise<unknown[]> => (await local.db.prepare("SELECT trainer_name, trainer_id, first_seen FROM trainer_names ORDER BY trainer_name, trainer_id").all()).results;
/** recordSql を直接流して、変更行数(rows_written の目安)を見る。 */
async function runRaw(pairs: readonly TrainerNamePair[], firstSeen: string): Promise<{ changes: number; rowsWritten: number }> {
  const meta = (await local.db.prepare(recordSql(pairs.length)).bind(...pairs.flatMap((p) => [p.trainerName, p.trainerId, firstSeen])).run()).meta;
  return { changes: meta.changes, rowsWritten: meta.rows_written };
}

describe("collectTrainerPairs(出馬表の馬から組を集める。純関数)", () => {
  it("名前も ID も空でない文字列の馬だけ採る。ID が null・名前が空・どちらも空は採らない", () => {
    const pairs = collectTrainerPairs([
      { trainerName: "藤野", trainerId: "01200" },
      { trainerName: "", trainerId: "01001" }, // 調教師未定
      { trainerName: "調教師ウ", trainerId: null }, // リンクが無い
      { trainerName: "", trainerId: null },
      { trainerName: "和田雄", trainerId: "01143" },
    ]);
    expect(pairs).toEqual([pair("藤野", "01200"), pair("和田雄", "01143")]);
  });

  it("同じレース内の同じ組は 1 つにまとめる(順序は最初に現れた順)。同じ名前の別の ID・同じ ID の別の名前は別の組", () => {
    const pairs = collectTrainerPairs([
      { trainerName: "A", trainerId: "1" },
      { trainerName: "B", trainerId: "2" },
      { trainerName: "A", trainerId: "1" },
      { trainerName: "A", trainerId: "3" },
      { trainerName: "C", trainerId: "2" },
    ]);
    expect(pairs).toEqual([pair("A", "1"), pair("B", "2"), pair("A", "3"), pair("C", "2")]);
  });

  it("空白や全角は直さない(厳密な文字列一致)。前後に空白のある名前はそのまま別の名前として扱う", () => {
    const pairs = collectTrainerPairs([
      { trainerName: "Ｍ藤野", trainerId: "01143" },
      { trainerName: "M藤野", trainerId: "01143" },
      { trainerName: " 藤野", trainerId: "01200" },
      { trainerName: "藤野", trainerId: "01200" },
    ]);
    expect(pairs).toEqual([pair("Ｍ藤野", "01143"), pair("M藤野", "01143"), pair(" 藤野", "01200"), pair("藤野", "01200")]);
  });
});

describe("chunkPairs(束縛数の上限に収める)", () => {
  it("1 文の束縛数は 3 × 組の数。D1 の上限 100 を超えない大きさで分ける。順序・件数は保つ", () => {
    expect(TRAINER_NAMES_CHUNK * 3).toBeLessThanOrEqual(100);
    const pairs = Array.from({ length: TRAINER_NAMES_CHUNK * 2 + 1 }, (_, i) => pair(`n${i}`, `${i}`));
    const chunks = chunkPairs(pairs);
    expect(chunks.map((c) => c.length)).toEqual([TRAINER_NAMES_CHUNK, TRAINER_NAMES_CHUNK, 1]);
    expect(chunks.flat()).toEqual(pairs);
    expect(chunkPairs([])).toEqual([]);
  });
});

describe("record", () => {
  it("新しい組は行になる。値が列に正しく入る(名前・ID・最初に見た開催日)", async () => {
    await new D1TrainerNamesStore({ db: local.db }).record([pair("藤野", "01200"), pair("和田雄", "01143")], "20261031");
    expect(await rowsOf()).toEqual([
      { trainer_name: "和田雄", trainer_id: "01143", first_seen: "20261031" },
      { trainer_name: "藤野", trainer_id: "01200", first_seen: "20261031" },
    ]);
  });

  it("1 レース(18 頭ぶん)を SQL 1 文で書く。組が無ければ SQL を発行しない", async () => {
    const spy = spyDb(local.db);
    const store = new D1TrainerNamesStore({ db: spy.db as never });
    await store.record(Array.from({ length: 18 }, (_, i) => pair(`調教師${i}`, `0${1000 + i}`)), "20261031");
    expect(spy.prepared).toEqual([recordSql(18)]);
    expect((await rowsOf()).length).toBe(18);
    await store.record([], "20261031");
    expect(spy.prepared).toHaveLength(1);
  });

  it("束縛数の上限を超える組数は、複数の文に分けて、全部書く", async () => {
    const spy = spyDb(local.db);
    const n = TRAINER_NAMES_CHUNK + 5;
    await new D1TrainerNamesStore({ db: spy.db as never }).record(Array.from({ length: n }, (_, i) => pair(`調教師${i}`, `${i}`)), "20261031");
    expect(spy.prepared).toEqual([recordSql(TRAINER_NAMES_CHUNK), recordSql(5)]);
    expect((await rowsOf()).length).toBe(n);
  });

  it("同じ組の再書き込みは行を書かない(changes = 0・rows_written = 0)。最初に見た開催日を上書きしない", async () => {
    const first = await runRaw([pair("藤野", "01200")], "20261031");
    expect(first.changes).toBe(1);
    expect(first.rowsWritten).toBeGreaterThan(0); // 前提: 新しい組は行を書く
    const again = await runRaw([pair("藤野", "01200")], "20261101");
    expect(again.changes).toBe(0);
    expect(again.rowsWritten).toBe(0);
    expect(await rowsOf()).toEqual([{ trainer_name: "藤野", trainer_id: "01200", first_seen: "20261031" }]);
  });

  it("新しい組と既存の組が混ざっても、新しい組だけが入る(changes = 新しい組の数)", async () => {
    await runRaw([pair("A", "1")], "20261031");
    const mixed = await runRaw([pair("A", "1"), pair("B", "2"), pair("A", "3")], "20261101");
    expect(mixed.changes).toBe(2);
    expect(await rowsOf()).toEqual([
      { trainer_name: "A", trainer_id: "1", first_seen: "20261031" },
      { trainer_name: "A", trainer_id: "3", first_seen: "20261101" },
      { trainer_name: "B", trainer_id: "2", first_seen: "20261101" },
    ]);
  });

  it("同じ名前の別の ID・同じ ID の別の名前は、別の行として残る(曖昧さを書き出しが判定できるように)", async () => {
    await new D1TrainerNamesStore({ db: local.db }).record([pair("藤野", "01200"), pair("西山裕貴", "01200"), pair("藤野", "99999")], "20261031");
    expect((await rowsOf()).length).toBe(3);
  });
});
