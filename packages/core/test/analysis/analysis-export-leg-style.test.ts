/**
 * レース情報スナップショットの馬ごとの脚質(Issue #314。想定隊列図〈#362〉の位置を脚質で決める。もとはレース再生〈#362 で廃止〉の隊列用)。
 * `buildRaceSnapshot` が戦績(`h.results`)から `legStyle` を計算して載せ、読み出し(`toSafeRaceSnapshot`)は
 * 過去のスナップショット(キー無し)を null で返す。`earlyPos` と同じ扱い。
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

/** 馬1=逃げ、馬2=追込、馬3=戦績の取得失敗(results: null)、馬4=初出走(空)。 */
function raceData(): RaceData {
  return {
    raceId: "202603020211",
    race: { raceName: "テスト", courseType: "芝", distance: 1800 },
    horses: [
      horseOf(1, [{ passing: [1, 1, 1, 1], entryCount: 10 }, { passing: [1, 2, 2, 2], entryCount: 10 }]),
      horseOf(2, [{ passing: [9, 9, 8, 5], entryCount: 10 }]),
      horseOf(3, null),
      horseOf(4, []),
    ],
    odds: { officialDatetime: null, oddsStatus: "result", win: {}, place: {} },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
  } as unknown as RaceData;
}

describe("buildRaceSnapshot(脚質。Issue #314)", () => {
  it("馬ごとに legStyle を載せる(取得失敗・初出走は null)。前の馬と後ろの馬で値が違う", () => {
    const byUmaban = new Map(buildRaceSnapshot(raceData()).horses.map((h) => [h.umaban, h]));
    expect(byUmaban.get(1)!.legStyle).toBe("逃げ");
    expect(byUmaban.get(2)!.legStyle).toBe("追込");
    expect(byUmaban.get(3)!.legStyle).toBeNull();
    expect(byUmaban.get(4)!.legStyle).toBeNull();
  });
});

describe("toSafeRaceSnapshot(脚質。Issue #314)", () => {
  it("保存したスナップショットから legStyle を読み出せる(JSON の往復を含む)", () => {
    const safe = toSafeRaceSnapshot(JSON.parse(JSON.stringify(buildRaceSnapshot(raceData()))) as unknown);
    expect(safe.horsesByUmaban.get(1)!.legStyle).toBe("逃げ");
    expect(safe.horsesByUmaban.get(2)!.legStyle).toBe("追込");
    expect(safe.horsesByUmaban.get(3)!.legStyle).toBeNull();
  });

  it("キーを持たない過去のスナップショットは legStyle が null で読める(補い値を作らない)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceData()))) as { horses: Record<string, unknown>[] };
    for (const h of stored.horses) {
      delete h["legStyle"];
    }
    expect(stored.horses.every((h) => !("legStyle" in h))).toBe(true); // 前提
    expect(toSafeRaceSnapshot(stored).horsesByUmaban.get(1)!.legStyle).toBeNull();
  });
});
