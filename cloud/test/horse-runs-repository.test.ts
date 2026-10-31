import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HORSE_RUN_PARSER_VERSION, encodeHorseRun } from "../../packages/core/src/scraper/horse-run-record";
import type { HorseRaceResult } from "../../packages/core/src/scraper/types";
import { D1HorseRunsStore, HORSE_READ_CHUNK, RUNS_WRITE_CHUNK, rewriteResultRuns, writeResultRuns, type ResultRunRow } from "../src/horse-runs-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #256 段階A: 各馬の戦績を D1 に貯める(`D1HorseRunsStore`。migration 0014 の `horse_runs`・`horse_run_saves`)。
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

const NOW = Date.parse("2026-06-27T12:00:00Z");
const DAY_MS = 86_400_000;

const BASE: HorseRaceResult = {
  date: "2026/05/01",
  venue: { round: 2, name: "福島", day: 2, raw: "2福島2" },
  weather: "晴",
  raceNumber: 11,
  raceName: "テスト",
  raceId: null,
  raceIdRaw: "202603020001",
  venueKind: "中央",
  entryCount: 16,
  wakuban: 3,
  umaban: 5,
  odds: 12.3,
  ninki: 6,
  finishPosition: { kind: "順位", value: 5 },
  jockeyName: "騎手",
  jockeyId: "01170",
  kinryo: 56,
  courseType: "芝",
  distance: 1800,
  trackCondition: "良",
  time: "1:45.9",
  margin: 0.4,
  passing: [5, 4, 8, 6],
  pace: "29.9-37.6",
  last3f: 35.0,
  bodyWeight: { weight: 496, diff: -2 },
  winnerName: "ウィナー",
};

const raceKey = (n: number): string => `2026030${String(n).padStart(5, "0")}`;
/** n 番目のレースの1走(鍵は 12 桁の数字)。 */
function run(n: number, patch: Partial<HorseRaceResult> = {}): HorseRaceResult {
  return { ...BASE, raceIdRaw: raceKey(n), ...patch };
}
const horseId = (i: number): string => `20201${String(i).padStart(5, "0")}`;
/** i 番目の馬の戦績(n 走。レース 1..n)。 */
function horse(i: number, n: number): { horseId: string; results: HorseRaceResult[] } {
  return { horseId: horseId(i), results: Array.from({ length: n }, (_, k) => run(k + 1)) };
}
const input = (horses: Array<{ horseId: string; results: HorseRaceResult[] }>, savedAt = NOW) => ({ raceId: "202606280511", kaisaiDate: "20260628", savedAt, horses });

async function count(table: string): Promise<number> {
  return (await local.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

/** 発行された SQL を記録する窓口(prepare だけを持つ。batch を呼べば TypeError)。 */
function recording(real: D1Database, fail: (sql: string) => boolean = () => false): { db: Pick<D1Database, "prepare">; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      if (fail(sql)) {
        throw new Error("D1 の失敗(テスト)");
      }
      return real.prepare(sql);
    },
  };
  return { db, sqls };
}

describe("D1HorseRunsStore.saveRace: 保存", () => {
  it("新規の行が horse_runs に入る(鍵・版数・初見時刻・タプル JSON が期待どおり)。集計の行が horse_run_saves に1行入る", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    const stats = await store.saveRace(input([{ horseId: horseId(1), results: [run(1), run(2)] }]));
    expect(stats).toMatchObject({ horses: 1, horsesFirstSeen: 1, rowsNew: 2, rowsWrittenRuns: 2 });
    const rows = (await local.db.prepare("SELECT horse_id, race_key, parser_version, first_seen_at, data FROM horse_runs ORDER BY race_key").all()).results;
    expect(rows).toStrictEqual([
      { horse_id: horseId(1), race_key: raceKey(1), parser_version: HORSE_RUN_PARSER_VERSION, first_seen_at: NOW, data: JSON.stringify(encodeHorseRun(run(1))) },
      { horse_id: horseId(1), race_key: raceKey(2), parser_version: HORSE_RUN_PARSER_VERSION, first_seen_at: NOW, data: JSON.stringify(encodeHorseRun(run(2))) },
    ]);
    const saves = (await local.db.prepare("SELECT saved_at, race_id, stats_json FROM horse_run_saves").all()).results as Array<{ saved_at: number; race_id: string; stats_json: string }>;
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ saved_at: NOW, race_id: "202606280511" });
    expect(JSON.parse(saves[0]!.stats_json)).toStrictEqual(stats);
  });

  it("冪等: 同じ内容をもう一度保存しても行は増えず、D1 の書き込み行数(rows_written)は行の分が 0。重複として数える", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    const horses = [horse(1, 30), horse(2, 30)];
    const first = await store.saveRace(input(horses));
    expect(first.rowsNew).toBe(60);
    expect(first.rowsWrittenRuns).toBe(60); // 新規 1 行につき rows_written 1(索引なし)
    const second = await store.saveRace(input(horses, NOW + 1000));
    expect(second).toMatchObject({ rowsNew: 0, rowsDupSameDay: 60, rowsWrittenRuns: 0, horsesZeroNew: 2 });
    expect(await count("horse_runs")).toBe(60);
    const third = await store.saveRace(input(horses, NOW + 2 * DAY_MS));
    expect(third).toMatchObject({ rowsNew: 0, rowsDupEarlier: 60, rowsWrittenRuns: 0 });
  });

  it("不一致は上書きする: 値が変わった行は新しい内容になり、初見時刻は据え置き。書き込みは変わった行の分だけ", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace(input([{ horseId: horseId(1), results: [run(1), run(2), run(3)] }]));
    const changed = run(2, { finishPosition: { kind: "順位", value: 4 } });
    const stats = await store.saveRace(input([{ horseId: horseId(1), results: [run(1), changed, run(3)] }], NOW + DAY_MS));
    expect(stats).toMatchObject({ rowsChanged: 1, rowsFilled: 0, rowsDupEarlier: 2, rowsNew: 0, rowsWrittenRuns: 1 });
    expect(stats.mismatchSamples).toStrictEqual([{ horseId: horseId(1), raceKey: raceKey(2), kind: "changed", slots: [12] }]);
    const row = await local.db.prepare("SELECT first_seen_at, data FROM horse_runs WHERE race_key = ?").bind(raceKey(2)).first<{ first_seen_at: number; data: string }>();
    expect(row).toStrictEqual({ first_seen_at: NOW, data: JSON.stringify(encodeHorseRun(changed)) });
    expect(await count("horse_runs")).toBe(3);
  });

  it("保存済みの版が古い行は再パースとして上書きされ、版数が現行になる。新しい版の行は触らない", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace(input([{ horseId: horseId(1), results: [run(1), run(2)] }]));
    await local.db.prepare("UPDATE horse_runs SET parser_version = ?, data = '[]' WHERE race_key = ?").bind(HORSE_RUN_PARSER_VERSION - 1, raceKey(1)).run();
    await local.db.prepare("UPDATE horse_runs SET parser_version = ?, data = '[\"新\"]' WHERE race_key = ?").bind(HORSE_RUN_PARSER_VERSION + 1, raceKey(2)).run();
    const stats = await store.saveRace(input([{ horseId: horseId(1), results: [run(1), run(2)] }], NOW + 1000));
    expect(stats).toMatchObject({ rowsReparsed: 1, rowsStoredNewer: 1, rowsChanged: 0, rowsWrittenRuns: 1 });
    const rows = (await local.db.prepare("SELECT race_key, parser_version, data FROM horse_runs ORDER BY race_key").all()).results;
    expect(rows).toStrictEqual([
      { race_key: raceKey(1), parser_version: HORSE_RUN_PARSER_VERSION, data: JSON.stringify(encodeHorseRun(run(1))) },
      { race_key: raceKey(2), parser_version: HORSE_RUN_PARSER_VERSION + 1, data: '["新"]' },
    ]);
  });

  it("別の馬の同じレースは別の行(鍵は馬ごと)。同じ馬の海外の行('X' + 日付)も保存される", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    const overseas = run(9, { raceIdRaw: null, venueKind: "海外", date: "2025/03/29" });
    await store.saveRace(input([{ horseId: horseId(1), results: [run(1), overseas] }, { horseId: horseId(2), results: [run(1)] }]));
    const keys = (await local.db.prepare("SELECT horse_id, race_key FROM horse_runs ORDER BY horse_id, race_key").all()).results;
    expect(keys).toStrictEqual([
      { horse_id: horseId(1), race_key: raceKey(1) },
      { horse_id: horseId(1), race_key: "X20250329" },
      { horse_id: horseId(2), race_key: raceKey(1) },
    ]);
  });
});

describe("D1HorseRunsStore.saveRace: 問い合わせの数と上限", () => {
  it("中央16頭・各30走の初回は、文が 4 つ(保存済みの読み・race_results の確認・行の書き込み・集計の記録)で、バインド変数は多くとも 100 以内", async () => {
    const { db, sqls } = recording(local.db);
    const store = new D1HorseRunsStore({ db });
    const stats = await store.saveRace(input(Array.from({ length: 16 }, (_, i) => horse(i + 1, 30))));
    expect(stats.rowsNew).toBe(480); // 前提: 480 行(16 × 30)が実際に入る
    expect(sqls).toHaveLength(4);
    expect(sqls.filter((s) => /FROM horse_runs\b/.test(s) && /^SELECT/.test(s))).toHaveLength(1);
    expect(sqls.filter((s) => s.includes("race_results"))).toHaveLength(1);
    expect(sqls.filter((s) => /^INSERT INTO horse_runs\b/.test(s))).toHaveLength(1);
    expect(sqls.filter((s) => s.includes("horse_run_saves"))).toHaveLength(1);
    expect(await count("horse_runs")).toBe(480);
  });

  it("2回目(重複だけ。新規が無い)は race_results の確認も行の書き込みも発行しない: 文が 2 つ(保存済みの読み・集計の記録)", async () => {
    const horses = Array.from({ length: 16 }, (_, i) => horse(i + 1, 30));
    await new D1HorseRunsStore({ db: local.db }).saveRace(input(horses));
    const { db, sqls } = recording(local.db);
    await new D1HorseRunsStore({ db }).saveRace(input(horses, NOW + 1000));
    expect(sqls).toHaveLength(2);
    expect(sqls.some((s) => /^INSERT INTO horse_runs\b/.test(s))).toBe(false);
    expect(sqls.some((s) => s.includes("race_results"))).toBe(false);
  });

  it(`行の書き込みは ${RUNS_WRITE_CHUNK} 行ごとに分け、馬の読みは ${HORSE_READ_CHUNK} 頭ごとに分ける(1 つのバインド変数は 2MB 以内・変数は 100 以内)`, async () => {
    const { db, sqls } = recording(local.db);
    const horses = Array.from({ length: HORSE_READ_CHUNK + 5 }, (_, i) => horse(i + 1, 1));
    // 1頭 ×1走 ×(HORSE_READ_CHUNK+5)頭 = 95 行 → 読みは 2 文。書き込みは 1 文
    await new D1HorseRunsStore({ db }).saveRace(input(horses));
    expect(sqls.filter((s) => /^SELECT[\s\S]*FROM horse_runs\b/.test(s))).toHaveLength(2);
    expect(await count("horse_runs")).toBe(HORSE_READ_CHUNK + 5);
    // 書き込みの分割: 1 頭 ×(RUNS_WRITE_CHUNK + 20)走
    await local.reset();
    const rec = recording(local.db);
    await new D1HorseRunsStore({ db: rec.db }).saveRace(input([horse(1, RUNS_WRITE_CHUNK + 20)]));
    expect(rec.sqls.filter((s) => /^INSERT INTO horse_runs\b/.test(s))).toHaveLength(2);
    expect(await count("horse_runs")).toBe(RUNS_WRITE_CHUNK + 20);
  });

  it("バインド変数は1文あたり 100 を超えない(馬 ID の読みは HORSE_READ_CHUNK 個。書き込みは JSON 1 個)", () => {
    expect(HORSE_READ_CHUNK).toBeLessThanOrEqual(100);
    expect(RUNS_WRITE_CHUNK).toBeGreaterThan(0);
  });
});

describe("D1HorseRunsStore.saveRace: 段階 D の判断材料(race_results との突き合わせ)", () => {
  async function seedResult(raceId: string): Promise<void> {
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES (?, 1, 1)").bind(raceId).run();
  }

  it("初見でない馬の新規行が race_results に取り込み済みのレースだけなら『すべて取り込み済み』、未取り込みが混ざれば『一部未取り込み』", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace(input([horse(1, 1), horse(2, 1), horse(3, 1)])); // 3頭とも 1 走(race 1)を保存済みにする
    await seedResult(raceKey(2));
    // 馬1: 新規 race 2(取り込み済み) / 馬2: 新規 race 2・3(3 は未取り込み) / 馬3: 新規なし
    const stats = await store.saveRace(
      input(
        [
          { horseId: horseId(1), results: [run(2), run(1)] },
          { horseId: horseId(2), results: [run(3), run(2), run(1)] },
          { horseId: horseId(3), results: [run(1)] },
        ],
        NOW + DAY_MS,
      ),
    );
    expect(stats).toMatchObject({ inResultsKnown: true, horsesFirstSeen: 0, horsesZeroNew: 1, horsesNewAllInResults: 1, horsesNewSomeNotInResults: 1, rowsNew: 3, newInResults: 2 });
  });

  it("race_results を引けなくても保存は成功し、inResultsKnown=false で内訳は 0", async () => {
    const { db } = recording(local.db, (sql) => sql.includes("race_results"));
    const stats = await new D1HorseRunsStore({ db }).saveRace(input([horse(1, 3)]));
    expect(stats).toMatchObject({ inResultsKnown: false, rowsNew: 3, horsesNewAllInResults: 0, newInResults: 0 });
    expect(await count("horse_runs")).toBe(3);
  });
});

describe("D1HorseRunsStore.saveRace: 失敗", () => {
  it("保存済みの読みが失敗したら投げる(呼び出し側が握る)。何も書かない", async () => {
    const { db } = recording(local.db, (sql) => /^SELECT[\s\S]*FROM horse_runs\b/.test(sql));
    await expect(new D1HorseRunsStore({ db }).saveRace(input([horse(1, 3)]))).rejects.toThrow("D1 の失敗");
    expect(await count("horse_runs")).toBe(0);
    expect(await count("horse_run_saves")).toBe(0);
  });

  it("出走馬が 0 頭なら何も発行せず、空の集計を返す(集計の行も書かない)", async () => {
    const { db, sqls } = recording(local.db);
    const stats = await new D1HorseRunsStore({ db }).saveRace(input([]));
    expect(sqls).toEqual([]);
    expect(stats).toMatchObject({ horses: 0, rowsOffered: 0, rowsNew: 0 });
  });
});

/**
 * Issue #552(#549-B1): 結果ページ由来の行(`source = 'result'`。migration 0032)。後続の B2・B3 が書く。
 * 戦績 API を正とする: 結果ページ由来の行を書く関数は戦績 API の行に触れず、戦績 API の保存は結果ページ由来の行を置き換える。
 */
describe("結果ページ由来の行を書く関数(writeResultRuns・rewriteResultRuns)", () => {
  const RESULT_AT = NOW - 7 * DAY_MS;
  /** 結果ページ由来の行(版は呼び出し側が決める。ここでは現行の版 + offset)。 */
  const resultRow = (i: number, n: number, over: Partial<ResultRunRow> = {}): ResultRunRow => ({
    horseId: horseId(i),
    raceKey: raceKey(n),
    parserVersion: HORSE_RUN_PARSER_VERSION,
    firstSeenAt: RESULT_AT,
    data: JSON.stringify(encodeHorseRun(run(n, { time: "結果ページ" }))),
    ...over,
  });
  const dump = async () => (await local.db.prepare("SELECT horse_id, race_key, parser_version, first_seen_at, source, data FROM horse_runs ORDER BY horse_id, race_key").all()).results;

  it("writeResultRuns: 行を source='result' で入れ、D1 の書き込み行数を返す。戦績 API の行には触れない(ON CONFLICT DO NOTHING。内容も source も初見時刻も変わらず、書き込みは 0)", async () => {
    await new D1HorseRunsStore({ db: local.db }).saveRace(input([{ horseId: horseId(1), results: [run(1)] }]));
    const apiBefore = await dump();
    expect(apiBefore).toHaveLength(1); // 前提: 戦績 API の行がある
    expect(apiBefore[0]!["source"]).toBeNull();
    const written = await writeResultRuns(local.db, [resultRow(1, 1), resultRow(1, 2), resultRow(2, 1)]);
    expect(written).toBe(2); // 鍵が重なる (馬1, race1) は書かない
    const rows = await dump();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toStrictEqual(apiBefore[0]); // 戦績 API の行はそのまま
    expect(rows.slice(1).map((r) => r["source"])).toEqual(["result", "result"]);
    expect(rows[1]!["first_seen_at"]).toBe(RESULT_AT);
    expect(await writeResultRuns(local.db, [resultRow(1, 2)])).toBe(0); // 結果ページ由来どうしの重なりも書かない
  });

  it("writeResultRuns: 行の書き込みは RUNS_WRITE_CHUNK 行ごとに分ける。0 行なら文を発行しない", async () => {
    const rec = recording(local.db);
    expect(await writeResultRuns(rec.db, [])).toBe(0);
    expect(rec.sqls).toEqual([]);
    const many = Array.from({ length: RUNS_WRITE_CHUNK + 20 }, (_, k) => resultRow(1, k + 1));
    expect(await writeResultRuns(rec.db, many)).toBe(RUNS_WRITE_CHUNK + 20);
    expect(rec.sqls).toHaveLength(2);
    expect(await count("horse_runs")).toBe(RUNS_WRITE_CHUNK + 20);
  });

  it("rewriteResultRuns: 版が上がったとき、結果ページ由来で版が古い行だけを書き直す。戦績 API の行・同じ版以上の結果ページ由来の行・初見時刻は変えない", async () => {
    const V = HORSE_RUN_PARSER_VERSION;
    await new D1HorseRunsStore({ db: local.db }).saveRace(input([{ horseId: horseId(1), results: [run(1)] }]));
    await writeResultRuns(local.db, [
      resultRow(1, 2, { parserVersion: V }), // 版が古い(書き直し対象)
      resultRow(1, 3, { parserVersion: V + 1 }), // 同じ版(対象外)
      resultRow(1, 4, { parserVersion: V + 2 }), // 新しい版(対象外)
    ]);
    const before = await dump();
    expect(before).toHaveLength(4); // 前提: 4 行(API 1 + 結果ページ 3)
    const next = (n: number): ResultRunRow => resultRow(1, n, { parserVersion: V + 1, firstSeenAt: NOW, data: JSON.stringify(["書き直し"]) });
    // race1 は戦績 API の行(対象外)。race2 は版が古い結果ページ由来(対象)。race3 は同じ版。race4 はより新しい版。
    const written = await rewriteResultRuns(local.db, [next(1), next(2), next(3), next(4), next(5)]); // race5 は保存済みに無い鍵(挿入にならない)
    expect(written).toBe(1);
    expect(await count("horse_runs")).toBe(4);
    const after = await dump();
    expect(after[0]).toStrictEqual(before[0]); // 戦績 API の行
    expect(after[1]).toStrictEqual({ ...before[1], parser_version: V + 1, data: JSON.stringify(["書き直し"]) }); // 初見時刻と source は据え置き
    expect(after[1]!["first_seen_at"]).toBe(RESULT_AT);
    expect(after[1]!["source"]).toBe("result");
    expect(after[2]).toStrictEqual(before[2]);
    expect(after[3]).toStrictEqual(before[3]);
  });
});

describe("D1HorseRunsStore.saveRace: 結果ページ由来の行(Issue #552)", () => {
  const RESULT_AT = NOW - 7 * DAY_MS;
  const resultRows = (i: number, ns: number[]): ResultRunRow[] =>
    ns.map((n) => ({ horseId: horseId(i), raceKey: raceKey(n), parserVersion: HORSE_RUN_PARSER_VERSION, firstSeenAt: RESULT_AT, data: JSON.stringify(encodeHorseRun(run(n, { time: "結果ページ" }))) }));

  it("結果ページ由来の行は『置き換えた』として戦績 API の内容で上書きされ、source が NULL に戻り、初見時刻が保存時刻になる。不一致(changed)には数えない。結果ページ由来の行しか無い馬は初見", async () => {
    await writeResultRuns(local.db, resultRows(1, [1, 2]));
    const stats = await new D1HorseRunsStore({ db: local.db }).saveRace(input([{ horseId: horseId(1), results: [run(1), run(2), run(3)] }]));
    expect(stats).toMatchObject({ horsesFirstSeen: 1, rowsNew: 1, rowsReplacedFromResult: 2, rowsChanged: 0, rowsFilled: 0, rowsReparsed: 0, rowsDupSameDay: 0, rowsDupEarlier: 0, rowsWrittenRuns: 3 });
    expect(stats.mismatchSamples).toEqual([]);
    const rows = (await local.db.prepare("SELECT race_key, source, first_seen_at, data FROM horse_runs ORDER BY race_key").all()).results;
    expect(rows).toStrictEqual([1, 2, 3].map((n) => ({ race_key: raceKey(n), source: null, first_seen_at: NOW, data: JSON.stringify(encodeHorseRun(run(n))) })));
    // 置き換えた後は戦績 API の行として扱う: もう一度同じ内容を保存すれば重複(同日の再実行)
    const again = await new D1HorseRunsStore({ db: local.db }).saveRace(input([{ horseId: horseId(1), results: [run(1), run(2), run(3)] }], NOW + 1000));
    expect(again).toMatchObject({ horsesFirstSeen: 0, rowsReplacedFromResult: 0, rowsDupSameDay: 3, rowsWrittenRuns: 0 });
  });

  it("書き込みの文の数は変わらない: 置き換えは新規と別の文を増やさず、上書きの文 1 つにまとまる(読み 1・race_results の確認 1・上書き 1・記録 1)", async () => {
    await writeResultRuns(local.db, resultRows(1, [1, 2]));
    const { db, sqls } = recording(local.db);
    await new D1HorseRunsStore({ db }).saveRace(input([{ horseId: horseId(1), results: [run(1), run(2)] }]));
    expect(sqls).toHaveLength(4);
    expect(sqls.filter((s) => /^INSERT INTO horse_runs\b/.test(s))).toHaveLength(1);
  });

  it("保存済みの行の読みは source 列を含め、戦績 API 由来の行(NULL)と結果ページ由来の行を区別する(混在した馬は初見でなく、結果ページ由来の行だけを置き換える)", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace(input([{ horseId: horseId(1), results: [run(1)] }])); // 戦績 API の行
    await writeResultRuns(local.db, resultRows(1, [2]));
    const stats = await store.saveRace(input([{ horseId: horseId(1), results: [run(1), run(2)] }], NOW + DAY_MS));
    expect(stats).toMatchObject({ horsesFirstSeen: 0, rowsDupEarlier: 1, rowsReplacedFromResult: 1, rowsNew: 0, horsesNewAllInResults: 0, horsesNewSomeNotInResults: 1 });
  });
});
