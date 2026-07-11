import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeRaceEv } from "../../src/ev/expected-value.js";
import { OddsParseError, parseOdds } from "../../src/scraper/parse-odds.js";
import type { OddsSnapshot } from "../../src/scraper/types.js";

/** フィクスチャ(JSON文字列)を読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const odds: OddsSnapshot = parseOdds(loadFixture("odds_202603020211.json"));

describe("parseOdds(実データの抽出)", () => {
  it("確定時刻を抽出すること", () => {
    expect(odds.officialDatetime).toBe("2026-06-28 15:52:30");
  });

  it("16頭分の単勝・複勝が馬番キー(数値)で引けること", () => {
    expect(Object.keys(odds.win)).toHaveLength(16);
    expect(Object.keys(odds.place)).toHaveLength(16);
  });

  it("馬番1の単勝(9.0倍・5番人気)を抽出すること", () => {
    expect(odds.win[1]).toEqual({ odds: 9.0, ninki: 5 });
  });

  it("馬番1の複勝(下限3.1・上限4.1・5番人気)を抽出すること", () => {
    expect(odds.place[1]).toEqual({ oddsMin: 3.1, oddsMax: 4.1, ninki: 5 });
  });

  it("馬番キーは2桁ゼロ埋め(01)ではなく数値(1)であること", () => {
    // "01" のような文字列キーではアクセスできず、数値キーで引ける。
    expect(odds.win[13]).toEqual({ odds: 5.4, ninki: 1 });
  });

  it('確定(result)は oddsStatus="result" になること', () => {
    expect(odds.oddsStatus).toBe("result");
  });
});

describe("parseOdds(status: middle 発売中)", () => {
  const middle: OddsSnapshot = parseOdds(
    loadFixture("odds_middle_202603020611.json"),
  );

  it('発売中(middle)は oddsStatus="middle" になること', () => {
    expect(middle.oddsStatus).toBe("middle");
  });

  it("確定時刻を抽出すること", () => {
    expect(middle.officialDatetime).toBe("2026-07-11 16:40:16");
  });

  it("単勝16頭・複勝16頭が引けること", () => {
    expect(Object.keys(middle.win)).toHaveLength(16);
    expect(Object.keys(middle.place)).toHaveLength(16);
  });

  it("複勝の実値(馬番11: 下限1.6・上限1.9・1番人気)を抽出すること", () => {
    expect(middle.place[11]).toEqual({ oddsMin: 1.6, oddsMax: 1.9, ninki: 1 });
  });

  it('単勝の第2要素が "0"(確定前のプレースホルダ)でも単勝オッズは壊れないこと', () => {
    // middle の単勝セルは [オッズ, "0", 人気] 形式。第2要素は単勝では未使用。
    expect(middle.win[4]).toEqual({ odds: 4.6, ninki: 1 });
  });
});

describe("parseOdds(status: yoso 予想オッズ・複勝未発売)", () => {
  const yoso: OddsSnapshot = parseOdds(
    loadFixture("odds_yoso_202602011011.json"),
  );

  it('予想オッズ(yoso)は oddsStatus="yoso" になること', () => {
    expect(yoso.oddsStatus).toBe("yoso");
  });

  it("複勝(odds[2])が無くてもエラーにせず place は空オブジェクトになること", () => {
    expect(yoso.place).toEqual({});
  });

  it("単勝14頭を抽出すること", () => {
    expect(Object.keys(yoso.win)).toHaveLength(14);
  });

  it('単勝の第2要素が空文字("")でも単勝オッズは壊れないこと(馬番9: 5.1倍・1番人気)', () => {
    expect(yoso.win[9]).toEqual({ odds: 5.1, ninki: 1 });
  });

  it("複勝が空のため computeRaceEv は全馬を理由付きで対象外にすること", () => {
    const priors = Object.keys(yoso.win).map((k) => ({
      umaban: Number(k),
      placeProb: 0.3,
    }));
    const evs = computeRaceEv(priors, yoso);
    expect(evs).toHaveLength(14);
    for (const ev of evs) {
      expect(ev.ev).toBeNull();
      expect(ev.isPositive).toBe(false);
      expect(ev.excludedReason).not.toBeNull();
    }
  });
});

describe("parseOdds(未確定・非数値の許容)", () => {
  it('単勝オッズが "---.-" の場合は odds が null になること', () => {
    const json = buildOddsJson({
      win: { "01": ["---.-", "0.0", "0"] },
      place: { "01": ["3.1", "4.1", "5"] },
    });
    const r = parseOdds(json);
    expect(r.win[1]!.odds).toBeNull();
  });

  it("複勝の下限・上限が非数値の場合はそれぞれ null になること", () => {
    const json = buildOddsJson({
      win: { "01": ["9.0", "0.0", "5"] },
      place: { "01": ["**.*", "**.*", "0"] },
    });
    const r = parseOdds(json);
    expect(r.place[1]).toEqual({ oddsMin: null, oddsMax: null, ninki: 0 });
  });
});

describe("parseOdds(馬番の範囲検証)", () => {
  it('馬番 "00" は不正データとして OddsParseError になること', () => {
    const json = buildOddsJson({
      win: { "00": ["9.0", "0.0", "5"] },
      place: { "00": ["3.1", "4.1", "5"] },
    });
    expect(() => parseOdds(json)).toThrow(OddsParseError);
  });

  it('馬番 "19" は不正データとして OddsParseError になること(上限18)', () => {
    const json = buildOddsJson({
      win: { "19": ["9.0", "0.0", "5"] },
      place: { "19": ["3.1", "4.1", "5"] },
    });
    expect(() => parseOdds(json)).toThrow(OddsParseError);
  });
});

describe("parseOdds(構造・status異常)", () => {
  it("JSONとして解釈できない入力は OddsParseError になること", () => {
    expect(() => parseOdds("<html>これはJSONではない")).toThrow(OddsParseError);
  });

  it("未知の status(result/middle/yoso 以外)は OddsParseError になること", () => {
    const json = JSON.stringify({
      status: "error",
      data: { official_datetime: "", odds: { "1": {}, "2": {} } },
    });
    expect(() => parseOdds(json)).toThrow(OddsParseError);
  });

  it("複勝(odds[2])が欠落している場合は OddsParseError になること(result)", () => {
    const json = JSON.stringify({
      status: "result",
      data: {
        official_datetime: "2026-06-28 15:52:30",
        odds: { "1": { "01": ["9.0", "0.0", "5"] } },
      },
    });
    expect(() => parseOdds(json)).toThrow(OddsParseError);
  });

  it("複勝(odds[2])が欠落している場合は OddsParseError になること(middle・複勝欠落は許容しない)", () => {
    // yoso のみ複勝欠落を許容する。middle は複勝が揃う状態のため欠落は構造異常として失敗させる。
    const json = JSON.stringify({
      status: "middle",
      data: {
        official_datetime: "2026-07-11 16:40:16",
        odds: { "1": { "01": ["9.0", "0", "5"] } },
      },
    });
    expect(() => parseOdds(json)).toThrow(OddsParseError);
  });
});

/**
 * オッズAPIレスポンス(JSON文字列)を組み立てる。境界値(未確定・範囲外馬番)検証用。
 */
function buildOddsJson(opts: {
  win: Record<string, [string, string, string]>;
  place: Record<string, [string, string, string]>;
}): string {
  return JSON.stringify({
    status: "result",
    data: {
      official_datetime: "2026-06-28 15:52:30",
      odds: { "1": opts.win, "2": opts.place },
    },
  });
}
