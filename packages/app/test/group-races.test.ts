import { describe, expect, it } from "vitest";

import { groupRacesByVenue } from "../src/renderer/group-races.js";
import type { RaceListItem } from "../src/shared/analysis-types.js";

const race = (venue: string | null, raceNumber: number): RaceListItem => ({
  raceId: `2026050208${String(raceNumber).padStart(2, "0")}`,
  name: `${raceNumber}R`,
  courseType: "芝",
  distance: 1600,
  entryCount: 12,
  venue,
  raceNumber,
});

describe("groupRacesByVenue(会場ごとのグループ化)", () => {
  it("会場ごとにまとめ、初出の会場順を保つ", () => {
    const races = [
      race("東京", 1),
      race("中山", 1),
      race("東京", 2),
      race("中山", 2),
    ];
    const groups = groupRacesByVenue(races);
    expect(groups.map((g) => g.venue)).toEqual(["東京", "中山"]);
    expect(groups[0]!.races.map((r) => r.raceNumber)).toEqual([1, 2]);
    expect(groups[1]!.races.map((r) => r.raceNumber)).toEqual([1, 2]);
  });

  it("各グループ内はレース番号昇順に並べる", () => {
    const races = [race("東京", 11), race("東京", 1), race("東京", 5)];
    const groups = groupRacesByVenue(races);
    expect(groups[0]!.races.map((r) => r.raceNumber)).toEqual([1, 5, 11]);
  });

  it("会場名が無い(null)場合は「不明」でまとめる", () => {
    const groups = groupRacesByVenue([race(null, 1)]);
    expect(groups[0]!.venue).toBe("不明");
  });

  it("空配列は空配列を返す", () => {
    expect(groupRacesByVenue([])).toEqual([]);
  });
});
