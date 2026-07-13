import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import {
  classifyTransportLoad,
  computeTransportBias,
} from "../../src/scorer/bias-transport.js";
import { DEFAULT_SCORER_CONFIG } from "../../src/scorer/config.js";
import type { HorseRaceResult, VenueKind } from "../../src/scraper/types.js";
import { makeResult, rank, venue } from "./helpers.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 輸送テスト用の合成戦績。会場名・着順・馬体重増減・開催区分を最小構成で指定する。 */
function tRun(
  venueName: string,
  finish: number,
  diff: number | null = null,
  venueKind: VenueKind = "中央",
): HorseRaceResult {
  return makeResult({
    date: "2025/01/01",
    venue: venue(venueName),
    venueKind,
    finishPosition: rank(finish),
    bodyWeight: diff === null ? null : { weight: 480, diff },
  });
}

describe("classifyTransportLoad(輸送負荷の分類テーブル)", () => {
  // 表駆動: 厩舎所在地 × 開催場 → 期待する輸送負荷分類。
  const cases: ReadonlyArray<
    readonly ["美浦" | "栗東", string, "地元圏" | "短距離輸送" | "長距離輸送"]
  > = [
    // 美浦(茨城)所属
    ["美浦", "中山", "地元圏"],
    ["美浦", "東京", "地元圏"],
    ["美浦", "福島", "短距離輸送"],
    ["美浦", "新潟", "短距離輸送"],
    ["美浦", "中京", "長距離輸送"],
    ["美浦", "京都", "長距離輸送"],
    ["美浦", "阪神", "長距離輸送"],
    ["美浦", "小倉", "長距離輸送"],
    ["美浦", "札幌", "長距離輸送"],
    ["美浦", "函館", "長距離輸送"],
    // 栗東(滋賀)所属
    ["栗東", "京都", "地元圏"],
    ["栗東", "阪神", "地元圏"],
    ["栗東", "中京", "地元圏"],
    // 小倉(北九州)は東京(長距離)より遠いため長距離輸送(距離感の逆転を回避)。
    // これにより栗東所属には短距離輸送に該当する中央場がなくなる(空バケット許容)。
    ["栗東", "小倉", "長距離輸送"],
    ["栗東", "東京", "長距離輸送"],
    ["栗東", "中山", "長距離輸送"],
    ["栗東", "福島", "長距離輸送"],
    ["栗東", "新潟", "長距離輸送"],
    ["栗東", "札幌", "長距離輸送"],
    ["栗東", "函館", "長距離輸送"],
  ];

  it.each(cases)(
    "%s 所属が %s 開催なら %s に分類されること",
    (stable, venueName, expected) => {
      expect(classifyTransportLoad(stable, venueName)).toBe(expected);
    },
  );

  it("北海道(札幌・函館)は両所属とも長距離輸送になること", () => {
    expect(classifyTransportLoad("美浦", "札幌")).toBe("長距離輸送");
    expect(classifyTransportLoad("美浦", "函館")).toBe("長距離輸送");
    expect(classifyTransportLoad("栗東", "札幌")).toBe("長距離輸送");
    expect(classifyTransportLoad("栗東", "函館")).toBe("長距離輸送");
  });

  it("中央10場でない会場(地方・海外)は分類対象外(null)になること", () => {
    expect(classifyTransportLoad("栗東", "大井")).toBeNull();
    expect(classifyTransportLoad("美浦", "メイダン")).toBeNull();
  });
});

describe("computeTransportBias(近距離・長距離)", () => {
  it("今回が地元圏(栗東→京都)なら補正なしになること", () => {
    const features = deriveRaceFeatures([
      tRun("京都", 1),
      tRun("阪神", 3),
      tRun("新潟", 8),
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "京都",
    });
    expect(c.kind).toBe("近距離");
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("今回が長距離輸送で長距離実績2走以上なら差分補正されること", () => {
    // 栗東所属。長距離 = 新潟・函館。新潟2走(1圏内)、函館1走(圏外)。
    // 長距離プール = 新潟2 + 函館1 = 3走中1圏内 → 1/3。
    // 全体(中央) = 上記3走 + 地元京都2走(2圏内) = 5走中3圏内 → 3/5。
    const features = deriveRaceFeatures([
      tRun("新潟", 2), // 長距離・圏内
      tRun("新潟", 8), // 長距離・圏外
      tRun("函館", 10), // 長距離・圏外
      tRun("京都", 1), // 地元・圏内
      tRun("京都", 3), // 地元・圏内
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "新潟",
    });
    expect(c.kind).toBe("長距離輸送");
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(3);
    expect(c.targetRate).toBeCloseTo(1 / 3, 10);
    expect(c.overallRate).toBeCloseTo(3 / 5, 10);
    expect(c.correction).toBeCloseTo(1 / 3 - 3 / 5, 10);
    // 滞在ではないので滞在ボーナスは0。
    expect(c.stayBonus).toBe(0);
    expect(c.correction).toBeCloseTo(c.differenceCorrection, 10);
  });

  it("長距離実績がちょうど2走なら補正が適用されること(境界値)", () => {
    // 栗東・今回新潟。長距離 = 新潟1走 + 函館1走 = ちょうど2走(1圏内)。
    const features = deriveRaceFeatures([
      tRun("新潟", 2), // 長距離・圏内
      tRun("函館", 8), // 長距離・圏外
      tRun("京都", 1), // 地元
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "新潟",
    });
    expect(c.kind).toBe("長距離輸送");
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(1 / 2, 10);
  });

  it("今回が長距離輸送でも長距離実績2走未満なら補正なしになること", () => {
    const features = deriveRaceFeatures([
      tRun("新潟", 2), // 長距離1走のみ
      tRun("京都", 1),
      tRun("京都", 3),
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "新潟",
    });
    expect(c.kind).toBe("長距離輸送");
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(1);
    expect(c.correction).toBe(0);
  });

  it("今回の会場が中央10場でないときは不明として補正なしになること", () => {
    const features = deriveRaceFeatures([tRun("京都", 1), tRun("阪神", 3)]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "メイダン",
    });
    expect(c.kind).toBe("不明");
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });
});

describe("computeTransportBias(NAR: 地方レースは補正対象外)", () => {
  it("venueKind が nar のときは輸送弱フラグを含め補正しないこと", () => {
    // 中央での長距離輸送実績・輸送弱に該当する馬体重減があっても、今回が地方(NAR)なら
    // 輸送・滞在バイアスは一律対象外(美浦/栗東所属フォールバックの実害を防ぐ)。
    const features = deriveRaceFeatures([
      tRun("新潟", 8, -12),
      tRun("函館", 9, -14),
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "美浦",
      venueName: "高知",
      venueKind: "nar",
    });
    expect(c.kind).toBe("不明");
    expect(c.applied).toBe(false);
    expect(c.todayLoad).toBeNull();
    expect(c.transportWeakFlag).toBe(false);
    expect(c.weakDropCount).toBe(0);
    expect(c.correction).toBe(0);
    expect(c.reason).toContain("NARのため対象外");
  });

  it("venueKind を省略した場合は従来どおり中央として扱われること(既定値は central)", () => {
    const features = deriveRaceFeatures([tRun("京都", 1), tRun("阪神", 3)]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "高知",
    });
    expect(c.applied).toBe(false);
    expect(c.reason).not.toContain("NARのため対象外");
  });
});

describe("computeTransportBias(滞在競馬・札幌函館)", () => {
  it("滞在実績2走以上なら滞在走の複勝率で差分補正されること", () => {
    // 栗東所属、今回函館。過去の函館2走(2圏内)=滞在実績。新潟2走(圏外)。
    // 滞在プール = 函館2走中2圏内 → 1.0。全体 = 4走中2圏内 → 0.5。
    const features = deriveRaceFeatures([
      tRun("函館", 1, 2),
      tRun("函館", 2, 2),
      tRun("新潟", 8, 2),
      tRun("新潟", 8, 2),
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "函館",
    });
    expect(c.kind).toBe("滞在");
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(1.0, 10);
    expect(c.overallRate).toBeCloseTo(0.5, 10);
    expect(c.differenceCorrection).toBeCloseTo(0.5, 10);
    // 輸送弱フラグは立たない(-10kg以上の減がない)ので滞在ボーナス0。
    expect(c.transportWeakFlag).toBe(false);
    expect(c.stayBonus).toBe(0);
    expect(c.correction).toBeCloseTo(0.5, 10);
  });

  it("輸送弱フラグの馬は滞在競馬で滞在ボーナスが加算されること", () => {
    // 函館2走(2圏内)=滞在実績1.0、全体0.5。加えて新潟(長距離)で-10,-12の大幅減2回 → 輸送弱ON。
    const features = deriveRaceFeatures([
      tRun("函館", 1, 2),
      tRun("函館", 2, 2),
      tRun("新潟", 8, -10),
      tRun("新潟", 8, -12),
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "函館",
    });
    expect(c.kind).toBe("滞在");
    expect(c.transportWeakFlag).toBe(true);
    expect(c.weakDropCount).toBe(2);
    const w = DEFAULT_SCORER_CONFIG.weights.transport;
    const bonus = DEFAULT_SCORER_CONFIG.transport.stayBonus * w;
    expect(c.stayBonus).toBeCloseTo(bonus, 10);
    // 差分補正(0.5) + 滞在ボーナス。
    expect(c.differenceCorrection).toBeCloseTo(0.5, 10);
    expect(c.correction).toBeCloseTo(0.5 + bonus, 10);
    expect(c.applied).toBe(true);
  });

  it("滞在実績が2走未満でも輸送弱の馬には滞在ボーナスだけ適用されること", () => {
    // 函館1走のみ(滞在実績不足)。新潟の大幅減2回で輸送弱ON。
    const features = deriveRaceFeatures([
      tRun("函館", 1, 2),
      tRun("新潟", 8, -10),
      tRun("新潟", 8, -12),
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "函館",
    });
    expect(c.kind).toBe("滞在");
    expect(c.transportWeakFlag).toBe(true);
    expect(c.differenceCorrection).toBe(0); // 滞在実績2走未満
    const w = DEFAULT_SCORER_CONFIG.weights.transport;
    const bonus = DEFAULT_SCORER_CONFIG.transport.stayBonus * w;
    expect(c.stayBonus).toBeCloseTo(bonus, 10);
    expect(c.correction).toBeCloseTo(bonus, 10);
    // applied は「差分補正のサンプルが十分か」を表す統一基準。滞在実績2走未満なので false。
    // 輸送弱の滞在ボーナスは stayBonus / correction フィールドで表現する。
    expect(c.applied).toBe(false);
  });

  it("滞在ちょうど2走・輸送弱なしなら applied=true・ボーナス0になること", () => {
    // 函館2走(1圏内)。輸送弱なし。差分補正のみ、applied はサンプル十分で true。
    const features = deriveRaceFeatures([
      tRun("函館", 1, 2),
      tRun("函館", 8, 2),
    ]);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "函館",
    });
    expect(c.kind).toBe("滞在");
    expect(c.sampleCount).toBe(2);
    expect(c.applied).toBe(true);
    expect(c.stayBonus).toBe(0);
  });
});

describe("computeTransportBias(輸送弱フラグの境界値)", () => {
  // 表駆動: 大幅減の回数・大きさ・発生した輸送区分 → フラグON/OFF。
  // 今回は函館(滞在)固定で評価し、所属(stable)はケースごとに指定する。
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly stable: "美浦" | "栗東";
    readonly runs: HorseRaceResult[];
    readonly flag: boolean;
    readonly count: number;
  }> = [
    {
      name: "-10kgちょうどの減が2回(長距離)ならフラグON",
      stable: "栗東",
      runs: [tRun("新潟", 8, -10), tRun("新潟", 8, -10)],
      flag: true,
      count: 2,
    },
    {
      name: "-10kgの減が1回だけならフラグOFF",
      stable: "栗東",
      runs: [tRun("新潟", 8, -10), tRun("新潟", 8, -2)],
      flag: false,
      count: 1,
    },
    {
      name: "-9kg(閾値未満)の減が2回ならフラグOFF",
      stable: "栗東",
      runs: [tRun("新潟", 8, -9), tRun("新潟", 8, -9)],
      flag: false,
      count: 0,
    },
    {
      name: "短距離輸送(美浦→福島)での大幅減もカウントされること",
      stable: "美浦",
      runs: [tRun("福島", 8, -10), tRun("新潟", 8, -12)],
      flag: true,
      count: 2,
    },
    {
      name: "地元圏(栗東→京都・阪神)での大幅減はカウントされないこと",
      stable: "栗東",
      runs: [tRun("京都", 8, -20), tRun("阪神", 8, -20)],
      flag: false,
      count: 0,
    },
    {
      name: "地方・海外走での大幅減はカウントされないこと",
      stable: "栗東",
      runs: [
        tRun("大井", 8, -20, "地方"),
        tRun("メイダン", 8, -20, "海外"),
      ],
      flag: false,
      count: 0,
    },
  ];

  it.each(cases)("$name", ({ stable, runs, flag, count }) => {
    const features = deriveRaceFeatures([...runs, tRun("函館", 1, 2)]);
    const c = computeTransportBias(features, {
      stableLocation: stable,
      venueName: "函館",
    });
    expect(c.transportWeakFlag).toBe(flag);
    expect(c.weakDropCount).toBe(count);
  });
});

describe("computeTransportBias(実フィクスチャ)", () => {
  it("ウィンターガーデン(栗東): 今回長距離(新潟)で長距離複勝率が (1/3 − 8/23) 補正になること", () => {
    const results = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(results);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "新潟",
    });
    // 栗東の長距離 = 小倉(3走・1圏内) + 新潟(2走・1圏内) + 函館(1走・圏外) = 6走中2圏内 → 2/6 = 1/3。
    // (小倉は本テーブル是正で栗東=長距離に含まれる。)全体(中央23走)の複勝率 = 8/23。
    expect(c.kind).toBe("長距離輸送");
    expect(c.sampleCount).toBe(6);
    expect(c.targetRate).toBeCloseTo(1 / 3, 10);
    expect(c.overallRate).toBeCloseTo(8 / 23, 10);
    expect(c.correction).toBeCloseTo(1 / 3 - 8 / 23, 10);
  });

  it("地方・海外中心の馬(2021105727)は中央走のみ集計し長距離実績不足で補正なしになること", () => {
    // 15戦中、中央は京都1走(地元圏)のみ。長距離プールは空。
    const results = parseHorseResults(
      loadFixture("horse_results_2021105727.json"),
    );
    const features = deriveRaceFeatures(results);
    const c = computeTransportBias(features, {
      stableLocation: "栗東",
      venueName: "新潟",
    });
    expect(c.kind).toBe("長距離輸送");
    expect(c.applied).toBe(false);
    expect(c.sampleCount).toBe(0);
    expect(c.correction).toBe(0);
  });
});
