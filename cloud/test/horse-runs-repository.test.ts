import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HORSE_RUN_PARSER_VERSION, encodeHorseRun } from "../../packages/core/src/scraper/horse-run-record";
import type { HorseRaceResult } from "../../packages/core/src/scraper/types";
import { D1HorseRunsStore, HORSE_READ_CHUNK, RUNS_WRITE_CHUNK } from "../src/horse-runs-repository";
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
