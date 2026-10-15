import { describe, expect, it } from "vitest";
import { courseTurnOf } from "../src/course-turn";

/**
 * Issue #311(レース再生): コースの回り(右・左)の表。raceId の場コードから決める。
 * 中央 10 場は core の `COURSE_TRAITS`(左回りは東京・中京・新潟)、地方は `docs/keibago-zip-investigation.md` §6.6 の実測
 * (左=川崎・浦和・盛岡・船橋。大井は 1650m だけ左。他は右)。不明・不正な raceId は右。
 */

/** 場コード(5〜6桁目)から 12 桁の raceId を作る。 */
const raceIdOf = (trackCode: string): string => `2026${trackCode}020211`;

describe("courseTurnOf(回りの表)", () => {
  const central: ReadonlyArray<readonly [string, string, "right" | "left"]> = [
    ["01", "札幌", "right"],
    ["02", "函館", "right"],
    ["03", "福島", "right"],
    ["04", "新潟", "left"],
    ["05", "東京", "left"],
    ["06", "中山", "right"],
    ["07", "中京", "left"],
    ["08", "京都", "right"],
    ["09", "阪神", "right"],
    ["10", "小倉", "right"],
  ];
  for (const [code, name, turn] of central) {
    it(`中央 ${name}(${code})は ${turn}`, () => {
      expect(courseTurnOf(raceIdOf(code), 1600)).toBe(turn);
    });
  }

  const nar: ReadonlyArray<readonly [string, string, "right" | "left"]> = [
    ["30", "門別", "right"],
    ["35", "盛岡", "left"],
    ["36", "水沢", "right"],
    ["42", "浦和", "left"],
    ["43", "船橋", "left"],
    ["44", "大井", "right"],
    ["45", "川崎", "left"],
    ["46", "金沢", "right"],
    ["47", "笠松", "right"],
    ["48", "名古屋", "right"],
    ["50", "園田", "right"],
    ["51", "姫路", "right"],
    ["54", "高知", "right"],
    ["55", "佐賀", "right"],
  ];
  for (const [code, name, turn] of nar) {
    it(`地方 ${name}(${code})は ${turn}`, () => {
      expect(courseTurnOf(raceIdOf(code), 1400)).toBe(turn);
    });
  }

  it("大井は 1650m だけ左(他の距離は右)", () => {
    expect(courseTurnOf(raceIdOf("44"), 1650)).toBe("left");
    expect(courseTurnOf(raceIdOf("44"), 1600)).toBe("right");
    expect(courseTurnOf(raceIdOf("44"), 1800)).toBe("right");
    expect(courseTurnOf(raceIdOf("44"), null)).toBe("right");
  });

  it("1650m の特例は大井だけ(他の場の 1650m は表のまま)", () => {
    expect(courseTurnOf(raceIdOf("45"), 1650)).toBe("left"); // 川崎は元から左
    expect(courseTurnOf(raceIdOf("54"), 1650)).toBe("right"); // 高知
    expect(courseTurnOf(raceIdOf("06"), 1650)).toBe("right"); // 中山
  });

  it("距離は中央の回りに影響しない(東京は距離 null でも左)", () => {
    expect(courseTurnOf(raceIdOf("05"), null)).toBe("left");
  });

  it("不明な場コード(地方の未知コード 40・範囲外 99)・12桁でない raceId・空文字は右", () => {
    expect(courseTurnOf(raceIdOf("40"), 1600)).toBe("right");
    expect(courseTurnOf(raceIdOf("99"), 1600)).toBe("right");
    expect(courseTurnOf("12345", 1600)).toBe("right");
    expect(courseTurnOf("", null)).toBe("right");
    // 場コード(5〜6桁目)が東京(05)でも、12桁でなければ右(桁数・数字の検査が効いている)
    expect(courseTurnOf("2026050211", 1600)).toBe("right"); // 10桁
    expect(courseTurnOf("2026050211000", 1600)).toBe("right"); // 13桁
    expect(courseTurnOf("202605abcdef", 1600)).toBe("right"); // 数字でない
  });
});
