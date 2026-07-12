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
  narOddsPageUrl,
  NarUnsupportedError,
  narRaceListSubUrl,
  oddsApiUrl,
  oikiriUrl,
  raceListSubUrl,
  raceResultUrl,
  shutubaUrl,
} from "../../src/scraper/urls.js";

const raceId = parseRaceId("202605020811");
const narRaceId = parseRaceId("202654071210");
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

  it("raceResultUrlはレース結果ページのURLを返すこと", () => {
    expect(raceResultUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/result.html?race_id=202605020811",
    );
  });
});

describe("URL構築のドメイン自動選択(中央/地方)", () => {
  it("shutubaUrlは地方race_idではnar.netkeiba.comを返すこと", () => {
    expect(shutubaUrl(narRaceId)).toBe(
      "https://nar.netkeiba.com/race/shutuba.html?race_id=202654071210",
    );
  });

  it("shutubaUrlは中央race_idではrace.netkeiba.comを返すこと(既存動作)", () => {
    expect(shutubaUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/shutuba.html?race_id=202605020811",
    );
  });

  it("raceResultUrlは地方race_idではnar.netkeiba.comを返すこと", () => {
    expect(raceResultUrl(narRaceId)).toBe(
      "https://nar.netkeiba.com/race/result.html?race_id=202654071210",
    );
  });

  it("raceResultUrlは中央race_idではrace.netkeiba.comを返すこと(既存動作)", () => {
    expect(raceResultUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/result.html?race_id=202605020811",
    );
  });
});

describe("narRaceListSubUrl(地方レース一覧サブHTML)", () => {
  it("開催日クエリ付きの地方レース一覧サブURL(nar.netkeiba.com)を返すこと", () => {
    expect(narRaceListSubUrl(kaisaiDate)).toBe(
      "https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260628",
    );
  });
});

describe("narOddsPageUrl(地方オッズページ)", () => {
  it("type=b1固定のクエリ付き地方オッズページURLを返すこと", () => {
    expect(narOddsPageUrl(narRaceId)).toBe(
      "https://nar.netkeiba.com/odds/index.html?type=b1&race_id=202654071210",
    );
  });
});

describe("oikiriUrl/commentUrl/oddsApiUrl(地方では存在しないページ)", () => {
  it("oikiriUrlに地方race_idを渡すとNarUnsupportedErrorになること", () => {
    expect(() => oikiriUrl(narRaceId)).toThrow(NarUnsupportedError);
  });

  it("commentUrlに地方race_idを渡すとNarUnsupportedErrorになること", () => {
    expect(() => commentUrl(narRaceId)).toThrow(NarUnsupportedError);
  });

  it("oddsApiUrlに地方race_idを渡すとNarUnsupportedErrorになること(中央用JSON APIはNARに存在しない)", () => {
    expect(() => oddsApiUrl(narRaceId)).toThrow(NarUnsupportedError);
  });

  it("中央race_idでは従来通りoikiriUrl/commentUrl/oddsApiUrlが取得できること(既存動作)", () => {
    expect(oikiriUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/oikiri.html?race_id=202605020811",
    );
    expect(commentUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/comment.html?race_id=202605020811",
    );
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
    expect(mod.raceResultUrl).toBe(raceResultUrl);
    expect(mod.narRaceListSubUrl).toBe(narRaceListSubUrl);
    expect(mod.narOddsPageUrl).toBe(narOddsPageUrl);
    expect(mod.NarUnsupportedError).toBe(NarUnsupportedError);
  });

  it("不採用となったnewspaperUrlは公開されないこと", async () => {
    const mod = await import("../../src/index.js");
    expect("newspaperUrl" in mod).toBe(false);
  });
});
