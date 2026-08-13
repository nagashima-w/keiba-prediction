import { describe, expect, it } from "vitest";
import { parseHorseId, parseRaceId } from "../../src/scraper/ids.js";
import type { RaceData, RaceHorseData } from "../../src/scraper/scrape-race.js";
import type { ShutubaHorse } from "../../src/scraper/types.js";
import { filterRaceDataBefore } from "../../src/scorer/snapshot-filter.js";
import { makeResult } from "./helpers.js";

/**
 * snapshot-filter — 先読みリーク防止のための基準日切り出し(#40「#35-1a」)。
 *
 * `filterRaceDataBefore` は `packages/app/src/main/analysis-pipeline.ts` の先読みリーク
 * (戦績を日付でフィルタせず prior に渡してしまう欠陥)を、計測用の入力データに限定して
 * 遮断するための純関数。本番側の是正(#39)はスコープ外。
 */

/** 出馬表1頭分を最小構成で組み立てる。 */
function makeShutuba(umaban: number): ShutubaHorse {
  return {
    wakuban: umaban,
    umaban,
    name: `馬${umaban}`,
    horseId: parseHorseId(String(umaban).padStart(10, "0")),
    sex: "牡",
    age: 4,
    kinryo: 55,
    jockeyName: "騎手",
    jockeyId: null,
    stableLocation: "美浦",
    trainerName: "調教師",
    trainerId: null,
    bodyWeight: null,
  };
}

/** RaceHorseData 1頭分を最小構成で組み立てる。 */
function makeHorse(
  umaban: number,
  results: RaceHorseData["results"],
): RaceHorseData {
  return { shutuba: makeShutuba(umaban), results, oikiri: null };
}

/** RaceData を最小構成で組み立てる(horses以外は本モジュールの関心事ではないため固定値)。 */
function makeRaceData(horses: RaceHorseData[]): RaceData {
  return {
    raceId: parseRaceId("202603020211"),
    race: { raceName: "テストレース", courseType: "芝", distance: 1800 },
    horses,
    odds: { officialDatetime: null, oddsStatus: "result", win: {}, place: {} },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
  };
}

describe("filterRaceDataBefore", () => {
  it("基準日と同日の走は除外し、1日前の走は残す(境界値)", () => {
    const raceData = makeRaceData([
      makeHorse(1, [
        makeResult({ date: "2026/06/28" }), // 同日(=当該レース自身)→除外
        makeResult({ date: "2026/06/27" }), // 1日前→残す
      ]),
    ]);

    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");

    // 前提: 元は2走(境界のズレを検出できるよう無条件に固定する)。
    expect(raceData.horses[0]!.results).toHaveLength(2);

    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(filtered.horses[0]!.results![0]!.date).toBe("2026/06/27");
    expect(diagnostics.removedByCutoffCount).toBe(1);
    expect(diagnostics.removedByInvalidDateCount).toBe(0);
    expect(diagnostics.removedCount).toBe(1);
    expect(diagnostics.totalResultCount).toBe(2);
  });

  it("基準日より2日前(境界の外側)は当然残る", () => {
    const raceData = makeRaceData([makeHorse(1, [makeResult({ date: "2026/06/26" })])]);
    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(diagnostics.removedCount).toBe(0);
  });

  it("非ゼロ埋めの日付形式(2026/6/28)でも辞書順比較にならず正しく境界判定する(受け入れ条件10)", () => {
    // "2026/6/28" は辞書順だと "2026/10/1" のような日付より大きく誤判定されうる文字列だが、
    // ここではまず「非ゼロ埋めの基準日と同日は除外される」ことを確認する。
    const raceData = makeRaceData([
      makeHorse(1, [
        makeResult({ date: "2026/6/28" }), // 非ゼロ埋め・同日→除外
        makeResult({ date: "2026/6/27" }), // 非ゼロ埋め・1日前→残す
      ]),
    ]);
    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(filtered.horses[0]!.results![0]!.date).toBe("2026/6/27");
    expect(diagnostics.removedByCutoffCount).toBe(1);
  });

  it("非ゼロ埋めの月をまたぐケースで辞書順比較なら誤判定する日付を正しく処理する", () => {
    // 辞書順では "2026/9/1" > "2026/10/1"(先頭文字'9'>'1')という誤判定が起きる組み合わせ。
    // 基準日を "2026/10/2"(2026年10月2日)とし、"2026/9/1"(9月1日、実際は31日前)が
    // 正しく「残る」側に分類されることを確認する。
    const raceData = makeRaceData([makeHorse(1, [makeResult({ date: "2026/9/1" })])]);
    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/10/02");
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(diagnostics.removedCount).toBe(0);
  });

  it("日付が欠損(null)の走は安全側に倒して除外し、除外件数を診断値に計上する", () => {
    const raceData = makeRaceData([
      makeHorse(1, [makeResult({ date: null }), makeResult({ date: "2026/06/27" })]),
    ]);
    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(diagnostics.removedByInvalidDateCount).toBe(1);
    expect(diagnostics.removedByCutoffCount).toBe(0);
  });

  it("日付が不正形式の走は安全側に倒して除外する", () => {
    const raceData = makeRaceData([
      makeHorse(1, [makeResult({ date: "不明" }), makeResult({ date: "2026/06/27" })]),
    ]);
    const { diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(diagnostics.removedByInvalidDateCount).toBe(1);
  });

  it("全走が除外され戦績0走になる馬がいても例外を投げず処理できる", () => {
    const raceData = makeRaceData([makeHorse(1, [makeResult({ date: "2026/06/28" })])]);
    expect(() => filterRaceDataBefore(raceData, "2026/06/28")).not.toThrow();
    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(filtered.horses[0]!.results).toEqual([]);
    expect(diagnostics.perHorse[0]!.originalCount).toBe(1);
    expect(diagnostics.perHorse[0]!.removedByCutoffCount).toBe(1);
  });

  it("results が null(戦績取得失敗)の馬は null のまま素通しし、除去件数に計上しない", () => {
    const raceData = makeRaceData([makeHorse(1, null)]);
    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(filtered.horses[0]!.results).toBeNull();
    expect(diagnostics.perHorse[0]!.originalCount).toBe(0);
    expect(diagnostics.removedCount).toBe(0);
  });

  it("除去件数0(リーク無し)のケース: 全走が基準日より前なら removedCount は0", () => {
    const raceData = makeRaceData([
      makeHorse(1, [makeResult({ date: "2026/06/20" }), makeResult({ date: "2026/04/18" })]),
    ]);
    const { diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(diagnostics.removedCount).toBe(0);
    expect(diagnostics.totalResultCount).toBe(2);
  });

  it("元スナップショットを破壊的に変更しない", () => {
    const originalResults = [makeResult({ date: "2026/06/28" }), makeResult({ date: "2026/06/27" })];
    const raceData = makeRaceData([makeHorse(1, originalResults)]);
    const snapshotBefore = JSON.parse(JSON.stringify(raceData)) as unknown;

    filterRaceDataBefore(raceData, "2026/06/28");

    expect(raceData.horses[0]!.results).toHaveLength(2); // 元配列の長さが変わっていない
    expect(raceData.horses[0]!.results).toBe(originalResults); // 元配列オブジェクト自体が同一参照のまま
    expect(JSON.parse(JSON.stringify(raceData))).toEqual(snapshotBefore); // 内容も不変
  });

  it("複数頭のリーク遮断: 頭数分の全走が当該レース自身(同日)のとき、全頭が0走になる", () => {
    // #40 Issue本文の実測(中央16頭フィクスチャで出走16頭全頭が該当)を、
    // 合成データで最小再現する境界ケース。
    const raceData = makeRaceData([
      makeHorse(1, [makeResult({ date: "2026/06/28" })]),
      makeHorse(2, [makeResult({ date: "2026/06/28" })]),
      makeHorse(3, [makeResult({ date: "2026/06/28" }), makeResult({ date: "2026/06/20" })]),
    ]);
    const { raceData: filtered, diagnostics } = filterRaceDataBefore(raceData, "2026/06/28");
    expect(filtered.horses[0]!.results).toEqual([]);
    expect(filtered.horses[1]!.results).toEqual([]);
    expect(filtered.horses[2]!.results).toHaveLength(1);
    expect(diagnostics.removedByCutoffCount).toBe(3);
    expect(diagnostics.removedCount).toBe(3);
  });
});
