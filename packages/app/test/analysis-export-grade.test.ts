/**
 * レース情報スナップショットのグレード(Issue #250)。
 *
 * `RaceSnapshotRace.grade` は**値があるときだけ**キーを持つ(任意)。過去に保存したスナップショットはキーを持たず、
 * 読み出し(`toSafeRaceSnapshot`)でも欠けたままになる(null は「保存時に読めなかった」と区別しない=キー無しと同じく扱う)。
 */

import { describe, expect, it } from "vitest";
import type { RaceData } from "@keiba/core/pipeline";
import { buildRaceSnapshot, toSafeRaceSnapshot } from "../src/main/analysis-export.js";

/** グレードの有無だけを変えた最小の RaceData(horses・odds は本テストの関心外)。 */
function raceDataWith(grade: string | undefined): RaceData {
  return {
    raceId: "202603020211",
    race: {
      raceName: "ラジオNIKKEI賞",
      courseType: "芝",
      distance: 1800,
      ...(grade === undefined ? {} : { grade }),
    },
    horses: [],
    odds: { officialDatetime: null, oddsStatus: "result", win: {}, place: {} },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
  } as unknown as RaceData;
}

describe("buildRaceSnapshot(グレード。Issue #250)", () => {
  it("出馬表にグレードがあるとき、スナップショットの race.grade に入ること", () => {
    const snapshot = buildRaceSnapshot(raceDataWith("G3"));
    expect(snapshot.race.grade).toBe("G3");
  });

  it("地方のテキスト(Jpn1)もそのまま入ること", () => {
    expect(buildRaceSnapshot(raceDataWith("Jpn1")).race.grade).toBe("Jpn1");
  });

  it("出馬表にグレードが無いとき、race.grade のキー自体を持たないこと(従来のスナップショットと同じ形)", () => {
    const snapshot = buildRaceSnapshot(raceDataWith(undefined));
    expect("grade" in snapshot.race).toBe(false);
    expect(Object.keys(snapshot.race).sort()).toEqual(
      ["courseType", "distance", "fence", "oddsStatus", "officialDatetime", "raceName", "startTime", "trackCondition", "weather"],
    );
    expect(JSON.stringify(snapshot.race)).not.toContain("grade");
  });
});

describe("toSafeRaceSnapshot(グレード。Issue #250)", () => {
  it("グレード入りで保存したスナップショットから、race.grade を読み出せること(JSON の往復を含む)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceDataWith("J・G2")))) as unknown;
    expect(toSafeRaceSnapshot(stored).race.grade).toBe("J・G2");
  });

  it("グレードを持たない過去のスナップショットは、race.grade が undefined のまま読めること(補い値を作らない)", () => {
    const stored = JSON.parse(JSON.stringify(buildRaceSnapshot(raceDataWith(undefined)))) as unknown;
    const safe = toSafeRaceSnapshot(stored);
    expect(safe.race.raceName).toBe("ラジオNIKKEI賞");
    expect(safe.race.grade).toBeUndefined();
  });
});
