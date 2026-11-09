import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeShiftJis } from "../src/jra-http";
import { isParamErrorPage, parseEntryPage, parseRaceCname, parseRaceListPage, parseVenueListPage } from "../src/jra-entries-parse";

/**
 * Issue #639: JRA の出馬表(詳細ページ)から、馬の ID・馬番・血統・馬主・生産者・ブリンカー・減量・マルガイ印を読むパーサ。
 * 見本は 2026-11-06 に取った JRA のページ(Shift_JIS の原本。`fixtures/jra_639_*`)。実サイトには出ない。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = (name: string): string => decodeShiftJis(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));

const DLI = page("jra_639_dli00_top_20261106.html");
const DRL_1108 = page("jra_639_drl_tokyo_20261108.html");
const DRL_1107 = page("jra_639_drl_tokyo_20261107.html");
const DDE_TOKYO11R = page("jra_639_dde_tokyo11R_20261108.html");
const DDE_TOKYO02R = page("jra_639_dde_tokyo02R_20261107.html");
const PARAM_ERROR = page("jra_639_param_error.html");
const RESULT_PAGE = page("jra_639_result_kyoto11R_20261004.html");

const CNAME_TOKYO11R = "pw01dde0105202605021120261108/65";
const CNAME_TOKYO02R = "pw01dde0105202605010220261107/98";

describe("parseRaceCname(レースの CNAME の分解)", () => {
  it("開催日・場・回・日目・R から netkeiba の race_id を作る(11/8 東京 11R = 202605050211 と同じ並び)", () => {
    expect(parseRaceCname(CNAME_TOKYO11R)).toEqual({ venueCode: "05", year: "2026", kai: "05", day: "02", race: "11", date: "20261108", raceId: "202605050211" });
  });
  it.each(["", "pw01dde0105202605021120261108", "pw01dde0105202605021120261108/6", "pw01drl00052026050220261108/30", "pw01dde0105202605021120261108/6G", "x pw01dde0105202605021120261108/65"])("形が違うものは null: %j", (text) => {
    expect(parseRaceCname(text)).toBeNull();
  });
});

describe("parseVenueListPage(開催の選択)", () => {
  it("指定の日の場ごとのレースの選択を返す(11/8 は 3 場。他の日は混ぜない)", () => {
    const venues = parseVenueListPage(DLI, "20261108");
    expect(venues.map((v) => v.venueCode)).toEqual(["03", "05", "08"]);
    expect(venues.map((v) => v.drlCname)).toEqual(["pw01drl00032026030220261108/3A", "pw01drl00052026050220261108/30", "pw01drl00082026050220261108/0E"]);
  });
  it("11/7 は別の CNAME、無い日は空", () => {
    expect(parseVenueListPage(DLI, "20261107").map((v) => v.drlCname)).toEqual(["pw01drl00032026030120261107/4C", "pw01drl00052026050120261107/42", "pw01drl00082026050120261107/20"]);
    expect(parseVenueListPage(DLI, "20261109")).toEqual([]);
  });
  it("パラメータエラーのページ・無関係なページからは空", () => {
    expect(parseVenueListPage(PARAM_ERROR, "20261108")).toEqual([]);
    expect(parseVenueListPage("", "20261108")).toEqual([]);
  });
});

describe("parseRaceListPage(レースの選択)", () => {
  it("東京 11/8 の 12 レースの詳細の CNAME を、R の順に返す", () => {
    const races = parseRaceListPage(DRL_1108, "20261108", "05");
    expect(races).toHaveLength(12);
    expect(races[0]).toBe("pw01dde0105202605020120261108/13");
    expect(races[10]).toBe(CNAME_TOKYO11R);
    expect(races.map((c) => parseRaceCname(c)?.race)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
  });
  it("別の日・別の場の CNAME は混ぜない(ナビの他の日のリンクがあっても)", () => {
    const races = parseRaceListPage(DRL_1107, "20261107", "05");
    expect(races).toHaveLength(12);
    expect(races.every((c) => parseRaceCname(c)?.date === "20261107" && parseRaceCname(c)?.venueCode === "05")).toBe(true);
    expect(races).toContain(CNAME_TOKYO02R);
    expect(parseRaceListPage(DRL_1107, "20261108", "05")).toEqual([]);
  });
});

describe("isParamErrorPage(符号が違うときの HTTP 200 のページ)", () => {
  it("<title> がパラメータエラー", () => {
    expect(isParamErrorPage(PARAM_ERROR)).toBe(true);
  });
  it("通常のページは違う", () => {
    expect(isParamErrorPage(DDE_TOKYO11R)).toBe(false);
    expect(isParamErrorPage(DLI)).toBe(false);
  });
});

describe("parseEntryPage(11/8 東京 11R。18 頭)", () => {
  const expected = parseRaceCname(CNAME_TOKYO11R)!;
  const result = parseEntryPage(DDE_TOKYO11R, expected);
  if (result.status !== "ok") throw new Error(`読めない: ${result.status}`);
  const horses = result.horses;

  it("18 頭(過去 5 年の成績の表の馬は含めない)・馬番は 1〜18", () => {
    expect(horses).toHaveLength(18);
    expect(horses.map((h) => h.umaban)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(result.skipped).toBe(0);
    expect(horses.map((h) => h.name)).not.toContain("ハヤヤッコ");
    expect(horses.map((h) => h.name)).not.toContain("オーソリティ");
  });
  it("1 番: 馬の ID・馬名・血統・馬主・生産者", () => {
    expect(horses[0]).toEqual({
      horseId: "2022105710",
      name: "ジーティーダーリン",
      umaban: 1,
      blinker: false,
      reductionKg: 0,
      foreignMark: false,
      sire: "サートゥルナーリア",
      dam: "ディアマイダーリン",
      damSire: "ハーツクライ",
      owner: "田畑 利彦",
      breeder: "追分ファーム",
    });
  });
  it("ブリンカーは ⑩⑭⑰⑱ の 4 頭だけ(馬番のセルの印)", () => {
    expect(horses.filter((h) => h.blinker).map((h) => h.umaban)).toEqual([10, 14, 17, 18]);
  });
  it("法人名の括弧・特殊な字もそのまま(株式会社の略記)", () => {
    expect(horses.find((h) => h.umaban === 3)?.owner).toBe("(株)サラブレッドクラブ・ラフィアン");
    expect(horses.every((h) => /^\d{10}$/.test(h.horseId))).toBe(true);
    expect(new Set(horses.map((h) => h.horseId)).size).toBe(18);
    expect(horses.every((h) => h.sire !== "" && h.dam !== "" && h.damSire !== "" && h.owner !== "" && h.breeder !== "")).toBe(true);
  });
  it("このレースに減量騎手・マルガイ印はいない", () => {
    expect(horses.some((h) => h.reductionKg > 0 || h.foreignMark)).toBe(false);
  });
  it("ミステリーウェイ(18 番)の ID は netkeiba の馬の ID と同じ 2018104638", () => {
    expect(horses.find((h) => h.name === "ミステリーウェイ")).toMatchObject({ horseId: "2018104638", umaban: 18, blinker: true });
  });
});

describe("parseEntryPage(11/7 東京 2R。2 歳未勝利の 13 頭)", () => {
  const expected = parseRaceCname(CNAME_TOKYO02R)!;
  const result = parseEntryPage(DDE_TOKYO02R, expected);
  if (result.status !== "ok") throw new Error(`読めない: ${result.status}`);
  const horses = result.horses;

  it("13 頭・減量の印は今回の騎手の分だけ(減量の正規表現が `<p class=\"jockey\"><span title=` の形に限られるので、馬柱側の印は拾わない。`PAST_START` の切り出しは JRA が馬柱のマークアップを変えたときの備えで、このテストでは切り出しの有無を区別できない。Issue #645)", () => {
    expect(horses).toHaveLength(13);
    expect(horses.filter((h) => h.reductionKg > 0).map((h) => h.reductionKg)).toEqual([3, 1, 2, 3]);
  });
  it("マルガイ印は 1 番(エコロヴォルグ)だけ。ブリンカーは 2 頭", () => {
    expect(horses.filter((h) => h.foreignMark).map((h) => h.name)).toEqual(["エコロヴォルグ"]);
    expect(horses.filter((h) => h.blinker)).toHaveLength(2);
    expect(horses[0]).toMatchObject({ horseId: "2024108339", umaban: 1, foreignMark: true });
  });
  it("字が欠けない(「奈良﨑」を含む馬主)", () => {
    expect(horses.map((h) => h.owner)).toContain("奈良﨑 孝一郎");
    expect(horses.some((h) => h.owner.includes("�"))).toBe(false);
  });
});

describe("parseEntryPage の失敗の判定", () => {
  const expected = parseRaceCname(CNAME_TOKYO11R)!;
  it("パラメータエラーのページ(HTTP 200)は param-error", () => {
    expect(parseEntryPage(PARAM_ERROR, expected)).toEqual({ status: "param-error" });
  });
  it("結果のページ(血統の欄が無い)・空・別の形は shape-mismatch", () => {
    expect(parseEntryPage(RESULT_PAGE, expected)).toEqual({ status: "shape-mismatch" });
    expect(parseEntryPage("", expected)).toEqual({ status: "shape-mismatch" });
    expect(parseEntryPage("<html><body>x</body></html>", expected)).toEqual({ status: "shape-mismatch" });
  });
  it("別のレースのページを返されたら race-mismatch(日付・R・回・日目のどれが違っても)", () => {
    expect(parseEntryPage(DDE_TOKYO02R, expected)).toEqual({ status: "race-mismatch" });
    expect(parseEntryPage(DDE_TOKYO11R, { ...expected, race: "10" })).toEqual({ status: "race-mismatch" });
    expect(parseEntryPage(DDE_TOKYO11R, { ...expected, date: "20261107" })).toEqual({ status: "race-mismatch" });
    expect(parseEntryPage(DDE_TOKYO11R, { ...expected, day: "01" })).toEqual({ status: "race-mismatch" });
    expect(parseEntryPage(DDE_TOKYO11R, { ...expected, venueCode: "06" })).toEqual({ status: "race-mismatch" });
  });
  it("10 桁でない ID の馬は保存せず skipped に数える(他の馬は読む)", () => {
    const mutated = DDE_TOKYO11R.replace("CNAME=pw01dud002022105710/E8", "CNAME=pw01dud00X0221057/E8");
    expect(mutated).not.toBe(DDE_TOKYO11R);
    const r = parseEntryPage(mutated, expected);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.skipped).toBe(1);
      expect(r.horses).toHaveLength(17);
      expect(r.horses[0]?.umaban).toBe(2);
    }
  });
  it("同じ馬の行が重複していたら、2 回目は保存せず skipped に数える(同じ馬を二重に返さない)", () => {
    // 行の区切りは CRLF と LF が混ざっている(原本のまま)ので、`<tr>` と `<td class="waku"` のあいだの空白は正規表現で読む。
    const starts = [...DDE_TOKYO11R.matchAll(/<tr>\s*<td class="waku"/g)].map((m) => m.index!);
    const start = starts[0]!;
    const end = starts[1]!;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const firstRow = DDE_TOKYO11R.slice(start, end);
    const r = parseEntryPage(DDE_TOKYO11R.slice(0, end) + firstRow + DDE_TOKYO11R.slice(end), expected);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.horses).toHaveLength(18);
      expect(r.skipped).toBe(1);
    }
  });
  it("馬の行がすべて読めないなら shape-mismatch(0 頭を ok にしない)", () => {
    const mutated = DDE_TOKYO11R.replaceAll("CNAME=pw01dud00", "CNAME=pw01dud0X");
    expect(parseEntryPage(mutated, expected)).toEqual({ status: "shape-mismatch" });
  });
});
