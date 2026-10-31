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

/**
 * #549-A1: ラップ表(`table.Race_HaronTime`)。区間タイム・位置・ペースの文字(最初の 3 区間の和 − 最後の 3 区間の和)・ペースの区分。
 * 期待値は、フィクスチャの HTML を python で別に読んで 0.1 秒単位の整数で足した値(パーサの出力を写していない)。
 * 戦績 API の `pace` との一致は race-record.test.ts で固定する。
 */
describe("補助パーサ: ラップ表(区間タイム・ペース・ペースの区分)", () => {
  // [フィクスチャ, 種別, 先頭の位置(m), 末尾の位置(m), 区間タイム(秒), ペース, 区分]
  const TABLE: ReadonlyArray<
    readonly [string, "central" | "nar", number, number, readonly number[], string | null, "S" | "M" | "H"]
  > = [
    ["history_central_result_202105040811.html", "central", 200, 2000, [12.8, 11.5, 11.9, 12.0, 12.3, 12.0, 11.8, 11.1, 11.1, 11.4], "36.2-33.6", "S"],
    ["result_202602010605.html", "central", 200, 1200, [12.5, 11.0, 11.2, 11.4, 11.4, 11.8], "34.7-34.6", "M"],
    // 距離が 200 の倍数でないレースは、先頭の位置が 100m(最初の区間が 100m 分)。戦績 API の pace と一致する実例(race-record.test.ts)
    ["result_202602010607.html", "central", 100, 1700, [6.9, 10.8, 12.2, 12.9, 12.2, 12.3, 12.4, 12.7, 12.5], "29.9-37.6", "M"],
    ["result_202603020210.html", "central", 100, 1700, [7.3, 11.2, 11.8, 12.4, 12.2, 12.1, 12.4, 12.4, 12.4], "30.3-37.2", "M"],
    ["result_202603020211.html", "central", 200, 1800, [12.1, 10.8, 11.6, 12.3, 12.2, 11.7, 11.4, 11.4, 11.7], "34.5-34.5", "M"],
    ["result_202605040205.html", "central", 200, 2000, [13.3, 12.1, 12.5, 12.6, 13.2, 13.1, 13.0, 11.6, 11.2, 11.3], "37.9-34.1", "S"],
    ["result_202606040810.html", "central", 200, 1200, [12.0, 10.6, 11.4, 11.7, 11.7, 12.3], "34.0-35.7", "H"],
    ["result_202607020502.html", "central", 200, 1400, [12.6, 11.1, 11.7, 12.1, 11.7, 11.4, 11.4], "35.4-34.5", "S"],
    // 区間が 6 個未満(1000m の 5 区間)は、最初の 3 区間と最後の 3 区間が重なる(3 番目の区間が両方に入る)。重なる和をそのまま出す:
    // 前 = 11.7+10.4+10.9 = 33.0、後 = 10.9+11.0+11.3 = 33.2(0.1 秒の整数で足した値を、python で別に計算)。
    // 戦績 API は地方の 800m(4 区間)・900m(5 区間)で値を返している(race-record.test.ts)。中央の 1000m の実例は無く未確認
    ["result_202604040112.html", "central", 200, 1000, [11.7, 10.4, 10.9, 11.0, 11.3], "33.0-33.2", "M"],
    // 地方も同じ形(ペースの文字が戦績 API と一致するかは、地方では未確認)
    ["nar_result_202644100810.html", "nar", 200, 1400, [13.1, 12.3, 12.0, 12.2, 12.5, 12.0, 12.5], "37.4-37.0", "M"],
  ];

  it.each(TABLE)("%s: 区間タイム・位置・ペース・区分を読む", (file, kind, first, last, laps, pace, cls) => {
    const { header } = parseResultExtra(fx(file), kind);
    expect(header.lapTimes).toEqual(laps);
    expect(header.lapDistances).toHaveLength(laps.length);
    expect(header.lapDistances![0]).toBe(first);
    expect(header.lapDistances![laps.length - 1]).toBe(last);
    expect(header.pace).toBe(pace);
    expect(header.paceClass).toBe(cls);
  });

  it("位置は 200m きざみ(先頭が 100m なら 100・300・…)で、レースの距離と末尾が合う", () => {
    const a = parseResultExtra(fx("result_202602010607.html"), "central").header;
    expect(a.lapDistances).toEqual([100, 300, 500, 700, 900, 1100, 1300, 1500, 1700]);
    expect(a.distance).toBe(1700);
  });

  it("障害レース(ラップ表もペースの区分も無い)は、すべて null", () => {
    const { header } = parseResultExtra(fx("result_202605040709.html"), "central");
    expect(header.courseType).toBe("障");
    expect(header.lapTimes).toBeNull();
    expect(header.lapDistances).toBeNull();
    expect(header.pace).toBeNull();
    expect(header.paceClass).toBeNull();
  });

  it("ラップ表の無い地方の結果ページも、すべて null(黙って値を作らない)", () => {
    const { header } = parseResultExtra(fx("nar_result_202654071210.html"), "nar");
    expect(header.lapTimes).toBeNull();
    expect(header.pace).toBeNull();
    expect(header.paceClass).toBeNull();
  });

  describe("ラップ表が壊れているとき(実物のフィクスチャを書き換えた入力)", () => {
    const SRC = fx("result_202603020211.html");
    // 前提の固定: 書き換える前は読める(書き換えが効いていなければ、下のテストは空振りする)
    it("書き換える前は読める", () => {
      const { header } = parseResultExtra(SRC, "central");
      expect(header.lapTimes).toHaveLength(9);
      expect(header.pace).toBe("34.5-34.5");
    });

    const mutate = (from: RegExp | string, to: string): string => {
      const out = SRC.replace(from, to);
      expect(out).not.toBe(SRC);
      return out;
    };

    it("区間のセルに数値でないものがあれば、区間タイムもペースも null", () => {
      // 区間の行(2 行目)の最初のセルを書き換える
      const html = mutate(/(<tr class="HaronTime">\s*<td>[^<]*<\/td>[\s\S]*?<\/tr>\s*<tr class="HaronTime">\s*<td>)[^<]*(<\/td>)/, "$1--$2");
      const { header } = parseResultExtra(html, "central");
      expect(header.lapTimes).toBeNull();
      expect(header.pace).toBeNull();
    });

    it("HaronTime の行が 2 行でなければ(累計だけ)null", () => {
      const html = mutate(/(<tr class="HaronTime">[\s\S]*?<\/tr>)\s*<tr class="HaronTime">[\s\S]*?<\/tr>/, "$1");
      const { header } = parseResultExtra(html, "central");
      expect(header.lapTimes).toBeNull();
      expect(header.pace).toBeNull();
    });

    it("見出しの数とセルの数が合わなければ null", () => {
      const html = mutate(/<th>1800m<\/th>/, "");
      const { header } = parseResultExtra(html, "central");
      expect(header.lapTimes).toBeNull();
      expect(header.lapDistances).toBeNull();
      expect(header.pace).toBeNull();
    });

    it("累計の行と区間の行が入れ替わっていれば(区間の和が累計と合わない)null", () => {
      const rows = [...SRC.matchAll(/<tr class="HaronTime">[\s\S]*?<\/tr>/g)].map((m) => m[0]);
      expect(rows).toHaveLength(2);
      const html = SRC.replace(rows[0]!, "@@A@@").replace(rows[1]!, rows[0]!).replace("@@A@@", rows[1]!);
      expect(html).not.toBe(SRC);
      const { header } = parseResultExtra(html, "central");
      expect(header.lapTimes).toBeNull();
      expect(header.pace).toBeNull();
    });

    it("累計との差が 0.1 秒以内(四捨五入のずれ)なら読める: 累計と区間は別々に四捨五入されるため、実データでも起きる形", () => {
      // 区間の行の最後のセルを 0.1 秒だけずらす: 11.7 → 11.8(累計との差 0.1)
      const html = mutate(/<td>11\.7<\/td>(\s*<\/tr>\s*<\/tbody>)/, "<td>11.8</td>$1");
      const { header } = parseResultExtra(html, "central");
      expect(header.lapTimes).not.toBeNull();
      expect(header.lapTimes![8]).toBe(11.8);
    });

    // 3 区間の表に書き換える(見出し・累計・区間のセルを 3 個にそろえる)
    const withLaps = (n: number): string => {
      const heads = ["200m", "400m", "600m"].slice(0, n).map((h) => `<th>${h}</th>`).join("");
      const cum = ["12.1", "22.9", "34.5"].slice(0, n).map((c) => `<td>${c}</td>`).join("");
      const sec = ["12.1", "10.8", "11.6"].slice(0, n).map((c) => `<td>${c}</td>`).join("");
      return mutate(
        /(<table[^>]*Race_HaronTime[^>]*>\s*<tbody>)[\s\S]*?(<\/tbody>)/,
        `$1<tr class="Header">${heads}</tr><tr class="HaronTime">${cum}</tr><tr class="HaronTime">${sec}</tr>$2`,
      );
    };

    it("区間がちょうど 3 個なら、前 3 区間と後ろ 3 区間が同じ区間で、ペースは全体の和を 2 回書く", () => {
      const { header } = parseResultExtra(withLaps(3), "central");
      expect(header.lapTimes).toEqual([12.1, 10.8, 11.6]);
      expect(header.pace).toBe("34.5-34.5");
    });

    it("区間が 3 個未満(2 個)なら、区間タイムは残してペースだけ null", () => {
      const { header } = parseResultExtra(withLaps(2), "central");
      expect(header.lapTimes).toEqual([12.1, 10.8]);
      expect(header.lapDistances).toEqual([200, 400]);
      expect(header.pace).toBeNull();
    });

    it("ペースの区分が S・M・H のどれでもなければ、区分だけ null(区間タイムは残る)", () => {
      const html = mutate(/(RapPace_Title">ペース:<span>)M/, "$1X");
      const { header } = parseResultExtra(html, "central");
      expect(header.paceClass).toBeNull();
      expect(header.lapTimes).toHaveLength(9);
      expect(header.pace).toBe("34.5-34.5");
    });

    it("ペースの区分の要素が無ければ、区分だけ null(区間タイムは残る)", () => {
      const html = mutate(/<div class="RapPace_Title">[\s\S]*?<\/div>/, "");
      const { header } = parseResultExtra(html, "central");
      expect(header.paceClass).toBeNull();
      expect(header.lapTimes).toHaveLength(9);
    });
  });
});
