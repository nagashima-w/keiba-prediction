/**
 * レース情報スナップショットの馬ごとの「スタート直後の位置」(Issue #311。レース再生の演出用)。
 * `buildRaceSnapshot` が戦績(`h.results`。runAnalysis では基準日で絞り済み)から `earlyPos` を計算して載せ、
 * 読み出し(`toSafeRaceSnapshot`)は過去のスナップショット(キー無し)を null で返す。
 */
import { describe, expect, it } from "vitest";
import type { RaceData } from "../../src/pipeline.js";
import { buildRaceSnapshot, toSafeRaceSnapshot } from "../../src/analysis/analysis-export.js";

function horseOf(umaban: number, results: unknown): unknown {
  return {
    shutuba: { wakuban: umaban, umaban, name: `馬${umaban}`, sex: "牡", age: 4, kinryo: 56, jockeyName: "騎手", trainerName: "調教師", bodyWeight: null },
    results,
    oikiri: null,
  };
}

/** 馬1=逃げ(1/10 と 2/10)、馬2=追込(9/10)、馬3=戦績の取得失敗(results: null)、馬4=初出走(空)。 */
function raceData(): RaceData {
  return {
    raceId: "202603020211",
    race: { raceName: "テスト", courseType: "芝", distance: 1800 },
    horses: [
      horseOf(1, [{ passing: [1, 1, 1], entryCount: 10 }, { passing: [2, 2, 2], entryCount: 10 }]),
      horseOf(2, [{ passing: [9, 9, 5], entryCount: 10 }]),
      horseOf(3, null),
      horseOf(4, []),
    ],
    odds: { officialDatetime: null, oddsStatus: "result", win: {}, place: {} },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
  } as unknown as RaceData;
}

describe("buildRaceSnapshot(スタート直後の位置。Issue #311)", () => {
  it("馬ごとに earlyPos を載せる(戦績の第1コーナー÷頭数の平均。取得失敗・初出走は null)", () => {
    const byUmaban = new Map(buildRaceSnapshot(raceData()).horses.map((h) => [h.umaban, h]));
    expect(byUmaban.get(1)!.earlyPos).toBe(0.15);
    expect(byUmaban.get(2)!.earlyPos).toBe(0.9);
    expect(byUmaban.get(3)!.earlyPos).toBeNull();
    expect(byUmaban.get(4)!.earlyPos).toBeNull();
    // 前提: 前の馬と後ろの馬で値が違う(取り違え・定数化の変異を検出できる)
    expect(byUmaban.get(1)!.earlyPos).not.toBe(byUmaban.get(2)!.earlyPos);
  });

  it("戦績そのもの(results)はスナップショットに入らない(サイズ大。従来どおり)", () => {
    const json = JSON.stringify(buildRaceSnapshot(raceData()));
    expect(json).not.toContain("passing");
    expect(json).not.toContain("entryCount");
  });
});

describe("toSafeRaceSnapshot(スタート直後の位置。Issue #311)", () => {
  it("保存したスナップショットから earlyPos を読み出せる(JSON の往復を含む)", () => {
    const safe = toSafeRaceSnapshot(JSON.parse(JSON.stringify(buildRaceSnapshot(raceData()))) as unknown);
    expect(safe.horsesByUmaban.get(1)!.earlyPos).toBe(0.15);
    expect(safe.horsesByUmaban.get(3)!.earlyPos).toBeNull();
  });

  it("キーを持たない過去のスナップショットは earlyPos が null で読める(補い値を作らない)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceData()))) as { horses: Record<string, unknown>[] };
    for (const h of stored.horses) {
      delete h["earlyPos"];
    }
    expect(stored.horses.every((h) => !("earlyPos" in h))).toBe(true); // 前提
    expect(toSafeRaceSnapshot(stored).horsesByUmaban.get(1)!.earlyPos).toBeNull();
  });
});
