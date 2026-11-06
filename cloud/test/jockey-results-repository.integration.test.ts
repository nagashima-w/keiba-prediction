import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pathFromMeta } from "./meta-path.js";
import { D1JockeyResultsStore, JOCKEY_SAVE_CHUNK } from "../src/jockey-results-repository";
import { parseJockeyResults } from "../../packages/core/src/scraper/parse-jockey-results";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #226(週 1 回の更新): 騎手の年ごとの成績を D1 に置く(`D1JockeyResultsStore`。migration 0012 の表 `jockey_results`)。
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

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const years = (base: number) => [
  { year: 2026, starts: 600 + base, placed: 200 + base },
  { year: 2025, starts: 700 + base, placed: 210 + base },
];

describe("D1JockeyResultsStore", () => {
  it("保存して読める: 騎手 ID・開催区分で引き、年ごとの成績と取得日時が往復で同じ", async () => {
    const store = new D1JockeyResultsStore({ db: local.db });
    await store.saveMany("central", [
      { jockeyId: "01170", years: years(0), fetchedAtMs: NOW },
      { jockeyId: "01043", years: years(5), fetchedAtMs: NOW - 1000 },
    ]);
    const got = await store.loadMany(["01170", "01043", "09999"], "central");
    expect([...got.keys()].sort()).toEqual(["01043", "01170"]); // 保存の無い騎手(09999)は入らない
    expect(got.get("01170")).toStrictEqual({ fetchedAtMs: NOW, years: years(0) });
    expect(got.get("01043")).toStrictEqual({ fetchedAtMs: NOW - 1000, years: years(5) });
  });

  it("中央と地方は別の行: 同じ騎手 ID でも kind ごとに保存され、読み分けられる", async () => {
    const store = new D1JockeyResultsStore({ db: local.db });
    await store.saveMany("central", [{ jockeyId: "01170", years: years(0), fetchedAtMs: NOW }]);
    await store.saveMany("nar", [{ jockeyId: "01170", years: years(9), fetchedAtMs: NOW + 1 }]);
    expect((await store.loadMany(["01170"], "central")).get("01170")!.years).toStrictEqual(years(0));
    expect((await store.loadMany(["01170"], "nar")).get("01170")!.years).toStrictEqual(years(9));
    const count = await local.db.prepare("SELECT COUNT(*) AS n FROM jockey_results").first<{ n: number }>();
    expect(count!.n).toBe(2);
  });

  it("上書き: 同じ騎手・区分を保存し直すと、年ごとの成績も取得日時も新しい値になる(行は増えない)", async () => {
    const store = new D1JockeyResultsStore({ db: local.db });
    await store.saveMany("central", [{ jockeyId: "01170", years: years(0), fetchedAtMs: NOW }]);
    await store.saveMany("central", [{ jockeyId: "01170", years: years(7), fetchedAtMs: NOW + 7 * 86_400_000 }]);
    const got = (await store.loadMany(["01170"], "central")).get("01170")!;
    expect(got.years).toStrictEqual(years(7));
    expect(got.fetchedAtMs).toBe(NOW + 7 * 86_400_000);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM jockey_results").first<{ n: number }>())!.n).toBe(1);
  });

  it("成績の行が無い騎手(中央の成績が無い)も、空配列として保存される(取得したが行が無い=未取得とは別。毎回取り直さない)", async () => {
    const store = new D1JockeyResultsStore({ db: local.db });
    await store.saveMany("central", [{ jockeyId: "a01ad", years: [], fetchedAtMs: NOW }]);
    const got = await store.loadMany(["a01ad"], "central");
    expect(got.get("a01ad")).toStrictEqual({ fetchedAtMs: NOW, years: [] });
  });

  it("1 回の読みは 1 クエリ・1 回の保存は(20 人まで)1 クエリ: D1 の「1 回の呼び出しあたりのクエリ数」を食わない", async () => {
    const spy = spyDb(local.db);
    const store = new D1JockeyResultsStore({ db: spy.db });
    expect(JOCKEY_SAVE_CHUNK).toBe(20);
    const ids = Array.from({ length: 18 }, (_, i) => String(1000 + i).padStart(5, "0"));
    await store.saveMany("central", ids.map((jockeyId, i) => ({ jockeyId, years: years(i), fetchedAtMs: NOW })));
    expect(spy.prepared).toHaveLength(1);
    await store.loadMany(ids, "central");
    expect(spy.prepared).toHaveLength(2);
    expect(spy.batches).toEqual([]); // batch は使わない
  });

  it("21 人以上は 20 人ずつに分けて保存する(バインド変数の上限 100 を超えない)。全員が読める", async () => {
    const spy = spyDb(local.db);
    const store = new D1JockeyResultsStore({ db: spy.db });
    const ids = Array.from({ length: 45 }, (_, i) => String(2000 + i).padStart(5, "0"));
    await store.saveMany("nar", ids.map((jockeyId, i) => ({ jockeyId, years: years(i), fetchedAtMs: NOW })));
    expect(spy.prepared).toHaveLength(3); // 20 + 20 + 5
    const got = await store.loadMany(ids.slice(0, 18), "nar");
    expect(got.size).toBe(18);
    const all = await local.db.prepare("SELECT COUNT(*) AS n FROM jockey_results WHERE kind = 'nar'").first<{ n: number }>();
    expect(all!.n).toBe(45);
  });

  it("空の入力はクエリを発行しない(読みも書きも)", async () => {
    const spy = spyDb(local.db);
    const store = new D1JockeyResultsStore({ db: spy.db });
    expect((await store.loadMany([], "central")).size).toBe(0);
    await store.saveMany("central", []);
    expect(spy.prepared).toEqual([]);
  });

  it("壊れた行(years_json が JSON でない・形が違う)は無いものとして扱い、ほかの行は読める(分析を止めない)", async () => {
    const insert = (id: string, json: string) =>
      local.db.prepare("INSERT INTO jockey_results (jockey_id, kind, years_json, fetched_at) VALUES (?, 'central', ?, ?)").bind(id, json, NOW).run();
    await insert("00001", "これはJSONではない");
    await insert("00002", JSON.stringify({ year: 2026 }));
    await insert("00003", JSON.stringify([[2026, 600]])); // 要素の長さが足りない
    await insert("00004", JSON.stringify([[2026, 600, 700]])); // 3着内が騎乗数より多い
    await insert("00005", JSON.stringify([[2026.5, 600, 200]])); // 年が整数でない
    await insert("00006", JSON.stringify([[2026, 600, 200], [2025, 700, 210]]));
    const store = new D1JockeyResultsStore({ db: local.db });
    const got = await store.loadMany(["00001", "00002", "00003", "00004", "00005", "00006"], "central");
    expect([...got.keys()]).toEqual(["00006"]);
    expect(got.get("00006")!.years).toStrictEqual([
      { year: 2026, starts: 600, placed: 200 },
      { year: 2025, starts: 700, placed: 210 },
    ]);
  });

  it("D1 が失敗すれば投げる(呼び出し側 = scrapeRace が取得へフォールバックする)", async () => {
    const broken = { prepare: () => { throw new Error("D1_ERROR: injected"); } } as unknown as ConstructorParameters<typeof D1JockeyResultsStore>[0]["db"];
    const store = new D1JockeyResultsStore({ db: broken });
    await expect(store.loadMany(["01170"], "central")).rejects.toThrow("injected");
    await expect(store.saveMany("central", [{ jockeyId: "01170", years: years(0), fetchedAtMs: NOW }])).rejects.toThrow("injected");
  });

  it("容量の見積りの根拠: 実フィクスチャ(横山武史 10 年分)の years_json は 1 行あたり数百バイト(コミット済みのフィクスチャから再現できる)", async () => {
    const page = readFileSync(pathFromMeta("../../fixtures/jockey_results_01170.html", import.meta.url), "utf-8");
    const parsed = parseJockeyResults(page);
    expect(parsed).toHaveLength(10);
    const store = new D1JockeyResultsStore({ db: local.db });
    await store.saveMany("central", [{ jockeyId: "01170", years: parsed, fetchedAtMs: NOW }]);
    const row = await local.db.prepare("SELECT length(years_json) AS n FROM jockey_results WHERE jockey_id = '01170'").first<{ n: number }>();
    // 年ごとに [年, 騎乗数, 3着内] の短い配列。10 年で 150 バイト(= 1 年あたり 15 バイト)。
    expect(row!.n).toBe(150);
  });
});
