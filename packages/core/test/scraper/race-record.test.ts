import { describe, expect, it } from "vitest";
import { loadFixture } from "../support/fixtures.js";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import { buildRaceRecord, crossCheckRows, RACE_RECORD_PARSER_VERSION } from "../../src/scraper/race-record.js";
import { parseResultExtra } from "../../src/scraper/parse-result-extra.js";

/**
 * Issue #532 段階 1: 既存の `parseRaceResult`(着順・通過順・後3F・人気・オッズ・払戻)と補助パーサの突き合わせ。
 * 行順+馬番+馬名が合わなければ、そのレースは理由つきで「読めない」扱いにする(値を黙って合成しない)。
 */

const fx = loadFixture;
const CENTRAL_2021 = fx("history_central_result_202105040811.html");
const NAR_2021 = fx("history_nar_result_202146110310.html");

function mustOk(html: string, raceId: string, kind: "central" | "nar") {
  const r = buildRaceRecord(html, raceId, kind);
  if (!r.ok) {
    throw new Error(`読めるはずのレースが読めなかった: ${r.category} ${r.detail}`);
  }
  return r.record;
}

describe("buildRaceRecord: 中央 2021 年", () => {
  const rec = mustOk(CENTRAL_2021, "202105040811", "central");

  it("レースの項目と区別(kind)", () => {
    expect(rec).toMatchObject({
      kind: "central",
      raceId: "202105040811",
      date: "2021-10-31",
      venueName: "東京",
      raceNumber: 11,
      name: "天皇賞(秋)",
      grade: "G1",
      courseType: "芝",
      distance: 2000,
      going: "良",
      fieldSizeDeclared: 16,
    });
    expect(rec.horses).toHaveLength(16);
  });

  it("着順・通過順・後3F・人気・単勝オッズは既存パーサの値、騎手などは補助パーサの値", () => {
    expect(rec.horses[0]).toMatchObject({
      finish: 1,
      finishStatus: null,
      finishDemoted: false,
      umaban: 5,
      horseName: "エフフォーリア",
      passing: [6, 6, 6],
      last3f: 33.2,
      ninki: 3,
      winOdds: 3.4,
      jockeyId: "01170",
      burden: 56,
      bodyWeight: 514,
    });
  });

  it("払戻は既存パーサの結果をそのまま持つ(単勝 5 番 340 円)", () => {
    expect(rec.payouts.win).toEqual([{ umaban: 5, payout: 340 }]);
    expect(rec.payouts.place.map((p) => p.umaban)).toEqual([5, 1, 9]);
    expect(rec.payouts.wide.state).toBe("parsed");
    expect(rec.payouts.trifecta.state).toBe("parsed");
  });
});

describe("buildRaceRecord: 1 着馬の行全体を固定する(実物の HTML と突き合わせた値)", () => {
  it("中央 2021 年 天皇賞(秋) 1 着エフフォーリア", () => {
    const rec = mustOk(CENTRAL_2021, "202105040811", "central");
    expect(rec.horses[0]).toEqual({
      umaban: 5,
      wakuban: 3,
      finish: 1,
      finishStatus: null,
      finishDemoted: false,
      finishRaw: "1",
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
      ninki: 3,
      winOdds: 3.4,
      last3f: 33.2,
      passing: [6, 6, 6],
      trainerId: "01097",
      trainerName: "鹿戸",
      trainerArea: "美浦",
      bodyWeight: 514,
      bodyWeightRaw: "514(+4)",
      bodyWeightDiff: 4,
      bodyWeightDiffRaw: "+4",
      cellsAligned: true,
    });
  });

  it("地方 2021 年 JBC クラシック(Jpn1) 1 着ミューチャリー", () => {
    const rec = mustOk(NAR_2021, "202146110310", "nar");
    expect(rec.horses[0]).toEqual({
      umaban: 7,
      wakuban: 6,
      finish: 1,
      finishStatus: null,
      finishDemoted: false,
      finishRaw: "1",
      horseId: "2016100981",
      horseName: "ミューチャリー",
      sexAgeRaw: "牡5",
      sex: "牡",
      age: 5,
      burden: 57,
      jockeyId: "05299",
      jockeyName: "吉原寛人",
      jockeyMark: null,
      timeRaw: "2:13.1",
      timeSec: 133.1,
      marginRaw: "",
      ninki: 6,
      winOdds: 13.9,
      last3f: 36,
      passing: [],
      trainerId: "05575",
      trainerName: "矢野義幸",
      trainerArea: "船橋",
      bodyWeight: 460,
      bodyWeightRaw: "460(-1)",
      bodyWeightDiff: -1,
      bodyWeightDiffRaw: "-1",
      cellsAligned: true,
    });
  });
});

describe("buildRaceRecord: 地方 Jpn1", () => {
  it("通過順の列が無いので passing は空配列、後3F・オッズは読める", () => {
    const rec = mustOk(NAR_2021, "202146110310", "nar");
    expect(rec.kind).toBe("nar");
    expect(rec.grade).toBe("Jpn1");
    expect(rec.date).toBe("2021-11-03");
    expect(rec.horses).toHaveLength(12);
    expect(rec.horses[0]).toMatchObject({
      finish: 1,
      umaban: 7,
      wakuban: 6,
      passing: [],
      last3f: 36,
      ninki: 6,
      winOdds: 13.9,
      jockeyId: "05299",
      trainerArea: "船橋",
    });
  });
});

describe("buildRaceRecord: 非数値の着順", () => {
  it("中止は finish が null で finishStatus に文字が入る(通過順は読めた分を持つ)", () => {
    const rec = mustOk(fx("result_202605040709.html"), "202605040709", "central");
    const stopped = rec.horses.find((h) => h.umaban === 8)!;
    expect(stopped).toMatchObject({ finish: null, finishStatus: "中止", finishRaw: "中止", passing: [8, 8] });
  });
});

describe("buildRaceRecord: 読めないレースは理由つきで拒否する", () => {
  const reject = (html: string, raceId: string, kind: "central" | "nar") => {
    const r = buildRaceRecord(html, raceId, kind);
    expect(r.ok).toBe(false);
    return r as Extract<typeof r, { ok: false }>;
  };

  it("race_id の年と title の日付の年が違う", () => {
    expect(reject(CENTRAL_2021, "202205040811", "central").category).toBe("年不一致");
  });

  it("race_id の末尾(レース番号)と title のレース番号が違う", () => {
    expect(reject(CENTRAL_2021, "202105040801", "central").category).toBe("レース番号不一致");
  });

  it("場コードが示す種別と置き場(kind)が違う", () => {
    expect(reject(CENTRAL_2021, "202105040811", "nar").category).toBe("種別不一致");
    expect(reject(NAR_2021, "202146110310", "central").category).toBe("種別不一致");
  });

  it("ページが名乗る race_id(canonical)がファイルの race_id と違う(別のレースのページが紛れ込んだ)", () => {
    const swapped = CENTRAL_2021.replace(/(rel="canonical" href="[^"]*race_id=)202105040811/, "$1202105040810");
    expect(swapped).not.toBe(CENTRAL_2021);
    expect(reject(swapped, "202105040811", "central").category).toBe("race_id不一致");
  });

  it("中央は race_id の回次・日次とページの回次・日目が違う(年とレース番号が偶然合っても弾く)", () => {
    // 回次 4 → 日次 8 の race_id 202105040811 に対して、別の開催(5 回 2 日目)のページが入っていた形(canonical は付いていないものとする)
    const other = CENTRAL_2021.replace(/<link rel="canonical"[^>]*>/, "").replace("<span>4回</span>", "<span>5回</span>").replace("<span>8日目</span>", "<span>2日目</span>");
    expect(other).not.toBe(CENTRAL_2021);
    const r = reject(other, "202105040811", "central");
    expect(r.category).toBe("race_id不一致");
    expect(r.detail).toMatch(/4回8日目.*5回2日目/);
  });

  it("地方は race_id に埋まった月日と title の日付が違う", () => {
    expect(reject(NAR_2021, "202146110410", "nar").category).toBe("日付不一致");
  });

  it("文字化け(U+FFFD)を含む", () => {
    expect(reject(CENTRAL_2021.replace("エフフォーリア", "エフ�フォーリア"), "202105040811", "central").category).toBe(
      "文字化け",
    );
  });

  it("既存パーサと補助パーサで馬名が食い違う行があれば、突き合わせ不一致として拒否する(統合)", () => {
    // 1 行目の着順セルに別の馬へのリンクが紛れ込んだ形。補助パーサは行内の最初の馬リンクを読むので既存パーサと食い違う
    const stray = CENTRAL_2021.replace(
      '<div class="Rank">1</div>',
      '<div class="Rank">1</div><a href="https://db.netkeiba.com/horse/9999999999" title="別の馬">x</a>',
    );
    expect(stray).not.toBe(CENTRAL_2021);
    const r = reject(stray, "202105040811", "central");
    expect(r.category).toBe("突き合わせ不一致");
    expect(r.detail).toMatch(/1 行目の馬名/);
  });

  it("結果の表が無い / 行が無い(確定前)", () => {
    expect(reject("<html><title>x</title></html>", "202105040811", "central").category).toBe("構造異常");
    const at = CENTRAL_2021.indexOf('id="All_Result_Table"');
    expect(at).toBeGreaterThan(0);
    const empty = CENTRAL_2021.slice(0, at) + CENTRAL_2021.slice(at).replace(/<tbody>[\s\S]*?<\/tbody>/, "<tbody></tbody>");
    expect(empty).not.toBe(CENTRAL_2021);
    expect(reject(empty, "202105040811", "central").category).toBe("結果未確定");
  });

  it("title に日付が無い", () => {
    const noDate = CENTRAL_2021.replace(/<title>[^<]*<\/title>/, "<title>x</title>");
    expect(reject(noDate, "202105040811", "central").category).toBe("日付不明");
  });
});

describe("crossCheckRows: 既存パーサと補助パーサの突き合わせ", () => {
  const core = parseRaceResult(CENTRAL_2021).horses;
  const extra = parseResultExtra(CENTRAL_2021, "central").rows;

  it("そろっていれば null(問題なし)", () => {
    expect(crossCheckRows(core, extra)).toBeNull();
  });

  it("行数が違えば理由を返す", () => {
    expect(crossCheckRows(core, extra.slice(0, 15))).toMatch(/行数/);
  });

  it("馬番が違う行があれば理由を返す(どの行かを含む)", () => {
    const changed = extra.map((r, i) => (i === 3 ? { ...r, umaban: 99 } : r));
    expect(crossCheckRows(core, changed)).toMatch(/4 行目.*馬番/);
  });

  it("馬名が違う行があれば理由を返す", () => {
    const changed = extra.map((r, i) => (i === 0 ? { ...r, horseName: "別の馬" } : r));
    expect(crossCheckRows(core, changed)).toMatch(/1 行目.*馬名/);
  });

  it("補助パーサの馬番が null(列がずれた行)でも、馬名が合えば通す", () => {
    const changed = extra.map((r, i) => (i === 2 ? { ...r, umaban: null, cellsAligned: false } : r));
    expect(crossCheckRows(core, changed)).toBeNull();
  });
});

/**
 * #549-A1: 読み取りの版数と、ラップ表(区間タイム・ペース)。
 * 版数: 移動前の出力(版数なし)を 1、ラップ表(laps・pace・paceClass)を足した出力を 2 とする。出力の意味を変えたら上げる。
 */
describe("buildRaceRecord: 読み取りの版数", () => {
  it("版数は 2(ラップ表を足した版)で、レコードにも同じ値が入る", () => {
    expect(RACE_RECORD_PARSER_VERSION).toBe(2);
    expect(mustOk(CENTRAL_2021, "202105040811", "central").parserVersion).toBe(RACE_RECORD_PARSER_VERSION);
    expect(mustOk(NAR_2021, "202146110310", "nar").parserVersion).toBe(RACE_RECORD_PARSER_VERSION);
  });
});

describe("buildRaceRecord: ラップ表と戦績 API の pace の一致", () => {
  // 同じ馬・同じレースが、結果ページのフィクスチャと戦績 API のフィクスチャの両方にある実例(全数。
  // 距離は 1700m〈先頭が 100m の表〉・1800m・2000m)。200 の倍数の距離と 1700m 以外で一致するかは未確認。
  const CASES = [
    ["result_202602010607.html", "202602010607", "horse_results_2021105857.json", "29.9-37.6"],
    ["result_202603020211.html", "202603020211", "horse_results_2023103386.json", "34.5-34.5"],
    ["result_202605040205.html", "202605040205", "horse_results_2024103584.json", "37.9-34.1"],
  ] as const;

  it.each(CASES)("%s のペースは、戦績 API(%s)の pace と文字まで一致する", (resultFile, raceId, apiFile, expected) => {
    const rec = mustOk(fx(resultFile), raceId, "central");
    const run = parseHorseResults(fx(apiFile)).find((r) => r.raceIdRaw === raceId);
    // 前提の固定: 戦績 API 側の実例が見つかり、値が期待どおり(見つからないと下の比較が空振りする)
    expect(run?.pace).toBe(expected);
    expect(rec.pace).toBe(run!.pace);
  });

  it("レコードに区間タイム・ペース・区分が入り、障害(表なし)は null", () => {
    const rec = mustOk(fx("result_202603020211.html"), "202603020211", "central");
    expect(rec.lapTimes).toHaveLength(9);
    expect(rec.pace).toBe("34.5-34.5");
    expect(rec.paceClass).toBe("M");
    const jump = mustOk(fx("result_202605040709.html"), "202605040709", "central");
    expect([jump.lapTimes, jump.pace, jump.paceClass]).toEqual([null, null, null]);
  });
});
