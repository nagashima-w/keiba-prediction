import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { NewspaperParseError, parseNewspaperResponse, PREV_WEIGHT_TYPES } from "../../src/scraper/parse-newspaper.js";
import { WEIGHT_TYPES } from "../../src/scraper/race-condition.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #421 段階 1-b: 新聞形式の API(AplNewsPaper)の応答から、前走の条件(負担重量の種別・条件の文言・牝馬限定)を読む。
 *
 * 期待値の件数・値は、フィクスチャの展開後 JSON を別の手段(python)で数えた値で、実装の出力の転記ではない:
 *  - 中央(秋華賞 202608040711): 17 頭・race_id のある行 111 → 重複を除いて 88 件(牝馬限定 47・そうでない 41)。z_blank 9・z_brother 5 の非レース要素を除く。
 *  - 地方(サマーチャンピオン 202655090311): 9 頭・284 行 → 12 桁の数字の race_id で重複を除いて 270 件(海外の `2026P0010105` を除く)。
 *    牝馬限定 true 4・false 105・null(条件の文言が空)161。
 */

/** 1 行(1 走)の合成。`kigou`・`jyuryo` は [コード, 表示, ""] の 3 要素。 */
function row(raceId: string, kigou: string, jyuryo: string): Record<string, unknown> {
  return { race_id: [raceId, raceId, ""], kigou: ["X", kigou, ""], jyuryo: ["0", jyuryo, ""] };
}

/** horses(各馬の race_result)を、API の応答の形(status/data の base64+zlib)にする。 */
function makeResponse(horses: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, overrides: Record<string, unknown> = {}): string {
  const decoded = horses.map((rr, i) => ({ horse_id: String(2020100000 + i), race_result: rr }));
  const encoded = deflateSync(Buffer.from(JSON.stringify(decoded), "utf-8")).toString("base64");
  return JSON.stringify({ status: "OK", reason: null, data: { "nkrace_newspaper::202608040711": encoded, "nkrace_newspaper::202608040711_last_dt": "2026-10-19 16:03:38" }, ...overrides });
}

describe("語彙", () => {
  it("PREV_WEIGHT_TYPES は WEIGHT_TYPES(出馬表の 4 語)に『見込』を足したもの。WEIGHT_TYPES 自体は広げない", () => {
    expect([...PREV_WEIGHT_TYPES]).toEqual([...WEIGHT_TYPES, "見込"]);
    expect([...WEIGHT_TYPES]).not.toContain("見込");
  });
});

describe("parseNewspaperResponse: 実フィクスチャ(中央・秋華賞)", () => {
  const table = parseNewspaperResponse(loadFixture("newspaper_api_202608040711.json"));
  const values = Object.values(table);

  it("race_id のある行を重複を除いて 88 件にする(z_blank・z_brother は含まれない)", () => {
    expect(Object.keys(table)).toHaveLength(88);
    for (const key of Object.keys(table)) {
      expect(key).toMatch(/^\d{12}$/);
    }
  });

  it("牝馬限定は 47 件・そうでないものが 41 件で、null は 0 件(中央の行は条件の文言がある)", () => {
    expect(values.filter((v) => v.filliesOnly === true)).toHaveLength(47);
    expect(values.filter((v) => v.filliesOnly === false)).toHaveLength(41);
    expect(values.filter((v) => v.filliesOnly === null)).toHaveLength(0);
  });

  it("ローズS(202609040411): 国際・牝馬限定・馬齢。条件の文言は空白を除いた形", () => {
    expect(table["202609040411"]).toEqual({ weightType: "馬齢", condition: "(国際)牝(指)", filliesOnly: true });
  });

  it("紫苑S(202606040211)も同じ(2 つ目の独立した標本)", () => {
    expect(table["202606040211"]).toEqual({ weightType: "馬齢", condition: "(国際)牝(指)", filliesOnly: true });
  });

  it("納屋橋特別(202607020506): 混合・指定・定量・牝馬限定でない(『混』を牝と取り違えない)", () => {
    expect(table["202607020506"]).toEqual({ weightType: "定量", condition: "(混)[指]", filliesOnly: false });
  });

  it("メルボルンT(202608030909): 馬齢・牝馬限定でない", () => {
    expect(table["202608030909"]).toEqual({ weightType: "馬齢", condition: "(混)(特指)", filliesOnly: false });
  });

  it("負担重量の種別の内訳(race_id の重複を除いた後): 別定 5・定量 20・馬齢 63(合計 88)", () => {
    const count = (w: string) => values.filter((v) => v.weightType === w).length;
    // 重複除去後: 別定 3+2=5、定量 11+9=20、馬齢 33+30=63(合計 88)。ハンデ・見込は無い。
    expect(count("別定")).toBe(5);
    expect(count("定量")).toBe(20);
    expect(count("馬齢")).toBe(63);
    expect(count("ハンデ")).toBe(0);
    expect(count("見込")).toBe(0);
  });
});

describe("parseNewspaperResponse: 実フィクスチャ(地方・サマーチャンピオン)", () => {
  const table = parseNewspaperResponse(loadFixture("newspaper_api_nar_202655090311.json"));
  const values = Object.values(table);

  it("12 桁の数字の race_id だけを重複を除いて 270 件にする(海外の 2026P0010105 は含まれない)", () => {
    expect(Object.keys(table)).toHaveLength(270);
    expect(table["2026P0010105"]).toBeUndefined();
  });

  it("牝馬限定は true 4・false 105・null 161(合計 270)", () => {
    expect(values.filter((v) => v.filliesOnly === true)).toHaveLength(4);
    expect(values.filter((v) => v.filliesOnly === false)).toHaveLength(105);
    expect(values.filter((v) => v.filliesOnly === null)).toHaveLength(161);
  });

  it("地方のレース(条件の文言が空)は condition=null・filliesOnly=null で、負担重量の種別だけが入る", () => {
    // 202555090411: 地方・ハンデ・kigou 空
    expect(table["202555090411"]).toEqual({ weightType: "ハンデ", condition: null, filliesOnly: null });
  });

  it("地方馬が走った中央のレースは、条件の文言があり牝馬限定の判定もできる(地方の応答でも中央の行は null にしない)", () => {
    expect(table["202603020411"]).toEqual({ weightType: "ハンデ", condition: "(国際)(特指)", filliesOnly: false });
  });

  it("『見込』は語彙に入る(202554080209)", () => {
    expect(table["202554080209"]).toEqual({ weightType: "見込", condition: null, filliesOnly: null });
  });

  it("jyuryo が空のレース(202343011911)は weightType=null(推測しない)", () => {
    expect(table["202343011911"]).toEqual({ weightType: null, condition: null, filliesOnly: null });
  });

  it("負担重量の種別の内訳: ハンデ 32・別定 93・定量 46・馬齢 72・見込 1・null 26(合計 270)", () => {
    const count = (w: string | null) => values.filter((v) => v.weightType === w).length;
    expect(count("ハンデ")).toBe(32);
    expect(count("別定")).toBe(93);
    expect(count("定量")).toBe(46);
    expect(count("馬齢")).toBe(72);
    expect(count("見込")).toBe(1);
    expect(count(null)).toBe(26);
  });
});

describe("parseNewspaperResponse: 合成入力", () => {
  it("空白(半角・全角)を除いた文言にする。空白だけの文言は condition=null", () => {
    const table = parseNewspaperResponse(
      makeResponse([[row("202601010101", "(国際) 牝(指)", "馬齢"), row("202601010102", "(国際)　牝　(指)", "別定"), row("202601010103", " ", "定量"), row("202601010104", "", "ハンデ")]]),
    );
    expect(table["202601010101"]?.condition).toBe("(国際)牝(指)");
    expect(table["202601010102"]?.condition).toBe("(国際)牝(指)");
    expect(table["202601010103"]).toEqual({ weightType: "定量", condition: null, filliesOnly: null });
    expect(table["202601010104"]).toEqual({ weightType: "ハンデ", condition: null, filliesOnly: null });
  });

  it("jyuryo の空・半角空白・未知の語は weightType=null(前後の空白は除いて語と完全一致)", () => {
    const table = parseNewspaperResponse(
      makeResponse([[row("202601010101", "[指]", ""), row("202601010102", "[指]", " "), row("202601010103", "[指]", "ハンデ戦"), row("202601010104", "[指]", " 定量 ")]]),
    );
    expect(table["202601010101"]?.weightType).toBeNull();
    expect(table["202601010102"]?.weightType).toBeNull();
    expect(table["202601010103"]?.weightType).toBeNull();
    expect(table["202601010104"]?.weightType).toBe("定量");
  });

  it("同じ race_id が複数の馬に出るときは先勝ち(順序を前提として固定: 先の馬が馬齢、後の馬が定量)", () => {
    const table = parseNewspaperResponse(makeResponse([[row("202601010101", "牝", "馬齢")], [row("202601010101", "", "定量")]]));
    expect(Object.keys(table)).toEqual(["202601010101"]);
    expect(table["202601010101"]).toEqual({ weightType: "馬齢", condition: "牝", filliesOnly: true });
  });

  it("race_id の無い要素・12 桁の数字でない race_id・race_id が配列でない行は除く。race_id だけの行は、条件が全部 null の行として残る(throw しない)", () => {
    const table = parseNewspaperResponse(
      makeResponse([
        [
          { z_blank: [["休養"], ["休養"]] },
          row("2026P0010105", "", "ハンデ"),
          row("20260101010", "", "ハンデ"),
          { race_id: "202601010101", kigou: ["X", "牝", ""], jyuryo: ["0", "馬齢", ""] },
          { race_id: ["202601010102"] },
          row("202601010103", "牝", "馬齢"),
        ],
      ]),
    );
    expect(Object.keys(table)).toEqual(["202601010102", "202601010103"]);
    expect(table["202601010102"]).toEqual({ weightType: null, condition: null, filliesOnly: null });
    expect(table["202601010103"]).toEqual({ weightType: "馬齢", condition: "牝", filliesOnly: true });
  });

  it("race_result が配列でない馬は読み飛ばす(馬が 0 頭でも空の表)", () => {
    const encoded = deflateSync(Buffer.from(JSON.stringify([{ horse_id: "1", race_result: null }, { horse_id: "2" }]), "utf-8")).toString("base64");
    const raw = JSON.stringify({ status: "OK", reason: null, data: { k: encoded } });
    expect(parseNewspaperResponse(raw)).toEqual({});
  });
});

describe("parseNewspaperResponse: 実フィクスチャ(status:NG)", () => {
  it("実測の NG 応答({\"status\":\"NG\",\"reason\":\"AplNewsPaper->get() Error\"}。2026-10-20、出馬表が未公開の将来の中央レース 202605050811 に POST。HTTP は 200・data 無し)は NewspaperParseError", () => {
    const raw = loadFixture("newspaper_api_ng_202605050811.json");
    expect(JSON.parse(raw)).toEqual({ status: "NG", reason: "AplNewsPaper->get() Error" }); // 前提: 実物の形
    expect(() => parseNewspaperResponse(raw)).toThrow(NewspaperParseError);
    expect(() => parseNewspaperResponse(raw)).toThrow(/status が OK ではありません/);
  });
});

describe("parseNewspaperResponse: 異常系は NewspaperParseError", () => {
  const encodedOf = (value: unknown) => deflateSync(Buffer.from(JSON.stringify(value), "utf-8")).toString("base64");

  it.each([
    ["JSON でない", "not a json"],
    ["status が OK でない(NG)", JSON.stringify({ status: "NG", reason: "x", data: [] })],
    ["data が無い", JSON.stringify({ status: "OK", reason: null })],
    ["データのキーが無い", JSON.stringify({ status: "OK", reason: null, data: { "k_last_dt": "a" } })],
    ["データが文字列でない", JSON.stringify({ status: "OK", reason: null, data: { k: 1 } })],
    ["zlib として読めない", JSON.stringify({ status: "OK", reason: null, data: { k: Buffer.from("zlibではない").toString("base64") } })],
    ["展開後が JSON でない", JSON.stringify({ status: "OK", reason: null, data: { k: deflateSync(Buffer.from("{壊れた")).toString("base64") } })],
    ["展開後が配列でない", JSON.stringify({ status: "OK", reason: null, data: { k: encodedOf({ a: 1 }) } })],
  ])("%s", (_name, raw) => {
    expect(() => parseNewspaperResponse(raw)).toThrow(NewspaperParseError);
  });
});
