/**
 * 出馬表の `race.grade`(Issue #250): 中央は `h1.RaceName` 内のアイコンの番号から、地方は `div.RaceName` 内のテキストから。
 *
 * 中央は、netkeiba 自身が `<title>` に書くグレード(例: 「毎日王冠(G2) 出馬表」)と照合する
 * (番号の表が実測と食い違えばここで赤くなる)。`hasGradeBadge`(有無だけの判定)は別で、既存の
 * `parse-shutuba.test.ts` が固定している。
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

/** `<title>` の「レース名(括弧内) 出馬表」から括弧内の文字列を取り出す。 */
function titleParen(html: string): string | undefined {
  return /<title>[^<]*?\(([^)<]*)\) 出馬表/.exec(html)?.[1];
}

describe("parseShutuba(中央のグレード。アイコンの番号から。Issue #250)", () => {
  // [フィクスチャ, netkeiba の title の括弧内, 期待する grade]
  // title の障害は「JG1」と書かれる。表示は「J・G1」(ユーザー指定)。
  const graded: ReadonlyArray<readonly [string, string, string]> = [
    ["shutuba_202606040911.html", "G1", "G1"], // スプリンターズS
    ["shutuba_202605040211.html", "G2", "G2"], // 毎日王冠(RaceName 内に番号 2 と 13 が並ぶ)
    ["shutuba_202603020211.html", "G3", "G3"], // ラジオNIKKEI賞(番号 3 と 13)
    ["shutuba_202606030711.html", "JG1", "J・G1"], // 中山グランドジャンプ
    ["shutuba_202609010708.html", "JG2", "J・G2"], // 阪神スプリングジャンプ
    ["shutuba_202610010708.html", "JG3", "J・G3"], // 小倉ジャンプS
  ];

  it.each(graded)("%s: title の括弧内「%s」のレースは grade=%s になること", (fixture, titleGrade, expected) => {
    const html = loadFixture(fixture);
    // 前提(無条件): title にグレードが書かれていること。これが成り立たないと下の照合が空振りになる。
    expect(titleParen(html)).toBe(titleGrade);
    const race = parseShutuba(html).race;
    expect(race.grade).toBe(expected);
    // title の括弧内(netkeiba 自身の表記)から作った期待値とも一致すること。
    expect(race.grade).toBe(titleGrade.replace(/^JG/, "J・G"));
    expect(race.hasGradeBadge).toBe(true);
  });

  it("固定しているグレード付きの出馬表は 6 件で、grade がどれも異なる値を含むこと", () => {
    expect(graded).toHaveLength(6);
    expect(new Set(graded.map(([, , g]) => g)).size).toBe(6);
  });

  it("グレードの無い中央のレースは grade が undefined(キー自体を持たない)であること", () => {
    for (const fixture of ["shutuba_202602010601.html", "shutuba_202602010607.html", "shutuba_202606040901.html"]) {
      const race = parseShutuba(loadFixture(fixture)).race;
      expect(race.hasGradeBadge, fixture).toBe(false);
      expect(race.grade, fixture).toBeUndefined();
      expect("grade" in race, fixture).toBe(false);
    }
  });

  it("未測定の番号(4)だけが付くレースは、hasGradeBadge=true のまま grade=undefined であること(推測しない)", () => {
    const html = loadFixture("shutuba_202603020211.html");
    const replaced = html.replace('Icon_GradeType Icon_GradeType3"', 'Icon_GradeType Icon_GradeType4"');
    // 前提(無条件): 置換が実際に効いていること。
    expect(replaced).not.toBe(html);
    const race = parseShutuba(replaced).race;
    expect(race.hasGradeBadge).toBe(true);
    expect(race.grade).toBeUndefined();
  });

  it("RaceName の外のアイコンは見ないこと: RaceName の直後に番号 1 のアイコンがあっても G3 のまま", () => {
    // 出馬表には過去走の一覧など RaceName の外にも Icon_GradeType が出る(例: shutuba_202606040901 の番号 15)。
    const html = loadFixture("shutuba_202603020211.html");
    const replaced = html.replace(/(<h1 class="RaceName">[\s\S]*?<\/h1>)/, '$1<span class="Icon_GradeType Icon_GradeType1"></span>');
    expect(replaced).not.toBe(html);
    expect(parseShutuba(replaced).race.grade).toBe("G3");
  });
});

describe("parseShutuba(地方のグレード。テキストから。Issue #250)", () => {
  it("地方のJpn1(帝王賞、div.RaceName)は、アイコン内のテキストをそのまま grade にすること", () => {
    const html = loadFixture("nar_shutuba_grade_202644070111.html");
    expect(titleParen(html)).toBe("Jpn1");
    expect(parseShutuba(html).race.grade).toBe("Jpn1");
  });

  it("グレードの無い地方のレースは grade が undefined であること", () => {
    for (const fixture of ["nar_shutuba_202642071301.html", "nar_shutuba_202654071210.html"]) {
      const race = parseShutuba(loadFixture(fixture)).race;
      expect(race.hasGradeBadge, fixture).toBe(false);
      expect(race.grade, fixture).toBeUndefined();
    }
  });

  it("地方のテキストの無いアイコンには、中央の番号の表を当てないこと(番号 1 のアイコンが G1 にならない)", () => {
    const html = loadFixture("nar_shutuba_grade_202644070111.html");
    const replaced = html.replace(
      /<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType19 Icon_GradePos01">Jpn1<\/span>/,
      '<span class="Icon_GradeType Icon_GradeType1 Icon_GradePos01"></span>',
    );
    expect(replaced).not.toBe(html);
    const race = parseShutuba(replaced).race;
    expect(race.hasGradeBadge).toBe(true);
    expect(race.grade).toBeUndefined();
  });
});
