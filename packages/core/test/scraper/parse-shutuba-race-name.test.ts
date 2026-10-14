/**
 * 出馬表の `race.raceName`(Issue #252): 中央は `h1.RaceName`、地方は `div.RaceName` から取る。
 *
 * 不具合: セレクタが `h1.RaceName` だけだったため、地方(`<div class="RaceName">`)では常に空文字になっていた。
 * 地方の `div.RaceName` は、レース名の後ろにグレードのアイコン(`<span class="Icon_Grade_None_Text …">Jpn1</span>`)
 * が同じ要素の内側に入るため、そのテキストをレース名に混ぜないことも固定する。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** `<title>` の「レース名(括弧内) 出馬表 | …」から、括弧と「出馬表」より前のレース名を取り出す。 */
function titleName(html: string): string | undefined {
  return /<title>([^<]*?)(?:\([^)<]*\))? 出馬表/.exec(html)?.[1];
}

describe("parseShutuba(地方のレース名。div.RaceName から。Issue #252)", () => {
  // [フィクスチャ, 期待するレース名]
  // 期待値は、フィクスチャの <div class="RaceName"> の中身(グレードのアイコンを除く)と
  // netkeiba の <title> から取った。一般戦は div の中に「(C3)」「(C1)」の格付けが付く(一覧ページの
  // レース名「ランチタイム(C3)」と同じ表記。title は括弧を落としている)。
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["nar_shutuba_202642071301.html", "ランチタイム(C3)"], // 浦和1R
    ["nar_shutuba_202654071210.html", "ファイナルレース(C1)"], // 高知10R
    ["nar_shutuba_grade_202644070111.html", "帝王賞"], // 大井11R・Jpn1(div 内にグレードの span が同居する)
  ];

  it.each(cases)("%s のレース名が空でなく、期待どおりであること", (fixture, expected) => {
    const race = parseShutuba(loadFixture(fixture)).race;
    // 前提: 修正前は全件 "" だった。空文字でないことを無条件に固定してから中身を比べる。
    expect(race.raceName).not.toBe("");
    expect(race.raceName).toBe(expected);
  });

  it.each(cases)("%s のレース名が <title> のレース名で始まること(実物との照合)", (fixture, expected) => {
    const html = loadFixture(fixture);
    const fromTitle = titleName(html);
    expect(fromTitle).toBeDefined();
    expect(fromTitle).not.toBe("");
    expect(expected.startsWith(fromTitle!)).toBe(true);
    expect(parseShutuba(html).race.raceName.startsWith(fromTitle!)).toBe(true);
  });

  it("グレードのテキスト(Jpn1)がレース名に混ざらず、grade としては読めていること", () => {
    const race = parseShutuba(loadFixture("nar_shutuba_grade_202644070111.html")).race;
    // 前提: このフィクスチャの div.RaceName の内側にはグレードの span が実在する(混入し得る状況)。
    expect(race.grade).toBe("Jpn1");
    expect(race.raceName).not.toContain("Jpn1");
    expect(race.raceName).toBe("帝王賞");
  });

  it("地方の div.RaceName で、グレードの span がレース名の前にあっても混ざらないこと(合成)", () => {
    const html = loadFixture("nar_shutuba_grade_202644070111.html");
    const span = '<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType19 Icon_GradePos01">Jpn1</span>';
    const original = /<div class="RaceName">[\s\S]*?<\/div>/.exec(html)![0];
    // 前提: 置換対象に span が実在する(実物は「レース名 → span」の順。ここでは「span → レース名」の順に入れ替える)。
    expect(original).toContain(span);
    const swapped = html.replace(original, `<div class="RaceName">${span}\n帝王賞\n</div>`);
    expect(swapped).not.toBe(html);
    const race = parseShutuba(swapped).race;
    expect(race.raceName).toBe("帝王賞");
    expect(race.grade).toBe("Jpn1");
  });
});

describe("parseShutuba(中央のレース名は変わらない。Issue #252)", () => {
  // [フィクスチャ, 修正前から返していたレース名] — 修正前の parseShutuba の出力をそのまま固定する。
  const central: ReadonlyArray<readonly [string, string]> = [
    ["shutuba_202602010601.html", "2歳未勝利"],
    ["shutuba_202602010607.html", "3歳以上1勝クラス"],
    ["shutuba_202603020211.html", "ラジオNIKKEI賞"],
    ["shutuba_202605040211.html", "毎日王冠"],
    ["shutuba_202606030711.html", "中山グランドJ"],
    ["shutuba_202606040901.html", "2歳未勝利"],
    ["shutuba_202606040911.html", "スプリンターズS"],
    ["shutuba_202609010708.html", "阪神スプリングジャンプ"],
    ["shutuba_202610010708.html", "小倉ジャンプS"],
  ];

  it.each(central)("%s のレース名が変わらないこと", (fixture, expected) => {
    expect(parseShutuba(loadFixture(fixture)).race.raceName).toBe(expected);
  });

  it("グレードのアイコン(テキストなし)が h1 内にあっても、レース名に混ざらないこと", () => {
    // 毎日王冠: h1.RaceName の内側に Icon_GradeType の span が実在する(G2 の番号 2 と 13 が並ぶ)。
    const html = loadFixture("shutuba_202605040211.html");
    const h1 = /<h1 class="RaceName">[\s\S]*?<\/h1>/.exec(html)![0];
    expect(h1).toContain("Icon_GradeType");
    expect(parseShutuba(html).race.raceName).toBe("毎日王冠");
  });
});
