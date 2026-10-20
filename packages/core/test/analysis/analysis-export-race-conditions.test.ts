/**
 * レース情報スナップショットのレースの条件(負担重量の種別・牝馬限定。Issue #421 段階 1)。
 *
 * `RaceSnapshotRace.weightType`・`filliesOnly` は**値があるときだけ**キーを持つ(任意)。出馬表がキーを持たない(地方・読めなかった)レースと、
 * この項目を保存する前の過去のスナップショットはキー自体が無い(`grade` と同じ流儀)。
 */

import { describe, expect, it } from "vitest";
import type { RaceData } from "../../src/pipeline.js";
import { buildRaceSnapshot, toSafeRaceSnapshot } from "../../src/analysis/analysis-export.js";

function raceDataWith(conditions: { readonly weightType?: string; readonly filliesOnly?: boolean }): RaceData {
  return {
    raceId: "202603020211",
    race: { raceName: "ラジオNIKKEI賞", courseType: "芝", distance: 1800, ...conditions },
    horses: [],
    odds: { officialDatetime: null, oddsStatus: "result", win: {}, place: {} },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
  } as unknown as RaceData;
}

describe("buildRaceSnapshot(レースの条件。Issue #421)", () => {
  it("出馬表に種別と牝馬限定があるとき、race.weightType・race.filliesOnly に入る(false も確定値として入る)", () => {
    const race = buildRaceSnapshot(raceDataWith({ weightType: "ハンデ", filliesOnly: false })).race;
    expect(race.weightType).toBe("ハンデ");
    expect(race.filliesOnly).toBe(false);
    expect("filliesOnly" in race).toBe(true);
    expect(buildRaceSnapshot(raceDataWith({ weightType: "馬齢", filliesOnly: true })).race.filliesOnly).toBe(true);
  });

  it("種別が無く牝馬限定だけあるとき、weightType はキー無し・filliesOnly だけが入る", () => {
    const race = buildRaceSnapshot(raceDataWith({ filliesOnly: false })).race;
    expect("weightType" in race).toBe(false);
    expect(race.filliesOnly).toBe(false);
  });

  it("出馬表が条件のキーを持たない(地方・読めなかった)とき、スナップショットにもキー自体が無い", () => {
    const race = buildRaceSnapshot(raceDataWith({})).race;
    expect("weightType" in race).toBe(false);
    expect("filliesOnly" in race).toBe(false);
    expect(JSON.stringify(race)).not.toContain("weightType");
    expect(JSON.stringify(race)).not.toContain("filliesOnly");
  });
});

describe("toSafeRaceSnapshot(レースの条件。Issue #421)", () => {
  it("保存したスナップショットから race.weightType・race.filliesOnly を読み出せる(JSON の往復を含む)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceDataWith({ weightType: "別定", filliesOnly: true })))) as unknown;
    const race = toSafeRaceSnapshot(stored).race;
    expect(race.weightType).toBe("別定");
    expect(race.filliesOnly).toBe(true);
  });

  it("条件を持たない過去のスナップショットは undefined のまま読める(補い値を作らない)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceDataWith({})))) as unknown;
    const race = toSafeRaceSnapshot(stored).race;
    expect(race.raceName).toBe("ラジオNIKKEI賞");
    expect(race.weightType).toBeUndefined();
    expect(race.filliesOnly).toBeUndefined();
  });
});
