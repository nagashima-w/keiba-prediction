/**
 * #653: 市場が見落としやすい条件の定義(`scripts/market-blindspots-653/conditions.ts`)のテスト。
 * 定義は docs/investigations/market-blindspots-653/plan.md と一致させる。対象外(null)と該当しない(false)の区別も固定する。
 */
import { describe, expect, it } from "vitest";
import {
  CONDITION_IDS,
  classFromName,
  evaluateConditions,
  styleAverage,
  type HorseContext,
  type PrevRun,
} from "../market-blindspots-653/conditions.js";

const prev = (o: Partial<PrevRun> = {}): PrevRun => ({
  date: "2025-01-01",
  raceId: "p1",
  venueName: "東京",
  courseType: "芝",
  distance: 1600,
  going: "良",
  raceClass: 1,
  n: 16,
  finish: 6,
  pos4: 8,
  last3fRank: null,
  marginSec: 1,
  jockeyId: "J1",
  jockeyMark: null,
  markKnown: true,
  trainerId: "T1",
  trainerKnown: true,
  ninki: 5,
  jEdge: null,
  ...o,
});

const ctx = (o: Partial<HorseContext> = {}): HorseContext => ({
  date: "2025-03-01",
  courseType: "芝",
  distance: 1600,
  going: "良",
  direction: "左",
  venueName: "東京",
  raceClass: 1,
  n: 16,
  month: 3,
  spans: [],
  sex: "牡",
  age: 4,
  wakuban: 4,
  jockeyId: "J1",
  jockeyMark: null,
  trainerId: "T1",
  jEdge: null,
  bodyWeightDiff: 0,
  oddsRank: 5,
  worstOddsRank: false,
  prev: prev(),
  daysSince: 59,
  priorRunCount: 5,
  ranAtVenue: true,
  style: null,
  trends: {},
  ...o,
});

describe("classFromName", () => {
  it.each([
    ["2歳新馬", 0],
    ["3歳未勝利", 0],
    ["3歳以上1勝クラス", 1],
    ["4歳以上2勝クラス", 2],
    ["3歳以上3勝クラス", 3],
    ["東京スポーツ杯2歳S(GIII)", 4],
    ["オープン", 4],
    ["ジャパンC(GI)", 4],
    ["3歳以上500万下", 1],
    ["3歳以上1000万下", 2],
    ["3歳以上1600万下", 3],
    ["謎のレース", null],
  ])("%s は %s", (name, expected) => {
    expect(classFromName(name)).toBe(expected);
  });
});

describe("styleAverage", () => {
  it("通過順が分かる走が 3 走未満なら null", () => {
    expect(styleAverage([{ pos4: 1, n: 10 }, { pos4: 2, n: 10 }])).toBeNull();
  });
  it("直近 5 走の 4 コーナー通過順 ÷ 頭数 の平均(新しい順に渡す)", () => {
    const runs = [1, 2, 3, 4, 5, 10].map((p) => ({ pos4: p, n: 10 }));
    // 直近 5 走 = 1..5。(1+2+3+4+5)/5/10 = 0.3。6 走目は使わない
    expect(styleAverage(runs)).toBeCloseTo(0.3, 10);
  });
  it("通過順が欠けた走は数えない", () => {
    const runs = [{ pos4: null, n: 10 }, { pos4: 5, n: 10 }, { pos4: 5, n: 10 }, { pos4: 5, n: 10 }];
    expect(styleAverage(runs)).toBeCloseTo(0.5, 10);
  });
});

describe("条件の一覧", () => {
  it("計画の 59 個(T は主の版 T1〜T11)", () => {
    expect(CONDITION_IDS).toHaveLength(59);
    expect(new Set(CONDITION_IDS).size).toBe(59);
  });
  it("evaluateConditions はすべての ID を返す", () => {
    expect(Object.keys(evaluateConditions(ctx())).sort()).toEqual([...CONDITION_IDS].sort());
  });
});

describe("前走(P)", () => {
  const cases: Array<[string, string, Partial<HorseContext>, boolean | null]> = [
    ["P1 該当", "P1", { prev: prev({ pos4: 12, n: 16, last3fRank: 2, finish: 7 }) }, true],
    ["P1 上がり 4 位は外れ", "P1", { prev: prev({ pos4: 12, n: 16, last3fRank: 4, finish: 7 }) }, false],
    ["P1 上がり順位が不明なら対象外", "P1", { prev: prev({ pos4: 12, n: 16, last3fRank: null, finish: 7 }) }, null],
    ["P1 前走が 3 着なら外れ", "P1", { prev: prev({ pos4: 12, n: 16, last3fRank: 1, finish: 3 }) }, false],
    ["P1 前走 7 頭立ては対象外", "P1", { prev: prev({ pos4: 6, n: 7, last3fRank: 1, finish: 6 }) }, null],
    ["P1 前走なしは対象外", "P1", { prev: null, daysSince: null }, null],
    ["P1 4角ちょうど 2/3 は外れ(> 2/3)", "P1", { prev: prev({ pos4: 12, n: 18, last3fRank: 1, finish: 7 }) }, false],
    ["P2 該当(境界 1/3)", "P2", { prev: prev({ pos4: 6, n: 18, finish: 4 }) }, true],
    ["P2 1/3 を超えれば外れ", "P2", { prev: prev({ pos4: 7, n: 18, finish: 4 }) }, false],
    ["P2 3 着は外れ", "P2", { prev: prev({ pos4: 2, n: 18, finish: 3 }) }, false],
    ["P3 該当", "P3", { prev: prev({ marginSec: 0.5, finish: 10, n: 16 }) }, true],
    ["P3 差 0.6 は外れ", "P3", { prev: prev({ marginSec: 0.6, finish: 10, n: 16 }) }, false],
    ["P3 着順が頭数のちょうど半分は外れ(> 0.5)", "P3", { prev: prev({ marginSec: 0.3, finish: 8, n: 16 }) }, false],
    ["P4 2.0 秒で該当", "P4", { prev: prev({ marginSec: 2.0 }) }, true],
    ["P4 1.9 秒は外れ", "P4", { prev: prev({ marginSec: 1.9 }) }, false],
    ["P4 差が不明は対象外", "P4", { prev: prev({ marginSec: null }) }, null],
    ["P5 上がり 1 位で 4 着", "P5", { prev: prev({ last3fRank: 1, finish: 4 }) }, true],
    ["P5 3 着は外れ", "P5", { prev: prev({ last3fRank: 1, finish: 3 }) }, false],
    ["P6 前走重・今回良", "P6", { prev: prev({ going: "重" }), going: "良" }, true],
    ["P6 前走稍重は外れ", "P6", { prev: prev({ going: "稍重" }), going: "良" }, false],
    ["P7 前走良・今回稍重", "P7", { prev: prev({ going: "良" }), going: "稍重" }, true],
    ["P7 今回も良は外れ", "P7", { prev: prev({ going: "良" }), going: "良" }, false],
    ["P8 前走 1 着", "P8", { prev: prev({ finish: 1 }) }, true],
    ["P8 前走中止(着順なし)は外れ", "P8", { prev: prev({ finish: null }) }, false],
  ];
  it.each(cases)("%s", (_n, id, o, expected) => {
    expect(evaluateConditions(ctx(o))[id]).toBe(expected);
  });
});

describe("条件の替わり(K)", () => {
  const cases: Array<[string, string, Partial<HorseContext>, boolean | null]> = [
    ["K1 昇級", "K1", { raceClass: 2, prev: prev({ raceClass: 1 }) }, true],
    ["K1 同級は外れ", "K1", { raceClass: 1, prev: prev({ raceClass: 1 }) }, false],
    ["K1 前走のクラス不明は対象外", "K1", { raceClass: 1, prev: prev({ raceClass: null }) }, null],
    ["K2 降級", "K2", { raceClass: 0, prev: prev({ raceClass: 1 }) }, true],
    ["K3 昇級かつ前走 1 着", "K3", { raceClass: 2, prev: prev({ raceClass: 1, finish: 1 }) }, true],
    ["K3 昇級でも前走 2 着は外れ", "K3", { raceClass: 2, prev: prev({ raceClass: 1, finish: 2 }) }, false],
    ["K4 延長ちょうど +400m", "K4", { distance: 2000, prev: prev({ distance: 1600 }) }, true],
    ["K4 +200m は外れ", "K4", { distance: 1800, prev: prev({ distance: 1600 }) }, false],
    ["K5 短縮ちょうど −400m", "K5", { distance: 1200, prev: prev({ distance: 1600 }) }, true],
    ["K6 芝→ダ", "K6", { courseType: "ダ", prev: prev({ courseType: "芝" }) }, true],
    ["K7 ダ→芝", "K7", { courseType: "芝", prev: prev({ courseType: "ダ" }) }, true],
    ["K7 芝→芝は外れ", "K7", { courseType: "芝", prev: prev({ courseType: "芝" }) }, false],
    ["K8 初めての競馬場(過去 3 走以上)", "K8", { ranAtVenue: false, priorRunCount: 3 }, true],
    ["K8 過去 2 走なら対象外", "K8", { ranAtVenue: false, priorRunCount: 2 }, null],
    ["K8 走ったことがあれば外れ", "K8", { ranAtVenue: true, priorRunCount: 8 }, false],
    ["K9 右→左", "K9", { direction: "左", prev: prev({ venueName: "中山" }) }, true],
    ["K9 左→左は外れ", "K9", { direction: "左", prev: prev({ venueName: "東京" }) }, false],
    ["K9 地方の前走は対象外", "K9", { direction: "左", prev: prev({ venueName: "大井" }) }, null],
  ];
  it.each(cases)("%s", (_n, id, o, expected) => {
    expect(evaluateConditions(ctx(o))[id]).toBe(expected);
  });
});

describe("人(J)・体(W)・間隔(I)", () => {
  const cases: Array<[string, string, Partial<HorseContext>, boolean | null]> = [
    ["J1 乗り替わり", "J1", { jockeyId: "J2" }, true],
    ["J1 継続は外れ", "J1", { jockeyId: "J1" }, false],
    ["J2 乗り替わりで見習いへ", "J2", { jockeyId: "J2", jockeyMark: "▲" }, true],
    ["J2 乗り替わりでも見習いでなければ外れ", "J2", { jockeyId: "J2", jockeyMark: null }, false],
    ["J3 見習いから非見習いへ", "J3", { jockeyId: "J2", prev: prev({ jockeyMark: "☆" }) }, true],
    ["J3 前走の印が不明なら対象外", "J3", { jockeyId: "J2", prev: prev({ markKnown: false }) }, null],
    ["J4 調教師替わり", "J4", { trainerId: "T2" }, true],
    ["J4 前走の調教師が不明なら対象外", "J4", { trainerId: "T2", prev: prev({ trainerKnown: false }) }, null],
    ["J5 騎手の指標が +0.02 以上上がる", "J5", { jockeyId: "J2", jEdge: 0.03, prev: prev({ jEdge: 0.01 }) }, true],
    ["J5 +0.019 は外れ", "J5", { jockeyId: "J2", jEdge: 0.029, prev: prev({ jEdge: 0.01 }) }, false],
    ["J6 −0.02 以下", "J6", { jockeyId: "J2", jEdge: -0.01, prev: prev({ jEdge: 0.01 }) }, true],
    ["J5 乗り替わりでなければ外れ", "J5", { jockeyId: "J1", jEdge: 0.05, prev: prev({ jEdge: 0.01 }) }, false],
    ["J7 見習い騎乗", "J7", { jockeyMark: "△" }, true],
    ["W1 +10kg", "W1", { bodyWeightDiff: 10 }, true],
    ["W1 +9kg は外れ", "W1", { bodyWeightDiff: 9 }, false],
    ["W2 −10kg", "W2", { bodyWeightDiff: -10 }, true],
    ["W1 増減が不明なら対象外", "W1", { bodyWeightDiff: null }, null],
    ["W3 +10kg かつ休み明け", "W3", { bodyWeightDiff: 12, daysSince: 120 }, true],
    ["W3 休み明けでなければ外れ", "W3", { bodyWeightDiff: 12, daysSince: 119 }, false],
    ["W4 −10kg かつ休み明け", "W4", { bodyWeightDiff: -12, daysSince: 200 }, true],
    ["I1 120 日", "I1", { daysSince: 120 }, true],
    ["I1 119 日は外れ", "I1", { daysSince: 119 }, false],
    ["I1 前走なしは対象外", "I1", { prev: null, daysSince: null }, null],
    ["I2 休み明けの未勝利", "I2", { daysSince: 130, raceClass: 0 }, true],
    ["I3 休み明けの 3 勝クラス", "I3", { daysSince: 130, raceClass: 3 }, true],
    ["I3 2 勝クラスは外れ", "I3", { daysSince: 130, raceClass: 2 }, false],
    ["I4 休み明けの牝", "I4", { daysSince: 130, sex: "牝" }, true],
    ["I5 休み明けの 5 歳", "I5", { daysSince: 130, age: 5 }, true],
    ["I6 連闘(7 日)", "I6", { daysSince: 7 }, true],
    ["I6 8 日は外れ", "I6", { daysSince: 8 }, false],
    ["I7 中 1 週(8 日)", "I7", { daysSince: 8 }, true],
    ["I7 14 日", "I7", { daysSince: 14 }, true],
    ["I7 15 日は外れ", "I7", { daysSince: 15 }, false],
    ["I9 休み明けで前走 3 着", "I9", { daysSince: 150, prev: prev({ finish: 3 }) }, true],
    ["I9 前走 4 着は外れ", "I9", { daysSince: 150, prev: prev({ finish: 4 }) }, false],
  ];
  it.each(cases)("%s", (_n, id, o, expected) => {
    expect(evaluateConditions(ctx(o))[id]).toBe(expected);
  });
});

describe("季節・性・齢(S)とレースの形(F)", () => {
  const cases: Array<[string, string, Partial<HorseContext>, boolean | null]> = [
    ["S1 7 月の牝", "S1", { month: 7, sex: "牝" }, true],
    ["S1 9 月は外れ", "S1", { month: 9, sex: "牝" }, false],
    ["S2 2 歳", "S2", { age: 2 }, true],
    ["S3 3 歳の春の未勝利", "S3", { age: 3, month: 5, raceClass: 0 }, true],
    ["S3 6 月は外れ", "S3", { age: 3, month: 6, raceClass: 0 }, false],
    ["S4 3 歳馬が 3 歳以上戦(秋)", "S4", { age: 3, month: 10, spans: ["サラ系３歳以上", "1勝クラス"] }, true],
    ["S4 3 歳限定戦は外れ", "S4", { age: 3, month: 10, spans: ["サラ系３歳"] }, false],
    ["S4 5 月は外れ", "S4", { age: 3, month: 5, spans: ["サラ系３歳以上"] }, false],
    ["S5 セン馬", "S5", { sex: "セ" }, true],
    ["S6 7 歳以上", "S6", { age: 7 }, true],
    ["S6 6 歳は外れ", "S6", { age: 6 }, false],
    ["F1 1 番人気", "F1", { oddsRank: 1 }, true],
    ["F2 14 頭以上の最低人気", "F2", { n: 14, worstOddsRank: true }, true],
    ["F2 13 頭は外れ", "F2", { n: 13, worstOddsRank: true }, false],
    ["F3 16 頭の 2 枠", "F3", { n: 16, wakuban: 2 }, true],
    ["F3 15 頭は外れ", "F3", { n: 15, wakuban: 2 }, false],
    ["F4 16 頭の 7 枠", "F4", { n: 16, wakuban: 7 }, true],
    ["F5 先行・内枠・1400m", "F5", { style: 0.33, wakuban: 3, distance: 1400 }, true],
    ["F5 脚質が不明なら対象外", "F5", { style: null, wakuban: 3, distance: 1400 }, null],
    ["F5 1600m は外れ", "F5", { style: 0.2, wakuban: 3, distance: 1600 }, false],
    ["F6 追込・ダート・1200m", "F6", { style: 0.6, courseType: "ダ", distance: 1200 }, true],
    ["F6 芝は外れ", "F6", { style: 0.7, courseType: "芝", distance: 1200 }, false],
  ];
  it.each(cases)("%s", (_n, id, o, expected) => {
    expect(evaluateConditions(ctx(o))[id]).toBe(expected);
  });
});

describe("その日の馬場の傾向(T)", () => {
  const t = (o: object) => ({ m60: { df: null, di: null, shift: null, ...o } });
  const cases: Array<[string, string, Partial<HorseContext>, boolean | null]> = [
    ["T1 前残りの日の先行馬", "T1", { style: 0.2, trends: t({ df: 0.1 }) }, true],
    ["T1 Δf 0.09 は外れ", "T1", { style: 0.2, trends: t({ df: 0.09 }) }, false],
    ["T1 その日の傾向が不明(対象外)なら対象外", "T1", { style: 0.2, trends: t({ df: null }) }, null],
    ["T1 脚質が不明なら対象外", "T1", { style: null, trends: t({ df: 0.2 }) }, null],
    ["T2 前残りの日の差し馬", "T2", { style: 0.6, trends: t({ df: 0.15 }) }, true],
    ["T3 差し有利の日の先行馬", "T3", { style: 0.3, trends: t({ df: -0.1 }) }, true],
    ["T4 差し有利の日の差し馬", "T4", { style: 0.8, trends: t({ df: -0.2 }) }, true],
    ["T5 内有利の日の内枠", "T5", { wakuban: 2, trends: t({ di: 0.12 }) }, true],
    ["T5 Δi 0.11 は外れ", "T5", { wakuban: 2, trends: t({ di: 0.11 }) }, false],
    ["T6 内有利の日の外枠", "T6", { wakuban: 7, trends: t({ di: 0.2 }) }, true],
    ["T7 外有利の日の外枠", "T7", { wakuban: 8, trends: t({ di: -0.12 }) }, true],
    ["T8 外有利の日の内枠", "T8", { wakuban: 1, trends: t({ di: -0.3 }) }, true],
    ["T9 重い方へ変わった", "T9", { trends: t({ shift: "heavier" }) }, true],
    ["T9 変わらなければ外れ", "T9", { trends: t({ shift: "same" }) }, false],
    ["T9 先のレースが無ければ対象外", "T9", { trends: t({ shift: null }) }, null],
    ["T10 軽い方へ変わった", "T10", { trends: t({ shift: "lighter" }) }, true],
    ["T11 変わった日の先行馬", "T11", { style: 0.1, trends: t({ shift: "lighter" }) }, true],
    ["T11 変わった日でも差し馬は外れ", "T11", { style: 0.8, trends: t({ shift: "lighter" }) }, false],
  ];
  it.each(cases)("%s", (_n, id, o, expected) => {
    expect(evaluateConditions(ctx(o))[id]).toBe(expected);
  });
  it("40 分版・すべて版は、別名(_m40・_any)で同じ定義を評価する", () => {
    const r = evaluateConditions(ctx({ style: 0.2, trends: { m60: { df: 0.2, di: null, shift: null }, m40: { df: -0.2, di: null, shift: null }, any: { df: 0.0, di: null, shift: null } } }), true);
    expect(r.T1).toBe(true);
    expect(r.T1_m40).toBe(false);
    expect(r.T3_m40).toBe(true);
    expect(r.T1_any).toBe(false);
  });
});
