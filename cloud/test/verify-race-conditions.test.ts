import { describe, expect, it } from "vitest";
import {
  axisLabelsOf,
  buildConditionFactsIndex,
  CLASS_LABELS,
  classLabelOf,
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
 * Issue #389(#385-B の b・c): 条件別の見える化の 4 軸(距離帯・馬場・芝ダ・クラス)の分類。分析の行の生の値(`race-facts.ts` が写したもの。クラスは #426 が保存した `race_class`)から、行の見出しを決める純関数。
 * 区切り・推定の規則は置き値(根拠のない境界)で、ここが規則の仕様になる。
 */

const NONE: RaceConditionFacts = { courseType: null, distance: null, trackCondition: null, raceClass: null };
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
    const index = buildConditionFactsIndex([row(1, { courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "毎日王冠", raceClass: "オープン", condRead: 1 })]);
    expect(index.get(1)).toEqual({ courseType: "芝", distance: 1600, trackCondition: "稍", raceClass: "オープン" }); // grade・raceName は索引に持たない(クラスは正確な race_class だけを使う)
  });

  it("★読めなかった行(cond_read=0)は、列に値があっても芝ダ・距離・馬場は null。確認前(NULL)も同じ", () => {
    const index = buildConditionFactsIndex([
      row(1, { courseType: "芝", distance: 1600, trackCondition: "良", condRead: 0 }),
      row(2, { courseType: "芝", distance: 1600, trackCondition: "良", condRead: null }),
    ]);
    expect(index.get(1)).toEqual(NONE);
    expect(index.get(2)).toEqual(NONE);
    expect(index.has(1)).toBe(true);
  });

  it("★クラスは cond_read と独立: 読めなかった行(0)・確認前(NULL)でも race_class は残る(結果の取り込みと補完は、スナップショットが読めなくてもクラスを書く)", () => {
    const index = buildConditionFactsIndex([
      row(1, { courseType: "芝", distance: 1600, raceClass: "2勝クラス", condRead: 0 }),
      row(2, { raceClass: "未勝利", condRead: null }),
      row(3, { raceClass: "新馬", condRead: 1 }),
    ]);
    expect(index.get(1)).toEqual({ ...NONE, raceClass: "2勝クラス" }); // 芝・1600 は捨て、クラスは残す
    expect(index.get(2)).toEqual({ ...NONE, raceClass: "未勝利" });
    expect(index.get(3)).toEqual({ ...NONE, raceClass: "新馬" });
  });

  it("条件の列を持たない行(既存の固定データ。cond_read も race_class も無い)は、全項目 null の事実(= 全軸が不明になる)", () => {
    expect(buildConditionFactsIndex([row(1)]).get(1)).toEqual(NONE);
  });

  it("cond_read=1 でも列が NULL の項目は null のまま(スナップショットに無かった)", () => {
    expect(buildConditionFactsIndex([row(1, { courseType: "ダ", distance: null, trackCondition: null, condRead: 1 })]).get(1)).toEqual({ ...NONE, courseType: "ダ" });
  });
});

// ---------------------------------------------------------------------------
// クラス(Issue #389-c)
// ---------------------------------------------------------------------------

describe("classLabelOf(クラス: 新馬 / 未勝利 / 1勝クラス / 2勝クラス / 3勝クラス / オープン / 地方(対象外) / 不明)", () => {
  it("見出しの並び: 中央の 6 つの正準ラベルの順、地方(対象外)、不明が最後", () => {
    expect([...CLASS_LABELS]).toEqual(["新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン", "地方(対象外)", "不明"]);
  });

  const central: ReadonlyArray<readonly [string, string | null, (typeof CLASS_LABELS)[number]]> = [
    ["新馬", "新馬", "新馬"],
    ["未勝利", "未勝利", "未勝利"],
    ["1勝クラス", "1勝クラス", "1勝クラス"],
    ["2勝クラス", "2勝クラス", "2勝クラス"],
    ["3勝クラス", "3勝クラス", "3勝クラス"],
    ["オープン", "オープン", "オープン"],
    ["全角数字・前後の空白は正規化して照合する", " １勝クラス ", "1勝クラス"],
    ["全角数字(3勝)", "３勝クラス", "3勝クラス"],
    ["NULL(未確認・読めなかった)は不明", null, "不明"],
    ["空文字は不明", "", "不明"],
    ["語彙に無い表記(部分一致しない: 1勝)は不明", "1勝", "不明"],
    ["語彙に無い表記(オープン特別)は不明", "オープン特別", "不明"],
    ["旧表記(500万下)は不明", "500万下", "不明"],
    ["地方の区分のトークン(C2)が中央のレースに入っていても不明(推測で中央の行に入れない)", "C2", "不明"],
  ];
  it.each(central)("中央: %s", (_name, raw, label) => {
    expect(classLabelOf(facts({ raceClass: raw }), "central")).toBe(label);
  });

  it("★行ごとに別の見出しになる(取り違えない): 6 つの正準ラベルは互いに別の行", () => {
    const labels = ["新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン"].map((v) => classLabelOf(facts({ raceClass: v }), "central"));
    expect(new Set(labels).size).toBe(6);
  });

  it("地方のレースは、race_class の値(C1・B2B3・3歳・NULL)に依らず『地方(対象外)』の 1 行。中央のラベルが入っていても地方の行", () => {
    for (const raw of ["C1", "B2B3", "3歳", "C2七", null, "オープン"]) {
      expect(classLabelOf(facts({ raceClass: raw }), "nar"), String(raw)).toBe("地方(対象外)");
    }
    expect(classLabelOf(null, "nar")).toBe("地方(対象外)");
  });

  it("開催区分が判定できない race_id(kind が null)は、race_class があっても不明。条件の行が無い(null)中央は不明", () => {
    expect(classLabelOf(facts({ raceClass: "未勝利" }), null)).toBe("不明");
    expect(classLabelOf(null, "central")).toBe("不明");
    expect(classLabelOf(null, null)).toBe("不明");
  });

  it("axisLabelsOf: 4 軸の見出しをまとめて返す(クラスは開催区分を受け取る)", () => {
    const f = facts({ courseType: "芝", distance: 1600, trackCondition: "良", raceClass: "1勝クラス" });
    expect(axisLabelsOf(f, "central")).toEqual({ distance: "1401〜1800m", track: "良", surface: "芝", class: "1勝クラス" });
    expect(axisLabelsOf(f, "nar")).toEqual({ distance: "1401〜1800m", track: "良", surface: "芝", class: "地方(対象外)" });
    expect(axisLabelsOf(null, "central")).toEqual({ distance: "不明", track: "未発表・不明", surface: "不明", class: "不明" });
  });
});
