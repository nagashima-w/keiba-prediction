import { describe, expect, it } from "vitest";
import {
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
} from "../../src/scraper/ids.js";
import {
  commentUrl,
  gradeWinnerApiUrl,
  gradeWinnerOriginUrl,
  gradeWinnerRefererUrl,
  horseResultsApiUrl,
  horseUrl,
  narOddsPageUrl,
  NarUnsupportedError,
  narRaceListSubUrl,
  narTrioOddsPageUrl,
  narWideOddsPageUrl,
  oddsApiUrl,
  oikiriUrl,
  raceListSubUrl,
  raceResultUrl,
  shutubaUrl,
  trioOddsApiUrl,
  wideOddsApiUrl,
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

describe("wideOddsApiUrl/trioOddsApiUrl(中央 ワイド・三連複オッズJSON API。機能D-1 実測2026-08-04)", () => {
  // 実測(2026-08-04, race_id=202603020211): 中央のオッズページ(odds/index.html?type=b1)の
  // タブから `getDataOdds('b5','c0')`(ワイド)・`getDataOdds('b7','c0')`(3連複)を発見し、
  // 各タブのAJAXフラグメント(odds_get_form.html)内のJSで `oddsType:'5'`(ワイド)・
  // `oddsType:'7'`(3連複、フラグメントのdo_update_odds呼び出しから確認)であることを
  // 独立に観測した。既存のoddsApiUrl(type=1)と同一のAPI(api_get_jra_odds.html)を
  // 数値typeのみ変えて叩けば、1レース分の全組合せが1リクエストで取得できることを
  // 実データ(race_id=202603020211・16頭)で確認済み(C(16,2)=120件・C(16,3)=560件と
  // 完全一致。docs/wide-trio-odds-investigation.md 参照)。

  it("wideOddsApiUrlは中央race_idでワイドオッズJSON APIのURL(type=5)を返すこと", () => {
    expect(wideOddsApiUrl(raceId)).toBe(
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202605020811&type=5&action=init",
    );
  });

  it("trioOddsApiUrlは中央race_idで3連複オッズJSON APIのURL(type=7)を返すこと", () => {
    expect(trioOddsApiUrl(raceId)).toBe(
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202605020811&type=7&action=init",
    );
  });

  it("wideOddsApiUrlに地方race_idを渡すとNarUnsupportedErrorになること(中央用JSON APIはNARに存在しない)", () => {
    expect(() => wideOddsApiUrl(narRaceId)).toThrow(NarUnsupportedError);
  });

  it("trioOddsApiUrlに地方race_idを渡すとNarUnsupportedErrorになること(中央用JSON APIはNARに存在しない)", () => {
    expect(() => trioOddsApiUrl(narRaceId)).toThrow(NarUnsupportedError);
  });
});

describe("narWideOddsPageUrl/narTrioOddsPageUrl(地方 ワイド・三連複オッズページ。機能D-1 実測2026-08-04)", () => {
  // 実測(2026-08-04, race_id=202654071210・12頭): type=b5(ワイド)は静的HTMLに全軸の
  // テーブルが1ページに含まれ、C(12,2)=66件と完全一致(軸馬別の制限なし)。
  // type=b7(3連複)は「軸馬選択」UI(#list_select_horse)を持ち、クエリ未指定時は
  // 軸馬1固定のC(11,2)=55件のみを返す(軸馬別取得。全組合せC(12,3)=220件を得るには
  // 軸1〜10の最大10リクエストが必要。&jiku=Nで軸を指定可能なことをAJAXフラグメント
  // (odds_get_form.html)で確認したが、本関数(index.htmlの直接URL)は軸1固定の
  // デフォルト応答を返す形に留める。全軸を機械的に走査する挙動は機能Dへの備えとして
  // #14着手前ゲートで判断する。詳細: docs/wide-trio-odds-investigation.md)。
  it("narWideOddsPageUrlはtype=b5固定のクエリ付き地方ワイドオッズページURLを返すこと", () => {
    expect(narWideOddsPageUrl(narRaceId)).toBe(
      "https://nar.netkeiba.com/odds/index.html?type=b5&race_id=202654071210",
    );
  });

  it("narTrioOddsPageUrlはtype=b7固定のクエリ付き地方3連複オッズページURLを返すこと", () => {
    expect(narTrioOddsPageUrl(narRaceId)).toBe(
      "https://nar.netkeiba.com/odds/index.html?type=b7&race_id=202654071210",
    );
  });
});

describe("gradeWinnerApiUrl/gradeWinnerRefererUrl/gradeWinnerOriginUrl(過去10年結果API。タスク機能B: 中央/地方でホストを出し分け)", () => {
  it("中央race_idではrace.netkeiba.comのURL・Referer(past10.html)・Originを返すこと", () => {
    expect(gradeWinnerApiUrl(raceId)).toBe("https://race.netkeiba.com/race_api/");
    expect(gradeWinnerRefererUrl(raceId)).toBe(
      "https://race.netkeiba.com/race/past10.html?race_id=202605020811",
    );
    expect(gradeWinnerOriginUrl(raceId)).toBe("https://race.netkeiba.com");
  });

  it("地方race_idではnar.netkeiba.comのURL・Referer(past5.html。ページ名が中央〈past10.html〉と異なる)・Originを返すこと", () => {
    expect(gradeWinnerApiUrl(narRaceId)).toBe("https://nar.netkeiba.com/race_api/");
    expect(gradeWinnerRefererUrl(narRaceId)).toBe(
      "https://nar.netkeiba.com/race/past5.html?race_id=202654071210",
    );
    expect(gradeWinnerOriginUrl(narRaceId)).toBe("https://nar.netkeiba.com");
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
    expect(mod.gradeWinnerApiUrl).toBe(gradeWinnerApiUrl);
    expect(mod.gradeWinnerRefererUrl).toBe(gradeWinnerRefererUrl);
    expect(mod.gradeWinnerOriginUrl).toBe(gradeWinnerOriginUrl);
    expect(mod.wideOddsApiUrl).toBe(wideOddsApiUrl);
    expect(mod.trioOddsApiUrl).toBe(trioOddsApiUrl);
    expect(mod.narWideOddsPageUrl).toBe(narWideOddsPageUrl);
    expect(mod.narTrioOddsPageUrl).toBe(narTrioOddsPageUrl);
  });

  it("不採用となったnewspaperUrlは公開されないこと", async () => {
    const mod = await import("../../src/index.js");
    expect("newspaperUrl" in mod).toBe(false);
  });
});
