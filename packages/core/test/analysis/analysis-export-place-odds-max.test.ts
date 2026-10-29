/**
 * レース情報スナップショットの馬ごとの複勝オッズの上限(Issue #253)。
 *
 * 想定複勝オッズ(分析から見た目安)を、分析時点の実際の複勝オッズ(下限〜上限)と並べて出すため、スナップショットの馬に
 * `placeOddsMax` を足した(`placeOddsMin` と同じく `race.odds.place[umaban]` から。未確定・取れない馬は null)。
 * **過去に保存したスナップショットはこのキーを持たない**ので、読み出し(`toSafeRaceSnapshot`)では null になる
 * (補い値を作らない。画面は「下限だけ」の形で出す)。
 */

import { describe, expect, it } from "vitest";
import type { RaceData } from "../../src/pipeline.js";
import { buildRaceSnapshot, toSafeRaceSnapshot } from "../../src/analysis/analysis-export.js";

function horseOf(umaban: number): unknown {
  return {
    shutuba: { wakuban: umaban, umaban, name: `馬${umaban}`, sex: "牡", age: 4, kinryo: 56, jockeyName: "騎手", trainerName: "調教師", bodyWeight: null },
    results: [],
    oikiri: null,
  };
}

/** 4頭: 馬1=下限・上限あり、馬2=下限だけ(上限が取れない)、馬3=未確定(どちらも null)、馬4=複勝オッズの欄が無い。 */
function raceData(): RaceData {
  return {
    raceId: "202603020211",
    race: { raceName: "テスト", courseType: "芝", distance: 1800 },
    horses: [horseOf(1), horseOf(2), horseOf(3), horseOf(4)],
    odds: {
      officialDatetime: null,
      oddsStatus: "result",
      win: {},
      place: {
        1: { oddsMin: 1.5, oddsMax: 2.3, ninki: 1 },
        2: { oddsMin: 3.1, oddsMax: null, ninki: 2 },
        3: { oddsMin: null, oddsMax: null, ninki: null },
      },
    },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
  } as unknown as RaceData;
}

describe("buildRaceSnapshot(複勝オッズの上限。Issue #253)", () => {
  it("馬ごとに placeOddsMax を写す(下限 placeOddsMin と取り違えない。上限が取れない馬・未確定の馬・欄の無い馬は null)", () => {
    const snapshot = buildRaceSnapshot(raceData());
    const byUmaban = new Map(snapshot.horses.map((h) => [h.umaban, h]));
    expect(byUmaban.get(1)).toMatchObject({ placeOddsMin: 1.5, placeOddsMax: 2.3 });
    expect(byUmaban.get(2)).toMatchObject({ placeOddsMin: 3.1, placeOddsMax: null });
    expect(byUmaban.get(3)).toMatchObject({ placeOddsMin: null, placeOddsMax: null });
    expect(byUmaban.get(4)).toMatchObject({ placeOddsMin: null, placeOddsMax: null });
    // 前提: 下限と上限が違う値(取り違え変異を検出できる)
    expect(byUmaban.get(1)!.placeOddsMin).not.toBe(byUmaban.get(1)!.placeOddsMax);
  });

  it("馬のキー一覧(placeOddsMax は Issue #253、earlyPos は Issue #311、latePos は Issue #363、legStyle は Issue #314、jockeyId は Issue #526 で増えた。他のキーは従来のまま)", () => {
    const keys = Object.keys(buildRaceSnapshot(raceData()).horses[0]!).sort();
    expect(keys).toEqual(
      ["age", "bodyWeight", "earlyPos", "jockeyId", "jockeyName", "kinryo", "latePos", "legStyle", "name", "oikiriCritic", "oikiriRank", "placeOddsMax", "placeOddsMin", "popularity", "sex", "trainerName", "umaban", "wakuban", "winOdds"],
    );
  });
});

describe("toSafeRaceSnapshot(複勝オッズの上限。Issue #253)", () => {
  it("上限入りで保存したスナップショットから、馬ごとの placeOddsMax を読み出せる(JSON の往復を含む)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceData()))) as unknown;
    const safe = toSafeRaceSnapshot(stored);
    expect(safe.horsesByUmaban.get(1)).toMatchObject({ placeOddsMin: 1.5, placeOddsMax: 2.3 });
    expect(safe.horsesByUmaban.get(2)).toMatchObject({ placeOddsMin: 3.1, placeOddsMax: null });
  });

  it("上限のキーを持たない過去のスナップショットは、placeOddsMax が null で読める(下限は保たれる。補い値を作らない)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceData()))) as { horses: Record<string, unknown>[] };
    for (const h of stored.horses) {
      delete h["placeOddsMax"];
    }
    expect(stored.horses.every((h) => !("placeOddsMax" in h))).toBe(true); // 前提
    const safe = toSafeRaceSnapshot(stored);
    expect(safe.horsesByUmaban.get(1)).toMatchObject({ placeOddsMin: 1.5, placeOddsMax: null });
  });
});
