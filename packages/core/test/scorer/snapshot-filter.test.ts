import { describe, expect, it } from "vitest";
import { parseHorseId, parseRaceId } from "../../src/scraper/ids.js";
import type { RaceData, RaceHorseData } from "../../src/scraper/scrape-race.js";
import type { ShutubaHorse } from "../../src/scraper/types.js";
import {
  excludeOwnRaceResults,
  filterRaceDataBefore,
} from "../../src/scorer/snapshot-filter.js";
import { makeResult } from "./helpers.js";

/**
 * snapshot-filter — 先読みリーク防止のための基準日切り出し(#40「#35-1a」)。
 *
 * `filterRaceDataBefore` は先読みリーク(戦績を日付でフィルタせず prior に渡してしまう欠陥)を
 * 遮断するための純関数。#40 は計測用の入力データの遮断に使い、#39 で production の
 * `analysis-pipeline.ts`(`runAnalysis` の scrape 直後)も同じ関数を使うようになった
 * (production 側の配線は `packages/app/test/analysis-pipeline-no-lookahead.test.ts` で固定)。
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

/**
 * excludeOwnRaceResults — 当該レース自身の走を日付に依らず除外する(#39 是正方式B)。
 *
 * `filterRaceDataBefore`(日付で絞る)は、`dateApproximate=true`(基準日が実行日になる)の過去レース
 * では当該レース自身の走を「実行日より前」として残してしまう。そこで raceId 一致による除外を
 * 別の純関数として持ち、pipeline で合成する(`filterRaceDataBefore` は #40 の恒等式を守るため無改変)。
 * 比較は `HorseRaceResult.raceIdRaw`(中央・地方とも12桁の生値が入る)で行う。`raceId` フィールドは
 * 地方では常に null なので、それに頼ると地方では一切効かない。
 */
describe("excludeOwnRaceResults", () => {
  const OWN = parseRaceId("202603020211");

  it("中央: raceIdRaw が対象 raceId と一致する走を日付に依らず除外し、他のレースの走は残す", () => {
    const raceData = makeRaceData([
      makeHorse(1, [
        makeResult({ date: "2026/06/28", raceId: OWN, raceIdRaw: "202603020211" }), // 自走
        makeResult({ date: "2026/06/20", raceId: parseRaceId("202603020111"), raceIdRaw: "202603020111" }), // 別レース
      ]),
    ]);
    const { raceData: filtered, removedCount } = excludeOwnRaceResults(raceData, OWN);
    expect(raceData.horses[0]!.results).toHaveLength(2); // 前提
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(filtered.horses[0]!.results![0]!.raceIdRaw).toBe("202603020111");
    expect(removedCount).toBe(1);
  });

  it("日付に依らない: 自走の日付が過去日(基準日近似のずれ)でも、未来日でも、欠損でも除外する", () => {
    const raceData = makeRaceData([
      makeHorse(1, [
        makeResult({ date: "2020/01/01", raceIdRaw: "202603020211" }),
        makeResult({ date: "2030/01/01", raceIdRaw: "202603020211" }),
        makeResult({ date: null, raceIdRaw: "202603020211" }),
        makeResult({ date: "2026/06/01", raceIdRaw: "202603020199" }),
      ]),
    ]);
    const { raceData: filtered, removedCount } = excludeOwnRaceResults(raceData, OWN);
    expect(raceData.horses[0]!.results).toHaveLength(4); // 前提
    expect(removedCount).toBe(3);
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(filtered.horses[0]!.results![0]!.date).toBe("2026/06/01");
  });

  it("地方: raceId フィールドが null で raceIdRaw にだけ値がある走も除外する(raceId 比較への取り違えを検出する)", () => {
    const narOwn = parseRaceId("202654071210");
    const raceData = makeRaceData([
      makeHorse(1, [
        makeResult({ date: "2026/07/12", raceId: null, raceIdRaw: "202654071210", venueKind: "地方" }),
        makeResult({ date: "2026/07/01", raceId: null, raceIdRaw: "202654070110", venueKind: "地方" }),
      ]),
    ]);
    const { raceData: filtered, removedCount } = excludeOwnRaceResults(raceData, narOwn);
    // 前提: 自走は raceId が null(=raceId で比較する実装では一致0件になる)。
    expect(raceData.horses[0]!.results![0]!.raceId).toBeNull();
    expect(removedCount).toBe(1);
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(filtered.horses[0]!.results![0]!.raceIdRaw).toBe("202654070110");
  });

  it("raceIdRaw が null の走(海外・リンク欠損)は誤って除外しない", () => {
    const raceData = makeRaceData([
      makeHorse(1, [makeResult({ date: "2026/06/28", raceId: null, raceIdRaw: null, venueKind: "海外" })]),
    ]);
    const { raceData: filtered, removedCount } = excludeOwnRaceResults(raceData, OWN);
    expect(filtered.horses[0]!.results).toHaveLength(1);
    expect(removedCount).toBe(0);
  });

  it("results が null(戦績取得失敗)の馬は null のまま通し、0走([])とは区別する", () => {
    const raceData = makeRaceData([
      makeHorse(1, null),
      makeHorse(2, [makeResult({ date: "2026/06/28", raceIdRaw: "202603020211" })]),
    ]);
    const { raceData: filtered } = excludeOwnRaceResults(raceData, OWN);
    expect(filtered.horses[0]!.results).toBeNull();
    expect(filtered.horses[1]!.results).toEqual([]);
  });

  it("複数頭の合計を removedCount に計上する(頭ごとに1走ずつ自走)", () => {
    const raceData = makeRaceData([
      makeHorse(1, [makeResult({ date: "2026/06/28", raceIdRaw: "202603020211" })]),
      makeHorse(2, [makeResult({ date: "2026/06/28", raceIdRaw: "202603020211" }), makeResult({ date: "2026/06/01", raceIdRaw: "202603020101" })]),
      makeHorse(3, [makeResult({ date: "2026/06/01", raceIdRaw: "202603020101" })]),
    ]);
    const { removedCount } = excludeOwnRaceResults(raceData, OWN);
    expect(removedCount).toBe(2);
  });

  it("自走が無ければ戦績の中身は不変で removedCount は0", () => {
    const results = [makeResult({ date: "2026/06/01", raceIdRaw: "202603020101" })];
    const raceData = makeRaceData([makeHorse(1, results)]);
    const { raceData: filtered, removedCount } = excludeOwnRaceResults(raceData, OWN);
    expect(removedCount).toBe(0);
    expect(filtered.horses[0]!.results).toEqual(results);
  });

  it("元スナップショットを破壊的に変更しない", () => {
    const originalResults = [
      makeResult({ date: "2026/06/28", raceIdRaw: "202603020211" }),
      makeResult({ date: "2026/06/01", raceIdRaw: "202603020101" }),
    ];
    const raceData = makeRaceData([makeHorse(1, originalResults)]);
    const before = JSON.parse(JSON.stringify(raceData)) as unknown;
    excludeOwnRaceResults(raceData, OWN);
    expect(raceData.horses[0]!.results).toBe(originalResults);
    expect(raceData.horses[0]!.results).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(raceData))).toEqual(before);
  });
});
