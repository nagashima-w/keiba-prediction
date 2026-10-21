/**
 * レースのクラス(Issue #426〈#389 の案 B〉)。`div.RaceData02` の span から読む純関数 `readRaceClass` と、HTML を受ける `parseRaceClassFromHtml`、
 * 出馬表の `race.raceClass`(`parseShutuba` の `readRaceClass` 指定)。
 *
 * 中央: クラスの span(新馬・未勝利・1〜3勝クラス・オープン)を、NFKC 正規化(全角数字を半角に)と空白除去のうえ**完全一致**で拾う。値は正準ラベル(半角数字)。
 * 地方: クラスは別の span ではなく「サラ系一般 C1」のように年齢条件の span の後半。**空白区切りの最後のトークンを生のまま**持つ(語彙は固定しない。軸の作り方は #389-c)。
 * どちらも「読めない・曖昧」は undefined(推測しない)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRaceClassFromHtml } from "../../src/scraper/parse-race-class.js";
import { CENTRAL_RACE_CLASSES, readRaceClass } from "../../src/scraper/race-class.js";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf-8");
}

describe("readRaceClass(中央。合成の span)", () => {
  it.each([
    [["2回", "福島", "2日目", "サラ系３歳", "オープン", "(国際)(特指)", "ハンデ", "16頭"], "オープン"],
    [["1回", "函館", "6日目", "サラ系２歳", "新馬", "牝[指]", "馬齢", "6頭"], "新馬"],
    [["1回", "函館", "6日目", "サラ系２歳", "未勝利", "(混)[指]", "馬齢", "8頭"], "未勝利"],
    // 全角数字は半角の正準ラベルにそろえる。
    [["サラ系３歳以上", "１勝クラス", "牝[指]"], "1勝クラス"],
    [["サラ系３歳以上", "２勝クラス"], "2勝クラス"],
    [["サラ系３歳以上", "３勝クラス"], "3勝クラス"],
    // 半角数字の揺れにも耐える。
    [["サラ系３歳以上", "1勝クラス"], "1勝クラス"],
    // 前後の空白・改行は無視する。
    [["サラ系３歳", "\n  オープン \n"], "オープン"],
    // 障害の条件でも同じ。
    [["障害４歳以上", "オープン", "(国際)"], "オープン"],
    // 位置に依存しない(クラスが先頭にあっても拾う)。
    [["未勝利", "サラ系２歳"], "未勝利"],
    // 同じクラスの重複は 1 種類なので読める。
    [["新馬", "新馬"], "新馬"],
  ] as const)("%j → %s", (spans, expected) => {
    expect(readRaceClass(spans, "central")).toBe(expected);
  });

  it("クラスの span が無い・旧表記・部分一致は読まない(推測しない)", () => {
    // 対照: 同じ形でクラスの span があれば読める(undefined の主張が空振りしない)。
    expect(readRaceClass(["サラ系３歳", "オープン", "定量"], "central")).toBe("オープン");
    for (const spans of [
      ["サラ系３歳", "定量", "10頭"], // クラスの span が無い
      [], // span が無い
      ["サラ系３歳以上", "500万下"], // 旧表記(2019 年に廃止。語彙に入れない)
      ["サラ系３歳以上", "1000万下"],
      ["サラ系３歳以上", "オープン特別"], // 部分一致をしない
      ["サラ系３歳以上", "1勝クラス以上"],
      ["サラ系３歳以上", "(オープン)"],
      ["サラ系３歳以上", "C1"], // 地方のトークンは中央では読まない
    ]) {
      expect(readRaceClass(spans, "central"), JSON.stringify(spans)).toBeUndefined();
    }
  });

  it("異なるクラスが 2 種類以上出たら(曖昧)読まない", () => {
    expect(readRaceClass(["新馬", "未勝利"], "central")).toBeUndefined();
    expect(readRaceClass(["１勝クラス", "２勝クラス"], "central")).toBeUndefined();
  });

  it("正準ラベルは 6 種(新馬・未勝利・1〜3勝クラス・オープン)", () => {
    expect([...CENTRAL_RACE_CLASSES]).toEqual(["新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン"]);
  });
});

describe("readRaceClass(地方。合成の span)", () => {
  it.each([
    [["8回", "高知", "2日目", "サラ系一般 C3", "9頭"], "C3"],
    [["サラ系３歳 C1"], "C1"],
    [["サラ系一般 A"], "A"],
    [["サラ系一般 B3"], "B3"],
    [["サラ系４歳以上 A2B1"], "A2B1"], // 複合の区分は生のまま
    [["サラ系４歳以上 4上"], "4上"], // 年齢限定の表記も生のまま(分類は読む側)
    [["サラ系２歳 2歳"], "2歳"],
    [["アラブ系一般 C1"], "C1"],
    [["サラ系一般 C2"], "C2"], // 空白が nbsp でも
    [["サラ系一般  B1 "], "B1"], // 前後・連続の空白
  ] as const)("%j → %s", (spans, expected) => {
    expect(readRaceClass(spans, "nar")).toBe(expected);
  });

  it("区分の無い span(ばんえいの「混合５歳以上 」など)や、中央の語彙は読まない", () => {
    // 対照: 区分があれば読める。
    expect(readRaceClass(["サラ系一般 C1"], "nar")).toBe("C1");
    for (const spans of [
      ["混合５歳以上 "], // ばんえい: 区分が無い
      ["サラ系一般"], // 区分が無い
      ["オープン"], // 中央の語彙は地方では読まない
      ["10頭", "本賞金:100.0、40.0万円"],
      [],
    ]) {
      expect(readRaceClass(spans, "nar"), JSON.stringify(spans)).toBeUndefined();
    }
  });

  it("長すぎるトークン(20 文字超)は自由文の疑いとして読まない", () => {
    expect(readRaceClass([`サラ系一般 ${"A".repeat(20)}`], "nar")).toBe("A".repeat(20));
    expect(readRaceClass([`サラ系一般 ${"A".repeat(21)}`], "nar")).toBeUndefined();
  });

  it("年齢条件の span が 2 つ以上あり区分が食い違うときは読まない(曖昧)", () => {
    expect(readRaceClass(["サラ系一般 C1", "サラ系一般 C2"], "nar")).toBeUndefined();
    expect(readRaceClass(["サラ系一般 C1", "サラ系一般 C1"], "nar")).toBe("C1");
  });
});

describe("parseRaceClassFromHtml(実フィクスチャ。出馬表・結果ページ)", () => {
  // [フィクスチャ, 期待するクラス]
  const central: ReadonlyArray<readonly [string, string]> = [
    ["result_202602010605.html", "新馬"],
    ["result_202602010607.html", "1勝クラス"],
    ["result_202603020203.html", "未勝利"],
    ["result_202603020210.html", "3勝クラス"], // 2026-10-21 に実測した結果ページ
    ["result_202603020211.html", "オープン"],
    ["result_202605040205.html", "新馬"],
    ["result_202606040810.html", "2勝クラス"],
    ["result_202606040901.html", "未勝利"],
    ["result_202607020501.html", "未勝利"],
    ["result_202607020502.html", "新馬"],
    ["result_202607020505.html", "1勝クラス"],
    ["result_202608040204.html", "新馬"],
    ["shutuba_202602010601.html", "未勝利"],
    ["shutuba_202602010607.html", "1勝クラス"],
    ["shutuba_202603020211.html", "オープン"],
    ["shutuba_202605040211.html", "オープン"],
    ["shutuba_202606030711.html", "オープン"], // 障害
    ["shutuba_202606040901.html", "未勝利"],
    ["shutuba_202606040911.html", "オープン"],
    ["shutuba_202609010708.html", "オープン"], // 障害
    ["shutuba_202610010708.html", "オープン"], // 障害
  ];

  it.each(central)("中央 %s → %s", (fixture, expected) => {
    expect(parseRaceClassFromHtml(loadFixture(fixture), "central")).toBe(expected);
  });

  it("前提: 中央の固定は 21 件で、正準ラベル 6 種がすべて現れる(表が空振りしていないことの確認)", () => {
    expect(central).toHaveLength(21);
    expect(new Set(central.map((c) => c[1]))).toEqual(new Set(CENTRAL_RACE_CLASSES));
  });

  // [フィクスチャ, 期待する区分(undefined = 読めない)]
  const nar: ReadonlyArray<readonly [string, string | undefined]> = [
    ["nar_result_202630062407.html", "C1"],
    ["nar_result_202644100810.html", "B3"],
    ["nar_result_202646071203.html", "2歳"],
    ["nar_result_202650062411.html", "A2B1"], // 2026-10-21 に実測した結果ページ(園田。複合の区分)
    ["nar_result_202654071201.html", "C2"],
    ["nar_result_202654071210.html", "C1"],
    ["nar_result_202654092706.html", "C3"],
    ["nar_result_202654092711.html", "A"],
    ["nar_result_partial_202644100810.html", "B3"],
    ["nar_result_presale_202642071612.html", "C2"],
    ["nar_shutuba_202642071301.html", "C3"],
    ["nar_shutuba_202654071210.html", "C1"],
    ["nar_shutuba_grade_202644070111.html", "4上"],
    // ばんえい(帯広。場コード 65)は `parseRaceId` が拒否する対象外のレース。区分が無いページの実例として、パーサの入力にだけ使う。
    ["nar_result_banei_202665071311.html", undefined],
  ];

  it.each(nar)("地方 %s → %s", (fixture, expected) => {
    expect(parseRaceClassFromHtml(loadFixture(fixture), "nar")).toBe(expected);
  });

  it("前提: 地方の固定は 14 件で、読めるものは 13 件・読めないもの(区分なし)が 1 件・読めた区分は 8 種", () => {
    expect(nar).toHaveLength(14);
    expect(nar.filter((n) => n[1] === undefined)).toHaveLength(1);
    expect(new Set(nar.map((n) => n[1]).filter((v) => v !== undefined))).toEqual(new Set(["C1", "C2", "C3", "B3", "A", "A2B1", "2歳", "4上"]));
  });

  it("RaceData02 が無い HTML は undefined", () => {
    expect(parseRaceClassFromHtml("<html><body><div class=\"RaceData01\">x</div></body></html>", "central")).toBeUndefined();
  });

  it("RaceData02 の外(レース名)の「オープン」「C1」は読まない", () => {
    const html = `<html><body><h1 class="RaceName">オープン特別(C1)</h1><div class="RaceData02"><span>サラ系３歳</span><span>10頭</span></div></body></html>`;
    expect(parseRaceClassFromHtml(html, "central")).toBeUndefined();
    expect(parseRaceClassFromHtml(html, "nar")).toBeUndefined();
  });
});

describe("parseShutuba(race.raceClass。readRaceClass の指定で読む)", () => {
  it("指定しない(既定)と、キー自体を持たない(従来の出力を変えない)", () => {
    for (const fixture of ["shutuba_202603020211.html", "nar_shutuba_202654071210.html"]) {
      const html = loadFixture(fixture);
      // 対照: 指定すれば読める出馬表であること。
      expect(parseShutuba(html, { readRaceClass: fixture.startsWith("nar_") ? "nar" : "central" }).race.raceClass, fixture).not.toBeUndefined();
      expect("raceClass" in parseShutuba(html).race, fixture).toBe(false);
    }
  });

  it("中央・地方の出馬表で race.raceClass が入る", () => {
    expect(parseShutuba(loadFixture("shutuba_202602010601.html"), { readRaceClass: "central" }).race.raceClass).toBe("未勝利");
    expect(parseShutuba(loadFixture("shutuba_202606030711.html"), { readRaceClass: "central" }).race.raceClass).toBe("オープン");
    expect(parseShutuba(loadFixture("nar_shutuba_202642071301.html"), { readRaceClass: "nar" }).race.raceClass).toBe("C3");
  });

  it("クラスの span が無い出馬表では、キー自体を持たない", () => {
    const html = loadFixture("shutuba_202603020211.html").replace("<span>オープン</span>", "");
    expect(html).not.toBe(loadFixture("shutuba_202603020211.html")); // 前提: 実際に span を消した
    expect("raceClass" in parseShutuba(html, { readRaceClass: "central" }).race).toBe(false);
  });

  it("負担重量の種別・牝馬限定の読み(Issue #421)と独立: readRaceClass だけ指定しても weightType・filliesOnly は付かない", () => {
    const race = parseShutuba(loadFixture("shutuba_202603020211.html"), { readRaceClass: "central" }).race;
    expect(race.raceClass).toBe("オープン");
    expect("weightType" in race).toBe(false);
    expect("filliesOnly" in race).toBe(false);
  });
});
