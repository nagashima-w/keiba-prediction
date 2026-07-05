import { describe, expect, it } from "vitest";
import {
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
} from "../../src/scraper/ids.js";
import {
  commentUrl,
  horseUrl,
  newspaperUrl,
  oikiriUrl,
  raceListSubUrl,
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

  it("newspaperUrlは競馬新聞ページのURLを返すこと", () => {
    expect(newspaperUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/newspaper.html?race_id=202605020811",
    );
  });

  it("oikiriUrlは追い切り(調教)ページの候補URLを返すこと", () => {
    expect(oikiriUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/oikiri.html?race_id=202605020811",
    );
  });

  it("commentUrlは厩舎コメントページの候補URLを返すこと", () => {
    expect(commentUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/comment.html?race_id=202605020811",
    );
  });

  it("horseUrlは馬個別ページ(末尾スラッシュ付き)のURLを返すこと", () => {
    expect(horseUrl(horseId)).toBe(
      "https://db.netkeiba.com/horse/2019105219/",
    );
  });
});

describe("公開API(index.tsからの再エクスポート)", () => {
  it("URL構築関数がindexから再エクスポートされていること", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.raceListSubUrl).toBe(raceListSubUrl);
    expect(mod.newspaperUrl).toBe(newspaperUrl);
    expect(mod.oikiriUrl).toBe(oikiriUrl);
    expect(mod.commentUrl).toBe(commentUrl);
    expect(mod.horseUrl).toBe(horseUrl);
  });
});
