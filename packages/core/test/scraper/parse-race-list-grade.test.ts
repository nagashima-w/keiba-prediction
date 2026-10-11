/**
 * レース一覧の `grade`(Issue #250): 中央は画像アイコンのクラス番号から、地方は生テキストから。
 *
 * 既存の `parse-race-list.test.ts` は「テキスト方式〈地方〉の grade」と「中央の非グレード行が undefined」を固定している。
 * 本ファイルは中央のグレード(G1〜G3・J・G1〜J・G3)の抽出と、その配線(読む範囲・地方に当てない)を固定する。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRaceList } from "../../src/scraper/parse-race-list.js";
import type { RaceListEntry } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("parseRaceList(中央のグレード。画像アイコンのクラス番号から。Issue #250)", () => {
  /** 一覧のフィクスチャを読み、グレードが付いた行だけを [race_id, grade] で返す。 */
  function gradedOf(name: string): Array<[string, string | undefined]> {
    return parseRaceList(loadFixture(name))
      .filter((e) => e.grade !== undefined)
      .map((e): [string, string | undefined] => [e.raceId, e.grade])
      .sort((a, b) => a[0].localeCompare(b[0])); // 一覧の並び(HTML 順)に依存しないよう race_id 昇順にそろえる
  }

  // 各一覧の「グレードが付く行」を丸ごと固定する(行の追加漏れ・余計な行の両方を検出する)。
  // 番号→ラベルの根拠は grade-label.test.ts(出馬表の title 照合)。ここでは一覧側の配線を固定する。
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
    ["race_list_sub_20260628.html", [["202602010611", "G3"], ["202603020211", "G3"]]], // 函館記念・ラジオNIK
    ["race_list_sub_20260808.html", [["202601010511", "G3"]]], // エルムS
    ["race_list_sub_20260926.html", [["202609040811", "G3"]]], // シリウスS
    ["race_list_sub_20260927.html", [["202606040911", "G1"]]], // スプリンター
    ["race_list_sub_20261004.html", [["202605040211", "G2"], ["202608040211", "G2"]]], // 毎日王冠・京都大賞典
    ["race_list_sub_20260418.html", [["202606030711", "J・G1"], ["202609020711", "G3"]]], // 中山GJ・アンタレスS
    ["race_list_sub_20260314.html", [["202609010708", "J・G2"]]], // 阪神SJ
    ["race_list_sub_20260214.html", [["202605010511", "G3"], ["202610010708", "J・G3"]]], // クイーンC・小倉JS
  ];

  it.each(cases)("%s: グレードが付く行はこの顔ぶれだけであること", (name, expected) => {
    expect(gradedOf(name)).toEqual(expected.map(([id, g]) => [id, g]));
  });

  it("固定している一覧は 8 件で、どれもグレード付きの行を 1 件以上持つこと(空振りでないこと)", () => {
    expect(cases).toHaveLength(8);
    expect(cases.every(([, expected]) => expected.length > 0)).toBe(true);
  });

  it("OP(5)・L(15)・3勝(16)・2勝(17)・1勝(18)の行は、アイコンがあっても grade=undefined であること", () => {
    const e1004 = parseRaceList(loadFixture("race_list_sub_20261004.html"));
    const e0314 = parseRaceList(loadFixture("race_list_sub_20260314.html"));
    const e0927 = parseRaceList(loadFixture("race_list_sub_20260927.html"));
    const pick = (list: RaceListEntry[], id: string, name: string): RaceListEntry => {
      const e = list.find((x) => x.raceId === id);
      // 前提: 行が存在し、名前が想定どおり(別の行を見ていないこと)。
      expect(e).toBeDefined();
      expect(e!.name).toBe(name);
      return e!;
    };
    // 20261004: 藤森S=番号5(OP)・赤富士S=16(3勝)・tvk賞=17(2勝)。
    expect(pick(e1004, "202608040210", "藤森S").grade).toBeUndefined();
    expect(pick(e1004, "202605040210", "赤富士S").grade).toBeUndefined();
    expect(pick(e1004, "202605040209", "tvk賞").grade).toBeUndefined();
    // 20260314: アネモネS=15(L)。20260927: ポートアイS=15(L)・サフラン賞=18(1勝)。
    expect(pick(e0314, "202606020511", "アネモネS").grade).toBeUndefined();
    expect(pick(e0927, "202609040911", "ポートアイS").grade).toBeUndefined();
    expect(pick(e0927, "202606040909", "サフラン賞").grade).toBeUndefined();
  });

  /** 1 行だけの一覧 HTML を作る。titleIcons にはレース名の横のアイコン、dataIcons には RaceData 内のアイコンを入れる。 */
  function oneRow(raceId: string, titleIcons: string, dataIcons = ""): string {
    return `
<dl class="RaceList_DataList">
<dd class="RaceList_Data ">
<ul>
<li class="RaceList_DataItem ">
<a href="../race/shutuba.html?race_id=${raceId}&rf=race_list" class="">
<div class="Race_Num"><span>11R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle">
<span class="ItemTitle">テスト賞</span>
${titleIcons}
</div>
<div class="RaceData">${dataIcons}<span>15:45</span><span class="Turf">芝1800m</span>16頭</div>
</div>
</a>
</li>
</ul>
</dd>
</dl>`;
  }

  it("実測した番号(3)は、組み立てた HTML でも G3 になること(下の未測定の行が空振りでないことの対照)", () => {
    const entries = parseRaceList(oneRow("202603020211", `<span class="Icon_GradeType Icon_GradeType3 Icon_GradePos01"></span>`));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.grade).toBe("G3");
  });

  it("未測定の番号(4・6〜9・14)と範囲外の番号は、推測せず grade=undefined であること", () => {
    for (const n of [4, 6, 7, 8, 9, 14, 19, 99]) {
      const entries = parseRaceList(oneRow("202603020211", `<span class="Icon_GradeType Icon_GradeType${n} Icon_GradePos01"></span>`));
      expect(entries, `番号 ${n}`).toHaveLength(1);
      expect(entries[0]!.grade, `番号 ${n}`).toBeUndefined();
    }
  });

  it("レース名の横のアイコンだけを見ること: RaceData 内のアイコン(番号 1)は grade にならない", () => {
    const entries = parseRaceList(oneRow("202603020211", "", `<span class="Icon_GradeType Icon_GradeType1"></span>`));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.grade).toBeUndefined();
  });

  it("レース名の横にアイコンが 2 つあるとき、番号の表にある方を採ること(GradeType13 は表に無いので無視)", () => {
    const entries = parseRaceList(
      oneRow(
        "202603020211",
        `<span class="Icon_GradeType Icon_GradeType13 Icon_GradePos01"></span><span class="Icon_GradeType Icon_GradeType2"></span>`,
      ),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.grade).toBe("G2");
  });

  it("地方のレースは番号を解釈しないこと: テキストの無い Icon_GradeType1 は grade=undefined(中央の表を地方に当てない)", () => {
    // 地方の race_id(場コード 43=船橋)。番号 1 を中央の表で G1 にしてしまう誤りを固定して防ぐ。
    const entries = parseRaceList(oneRow("202643093011", `<span class="Icon_GradeType Icon_GradeType1 Icon_GradePos01"></span>`));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.raceId).toBe("202643093011");
    expect(entries[0]!.grade).toBeUndefined();
  });

  it("地方(2026-09-30)の本物の Jpn2(日本テレビ盃・船橋)と重賞(サンライズカップ・門別)を生テキストで抽出すること", () => {
    // Jpn2 のクラス番号は 20(Jpn1 は 19)。地方は番号ではなくテキストを使う。
    const nar = parseRaceList(loadFixture("nar_race_list_sub_20260930.html"));
    expect(nar.filter((e) => e.grade === "Jpn2").map((e) => e.raceId)).toEqual(["202643093011"]);
    expect(nar.find((e) => e.raceId === "202630093012")!.grade).toBe("重賞");
  });
});
