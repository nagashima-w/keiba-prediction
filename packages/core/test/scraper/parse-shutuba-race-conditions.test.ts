/**
 * 出馬表の `race.weightType`(負担重量の種別)・`race.filliesOnly`(牝馬限定)(Issue #421 段階 1)。
 *
 * 読む場所は `div.RaceData02` の中の span だけ(位置に依存しない)。種別は span の文字列と完全一致で拾い(レース名の「…ハンデ」に当てない)、
 * 牝馬限定は条件の span が「牝」を含むかで判定する。**地方は読まない**: `parseShutuba` の `readRaceConditions` は既定 false で、
 * 指定しない限り中央の出馬表でもキーを付けない(`scrapeRace` が `!isNar` を渡す)。
 */

import { describe, expect, it } from "vitest";
import { isFilliesOnlyCondition, WEIGHT_TYPES } from "../../src/scraper/race-condition.js";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";
import { loadFixture } from "../support/fixtures.js";

const READ = { readRaceConditions: true } as const;

/** 最小限の出馬表 HTML(RaceData01 と 1 頭ぶんの行)。RaceData02 の中身と、RaceData02 の外に置くレース名だけを差し替える。 */
function minimalShutuba(options: { readonly data02?: string | null; readonly raceName?: string }): string {
  const data02 = options.data02 === undefined ? "<span>1回</span><span>函館</span><span>定量</span><span>10頭</span>" : options.data02;
  return `<html><body>
<h1 class="RaceName">${options.raceName ?? "テスト特別"}</h1>
<div class="RaceData01"><span>15:45発走</span> / <span>芝1800m</span> (右) / 天候:晴</div>
${data02 === null ? "" : `<div class="RaceData02">${data02}</div>`}
<table><tr class="HorseList"><td class="Waku1"><span>1</span></td><td class="Umaban1">1</td>
<td class="HorseInfo"><span class="HorseName"><a href="https://db.netkeiba.com/horse/2020100001" title="テストホース">テストホース</a></span></td>
<td class="Barei">牡3</td><td>56.0</td><td class="Jockey"><a href="https://db.netkeiba.com/jockey/result/recent/01001/" title="騎手A">騎手A</a></td>
<td class="Trainer"><span class="Label1">美浦</span><a href="https://db.netkeiba.com/trainer/01001/" title="調教師A">調教師A</a></td><td class="Weight">480<small>(+2)</small></td></tr></table>
</body></html>`;
}

describe("parseShutuba(中央の負担重量の種別・牝馬限定。実フィクスチャ。Issue #421)", () => {
  // [フィクスチャ, 期待する weightType, 期待する filliesOnly]
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["shutuba_202602010601.html", "馬齢", false], // 函館 未勝利 (混)[指]
    ["shutuba_202602010607.html", "定量", true], // 函館 1勝クラス 牝[指]
    ["shutuba_202603020211.html", "ハンデ", false], // 福島 ラジオNIKKEI賞 (国際)(特指)
    ["shutuba_202605040211.html", "別定", false], // 東京 毎日王冠 (国際)(指)
    ["shutuba_202606030711.html", "定量", false], // 中山 障害オープン (国際)
    ["shutuba_202606040901.html", "馬齢", true], // 中山 未勝利 牝[指]
    ["shutuba_202606040911.html", "定量", false], // 中山 スプリンターズS (国際)(指)
    ["shutuba_202609010708.html", "別定", false], // 阪神 障害オープン (混)
    ["shutuba_202610010708.html", "別定", false], // 小倉 障害オープン (混)
  ];

  it.each(cases)("%s: weightType=%s・filliesOnly=%s", (fixture, weightType, filliesOnly) => {
    const race = parseShutuba(loadFixture(fixture), READ).race;
    expect(race.weightType).toBe(weightType);
    expect(race.filliesOnly).toBe(filliesOnly);
  });

  it("前提: 固定している出馬表は 9 件で、4 種別がすべて現れ、牝馬限定は 2 件(表が空振りしていないことの確認)", () => {
    expect(cases).toHaveLength(9);
    expect(new Set(cases.map((c) => c[1]))).toEqual(new Set(WEIGHT_TYPES));
    expect(cases.filter((c) => c[2])).toHaveLength(2);
  });

  it("readRaceConditions を指定しない(既定)と、中央の出馬表でもキー自体を持たない(地方は読まない担保)", () => {
    for (const [fixture] of cases) {
      const html = loadFixture(fixture);
      // 対照: 指定すれば読める出馬表であること(キー無しの主張が空振りしない)。
      expect(parseShutuba(html, READ).race.filliesOnly, fixture).not.toBeUndefined();
      const race = parseShutuba(html).race;
      expect("weightType" in race, fixture).toBe(false);
      expect("filliesOnly" in race, fixture).toBe(false);
      const explicitFalse = parseShutuba(html, { readRaceConditions: false }).race;
      expect("weightType" in explicitFalse, fixture).toBe(false);
      expect("filliesOnly" in explicitFalse, fixture).toBe(false);
    }
  });

  it("地方の出馬表(3 件)には種別・牝の span が無く、weightType はキー自体を持たない", () => {
    for (const fixture of ["nar_shutuba_202642071301.html", "nar_shutuba_202654071210.html", "nar_shutuba_grade_202644070111.html"]) {
      const race = parseShutuba(loadFixture(fixture), READ).race;
      expect("weightType" in race, fixture).toBe(false);
    }
  });
});

describe("parseShutuba(負担重量の種別・牝馬限定の境界。合成 HTML。Issue #421)", () => {
  it("前提(対照): 最小の HTML で種別と牝馬限定でない値が読めること", () => {
    const race = parseShutuba(minimalShutuba({}), READ).race;
    expect(race.weightType).toBe("定量");
    expect(race.filliesOnly).toBe(false);
  });

  it("`(国際)牝(指)` の形(牝が括弧の間にある)でも牝馬限定になる", () => {
    const race = parseShutuba(minimalShutuba({ data02: "<span>2回</span><span>京都</span><span>(国際)牝(指)</span><span>馬齢</span><span>18頭</span>" }), READ).race;
    expect(race.filliesOnly).toBe(true);
    expect(race.weightType).toBe("馬齢");
  });

  it("span の並びに依存しない(種別が頭数の後ろ・条件の前に来ても拾う)", () => {
    const reordered = parseShutuba(minimalShutuba({ data02: "<span>ハンデ</span><span>16頭</span><span>牝[指]</span><span>1回</span>" }), READ).race;
    expect(reordered.weightType).toBe("ハンデ");
    expect(reordered.filliesOnly).toBe(true);
  });

  it("RaceData02 が無いとき、2 つのキーとも持たない(読めなかったことを false で偽らない)", () => {
    const race = parseShutuba(minimalShutuba({ data02: null }), READ).race;
    expect("weightType" in race).toBe(false);
    expect("filliesOnly" in race).toBe(false);
  });

  it("RaceData02 はあるが種別の span が無いとき、weightType はキー無し・filliesOnly は確定値(false)", () => {
    const race = parseShutuba(minimalShutuba({ data02: "<span>1回</span><span>函館</span><span>10頭</span>" }), READ).race;
    expect("weightType" in race).toBe(false);
    expect(race.filliesOnly).toBe(false);
  });

  it("部分一致はしない: span が「ハンデ戦」「ハンデキャップ」のとき種別とみなさない", () => {
    // 対照: 完全一致の span があれば読める。
    expect(parseShutuba(minimalShutuba({ data02: "<span>ハンデ</span>" }), READ).race.weightType).toBe("ハンデ");
    for (const text of ["ハンデ戦", "ハンデキャップ", "別定重量", "定量(馬齢)の目安"]) {
      const race = parseShutuba(minimalShutuba({ data02: `<span>${text}</span>` }), READ).race;
      expect("weightType" in race, text).toBe(false);
    }
  });

  it("レース名(RaceData02 の外)の「ハンデ」「牝」は種別・牝馬限定に影響しない", () => {
    const race = parseShutuba(minimalShutuba({ raceName: "牝馬ハンデキャップ", data02: "<span>定量</span><span>10頭</span>" }), READ).race;
    expect(race.weightType).toBe("定量");
    expect(race.filliesOnly).toBe(false);
  });

  it("span の前後の空白・改行は無視して完全一致する", () => {
    const race = parseShutuba(minimalShutuba({ data02: "<span>\n  別定 \n</span>" }), READ).race;
    expect(race.weightType).toBe("別定");
  });

  it("種別が 2 種類出たら(曖昧)キー無し。同じ種別が重複しても 1 種類なので読める", () => {
    const ambiguous = parseShutuba(minimalShutuba({ data02: "<span>ハンデ</span><span>別定</span>" }), READ).race;
    expect("weightType" in ambiguous).toBe(false);
    const dup = parseShutuba(minimalShutuba({ data02: "<span>ハンデ</span><span>ハンデ</span>" }), READ).race;
    expect(dup.weightType).toBe("ハンデ");
  });
});

describe("isFilliesOnlyCondition(牝馬限定の判定。前走の条件〈b〉でも使う共有の規則)", () => {
  it.each([
    ["牝[指]", true],
    ["(国際)牝(指)", true],
    ["牝", true],
    ["(混)[指]", false],
    ["(国際)(特指)", false],
    ["", false],
  ])("%s → %s", (text, expected) => {
    expect(isFilliesOnlyCondition(text)).toBe(expected);
  });
});
