import { describe, expect, it } from "vitest";
import {
  buildConditionFactsIndex,
  DISTANCE_LABELS,
  distanceLabelOf,
  SURFACE_LABELS,
  surfaceLabelOf,
  TRACK_LABELS,
  trackLabelOf,
  type RaceConditionFacts,
} from "../src/verify-race-conditions";
import type { VerifyAnalysisRow } from "../src/verify-read";

/**
 * Issue #389(#385-B の b): 条件別の見える化の 3 軸(距離帯・馬場・芝ダ)の分類。クラスは含めない(#426 のあとに #389-c で足す)。分析の行の生の値(`race-facts.ts` が写したもの)から、行の見出しを決める純関数。
 * 区切り・推定の規則は置き値(根拠のない境界)で、ここが規則の仕様になる。
 */

const NONE: RaceConditionFacts = { courseType: null, distance: null, trackCondition: null };
const facts = (over: Partial<RaceConditionFacts>): RaceConditionFacts => ({ ...NONE, ...over });

// ---------------------------------------------------------------------------
// b1 距離帯
// ---------------------------------------------------------------------------

describe("distanceLabelOf(距離帯: 〜1400m / 1401〜1800m / 1801〜2200m / 2201m〜 / 障害 / 不明)", () => {
  const cases: ReadonlyArray<readonly [string, number, (typeof DISTANCE_LABELS)[number]]> = [
    ["1000m(最短側)", 1000, "〜1400m"],
    ["1400m(境界の下側ちょうど)", 1400, "〜1400m"],
    ["1401m(境界の上側。地方にある 100m 刻みでない距離)", 1401, "1401〜1800m"],
    ["1600m", 1600, "1401〜1800m"],
    ["1800m(境界の下側ちょうど)", 1800, "1401〜1800m"],
    ["1801m(境界の上側)", 1801, "1801〜2200m"],
    ["1870m(地方の実在しうる距離。『1900〜』ではなくこの帯)", 1870, "1801〜2200m"],
    ["2200m(境界の下側ちょうど)", 2200, "1801〜2200m"],
    ["2201m(境界の上側)", 2201, "2201m〜"],
    ["3600m(最長側)", 3600, "2201m〜"],
  ];
  it.each(cases)("芝・ダ共通: %s", (_name, distance, label) => {
    expect(distanceLabelOf(facts({ courseType: "芝", distance }))).toBe(label);
    expect(distanceLabelOf(facts({ courseType: "ダ", distance }))).toBe(label);
    // 芝ダが読めなくても、距離があれば距離帯は決まる
    expect(distanceLabelOf(facts({ distance }))).toBe(label);
  });

  it("障害(course_type が障)は、距離があっても距離帯でなく『障害』の行", () => {
    expect(distanceLabelOf(facts({ courseType: "障", distance: 3000 }))).toBe("障害");
    expect(distanceLabelOf(facts({ courseType: "障", distance: null }))).toBe("障害");
  });

  it("距離が無い・不正(0・負・小数・NaN)・条件の行が無い(null)は『不明』", () => {
    expect(distanceLabelOf(facts({ courseType: "芝", distance: null }))).toBe("不明");
    expect(distanceLabelOf(facts({ distance: 0 }))).toBe("不明");
    expect(distanceLabelOf(facts({ distance: -1200 }))).toBe("不明");
    expect(distanceLabelOf(facts({ distance: 1600.5 }))).toBe("不明");
    expect(distanceLabelOf(facts({ distance: Number.NaN }))).toBe("不明");
    expect(distanceLabelOf(null)).toBe("不明");
  });

  it("『不明』は並びの最後", () => {
    expect(DISTANCE_LABELS[DISTANCE_LABELS.length - 1]).toBe("不明");
  });
});

// ---------------------------------------------------------------------------
// b3 馬場
// ---------------------------------------------------------------------------

describe("trackLabelOf(馬場の正規化: 良 / 稍重 / 重 / 不良 / 未発表・不明)", () => {
  const cases: ReadonlyArray<readonly [string | null, (typeof TRACK_LABELS)[number]]> = [
    ["良", "良"],
    ["稍重", "稍重"],
    ["稍", "稍重"],
    ["重", "重"],
    ["不良", "不良"],
    ["不", "不良"],
    [" 稍重 ", "稍重"],
    [null, "未発表・不明"],
    ["−", "未発表・不明"],
    ["-", "未発表・不明"],
    ["未発表", "未発表・不明"],
    ["", "未発表・不明"],
    ["ぬかるみ", "未発表・不明"],
  ];
  it.each(cases)("%j → %s", (raw, label) => {
    expect(trackLabelOf(facts({ trackCondition: raw }))).toBe(label);
  });

  it("条件の行が無い(null)は『未発表・不明』。『重』は『稍重』『不良』と取り違えない", () => {
    expect(trackLabelOf(null)).toBe("未発表・不明");
    expect(new Set(["良", "稍重", "重", "不良"].map((v) => trackLabelOf(facts({ trackCondition: v })))).size).toBe(4);
  });

  it("『未発表・不明』は並びの最後", () => {
    expect(TRACK_LABELS[TRACK_LABELS.length - 1]).toBe("未発表・不明");
  });
});

// ---------------------------------------------------------------------------
// b4 芝ダ
// ---------------------------------------------------------------------------

describe("surfaceLabelOf(芝 / ダ / 障害 / 不明)", () => {
  it("4 つの行に分かれる", () => {
    expect(surfaceLabelOf(facts({ courseType: "芝" }))).toBe("芝");
    expect(surfaceLabelOf(facts({ courseType: "ダ" }))).toBe("ダ");
    expect(surfaceLabelOf(facts({ courseType: "障" }))).toBe("障害");
    expect(surfaceLabelOf(facts({ courseType: null }))).toBe("不明");
    expect(surfaceLabelOf(null)).toBe("不明");
    expect([...SURFACE_LABELS]).toEqual(["芝", "ダ", "障害", "不明"]);
  });
});

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

function row(id: number, over: Partial<VerifyAnalysisRow> = {}): VerifyAnalysisRow {
  return {
    id, raceId: "202606030811", analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45", ...over,
  };
}

describe("buildConditionFactsIndex(分析の行 → 条件の索引)", () => {
  it("読めた行(cond_read=1)の生の値を分析 id で引ける", () => {
    const index = buildConditionFactsIndex([row(1, { courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "毎日王冠", condRead: 1 })]);
    expect(index.get(1)).toEqual({ courseType: "芝", distance: 1600, trackCondition: "稍" }); // grade・raceName は(クラスを出さない間は)索引に持たない
  });

  it("★読めなかった行(cond_read=0)は、列に値があっても条件なし(null)。確認前(NULL)も条件なし", () => {
    const index = buildConditionFactsIndex([
      row(1, { courseType: "芝", distance: 1600, condRead: 0 }),
      row(2, { courseType: "芝", distance: 1600, condRead: null }),
    ]);
    expect(index.get(1)).toBeNull();
    expect(index.get(2)).toBeNull();
    expect(index.has(1)).toBe(true);
  });

  it("条件の列を持たない行(既存の固定データ。cond_read も無い)は、全項目 null の事実(= 全軸が不明になる)", () => {
    expect(buildConditionFactsIndex([row(1)]).get(1)).toEqual(NONE);
  });

  it("cond_read=1 でも列が NULL の項目は null のまま(スナップショットに無かった)", () => {
    expect(buildConditionFactsIndex([row(1, { courseType: "ダ", distance: null, trackCondition: null, condRead: 1 })]).get(1)).toEqual({ ...NONE, courseType: "ダ" });
  });
});
