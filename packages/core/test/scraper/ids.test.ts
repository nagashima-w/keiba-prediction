import { describe, expect, it } from "vitest";
import {
  InvalidIdError,
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
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
  });
});
