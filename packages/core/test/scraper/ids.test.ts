import { describe, expect, it } from "vitest";
import {
  centralVenueInfoFromRaceId,
  InvalidIdError,
  kaisaiDateFromNarRaceId,
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  siblingRaceIdsSameDay,
  venueKindOfRaceId,
} from "../../src/scraper/ids.js";

describe("parseRaceId(レースIDのパースと検証)", () => {
  it("正当な12桁のレースIDをそのままの文字列として返すこと", () => {
    const id = parseRaceId("202605020811");
    expect(id).toBe("202605020811");
  });

  describe("桁数の境界値", () => {
    // [入力, 期待: 有効か]
    const cases: Array<[string, boolean]> = [
      ["202605020811", true], // 12桁ちょうど
      ["20260502081", false], // 11桁
      ["2026050208111", false], // 13桁
      ["", false], // 空文字
    ];
    it.each(cases)("入力%sの有効性が%sであること", (input, valid) => {
      if (valid) {
        expect(parseRaceId(input)).toBe(input);
      } else {
        expect(() => parseRaceId(input)).toThrow(InvalidIdError);
      }
    });
  });

  it("非数字を含む場合はエラーを投げること", () => {
    expect(() => parseRaceId("20260502081a")).toThrow(InvalidIdError);
    expect(() => parseRaceId("2026-5020811")).toThrow(InvalidIdError);
  });

  describe("競馬場コード(5〜6桁目)の範囲01〜10", () => {
    // [レースID, 有効か]
    const cases: Array<[string, boolean]> = [
      ["202600020811", false], // コード00
      ["202601020811", true], // コード01(下限)
      ["202610020811", true], // コード10(上限)
      ["202611020811", false], // コード11
    ];
    it.each(cases)("%sの有効性が%sであること", (input, valid) => {
      if (valid) {
        expect(parseRaceId(input)).toBe(input);
      } else {
        expect(() => parseRaceId(input)).toThrow(InvalidIdError);
      }
    });
  });

  describe("レース番号(11〜12桁目)の範囲01〜12", () => {
    // [レースID, 有効か]
    const cases: Array<[string, boolean]> = [
      ["202605020800", false], // レース00
      ["202605020801", true], // レース01(下限)
      ["202605020812", true], // レース12(上限)
      ["202605020813", false], // レース13
    ];
    it.each(cases)("%sの有効性が%sであること", (input, valid) => {
      if (valid) {
        expect(parseRaceId(input)).toBe(input);
      } else {
        expect(() => parseRaceId(input)).toThrow(InvalidIdError);
      }
    });
  });

  it("エラーメッセージに不正の理由が含まれること", () => {
    expect(() => parseRaceId("202611020811")).toThrow(/競馬場コード/);
    expect(() => parseRaceId("202605020813")).toThrow(/レース番号/);
    expect(() => parseRaceId("20260502081")).toThrow(/12桁/);
  });

  describe("地方競馬場コード(5〜6桁目)の範囲30〜64", () => {
    // [レースID, 有効か, 補足]
    const cases: Array<[string, boolean, string]> = [
      ["202629071201", false, "コード29は中央でも地方でもない"],
      ["202630071201", true, "コード30(地方の下限)"],
      ["202654071210", true, "コード54=高知(実測値)"],
      ["202664071201", true, "コード64(地方の上限)"],
      ["202666071201", false, "コード66は地方の上限(64)を超える"],
    ];
    it.each(cases)("%s → 有効性%s(%s)", (input, valid) => {
      if (valid) {
        expect(parseRaceId(input)).toBe(input);
      } else {
        expect(() => parseRaceId(input)).toThrow(InvalidIdError);
      }
    });
  });

  describe("帯広(ばんえい競馬・コード65)は明示的に拒否", () => {
    it("コード65はInvalidIdErrorになり、理由にばんえい/帯広が含まれること", () => {
      expect(() => parseRaceId("202665071201")).toThrow(InvalidIdError);
      expect(() => parseRaceId("202665071201")).toThrow(/ばんえい|帯広/);
    });
  });

  describe("地方レースIDの月日部(7〜10桁目)は実在日として検証する", () => {
    // [レースID, 有効か, 補足]
    const cases: Array<[string, boolean, string]> = [
      ["202654071210", true, "7月12日は実在する(高知10R実測値)"],
      ["202654130101", false, "13月は不正"],
      ["202654000101", false, "0月は不正"],
      ["202654023001", false, "2月30日は常に不正(2026年は平年)"],
      ["202454022901", true, "2024年は閏年なので2月29日は正当"],
      ["202654022901", false, "2026年は平年なので2月29日は不正"],
      ["202654063001", true, "6月30日は実在する"],
      ["202654063101", false, "6月は30日までなので31日は不正"],
    ];
    it.each(cases)("%s → 有効性%s(%s)", (input, valid) => {
      if (valid) {
        expect(parseRaceId(input)).toBe(input);
      } else {
        expect(() => parseRaceId(input)).toThrow(InvalidIdError);
      }
    });
  });

  describe("中央レースIDの7〜10桁目は回次・日次であり、実在日検証の対象外", () => {
    it("中央コード(01〜10)では7〜10桁目が実在日でなくても有効であること", () => {
      // 202605130811: 場コード05・7〜8桁目=13(13月相当だが中央は回次のため無関係)。
      expect(parseRaceId("202605130811")).toBe("202605130811");
    });
  });
});

describe("venueKindOfRaceId(レースIDから開催区分を判定)", () => {
  it("中央(場コード01〜10)は\"central\"を返すこと", () => {
    expect(venueKindOfRaceId(parseRaceId("202605020811"))).toBe("central");
  });

  it("地方(場コード30〜64)は\"nar\"を返すこと", () => {
    expect(venueKindOfRaceId(parseRaceId("202654071210"))).toBe("nar");
  });
});

describe("siblingRaceIdsSameDay(同一場・同一開催日の兄弟レースID列挙、タスク#27-C)", () => {
  it("中央: 先頭10桁を保ったまま01〜12を列挙し、自レース番号(11)を除外すること", () => {
    const siblings = siblingRaceIdsSameDay(parseRaceId("202605020811"));
    expect(siblings).toEqual([
      "202605020801",
      "202605020802",
      "202605020803",
      "202605020804",
      "202605020805",
      "202605020806",
      "202605020807",
      "202605020808",
      "202605020809",
      "202605020810",
      "202605020812",
    ]);
    expect(siblings).not.toContain("202605020811");
  });

  it("地方: 先頭10桁(場コード+月日)を保ったまま01〜12を列挙し、自レース番号(10)を除外すること", () => {
    const siblings = siblingRaceIdsSameDay(parseRaceId("202654071210"));
    expect(siblings).toEqual([
      "202654071201",
      "202654071202",
      "202654071203",
      "202654071204",
      "202654071205",
      "202654071206",
      "202654071207",
      "202654071208",
      "202654071209",
      "202654071211",
      "202654071212",
    ]);
    expect(siblings).not.toContain("202654071210");
  });

  it("自レース番号が01(先頭)のときも01を除外し、02〜12のみ返すこと(境界値)", () => {
    const siblings = siblingRaceIdsSameDay(parseRaceId("202605020801"));
    expect(siblings).toHaveLength(11);
    expect(siblings[0]).toBe("202605020802");
    expect(siblings).not.toContain("202605020801");
  });

  it("自レース番号が12(末尾)のときも12を除外し、01〜11のみ返すこと(境界値)", () => {
    const siblings = siblingRaceIdsSameDay(parseRaceId("202605020812"));
    expect(siblings).toHaveLength(11);
    expect(siblings[siblings.length - 1]).toBe("202605020811");
    expect(siblings).not.toContain("202605020812");
  });

  it("常にレース番号昇順(決定論的な順序)で返すこと", () => {
    const siblings = siblingRaceIdsSameDay(parseRaceId("202605020811"));
    const raceNumbers = siblings.map((id) => Number(id.slice(10, 12)));
    expect(raceNumbers).toEqual([...raceNumbers].sort((a, b) => a - b));
  });

  it("戻り値の各要素が parseRaceId を通過済みの妥当なレースIDであること", () => {
    const siblings = siblingRaceIdsSameDay(parseRaceId("202654071210"));
    for (const id of siblings) {
      expect(() => parseRaceId(id)).not.toThrow();
    }
  });
});

describe("kaisaiDateFromNarRaceId(地方レースIDから開催日を導出)", () => {
  it("地方(場コード30〜64)のレースIDから開催日(YYYYMMDD)を導出すること", () => {
    // 場コード54 → 高知。7〜10桁目 0712 → 7月12日。
    expect(kaisaiDateFromNarRaceId("202654071210")).toBe("20260712");
  });

  describe("地方場コードの境界値(30・64)でも開催日を導出できること", () => {
    // [レースID, 期待する開催日, 補足]
    const cases: Array<[string, string, string]> = [
      ["202630071201", "20260712", "コード30(地方の下限)"],
      ["202664071201", "20260712", "コード64(地方の上限)"],
    ];
    it.each(cases)("%s → %s(%s)", (raceId, expected) => {
      expect(kaisaiDateFromNarRaceId(raceId)).toBe(expected);
    });
  });

  it("中央(場コード01〜10)のレースIDはnullを返すこと(回次・日次からは日付を復元できない)", () => {
    expect(kaisaiDateFromNarRaceId("202605020811")).toBeNull();
  });

  it("12桁の数字でない入力はnullを返すこと", () => {
    expect(kaisaiDateFromNarRaceId("2026540712101")).toBeNull(); // 13桁
    expect(kaisaiDateFromNarRaceId("20265407121")).toBeNull(); // 11桁
    expect(kaisaiDateFromNarRaceId("20265407121a")).toBeNull(); // 非数字混在
  });

  it("場コードが地方の範囲(30〜64)外(帯広65含む)ならnullを返すこと", () => {
    expect(kaisaiDateFromNarRaceId("202665071210")).toBeNull(); // 帯広(ばんえい)
    expect(kaisaiDateFromNarRaceId("202629071210")).toBeNull(); // 範囲外(29)
    expect(kaisaiDateFromNarRaceId("202665071265")).toBeNull(); // 65
  });

  it("月日部が暦として実在しない場合はnullを返すこと(既存のKaisaiDate検証を再利用)", () => {
    expect(kaisaiDateFromNarRaceId("202654133201")).toBeNull(); // 13月32日は存在しない
    expect(kaisaiDateFromNarRaceId("202654023001")).toBeNull(); // 2026年2月30日は存在しない(平年)
  });

  it("閏年の2月29日は有効な開催日として導出すること", () => {
    // 2024年は閏年。場コード54(高知)の2月29日。
    expect(kaisaiDateFromNarRaceId("202454022901")).toBe("20240229");
  });
});

describe("centralVenueInfoFromRaceId(中央レースIDから開催情報を導出)", () => {
  it("中央レースIDから場コード・回次・日次を2桁ゼロ埋め文字列で導出すること", () => {
    // 202605020811 → 場コード05・回次02・日次08(11R)。
    expect(centralVenueInfoFromRaceId("202605020811")).toEqual({
      trackCode: "05",
      round: "02",
      day: "08",
    });
  });

  it("回次・日次が1桁相当の値でも2桁ゼロ埋め文字列のまま保持すること(P3のレースID再構築で桁を誤らないため)", () => {
    // 202601010109 → 場コード01・回次01・日次01。
    expect(centralVenueInfoFromRaceId("202601010109")).toEqual({
      trackCode: "01",
      round: "01",
      day: "01",
    });
  });

  describe("中央場コードの境界値(01・10)でも開催情報を導出できること", () => {
    // [レースID, 期待する開催情報, 補足]
    const cases: Array<
      [string, { trackCode: string; round: string; day: string }, string]
    > = [
      ["202601020811", { trackCode: "01", round: "02", day: "08" }, "コード01(中央の下限)"],
      ["202610020811", { trackCode: "10", round: "02", day: "08" }, "コード10(中央の上限)"],
    ];
    it.each(cases)("%s → %j(%s)", (raceId, expected) => {
      expect(centralVenueInfoFromRaceId(raceId)).toEqual(expected);
    });
  });

  it("地方(場コード30〜64)のレースIDはnullを返すこと(対象外)", () => {
    expect(centralVenueInfoFromRaceId("202654071210")).toBeNull();
  });

  it("12桁の数字でない・場コード不正など parseRaceId が拒否する入力はnullを返すこと", () => {
    expect(centralVenueInfoFromRaceId("2026050208111")).toBeNull(); // 13桁
    expect(centralVenueInfoFromRaceId("20260502081")).toBeNull(); // 11桁
    expect(centralVenueInfoFromRaceId("202611020811")).toBeNull(); // 場コード11(中央でも地方でもない)
    expect(centralVenueInfoFromRaceId("202605020813")).toBeNull(); // レース番号13は不正
  });

  it("回次・日次が「00」等の異常桁でも、parseRaceIdが回次・日次の範囲を検証しないため例外にせずそのまま返すこと", () => {
    // parseRaceId は場コード・レース番号のみ検証し、回次・日次(7〜10桁目)の範囲は検証しない
    // (ids.ts のコメント参照)。本関数もその検証方針を踏襲し、独自の範囲チェックを追加しない
    // (検証ロジックの二重管理を避けるため)。202601000811 → 回次00・日次08。
    expect(centralVenueInfoFromRaceId("202601000811")).toEqual({
      trackCode: "01",
      round: "00",
      day: "08",
    });
  });
});

describe("parseKaisaiDate(開催日のパースと検証)", () => {
  it("正当な8桁の開催日をそのままの文字列として返すこと", () => {
    expect(parseKaisaiDate("20260628")).toBe("20260628");
  });

  describe("桁数・数字の検証", () => {
    // [入力, 有効か]
    const cases: Array<[string, boolean]> = [
      ["20260628", true], // 8桁ちょうど
      ["2026062", false], // 7桁
      ["202606280", false], // 9桁
      ["2026062a", false], // 非数字
    ];
    it.each(cases)("入力%sの有効性が%sであること", (input, valid) => {
      if (valid) {
        expect(parseKaisaiDate(input)).toBe(input);
      } else {
        expect(() => parseKaisaiDate(input)).toThrow(InvalidIdError);
      }
    });
  });

  describe("実在日チェック(月・日の範囲、閏年判定)", () => {
    // [開催日, 有効か, 補足]
    const cases: Array<[string, boolean, string]> = [
      ["20260229", false, "2026年は平年なので2月29日は不正"],
      ["20240229", true, "2024年は閏年なので2月29日は正当"],
      ["20260230", false, "2月30日は常に不正"],
      ["19000229", false, "1900年は100で割れて400で割れないため平年"],
      ["20000229", true, "2000年は400で割れるため閏年"],
      ["20261301", false, "13月は不正"],
      ["20260001", false, "0月は不正"],
      ["20260600", false, "0日は不正"],
      ["20260631", false, "6月は30日までなので31日は不正"],
      ["20260630", true, "6月30日は正当"],
      ["20261231", true, "12月31日は正当"],
    ];
    it.each(cases)("%s → 有効性%s(%s)", (input, valid) => {
      if (valid) {
        expect(parseKaisaiDate(input)).toBe(input);
      } else {
        expect(() => parseKaisaiDate(input)).toThrow(InvalidIdError);
      }
    });
  });
});

describe("parseHorseId(馬IDのパースと検証)", () => {
  it("正当な10桁の馬IDをそのままの文字列として返すこと", () => {
    expect(parseHorseId("2019105219")).toBe("2019105219");
  });

  describe("桁数・数字の境界値", () => {
    // [入力, 有効か]
    const cases: Array<[string, boolean]> = [
      ["2019105219", true], // 10桁ちょうど
      ["201910521", false], // 9桁
      ["20191052199", false], // 11桁
      ["201910521a", false], // 非数字
    ];
    it.each(cases)("入力%sの有効性が%sであること", (input, valid) => {
      if (valid) {
        expect(parseHorseId(input)).toBe(input);
      } else {
        expect(() => parseHorseId(input)).toThrow(InvalidIdError);
      }
    });
  });
});

describe("公開API(index.tsからの再エクスポート)", () => {
  it("パース関数とエラークラスがindexから再エクスポートされていること", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.parseRaceId).toBe(parseRaceId);
    expect(mod.parseKaisaiDate).toBe(parseKaisaiDate);
    expect(mod.parseHorseId).toBe(parseHorseId);
    expect(mod.InvalidIdError).toBe(InvalidIdError);
    expect(mod.venueKindOfRaceId).toBe(venueKindOfRaceId);
    expect(mod.centralVenueInfoFromRaceId).toBe(centralVenueInfoFromRaceId);
    expect(mod.siblingRaceIdsSameDay).toBe(siblingRaceIdsSameDay);
  });
});
