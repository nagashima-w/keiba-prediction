import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRaceRecord } from "../../packages/core/src/scraper/race-record";
import {
  PERSON_STATS_FROM_DATE,
  aggregatePersonYears,
  buildPersonRow,
  decodePersonHorses,
  encodePersonHorses,
  type PersonRow,
  type PersonSourceRecord,
} from "../src/person-stats-calc";
import { pathFromMeta } from "./meta-path";

/**
 * Issue #729(段階 A): 騎手・調教師の年ごとの集計の元になる「レースごとの人の行」(`buildPersonRow`)と、年ごとの集計(`aggregatePersonYears`)。
 * **定義はこの 2 つの純関数だけが持つ**: starts は取消・除外を除く全頭(中止・失格を含む)、placed は finish <= 3。障害も含める。
 * 定義が並走の突き合わせ(jockey_results・trainer_results との比較)で合わないときは、ここだけを直す。
 */

type H = PersonSourceRecord["horses"][number];
const horse = (over: Partial<H>): H => ({ finish: 1, finishStatus: null, jockeyId: "J1", trainerId: "T1", ...over });
const record = (horses: H[], over: Partial<PersonSourceRecord> = {}): PersonSourceRecord => ({
  raceId: "202506010101",
  date: "2025-06-01",
  kind: "central",
  venueCode: "06",
  courseType: "芝",
  distance: 1600,
  horses,
  ...over,
});

describe("buildPersonRow: 1 レースの人の行", () => {
  it("3 着内は 1、4 着以下は 0。finish <= 3 の境界は 3 着が 1・4 着が 0", () => {
    const row = buildPersonRow(
      record([horse({ finish: 1, jockeyId: "A" }), horse({ finish: 2, jockeyId: "B" }), horse({ finish: 3, jockeyId: "C" }), horse({ finish: 4, jockeyId: "D" })]),
    );
    expect(row).not.toBeNull();
    expect(row!.horses.map((h) => h[2])).toEqual([1, 1, 1, 0]);
    expect(row!.horses).toHaveLength(4); // 前提: 4 頭すべてが数えられている
  });

  it("中止(finish が null)・失格は数える(着外 0)。取消・除外は数えない", () => {
    const row = buildPersonRow(
      record([
        horse({ finish: 1, jockeyId: "A" }),
        horse({ finish: null, finishStatus: "中止", jockeyId: "B" }),
        horse({ finish: null, finishStatus: "失格", jockeyId: "C" }),
        horse({ finish: null, finishStatus: "取消", jockeyId: "D" }),
        horse({ finish: null, finishStatus: "除外", jockeyId: "E" }),
      ]),
    );
    expect(row!.horses.map((h) => [h[0], h[2]])).toEqual([
      ["A", 1],
      ["B", 0],
      ["C", 0],
    ]);
  });

  it("着順の表示が空の馬(finish も finishStatus も null)は走った馬として数える(着外 0)。取消・除外の判定は先頭 1 文字(race-record-to-runs と同じ)", () => {
    const row = buildPersonRow(record([horse({ finish: null, finishStatus: null, jockeyId: "A" }), horse({ finish: null, finishStatus: "取", jockeyId: "B" })]));
    expect(row!.horses.map((h) => h[0])).toEqual(["A"]);
  });

  it("数える馬が 1 頭もないレースは null(印だけ付ける)。1 頭だけでも行は作る(市場の 5 頭条件は引き継がない)", () => {
    expect(buildPersonRow(record([horse({ finish: null, finishStatus: "取消" })]))).toBeNull();
    expect(buildPersonRow(record([]))).toBeNull();
    expect(buildPersonRow(record([horse({ finish: 1 })]))!.horses).toHaveLength(1);
  });

  it("障害のレースも入る。コース情報(競馬場コード・芝ダ障・距離)を持つ。騎手・調教師 ID の null はそのまま持つ", () => {
    const row = buildPersonRow(record([horse({ finish: 2, jockeyId: null, trainerId: "T9" })], { courseType: "障", distance: 3000, venueCode: "08" }));
    expect(row).toEqual({
      raceId: "202506010101",
      raceDate: "2025-06-01",
      venueCode: "08",
      courseType: "障",
      distance: 3000,
      horses: [[null, "T9", 1]],
    } satisfies PersonRow);
  });

  it("中央だけ・2021-01-01 以降だけ。地方と、それより前の日付は null", () => {
    expect(PERSON_STATS_FROM_DATE).toBe("2021-01-01");
    expect(buildPersonRow(record([horse({})], { kind: "nar" }))).toBeNull();
    expect(buildPersonRow(record([horse({})], { date: "2020-12-31" }))).toBeNull();
    expect(buildPersonRow(record([horse({})], { date: "2021-01-01" }))).not.toBeNull();
  });

  it("実ページの取消(result_202606040901。16 頭中 1 頭): 15 頭が数えられ、3 着内は 3 頭", () => {
    const html = readFileSync(pathFromMeta("../../fixtures/result_202606040901.html", import.meta.url), "utf-8");
    const built = buildRaceRecord(html, "202606040901", "central");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.horses).toHaveLength(16); // 前提
    expect(built.record.horses.filter((h) => h.finishStatus === "取消")).toHaveLength(1); // 前提
    const row = buildPersonRow(built.record);
    expect(row).not.toBeNull();
    expect(row!.horses).toHaveLength(15);
    expect(row!.horses.filter((h) => h[2] === 1)).toHaveLength(3);
    expect(row!.venueCode).toBe(built.record.venueCode);
    expect(row!.courseType).toBe(built.record.courseType);
  });
});

describe("encodePersonHorses / decodePersonHorses", () => {
  it("往復で元に戻る。壊れた形は null", () => {
    const horses: PersonRow["horses"] = [
      ["05386", "01200", 1],
      [null, null, 0],
    ];
    expect(decodePersonHorses(encodePersonHorses(horses))).toEqual(horses);
    for (const bad of ["x", "{}", "[[1,2,3]]", '[["a","b",2]]', '[["a","b"]]', '[["a",1,0]]']) {
      expect(decodePersonHorses(bad), bad).toBeNull();
    }
  });
});

describe("aggregatePersonYears: 年ごとの集計", () => {
  const rowOf = (raceId: string, raceDate: string, horses: PersonRow["horses"]): PersonRow => ({ raceId, raceDate, venueCode: "06", courseType: "芝", distance: 1600, horses });

  it("騎手・調教師ごと・年ごとに starts と placed を数える。年をまたいで分ける。ID が null の馬は数えない", () => {
    const out = aggregatePersonYears([
      rowOf("a", "2024-12-28", [["J1", "T1", 1], ["J2", "T1", 0], [null, "T2", 1]]),
      rowOf("b", "2025-01-05", [["J1", "T1", 0], ["J1", "T2", 1]]),
    ]);
    const find = (kind: string, id: string, year: number) => out.find((r) => r.personKind === kind && r.personId === id && r.year === year);
    expect(find("jockey", "J1", 2024)).toMatchObject({ starts: 1, placed: 1 });
    expect(find("jockey", "J1", 2025)).toMatchObject({ starts: 2, placed: 1 }); // 同じ人が同じレースに複数頭
    expect(find("jockey", "J2", 2024)).toMatchObject({ starts: 1, placed: 0 });
    expect(find("trainer", "T1", 2024)).toMatchObject({ starts: 2, placed: 1 });
    expect(find("trainer", "T2", 2024)).toMatchObject({ starts: 1, placed: 1 }); // 騎手 ID が null でも調教師は数える
    expect(find("trainer", "T2", 2025)).toMatchObject({ starts: 1, placed: 1 });
    expect(out.some((r) => r.personId === "null" || r.personId === "")).toBe(false);
    expect(out).toHaveLength(7); // 前提: 騎手 J1(2 年)・J2 と、調教師 T1(2 年)・T2(2 年)
  });

  it("不変条件: どの行も 0 <= placed <= starts。空入力は空", () => {
    const out = aggregatePersonYears([rowOf("a", "2025-01-05", [["J1", "T1", 1], ["J1", "T1", 0], ["J2", "T1", 0]])]);
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(r.placed).toBeGreaterThanOrEqual(0);
      expect(r.placed).toBeLessThanOrEqual(r.starts);
    }
    expect(aggregatePersonYears([])).toEqual([]);
  });
});
