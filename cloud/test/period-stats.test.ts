import { describe, expect, it } from "vitest";
import type { RaceResultData } from "../src/daily-report-bets";
import { buildDayStats, buildRaceDigest } from "../src/daily-report-digest";
import { buildPeriodStats, buildRollingSummary, rollingPriorWindow, ROLLING_DAYS, type PeriodRows } from "../src/period-stats";
import { fixtureRaceInputs } from "./daily-report-fixtures";

/**
 * Issue #264: 期間の統計(直前 27 日の再集計)。D1 の行から `DayStats` と同じ形の統計を作る純関数。
 * 集計の本体は日報の 1 日の統計(`buildDayStats`)と同じ関数を通るので、**同じ 1 日分の入力から両方で同じ数字になる**ことを固定する(最後の describe)。
 */

describe("rollingPriorWindow(その日を除く直前 27 日。28 日累計は、これにその日の統計を足して作る)", () => {
  it("定数: 28 日累計 = 直前 27 日 + その日", () => {
    expect(ROLLING_DAYS).toBe(28);
  });

  it.each([
    { name: "同じ月の中", date: "20261011", from: "20260914", to: "20261010" },
    { name: "月またぎ(10/1 の直前 27 日は 9/4〜9/30)", date: "20261001", from: "20260904", to: "20260930" },
    { name: "2 月をまたぐ(平年。3/1 の前日は 2/28)", date: "20260301", from: "20260202", to: "20260228" },
    { name: "2 月をまたぐ(うるう年。3/1 の前日は 2/29)", date: "20240301", from: "20240203", to: "20240229" },
    { name: "年またぎ", date: "20270105", from: "20261209", to: "20270104" },
  ])("$name: $date → $from〜$to", ({ date, from, to }) => {
    expect(rollingPriorWindow(date)).toEqual({ fromDate: from, toDate: to });
  });

  it("窓の長さは 27 日(両端を含む): from から to までの日数 + 1", () => {
    const { fromDate, toDate } = rollingPriorWindow("20261011");
    const days = (Date.UTC(+toDate.slice(0, 4), +toDate.slice(4, 6) - 1, +toDate.slice(6)) - Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(4, 6) - 1, +fromDate.slice(6))) / 86_400_000 + 1;
    expect(days).toBe(ROLLING_DAYS - 1);
  });
});

const emptyRows = (): PeriodRows => ({ races: [], bets: [], marks: [], results: [], combos: [], imports: [] });
const RANGE = { fromDate: "20260914", toDate: "20261010" };

describe("buildPeriodStats(行 → 統計)", () => {
  /** 2 開催日・3 レース: 9/20 の R1(結果あり・単勝的中)・R2(結果なし・買い目あり)、10/4 の R3(結果あり・はずれ)。 */
  function rows(): PeriodRows {
    return {
      races: [
        { analysisId: 1, raceId: "202605030801", kaisaiDate: "20260920", model: "claude-sonnet-5-5" },
        { analysisId: 2, raceId: "202605030802", kaisaiDate: "20260920", model: null },
        { analysisId: 3, raceId: "202605030901", kaisaiDate: "20261004", model: "claude-sonnet-5-5" },
      ],
      bets: [
        { analysisId: 1, betType: "win", comboKey: "01", stake: 200, odds: 4, ev: 1.2 }, // 的中 400 円 → 800
        { analysisId: 1, betType: "place", comboKey: "02", stake: 100, odds: 2, ev: 1.0 }, // はずれ(02 は 5 着)
        { analysisId: 2, betType: "win", comboKey: "05", stake: 500, odds: 4, ev: 1.2 }, // 結果なしで判定不能
        { analysisId: 3, betType: "win", comboKey: "03", stake: 300, odds: 5, ev: 1.5 }, // はずれ
      ],
      marks: [
        { analysisId: 1, umaban: 1, mark: "◎" },
        { analysisId: 1, umaban: 2, mark: "〇" },
        { analysisId: 2, umaban: 5, mark: "◎" },
        { analysisId: 3, umaban: 3, mark: "◎" },
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
      ],
      combos: [],
      imports: [],
    };
  }

  it("期間の範囲と、実際に分析があった開催日の数(dayCount)を持つ。開催の無い日は数えない", () => {
    const s = buildPeriodStats(rows(), RANGE);
    expect(s.fromDate).toBe("20260914");
    expect(s.toDate).toBe("20261010");
    expect(s.dayCount).toBe(2); // 27 日のうち 9/20 と 10/4 の 2 日だけ
    expect(s.raceCount).toBe(3);
    expect(s.resultRaceCount).toBe(2);
    expect(s.noResultRaceCount).toBe(1);
    expect(s.betRaceCount).toBe(3);
    expect(s.llmUsedRaceCount).toBe(2); // R2 の model が null
  });

  it("賭け金・払戻・点数・的中は、判定できた買い目だけ。結果なしのレースの買い目は判定不能に数える", () => {
    const s = buildPeriodStats(rows(), RANGE);
    expect(s.totalStake).toBe(600); // 200 + 100 + 300
    expect(s.totalReturn).toBe(800);
    expect(s.recoveryRate).toBeCloseTo(800 / 600, 12);
    expect(s.judgedBetCount).toBe(3);
    expect(s.hitBetCount).toBe(1);
    expect(s.unjudgedBetCount).toBe(1);
    expect(s.unjudgedStake).toBe(500);
  });

  it("見込みの的中数は、判定できた買い目の ev / odds の合計(判定不能の買い目は入れない)。最大払戻の 1 点を持つ", () => {
    const s = buildPeriodStats(rows(), RANGE);
    expect(s.expectedBetCount).toBe(3);
    expect(s.expectedHits).toBeCloseTo(1.2 / 4 + 1.0 / 2 + 1.5 / 5, 12);
    expect(s.expectedHits).not.toBeCloseTo(1.2 / 4 + 1.0 / 2 + 1.5 / 5 + 1.2 / 4, 3);
    expect(s.maxPayout).toBe(800);
    expect(s.maxPayoutStake).toBe(200);
  });

  it("Issue #278 返還: 行の scratched=true の馬への買い目は返還(賭け金・払戻・点数に含め、的中には入れない)。scratched が無い行(旧い行)の着順なしは従来どおりはずれ", () => {
    const base = rows();
    const withScratched = (scratched: boolean | undefined): PeriodRows => ({
      ...base,
      // R1 の 2 番(複勝の買い目 100 円。元は 5 着ではずれ)を、着順なしにして scratched を付け替える
      results: base.results.map((r) => (r.raceId === "202605030801" && r.umaban === 2 ? { raceId: r.raceId, umaban: 2, finishPosition: null, winPayout: null, placePayout: null, ...(scratched === undefined ? {} : { scratched }) } : r)),
    });
    const refunded = buildPeriodStats(withScratched(true), RANGE);
    expect(refunded.refundedBetCount).toBe(1);
    expect(refunded.refundedStake).toBe(100);
    expect(refunded.judgedBetCount).toBe(3); // 点数は変わらない(はずれ → 返還)
    expect(refunded.hitBetCount).toBe(1);
    expect(refunded.totalStake).toBe(600);
    expect(refunded.totalReturn).toBe(900); // 的中 800 + 返還 100
    expect(refunded.byBetType["place"]!.refundCount).toBe(1);
    expect(refunded.expectedBetCount).toBe(2); // 返還は見込みに入れない(3 → 2)
    // 対照: scratched が無い(旧い行)・false(中止など)は、はずれのまま
    for (const flag of [undefined, false]) {
      const s = buildPeriodStats(withScratched(flag), RANGE);
      expect(s.refundedBetCount).toBe(0);
      expect(s.totalReturn).toBe(800);
    }
  });

  it("印別は、結果のあるレースの頭数・1 着・3 着内(結果の無いレースの印は数えない)。着順に載っていない馬は数えない", () => {
    const s = buildPeriodStats(rows(), RANGE);
    expect(s.byMark).toEqual([
      { mark: "◎", count: 2, win: 1, top3: 1 }, // R1 の ◎=1 着、R3 の ◎(3 番)=4 着。R2 は結果なし
      { mark: "〇", count: 1, win: 0, top3: 0 }, // R1 の 〇(2 番)=5 着
    ]);
  });

  it("別の分析の買い目・印を取り違えない(analysisId で束ねる)。行の無い分析・どの分析にも属さない行は無視する", () => {
    const r = rows();
    const withStray: PeriodRows = { ...r, bets: [...r.bets, { analysisId: 999, betType: "win", comboKey: "01", stake: 7777, odds: 4, ev: 1.2 }], marks: [...r.marks, { analysisId: 999, umaban: 1, mark: "☆" }] };
    expect(buildPeriodStats(withStray, RANGE)).toEqual(buildPeriodStats(r, RANGE));
  });

  it("組合せ券種: 取込印がある券種の払戻で判定し、無い券種は判定不能(日報と同じ判定)", () => {
    const r = rows();
    const plus: PeriodRows = {
      ...r,
      bets: [...r.bets, { analysisId: 1, betType: "wide", comboKey: "0103", stake: 100, odds: 8, ev: 1.0 }, { analysisId: 1, betType: "trio", comboKey: "010203", stake: 100, odds: 30, ev: 1.0 }],
      combos: [{ raceId: "202605030801", betType: "wide", comboKey: "0103", payout: 900 }],
      imports: [{ raceId: "202605030801", betType: "wide" }],
    };
    const s = buildPeriodStats(plus, RANGE);
    expect(s.byBetType["wide"]).toMatchObject({ betCount: 1, hitCount: 1, stake: 100, payout: 900 });
    expect(s.byBetType["trio"]).toBeUndefined(); // 3 連複は未取込で判定不能
    expect(s.unjudgedBetCount).toBe(2);
  });

  it("Issue #272: 印の定型の買い方(whatIf)は、同じ行(印・結果・組合せ払戻・取込印)から作る。判定できた・判定不能・対象外が別々に数えられる", () => {
    const w = buildPeriodStats(rows(), RANGE).whatIf!;
    // R1(◎1 着・〇5 着・結果あり)・R2(◎のみ・結果なし)・R3(◎4 着・結果あり)。組合せ払戻の行は無い。
    expect(w["win"]).toEqual({ betCount: 2, hitCount: 1, stake: 200, payout: 400, refundCount: 0, unjudgedCount: 1, inapplicableCount: 0 });
    expect(w["place"]).toEqual({ betCount: 2, hitCount: 1, stake: 200, payout: 150, refundCount: 0, unjudgedCount: 1, inapplicableCount: 0 });
    // ワイド・馬連: R1 だけ◎〇が揃うが取込印が無く判定不能。R2・R3 は〇が無く対象外
    expect(w["wide"]).toEqual({ betCount: 0, hitCount: 0, stake: 0, payout: 0, refundCount: 0, unjudgedCount: 1, inapplicableCount: 2 });
    expect(w["quinella"]).toEqual(w["wide"]);
    // 3 連複: ▲が無く 3 レースとも対象外
    expect(w["trio"]).toEqual({ betCount: 0, hitCount: 0, stake: 0, payout: 0, refundCount: 0, unjudgedCount: 0, inapplicableCount: 3 });
  });

  it("Issue #272: 組合せ払戻と取込印があれば、ワイド・馬連・3 連複の型が的中として数えられる(別のレースの払戻は混ぜない)", () => {
    const r = rows();
    const withCombos: PeriodRows = {
      ...r,
      marks: [...r.marks, { analysisId: 1, umaban: 3, mark: "▲" }, { analysisId: 3, umaban: 2, mark: "〇" }],
      combos: [
        { raceId: "202605030801", betType: "wide", comboKey: "0102", payout: 900 },
        { raceId: "202605030801", betType: "trio", comboKey: "010203", payout: 6000 },
        { raceId: "202605030901", betType: "wide", comboKey: "0102", payout: 111 },
      ],
      imports: [{ raceId: "202605030801", betType: "wide" }, { raceId: "202605030801", betType: "trio" }, { raceId: "202605030801", betType: "quinella" }, { raceId: "202605030901", betType: "wide" }],
    };
    const w = buildPeriodStats(withCombos, RANGE).whatIf!;
    // 判定は払戻の表のキー(昇順の組)との一致。R3 は◎3-〇2(キー 0203)で、R3 の払戻の表は 0102 だけ → はずれ(R1 の 0102 の払戻 900 と混ざらない)
    expect(w["wide"]).toMatchObject({ betCount: 2, hitCount: 1, payout: 900, unjudgedCount: 0, inapplicableCount: 1 });
    expect(w["trio"]).toMatchObject({ betCount: 1, hitCount: 1, payout: 6000, inapplicableCount: 2 });
    // 馬連: R1 は取込印だけで払戻 0 件、R3 は取込印なし → どちらも判定不能。R2 は〇が無く対象外
    expect(w["quinella"]).toMatchObject({ betCount: 0, unjudgedCount: 2, inapplicableCount: 1 });
  });

  it("行が 1 つも無い期間は、件数 0・回収率 null・開催日 0(落ちない)", () => {
    const s = buildPeriodStats(emptyRows(), RANGE);
    expect(s).toMatchObject({ raceCount: 0, dayCount: 0, totalStake: 0, recoveryRate: null, expectedHits: 0, maxPayout: 0, byMark: [], byBetType: {} });
  });
});

describe("日報の 1 日の統計と、期間の統計が同じ数字になる(突き合わせ。集計の本体は同じ関数だが、行 → 入力の組み立てが食い違わないことを固定する)", () => {
  /** 日報の材料(分析のビューと結果)から、D1 の行を逆に作る。 */
  function rowsFromFixtures(): PeriodRows {
    const out: PeriodRows = { races: [], bets: [], marks: [], results: [], combos: [], imports: [] };
    const races = out.races as PeriodRows["races"][number][];
    const bets = out.bets as PeriodRows["bets"][number][];
    const marks = out.marks as PeriodRows["marks"][number][];
    const results = out.results as PeriodRows["results"][number][];
    const combos = out.combos as PeriodRows["combos"][number][];
    const imports = out.imports as PeriodRows["imports"][number][];
    for (const input of fixtureRaceInputs()) {
      const v = input.view;
      races.push({ analysisId: v.id, raceId: v.raceId, kaisaiDate: v.kaisaiDate!, model: v.model });
      for (const b of v.allocation!.bets) {
        bets.push({ analysisId: v.id, betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev });
      }
      for (const h of v.horses) {
        if (h.mark !== null) marks.push({ analysisId: v.id, umaban: h.umaban, mark: h.mark });
      }
      const res: RaceResultData | undefined = input.result;
      for (const h of res?.horses ?? []) {
        results.push({ raceId: v.raceId, umaban: h.umaban, finishPosition: h.finishPosition, winPayout: h.winPayout, placePayout: h.placePayout });
      }
      for (const [betType, c] of Object.entries(res?.combos ?? {})) {
        if (c.imported) imports.push({ raceId: v.raceId, betType });
        for (const p of c.payouts) combos.push({ raceId: v.raceId, betType, comboKey: p.comboKey, payout: p.payout });
      }
    }
    return out;
  }

  it("偽の 3 レース(結果あり 2・なし 1、単勝・複勝・ワイド・馬連〈未取込〉)で、DayStats の全項目が一致する", () => {
    const day = buildDayStats(fixtureRaceInputs().map((i) => buildRaceDigest(i.view, i.result)));
    const period = buildPeriodStats(rowsFromFixtures(), { fromDate: "20261010", toDate: "20261010" });
    // 前提(空振り防止): 的中・はずれ・判定不能・組合せの払戻・印別・見込みのすべてが実際に数えられている
    expect(day.hitBetCount).toBeGreaterThan(0);
    expect(day.judgedBetCount - day.hitBetCount).toBeGreaterThan(0);
    expect(day.unjudgedBetCount).toBeGreaterThan(0);
    expect(day.byBetType["wide"]?.hitCount).toBe(1);
    expect(day.byMark.length).toBeGreaterThan(1);
    expect(day.expectedBetCount).toBe(day.judgedBetCount);
    expect(day.expectedHits).toBeGreaterThan(0);
    expect(day.maxPayout).toBeGreaterThan(0);
    // 定型(Issue #272)も実際に数えられている: 単勝は的中 1・はずれ 1・判定不能 1、3 連複は判定不能 1・対象外 2
    expect(day.whatIf!["win"]).toMatchObject({ betCount: 2, hitCount: 1, unjudgedCount: 1 });
    expect(day.whatIf!["trio"]).toMatchObject({ betCount: 0, unjudgedCount: 1, inapplicableCount: 2 });
    const { dayCount, fromDate, toDate, ...stats } = period;
    expect(dayCount).toBe(1);
    expect([fromDate, toDate]).toEqual(["20261010", "20261010"]);
    expect(stats).toStrictEqual(day);
  });
});

describe("buildRollingSummary(直前 27 日 + その日 = 28 日累計)", () => {
  const day = () => buildDayStats(fixtureRaceInputs().map((i) => buildRaceDigest(i.view, i.result)));
  const prior = () => buildPeriodStats(
    {
      races: [{ analysisId: 1, raceId: "202605030801", kaisaiDate: "20260920", model: "claude-sonnet-5-5" }],
      bets: [{ analysisId: 1, betType: "win", comboKey: "01", stake: 1000, odds: 4, ev: 1.2 }],
      marks: [{ analysisId: 1, umaban: 1, mark: "◎" }],
      results: [
        { raceId: "202605030801", umaban: 3, finishPosition: 1, winPayout: 500, placePayout: 150 },
        { raceId: "202605030801", umaban: 1, finishPosition: 2, winPayout: null, placePayout: 200 },
      ],
      combos: [],
      imports: [],
    },
    { fromDate: "20260913", toDate: "20261009" },
  );

  it("累計は、直前 27 日の統計とその日の統計の和。範囲は D−27〜D、開催日数は 27 日側 + その日(1)", () => {
    const p = prior();
    const d = day();
    const r = buildRollingSummary("20261010", d, p);
    // 前提(空振り防止): 両方に賭け金・見込みがある
    expect(p.totalStake).toBeGreaterThan(0);
    expect(d.totalStake).toBeGreaterThan(0);
    expect(r.windowDays).toBe(28);
    expect(r.prior).toBe(p);
    expect(r.total.fromDate).toBe("20260913");
    expect(r.total.toDate).toBe("20261010");
    expect(r.total.dayCount).toBe(p.dayCount + 1);
    expect(r.total.raceCount).toBe(p.raceCount + d.raceCount);
    expect(r.total.totalStake).toBe(p.totalStake + d.totalStake);
    expect(r.total.totalReturn).toBe(p.totalReturn + d.totalReturn);
    expect(r.total.expectedHits).toBeCloseTo(p.expectedHits + d.expectedHits, 12);
    expect(r.total.recoveryRate).toBeCloseTo((p.totalReturn + d.totalReturn) / (p.totalStake + d.totalStake), 12);
  });

  it("その日にレースが無いとき(0 件)は開催日に数えない。直前 27 日が空でも累計はその日の統計になる", () => {
    const empty = buildPeriodStats(emptyRows(), { fromDate: "20260913", toDate: "20261009" });
    expect(buildRollingSummary("20261010", buildDayStats([]), empty).total.dayCount).toBe(0);
    const r = buildRollingSummary("20261010", day(), empty);
    expect(r.total.dayCount).toBe(1);
    expect(r.prior.dayCount).toBe(0);
    expect(r.total.totalStake).toBe(day().totalStake);
    expect(r.total.byMark).toEqual(day().byMark);
  });
});
