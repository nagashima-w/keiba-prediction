/**
 * 交流重賞(Jpn1/2/3)判定・抽出の純関数テスト。
 *
 * タスクB1: 地方(NAR)の一覧から「Jpnのみ」を絞り込むための下位関数。
 * grade文字列の判定はテーブル駆動で境界値(全角・空文字・undefined等)を固定する。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { filterJpnOnlyEntries, isJpnGrade } from "../../src/scraper/jpn-grade.js";
import { parseRaceList } from "../../src/scraper/parse-race-list.js";
import type { RaceListEntry } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("isJpnGrade(交流重賞Jpn1/2/3判定)", () => {
  const cases: Array<[string | undefined, boolean]> = [
    ["Jpn1", true],
    ["Jpn2", true],
    ["Jpn3", true],
    ["JpnⅠ", true],
    ["JpnⅡ", true],
    ["JpnⅢ", true],
    [" Jpn1 ", true],
    ["重賞", false],
    ["OP", false],
    ["L", false],
    ["", false],
    [undefined, false],
    // 全角数字(Jpn１)は不受理を明示的に固定する(半角のみ受理)。
    ["Jpn１", false],
    // 以下、正規表現が「たまたま通しうる」境界を回帰として固定する(code-reviewer指摘)。
    ["Jpn10", false], // 数字2桁(末尾に余分な"0")
    ["Jpn4", false], // 範囲外の数字
    ["AJpn1", false], // 前方に余分な文字
    ["Jpn1G", false], // 後方に余分な文字
    ["Jpn1\nJpn2", false], // 改行を挟んだ複数行
    ["jpn1", false], // 小文字(大文字小文字を区別する)
  ];

  it.each(cases)("isJpnGrade(%o) は %o を返す", (input, expected) => {
    expect(isJpnGrade(input)).toBe(expected);
  });
});

describe("filterJpnOnlyEntries(Jpnのみ抽出)", () => {
  /** grade違いの3件(Jpn1・重賞・undefined)を用意する共通ヘルパ。 */
  function makeEntry(
    raceId: string,
    grade: string | undefined,
  ): RaceListEntry {
    return {
      raceId: raceId as RaceListEntry["raceId"],
      name: `テスト${raceId}`,
      courseType: "ダ",
      distance: 1400,
      entryCount: 10,
      raceNumber: 1,
      grade,
    };
  }

  it("Jpn混在一覧からJpnのみ抽出すること", () => {
    const entries = [
      makeEntry("A", "Jpn1"),
      makeEntry("B", "重賞"),
      makeEntry("C", "Jpn2"),
      makeEntry("D", "OP"),
    ];
    const result = filterJpnOnlyEntries(entries);
    expect(result.map((e) => e.raceId)).toEqual(["A", "C"]);
  });

  it("grade=undefinedの行は除外すること", () => {
    const entries = [makeEntry("A", "Jpn1"), makeEntry("B", undefined)];
    const result = filterJpnOnlyEntries(entries);
    expect(result.map((e) => e.raceId)).toEqual(["A"]);
  });

  it("空配列を渡した場合は空配列を返すこと", () => {
    expect(filterJpnOnlyEntries([])).toEqual([]);
  });

  it("実データ(さきたま杯Jpn1を含む2026-06-24地方一覧)でJpn1のみが残ること", () => {
    const html = loadFixture("nar_race_list_sub_20260624.html");
    const entries = parseRaceList(html);
    const result = filterJpnOnlyEntries(entries);

    // さきたま杯(浦和・Jpn1)は残る。
    const sakitama = result.find((e) => e.raceId === "202642062411");
    expect(sakitama).toBeDefined();
    expect(sakitama!.grade).toBe("Jpn1");

    // Jpn以外(重賞・OP・無印等)はすべて落ちる。
    expect(result.every((e) => isJpnGrade(e.grade))).toBe(true);
    // 元の一覧よりも件数が減っている(全件がJpnではないこと)ことを確認する。
    expect(result.length).toBeLessThan(entries.length);
  });
});
