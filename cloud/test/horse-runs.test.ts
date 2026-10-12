import { describe, expect, it } from "vitest";
import { HORSE_RUN_PARSER_VERSION, encodeHorseRun, horseRunKey } from "../../packages/core/src/scraper/horse-run-record";
import type { HorseRaceResult } from "../../packages/core/src/scraper/types";
import { jstDay, planHorseRunsSave, summarizeSave, type PlanInput, type StoredRun } from "../src/horse-runs";

/**
 * Issue #256 段階A: 戦績の保存の計画(純ロジック。D1 に触れない)。
 * 保存済みの行と今回取った行を突き合わせ、「新規・重複(同日の再実行/前日以前)・不一致(後から埋まった/値が変わった)・再パース」に分け、
 * 段階 D・E に進むかの判断材料(horse_run_saves の集計)を作る。
 */

const BASE: HorseRaceResult = {
  date: "2026/06/28",
  venue: { round: 2, name: "福島", day: 2, raw: "2福島2" },
  weather: "晴",
  raceNumber: 11,
  raceName: "テスト",
  raceId: "202603020211" as HorseRaceResult["raceId"],
  raceIdRaw: "202603020211",
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

/** n 番目のレースの1走(レース ID と日付を変える)。 */
function run(n: number, patch: Partial<HorseRaceResult> = {}): HorseRaceResult {
  const id = `20260302${String(n).padStart(4, "0")}`;
  return { ...BASE, raceIdRaw: id, raceId: null, date: `2026/05/${String(n).padStart(2, "0")}`, ...patch };
}

const NOW = Date.parse("2026-06-27T12:00:00Z"); // JST 2026-06-27 21:00
const DAY_MS = 86_400_000;

function stored(horseId: string, r: HorseRaceResult, over: Partial<StoredRun> = {}): StoredRun {
  return {
    horseId,
    raceKey: horseRunKey(r)!,
    parserVersion: HORSE_RUN_PARSER_VERSION,
    firstSeenAt: NOW - 30 * DAY_MS,
    data: JSON.stringify(encodeHorseRun(r)),
    ...over,
  };
}

function input(horses: PlanInput["horses"]): PlanInput {
  return { raceId: "202606280511", kaisaiDate: "20260628", savedAt: NOW, horses };
}

describe("jstDay", () => {
  it("JST の日付(YYYYMMDD)。UTC 14:59:59.999 は JST 23:59、UTC 15:00 は翌日", () => {
    expect(jstDay(Date.parse("2026-06-27T14:59:59.999Z"))).toBe("20260627");
    expect(jstDay(Date.parse("2026-06-27T15:00:00.000Z"))).toBe("20260628");
  });
});

describe("planHorseRunsSave: 新規", () => {
  it("保存済みが無い馬(初見)は全行が新規。鍵の無い行は保存せず数える。同じ鍵の重複は1行目だけ", () => {
    const noKey = run(9, { raceIdRaw: null, date: null, venueKind: "海外" });
    const dup = run(1);
    const plan = planHorseRunsSave(input([{ horseId: "2020100001", results: [run(1), dup, run(2), noKey] }]), []);
    expect(plan.inserts.map((r) => r.raceKey)).toEqual(["202603020001", "202603020002"]);
    expect(plan.updates).toEqual([]);
    const stats = summarizeSave(plan, new Set(), 0);
    expect(stats).toMatchObject({ horses: 1, horsesFirstSeen: 1, rowsOffered: 4, rowsNoKey: 1, rowsDupInInput: 1, rowsNew: 2, rowsNewFromFirstSeen: 2 });
    // 保存する行の中身: 版数・初見時刻・タプルの JSON
    expect(plan.inserts[0]).toStrictEqual({ horseId: "2020100001", raceKey: "202603020001", parserVersion: HORSE_RUN_PARSER_VERSION, firstSeenAt: NOW, data: JSON.stringify(encodeHorseRun(run(1))) });
  });

  it("新規行の開催区分別の件数(中央・地方・海外)", () => {
    const rows = [run(1), run(2, { venueKind: "地方", raceIdRaw: "202644031511" }), run(3, { venueKind: "海外", raceIdRaw: null, date: "2026/03/29" })];
    const stats = summarizeSave(planHorseRunsSave(input([{ horseId: "2020100001", results: rows }]), []), new Set(), 0);
    expect(stats.newByKind).toStrictEqual({ central: 1, nar: 1, overseas: 1 });
    expect(stats.rowsNew).toBe(3);
  });
});

describe("planHorseRunsSave: 重複(一致)", () => {
  it("同じ内容の再送は書き込みなし。保存したのが同じ JST 日なら『同日の再実行』、前日以前なら『前日以前から保存済み』", () => {
    const h = "2020100001";
    const rows = [run(1), run(2)];
    const store = [stored(h, rows[0]!, { firstSeenAt: NOW - 1000 }), stored(h, rows[1]!, { firstSeenAt: NOW - DAY_MS })];
    const plan = planHorseRunsSave(input([{ horseId: h, results: rows }]), store);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(summarizeSave(plan, new Set(), 0)).toMatchObject({ rowsNew: 0, rowsDupSameDay: 1, rowsDupEarlier: 1, rowsFilled: 0, rowsChanged: 0, horsesFirstSeen: 0, horsesZeroNew: 1 });
  });

  it("日付の境界: 保存が JST の前日 23:59 なら『前日以前』、同日の 00:00 なら『同日』", () => {
    const h = "2020100001";
    const r = run(1);
    const jstMidnight = Date.parse("2026-06-26T15:00:00Z"); // JST 2026-06-27 00:00
    const a = summarizeSave(planHorseRunsSave(input([{ horseId: h, results: [r] }]), [stored(h, r, { firstSeenAt: jstMidnight - 1 })]), new Set(), 0);
    const b = summarizeSave(planHorseRunsSave(input([{ horseId: h, results: [r] }]), [stored(h, r, { firstSeenAt: jstMidnight })]), new Set(), 0);
    expect([a.rowsDupEarlier, a.rowsDupSameDay]).toEqual([1, 0]);
    expect([b.rowsDupEarlier, b.rowsDupSameDay]).toEqual([0, 1]);
  });
});

describe("planHorseRunsSave: 不一致(上書きする。初見時刻は変えない)", () => {
  const h = "2020100001";

  it("後から埋まった(保存済みで空だった項目が埋まった)だけなら『埋まった』。値が変わったら『変わった』", () => {
    const empty = run(1, { pace: null, last3f: null, passing: [] });
    const filled = run(1); // 保存済み(空)→今回(埋まった)
    const changed = run(2, { finishPosition: { kind: "順位", value: 4 } }); // 保存済み(5着)→今回(4着=繰り上がり)
    const store = [stored(h, empty, { firstSeenAt: NOW - 2 * DAY_MS }), stored(h, run(2), { firstSeenAt: NOW - 3 * DAY_MS })];
    const plan = planHorseRunsSave(input([{ horseId: h, results: [filled, changed] }]), store);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates.map((u) => u.raceKey)).toEqual(["202603020001", "202603020002"]);
    expect(plan.updates[0]!.firstSeenAt).toBe(NOW - 2 * DAY_MS); // 初見時刻は据え置き
    expect(plan.updates[0]!.data).toBe(JSON.stringify(encodeHorseRun(filled)));
    const stats = summarizeSave(plan, new Set(), 0);
    expect(stats).toMatchObject({ rowsFilled: 1, rowsChanged: 1, rowsDupSameDay: 0, rowsDupEarlier: 0, rowsNew: 0 });
    // 標本: 違ったスロットの番号(pace=22・last3f=23・passing=21 / finishPosition=12)と種別
    expect(stats.mismatchSamples).toStrictEqual([
      { horseId: h, raceKey: "202603020001", kind: "filled", slots: [21, 22, 23] },
      { horseId: h, raceKey: "202603020002", kind: "changed", slots: [12] },
    ]);
  });

  it("埋まった項目と値が変わった項目が混ざる行は『変わった』(埋まっただけではない)", () => {
    const before = run(1, { pace: null, jockeyName: "旧名" });
    const after = run(1, { jockeyName: "新名" });
    const stats = summarizeSave(planHorseRunsSave(input([{ horseId: h, results: [after] }]), [stored(h, before)]), new Set(), 0);
    expect(stats).toMatchObject({ rowsFilled: 0, rowsChanged: 1 });
  });

  it("標本は1回の保存で最大 5 件。件数(rowsChanged)は全件を数える", () => {
    const rows = Array.from({ length: 7 }, (_, i) => run(i + 1, { time: "1:00.0" }));
    const store = rows.map((r) => stored(h, { ...r, time: "1:01.0" }));
    const plan = planHorseRunsSave(input([{ horseId: h, results: rows }]), store);
    expect(plan.updates).toHaveLength(7);
    const stats = summarizeSave(plan, new Set(), 0);
    expect(stats.rowsChanged).toBe(7);
    expect(stats.mismatchSamples).toHaveLength(5);
  });
});

describe("planHorseRunsSave: 版数", () => {
  const h = "2020100001";
  it("保存済みの版が古い行は『再パース』として上書きする(不一致には数えない)。初見時刻は据え置き", () => {
    const r = run(1);
    const old = stored(h, { ...r, time: "旧" }, { parserVersion: HORSE_RUN_PARSER_VERSION - 1 });
    const plan = planHorseRunsSave(input([{ horseId: h, results: [r] }]), [old]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ parserVersion: HORSE_RUN_PARSER_VERSION, firstSeenAt: old.firstSeenAt });
    expect(summarizeSave(plan, new Set(), 0)).toMatchObject({ rowsReparsed: 1, rowsChanged: 0, rowsFilled: 0 });
  });

  it("保存済みの版のほうが新しい行(旧い Worker が動いているとき)は上書きしない", () => {
    const r = run(1);
    const newer = stored(h, { ...r, time: "新" }, { parserVersion: HORSE_RUN_PARSER_VERSION + 1 });
    const plan = planHorseRunsSave(input([{ horseId: h, results: [r] }]), [newer]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(summarizeSave(plan, new Set(), 0)).toMatchObject({ rowsStoredNewer: 1, rowsChanged: 0 });
  });
});

describe("summarizeSave: 段階 D の判断材料(馬ごとの分類)", () => {
  it("初見でない馬を、新規0行・新規がすべて結果の取り込み済み・一部が未取り込み に分ける。初見の馬は別に数える", () => {
    const a = "2020100001"; // 新規0行
    const b = "2020100002"; // 新規1行(race 3: race_results にある)
    const c = "2020100003"; // 新規2行(race 4 はある・race 5 は無い)
    const d = "2020100004"; // 初見(保存済みなし)
    const store = [stored(a, run(1)), stored(b, run(1)), stored(c, run(1))];
    const plan = planHorseRunsSave(
      input([
        { horseId: a, results: [run(1)] },
        { horseId: b, results: [run(3), run(1)] },
        { horseId: c, results: [run(5), run(4), run(1)] },
        { horseId: d, results: [run(3), run(1)] },
      ]),
      store,
    );
    // race_results を引く鍵は、新規行のレース ID(12 桁)を重複なしで。a の run(1) は保存済み・d の run(1) は初見の馬の新規なので入る
    expect([...plan.newKeys].sort()).toEqual(["202603020001", "202603020003", "202603020004", "202603020005"]);
    const stats = summarizeSave(plan, new Set(["202603020003", "202603020004"]), 0);
    expect(stats).toMatchObject({
      horses: 4,
      horsesFirstSeen: 1,
      horsesZeroNew: 1,
      horsesNewAllInResults: 1,
      horsesNewSomeNotInResults: 1,
      inResultsKnown: true,
      rowsNew: 5, // b:1 + c:2 + d:2
      rowsNewFromFirstSeen: 2,
      newInResults: 3, // b:race3 + c:race4 + d:race3(初見の馬の新規も数える。鍵が race_results にあるか)
    });
    // 馬の分類の和 = 馬の数
    expect(stats.horsesFirstSeen + stats.horsesZeroNew + stats.horsesNewAllInResults + stats.horsesNewSomeNotInResults).toBe(stats.horses);
  });

  it("race_results を引けなかった(null)ときは、取り込み済みかの内訳を 0 にして inResultsKnown=false にする(保存は妨げない)", () => {
    const h = "2020100001";
    const plan = planHorseRunsSave(input([{ horseId: h, results: [run(2), run(1)] }]), [stored(h, run(1))]);
    const stats = summarizeSave(plan, null, 0);
    expect(stats).toMatchObject({ inResultsKnown: false, horsesNewAllInResults: 0, horsesNewSomeNotInResults: 0, newInResults: 0, rowsNew: 1 });
    expect(plan.inserts).toHaveLength(1);
  });

  it("件数の恒等式: 提供した行数 = 鍵なし + 入力内の重複 + 新規 + 保存済みの内訳(同日・前日以前・埋まった・変わった・再パース・保存済みが新しい)", () => {
    const h = "2020100001";
    const rows = [
      run(1), // 一致(同日)
      run(2), // 一致(前日以前)
      run(3, { pace: "29.9-37.6" }), // 埋まった
      run(4, { time: "x" }), // 変わった
      run(5), // 再パース
      run(6), // 保存済みが新しい
      run(7), // 新規
      run(7), // 入力内の重複
      run(8, { raceIdRaw: null, date: null, venueKind: "海外" }), // 鍵なし
    ];
    const store = [
      stored(h, run(1), { firstSeenAt: NOW }),
      stored(h, run(2), { firstSeenAt: NOW - 2 * DAY_MS }),
      stored(h, run(3, { pace: null })),
      stored(h, run(4)),
      stored(h, run(5), { parserVersion: HORSE_RUN_PARSER_VERSION - 1 }),
      stored(h, run(6), { parserVersion: HORSE_RUN_PARSER_VERSION + 1 }),
    ];
    const s = summarizeSave(planHorseRunsSave(input([{ horseId: h, results: rows }]), store), new Set(), 0);
    expect(s.rowsOffered).toBe(9);
    const parts = [s.rowsNoKey, s.rowsDupInInput, s.rowsNew, s.rowsDupSameDay, s.rowsDupEarlier, s.rowsFilled, s.rowsChanged, s.rowsReparsed, s.rowsStoredNewer];
    expect(parts).toStrictEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]); // 前提: どの区分も1行ずつ入っている(空振りでない)
    expect(parts.reduce((x, y) => x + y, 0)).toBe(s.rowsOffered);
  });

  it("集計には保存したレース・開催日・時刻と、D1 の書き込み行数を載せる", () => {
    const s = summarizeSave(planHorseRunsSave(input([{ horseId: "2020100001", results: [run(1)] }]), []), new Set(), 7);
    expect(s).toMatchObject({ v: 1, raceId: "202606280511", kaisaiDate: "20260628", savedAt: NOW, rowsWrittenRuns: 7 });
  });
});
