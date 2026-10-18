/**
 * タイム指数(Issue #353〈#274-B〉)の単体テスト。
 *
 * 1走の指数 = (基準 + 馬場の補正 × 距離km − タイム) ÷ 距離km(基準より 1000m あたり何秒速いか)。
 * 馬の代表値 = 指数が出せた走のうち新しい順に 5 つの最高。
 * 特徴量 = 代表値 − レース内の中央値(値のある馬が 2 頭以上のとき。中央値は昇順の floor(n/2) 番目)を ±5 で打ち切る。値のない馬は 0。
 *
 * ここでは**差し込んだ小さな表**(丸い数字)で、手計算した期待値を固定する。本番の表そのものの検査は standard-times.test.ts。
 */

import { describe, expect, it } from "vitest";
import {
  TIME_INDEX_CLIP,
  TIME_INDEX_RECENT_RUNS,
  classifyTimeIndexCondition,
  computeFieldTimeIndexContributions,
  horseTimeIndex,
  parseRaceTimeSec,
  runTimeIndex,
} from "../../src/scorer/time-index.js";
import type { StandardTimeTable } from "../../src/scorer/standard-times.js";
import type { HorseRaceResult } from "../../src/scraper/types.js";
import { makeResult, rank, venue } from "./helpers.js";

/** 丸い数字の差し込み表。中山の芝 1600 は基準 96.0 秒、東京のダ 1400 は基準 85.0 秒。 */
const TABLE: StandardTimeTable = {
  standards: {
    "中山|芝|1600": { median: 96, n: 100 },
    "東京|ダ|1400": { median: 85, n: 100 },
  },
  offsets: {
    "芝|良": { median: 0, n: 100 },
    "芝|稍重": { median: 0.5, n: 100 },
    "芝|重・不良": { median: 1, n: 100 },
    "ダ|良": { median: 0, n: 100 },
    "ダ|稍重": { median: -0.5, n: 100 },
    "ダ|重・不良": { median: -1, n: 100 },
  },
};

/** 中山の芝 1600m・良・中央・1着の走(指数が出せる最小構成)。overrides で 1 項目ずつ崩す。 */
function run(overrides: Partial<HorseRaceResult> = {}): HorseRaceResult {
  return makeResult({
    date: "2026/01/01",
    venue: venue("中山"),
    venueKind: "中央",
    courseType: "芝",
    distance: 1600,
    trackCondition: "良",
    time: "1:35.0",
    finishPosition: rank(1),
    ...overrides,
  });
}

describe("parseRaceTimeSec(タイムの読み取り)", () => {
  it.each([
    ["1:35.0", 95],
    ["1:45.9", 105.9],
    ["0:57.8", 57.8],
    ["2:30.1", 150.1],
    [" 1:35.0 ", 95],
  ])("%s → %s 秒", (text, sec) => {
    expect(parseRaceTimeSec(text)).toBeCloseTo(sec, 10);
  });

  it.each([[null], [""], ["95.0"], ["1:35"], ["1:5.0"], ["abc"], ["1:35.00"]])(
    "読めない形(%s)は null",
    (text) => {
      expect(parseRaceTimeSec(text)).toBeNull();
    },
  );
});

describe("classifyTimeIndexCondition(馬場の3区分)", () => {
  it.each([
    ["良", "良"],
    ["稍", "稍重"],
    ["稍重", "稍重"],
    ["重", "重・不良"],
    ["不", "重・不良"],
    ["不良", "重・不良"],
  ] as const)("%s → %s", (text, expected) => {
    expect(classifyTimeIndexCondition(text)).toBe(expected);
  });

  it.each([[null], [""], ["未"], ["良好"], ["晴"]])("想定外の値(%s)は対象外(null)", (text) => {
    expect(classifyTimeIndexCondition(text)).toBeNull();
  });
});

describe("runTimeIndex(1走の指数)", () => {
  it("良: (96.0 + 0×1.6 − 95.0) ÷ 1.6 = 0.625", () => {
    expect(runTimeIndex(run(), TABLE)).toBeCloseTo(0.625, 10);
  });

  it("稍と稍重は同じ区分: (96.0 + 0.5×1.6 − 96.0) ÷ 1.6 = 0.5", () => {
    expect(runTimeIndex(run({ trackCondition: "稍", time: "1:36.0" }), TABLE)).toBeCloseTo(0.5, 10);
    expect(runTimeIndex(run({ trackCondition: "稍重", time: "1:36.0" }), TABLE)).toBeCloseTo(0.5, 10);
  });

  it("重・不良: (96.0 + 1×1.6 − 97.2) ÷ 1.6 = 0.25(重・不・不良は同じ区分)", () => {
    for (const tc of ["重", "不", "不良"]) {
      expect(runTimeIndex(run({ trackCondition: tc, time: "1:37.2" }), TABLE)).toBeCloseTo(0.25, 10);
    }
  });

  it("ダートは別の基準と補正: 東京ダ 1400・稍重・タイム 1:24.0 → (85.0 − 0.5×1.4 − 84.0) ÷ 1.4", () => {
    const r = run({ venue: venue("東京"), courseType: "ダ", distance: 1400, trackCondition: "稍重", time: "1:24.0" });
    expect(runTimeIndex(r, TABLE)).toBeCloseTo((85 - 0.5 * 1.4 - 84) / 1.4, 10);
  });

  it("基準より遅ければ負になる: 1:37.6 → (96.0 − 97.6) ÷ 1.6 = −1.0", () => {
    expect(runTimeIndex(run({ time: "1:37.6" }), TABLE)).toBeCloseTo(-1, 10);
  });

  // 出せない走(いずれも、他の項目は出せる状態のまま 1 項目だけ崩す)。
  it.each<[string, Partial<HorseRaceResult>]>([
    ["地方の走", { venueKind: "地方" }],
    ["海外の走", { venueKind: "海外" }],
    ["着順が非数値(中止)", { finishPosition: { kind: "非数値", text: "中" } }],
    ["着順なし", { finishPosition: null }],
    ["タイムなし", { time: null }],
    ["タイムが読めない", { time: "abc" }],
    ["馬場なし", { trackCondition: null }],
    ["馬場が想定外の値", { trackCondition: "未" }],
    ["基準のない距離(区分なし)", { distance: 1800 }],
    ["基準のない競馬場", { venue: venue("札幌") }],
    ["障害(障)の走", { courseType: "障" }],
    ["コース種別なし", { courseType: null }],
    ["距離なし", { distance: null }],
    ["距離 0", { distance: 0 }],
    ["会場なし", { venue: null }],
    ["会場名なし", { venue: { round: null, name: null, day: null, raw: "" } }],
  ])("出せない: %s → null", (_name, overrides) => {
    // 前提: 崩す前の走は指数が出せる(崩した項目だけが原因であることを固定する)。
    expect(runTimeIndex(run(), TABLE)).not.toBeNull();
    expect(runTimeIndex(run(overrides), TABLE)).toBeNull();
  });

  it("馬場の補正が表に無い区分なら null(想定外を 0 で埋めない)", () => {
    const noOffset: StandardTimeTable = { standards: TABLE.standards, offsets: {} };
    expect(runTimeIndex(run(), noOffset)).toBeNull();
  });
});

describe("horseTimeIndex(馬の代表値 = 近5走の最高)", () => {
  /** 中山の芝 1600・良で、指定した指数になるタイム(秒)の走。タイム = 96.0 − 指数 × 1.6。 */
  const withIndex = (idx: number): HorseRaceResult => {
    const sec = 96 - idx * 1.6;
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(1).padStart(4, "0");
    return run({ time: `${m}:${s}` });
  };

  it("「最高」は最新でも最古でもない走を選ぶ(新しい順 [0, −1, 0.625, 0, −1])→ 0.625、使った走は 5", () => {
    const results = [withIndex(0), withIndex(-1), withIndex(0.625), withIndex(0), withIndex(-1)];
    const r = horseTimeIndex(results, TABLE);
    expect(r).not.toBeNull();
    expect(r!.value).toBeCloseTo(0.625, 10);
    expect(r!.runs).toBe(5);
  });

  it("指数が出せない走は数に入れない: 先頭の地方走は枠を使わず、指数が出せた走の 5 つ目まで見る", () => {
    // 新しい順: [地方(出せない), 0, −1, 0.625, 0, −1, 3.5(指数が出せた走の 6 つ目 = 対象外)]
    const results = [
      run({ venueKind: "地方" }),
      withIndex(0),
      withIndex(-1),
      withIndex(0.625),
      withIndex(0),
      withIndex(-1),
      withIndex(3.5),
    ];
    const r = horseTimeIndex(results, TABLE);
    expect(TIME_INDEX_RECENT_RUNS).toBe(5);
    expect(r!.value).toBeCloseTo(0.625, 10); // 6 つ目の 3.5 は入らない。
    expect(r!.runs).toBe(5);
  });

  it("5 走未満でも出る(指数が出せた走が 2 つ → その最高、runs は 2)", () => {
    const r = horseTimeIndex([withIndex(-1), withIndex(0.25)], TABLE);
    expect(r!.value).toBeCloseTo(0.25, 10);
    expect(r!.runs).toBe(2);
  });

  it("最高が負でもそのまま(すべて基準より遅い馬は負の代表値)", () => {
    const r = horseTimeIndex([withIndex(-2), withIndex(-1)], TABLE);
    expect(r!.value).toBeCloseTo(-1, 10);
  });

  it("指数が出せる走が 1 つもなければ null / 戦績なしも null", () => {
    expect(horseTimeIndex([run({ venueKind: "地方" }), run({ time: null })], TABLE)).toBeNull();
    expect(horseTimeIndex([], TABLE)).toBeNull();
  });
});

describe("computeFieldTimeIndexContributions(特徴量と寄与度)", () => {
  const W = 0.12;
  const CTX = { venueKind: "central", courseType: "芝", weight: W } as const;
  /** 指数が idx になる走 1 つだけの戦績。 */
  const one = (idx: number): HorseRaceResult[] => {
    const sec = 96 - idx * 1.6;
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(1).padStart(4, "0");
    return [run({ time: `${m}:${s}` })];
  };
  const none: HorseRaceResult[] = [run({ venueKind: "地方" })];

  it("値のある馬が 2 頭: 中央値は昇順の floor(2/2)=1 番目(大きいほう) → 上位の馬は 0、下位の馬は差がそのまま補正", () => {
    const cs = computeFieldTimeIndexContributions([one(1), one(0.5), none], CTX, TABLE);
    expect(cs).toHaveLength(3);
    expect(cs[0]!.biasName).toBe("タイム指数");
    expect(cs[0]!.applied).toBe(true);
    expect(cs[0]!.correction).toBeCloseTo(0, 12); // 1.0 − 中央値 1.0
    expect(cs[1]!.applied).toBe(true);
    expect(cs[1]!.correction).toBeCloseTo(W * (0.5 - 1.0), 12);
    expect(cs[1]!.weight).toBe(W);
    expect(cs[1]!.targetRate).toBeCloseTo(0.5, 10); // 馬の代表値
    expect(cs[1]!.overallRate).toBeCloseTo(1.0, 10); // レース内の中央値
    expect(cs[1]!.sampleCount).toBe(1);
    // 値のない馬は 0 で、適用されない。
    expect(cs[2]!.applied).toBe(false);
    expect(cs[2]!.correction).toBe(0);
    expect(cs[2]!.sampleCount).toBe(0);
  });

  it("値のある馬が 4 頭: 中央値は昇順 [−1, 0, 1, 3] の floor(4/2)=2 番目 = 1。補正は w×(代表値−1)", () => {
    const cs = computeFieldTimeIndexContributions([one(3), one(-1), one(1), one(0)], CTX, TABLE);
    const expected = [3 - 1, -1 - 1, 1 - 1, 0 - 1].map((d) => W * d);
    cs.forEach((c, i) => {
      expect(c.applied).toBe(true);
      expect(c.correction).toBeCloseTo(expected[i]!, 12);
      expect(c.overallRate).toBeCloseTo(1, 10);
    });
  });

  it("±5 で打ち切る: 差が +7 の馬は +5、−8 の馬は −5(打ち切りの内側はそのまま)", () => {
    // 値 [7, 0, 0, −8] → 昇順 [−8, 0, 0, 7]、中央値は index 2 = 0。
    const cs = computeFieldTimeIndexContributions([one(7), one(0), one(0), one(-8)], CTX, TABLE);
    expect(TIME_INDEX_CLIP).toBe(5);
    expect(cs[0]!.correction).toBeCloseTo(W * 5, 12);
    expect(cs[1]!.correction).toBeCloseTo(0, 12);
    expect(cs[3]!.correction).toBeCloseTo(W * -5, 12);
    // 打ち切りの内側: 差 +4.5 はそのまま。
    const inner = computeFieldTimeIndexContributions([one(4.5), one(0), one(0)], CTX, TABLE);
    expect(inner[0]!.correction).toBeCloseTo(W * 4.5, 12);
  });

  it("値のある馬が 1 頭だけなら全頭 0(補正なし)", () => {
    const cs = computeFieldTimeIndexContributions([one(2), none, none], CTX, TABLE);
    for (const c of cs) {
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
    }
    expect(cs[0]!.reason).toContain("2頭未満");
  });

  it("値のある馬が 0 頭なら全頭 0", () => {
    const cs = computeFieldTimeIndexContributions([none, none, none], CTX, TABLE);
    expect(cs.map((c) => c.correction)).toEqual([0, 0, 0]);
    expect(cs.every((c) => !c.applied)).toBe(true);
  });

  it("全馬の値が同じなら全馬 0(全馬同一データ → 全馬同一 prior を保つ)", () => {
    const cs = computeFieldTimeIndexContributions([one(1.5), one(1.5), one(1.5)], CTX, TABLE);
    for (const c of cs) {
      expect(c.applied).toBe(true);
      expect(c.correction).toBeCloseTo(0, 12);
    }
  });

  it("重み 0 なら補正は 0(寄与度は残る)", () => {
    const cs = computeFieldTimeIndexContributions([one(3), one(0), one(0)], { ...CTX, weight: 0 }, TABLE);
    expect(cs.every((c) => c.correction === 0)).toBe(true);
    expect(cs[0]!.applied).toBe(true);
    expect(cs[0]!.weight).toBe(0);
  });

  it("地方のレースは全頭 0・applied:false・「NARのため対象外」(値のある馬が何頭いても)", () => {
    const cs = computeFieldTimeIndexContributions([one(3), one(0), one(1)], { ...CTX, venueKind: "nar" }, TABLE);
    for (const c of cs) {
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
      expect(c.reason).toBe("NARのため対象外");
    }
  });

  it("今回のレースが障害なら全頭 0・applied:false・「障害のため対象外」", () => {
    const cs = computeFieldTimeIndexContributions([one(3), one(0), one(1)], { ...CTX, courseType: "障" }, TABLE);
    for (const c of cs) {
      expect(c.applied).toBe(false);
      expect(c.correction).toBe(0);
      expect(c.reason).toBe("障害のため対象外");
    }
  });

  it("頭数 0 は空配列", () => {
    expect(computeFieldTimeIndexContributions([], CTX, TABLE)).toEqual([]);
  });
});
