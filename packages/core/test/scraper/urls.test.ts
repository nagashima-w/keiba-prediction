import { describe, expect, it } from "vitest";
import {
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
} from "../../src/scraper/ids.js";
import {
  commentUrl,
  horseResultsApiUrl,
  horseUrl,
  oddsApiUrl,
  oikiriUrl,
  raceListSubUrl,
  shutubaUrl,
} from "../../src/scraper/urls.js";

const raceId = parseRaceId("202605020811");
const kaisaiDate = parseKaisaiDate("20260628");
const horseId = parseHorseId("2019105219");

describe("URL構築の集約(urls.ts)", () => {
  it("raceListSubUrlは開催日クエリ付きのレース一覧サブURLを返すこと", () => {
    expect(raceListSubUrl(kaisaiDate)).toBe(
      "https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260628",
    );
  });

  it("shutubaUrlは出馬表ページ(正式ルート)のURLを返すこと", () => {
    expect(shutubaUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/shutuba.html?race_id=202605020811",
    );
  });

  it("oikiriUrlは追い切り(調教)ページの実URLを返すこと", () => {
    expect(oikiriUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/oikiri.html?race_id=202605020811",
    );
  });

  it("commentUrlは厩舎コメントページの実URLを返すこと", () => {
    expect(commentUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/comment.html?race_id=202605020811",
    );
  });

  it("horseUrlは馬個別ページ(末尾スラッシュ付き)のURLを返すこと", () => {
    expect(horseUrl(horseId)).toBe(
      "https://db.netkeiba.com/horse/2019105219/",
    );
  });

  it("horseResultsApiUrlは全戦績JSON APIのURLを返すこと", () => {
    expect(horseResultsApiUrl(horseId)).toBe(
      "https://db.netkeiba.com/horse/ajax_horse_results.html?input=UTF-8&output=json&id=2019105219",
    );
  });

  it("oddsApiUrlは単勝・複勝オッズJSON APIのURLを返すこと", () => {
    expect(oddsApiUrl(raceId)).toBe(
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202605020811&type=1&action=init",
    );
  });
});

describe("公開API(index.tsからの再エクスポート)", () => {
  it("URL構築関数がindexから再エクスポートされていること", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.raceListSubUrl).toBe(raceListSubUrl);
    expect(mod.shutubaUrl).toBe(shutubaUrl);
    expect(mod.oikiriUrl).toBe(oikiriUrl);
    expect(mod.commentUrl).toBe(commentUrl);
    expect(mod.horseUrl).toBe(horseUrl);
    expect(mod.horseResultsApiUrl).toBe(horseResultsApiUrl);
    expect(mod.oddsApiUrl).toBe(oddsApiUrl);
  });

  it("不採用となったnewspaperUrlは公開されないこと", async () => {
    const mod = await import("../../src/index.js");
    expect("newspaperUrl" in mod).toBe(false);
  });
});
