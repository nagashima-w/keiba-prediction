import { describe, expect, it } from "vitest";
import { CLOSE_BASIS_LABELS, CLOSE_COMPARISON_DESCRIPTION, computeCloseComparison, type CloseComparison, type VerifyCloseBetRow, type VerifyCloseMetaRow, type VerifyCloseRows } from "../src/verify-close";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyReadRows, type VerifyResultRow } from "../src/verify-read";

/**
 * Issue #379(#335-N): 検証画面の「締切直前の再計算との比較」を、地方を含めて区分(all・central・nar)ごとに計算し、**取り直しの基準**(`closeComboBasis`)で行を分ける。
 *  - refetched: 組合せも取り直した/組合せなしの配分(中央の全部、地方の組合せ OFF)
 *  - analysis: 単勝・複勝だけ取り直し、組合せは分析時のオッズの混成の配分(地方の組合せ ON)
 * 基準の判定は、場(race_id)と、分析時の組合せ設定(`comboOnIds`=分析時の配分メタの `include_combo_odds` が 1 の分析 id)から。**失敗・行わなかった回の分析にも基準が付く**(メタの値は ok の回にしか無いので使わない)。
 * 旧い `nar-unsupported` の行(Issue #338 の時点で書かれた、地方の skipped)は、仕組みが無かった時点のものなので、分母に数えない。
 */

const C1 = "202606030801";
const N1 = "202644071411";
const N2 = "202644071412";
const N3 = "202644071409";
const N4 = "202644071410";

function analysis(id: number, raceId: string): VerifyAnalysisRow {
  return {
    id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
  };
}
/** 1 番は hit なら 1 着(複勝 300 円)、miss なら 5 着。2 番は常に 2 着(複勝 150 円)。 */
function resultsOf(raceId: string, hit: boolean): VerifyResultRow[] {
  return [
    { raceId, umaban: 1, finishPosition: hit ? 1 : 5, placePayout: hit ? 300 : null, winPayout: null },
    { raceId, umaban: 2, finishPosition: 2, placePayout: 150, winPayout: null },
  ];
}
const placeBet = (analysisId: number, key: string, stake: number) => ({ analysisId, betType: "place", comboKey: key, stake });
const closeMeta = (analysisId: number, round: number, status: string, over: Partial<VerifyCloseMetaRow> = {}): VerifyCloseMetaRow => ({
  analysisId, round, status, route: status === "ok" ? "place-only" : null, skipReasonCode: null, reason: null, ...over,
});
const closeBet = (analysisId: number, round: number, key: string, stake: number): VerifyCloseBetRow => ({ analysisId, round, betType: "place", comboKey: key, stake });

/**
 *  id1  (中央・C1・的中): 分析時 01 に 1,000(払戻 3,000)。回 1 ok [01 に 500]・回 2 ok [01 に 800]
 *  id10 (地方・N1・的中・組合せ ON): 分析時 01 に 2,000(払戻 6,000)。回 1 ok [01 に 1,000]
 *  id11 (地方・N2・外れ・組合せ OFF): 分析時 01 に 400。回 1 ok [02 に 300](2 着。払戻 450)
 *  id12 (地方・N3・的中): 分析時 01 に 50。回 1・2 とも skipped(旧 nar-unsupported)
 *  id13 (地方・N4・的中・組合せ ON): 分析時 01 に 70。回 1 failed(combo-missing)
 */
function fixture(extraMeta: VerifyCloseMetaRow[] = []): { source: ReturnType<typeof buildVerifySource>; close: VerifyCloseRows; comboOnIds: ReadonlySet<number> } {
  const analyses = [analysis(1, C1), analysis(10, N1), analysis(11, N2), analysis(12, N3), analysis(13, N4)];
  const rows: VerifyReadRows = {
    analyses,
    horses: analyses.map((a) => ({ analysisId: a.id, umaban: 1, prior: 0.5, adjusted_prob: 0.5, place_odds_min: 2, ev: 1.2, is_positive: 1, contributions_json: null, mark: "◎", reason: null, highlights_json: null, concerns_json: null })),
    results: [...resultsOf(C1, true), ...resultsOf(N1, true), ...resultsOf(N2, false), ...resultsOf(N3, true), ...resultsOf(N4, true)],
    allocationMeta: analyses.map((a) => ({ analysisId: a.id, route: "place-only", skipReasonCode: null })),
    bets: [placeBet(1, "01", 1000), placeBet(10, "01", 2000), placeBet(11, "01", 400), placeBet(12, "01", 50), placeBet(13, "01", 70)],
    comboPayouts: [], comboImports: [],
  };
  const close: VerifyCloseRows = {
    meta: [
      closeMeta(1, 1, "ok"), closeMeta(1, 2, "ok"),
      closeMeta(10, 1, "ok"),
      closeMeta(11, 1, "ok"),
      closeMeta(12, 1, "skipped", { reason: "nar-unsupported" }), closeMeta(12, 2, "skipped", { reason: "nar-unsupported" }),
      closeMeta(13, 1, "failed", { reason: "combo-missing" }),
      ...extraMeta,
    ],
    bets: [closeBet(1, 1, "01", 500), closeBet(1, 2, "01", 800), closeBet(10, 1, "01", 1000), closeBet(11, 1, "02", 300)],
  };
  return { source: buildVerifySource(rows), close, comboOnIds: new Set([10, 13]) };
}

type Venue = "all" | "central" | "nar";
const compute = (venue: Venue, f = fixture()): CloseComparison | null => computeCloseComparison(f.source, f.close, { venue, comboOnIds: f.comboOnIds });
function row(c: CloseComparison | null, round: number, basis: "refetched" | "analysis") {
  if (c === null) throw new Error("比較が null");
  const r = c.rounds.find((x) => x.round === round && x.basis === basis);
  if (r === undefined) throw new Error(`回 ${round}・${basis} の行がない`);
  return r;
}
const keys = (c: CloseComparison | null): string[] => (c === null ? [] : c.rounds.map((r) => `${r.round}:${r.basis}`));

describe("区分ごとの比較(Issue #379)", () => {
  it("中央: 中央の分析(id1)だけが入り、地方の分析・行は一切入らない。基準は refetched の行だけ", () => {
    const c = compute("central");
    expect(keys(c)).toEqual(["1:refetched", "2:refetched"]);
    const r1 = row(c, 1, "refetched");
    expect([r1.okCount, r1.targetCount]).toEqual([1, 1]);
    expect(r1.base).toMatchObject({ totalStake: 1000, totalReturn: 3000 });
    expect(r1.recalc).toMatchObject({ totalStake: 500, totalReturn: 1500 });
  });

  it("地方: 組合せ OFF(id11)と組合せ ON(id10・id13)が別の行になる。それぞれの賭け金・払戻は、その基準の分析だけ", () => {
    const c = compute("nar");
    expect(keys(c)).toEqual(["1:refetched", "1:analysis", "2:refetched"]);
    const off = row(c, 1, "refetched");
    expect([off.okCount, off.targetCount]).toEqual([1, 1]); // id11 だけ。id12(旧 nar-unsupported)は入らない
    expect(off.base).toMatchObject({ totalStake: 400, totalReturn: 0, betCount: 1 });
    expect(off.recalc).toMatchObject({ totalStake: 300, totalReturn: 450, betCount: 1 });
    const on = row(c, 1, "analysis");
    expect([on.okCount, on.targetCount]).toEqual([1, 2]); // ok: id10 / 対象: id10 と、failed(combo-missing)の id13
    expect(on.base).toMatchObject({ totalStake: 2000, totalReturn: 6000 });
    expect(on.recalc).toMatchObject({ totalStake: 1000, totalReturn: 3000 });
    // 前提(空振り防止): 2 つの基準で数値が違う(取り違えを検出できる)
    expect(off.base.totalStake).not.toBe(on.base.totalStake);
  });

  it("全体: refetched は中央 + 地方の OFF の合計、analysis は地方の ON だけ(区分のタブに従う)", () => {
    const c = compute("all");
    expect(keys(c)).toEqual(["1:refetched", "1:analysis", "2:refetched"]);
    const refetched = row(c, 1, "refetched");
    expect([refetched.okCount, refetched.targetCount]).toEqual([2, 2]);
    expect(refetched.base).toMatchObject({ totalStake: 1400, totalReturn: 3000 });
    expect(refetched.recalc).toMatchObject({ totalStake: 800, totalReturn: 1950 });
    expect(row(c, 1, "analysis").base).toMatchObject({ totalStake: 2000, totalReturn: 6000 });
  });

  it("基準ごとの行ラベル: analysis は「組合せは分析時のオッズ」、refetched は null(サーバが渡し、クライアントは足すだけ)", () => {
    expect(CLOSE_BASIS_LABELS).toEqual({ refetched: null, analysis: "組合せは分析時のオッズ" });
    const c = compute("nar");
    expect(row(c, 1, "analysis").basisLabel).toBe("組合せは分析時のオッズ");
    expect(row(c, 1, "refetched").basisLabel).toBeNull();
  });

  it("旧い nar-unsupported の行は分母に数えない(行を消した場合と、地方の比較がまったく同じ)", () => {
    const withLegacy = fixture();
    const without = fixture();
    const filtered: VerifyCloseRows = { meta: without.close.meta.filter((m) => m.reason !== "nar-unsupported"), bets: without.close.bets };
    expect(withLegacy.close.meta.length - filtered.meta.length).toBe(2); // 前提: 本当に旧い行が 2 つあった
    expect(compute("nar", withLegacy)).toEqual(compute("nar", { ...without, close: filtered }));
    // 旧い行(id12。組合せ OFF の地方の分析)を数えていれば、対象は 2 になる。1 であることが、除いている証拠
    expect(row(compute("nar", withLegacy), 1, "refetched").targetCount).toBe(1);
  });

  it("理由が nar-unsupported でない地方の skipped(too-late など)は、通常どおり対象に数える", () => {
    const f = fixture([closeMeta(11, 2, "skipped", { reason: "too-late" })]);
    const r2 = row(compute("nar", f), 2, "refetched");
    expect([r2.okCount, r2.targetCount]).toEqual([0, 1]);
  });

  it("どの回も少なくとも 1 行は出る(対象が無い回は refetched の 0 件の行)。analysis の行は、対象があるときだけ", () => {
    const c = compute("nar");
    const r2 = row(c, 2, "refetched");
    expect([r2.okCount, r2.targetCount]).toEqual([0, 0]);
    expect(keys(c)).not.toContain("2:analysis");
    // 組合せ ON の地方だけのデータでは、refetched の行は(対象 0 のときは)出さず、analysis の行が出る
    const onlyOn: VerifyCloseRows = { meta: [closeMeta(10, 1, "ok")], bets: [closeBet(10, 1, "01", 1000)] };
    const f = fixture();
    expect(keys(compute("nar", { ...f, close: onlyOn }))).toEqual(["1:analysis", "2:refetched"]);
  });

  it("その区分に対象が 1 つも無ければ null(地方の行が無い状態で地方のタブ。再計算の行が無い状態)", () => {
    const f = fixture();
    const centralOnly: VerifyCloseRows = { meta: [closeMeta(1, 1, "ok")], bets: [closeBet(1, 1, "01", 500)] };
    expect(compute("nar", { ...f, close: centralOnly })).toBeNull();
    expect(compute("central", { ...f, close: centralOnly })).not.toBeNull(); // 前提: 中央には対象がある
    expect(compute("all", { ...f, close: { meta: [], bets: [] } })).toBeNull();
  });

  it("説明文はサーバが持つ(クライアントの束に日本語を置かない)。区分のタブに従うこと・混成の行が別の比較であること・旧い地方の分析が入らないことを述べる", () => {
    const c = compute("nar");
    expect(c!.description).toBe(CLOSE_COMPARISON_DESCRIPTION);
    expect(CLOSE_COMPARISON_DESCRIPTION).toContain("区分のタブに合わせて");
    expect(CLOSE_COMPARISON_DESCRIPTION).toContain("組合せは分析時のオッズ");
    expect(CLOSE_COMPARISON_DESCRIPTION).not.toContain("中央のレースだけ");
    expect(CLOSE_COMPARISON_DESCRIPTION).not.toContain("区分のタブには依りません");
  });
});
