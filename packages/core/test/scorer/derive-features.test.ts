import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import type {
  FinishPosition,
  HorseRaceResult,
} from "../../src/scraper/types.js";
import {
  REST_MIN_DAYS,
  SHORT_ROTATION_MAX_DAYS,
  classifyFrameZone,
  classifyRotationInterval,
  classifySeason,
  classifyTrackWetness,
  daysBetweenDates,
  deriveRaceFeatures,
  isPlaced,
} from "../../src/scorer/derive-features.js";

/** フィクスチャ(JSON文字列)を読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 着順(順位)を組み立てる小ヘルパ。 */
function rank(value: number, demoted?: boolean): FinishPosition {
  return demoted ? { kind: "順位", value, demoted } : { kind: "順位", value };
}

describe("isPlaced(複勝圏判定)", () => {
  it.each([
    [1, true],
    [2, true],
    [3, true],
    [4, false],
    [5, false],
    [18, false],
  ])("順位%i着は判定=placed:%s になること", (value, placed) => {
    expect(isPlaced(rank(value))).toEqual({ kind: "判定", placed });
  });

  it("着順3着/4着の境界(3=複勝圏内、4=圏外)を正しく判定すること", () => {
    expect(isPlaced(rank(3))).toEqual({ kind: "判定", placed: true });
    expect(isPlaced(rank(4))).toEqual({ kind: "判定", placed: false });
  });

  it("降着で確定3着(3(降))も複勝圏内(placed:true)として扱うこと", () => {
    expect(isPlaced(rank(3, true))).toEqual({ kind: "判定", placed: true });
  });

  it.each([["中止"], ["除外"], ["取消"], ["失格"]])(
    "非数値着順「%s」は判定ではなく集計対象外(kind:対象外)になること",
    (text) => {
      const finish: FinishPosition = { kind: "非数値", text };
      expect(isPlaced(finish)).toEqual({
        kind: "対象外",
        reason: "非数値着順",
      });
    },
  );

  it("着順が null(欠損)の場合も集計対象外になること", () => {
    expect(isPlaced(null)).toEqual({ kind: "対象外", reason: "着順欠損" });
  });

  it("対象外は placed:false と型で区別できること(混同しない)", () => {
    const 圏外 = isPlaced(rank(4));
    const 対象外 = isPlaced({ kind: "非数値", text: "中止" });
    expect(圏外.kind).toBe("判定");
    expect(対象外.kind).toBe("対象外");
    // 「圏外(placed:false)」と「対象外」は別物であること。
    expect(圏外).not.toEqual(対象外);
  });
});

describe("採用したレース間隔の境界定義", () => {
  it("連闘〜中3週の上限は28日、休み明けの下限は71日であること", () => {
    // 中N週 ⇔ 日数差 ≈ 7×(N+1)日(競馬慣行)。式 N=floor((d-1)/7)。
    // 中3週の最大=28日(=7×4)、中10週の最小=71日(=7×10+1)。
    expect(SHORT_ROTATION_MAX_DAYS).toBe(28);
    expect(REST_MIN_DAYS).toBe(71);
  });
});

describe("classifyRotationInterval(レース間隔の3分類)", () => {
  it.each([
    // 連闘〜中3週(1〜28日)
    [1, "連闘〜中3週"],
    [7, "連闘〜中3週"], // 連闘(中0週)
    [14, "連闘〜中3週"], // 中1週
    [21, "連闘〜中3週"], // 中2週
    [28, "連闘〜中3週"], // 中3週(=7×4、上限)
    // 中4〜9週(29〜70日)
    [29, "中4〜9週"], // 中4週の下限(28/29境界)
    [35, "中4〜9週"], // 中4週(=7×5)
    [41, "中4〜9週"],
    [70, "中4〜9週"], // 中9週(=7×10、上限)
    // 休み明け(71日以上)
    [71, "休み明け"], // 中10週の下限(70/71境界)
    [77, "休み明け"], // 中10週(≈7×11)
    [78, "休み明け"],
    [200, "休み明け"],
  ])("日数差%i日は「%s」に分類されること", (days, expected) => {
    expect(classifyRotationInterval(days)).toBe(expected);
  });

  it("中3週/中4週の境界(28日=連闘〜中3週、29日=中4〜9週)", () => {
    expect(classifyRotationInterval(28)).toBe("連闘〜中3週");
    expect(classifyRotationInterval(29)).toBe("中4〜9週");
  });

  it("中9週/休み明け(中10週)の境界(70日=中4〜9週、71日=休み明け)", () => {
    expect(classifyRotationInterval(70)).toBe("中4〜9週");
    expect(classifyRotationInterval(71)).toBe("休み明け");
  });

  it("日数差が null(前走なし・日付欠損)のときは「不明」になること", () => {
    expect(classifyRotationInterval(null)).toBe("不明");
  });

  it.each([[-1], [-10]])(
    "日数差が負(契約違反: %i日)のときは「不明」を返すこと",
    (days) => {
      expect(classifyRotationInterval(days)).toBe("不明");
    },
  );
});

describe("daysBetweenDates(日付文字列の日数差)", () => {
  it.each([
    ["2026/06/21", "2026/06/28", 7],
    ["2026/04/11", "2026/06/28", 78],
    ["2026/03/21", "2026/04/11", 21],
    ["2026/02/08", "2026/03/21", 41],
    ["2026/06/28", "2026/06/28", 0],
    // うるう年(2024年)の2月跨ぎ: 2/28→3/1 は 2/29 を挟むため2日。
    ["2024/02/28", "2024/03/01", 2],
    // 非うるう年(2026年)の2月跨ぎ: 2/28→3/1 は1日。
    ["2026/02/28", "2026/03/01", 1],
  ])("%s→%s は%i日になること", (prev, cur, expected) => {
    expect(daysBetweenDates(prev, cur)).toBe(expected);
  });

  it("いずれかの日付が null のときは null を返すこと", () => {
    expect(daysBetweenDates(null, "2026/06/28")).toBeNull();
    expect(daysBetweenDates("2026/06/28", null)).toBeNull();
  });

  it("解釈できない日付表記は null を返すこと", () => {
    expect(daysBetweenDates("不明", "2026/06/28")).toBeNull();
  });
});

describe("classifySeason(季節分類)", () => {
  it.each([
    [1, "冬"],
    [2, "冬"], // 2/3月境界の冬側
    [3, "春秋"], // 2/3月境界の春秋側
    [4, "春秋"],
    [5, "春秋"], // 5/6月境界の春秋側
    [6, "夏"], // 5/6月境界の夏側
    [7, "夏"],
    [8, "夏"],
    [9, "夏"], // 9/10月境界の夏側
    [10, "春秋"], // 9/10月境界の春秋側
    [11, "春秋"], // 11/12月境界の春秋側
    [12, "冬"], // 11/12月境界の冬側
  ])("%i月は「%s」に分類されること", (month, expected) => {
    expect(classifySeason(month)).toBe(expected);
  });

  it.each([[0], [13], [-1]])(
    "範囲外の月(%i)は対象外(null)を返すこと",
    (month) => {
      expect(classifySeason(month)).toBeNull();
    },
  );
});

describe("classifyFrameZone(枠ゾーン分類)", () => {
  it.each([
    [1, "内"],
    [2, "内"],
    [3, "内"], // 3/4境界の内側
    [4, "中"], // 3/4境界の中側
    [5, "中"],
    [6, "中"], // 6/7境界の中側
    [7, "外"], // 6/7境界の外側
    [8, "外"],
  ])("枠%i番は「%s」に分類されること", (waku, expected) => {
    expect(classifyFrameZone(waku)).toBe(expected);
  });

  it("枠番が null(海外走など)のときは対象外(null)になること", () => {
    expect(classifyFrameZone(null)).toBeNull();
  });

  it.each([[0], [9]])("枠の範囲外(%i)は対象外(null)になること", (waku) => {
    expect(classifyFrameZone(waku)).toBeNull();
  });
});

describe("classifyTrackWetness(道悪判定)", () => {
  it.each([
    ["良", false],
    ["稍", true],
    ["重", true],
    ["不", true],
    ["稍重", true],
    ["不良", true],
  ])("馬場「%s」の道悪判定は isWet=%s になること", (cond, isWet) => {
    expect(classifyTrackWetness(cond, "芝")).toEqual({ isWet, courseType: "芝" });
  });

  it("良/稍の境界(良=乾き、稍=道悪)を正しく判定すること", () => {
    expect(classifyTrackWetness("良", "ダ")?.isWet).toBe(false);
    expect(classifyTrackWetness("稍", "ダ")?.isWet).toBe(true);
  });

  it("芝/ダートの区別ができるよう courseType を併せて返すこと", () => {
    expect(classifyTrackWetness("重", "ダ")).toEqual({
      isWet: true,
      courseType: "ダ",
    });
    expect(classifyTrackWetness("重", "芝")).toEqual({
      isWet: true,
      courseType: "芝",
    });
  });

  it("馬場状態が null のときは対象外(null)になること", () => {
    expect(classifyTrackWetness(null, "芝")).toBeNull();
  });

  it("未知の馬場表記は対象外(null)になること", () => {
    expect(classifyTrackWetness("？", "芝")).toBeNull();
  });
});

/** 合成戦績1走分を最小構成で組み立てる(派生特徴量の統合テスト用)。 */
function makeResult(
  overrides: Partial<HorseRaceResult> & { date: string | null },
): HorseRaceResult {
  return {
    venue: null,
    weather: null,
    raceNumber: null,
    raceName: null,
    raceId: null,
    raceIdRaw: null,
    venueKind: "中央",
    entryCount: null,
    wakuban: null,
    umaban: null,
    odds: null,
    ninki: null,
    finishPosition: null,
    jockeyName: null,
    jockeyId: null,
    kinryo: null,
    courseType: null,
    distance: null,
    trackCondition: null,
    time: null,
    margin: null,
    passing: [],
    pace: null,
    last3f: null,
    bodyWeight: null,
    winnerName: null,
    ...overrides,
  };
}

describe("deriveRaceFeatures(休み明け何走目ラベル)", () => {
  it("キャリア初戦(最古走)は休み明け1走目になること", () => {
    // 入力は新しい順。最古走=配列末尾。
    const results = [
      makeResult({ date: "2025/03/01" }),
      makeResult({ date: "2025/01/01" }), // 初戦
    ];
    const features = deriveRaceFeatures(results);
    // 末尾(最古)が初戦=1走目。
    expect(features[1]!.restRunNumber).toBe(1);
    expect(features[1]!.interval).toBe("不明");
  });

  it("連続出走で1,2,3...とカウントし、休み明けでリセットすること", () => {
    // 古い順の並び(実際の入力は新しい順なので逆順で渡す):
    //  A 2025/01/01 初戦        → 1走目
    //  B 2025/01/15 中2週(14日) → 2走目
    //  C 2025/02/01 中2週(17日) → 3走目
    //  D 2025/05/01 休み明け(89日)→ 1走目(リセット)
    //  E 2025/05/22 中2週(21日) → 2走目
    const chrono = [
      makeResult({ date: "2025/01/01" }),
      makeResult({ date: "2025/01/15" }),
      makeResult({ date: "2025/02/01" }),
      makeResult({ date: "2025/05/01" }),
      makeResult({ date: "2025/05/22" }),
    ];
    // 新しい順に反転して入力。
    const features = deriveRaceFeatures([...chrono].reverse());
    // features も新しい順。E,D,C,B,A の順。
    const [E, D, C, B, A] = features;
    expect(A!.restRunNumber).toBe(1); // 初戦
    expect(B!.restRunNumber).toBe(2);
    expect(C!.restRunNumber).toBe(3);
    expect(D!.restRunNumber).toBe(1); // 休み明けでリセット
    expect(D!.interval).toBe("休み明け");
    expect(E!.restRunNumber).toBe(2);
  });

  it("休み明け起点を過ぎた4走目以降も連番でカウントし続けること", () => {
    const chrono = [
      makeResult({ date: "2025/01/01" }), // 1
      makeResult({ date: "2025/01/15" }), // 2
      makeResult({ date: "2025/02/01" }), // 3
      makeResult({ date: "2025/02/15" }), // 4
      makeResult({ date: "2025/03/01" }), // 5
    ];
    const features = deriveRaceFeatures([...chrono].reverse());
    const nums = [...features].reverse().map((f) => f.restRunNumber);
    expect(nums).toEqual([1, 2, 3, 4, 5]);
  });

  it("途中で日付欠損があると走目が算出不能(null)になること", () => {
    const chrono = [
      makeResult({ date: "2025/01/01" }), // 1
      makeResult({ date: null }), // 日付欠損 → 算出不能
      makeResult({ date: "2025/02/01" }), // 前走間隔不明 → 算出不能
    ];
    const features = deriveRaceFeatures([...chrono].reverse());
    const nums = [...features].reverse().map((f) => f.restRunNumber);
    expect(nums).toEqual([1, null, null]);
  });
});

describe("deriveRaceFeatures(入力順の保持と前走間隔)", () => {
  it("入力(新しい順)の並びをそのまま保った配列を返すこと", () => {
    const results = [
      makeResult({ date: "2025/03/01", umaban: 1 }),
      makeResult({ date: "2025/02/01", umaban: 2 }),
      makeResult({ date: "2025/01/01", umaban: 3 }),
    ];
    const features = deriveRaceFeatures(results);
    expect(features.map((f) => f.result.umaban)).toEqual([1, 2, 3]);
  });

  it("各走の前走との日数差(daysSincePrev)は入力の次要素との差になること", () => {
    const results = [
      makeResult({ date: "2025/03/01" }), // 前走2025/02/01 → 28日
      makeResult({ date: "2025/02/01" }), // 前走2025/01/01 → 31日
      makeResult({ date: "2025/01/01" }), // 初戦 → null
    ];
    const features = deriveRaceFeatures(results);
    expect(features[0]!.daysSincePrev).toBe(28);
    expect(features[1]!.daysSincePrev).toBe(31);
    expect(features[2]!.daysSincePrev).toBeNull();
  });
});

describe("deriveRaceFeatures(実フィクスチャ: ウィンターガーデン23走)", () => {
  const winter: HorseRaceResult[] = parseHorseResults(
    loadFixture("horse_results_2021105857.json"),
  );
  const features = deriveRaceFeatures(winter);

  it("走数を保ったまま(23走)派生特徴量を付与すること", () => {
    expect(features).toHaveLength(23);
  });

  it("最新走(2026/06/28)は前走(2026/04/11)から78日=休み明けになること", () => {
    const f = features[0]!;
    expect(f.result.date).toBe("2026/06/28");
    expect(f.daysSincePrev).toBe(78);
    expect(f.interval).toBe("休み明け");
    // 自身が休み明けなので走目は1にリセットされる。
    expect(f.restRunNumber).toBe(1);
  });

  it("2走目(2026/04/11)は前走から21日=連闘〜中3週になること", () => {
    const f = features[1]!;
    expect(f.result.date).toBe("2026/04/11");
    expect(f.daysSincePrev).toBe(21);
    expect(f.interval).toBe("連闘〜中3週");
  });

  it("3走目(2026/03/21)は前走から41日=中4〜9週になること", () => {
    const f = features[2]!;
    expect(f.result.date).toBe("2026/03/21");
    expect(f.daysSincePrev).toBe(41);
    expect(f.interval).toBe("中4〜9週");
  });

  it("最新走(2026/06/28・稍・ダ)は道悪(isWet=true)・夏・内枠と判定されること", () => {
    const f = features[0]!;
    expect(f.trackWetness).toEqual({ isWet: true, courseType: "ダ" });
    expect(f.season).toBe("夏"); // 6月
    expect(f.frameZone).toBe("内"); // 枠1
  });

  it("最古走は初戦扱いで interval=不明・restRunNumber=1 になること", () => {
    const f = features[features.length - 1]!;
    expect(f.interval).toBe("不明");
    expect(f.daysSincePrev).toBeNull();
    expect(f.restRunNumber).toBe(1);
  });
});
