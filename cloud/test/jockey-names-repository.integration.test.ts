import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { chunkPairs, collectJockeyPairs, D1JockeyNamesStore, JOCKEY_NAMES_CHUNK, recordSql, type JockeyNamePair } from "../src/jockey-names-repository";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #526 段階 1b: 出馬表の騎手名と騎手 ID の組 `jockey_names` の書き込み(先着。同じ組の再書き込みは行を書かない)。
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

const pair = (jockeyName: string, jockeyId: string): JockeyNamePair => ({ jockeyName, jockeyId });
const rowsOf = async (): Promise<unknown[]> => (await local.db.prepare("SELECT jockey_name, jockey_id, first_seen FROM jockey_names ORDER BY jockey_name, jockey_id").all()).results;
/** recordSql を直接流して、変更行数(rows_written の目安)を見る。 */
async function runRaw(pairs: readonly JockeyNamePair[], firstSeen: string): Promise<{ changes: number; rowsWritten: number }> {
  const meta = (await local.db.prepare(recordSql(pairs.length)).bind(...pairs.flatMap((p) => [p.jockeyName, p.jockeyId, firstSeen])).run()).meta;
  return { changes: meta.changes, rowsWritten: meta.rows_written };
}

describe("collectJockeyPairs(出馬表の馬から組を集める。純関数)", () => {
  it("名前も ID も空でない文字列の馬だけ採る。ID が null・名前が空・どちらも空は採らない", () => {
    const pairs = collectJockeyPairs([
      { jockeyName: "戸崎圭", jockeyId: "05386" },
      { jockeyName: "", jockeyId: "01001" }, // 騎手未定
      { jockeyName: "騎手ウ", jockeyId: null }, // リンクが無い
      { jockeyName: "", jockeyId: null },
      { jockeyName: "ルメール", jockeyId: "05339" },
    ]);
    expect(pairs).toEqual([pair("戸崎圭", "05386"), pair("ルメール", "05339")]);
  });

  it("同じレース内の同じ組は 1 つにまとめる(順序は最初に現れた順)。同じ名前の別の ID・同じ ID の別の名前は別の組", () => {
    const pairs = collectJockeyPairs([
      { jockeyName: "A", jockeyId: "1" },
      { jockeyName: "B", jockeyId: "2" },
      { jockeyName: "A", jockeyId: "1" },
      { jockeyName: "A", jockeyId: "3" },
      { jockeyName: "C", jockeyId: "2" },
    ]);
    expect(pairs).toEqual([pair("A", "1"), pair("B", "2"), pair("A", "3"), pair("C", "2")]);
  });

  it("空白や全角は直さない(厳密な文字列一致)。前後に空白のある名前はそのまま別の名前として扱う", () => {
    const pairs = collectJockeyPairs([
      { jockeyName: "Ｍデムーロ", jockeyId: "05212" },
      { jockeyName: "Mデムーロ", jockeyId: "05212" },
      { jockeyName: " 戸崎圭", jockeyId: "05386" },
      { jockeyName: "戸崎圭", jockeyId: "05386" },
    ]);
    expect(pairs).toEqual([pair("Ｍデムーロ", "05212"), pair("Mデムーロ", "05212"), pair(" 戸崎圭", "05386"), pair("戸崎圭", "05386")]);
  });
});

describe("chunkPairs(束縛数の上限に収める)", () => {
  it("1 文の束縛数は 3 × 組の数。D1 の上限 100 を超えない大きさで分ける。順序・件数は保つ", () => {
    expect(JOCKEY_NAMES_CHUNK * 3).toBeLessThanOrEqual(100);
    const pairs = Array.from({ length: JOCKEY_NAMES_CHUNK * 2 + 1 }, (_, i) => pair(`n${i}`, `${i}`));
    const chunks = chunkPairs(pairs);
    expect(chunks.map((c) => c.length)).toEqual([JOCKEY_NAMES_CHUNK, JOCKEY_NAMES_CHUNK, 1]);
    expect(chunks.flat()).toEqual(pairs);
    expect(chunkPairs([])).toEqual([]);
  });
});

describe("record", () => {
  it("新しい組は行になる。値が列に正しく入る(名前・ID・最初に見た開催日)", async () => {
    await new D1JockeyNamesStore({ db: local.db }).record([pair("戸崎圭", "05386"), pair("ルメール", "05339")], "20261031");
    expect(await rowsOf()).toEqual([
      { jockey_name: "ルメール", jockey_id: "05339", first_seen: "20261031" },
      { jockey_name: "戸崎圭", jockey_id: "05386", first_seen: "20261031" },
    ]);
  });

  it("1 レース(18 頭ぶん)を SQL 1 文で書く。組が無ければ SQL を発行しない", async () => {
    const spy = spyDb(local.db);
    const store = new D1JockeyNamesStore({ db: spy.db as never });
    await store.record(Array.from({ length: 18 }, (_, i) => pair(`騎手${i}`, `0${1000 + i}`)), "20261031");
    expect(spy.prepared).toEqual([recordSql(18)]);
    expect((await rowsOf()).length).toBe(18);
    await store.record([], "20261031");
    expect(spy.prepared).toHaveLength(1);
  });

  it("束縛数の上限を超える組数は、複数の文に分けて、全部書く", async () => {
    const spy = spyDb(local.db);
    const n = JOCKEY_NAMES_CHUNK + 5;
    await new D1JockeyNamesStore({ db: spy.db as never }).record(Array.from({ length: n }, (_, i) => pair(`騎手${i}`, `${i}`)), "20261031");
    expect(spy.prepared).toEqual([recordSql(JOCKEY_NAMES_CHUNK), recordSql(5)]);
    expect((await rowsOf()).length).toBe(n);
  });

  it("同じ組の再書き込みは行を書かない(changes = 0・rows_written = 0)。最初に見た開催日を上書きしない", async () => {
    const first = await runRaw([pair("戸崎圭", "05386")], "20261031");
    expect(first.changes).toBe(1);
    expect(first.rowsWritten).toBeGreaterThan(0); // 前提: 新しい組は行を書く
    const again = await runRaw([pair("戸崎圭", "05386")], "20261101");
    expect(again.changes).toBe(0);
    expect(again.rowsWritten).toBe(0);
    expect(await rowsOf()).toEqual([{ jockey_name: "戸崎圭", jockey_id: "05386", first_seen: "20261031" }]);
  });

  it("新しい組と既存の組が混ざっても、新しい組だけが入る(changes = 新しい組の数)", async () => {
    await runRaw([pair("A", "1")], "20261031");
    const mixed = await runRaw([pair("A", "1"), pair("B", "2"), pair("A", "3")], "20261101");
    expect(mixed.changes).toBe(2);
    expect(await rowsOf()).toEqual([
      { jockey_name: "A", jockey_id: "1", first_seen: "20261031" },
      { jockey_name: "A", jockey_id: "3", first_seen: "20261101" },
      { jockey_name: "B", jockey_id: "2", first_seen: "20261101" },
    ]);
  });

  it("同じ名前の別の ID・同じ ID の別の名前は、別の行として残る(曖昧さを書き出しが判定できるように)", async () => {
    await new D1JockeyNamesStore({ db: local.db }).record([pair("戸崎圭", "05386"), pair("戸崎圭太", "05386"), pair("戸崎圭", "99999")], "20261031");
    expect((await rowsOf()).length).toBe(3);
  });
});
