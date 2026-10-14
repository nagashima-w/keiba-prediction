import { describe, expect, it } from "vitest";
import {
  isLiveAnalysisDate,
  jockeyStatsWindow,
  selectJockeyStats,
} from "../../src/scorer/jockey-stats.js";
import type { JockeyYearRecord } from "../../src/scraper/parse-jockey-results.js";

/** 年ごとの記録(騎乗数は年×100、3着内は年×30 など、年が分かる値にして足し間違いを検出できるようにする)。 */
const RECORDS: readonly JockeyYearRecord[] = [
  { year: 2026, starts: 600, placed: 200 },
  { year: 2025, starts: 700, placed: 210 },
  { year: 2024, starts: 800, placed: 220 },
  { year: 2023, starts: 900, placed: 230 },
];

/** JST の日時を指定して Date にする(JST = UTC+9)。 */
const jst = (iso: string): Date => new Date(new Date(`${iso}+09:00`).getTime());

describe("isLiveAnalysisDate(分析日がライブ〈今日以降〉か過去日か。基準は JST の暦日)", () => {
  it.each([
    ["前日の21時(JST)に翌日を分析する(事前分析)", "2026/10/12", "2026-10-11T21:00:00", true],
    ["当日(発走前の分析)", "2026/10/11", "2026-10-11T13:00:00", true],
    ["昨日の開催日(過去日の分析)", "2026/10/10", "2026-10-11T13:00:00", false],
    ["JST の日付が変わった直後(UTC ではまだ前日)は、前日の開催日を過去日として扱う", "2026/10/11", "2026-10-12T00:30:00", false],
    ["JST の0時台(UTC では前日)でも、JST の今日の開催日はライブ", "2026/10/12", "2026-10-12T00:30:00", true],
    ["年をまたぐ: 12/31 の21時に元日を分析する", "2027/01/01", "2026-12-31T21:00:00", true],
  ])("%s", (_name, analysisDate, nowJst, expected) => {
    expect(isLiveAnalysisDate(analysisDate, jst(nowJst))).toBe(expected);
  });

  it("YYYY/MM/DD でない分析日は失敗させる(黙ってライブ扱いにしない)", () => {
    expect(() => isLiveAnalysisDate("2026-10-11", jst("2026-10-11T13:00:00"))).toThrow();
  });
});

describe("jockeyStatsWindow(集計する年の窓)", () => {
  it.each([
    ["ライブ: 前年+当年", "2026/10/12", true, [2025, 2026]],
    ["過去日: 前々年+前年(分析日の年の成績は、分析日より後の騎乗を含むので使わない)", "2026/03/01", false, [2024, 2025]],
    ["年初のライブ: 前年+当年", "2027/01/05", true, [2026, 2027]],
  ])("%s", (_name, analysisDate, live, expected) => {
    expect(jockeyStatsWindow(analysisDate, live)).toEqual(expected);
  });
});

describe("selectJockeyStats(騎手の年ごとの記録から、窓の年だけを足し合わせる)", () => {
  it("ライブ(分析日 2026/10/12・今日 2026/10/11): 2026 と 2025 の合計だけ(2024 以前は入らない)", () => {
    const s = selectJockeyStats(RECORDS, "2026/10/12", jst("2026-10-11T21:00:00"));
    expect(s).toEqual({ starts: 600 + 700, placed: 200 + 210 });
  });

  it("過去日(分析日 2026/10/10・今日 2026/10/11): 2025 と 2024 の合計だけ(当年 2026 は入らない)", () => {
    const s = selectJockeyStats(RECORDS, "2026/10/10", jst("2026-10-11T13:00:00"));
    expect(s).toEqual({ starts: 700 + 800, placed: 210 + 220 });
  });

  it("記録そのものが無い(取得できなかった)ときは undefined(= データなし)", () => {
    expect(selectJockeyStats(undefined, "2026/10/12", jst("2026-10-11T21:00:00"))).toBeUndefined();
  });

  it("記録はあるが窓の年の行が1つも無い(例: 騎手が今年デビューで前年が無い・成績の無い騎手)ときは、騎乗数0の記録", () => {
    const s = selectJockeyStats([{ year: 2022, starts: 50, placed: 10 }], "2026/10/12", jst("2026-10-11T21:00:00"));
    expect(s).toEqual({ starts: 0, placed: 0 });
    expect(selectJockeyStats([], "2026/10/12", jst("2026-10-11T21:00:00"))).toEqual({ starts: 0, placed: 0 });
  });

  it("窓の片方の年しか無い(デビュー2年目など)ときは、ある年だけを足す", () => {
    const s = selectJockeyStats(
      [
        { year: 2026, starts: 624, placed: 136 },
        { year: 2025, starts: 345, placed: 45 },
      ],
      "2026/10/12",
      jst("2026-10-11T21:00:00"),
    );
    expect(s).toEqual({ starts: 969, placed: 181 });
  });
});
