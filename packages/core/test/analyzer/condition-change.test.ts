/**
 * 条件替わり(妙味材料)判定の純関数テスト。
 * サーフェス替わり・距離延長/短縮・中央⇄地方替わりを、境界値・欠損スキップ・並び順を含む
 * テーブル駆動で固定する(2026-07-19 boss着手前ゲート合意仕様)。
 */

import { describe, expect, it } from "vitest";
import {
  computeConditionChangeTags,
  DISTANCE_CHANGE_LOOKBACK_RUNS,
  DISTANCE_CHANGE_THRESHOLD_METERS,
  type ConditionChangeInput,
  type ConditionChangeRun,
} from "../../src/analyzer/condition-change.js";

/** 条件なし(全項目null)の過去走。欠損スキップ系テストの基礎データに使う。 */
function emptyRun(): ConditionChangeRun {
  return { courseType: null, distance: null, venueKind: null };
}

function run(overrides: Partial<ConditionChangeRun>): ConditionChangeRun {
  return { ...emptyRun(), ...overrides };
}

function baseInput(overrides: Partial<ConditionChangeInput> = {}): ConditionChangeInput {
  return {
    currentCourseType: "芝",
    currentDistance: 1600,
    currentVenueKind: "central",
    pastRuns: [],
    ...overrides,
  };
}

describe("computeConditionChangeTags(定数)", () => {
  it("距離替わり専用の遡り窓は3であること(脚質recentRunsとは独立の名前付き定数)", () => {
    expect(DISTANCE_CHANGE_LOOKBACK_RUNS).toBe(3);
  });

  it("距離延長/短縮の閾値は400mであること", () => {
    expect(DISTANCE_CHANGE_THRESHOLD_METERS).toBe(400);
  });
});

describe("computeConditionChangeTags(新馬・欠損の基本挙動)", () => {
  it("新馬(過去走0)は全タグなしで空配列を返すこと", () => {
    const tags = computeConditionChangeTags(baseInput({ pastRuns: [] }));
    expect(tags).toEqual([]);
  });

  it("過去走はあるが全項目欠損(courseType/distance/venueKindすべてnull)でも例外にせず空配列を返すこと", () => {
    const tags = computeConditionChangeTags(
      baseInput({ pastRuns: [emptyRun(), emptyRun()] }),
    );
    expect(tags).toEqual([]);
  });

  it("currentVenueKind未指定なら開催替わりタグの判定だけをスキップし、他タグ判定には影響しないこと", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentVenueKind: undefined,
        currentCourseType: "ダ",
        pastRuns: [run({ courseType: "芝", venueKind: "地方" })],
      }),
    );
    // サーフェス替わり(芝→ダ)は判定されるが、開催替わりは currentVenueKind 欠損でタグなし。
    expect(tags.map((t) => t.kind)).toEqual(["surface"]);
  });
});

describe("computeConditionChangeTags(サーフェス替わり)", () => {
  it("前走が異なるサーフェス(芝→ダ)なら「ダ替わり(前走芝)」を返すこと(ダート経験ありなので強い語にしない)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "ダ",
        // 前走(芝)の他にダート経験(older)を持たせ、enrichment(初ダート)が誤発火しないことも兼ねて確認する。
        pastRuns: [run({ courseType: "芝" }), run({ courseType: "ダ" })],
      }),
    );
    expect(tags).toEqual([{ kind: "surface", label: "ダ替わり(前走芝)" }]);
  });

  it("前走が異なるサーフェス(ダ→芝)なら「芝替わり(前走ダ)」を返すこと(芝経験ありなので強い語にしない)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "芝",
        // 前走(ダ)の他に芝経験(older)を持たせ、enrichment(初芝)が誤発火しないことも兼ねて確認する。
        pastRuns: [run({ courseType: "ダ" }), run({ courseType: "芝" })],
      }),
    );
    expect(tags).toEqual([{ kind: "surface", label: "芝替わり(前走ダ)" }]);
  });

  it("前走が同じサーフェスならサーフェスタグを付けないこと", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "芝",
        pastRuns: [run({ courseType: "芝" })],
      }),
    );
    expect(tags).toEqual([]);
  });

  it("前走が障害でもスキップしてさらに前の芝/ダ走まで遡ること", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "ダ",
        pastRuns: [
          run({ courseType: "障" }),
          run({ courseType: "芝" }),
          run({ courseType: "ダ" }), // ダート経験ありにし、enrichmentの誤発火を避ける。
        ],
      }),
    );
    expect(tags).toEqual([{ kind: "surface", label: "ダ替わり(前走芝)" }]);
  });

  it("有効な芝/ダ走が過去に1つも無ければサーフェスタグを付けないこと(障のみ)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "ダ",
        pastRuns: [run({ courseType: "障" }), emptyRun()],
      }),
    );
    expect(tags).toEqual([]);
  });

  it("現レースが障ならサーフェスタグ自体を出さないこと(前走が芝/ダで替わりに見えても)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "障",
        pastRuns: [run({ courseType: "芝" })],
      }),
    );
    expect(tags).toEqual([]);
  });
});

describe("computeConditionChangeTags(サーフェスenrichment: 初ダート/初芝)", () => {
  it("ダート替わり かつ 過去にダート経験が0なら「初ダート」と強い語にすること", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "ダ",
        pastRuns: [run({ courseType: "芝" }), run({ courseType: "芝" })],
      }),
    );
    expect(tags).toEqual([{ kind: "surface", label: "初ダート" }]);
  });

  it("芝替わり かつ 過去に芝経験が0なら「初芝」と強い語にすること", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "芝",
        pastRuns: [run({ courseType: "ダ" }), run({ courseType: "ダ" })],
      }),
    );
    expect(tags).toEqual([{ kind: "surface", label: "初芝" }]);
  });

  it("ダート替わりだが過去にダート経験があれば通常の「ダ替わり(前走芝)」のままにすること(強い語にしない)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "ダ",
        pastRuns: [
          run({ courseType: "芝" }), // 前走
          run({ courseType: "ダ" }), // 過去にダート経験あり
        ],
      }),
    );
    expect(tags).toEqual([{ kind: "surface", label: "ダ替わり(前走芝)" }]);
  });

  it("経験の有無は直近走の遡りだけでなく pastRuns 全体(古い走含む)で判定すること", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "ダ",
        pastRuns: [
          run({ courseType: "障" }), // 遡りではスキップされる
          run({ courseType: "芝" }), // 前走(直近有効走)
          run({ courseType: "ダ" }), // かなり古いがダート経験あり
        ],
      }),
    );
    expect(tags).toEqual([{ kind: "surface", label: "ダ替わり(前走芝)" }]);
  });
});

describe("computeConditionChangeTags(距離延長/短縮)", () => {
  it("差の絶対値が400m未満(399m)なら距離タグを付けないこと", () => {
    const tags = computeConditionChangeTags(
      baseInput({ currentDistance: 1999, pastRuns: [run({ distance: 1600 })] }),
    );
    expect(tags).toEqual([]);
  });

  it("差の絶対値がちょうど400mなら延長/短縮と判定すること(400ちょうどを含む)", () => {
    const tags = computeConditionChangeTags(
      baseInput({ currentDistance: 2000, pastRuns: [run({ distance: 1600 })] }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+400m)" },
    ]);
  });

  it("平均より400m以上短ければ距離短縮と判定すること", () => {
    const tags = computeConditionChangeTags(
      baseInput({ currentDistance: 1200, pastRuns: [run({ distance: 1600 })] }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離短縮(平均比-400m)" },
    ]);
  });

  it("有効走を最大3件集めて平均すること(3件で判定・非整数平均は実差をMath.roundで整数mに丸める)", () => {
    // 平均 = (1600+1700+1800)/3 = 1700 ちょうど。現距離2200 → 差+500。
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2200,
        pastRuns: [
          run({ distance: 1600 }),
          run({ distance: 1700 }),
          run({ distance: 1800 }),
        ],
      }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+500m)" },
    ]);
  });

  it("非整数平均になる場合、閾値比較は生平均で行い、表示差はMath.round丸めであること", () => {
    // 平均 = (1600+1700+2000)/3 = 1766.666...。現距離2000 → 生差 = 233.333...(閾値未満のため距離タグなし)。
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2000,
        pastRuns: [
          run({ distance: 1600 }),
          run({ distance: 1700 }),
          run({ distance: 2000 }),
        ],
      }),
    );
    expect(tags).toEqual([]);
  });

  it("非整数平均かつ閾値以上のとき、実差表示はMath.roundで整数mに丸めること", () => {
    // 平均 = (1400+1500+1500)/3 = 1466.666...。現距離2000 → 生差 = 533.333... → round(533.333)=533。
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2000,
        pastRuns: [
          run({ distance: 1400 }),
          run({ distance: 1500 }),
          run({ distance: 1500 }),
        ],
      }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+533m)" },
    ]);
  });

  it("4件目以降の有効走は窓(最大3件)に含めないこと", () => {
    // 直近3件の平均 = (1600+1600+1600)/3 = 1600。4件目(1200m)は無視されるため差は+400のまま。
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2000,
        pastRuns: [
          run({ distance: 1600 }),
          run({ distance: 1600 }),
          run({ distance: 1600 }),
          run({ distance: 1200 }), // 窓の外(4件目)
        ],
      }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+400m)" },
    ]);
  });

  it("障害走は距離平均の対象から除外してスキップすること", () => {
    // 障(2400m)を除外し、有効走(1600m)のみで平均する。
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2000,
        pastRuns: [
          run({ courseType: "障", distance: 2400 }),
          run({ courseType: "芝", distance: 1600 }),
        ],
      }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+400m)" },
    ]);
  });

  it("海外走は距離平均の対象から除外してスキップすること", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2000,
        pastRuns: [
          run({ courseType: "芝", distance: 2400, venueKind: "海外" }),
          run({ courseType: "芝", distance: 1600, venueKind: "中央" }),
        ],
      }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+400m)" },
    ]);
  });

  it("距離欠損(distance=null)の走はスキップすること", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2000,
        pastRuns: [run({ distance: null }), run({ distance: 1600 })],
      }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+400m)" },
    ]);
  });

  it("対象走(有効走)が1件も無ければ距離タグを付けないこと", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentDistance: 2000,
        pastRuns: [
          run({ courseType: "障", distance: 2400 }),
          run({ distance: null }),
        ],
      }),
    );
    expect(tags).toEqual([]);
  });

  it("有効走が1件だけでもその1件で平均(=その値そのもの)して判定すること", () => {
    const tags = computeConditionChangeTags(
      baseInput({ currentDistance: 2000, pastRuns: [run({ distance: 1600 })] }),
    );
    expect(tags).toEqual([
      { kind: "distance", label: "距離延長(平均比+400m)" },
    ]);
  });
});

describe("computeConditionChangeTags(中央⇄地方替わり: venueKind語彙吸収)", () => {
  it("前走地方(地方)・現在central なら「地方→中央」を返すこと(nar↔地方マッピング)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentVenueKind: "central",
        pastRuns: [run({ venueKind: "地方" })],
      }),
    );
    expect(tags).toEqual([{ kind: "venue", label: "地方→中央" }]);
  });

  it("前走中央・現在nar なら「中央→地方」を返すこと(central↔中央マッピング)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentVenueKind: "nar",
        pastRuns: [run({ venueKind: "中央" })],
      }),
    );
    expect(tags).toEqual([{ kind: "venue", label: "中央→地方" }]);
  });

  it("前走と現在の開催区分が同じなら開催タグを付けないこと", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentVenueKind: "central",
        pastRuns: [run({ venueKind: "中央" })],
      }),
    );
    expect(tags).toEqual([]);
  });

  it("前走が海外ならスキップしてさらに前の国内走まで遡ること(比較不能な海外走を飛ばす)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentVenueKind: "central",
        pastRuns: [run({ venueKind: "海外" }), run({ venueKind: "地方" })],
      }),
    );
    expect(tags).toEqual([{ kind: "venue", label: "地方→中央" }]);
  });

  it("国内走が過去に1つも無ければ開催タグを付けないこと(海外走のみ)", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentVenueKind: "central",
        pastRuns: [run({ venueKind: "海外" }), emptyRun()],
      }),
    );
    expect(tags).toEqual([]);
  });
});

describe("computeConditionChangeTags(複数タグの並び順固定)", () => {
  it("サーフェス・距離・開催のすべてが該当する場合、サーフェス→距離→開催の順で返すこと", () => {
    const tags = computeConditionChangeTags(
      baseInput({
        currentCourseType: "ダ",
        currentDistance: 2400,
        currentVenueKind: "central",
        pastRuns: [
          run({ courseType: "芝", distance: 2000, venueKind: "地方" }),
          run({ courseType: "ダ", distance: 2000, venueKind: "地方" }), // ダート経験ありなので通常表記
        ],
      }),
    );
    expect(tags.map((t) => t.kind)).toEqual(["surface", "distance", "venue"]);
    expect(tags).toEqual([
      { kind: "surface", label: "ダ替わり(前走芝)" },
      { kind: "distance", label: "距離延長(平均比+400m)" },
      { kind: "venue", label: "地方→中央" },
    ]);
  });
});
