import { describe, expect, it } from "vitest";
import { OIKIRI_PARSER_VERSION, parseOikiri } from "../../src/scraper/parse-oikiri.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #731: 過去(2021 年)の追い切りのページも既存のパーサで読める。
 * フィクスチャは 2021-01-30 東京 1R(race_id 202105010101)の実物。2026 年のフィクスチャ(oikiri_202603020211.html)とは
 * 馬・評語・ランクの値がすべて違うので、取り違えると赤になる。
 */
const r = parseOikiri(loadFixture("oikiri_202105010101.html"));

describe("parseOikiri(2021 年の過去ページ)", () => {
  it("16 頭を馬番 1〜16 の順で読み、スキップは 0 件", () => {
    expect(r.entries).toHaveLength(16);
    expect(r.entries.map((e) => e.umaban)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(r.skippedRowCount).toBe(0);
  });

  it("馬番 1 は キタノコンキスタ(2018101424)・評語 目立たず・ランク C", () => {
    expect(r.entries[0]).toEqual({ umaban: 1, horseId: "2018101424", horseName: "キタノコンキスタ", critic: "目立たず", rank: "C" });
  });

  it("馬番 2 は プレフェリータ(2018105460)・追毎良化・B(馬 ID とランクの取り違えを検出する)", () => {
    expect(r.entries[1]).toEqual({ umaban: 2, horseId: "2018105460", horseName: "プレフェリータ", critic: "追毎良化", rank: "B" });
  });

  it("ランクの内訳は B が 6 頭・C が 10 頭(全馬にランクと評語がある)", () => {
    expect(r.entries.filter((e) => e.rank === "B")).toHaveLength(6);
    expect(r.entries.filter((e) => e.rank === "C")).toHaveLength(10);
    expect(r.entries.every((e) => e.critic !== null && e.critic !== "")).toBe(true);
  });
});

describe("OIKIRI_PARSER_VERSION", () => {
  it("正の整数(保存の行に添えて、読み直しの対象を引くための版)", () => {
    expect(Number.isInteger(OIKIRI_PARSER_VERSION)).toBe(true);
    expect(OIKIRI_PARSER_VERSION).toBeGreaterThanOrEqual(1);
  });
});
