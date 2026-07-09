import { parseRaceId, type RaceListEntry } from "@keiba/core";
import { describe, expect, it } from "vitest";

import { toRaceListItem } from "../src/main/to-race-list-item.js";

describe("toRaceListItem(レース一覧要約の変換)", () => {
  const base: RaceListEntry = {
    raceId: parseRaceId("202605020811"),
    name: "テスト特別",
    courseType: "芝",
    distance: 1600,
    entryCount: 12,
    venue: "東京",
    raceNumber: 11,
  };

  it("RaceListEntry をそのまま平坦化する", () => {
    expect(toRaceListItem(base)).toEqual({
      raceId: "202605020811",
      name: "テスト特別",
      courseType: "芝",
      distance: 1600,
      entryCount: 12,
      venue: "東京",
      raceNumber: 11,
    });
  });

  it("venue 未定義(undefined)は null に正規化する(IPCで欠落させないため)", () => {
    const { venue, ...rest } = base;
    void venue;
    const item = toRaceListItem(rest as RaceListEntry);
    expect(item.venue).toBeNull();
  });
});
