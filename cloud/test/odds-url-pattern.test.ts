import { describe, expect, it } from "vitest";

import { parseHorseId, parseKaisaiDate, parseRaceId } from "../../packages/core/src/scraper/ids";
import * as urls from "../../packages/core/src/scraper/urls";
import { ODDS_URL_PATTERN } from "../src/race-day-core";

/**
 * Issue #178(再レビュー指摘): 発走前の計算ステップがオッズとして鮮度を見る URL(`ODDS_URL_PATTERN`)の分類を、
 * `packages/core/src/scraper/urls.ts` が export する URL ビルダー全部に対して検査する。
 * 地方の3連複・3連単の軸馬別(`odds/odds_get_form.html?...&jiku=N`)が、パターンから漏れていたせいで前回の実行の
 * キャッシュが今回の分析に使われた(`odds/index.html` しか見ていなかった)。
 *
 * 列挙は手書きの一覧ではなく `import * as urls` の export から取り、**全ビルダーが「オッズ」「オッズでない」のどちらかに
 * 分類されていること**を検査する。新しいビルダーが urls.ts に増えたら、分類を決めるまでこのテストが落ちる。
 */

const CENTRAL = parseRaceId("202603020211");
const NAR = parseRaceId("202654071210");
const DATE = parseKaisaiDate("20260628");
const HORSE = parseHorseId("2023103386");

/** オッズを返すビルダー → そのビルダーの呼び出し(中央用・地方用の引数)。 */
const ODDS_BUILDERS: Record<string, () => string[]> = {
  oddsApiUrl: () => [urls.oddsApiUrl(CENTRAL)],
  wideOddsApiUrl: () => [urls.wideOddsApiUrl(CENTRAL)],
  trioOddsApiUrl: () => [urls.trioOddsApiUrl(CENTRAL)],
  exactaOddsApiUrl: () => [urls.exactaOddsApiUrl(CENTRAL)],
  quinellaOddsApiUrl: () => [urls.quinellaOddsApiUrl(CENTRAL)],
  trifectaOddsApiUrl: () => [urls.trifectaOddsApiUrl(CENTRAL)],
  bracketQuinellaOddsApiUrl: () => [urls.bracketQuinellaOddsApiUrl(CENTRAL)],
  narOddsPageUrl: () => [urls.narOddsPageUrl(NAR)],
  narWideOddsPageUrl: () => [urls.narWideOddsPageUrl(NAR)],
  narExactaOddsPageUrl: () => [urls.narExactaOddsPageUrl(NAR)],
  narQuinellaOddsPageUrl: () => [urls.narQuinellaOddsPageUrl(NAR)],
  narBracketQuinellaOddsPageUrl: () => [urls.narBracketQuinellaOddsPageUrl(NAR)],
  narTrioOddsPageUrl: () => [urls.narTrioOddsPageUrl(NAR)],
  // 軸馬別は軸ごとに別 URL。複数の軸で確かめる。
  narTrioOddsAxisUrl: () => [1, 2, 10].map((jiku) => urls.narTrioOddsAxisUrl(NAR, jiku)),
  narTrifectaOddsAxisUrl: () => [1, 2, 10].map((jiku) => urls.narTrifectaOddsAxisUrl(NAR, jiku)),
};

/** オッズでないビルダー(出馬表・追い切り・戦績・結果・レース一覧ほか)。中央・地方の両方があるものは両方で確かめる(追い切り・コメントは中央のみ)。 */
const NON_ODDS_BUILDERS: Record<string, () => string[]> = {
  raceListSubUrl: () => [urls.raceListSubUrl(DATE)],
  narRaceListSubUrl: () => [urls.narRaceListSubUrl(DATE)],
  shutubaUrl: () => [urls.shutubaUrl(CENTRAL), urls.shutubaUrl(NAR)],
  oikiriUrl: () => [urls.oikiriUrl(CENTRAL)],
  commentUrl: () => [urls.commentUrl(CENTRAL)],
  horseUrl: () => [urls.horseUrl(HORSE)],
  horseResultsApiUrl: () => [urls.horseResultsApiUrl(HORSE)],
  raceResultUrl: () => [urls.raceResultUrl(CENTRAL), urls.raceResultUrl(NAR)],
  gradeWinnerApiUrl: () => [urls.gradeWinnerApiUrl(CENTRAL), urls.gradeWinnerApiUrl(NAR)],
  gradeWinnerRefererUrl: () => [urls.gradeWinnerRefererUrl(CENTRAL), urls.gradeWinnerRefererUrl(NAR)],
  gradeWinnerOriginUrl: () => [urls.gradeWinnerOriginUrl(CENTRAL), urls.gradeWinnerOriginUrl(NAR)],
};

const exportedBuilders = Object.entries(urls)
  .filter(([name, value]) => typeof value === "function" && name.endsWith("Url"))
  .map(([name]) => name)
  .sort();

describe("オッズの URL の分類(ODDS_URL_PATTERN。Issue #178)", () => {
  it("urls.ts が export する URL ビルダー(…Url)は、すべて「オッズ」か「オッズでない」のどちらかに分類済み(新しいビルダーが増えたら分類を決める)", () => {
    expect(exportedBuilders.length).toBeGreaterThan(20); // 前提: 列挙が空振りしていない
    const classified = [...Object.keys(ODDS_BUILDERS), ...Object.keys(NON_ODDS_BUILDERS)].sort();
    expect(classified).toEqual(exportedBuilders);
    expect(Object.keys(ODDS_BUILDERS).filter((n) => n in NON_ODDS_BUILDERS)).toEqual([]);
  });

  it.each(Object.keys(ODDS_BUILDERS))("オッズのビルダー %s が作る URL は、すべてオッズと判定される", (name) => {
    const built = ODDS_BUILDERS[name]!();
    expect(built.length).toBeGreaterThan(0);
    for (const url of built) {
      expect(ODDS_URL_PATTERN.test(url), url).toBe(true);
    }
  });

  it.each(Object.keys(NON_ODDS_BUILDERS))("オッズでないビルダー %s が作る URL は、オッズと判定されない(出馬表・戦績などの再取得を、鮮度の対象にしない)", (name) => {
    const built = NON_ODDS_BUILDERS[name]!();
    expect(built.length).toBeGreaterThan(0);
    for (const url of built) {
      expect(ODDS_URL_PATTERN.test(url), url).toBe(false);
    }
  });

  it("前提: 地方の軸馬別のURLは `odds/odds_get_form.html` で、`odds/index.html` ではない(このパスが漏れていたことの再現)", () => {
    const axis = urls.narTrioOddsAxisUrl(NAR, 1);
    expect(axis).toContain("/odds/odds_get_form.html");
    expect(axis).not.toContain("/odds/index.html");
    expect(urls.narTrifectaOddsAxisUrl(NAR, 1)).toContain("/odds/odds_get_form.html");
  });
});
