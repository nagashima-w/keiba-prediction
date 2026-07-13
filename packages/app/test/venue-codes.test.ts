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

describe("venueNameFromRaceId(NAR: 地方場コードの会場名導出)", () => {
  it("実測済みのNAR場コード(30〜64)から地方競馬場名を返す", () => {
    // 202654071210 → 2026年・場コード54・7月12日・10R(docs/nar-scraping-plan.mdの実例)。
    expect(venueNameFromRaceId("202630071210")).toBe("門別");
    expect(venueNameFromRaceId("202635071210")).toBe("盛岡");
    expect(venueNameFromRaceId("202636071210")).toBe("水沢");
    expect(venueNameFromRaceId("202642071210")).toBe("浦和");
    expect(venueNameFromRaceId("202643071210")).toBe("船橋");
    expect(venueNameFromRaceId("202644071210")).toBe("大井");
    expect(venueNameFromRaceId("202645071210")).toBe("川崎");
    expect(venueNameFromRaceId("202646071210")).toBe("金沢");
    expect(venueNameFromRaceId("202647071210")).toBe("笠松");
    expect(venueNameFromRaceId("202648071210")).toBe("名古屋");
    expect(venueNameFromRaceId("202650071210")).toBe("園田");
    expect(venueNameFromRaceId("202651071210")).toBe("姫路");
    expect(venueNameFromRaceId("202654071210")).toBe("高知");
    expect(venueNameFromRaceId("202655071210")).toBe("佐賀");
  });

  it("未知の地方場コード(30〜64の範囲内だが対応表にない)はフォールバック表示名になる", () => {
    // 31は表に無い(門別=30の次)。範囲内(30〜64)だが未実測のため「地方(コードNN)」にフォールバックする。
    expect(venueNameFromRaceId("202631071210")).toBe("地方(コード31)");
    // 64も未実測の場コード(範囲上限)。
    expect(venueNameFromRaceId("202664071210")).toBe("地方(コード64)");
  });

  it("範囲外(11〜29・65以上)は引き続き例外を投げる", () => {
    // 帯広(ばんえい・65)はそり曳きで平地競走ではないため対象外。
    expect(() => venueNameFromRaceId("202665071210")).toThrow();
    // 中央・地方いずれの範囲にも属さない11〜29。
    expect(() => venueNameFromRaceId("202629071210")).toThrow();
    expect(() => venueNameFromRaceId("202611010101")).toThrow();
  });
});
