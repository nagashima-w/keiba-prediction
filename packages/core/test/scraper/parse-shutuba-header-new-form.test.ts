/**
 * 出馬表の見出し(`div.RaceData01`)の「新しい形」の読み取りのテスト(Issue #521)。
 *
 * netkeiba が見出しの形を変えたため、天候・馬場状態・柵が読めなくなっていた(2026-10-28 に実測)。
 *
 * - 旧い形: `芝1200m (右 外 C) / 天候:曇 / 馬場:重`(括弧つきの柵、文字の「天候:」「馬場:」)
 * - 新しい形: `芝1400m 左 A / <天候アイコン aria-label="曇"> <span class="Item03"> 良</span>`
 *   (括弧なしの柵、天候はアイコンの aria-label、馬場状態は span.Item03〈芝・障害〉または span.Item04〈ダート〉)
 *
 * 旧い形のテストは既存の parse-shutuba.test.ts・parse-shutuba-fence.test.ts が受け持つ(書き換えない)。
 * ここは新しい形と、旧い形が優先されることだけを見る。
 * 見出しの断片は、2026-10-28 に取った実物(結果ページ。見出しは出馬表と同じ形)から、そのままコピーしたもの。
 */

import { describe, expect, it } from "vitest";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";
import { loadFixture } from "../support/fixtures.js";

/** 出馬表ページ全体を組み立てる(RaceData01 のみ可変。他は最小限の 1 頭ぶん)。 */
function buildPage(raceData01: string): string {
  return `
    <div class="RaceList_Item02">
      <h1 class="RaceName">テストレース</h1>
      <div class="RaceData01">${raceData01}</div>
    </div>
    <table><tbody>
      <tr class="HorseList">
        <td class="Waku1 Txt_C"><span>1</span></td>
        <td class="Umaban1 Txt_C">1</td>
        <td class="HorseInfo"><span class="HorseName"><a href="https://db.netkeiba.com/horse/2023103386" title="テスト馬">テスト馬</a></span></td>
        <td class="Barei Txt_C">牡3</td>
        <td class="Txt_C">55.0</td>
        <td class="Jockey"><a href="https://db.netkeiba.com/jockey/result/recent/01043/" title="騎手">騎手</a></td>
        <td class="Trainer"><span class="Label1">美浦</span><a href="https://db.netkeiba.com/trainer/result/recent/01126/" title="調教師">調教師</a></td>
        <td class="Weight">464(-8)</td>
      </tr>
    </tbody></table>`;
}

describe("parseShutuba(新しい形の見出し・実フィクスチャ)", () => {
  it("shutuba_202605040110(東京芝1400m・左 A・曇・良)から天候・馬場状態・柵が読めること", () => {
    const { race } = parseShutuba(loadFixture("shutuba_202605040110.html"));
    expect(race.courseType).toBe("芝");
    expect(race.distance).toBe(1400);
    expect(race.startTime).toBe("15:10");
    expect(race.weather).toBe("曇");
    expect(race.trackCondition).toBe("良");
    expect(race.fence).toBe("A");
  });
});

/** 実物の見出し(結果ページ 202608040407 等から、そのままコピーしたもの)。 */
const REAL = {
  /** 202608040407: 芝・右 外 A・晴・良(風の span あり) */
  turfRightOuter: '\n13:10発走 /<!-- <span class="Turf"> --><span> 芝1800m</span> 右 外&nbsp;A\n\n/ <span class="Icon_Weather02 Icon_W01" role="img" aria-label="晴" title="晴"></span>\n\n<span class="Item03"> 良</span>\n\n<span class="Item05">/ 直線：弱横風</span>\n',
  /** 202604040409: 芝・左 外 A・雨・不(不良) */
  turfLeftOuterBad: '\n14:00発走 /<!-- <span class="Turf"> --><span> 芝1600m</span> 左 外&nbsp;A\n\n/ <span class="Icon_Weather02 Icon_W04" role="img" aria-label="雨" title="雨"></span>\n\n<span class="Item03"> 不</span>\n\n<span class="Item05">/ 直線：弱横風</span>\n',
  /** 202604040112: 芝1000m 直線・A・晴・良 */
  turfStraight: '\n16:01発走 /<!-- <span class="Turf"> --><span> 芝1000m</span> 直線&nbsp;A\n\n/ <span class="Icon_Weather02 Icon_W01" role="img" aria-label="晴" title="晴"></span>\n\n<span class="Item03"> 良</span>\n\n<span class="Item05">/ 直線：中横風</span>\n',
  /** 202605040807: ダ・左・雨・稍(馬場状態は Item04) */
  dirtLeft: '\n13:25発走 /<!-- <span class="Turf"> --><span> ダ1600m</span> 左\n\n/ <span class="Icon_Weather02 Icon_W04" role="img" aria-label="雨" title="雨"></span>\n\n\n<span class="Item04"> 稍</span>\n<span class="Item05">/ 直線：弱横風</span>\n',
  /** 202605040709: 障・芝(括弧なし)・晴・良 */
  jump: '\n14:10発走 /<!-- <span class="Turf"> --><span> 障3110m</span> 芝\n\n/ <span class="Icon_Weather02 Icon_W01" role="img" aria-label="晴" title="晴"></span>\n\n<span class="Item03"> 良</span>\n\n<span class="Item05">/ 直線：中横風</span>\n',
  /** 202608040209: 芝・右 A・雨・稍(天候アイコンのクラスがもう一方の系統。aria-label は同じく付く) */
  turfRightOldIconClass: '\n14:15発走 /<!-- <span class="Turf"> --><span> 芝2000m</span> 右&nbsp;A\n\n\n/ <span class="Icon_Weather Weather03" role="img" aria-label="雨" title="雨"></span>\n<span class="Item03"> 稍</span>\n\n\n',
  /** 202604040407: 芝・左 外 A・雨・重 */
  turfHeavy: '\n13:00発走 /<!-- <span class="Turf"> --><span> 芝2000m</span> 左 外&nbsp;A\n\n/ <span class="Icon_Weather02 Icon_W04" role="img" aria-label="雨" title="雨"></span>\n\n<span class="Item03"> 重</span>\n\n<span class="Item05">/ 直線：弱横風</span>\n',
} as const;

describe("parseShutuba(新しい形の見出し・実物の見出しの断片。表は変種ごとの期待値)", () => {
  const cases: ReadonlyArray<{
    name: string;
    html: string;
    courseType: "芝" | "ダ" | "障";
    distance: number;
    weather: string;
    trackCondition: string;
    /** 芝のときだけ柵の文字。芝以外は undefined(キー自体が無い)。 */
    fence: string | undefined;
  }> = [
    { name: "芝・右 外 A・晴・良", html: REAL.turfRightOuter, courseType: "芝", distance: 1800, weather: "晴", trackCondition: "良", fence: "A" },
    { name: "芝・左 外 A・雨・不", html: REAL.turfLeftOuterBad, courseType: "芝", distance: 1600, weather: "雨", trackCondition: "不", fence: "A" },
    { name: "芝・直線 A・晴・良", html: REAL.turfStraight, courseType: "芝", distance: 1000, weather: "晴", trackCondition: "良", fence: "A" },
    { name: "ダ・左・雨・稍(Item04)", html: REAL.dirtLeft, courseType: "ダ", distance: 1600, weather: "雨", trackCondition: "稍", fence: undefined },
    { name: "障・芝・晴・良(柵なし)", html: REAL.jump, courseType: "障", distance: 3110, weather: "晴", trackCondition: "良", fence: undefined },
    { name: "芝・右 A・雨・稍(別系統の天候アイコン)", html: REAL.turfRightOldIconClass, courseType: "芝", distance: 2000, weather: "雨", trackCondition: "稍", fence: "A" },
    { name: "芝・左 外 A・雨・重", html: REAL.turfHeavy, courseType: "芝", distance: 2000, weather: "雨", trackCondition: "重", fence: "A" },
  ];

  it.each(cases)("$name", ({ html, courseType, distance, weather, trackCondition, fence }) => {
    const { race } = parseShutuba(buildPage(html));
    expect(race.courseType).toBe(courseType);
    expect(race.distance).toBe(distance);
    expect(race.weather).toBe(weather);
    expect(race.trackCondition).toBe(trackCondition);
    if (courseType === "芝") {
      // 芝は柵の文字が必ず取れる(取れないと null になり、下の toBe が落ちる)。
      expect(fence).toBeDefined();
      expect(race.fence).toBe(fence);
    } else {
      expect("fence" in race).toBe(false);
    }
  });

  it("表の変種に、芝・ダ・障と、馬場状態の良・稍・重・不がすべて含まれていること(表が退化していない前提)", () => {
    expect(new Set(cases.map((c) => c.courseType))).toEqual(new Set(["芝", "ダ", "障"]));
    expect(new Set(cases.map((c) => c.trackCondition))).toEqual(new Set(["良", "稍", "重", "不"]));
    expect(new Set(cases.map((c) => c.fence))).toEqual(new Set(["A", undefined]));
  });
});

describe("parseShutuba(新しい形の見出し・柵の境界)", () => {
  it("芝で回り方向だけ(柵の文字なし)なら fence=null。直後の風の span(「直線：…」)を柵と取らないこと", () => {
    const html = buildPage(
      '\n13:10発走 /<!-- <span class="Turf"> --><span> 芝1800m</span> 右\n\n/ <span class="Icon_Weather02 Icon_W01" role="img" aria-label="晴" title="晴"></span>\n\n<span class="Item03"> 良</span>\n\n<span class="Item05">/ 直線：弱横風</span>\n',
    );
    const { race } = parseShutuba(html);
    expect(race.courseType).toBe("芝");
    expect(race.fence).toBeNull();
  });

  it("芝の距離のあとに何も続かず「/」で次の要素に移るなら fence=null", () => {
    const { race } = parseShutuba(buildPage('13:10発走 / <span> 芝1800m</span> / <span class="Item03"> 良</span>'));
    expect(race.fence).toBeNull();
  });

  it("旧い形(括弧つき)が新しい形の読み方より優先されること(括弧の中の C を取り、後ろの A は取らない)", () => {
    const { race } = parseShutuba(buildPage("15:45発走 / 芝1200m (右 外&nbsp;C) A / 天候:晴 / 馬場:良"));
    expect(race.fence).toBe("C");
  });
});

describe("parseShutuba(新しい形の見出し・天候)", () => {
  const withWeather = (icon: string): string =>
    buildPage(`13:10発走 / <span> 芝1800m</span> 右&nbsp;A / ${icon} <span class="Item03"> 良</span>`);

  it("aria-label が空白を含む(1 トークンでない)なら天候は読まない(キーが無い)", () => {
    const { race } = parseShutuba(withWeather('<span class="Icon_Weather Weather03" aria-label="小 雨"></span>'));
    expect("weather" in race).toBe(false);
  });

  it("aria-label が空なら天候は読まない(キーが無い)", () => {
    const { race } = parseShutuba(withWeather('<span class="Icon_Weather Weather03" aria-label="  "></span>'));
    expect("weather" in race).toBe(false);
  });

  it("aria-label が無い天候アイコンだけなら天候は読まない(キーが無い)", () => {
    const { race } = parseShutuba(withWeather('<span class="Icon_Weather Weather03"></span>'));
    expect("weather" in race).toBe(false);
  });

  it("天候アイコン以外の aria-label は天候と取らないこと", () => {
    const { race } = parseShutuba(withWeather('<span class="Other" aria-label="曇"></span>'));
    expect("weather" in race).toBe(false);
  });

  it("aria-label の前後の空白は除いて読むこと", () => {
    const { race } = parseShutuba(withWeather('<span class="Icon_Weather Weather03" aria-label=" 雨 "></span>'));
    expect(race.weather).toBe("雨");
  });

  it("旧い形の「天候:」の文字が優先されること", () => {
    const { race } = parseShutuba(
      buildPage('15:45発走 / 芝1800m (右&nbsp;A) / 天候:晴<span class="Icon_Weather Weather02" aria-label="曇"></span> / 馬場:良'),
    );
    expect(race.weather).toBe("晴");
  });
});

describe("parseShutuba(新しい形の見出し・馬場状態)", () => {
  const withItem = (cls: string, text: string): string =>
    buildPage(`13:10発走 / <span> 芝1800m</span> 右&nbsp;A / <span class="${cls}">${text}</span>`);

  it.each(["良", "稍", "重", "不", "稍重", "不良"])("許可リストの語「%s」を読むこと(前後の空白は除く)", (word) => {
    expect(parseShutuba(withItem("Item03", ` ${word}`)).race.trackCondition).toBe(word);
    expect(parseShutuba(withItem("Item04", ` ${word} `)).race.trackCondition).toBe(word);
  });

  it.each(["−", "水分量:2.5", "", "不明", "良/稍"])("許可リスト外の「%s」は馬場状態として読まない(キーが無い)", (text) => {
    const { race } = parseShutuba(withItem("Item04", text));
    expect("trackCondition" in race).toBe(false);
  });

  it("Item05(風)は馬場状態と取らないこと", () => {
    const { race } = parseShutuba(withItem("Item05", " 良"));
    expect("trackCondition" in race).toBe(false);
  });

  it("旧い形の「馬場:」の文字が優先されること(旧い形の中身はそのまま返す。未発表の「−」も従来どおり)", () => {
    expect(parseShutuba(buildPage('13:30発走 / ダ1300m (左)\n<span class="Item04">/ 馬場:−</span>')).race.trackCondition).toBe("−");
    expect(
      parseShutuba(buildPage('15:45発走 / 芝1800m (右&nbsp;A) / 天候:晴 / <span class="Item03">馬場:稍</span>')).race.trackCondition,
    ).toBe("稍");
  });
});
