/**
 * #664: #663 の条件を学習モデルの特徴量にする定義(`scripts/stat-features-664/features.ts`)のテスト。
 * 定義は docs/investigations/stat-features-664/plan.md §2 と一致させる。前走なし・障害の前走・欠けの扱いも固定する。
 */
import { describe, expect, it } from "vitest";
import { FLAG_NAMES, buildFeatureRows, computeFlags, daysBetween, isForeignName, type CurInfo, type RunInfo } from "../stat-features-664/features.js";
import type { RaceRecord, RecordHorse } from "../../packages/core/src/scraper/race-record.js";

const cur = (o: Partial<CurInfo> = {}): CurInfo => ({
  date: "2025-06-01", venueName: "東京", courseType: "芝", distance: 1600, sex: "牡", age: 4, bodyWeight: 480,
  trainerArea: "美浦", jockeyId: "J1", jockeyName: "田中", ...o,
});
const prev = (o: Partial<RunInfo> = {}): RunInfo => ({
  date: "2025-05-04", courseType: "芝", distance: 1600, finish: 3, pos4: 5, jockeyId: "J1", ...o,
});

describe("daysBetween", () => {
  it.each([
    ["2025-05-04", "2025-06-01", 28],
    ["2024-12-28", "2025-01-04", 7],
    ["2024-02-28", "2024-03-01", 2], // 閏年
  ])("%s → %s は %i 日", (a, b, d) => expect(daysBetween(a, b)).toBe(d));
});

describe("isForeignName(カタカナだけの騎手名)", () => {
  it.each([
    ["ルメー", true], ["レーン", true], ["ディー", true], ["Ｍデム", true], ["Ｍ．デ", true], ["Ｃ．ル", true], ["Ａルメ", true], ["Ｈドイ", true],
    ["田中", false], ["鮫島駿", false], ["", false], [null, false], ["Aルメ", false], ["Ｍ", false], ["Ｍ田中", false],
  ])(
    "%s → %s", (n, e) => expect(isForeignName(n as string | null)).toBe(e));
});

describe("computeFlags: 前走なし", () => {
  it("前走が無いとき noprev=1 で、前走を使う旗はすべて 0", () => {
    const f = computeFlags(cur(), null);
    expect(f.noprev).toBe(1);
    for (const k of ["turf2dirt", "dirt2turf", "rest180", "mid1w", "distUp400", "foreignJC", "foreignJCnoLemaire", "foreignJCnoLD", "gain4"] as const) expect(f[k]).toBe(0);
  });
  it("前走があれば noprev=0", () => expect(computeFlags(cur(), prev()).noprev).toBe(0));
});

describe("computeFlags: 芝ダ替わり", () => {
  it("芝→ダ", () => { const f = computeFlags(cur({ courseType: "ダ" }), prev({ courseType: "芝" })); expect([f.turf2dirt, f.dirt2turf]).toEqual([1, 0]); });
  it("ダ→芝", () => { const f = computeFlags(cur({ courseType: "芝" }), prev({ courseType: "ダ" })); expect([f.turf2dirt, f.dirt2turf]).toEqual([0, 1]); });
  it("同じ面は 0", () => { const f = computeFlags(cur({ courseType: "芝" }), prev({ courseType: "芝" })); expect([f.turf2dirt, f.dirt2turf]).toEqual([0, 0]); });
  it("前走が障害なら芝ダ替わり・距離の差・押し上げは 0(日数は出す)", () => {
    const f = computeFlags(cur({ courseType: "ダ", distance: 2400, date: "2025-12-01" }), prev({ courseType: "障", distance: 1200, finish: 10, pos4: 20, date: "2025-05-04" }));
    expect([f.turf2dirt, f.dirt2turf, f.distUp400, f.gain4]).toEqual([0, 0, 0, 0]);
    expect(f.rest180).toBe(1);
  });
});

describe("computeFlags: 日数(境界)", () => {
  it.each([
    [7, 0, 0], [8, 1, 0], [14, 1, 0], [15, 0, 0], [179, 0, 0], [180, 0, 1], [181, 0, 1],
  ])("前走から %i 日 → mid1w=%i rest180=%i", (d, mid, rest) => {
    const start = Date.UTC(2025, 0, 1) + d * 86400000;
    const date = new Date(start).toISOString().slice(0, 10);
    const f = computeFlags(cur({ date }), prev({ date: "2025-01-01" }));
    expect([f.mid1w, f.rest180]).toEqual([mid, rest]);
  });
});

describe("computeFlags: 距離延長(境界)", () => {
  it.each([[1999, 1600, 0], [2000, 1600, 1], [2400, 1600, 1], [1200, 1600, 0]])("今走 %i 前走 %i → %i", (cd, pd, e) =>
    expect(computeFlags(cur({ distance: cd }), prev({ distance: pd })).distUp400).toBe(e));
});

describe("computeFlags: 牝馬・7歳以上・馬体重", () => {
  it("牝は 1・牡とセンは 0", () => {
    expect(computeFlags(cur({ sex: "牝" }), null).filly).toBe(1);
    expect(computeFlags(cur({ sex: "牡" }), null).filly).toBe(0);
    expect(computeFlags(cur({ sex: "セ" }), null).filly).toBe(0);
  });
  it.each([[6, 0], [7, 1], [10, 1]])("%i 歳 → %i", (a, e) => expect(computeFlags(cur({ age: a }), null).age7).toBe(e));
  it("年齢が欠けていれば 0", () => expect(computeFlags(cur({ age: null }), null).age7).toBe(0));
  it.each([[418, 1, 0], [420, 0, 0], [500, 0, 0], [518, 0, 0], [520, 0, 1], [540, 0, 1]])("馬体重 %i → light=%i heavy=%i", (w, l, h) => {
    const f = computeFlags(cur({ bodyWeight: w }), null);
    expect([f.wLight, f.wHeavy]).toEqual([l, h]);
  });
  it("馬体重が欠けていれば両方 0", () => { const f = computeFlags(cur({ bodyWeight: null }), null); expect([f.wLight, f.wHeavy]).toEqual([0, 0]); });
});

describe("computeFlags: 厩舎の東西 × 場の東西", () => {
  it.each([
    ["美浦", "京都", 1, 0], ["美浦", "阪神", 1, 0], ["美浦", "中京", 1, 0], ["美浦", "小倉", 1, 0],
    ["美浦", "東京", 0, 0], ["美浦", "札幌", 0, 0], ["美浦", "函館", 0, 0],
    ["栗東", "東京", 0, 1], ["栗東", "中山", 0, 1], ["栗東", "新潟", 0, 1], ["栗東", "福島", 0, 1],
    ["栗東", "京都", 0, 0], ["栗東", "札幌", 0, 0], ["地方", "東京", 0, 0], [null, "京都", 0, 0],
  ])("%s の馬が %s で走る → 関東馬の関西遠征=%i 関西馬の関東遠征=%i", (area, venue, e, w) => {
    const f = computeFlags(cur({ trainerArea: area, venueName: venue }), null);
    expect([f.eastInWest, f.westInEast]).toEqual([e, w]);
  });
});

describe("computeFlags: 外国人騎手への乗り替わり", () => {
  it("カタカナ名で前走と騎手が違えば 1", () => expect(computeFlags(cur({ jockeyId: "F1", jockeyName: "レーン" }), prev({ jockeyId: "J1" })).foreignJC).toBe(1));
  it("前走も同じ騎手なら乗り替わりではない", () => expect(computeFlags(cur({ jockeyId: "F1", jockeyName: "レーン" }), prev({ jockeyId: "F1" })).foreignJC).toBe(0));
  it("日本人騎手への乗り替わりは 0", () => expect(computeFlags(cur({ jockeyId: "J2", jockeyName: "田中" }), prev({ jockeyId: "J1" })).foreignJC).toBe(0));
  it("前走の騎手IDが無ければ乗り替わりは判定できず 0", () => expect(computeFlags(cur({ jockeyId: "F1", jockeyName: "レーン" }), prev({ jockeyId: null })).foreignJC).toBe(0));
  it("Ｍデムは名前がカタカナだけでなくても外国人(jockeyId 05212)", () =>
    expect(computeFlags(cur({ jockeyId: "05212", jockeyName: "Ｍデム" }), prev({ jockeyId: "J1" })).foreignJC).toBe(1));
  it("ルメール(05339)は foreignJC=1 だが、ルメール除きの版・ルメールとＭデムーロ除きの版は 0", () => {
    const f = computeFlags(cur({ jockeyId: "05339", jockeyName: "ルメー" }), prev({ jockeyId: "J1" }));
    expect([f.foreignJC, f.foreignJCnoLemaire, f.foreignJCnoLD]).toEqual([1, 0, 0]);
  });
  it("名前が「Ｃ．ル」でも jockeyId 05339 ならルメール", () =>
    expect(computeFlags(cur({ jockeyId: "05339", jockeyName: "Ｃ．ル" }), prev({ jockeyId: "J1" })).foreignJCnoLemaire).toBe(0));
  it("Ｍデムーロ(05212)は、ルメール除きでは 1、ルメールとＭデムーロ除きでは 0", () => {
    const f = computeFlags(cur({ jockeyId: "05212", jockeyName: "Ｍデム" }), prev({ jockeyId: "J1" }));
    expect([f.foreignJC, f.foreignJCnoLemaire, f.foreignJCnoLD]).toEqual([1, 1, 0]);
  });
  it("弟のＣデムーロ(05473。短期免許)は、ルメールとＭデムーロ除きの版でも 1(兄だけを ID で除く)", () => {
    const f = computeFlags(cur({ jockeyId: "05473", jockeyName: "Ｃデム" }), prev({ jockeyId: "J1" }));
    expect([f.foreignJC, f.foreignJCnoLemaire, f.foreignJCnoLD]).toEqual([1, 1, 1]);
  });
  it("Ａルメ(05659。ルメールではない)と、その他の外国人は、どの版でも 1", () => {
    for (const [id, nm] of [["05659", "Ａルメ"], ["05585", "レーン"]] as const) {
      const f = computeFlags(cur({ jockeyId: id, jockeyName: nm }), prev({ jockeyId: "J1" }));
      expect([f.foreignJC, f.foreignJCnoLemaire, f.foreignJCnoLD]).toEqual([1, 1, 1]);
    }
  });
});

describe("computeFlags: 前走で 4 角から押し上げ", () => {
  it.each([[10, 5, 1], [10, 6, 0], [9, 3, 1], [4, 1, 0]])("4角 %i 番手 → %i 着なら gain4=%i", (p4, fin, e) => {
    expect(computeFlags(cur(), prev({ pos4: p4, finish: fin })).gain4).toBe(e);
  });
  it("着順か通過順が欠けていれば 0", () => {
    expect(computeFlags(cur(), prev({ pos4: null, finish: 1 })).gain4).toBe(0);
    expect(computeFlags(cur(), prev({ pos4: 12, finish: null })).gain4).toBe(0);
  });
});

const horse = (o: Partial<RecordHorse>): RecordHorse => ({
  umaban: 1, wakuban: 1, finish: 1, finishStatus: null, finishDemoted: false, finishRaw: "1", horseId: "H1", horseName: "x",
  sexAgeRaw: null, sex: "牡", age: 4, burden: 55, jockeyId: "J1", jockeyName: "田中", jockeyMark: null, timeRaw: null, timeSec: null,
  marginRaw: null, ninki: 1, winOdds: 2, last3f: null, passing: [3, 3, 3, 3], trainerId: "T1", trainerName: "t", trainerArea: "美浦",
  bodyWeight: 480, bodyWeightRaw: null, bodyWeightDiff: 0, bodyWeightDiffRaw: null, cellsAligned: true, ...o,
}) as RecordHorse;
const race = (o: Record<string, unknown>, horses: RecordHorse[]): RaceRecord =>
  ({ raceId: "r", date: "2025-05-04", venueName: "東京", courseType: "芝", distance: 1600, horses, ...o }) as unknown as RaceRecord;

describe("buildFeatureRows: 時間順の走査", () => {
  it("初出走は noprev=1、2走目は前走を引く。取消・除外の馬は戦績に入れない。障害のレースにも行を出し(fit.py が障害を除かないため)、戦績にも入れる", () => {
    const recs = [
      race({ raceId: "r3", date: "2025-12-01", courseType: "ダ", distance: 2000 }, [horse({ umaban: 1, horseId: "H1" })]),
      race({ raceId: "r1", date: "2025-05-04" }, [horse({ umaban: 1, horseId: "H1", passing: [10, 10, 10, 9], finish: 3 }), horse({ umaban: 2, horseId: "H2", finishStatus: "取消", finish: null })]),
      race({ raceId: "r2", date: "2025-06-01", courseType: "障", distance: 3000 }, [horse({ umaban: 1, horseId: "H1" })]),
    ];
    const rows = buildFeatureRows(recs);
    const key = (id: string, u: number) => rows.find((r) => r.raceId === id && r.umaban === u)!;
    expect(key("r1", 1).noprev).toBe(1);
    expect(key("r2", 1).noprev).toBe(0); // 障害のレースの行もある。前走は r1(芝・平地)
    expect([key("r2", 1).turf2dirt, key("r2", 1).dirt2turf, key("r2", 1).distUp400]).toEqual([0, 0, 1]); // 今走が障害なら芝ダ替わりは 0。距離は 3000−1600
    expect(rows.find((r) => r.raceId === "r1" && r.umaban === 2)).toBeUndefined(); // 取消の馬の行は出さない
    expect(key("r3", 1).noprev).toBe(0);
    expect(key("r3", 1).rest180).toBe(1); // 前走は r2(障害)の 2025-06-01 で、183 日 → 180 日以上
  });
  it("FLAG_NAMES は旗の全部で、行に過不足なく入る", () => {
    const rows = buildFeatureRows([race({ raceId: "r1" }, [horse({})])]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["raceId", "umaban", ...FLAG_NAMES].sort());
  });
});
