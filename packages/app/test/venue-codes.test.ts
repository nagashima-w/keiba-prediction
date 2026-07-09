import { describe, expect, it } from "vitest";

import { venueNameFromRaceId, VENUE_BY_TRACK_CODE } from "../src/main/venue-codes.js";

describe("venueNameFromRaceId(レースIDから会場名を導出)", () => {
  it("場コード(5〜6桁目)から中央10場の会場名を返す", () => {
    // 202605020811 → 場コード05 → 東京。
    expect(venueNameFromRaceId("202605020811")).toBe("東京");
    // 場コード06 → 中山。
    expect(venueNameFromRaceId("202606010101")).toBe("中山");
    // 場コード01 → 札幌。
    expect(venueNameFromRaceId("202601010101")).toBe("札幌");
    // 場コード10 → 小倉。
    expect(venueNameFromRaceId("202610010112")).toBe("小倉");
  });

  it("マッピングは中央10場すべてを網羅する", () => {
    const expected = [
      "札幌",
      "函館",
      "福島",
      "新潟",
      "東京",
      "中山",
      "中京",
      "京都",
      "阪神",
      "小倉",
    ];
    expect([...VENUE_BY_TRACK_CODE.values()]).toEqual(expected);
    expect(VENUE_BY_TRACK_CODE.size).toBe(10);
  });

  it("12桁でない/場コードが範囲外の入力は例外を投げる", () => {
    expect(() => venueNameFromRaceId("2026")).toThrow();
    // 場コード11(範囲外)。
    expect(() => venueNameFromRaceId("202611010101")).toThrow();
    // 場コード00(範囲外)。
    expect(() => venueNameFromRaceId("202600010101")).toThrow();
  });
});
