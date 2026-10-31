import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HorseRaceResult } from "../../packages/core/src/scraper/types";
import { D1HorseRunsStore, STATUS_NOTE, aggregateSaves, readHorseRunsStatus, writeResultRuns } from "../src/horse-runs-repository";
import { HORSE_RUN_PARSER_VERSION, encodeHorseRun } from "../../packages/core/src/scraper/horse-run-record";
import type { SaveStats } from "../src/horse-runs";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #256 段階A: 管理者用の診断の中身(`readHorseRunsStatus`。読み取りだけ)。2〜4 週後に段階 D・E へ進むかを判断する材料。
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

const DAY_MS = 86_400_000;
const NOON = Date.parse("2026-06-27T03:00:00Z"); // JST 2026-06-27 12:00

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
const run = (n: number, patch: Partial<HorseRaceResult> = {}): HorseRaceResult => ({ ...BASE, raceIdRaw: raceKey(n), date: `2026/05/${String(((n - 1) % 28) + 1).padStart(2, "0")}`, ...patch });

describe("readHorseRunsStatus", () => {
  it("空の表: 行数 0・日付は null・保存の集計は 0・割合は null(分母 0)", async () => {
    const s = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: false });
    expect(s.table).toStrictEqual({ rows: 0, horses: 0, byKind: {}, byParserVersion: {}, runDateMin: null, runDateMax: null, firstSeenMin: null, firstSeenMax: null });
    expect(s.saves.all).toMatchObject({ saves: 0, horses: 0, rowsNew: 0, shareNewAllInResults: null, shareZeroNew: null });
    expect(s.saves.daily).toEqual([]);
    expect(s.resultRows).toStrictEqual({ rows: 0, horses: 0, byParserVersion: {}, runDateMin: null, runDateMax: null }); // Issue #552: 結果ページ由来の行は 0 件
    expect(s.cells).toBeUndefined();
    expect(s.note).toBe(STATUS_NOTE);
    expect(STATUS_NOTE).toContain("手動の発走前だけの分析"); // 段階Aの限界を診断に書く(オーケストレーターの指示)
  });

  it("保存後: 表の行数・馬の数・開催区分別・版数別・走った日の最小最大・初見時刻の最小最大", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace({
      raceId: "202606280511",
      kaisaiDate: "20260628",
      savedAt: NOON,
      horses: [
        { horseId: "2020100001", results: [run(1, { date: "2026/05/03" }), run(2, { date: "2025/12/20", venueKind: "地方", raceIdRaw: "202644031511" })] },
        { horseId: "2020100002", results: [run(3, { date: "2026/06/01" }), run(9, { raceIdRaw: null, venueKind: "海外", date: "2025/03/29" })] },
      ],
    });
    const s = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: false });
    expect(s.table).toStrictEqual({
      rows: 4,
      horses: 2,
      byKind: { 中央: 2, 地方: 1, 海外: 1 },
      byParserVersion: { "1": 4 },
      runDateMin: "2025/03/29",
      runDateMax: "2026/06/01",
      firstSeenMin: NOON,
      firstSeenMax: NOON,
    });
    expect(s.saves.all).toMatchObject({ saves: 1, horses: 2, horsesFirstSeen: 2, rowsNew: 4, rowsWrittenRuns: 4, newByKind: { central: 2, nar: 1, overseas: 1 } });
    expect(s.saves.daily).toEqual([{ day: "20260627", saves: 1, horses: 2, horsesFirstSeen: 2, rowsNew: 4, rowsWrittenRuns: 4 }]);
  });

  it("開催日より前に保存した分だけを『事前』として別に集計する(開催日以降の手動の再分析を判断から外す)。期間の外は読まない", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    const horses = (i: number) => [{ horseId: `20201000${i}`, results: [run(1)] }];
    await store.saveRace({ raceId: "202606280511", kaisaiDate: "20260628", savedAt: NOON, horses: horses(1) }); // 前日に保存 = 事前
    await store.saveRace({ raceId: "202606280512", kaisaiDate: "20260628", savedAt: NOON + DAY_MS, horses: horses(2) }); // 開催日当日に保存 = 事前でない
    await store.saveRace({ raceId: "202606280513", kaisaiDate: "20260628", savedAt: NOON - 40 * DAY_MS, horses: horses(3) }); // 期間の外
    const s = await readHorseRunsStatus(local.db, { sinceMs: NOON - 14 * DAY_MS, days: 14, cells: false });
    expect(s.saves.all.saves).toBe(2);
    expect(s.saves.beforeRaceDay.saves).toBe(1);
    expect(s.saves.beforeRaceDay.horses).toBe(1);
    expect(s.saves.daily.map((d) => d.day)).toEqual(["20260627", "20260628"]);
  });

  it("壊れた集計の行は読めなかった数に入れ、他の行の集計は続ける", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace({ raceId: "202606280511", kaisaiDate: "20260628", savedAt: NOON, horses: [{ horseId: "2020100001", results: [run(1)] }] });
    await local.db.prepare("INSERT INTO horse_run_saves (saved_at, race_id, stats_json) VALUES (?, ?, ?)").bind(NOON + 1, "x", "{壊れた").run();
    await local.db.prepare("INSERT INTO horse_run_saves (saved_at, race_id, stats_json) VALUES (?, ?, ?)").bind(NOON + 2, "y", JSON.stringify({ v: 2 })).run();
    const s = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: false });
    expect(s.saves.unreadable).toBe(2);
    expect(s.saves.all.saves).toBe(1);
  });

  it("cells=1: 中央の走を 騎手 × 競馬場 × 芝ダ × 距離帯(200m)のセルに分け、走数が 10・30・100 以上のセルの数を返す。地方・海外・騎手なしは数えない", async () => {
    const rows: HorseRaceResult[] = [];
    let n = 0;
    const add = (count: number, patch: Partial<HorseRaceResult>) => {
      for (let i = 0; i < count; i += 1) {
        n += 1;
        rows.push(run(n, patch));
      }
    };
    add(100, { jockeyId: "A", distance: 1800 }); // セル1: 福島・芝・1800(帯 9)・A = 100
    add(30, { jockeyId: "A", distance: 1900 }); // 1900 は同じ帯(1800〜1999)。セル1 に入って 130
    add(12, { jockeyId: "B", distance: 1800 }); // セル2 = 12
    add(5, { jockeyId: "A", distance: 2000 }); // 帯が違う(2000〜)。セル3 = 5
    add(3, { jockeyId: "A", venue: { round: 1, name: "東京", day: 1, raw: "1東京1" } }); // 競馬場が違う。セル4 = 3
    add(7, { jockeyId: "A", courseType: "ダ" }); // 芝ダが違う。セル5 = 7
    add(50, { jockeyId: "A", venueKind: "地方" }); // 数えない
    add(50, { jockeyId: null }); // 騎手なし: 数えない
    add(50, { jockeyId: "A", distance: null }); // 距離なし: 数えない
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace({ raceId: "202606280511", kaisaiDate: "20260628", savedAt: NOON, horses: [{ horseId: "2020100001", results: rows }] });
    const s = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: true });
    expect(s.cells).toStrictEqual({ cells: 5, runs: 130 + 12 + 5 + 3 + 7, n10: 2, n30: 1, n100: 1 });
  });
});

describe("aggregateSaves(純関数)", () => {
  const base: SaveStats = {
    v: 1,
    raceId: "r",
    kaisaiDate: "20260628",
    savedAt: NOON,
    horses: 16,
    horsesFirstSeen: 6,
    horsesZeroNew: 2,
    horsesNewAllInResults: 6,
    horsesNewSomeNotInResults: 2,
    inResultsKnown: true,
    rowsOffered: 100,
    rowsNoKey: 0,
    rowsDupInInput: 0,
    rowsNew: 40,
    rowsNewFromFirstSeen: 30,
    newByKind: { central: 20, nar: 15, overseas: 5 },
    newInResults: 15,
    rowsDupSameDay: 0,
    rowsDupEarlier: 60,
    rowsFilled: 0,
    rowsChanged: 0,
    rowsReparsed: 0,
    rowsStoredNewer: 0,
    mismatchSamples: [],
    rowsWrittenRuns: 40,
  };

  it("足し合わせ、割合は『新規あり』『初見でない馬』を分母にする(初見・新規0行を分母に混ぜない)", () => {
    const t = aggregateSaves([base, { ...base, inResultsKnown: false, horsesNewAllInResults: 0, horsesNewSomeNotInResults: 0 }]);
    expect(t).toMatchObject({ saves: 2, horses: 32, horsesFirstSeen: 12, horsesZeroNew: 4, rowsNew: 80, rowsWrittenRuns: 80, savesWithoutResultsLookup: 1 });
    expect(t.newByKind).toStrictEqual({ central: 40, nar: 30, overseas: 10 });
    // 新規あり = 6 + 2(引けなかった保存の内訳は 0)。すべて取り込み済み 6 / 8
    expect(t.shareNewAllInResults).toBeCloseTo(6 / 8, 10);
    // 初見でない馬 = 32 - 12 = 20。新規 0 行 4
    expect(t.shareZeroNew).toBeCloseTo(4 / 20, 10);
  });

  it("空の入力は 0 件・割合は null", () => {
    expect(aggregateSaves([])).toMatchObject({ saves: 0, shareNewAllInResults: null, shareZeroNew: null });
  });
});

/**
 * Issue #552(#549-B1): 結果ページ由来の行(`source = 'result'`)が混ざっても、診断の表(`table`)と `cells` は戦績 API 由来の行だけを数える。
 * 結果ページ由来の行は別の欄(`resultRows`)に出す。結果ページ由来が 0 件の今は、既存の数字が一切変わらない。
 */
describe("readHorseRunsStatus: 出どころで分ける(Issue #552)", () => {
  async function seed(): Promise<void> {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace({
      raceId: "202606280511",
      kaisaiDate: "20260628",
      savedAt: NOON,
      horses: [{ horseId: "2020100001", results: [run(1, { date: "2026/05/03" }), run(2, { date: "2025/12/20", venueKind: "地方", raceIdRaw: "202644031511" })] }],
    });
  }
  const resultRun = (horseId: string, n: number, patch: Partial<HorseRaceResult>) => ({
    horseId,
    raceKey: patch.raceIdRaw ?? raceKey(n),
    parserVersion: HORSE_RUN_PARSER_VERSION + 5,
    firstSeenAt: NOON - 99 * DAY_MS,
    data: JSON.stringify(encodeHorseRun(run(n, patch))),
  });

  it("結果ページ由来の行を足しても、table(行数・馬の数・区分別・版数別・走った日・初見時刻)は戦績 API 由来のままで、足した行は resultRows にだけ出る", async () => {
    await seed();
    const before = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: true });
    expect(before.table.rows).toBe(2); // 前提: 戦績 API 由来の行がある
    expect(before.resultRows.rows).toBe(0);
    await writeResultRuns(local.db, [
      resultRun("2020100001", 7, { date: "2020/01/05" }), // 戦績 API の馬が持つ別の走
      resultRun("2020100009", 8, { date: "2019/12/01" }), // 戦績 API に無い馬
      resultRun("2020100009", 9, { date: "2024/03/09", venueKind: "地方", raceIdRaw: "202644031599" }),
    ]);
    const after = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: true });
    expect(after.table).toStrictEqual(before.table); // table は 1 バイトも変わらない
    expect(after.cells).toStrictEqual(before.cells);
    expect(after.saves).toStrictEqual(before.saves);
    expect(after.resultRows).toStrictEqual({ rows: 3, horses: 2, byParserVersion: { [String(HORSE_RUN_PARSER_VERSION + 5)]: 3 }, runDateMin: "2019/12/01", runDateMax: "2024/03/09" });
  });

  it("cells=1 は戦績 API 由来の中央の走だけを数える(結果ページ由来の中央の走は数えない)", async () => {
    const store = new D1HorseRunsStore({ db: local.db });
    await store.saveRace({ raceId: "202606280511", kaisaiDate: "20260628", savedAt: NOON, horses: [{ horseId: "2020100001", results: Array.from({ length: 12 }, (_, i) => run(i + 1, { jockeyId: "A" })) }] });
    await writeResultRuns(local.db, Array.from({ length: 30 }, (_, i) => resultRun("2020100002", i + 1, { jockeyId: "A" })));
    const s = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: true });
    expect(s.cells).toStrictEqual({ cells: 1, runs: 12, n10: 1, n30: 0, n100: 0 }); // 結果ページ由来の 30 走が入れば n30 が 1 になる
    expect(s.resultRows.rows).toBe(30);
  });

  it("結果ページ由来の行が 0 件のとき: 表・保存の集計・割合は従来の値のまま(固定)。集計の新しい項目 rowsReplacedFromResult は 0。保存の記録(stats_json)に項目が増えても v は 1 のまま", async () => {
    await seed();
    const s = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: false });
    expect(s.table).toStrictEqual({ rows: 2, horses: 1, byKind: { 中央: 1, 地方: 1 }, byParserVersion: { "1": 2 }, runDateMin: "2025/12/20", runDateMax: "2026/05/03", firstSeenMin: NOON, firstSeenMax: NOON });
    expect(s.saves.all).toStrictEqual({
      saves: 1,
      horses: 1,
      horsesFirstSeen: 1,
      horsesZeroNew: 0,
      horsesNewAllInResults: 0,
      horsesNewSomeNotInResults: 0,
      rowsOffered: 2,
      rowsNew: 2,
      rowsDupSameDay: 0,
      rowsDupEarlier: 0,
      rowsFilled: 0,
      rowsChanged: 0,
      rowsReparsed: 0,
      rowsStoredNewer: 0,
      rowsNoKey: 0,
      rowsDupInInput: 0,
      rowsWrittenRuns: 2,
      newByKind: { central: 1, nar: 1, overseas: 0 },
      savesWithoutResultsLookup: 0,
      shareNewAllInResults: null,
      shareZeroNew: null,
      rowsReplacedFromResult: 0,
    });
    const raw = (await local.db.prepare("SELECT stats_json AS j FROM horse_run_saves").first<{ j: string }>())!.j;
    expect((JSON.parse(raw) as SaveStats).v).toBe(1);
    expect((JSON.parse(raw) as SaveStats).rowsReplacedFromResult).toBe(0);
  });

  it("置き換えの件数は期間内の保存の集計に足される。この項目が無い古い記録は 0 として読む(読めなかった数に入れない)", async () => {
    await seed();
    await writeResultRuns(local.db, [resultRun("2020100003", 1, {}), resultRun("2020100003", 2, {})]);
    await new D1HorseRunsStore({ db: local.db }).saveRace({ raceId: "202606280512", kaisaiDate: "20260628", savedAt: NOON + 1000, horses: [{ horseId: "2020100003", results: [run(1), run(2)] }] });
    const old = JSON.parse((await local.db.prepare("SELECT stats_json AS j FROM horse_run_saves ORDER BY saved_at LIMIT 1").first<{ j: string }>())!.j) as Record<string, unknown>;
    delete old["rowsReplacedFromResult"]; // 項目が増える前の記録の形
    await local.db.prepare("INSERT INTO horse_run_saves (saved_at, race_id, stats_json) VALUES (?, ?, ?)").bind(NOON + 2000, "202606280513", JSON.stringify(old)).run();
    const s = await readHorseRunsStatus(local.db, { sinceMs: 0, days: 14, cells: false });
    expect(s.saves.unreadable).toBe(0);
    expect(s.saves.all.saves).toBe(3);
    expect(s.saves.all.rowsReplacedFromResult).toBe(2);
  });

  it("aggregateSaves: rowsReplacedFromResult を足し合わせる(任意の項目。無い記録は 0)", () => {
    const one = { v: 1, raceId: "r", kaisaiDate: "20260628", savedAt: NOON, horses: 1, horsesFirstSeen: 0, horsesZeroNew: 0, horsesNewAllInResults: 0, horsesNewSomeNotInResults: 0, inResultsKnown: true, rowsOffered: 0, rowsNoKey: 0, rowsDupInInput: 0, rowsNew: 0, rowsNewFromFirstSeen: 0, newByKind: { central: 0, nar: 0, overseas: 0 }, newInResults: 0, rowsDupSameDay: 0, rowsDupEarlier: 0, rowsFilled: 0, rowsChanged: 0, rowsReparsed: 0, rowsStoredNewer: 0, mismatchSamples: [], rowsWrittenRuns: 0 } satisfies SaveStats;
    expect(aggregateSaves([{ ...one, rowsReplacedFromResult: 3 }, { ...one, rowsReplacedFromResult: 4 }, one]).rowsReplacedFromResult).toBe(7);
    expect(aggregateSaves([]).rowsReplacedFromResult).toBe(0);
  });

  it("STATUS_NOTE は、表と cells が戦績 API 由来に絞られていることと、結果ページ由来が resultRows に別出しであることを書く", () => {
    expect(STATUS_NOTE).toContain("resultRows");
    expect(STATUS_NOTE).toContain("戦績 API");
    expect(STATUS_NOTE).toContain("手動の発走前だけの分析");
  });
});
