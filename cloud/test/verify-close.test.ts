import { describe, expect, it } from "vitest";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { computeCloseComparison, type CloseComparison, type VerifyCloseBetRow, type VerifyCloseMetaRow, type VerifyCloseRows } from "../src/verify-close";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyReadRows, type VerifyResultRow } from "../src/verify-read";

/**
 * Issue #379 で `computeCloseComparison` は区分と基準の入力を取るようになった。このファイルの既存のテストは、Issue #352 の仕様(中央の分析だけ・組合せの基準なし)を固定するもので、
 * 区分 `central`・組合せ ON の分析なしで呼ぶ(中央の挙動の保証は弱めていない)。地方・基準・旧い行は `verify-close-venue.test.ts`。
 */
const compute = (source: Parameters<typeof computeCloseComparison>[0], close: Parameters<typeof computeCloseComparison>[1]) =>
  computeCloseComparison(source, close, { venue: "central", comboOnIds: new Set<number>() });

/**
 * Issue #352(#335-C): 検証画面に、分析時と締切直前の再計算(回 1 = 5 分前、回 2 = 直前)の回収率を並べる。純関数 `computeCloseComparison` の仕様。
 * 計算は core の `computeVerifyReport`(`PRODUCTION_VERIFY_CONFIG`)をそのまま使い、`getAllocationForVerify` だけを差し替える。
 * **最新の選択・結果の有無・先読みの遮断などの集計対象の規則は、全分析に対して本体の検証と同じに行い、そのあとで配分を返す分析を ok の回の分析だけにする**。
 */

const R1 = "202606030801";
const R2 = "202606030802";
const R3 = "202606030803";
const R4 = "202606030804";
const NAR = "202644071411";

function analysis(id: number, raceId: string, over: Partial<VerifyAnalysisRow> = {}): VerifyAnalysisRow {
  return {
    id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
    ...over,
  };
}

/** 結果: 1 番は hit なら 1 着(複勝 300 円)、miss なら 5 着(払戻なし)。2 番は常に 2 着(複勝 150 円)。 */
function resultsOf(raceId: string, hit: boolean): VerifyResultRow[] {
  return [
    { raceId, umaban: 1, finishPosition: hit ? 1 : 5, placePayout: hit ? 300 : null, winPayout: null },
    { raceId, umaban: 2, finishPosition: 2, placePayout: 150, winPayout: null },
  ];
}

const place = (key: string, stake: number) => ({ betType: "place", comboKey: key, stake });

/** 分析時の配分(メタと買い目)。 */
function baseAllocation(analysisId: number, bets: ReadonlyArray<{ betType: string; comboKey: string; stake: number }>): { meta: VerifyReadRows["allocationMeta"][number]; bets: VerifyReadRows["bets"] } {
  return { meta: { analysisId, route: "place-only", skipReasonCode: null }, bets: bets.map((b) => ({ analysisId, ...b })) };
}

function readRows(analyses: VerifyAnalysisRow[], results: VerifyResultRow[], allocations: ReturnType<typeof baseAllocation>[]): VerifyReadRows {
  const horses = analyses.map((a) => ({ analysisId: a.id, umaban: 1, prior: 0.5, adjusted_prob: 0.5, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null }));
  return {
    analyses, horses, results,
    allocationMeta: allocations.map((a) => a.meta),
    bets: allocations.flatMap((a) => a.bets),
    comboPayouts: [], comboImports: [],
  };
}

function closeMeta(analysisId: number, round: number, status: string, over: Partial<VerifyCloseMetaRow> = {}): VerifyCloseMetaRow {
  return { analysisId, round, status, route: status === "ok" ? "place-only" : null, skipReasonCode: null, ...over };
}
function closeBet(analysisId: number, round: number, key: string, stake: number): VerifyCloseBetRow {
  return { analysisId, round, betType: "place", comboKey: key, stake };
}

/**
 * 基本の入力。
 *  A(id1・R1 的中): 分析時 place 01 に 1,000(払戻 3,000)。回 1 ok [01 に 500]・回 2 ok [02 に 400]
 *  B(id2・R2 外れ): 分析時 01 に 2,000(払戻 0)。回 1 ok [01 に 300]・回 2 failed
 *  C(id3・R3 的中): 分析時 01 に 4,000。再計算の行なし
 *  D(id4・R4 的中): 分析時 01 に 8,000。回 1・2 とも skipped(too-late)
 *  N(id5・地方): 分析時 01 に 100。回 1・2 とも skipped(nar-unsupported)
 */
function basic(): { source: ReturnType<typeof buildVerifySource>; close: VerifyCloseRows; rows: VerifyReadRows } {
  const analyses = [analysis(1, R1), analysis(2, R2), analysis(3, R3), analysis(4, R4), analysis(5, NAR)];
  const results = [...resultsOf(R1, true), ...resultsOf(R2, false), ...resultsOf(R3, true), ...resultsOf(R4, true), ...resultsOf(NAR, true)];
  const rows = readRows(analyses, results, [
    baseAllocation(1, [place("01", 1000)]),
    baseAllocation(2, [place("01", 2000)]),
    baseAllocation(3, [place("01", 4000)]),
    baseAllocation(4, [place("01", 8000)]),
    baseAllocation(5, [place("01", 100)]),
  ]);
  const close: VerifyCloseRows = {
    meta: [
      closeMeta(1, 1, "ok"), closeMeta(1, 2, "ok"),
      closeMeta(2, 1, "ok"), closeMeta(2, 2, "failed", { skipReasonCode: null }),
      closeMeta(4, 1, "skipped"), closeMeta(4, 2, "skipped"),
      closeMeta(5, 1, "skipped"), closeMeta(5, 2, "skipped"),
    ],
    bets: [closeBet(1, 1, "01", 500), closeBet(1, 2, "02", 400), closeBet(2, 1, "01", 300)],
  };
  return { source: buildVerifySource(rows), close, rows };
}

function roundOf(c: CloseComparison | null, round: number) {
  if (c === null) throw new Error("比較が null");
  const r = c.rounds.find((x) => x.round === round);
  if (r === undefined) throw new Error(`回 ${round} がない`);
  return r;
}

describe("computeCloseComparison: 同じ分析の集合で、分析時と再計算を比べる", () => {
  it("前提(空振り防止): 地方の分析は『全体』には入るが『中央』には入らず、基本の入力は 5 分析すべて集計対象になっている", () => {
    const { source } = basic();
    expect(computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "all").includedAnalysisCount).toBe(5);
    expect(computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central").includedAnalysisCount).toBe(4);
  });

  it("回 1: ok の分析(A・B)だけで、分析時の配分(1,000+2,000)と再計算の配分(500+300)の回収率を計算する。failed・skipped・行なしの分析の配分は入らない", () => {
    const { source, close } = basic();
    const r1 = roundOf(compute(source, close), 1);
    expect(r1.base.totalStake).toBe(3000); // C(4,000)・D(8,000)は入らない
    expect(r1.base.totalReturn).toBe(3000); // A のみ的中(300×1000/100)
    expect(r1.base.betCount).toBe(2);
    expect(r1.base.recoveryRate).toBeCloseTo(1.0, 10);
    expect(r1.recalc.totalStake).toBe(800);
    expect(r1.recalc.totalReturn).toBe(1500); // A の 500 が的中(300×500/100)
    expect(r1.recalc.betCount).toBe(2);
    expect(r1.recalc.recoveryRate).toBeCloseTo(1.875, 10);
    // 差(再計算の回収率 − 分析時の回収率)が 0 でないこと(同じ値を比べる自明なテストにしない)
    expect(r1.recalc.recoveryRate! - r1.base.recoveryRate!).not.toBe(0);
  });

  it("回 2: 回ごとに独立。回 2 で ok なのは A だけ(B は failed)なので、分析時側の賭け金も A の 1,000 だけになる", () => {
    const { source, close } = basic();
    const r2 = roundOf(compute(source, close), 2);
    expect(r2.base.totalStake).toBe(1000);
    expect(r2.base.totalReturn).toBe(3000);
    expect(r2.base.recoveryRate).toBeCloseTo(3.0, 10);
    expect(r2.recalc.totalStake).toBe(400);
    expect(r2.recalc.totalReturn).toBe(600); // 02 は 2 着で複勝 150 円(150×400/100)
    expect(r2.recalc.recoveryRate).toBeCloseTo(1.5, 10);
  });

  it("件数: ok の数と対象の数(failed・skipped を含む行がある分析の数。行がない分析・地方は含まない)", () => {
    const { source, close } = basic();
    const c = compute(source, close);
    expect([roundOf(c, 1).okCount, roundOf(c, 1).targetCount]).toEqual([2, 3]); // ok: A・B / 対象: A・B・D
    expect([roundOf(c, 2).okCount, roundOf(c, 2).targetCount]).toEqual([1, 3]); // ok: A / 対象: A・B(failed)・D(skipped)
  });

  it("回の並びと、直前の回のリード(分)を持つ(5 分前=回 1、直前=回 2。サーバの定数から作る)", () => {
    const { source, close } = basic();
    const c = compute(source, close);
    expect(c!.rounds.map((r) => [r.round, r.leadMinutes])).toEqual([[1, 5], [2, 2]]);
  });
});

describe("computeCloseComparison: 集計対象の規則は本体の検証と同じ(最新の選択は全分析で行う)", () => {
  it("★同じレースで『古い分析が ok・新しい分析が failed』のとき、そのレースはどちらの側にも入らない(古い分析が最新に化けない)", () => {
    const analyses = [analysis(1, R1, { analyzedAt: "2026-07-05T04:00:00.000Z" }), analysis(2, R1, { analyzedAt: "2026-07-05T05:00:00.000Z" })];
    const rows = readRows(analyses, resultsOf(R1, true), [baseAllocation(1, [place("01", 1000)]), baseAllocation(2, [place("01", 2000)])]);
    const close: VerifyCloseRows = {
      meta: [closeMeta(1, 1, "ok"), closeMeta(2, 1, "failed")],
      bets: [closeBet(1, 1, "01", 500)],
    };
    const source = buildVerifySource(rows);
    // 前提: 本体の検証は新しい分析(id2)だけを数え、古い分析(id1)は上書きされた扱い
    const main = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central");
    expect(main.includedAnalysisCount).toBe(1);
    expect(main.supersededAnalysisCount).toBe(1);
    const r1 = roundOf(compute(source, close), 1);
    expect(r1.okCount).toBe(0);
    expect(r1.targetCount).toBe(1); // 行があるのは集計に入った id2(failed)
    expect(r1.base.totalStake).toBe(0);
    expect(r1.recalc.totalStake).toBe(0);
    expect(r1.base.betCount).toBe(0);
    expect(r1.recalc.betCount).toBe(0);
  });

  it("結果のないレース・先読みの疑いのある分析は、本体と同じく集計に入らない(件数にも賭け金にも)", () => {
    const suspect = analysis(2, R2, { historyCutoffDate: null, promptLookaheadGuarded: 0, analyzedAt: "2026-07-05T08:00:00.000Z", raceSnapshotJson: '{"race":{"startTime":"15:45"}}' });
    const analyses = [analysis(1, R1), suspect, analysis(3, R3)];
    const results = [...resultsOf(R1, true), ...resultsOf(R2, true)]; // R3 は結果なし
    const rows = readRows(analyses, results, [baseAllocation(1, [place("01", 1000)]), baseAllocation(2, [place("01", 2000)]), baseAllocation(3, [place("01", 4000)])]);
    const close: VerifyCloseRows = {
      meta: [closeMeta(1, 1, "ok"), closeMeta(2, 1, "ok"), closeMeta(3, 1, "ok")],
      bets: [closeBet(1, 1, "01", 500), closeBet(2, 1, "01", 600), closeBet(3, 1, "01", 700)],
    };
    const source = buildVerifySource(rows);
    const main = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central");
    expect(main.includedAnalysisCount).toBe(1);
    expect(main.excludedLookaheadSuspectCount).toBe(1);
    expect(main.excludedAnalysisCount).toBe(1);
    const r1 = roundOf(compute(source, close), 1);
    expect([r1.okCount, r1.targetCount]).toEqual([1, 1]);
    expect(r1.base.totalStake).toBe(1000);
    expect(r1.recalc.totalStake).toBe(500);
  });
});

describe("computeCloseComparison: 本体の検証との一致", () => {
  it("全分析が ok で、再計算の買い目が分析時と同一なら、分析時側・再計算側とも本体の配分ベースの回収率(overall)と一致する(的中・外れ・返還を含む)", () => {
    const analyses = [analysis(1, R1), analysis(2, R2), analysis(3, R3)];
    const results = [
      ...resultsOf(R1, true),
      ...resultsOf(R2, false),
      // R3: 3 番が取消(返還になる買い目)
      ...resultsOf(R3, true),
      { raceId: R3, umaban: 3, finishPosition: null, placePayout: null, winPayout: null, scratched: 1 },
    ];
    const bets1 = [place("01", 1000), place("02", 300)];
    const bets2 = [place("01", 2000)];
    const bets3 = [place("01", 500), place("03", 700)];
    const rows = readRows(analyses, results, [baseAllocation(1, bets1), baseAllocation(2, bets2), baseAllocation(3, bets3)]);
    const close: VerifyCloseRows = {
      meta: [closeMeta(1, 1, "ok"), closeMeta(2, 1, "ok"), closeMeta(3, 1, "ok")],
      bets: [
        ...bets1.map((b) => closeBet(1, 1, b.comboKey, b.stake)),
        ...bets2.map((b) => closeBet(2, 1, b.comboKey, b.stake)),
        ...bets3.map((b) => closeBet(3, 1, b.comboKey, b.stake)),
      ],
    };
    const source = buildVerifySource(rows);
    const overall = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central").proposedBet.overall;
    // 前提(空振り防止): 賭け金が正で、的中・外れ・返還がそろっている
    expect(overall.totalStake).toBe(4500);
    expect(overall.refundedCount).toBe(1);
    expect(overall.totalReturn).toBeGreaterThan(overall.refundedStake);
    expect(overall.totalReturn).toBeLessThan(overall.totalStake * 2);
    const r1 = roundOf(compute(source, close), 1);
    for (const side of [r1.base, r1.recalc]) {
      expect(side).toEqual({ betCount: overall.betCount, totalStake: overall.totalStake, totalReturn: overall.totalReturn, recoveryRate: overall.recoveryRate });
    }
    expect(r1.okCount).toBe(3);
    expect(r1.targetCount).toBe(3);
  });
});

describe("computeCloseComparison: 退化した入力", () => {
  it("再計算の行が 1 つも無ければ null(比較なし)", () => {
    const { source } = basic();
    expect(compute(source, { meta: [], bets: [] })).toBeNull();
  });

  it("ok が 0 件の回は、件数 0・賭け数 0・回収率 null(0 除算にしない)。対象の件数は出る", () => {
    const { source } = basic();
    const close: VerifyCloseRows = { meta: [closeMeta(1, 1, "failed"), closeMeta(2, 2, "skipped")], bets: [] };
    const c = compute(source, close);
    const r1 = roundOf(c, 1);
    expect([r1.okCount, r1.targetCount]).toEqual([0, 1]);
    expect(r1.base).toEqual({ betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null });
    expect(r1.recalc).toEqual({ betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null });
    // 回 2 は行が 1 つ(分析 2)で ok なし。行のない回 1・回 2 とも一覧に出る
    expect(c!.rounds).toHaveLength(2);
    expect([roundOf(c, 2).okCount, roundOf(c, 2).targetCount]).toEqual([0, 1]);
  });

  it("定義にない回(3 など)の行は無視する(回の一覧は 1・2 のまま、件数にも入らない)", () => {
    const { source } = basic();
    const close: VerifyCloseRows = { meta: [closeMeta(1, 1, "ok"), closeMeta(1, 3, "ok")], bets: [closeBet(1, 1, "01", 500), closeBet(1, 3, "01", 999)] };
    const c = compute(source, close);
    expect(c!.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(roundOf(c, 1).recalc.totalStake).toBe(500);
    expect([roundOf(c, 2).okCount, roundOf(c, 2).targetCount]).toEqual([0, 0]);
  });

  it("status が ok なのに route が NULL の行は、配分なしとして扱う(ok の件数にも賭け金にも入れない。対象には数える)", () => {
    const { source } = basic();
    const close: VerifyCloseRows = { meta: [closeMeta(1, 1, "ok", { route: null })], bets: [closeBet(1, 1, "01", 500)] };
    const r1 = roundOf(compute(source, close), 1);
    expect([r1.okCount, r1.targetCount]).toEqual([0, 1]);
    expect(r1.recalc.totalStake).toBe(0);
    expect(r1.base.totalStake).toBe(0);
  });

  it("ok だが見送り(skip_reason_code あり・買い目なし)の分析は、ok の件数に数え、賭け金には入らない", () => {
    const { source } = basic();
    const close: VerifyCloseRows = {
      meta: [closeMeta(1, 1, "ok"), closeMeta(2, 1, "ok", { skipReasonCode: "no-positive-ev" })],
      bets: [closeBet(1, 1, "01", 500)],
    };
    const r1 = roundOf(compute(source, close), 1);
    expect([r1.okCount, r1.targetCount]).toEqual([2, 2]);
    expect(r1.recalc.totalStake).toBe(500); // B は見送り
    expect(r1.recalc.betCount).toBe(1);
    expect(r1.base.totalStake).toBe(3000); // 分析時側は、同じ 2 分析(A・B)の配分
  });

  it("比較の値は、入力の読み取り口を書き換えない(2 回呼んで同じ結果)", () => {
    const { source, close } = basic();
    const first = compute(source, close);
    const second = compute(source, close);
    expect(second).toEqual(first);
    expect(roundOf(first, 1).base.totalStake).toBe(3000);
  });
});
