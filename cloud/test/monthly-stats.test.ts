import { describe, expect, it } from "vitest";
import { buildMonthStats } from "../src/monthly-stats";
import { buildPeriodStats, type PeriodRows } from "../src/period-stats";

/**
 * Issue #279(#265-A): 月の統計。D1 の行(期間の再集計と同じ行)から、月全体の統計(`buildPeriodStats` と同じ数字)に、
 * 開催日ごとの行と、プロンプト版ごとの行を足したものを作る純関数。日ごと・版ごとの行は**同じ行の分割**なので、足し合わせると月全体になる。
 */

const RANGE = { fromDate: "20261001", toDate: "20261031" };

/**
 * 3 開催日・4 レース・3 つの版(v1・v2・版不明):
 *  - 10/03 A1(v1。結果あり・単勝的中 200 円 → 800・複勝はずれ 100 円)・A2(v1。結果なし・買い目 500 円は判定不能)
 *  - 10/10 B1(v2。結果あり・単勝はずれ 300 円)
 *  - 10/31 C1(版不明。結果あり・単勝的中 100 円 → 600)
 */
function rows(): PeriodRows {
  return {
    races: [
      { analysisId: 1, raceId: "202605030801", kaisaiDate: "20261003", model: "claude-sonnet-5-5", promptVersion: "v1" },
      { analysisId: 2, raceId: "202605030802", kaisaiDate: "20261003", model: null, promptVersion: "v1" },
      { analysisId: 3, raceId: "202605030901", kaisaiDate: "20261010", model: "claude-sonnet-5-5", promptVersion: "v2" },
      { analysisId: 4, raceId: "202605031001", kaisaiDate: "20261031", model: "claude-sonnet-5-5", promptVersion: null },
    ],
    bets: [
      { analysisId: 1, betType: "win", comboKey: "01", stake: 200, odds: 4, ev: 1.2 },
      { analysisId: 1, betType: "place", comboKey: "02", stake: 100, odds: 2, ev: 1.0 },
      { analysisId: 2, betType: "win", comboKey: "05", stake: 500, odds: 4, ev: 1.2 },
      { analysisId: 3, betType: "win", comboKey: "03", stake: 300, odds: 5, ev: 1.5 },
      { analysisId: 4, betType: "win", comboKey: "01", stake: 100, odds: 5, ev: 1.5 },
    ],
    marks: [
      { analysisId: 1, umaban: 1, mark: "◎" },
      { analysisId: 3, umaban: 3, mark: "◎" },
      { analysisId: 4, umaban: 1, mark: "◎" },
    ],
    results: [
      { raceId: "202605030801", umaban: 1, finishPosition: 1, winPayout: 400, placePayout: 150 },
      { raceId: "202605030801", umaban: 3, finishPosition: 2, winPayout: null, placePayout: 200 },
      { raceId: "202605030801", umaban: 4, finishPosition: 3, winPayout: null, placePayout: 120 },
      { raceId: "202605030801", umaban: 2, finishPosition: 5, winPayout: null, placePayout: null },
      { raceId: "202605030901", umaban: 1, finishPosition: 1, winPayout: 300, placePayout: 110 },
      { raceId: "202605030901", umaban: 2, finishPosition: 2, winPayout: null, placePayout: 130 },
      { raceId: "202605030901", umaban: 4, finishPosition: 3, winPayout: null, placePayout: 140 },
      { raceId: "202605030901", umaban: 3, finishPosition: 4, winPayout: null, placePayout: null },
      { raceId: "202605031001", umaban: 1, finishPosition: 1, winPayout: 600, placePayout: 200 },
      { raceId: "202605031001", umaban: 2, finishPosition: 2, winPayout: null, placePayout: 150 },
    ],
    combos: [],
    imports: [],
  };
}

describe("buildMonthStats(月全体)", () => {
  it("月全体の数字は、同じ行を期間の統計(buildPeriodStats)に通したものと同じ(期間の範囲・開催日数も含む)", () => {
    const month = buildMonthStats(rows(), RANGE);
    const period = buildPeriodStats(rows(), RANGE);
    const { days: _days, byVersion: _byVersion, ...rest } = month;
    expect(rest).toEqual(period);
    // 前提: 数字が自明に 0 でない(同じ空の統計どうしの比較にならない)
    expect(period.raceCount).toBe(4);
    expect(period.totalStake).toBe(700);
    expect(period.totalReturn).toBe(1400);
    expect(period.dayCount).toBe(3);
  });
});

describe("buildMonthStats(開催日ごとの行)", () => {
  it("分析のあった開催日だけが昇順に並び、レース数・結果・賭け金・払戻・回収率・点数・的中が日ごとの数字になる", () => {
    const { days } = buildMonthStats(rows(), RANGE);
    expect(days.map((d) => d.date)).toEqual(["20261003", "20261010", "20261031"]);
    const [d3, d10, d31] = days;
    expect(d3).toMatchObject({ raceCount: 2, resultRaceCount: 1, noResultRaceCount: 1, totalStake: 300, totalReturn: 800, judgedBetCount: 2, hitBetCount: 1 });
    expect(d3!.recoveryRate).toBeCloseTo(800 / 300, 12);
    expect(d10).toMatchObject({ raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, totalStake: 300, totalReturn: 0, judgedBetCount: 1, hitBetCount: 0 });
    expect(d10!.recoveryRate).toBe(0);
    expect(d31).toMatchObject({ raceCount: 1, totalStake: 100, totalReturn: 600, judgedBetCount: 1, hitBetCount: 1 });
    expect(d31!.recoveryRate).toBe(6);
  });

  it("判定不能の買い目(結果が無いレースの買い目)は日ごとの点数と賭け金を持つ。無い日は 0(Issue #280。プロンプトの日ごとの行が使う)", () => {
    const month = buildMonthStats(rows(), RANGE);
    const [d3, d10, d31] = month.days;
    // 10/03 の A2(結果なし)の買い目 500 円 1 点が判定不能。他の日は無い
    expect(d3).toMatchObject({ unjudgedBetCount: 1, unjudgedStake: 500 });
    expect(d10).toMatchObject({ unjudgedBetCount: 0, unjudgedStake: 0 });
    expect(d31).toMatchObject({ unjudgedBetCount: 0, unjudgedStake: 0 });
    // 足すと月全体(前提: 月全体の判定不能が 0 でない)
    expect(month.unjudgedBetCount).toBe(1);
    expect(month.unjudgedStake).toBe(500);
    expect(month.days.reduce((n, d) => n + d.unjudgedBetCount, 0)).toBe(month.unjudgedBetCount);
    expect(month.days.reduce((n, d) => n + d.unjudgedStake, 0)).toBe(month.unjudgedStake);
  });

  it("日ごとの行を足すと月全体になる(日ごとの数字が 0 でないことを先に固定する)", () => {
    const month = buildMonthStats(rows(), RANGE);
    expect(month.days.every((d) => d.totalStake > 0)).toBe(true);
    const sum = (pick: (d: (typeof month.days)[number]) => number): number => month.days.reduce((n, d) => n + pick(d), 0);
    expect(sum((d) => d.raceCount)).toBe(month.raceCount);
    expect(sum((d) => d.resultRaceCount)).toBe(month.resultRaceCount);
    expect(sum((d) => d.noResultRaceCount)).toBe(month.noResultRaceCount);
    expect(sum((d) => d.totalStake)).toBe(month.totalStake);
    expect(sum((d) => d.totalReturn)).toBe(month.totalReturn);
    expect(sum((d) => d.judgedBetCount)).toBe(month.judgedBetCount);
    expect(sum((d) => d.hitBetCount)).toBe(month.hitBetCount);
  });

  it("賭け金が 0 の日の回収率は null(0 除算にしない)", () => {
    const r = rows();
    const noBet: PeriodRows = { ...r, bets: r.bets.filter((b) => b.analysisId !== 3) };
    const d10 = buildMonthStats(noBet, RANGE).days.find((d) => d.date === "20261010");
    expect(d10).toBeDefined();
    expect(d10!.totalStake).toBe(0);
    expect(d10!.recoveryRate).toBeNull();
  });

  it("返還(取消・除外の馬への買い目)は日ごとの点数・賭け金・払戻に含まれ、返還の点数も持つ", () => {
    const r = rows();
    // B1 の 3 番(単勝 300 円。元は 4 着ではずれ)を、取消・除外にする
    const scratched: PeriodRows = {
      ...r,
      results: r.results.map((x) => (x.raceId === "202605030901" && x.umaban === 3 ? { raceId: x.raceId, umaban: 3, finishPosition: null, winPayout: null, placePayout: null, scratched: true } : x)),
    };
    const d10 = buildMonthStats(scratched, RANGE).days.find((d) => d.date === "20261010")!;
    expect(d10.refundedBetCount).toBe(1);
    expect(d10.totalStake).toBe(300);
    expect(d10.totalReturn).toBe(300); // 返還は賭け金がそのまま戻る
    expect(d10.hitBetCount).toBe(0); // 的中には数えない
  });
});

describe("buildMonthStats(プロンプト版ごとの行)", () => {
  it("版の昇順に並び、版不明(null)は末尾。レース数・結果・賭け金・払戻・回収率・点数・的中が版ごとの数字になる", () => {
    const { byVersion } = buildMonthStats(rows(), RANGE);
    expect(byVersion.map((v) => v.promptVersion)).toEqual(["v1", "v2", null]);
    expect(byVersion[0]).toMatchObject({ raceCount: 2, resultRaceCount: 1, totalStake: 300, totalReturn: 800, judgedBetCount: 2, hitBetCount: 1 });
    expect(byVersion[0]!.recoveryRate).toBeCloseTo(800 / 300, 12);
    expect(byVersion[1]).toMatchObject({ raceCount: 1, totalStake: 300, totalReturn: 0, judgedBetCount: 1, hitBetCount: 0 });
    expect(byVersion[1]!.recoveryRate).toBe(0);
    expect(byVersion[2]).toMatchObject({ raceCount: 1, totalStake: 100, totalReturn: 600, judgedBetCount: 1, hitBetCount: 1 });
  });

  it("版ごとの行を足すと月全体になる(版ごとの数字が 0 でないことを先に固定する)", () => {
    const month = buildMonthStats(rows(), RANGE);
    expect(month.byVersion).toHaveLength(3);
    expect(month.byVersion.every((v) => v.totalStake > 0)).toBe(true);
    const sum = (pick: (v: (typeof month.byVersion)[number]) => number): number => month.byVersion.reduce((n, v) => n + pick(v), 0);
    expect(sum((v) => v.raceCount)).toBe(month.raceCount);
    expect(sum((v) => v.totalStake)).toBe(month.totalStake);
    expect(sum((v) => v.totalReturn)).toBe(month.totalReturn);
    expect(sum((v) => v.hitBetCount)).toBe(month.hitBetCount);
  });

  it("版の列を持たない行(promptVersion のキーが無い)は、版不明(null)にまとめる", () => {
    const r = rows();
    const noVersion: PeriodRows = { ...r, races: r.races.map(({ promptVersion: _p, ...rest }) => rest) };
    const { byVersion } = buildMonthStats(noVersion, RANGE);
    expect(byVersion).toHaveLength(1);
    expect(byVersion[0]).toMatchObject({ promptVersion: null, raceCount: 4, totalStake: 700, totalReturn: 1400 });
  });
});

describe("buildMonthStats(分析が無い月)", () => {
  it("行が無ければ、日ごと・版ごとの行は空で、月全体は 0 件・回収率 null", () => {
    const month = buildMonthStats({ races: [], bets: [], marks: [], results: [], combos: [], imports: [] }, RANGE);
    expect(month.days).toEqual([]);
    expect(month.byVersion).toEqual([]);
    expect(month.raceCount).toBe(0);
    expect(month.recoveryRate).toBeNull();
    expect(month.dayCount).toBe(0);
    expect(month.fromDate).toBe("20261001");
    expect(month.toDate).toBe("20261031");
  });
});
