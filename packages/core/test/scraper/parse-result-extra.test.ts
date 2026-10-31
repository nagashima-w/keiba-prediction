import { describe, expect, it } from "vitest";
import { loadFixture } from "../support/fixtures.js";
import { parseResultExtra, ResultExtraError } from "../../src/scraper/parse-result-extra.js";

/**
 * Issue #532 段階 1: 開発用の補助パーサ(`parseResultExtra`)のテスト。
 * 期待値はフィクスチャの HTML を python で別途読んで突き合わせた値(パーサの出力を写していない)。
 * ネットワークには出ない。
 */

const fx = loadFixture;

const CENTRAL_2021 = fx("history_central_result_202105040811.html");
const NAR_2021 = fx("history_nar_result_202146110310.html");

describe("補助パーサ: 中央 2021 年(天皇賞(秋))の見出し", () => {
  const { header } = parseResultExtra(CENTRAL_2021, "central");

  it("日付・場・レース番号・名前・格を title と h1 から読む", () => {
    expect(header.date).toBe("2021-10-31");
    expect(header.venueName).toBe("東京");
    expect(header.raceNumber).toBe(11);
    expect(header.name).toBe("天皇賞(秋)");
    expect(header.grade).toBe("G1");
  });

  it("発走時刻・面・距離・回り・コース区分を RaceData01 から読む", () => {
    expect(header.startTime).toBe("15:40");
    expect(header.courseType).toBe("芝");
    expect(header.distance).toBe(2000);
    expect(header.direction).toBe("左");
    expect(header.courseDetail).toBe("B");
  });

  it("天候(aria-label)と馬場(Item の span)を読む", () => {
    expect(header.weather).toBe("曇");
    expect(header.going).toBe("良");
  });

  it("RaceData02 から回次・日目・頭数・クラス・重量種別を読み、span の生配列も残す", () => {
    expect(header.kai).toBe(4);
    expect(header.nichime).toBe(8);
    expect(header.fieldSizeDeclared).toBe(16);
    expect(header.raceClass).toBe("オープン");
    expect(header.weightType).toBe("定量");
    expect(header.raceData02Spans).toContain("サラ系３歳以上");
    expect(header.raceData02Spans).toContain("(国際)(指)");
  });
});

describe("補助パーサ: 中央 2021 年の各馬", () => {
  const extra = parseResultExtra(CENTRAL_2021, "central");

  it("16 頭・欠けた列なし・全行でセル数がヘッダと合う", () => {
    expect(extra.rows).toHaveLength(16);
    expect(extra.missingColumns).toEqual([]);
    expect(extra.rows.every((r) => r.cellsAligned)).toBe(true);
  });

  it("1 着エフフォーリアの全項目(実物の HTML と突き合わせた値)", () => {
    const r = extra.rows[0]!;
    expect(r).toMatchObject({
      finishRaw: "1",
      wakuban: 3,
      umaban: 5,
      horseId: "2018105027",
      horseName: "エフフォーリア",
      sexAgeRaw: "牡3",
      sex: "牡",
      age: 3,
      burden: 56,
      jockeyId: "01170",
      jockeyName: "横山武",
      jockeyMark: null,
      timeRaw: "1:57.9",
      timeSec: 117.9,
      marginRaw: "",
      trainerId: "01097",
      trainerName: "鹿戸",
      trainerArea: "美浦",
      bodyWeight: 514,
      bodyWeightDiff: 4,
      bodyWeightDiffRaw: "+4",
    });
  });

  it("2 着コントレイル(着差 1・減 -8)・3 着グランアレグリア(着差クビ・牝5)", () => {
    const r2 = extra.rows[1]!;
    expect(r2).toMatchObject({
      umaban: 1,
      wakuban: 1,
      horseId: "2017101835",
      burden: 58,
      jockeyId: "01014",
      jockeyName: "福永",
      timeSec: 118,
      marginRaw: "1",
      trainerId: "01075",
      trainerArea: "栗東",
      bodyWeight: 464,
      bodyWeightDiff: -8,
    });
    const r3 = extra.rows[2]!;
    expect(r3).toMatchObject({
      umaban: 9,
      wakuban: 5,
      sex: "牝",
      age: 5,
      jockeyId: "05339",
      jockeyName: "ルメー",
      marginRaw: "クビ",
      timeSec: 118.1,
      trainerId: "00386",
      trainerName: "藤沢和",
      bodyWeight: 504,
      bodyWeightDiff: 2,
    });
  });
});

describe("補助パーサ: 中央 2026 年", () => {
  it("稍重・雨・減量騎手(◇)・着差が分数", () => {
    const { header, rows } = parseResultExtra(fx("result_202605040807.html"), "central");
    expect(header.date).toBe("2026-10-24");
    expect(header.venueName).toBe("東京");
    expect(header.raceNumber).toBe(7);
    expect(header.name).toBe("3歳以上1勝クラス");
    expect(header.grade).toBeNull();
    expect(header.courseType).toBe("ダ");
    expect(header.distance).toBe(1600);
    expect(header.direction).toBe("左");
    expect(header.courseDetail).toBeNull();
    expect(header.weather).toBe("雨");
    // 馬場の span は「稍」だけで、正規化後は「稍重」。生の文字も残す。
    expect(header.going).toBe("稍重");
    expect(header.goingRaw).toEqual(["稍"]);
    expect(header.raceClass).toBe("1勝クラス");
    expect(header.weightType).toBe("定量");
    expect(rows).toHaveLength(12);
    const r = rows[1]!;
    expect(r).toMatchObject({
      finishRaw: "2",
      umaban: 5,
      wakuban: 5,
      horseId: "2023102891",
      horseName: "グロリアス",
      sex: "牝",
      age: 3,
      burden: 52,
      jockeyMark: "◇",
      jockeyName: "小林美",
      jockeyId: "01206",
      timeSec: 98.8,
      marginRaw: "1.1/4",
      trainerId: "01172",
      trainerArea: "栗東",
      bodyWeight: 460,
      bodyWeightDiff: 2,
    });
  });

  it("障害: 面は 障 で、距離 3110・格は JG2(title の括弧)。中止の行は時計が無く、増減は -14", () => {
    const { header, rows } = parseResultExtra(fx("result_202605040709.html"), "central");
    expect(header.date).toBe("2026-10-18");
    expect(header.courseType).toBe("障");
    expect(header.distance).toBe(3110);
    expect(header.name).toBe("東京ハイジャンプ");
    expect(header.grade).toBe("JG2");
    expect(header.going).toBe("良");
    const stopped = rows.find((x) => x.finishRaw === "中止")!;
    expect(stopped).toBeDefined();
    expect(stopped).toMatchObject({
      umaban: 8,
      horseId: "2019100788",
      jockeyId: "01087",
      jockeyName: "上野",
      burden: 60,
      timeRaw: "",
      timeSec: null,
      bodyWeight: 484,
      bodyWeightDiff: -14,
    });
  });

  it("取消: 馬体重は空(null)、斤量・騎手 ID は読める", () => {
    const { header, rows } = parseResultExtra(fx("result_202606040901.html"), "central");
    expect(header.raceClass).toBe("未勝利");
    const cancelled = rows.find((x) => x.finishRaw === "取消")!;
    expect(cancelled).toMatchObject({
      umaban: 6,
      wakuban: 3,
      horseId: "2024105198",
      burden: 55,
      jockeyId: "01158",
      bodyWeight: null,
      bodyWeightDiff: null,
      bodyWeightDiffRaw: "",
      timeSec: null,
    });
    expect(cancelled.cellsAligned).toBe(true);
  });

  it("除外: 馬体重の増減 (0) は数値の 0", () => {
    const { rows } = parseResultExtra(fx("result_202605040205.html"), "central");
    const excluded = rows.find((x) => x.finishRaw === "除外")!;
    expect(excluded).toMatchObject({ umaban: 10, bodyWeight: 474, bodyWeightDiff: 0, bodyWeightDiffRaw: "0" });
  });
});

describe("補助パーサ: 地方(Jpn1 JBC クラシック・通過順の列が無い 14 列)", () => {
  const extra = parseResultExtra(NAR_2021, "nar");

  it("旧い形の見出し(天候:晴 / 馬場:良 / (右))を読む", () => {
    const h = extra.header;
    expect(h.date).toBe("2021-11-03");
    expect(h.venueName).toBe("金沢");
    expect(h.raceNumber).toBe(10);
    expect(h.name).toBe("JBCクラシック");
    expect(h.grade).toBe("Jpn1");
    expect(h.startTime).toBe("16:20");
    expect(h.courseType).toBe("ダ");
    expect(h.distance).toBe(2100);
    expect(h.direction).toBe("右");
    expect(h.weather).toBe("晴");
    expect(h.going).toBe("良");
    expect(h.fieldSizeDeclared).toBe(12);
    expect(h.kai).toBe(16);
    expect(h.nichime).toBe(5);
  });

  it("通過順の列が無くても、後ろの列(厩舎・馬体重)がずれない", () => {
    expect(extra.rows).toHaveLength(12);
    expect(extra.missingColumns).toEqual(["コーナー通過順"]);
    expect(extra.rows.every((r) => r.cellsAligned)).toBe(true);
    expect(extra.rows[0]).toMatchObject({
      finishRaw: "1",
      wakuban: 6,
      umaban: 7,
      horseId: "2016100981",
      horseName: "ミューチャリー",
      sex: "牡",
      age: 5,
      burden: 57,
      jockeyId: "05299",
      jockeyName: "吉原寛人",
      timeRaw: "2:13.1",
      timeSec: 133.1,
      trainerId: "05575",
      trainerName: "矢野義幸",
      trainerArea: "船橋",
      bodyWeight: 460,
      bodyWeightDiff: -1,
    });
    // 全角の騎手名はそのまま持つ。調教師 ID に英数字が混じるものがある。
    expect(extra.rows[1]).toMatchObject({ jockeyName: "Ｍ．デム", jockeyId: "05212", marginRaw: "1/2", bodyWeightDiff: 7 });
    expect(extra.rows[5]!.trainerId).toBe("a02f0");
    expect(extra.rows[9]!.jockeyId).toBe("a00d0");
  });
});

describe("補助パーサ: 壊れた構造は黙って値を作らない", () => {
  it("行の td が 1 個欠けた行は、位置で読む項目だけ null にして行は残す(ID は構造から読める)", () => {
    // 2 行目の馬体重の td を丸ごと消す(td 数がヘッダと合わなくなる)
    let n = 0;
    const broken = CENTRAL_2021.replace(/<td class="Weight">[\s\S]*?<\/td>/g, (m) => (++n === 2 ? "" : m));
    expect(n).toBe(16);
    const { rows } = parseResultExtra(broken, "central");
    expect(rows).toHaveLength(16);
    expect(rows[1]!.cellsAligned).toBe(false);
    expect(rows[1]).toMatchObject({
      bodyWeight: null,
      timeSec: null,
      burden: null,
      sex: null,
      jockeyId: "01014",
      horseId: "2017101835",
      trainerId: "01075",
    });
    // 他の行は影響を受けない
    expect(rows[0]).toMatchObject({ cellsAligned: true, bodyWeight: 514, burden: 56 });
    expect(rows[2]!.cellsAligned).toBe(true);
  });

  it("列そのもの(馬体重)が見出しごと無いときは、全行でその項目が null で missingColumns に載る", () => {
    const noWeight = CENTRAL_2021.replace(/<th class="Weight">[\s\S]*?<\/th>/, "").replace(
      /<td class="Weight">[\s\S]*?<\/td>/g,
      "",
    );
    const { rows, missingColumns } = parseResultExtra(noWeight, "central");
    expect(missingColumns).toEqual(["馬体重"]);
    expect(rows).toHaveLength(16);
    expect(rows.every((r) => r.cellsAligned && r.bodyWeight === null && r.bodyWeightDiff === null)).toBe(true);
    expect(rows[0]!.burden).toBe(56);
  });

  it("馬番の列が見出しに無いときは読めない扱い(例外)", () => {
    const bad = CENTRAL_2021.replace(/<th class="Num">馬<br>番<\/th>/, "");
    expect(() => parseResultExtra(bad, "central")).toThrow(ResultExtraError);
  });

  it("結果テーブルが無いときは例外", () => {
    expect(() => parseResultExtra("<html><title>x</title></html>", "central")).toThrow(ResultExtraError);
  });
});
