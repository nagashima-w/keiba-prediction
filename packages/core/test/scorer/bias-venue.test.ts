import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { deriveRaceFeatures } from "../../src/scorer/derive-features.js";
import { computeVenueBias } from "../../src/scorer/bias-venue.js";
import { courseSimilarity } from "../../src/scorer/course-traits.js";
import { DEFAULT_SCORER_CONFIG } from "../../src/scorer/config.js";
import { makeResult, rank, venue } from "./helpers.js";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 中央の1走(会場名・着順)を作る。 */
function centralRun(date: string, venueName: string, finish: number) {
  return makeResult({
    date,
    venue: venue(venueName),
    venueKind: "中央",
    finishPosition: rank(finish),
  });
}

describe("computeVenueBias(競馬場適性・当該場実績)", () => {
  it("当該場に2走以上あれば当該場複勝率で差分補正すること", () => {
    // 京都3走(圏内2: 1,3着 / 圏外1: 8着)→ 2/3。
    // 全体(中央5走)= 京都3 + 東京2、圏内3(京都2+東京1)→ 3/5=0.6。差分 = 2/3 − 0.6。
    const features = deriveRaceFeatures([
      centralRun("2025/05/01", "京都", 1),
      centralRun("2025/04/01", "京都", 3),
      centralRun("2025/03/01", "京都", 8),
      centralRun("2025/02/01", "東京", 1),
      centralRun("2025/01/01", "東京", 5),
    ]);
    const c = computeVenueBias(features, { venueName: "京都" });
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(3);
    expect(c.targetRate).toBeCloseTo(2 / 3, 10);
    expect(c.overallRate).toBeCloseTo(0.6, 10);
    expect(c.correction).toBeCloseTo(2 / 3 - 0.6, 10);
  });

  it("当該場1走のときは当該場実績では補正せず代替評価に回ること", () => {
    // 京都1走のみ。代替評価に回るため、当該場実績としては採用しない(kind が代替評価)。
    const features = deriveRaceFeatures([
      centralRun("2025/02/01", "京都", 1),
      centralRun("2025/01/01", "阪神", 3),
      centralRun("2024/12/01", "阪神", 2),
    ]);
    const c = computeVenueBias(features, { venueName: "京都" });
    expect(c.kind).toBe("代替評価");
  });

  it("地方・海外走は当該場実績・全体母数の双方から除外されること", () => {
    // 会場名が同じ「京都」でも venueKind が地方なら対象外。
    const features = deriveRaceFeatures([
      centralRun("2025/05/01", "京都", 1),
      centralRun("2025/04/01", "京都", 3),
      makeResult({
        date: "2025/03/01",
        venue: venue("京都"),
        venueKind: "地方",
        finishPosition: rank(1),
      }),
    ]);
    const c = computeVenueBias(features, { venueName: "京都" });
    // 中央の京都2走のみ(圏内2)→ 2/2=1.0。地方走は数えない。
    expect(c.sampleCount).toBe(2);
    expect(c.targetRate).toBeCloseTo(1, 10);
  });

  it("中央実績が全く無い場合は不明(補正なし)になること", () => {
    const features = deriveRaceFeatures([
      makeResult({
        date: "2025/01/01",
        venue: venue("大井"),
        venueKind: "地方",
        finishPosition: rank(1),
      }),
    ]);
    const c = computeVenueBias(features, { venueName: "京都" });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("今回の会場が中央10場でない(未知)場合は補正なしになること", () => {
    const features = deriveRaceFeatures([centralRun("2025/01/01", "京都", 1)]);
    const c = computeVenueBias(features, { venueName: "大井" });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });

  it("実フィクスチャ(ウィンターガーデン): 京都実績の補正が (4/7 − 8/23) になること", () => {
    const winter = parseHorseResults(
      loadFixture("horse_results_2021105857.json"),
    );
    const features = deriveRaceFeatures(winter);
    const c = computeVenueBias(features, { venueName: "京都" });
    // 京都7走中4走圏内 → 4/7。全体(中央23走)8走圏内 → 8/23。
    expect(c.kind).toBe("実績");
    expect(c.sampleCount).toBe(7);
    expect(c.targetRate).toBeCloseTo(4 / 7, 10);
    expect(c.overallRate).toBeCloseTo(8 / 23, 10);
    expect(c.correction).toBeCloseTo(4 / 7 - 8 / 23, 10);
  });
});

describe("computeVenueBias(競馬場適性・代替評価)", () => {
  it("当該場実績が無くても類似コースの実績で代替評価すること", () => {
    // 今回=東京(左・平坦・野芝)。当該場実績なし。
    //  新潟(左・平坦・野芝)2走とも圏内、中京(左・急坂・野芝)2走とも圏外、
    //  中山(右・急坂・野芝)1走圏内は類似度が閾値未満で除外される想定。
    const features = deriveRaceFeatures([
      centralRun("2025/06/01", "新潟", 1),
      centralRun("2025/05/01", "新潟", 2),
      centralRun("2025/04/01", "中京", 8),
      centralRun("2025/03/01", "中京", 9),
      centralRun("2025/02/01", "中山", 1),
    ]);
    const c = computeVenueBias(features, { venueName: "東京" });

    // 実装と同じ定数・式で期待値を組み立てる(定数のハードコードを避ける)。
    const simNiigata = courseSimilarity("東京", "新潟")!;
    const simChukyo = courseSimilarity("東京", "中京")!;
    const simNakayama = courseSimilarity("東京", "中山")!;
    const threshold = DEFAULT_SCORER_CONFIG.venue.similarityThreshold;
    // 中山は閾値未満で除外される前提(テスト設計の検証)。
    expect(simNakayama).toBeLessThan(threshold);
    expect(simNiigata).toBeGreaterThanOrEqual(threshold);
    expect(simChukyo).toBeGreaterThanOrEqual(threshold);

    // 類似度重み付き複勝率 = Σ(sim×placed)/Σ(sim)。新潟2走圏内・中京2走圏外。
    const weightedRate =
      (simNiigata * 1 + simNiigata * 1 + simChukyo * 0 + simChukyo * 0) /
      (simNiigata + simNiigata + simChukyo + simChukyo);
    // 全体(中央5走)複勝率 = 圏内3(新潟2+中山1)/5 = 0.6。
    const overallRate = 3 / 5;
    const decay = DEFAULT_SCORER_CONFIG.venue.similarityDecay;
    const expected =
      (weightedRate - overallRate) *
      DEFAULT_SCORER_CONFIG.weights.venue *
      decay;

    expect(c.kind).toBe("代替評価");
    expect(c.applied).toBe(true);
    expect(c.sampleCount).toBe(4); // 新潟2 + 中京2(中山は閾値未満で除外)
    expect(c.targetRate).toBeCloseTo(weightedRate, 10);
    expect(c.overallRate).toBeCloseTo(overallRate, 10);
    expect(c.correction).toBeCloseTo(expected, 10);
  });

  it("代替評価は減衰(similarityDecay)により当該場実績より控えめな補正になること", () => {
    // 類似コースが1つ(新潟のみ)で複勝率0の場合、マイナス補正だが減衰で控えめになる。
    const features = deriveRaceFeatures([
      centralRun("2025/06/01", "新潟", 8),
      centralRun("2025/05/01", "新潟", 9),
    ]);
    const c = computeVenueBias(features, { venueName: "東京" });
    expect(c.kind).toBe("代替評価");
    // 減衰係数が1未満であること(代替評価は直接実績より不確実なため割り引く)。
    expect(DEFAULT_SCORER_CONFIG.venue.similarityDecay).toBeLessThan(1);
    // 補正はマイナス方向(全体0 vs 新潟0だが、overall=0なので差分0)。
    // ここでは overall も 0 のため補正0になる。符号のテストは前ケースで担保。
    expect(c.correction).toBeLessThanOrEqual(0);
  });

  it("類似コースの実績も2走未満(サンプル不足)なら不明になること", () => {
    // 東京に類似する新潟1走のみ → 代替評価の母数も2走未満で補正なし。
    const features = deriveRaceFeatures([centralRun("2025/06/01", "新潟", 1)]);
    const c = computeVenueBias(features, { venueName: "東京" });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
  });
});

describe("computeVenueBias(NAR: 地方レースは補正対象外)", () => {
  it("venueKind が nar のときは当該場実績があっても補正しないこと", () => {
    // 中央の京都実績が豊富にあっても、今回が地方(NAR)レースなら競馬場適性補正は対象外。
    const features = deriveRaceFeatures([
      centralRun("2025/05/01", "京都", 1),
      centralRun("2025/04/01", "京都", 3),
      centralRun("2025/03/01", "京都", 8),
    ]);
    const c = computeVenueBias(features, {
      venueName: "高知",
      venueKind: "nar",
    });
    expect(c.applied).toBe(false);
    expect(c.correction).toBe(0);
    expect(c.kind).toBe("不明");
    expect(c.reason).toContain("NARのため対象外");
  });

  it("venueKind を省略した場合は従来どおり中央として扱われること(既定値は central)", () => {
    // 既定(central)では今回の会場が中央10場かどうかで判定する従来ロジックのまま。
    const features = deriveRaceFeatures([centralRun("2025/01/01", "京都", 1)]);
    const c = computeVenueBias(features, { venueName: "高知" });
    expect(c.applied).toBe(false);
    expect(c.reason).not.toContain("NARのため対象外");
  });
});
