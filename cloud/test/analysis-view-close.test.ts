import { describe, expect, it } from "vitest";
import type { StoredAllocation, StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import type { StoredCloseRound } from "../src/analysis-close";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult } from "../src/analysis-repository";

/**
 * Issue #338(#335-A1): `GET /api/analyses/{id}` の `close`(締切の直前の再計算の、2 回ぶんの結果)。回ごとに状態・時刻・遅れ・配分(分析時の提案と同じ形)・差分を返す。
 * 結果が無い(旧い分析・表が無い間)は null(キーは常にある)。
 */

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

function detail(): AnalysisDetailResult {
  const analysis = {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1), horse(2), horse(3)],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: null,
    rawResponse: null,
    raceSnapshot: null,
    historyCutoffDate: null,
  } as StoredAnalysis;
  return { analysis, detail: "none", llmNote: null, llmCalls: null };
}

const BASE: StoredAllocation = {
  route: "mixed",
  unavailableReason: null,
  fallbackReason: null,
  skipReasonCode: null,
  bankroll: 10000,
  perRaceCap: 3000,
  kellyFraction: 0.25,
  evThreshold: 1.1,
  includeComboOdds: true,
  includeWide: true,
  includeTrio: false,
  includeQuinella: null,
  includeExacta: true,
  includeTrifecta: false,
  includeBracketQuinella: null,
  betUnit: 100,
  oddsStatus: "middle",
  bets: [
    { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
    { betType: "wide", comboKey: "0102", stake: 200, odds: 6.5, ev: 1.3 },
    { betType: "win", comboKey: "03", stake: 100, odds: 9, ev: 1.15 },
  ],
};

const sorted = (o: object): string[] => Object.keys(o).sort();

function okRound(round: number, allocation: StoredAllocation): StoredCloseRound {
  return { round, status: "ok", reason: null, dueAt: "2026-06-28T06:40:00.000Z", firedAt: "2026-06-28T06:40:02.000Z", lateMs: 2000, oddsOfficialDatetime: "2026-06-28 15:41:00", allocation };
}

describe("buildAnalysisView の close(Issue #338)", () => {
  it("結果が無ければ null(省略・空配列とも)。キーは常にある", () => {
    expect(buildAnalysisView(detail(), BASE).close).toBeNull();
    expect(buildAnalysisView(detail(), BASE, []).close).toBeNull();
    expect("close" in buildAnalysisView(detail(), undefined)).toBe(true);
  });

  it("ok の回: 状態・時刻・遅れ・リード(分)・配分(分析時の提案と同じキーの集合)・差分(追加・削除・賭け金の変化)を返す", () => {
    const after: StoredAllocation = {
      ...BASE,
      oddsStatus: "middle",
      bets: [
        { betType: "place", comboKey: "01", stake: 500, odds: 1.7, ev: 1.1 }, // 賭け金の変化 300 → 500
        { betType: "wide", comboKey: "0102", stake: 200, odds: 5.9, ev: 1.25 }, // 賭け金は同じ(オッズだけ動いた) = 変化なし
        { betType: "exacta", comboKey: "0301", stake: 100, odds: 40, ev: 1.4 }, // 追加
        // win:03 は削除
      ],
    };
    const view = buildAnalysisView(detail(), BASE, [okRound(1, after)]);
    expect(view.close).not.toBeNull();
    const round = view.close!.rounds[0]!;
    expect(round).toMatchObject({ round: 1, leadMinutes: 5, status: "ok", reason: null, dueAt: "2026-06-28T06:40:00.000Z", firedAt: "2026-06-28T06:40:02.000Z", lateMs: 2000, oddsOfficialDatetime: "2026-06-28 15:41:00" });
    expect(sorted(round)).toEqual(["allocation", "diff", "dueAt", "firedAt", "lateMs", "leadMinutes", "oddsOfficialDatetime", "reason", "round", "status"]);
    // 配分は分析時の提案と同じ形(キーの集合が同じ)
    expect(sorted(round.allocation!)).toEqual(sorted(view.allocation!));
    expect(round.allocation!.bets.map((b) => `${b.betType}:${b.comboKey}:${b.stake}`)).toEqual(["place:01:500", "wide:0102:200", "exacta:0301:100"]);
    // 差分(前提: 追加・削除・変化・不変が各 1 件ずつ。退化していない)
    expect(round.diff).toMatchObject({ unchanged: 1, hasChange: true, totalStakeBefore: 600, totalStakeAfter: 800 });
    expect(round.diff!.added.map((b) => b.comboKey)).toEqual(["0301"]);
    expect(round.diff!.removed.map((b) => b.comboKey)).toEqual(["03"]);
    expect(round.diff!.changed.map((c) => [c.comboKey, c.beforeStake, c.afterStake])).toEqual([["01", 300, 500]]);
    expect(sorted(round.diff!)).toEqual(["added", "changed", "hasChange", "removed", "totalStakeAfter", "totalStakeBefore", "unchanged"]);
  });

  it("2 回ぶんは回の昇順(5 分前 → 2 分前〈暫定〉)。差分は、どちらも分析時の提案との比較", () => {
    const view = buildAnalysisView(detail(), BASE, [okRound(2, { ...BASE, bets: [] }), okRound(1, BASE)]);
    expect(view.close!.rounds.map((r) => [r.round, r.leadMinutes])).toEqual([[1, 5], [2, 2]]);
    expect(view.close!.rounds[0]!.diff).toMatchObject({ hasChange: false, unchanged: 3 });
    expect(view.close!.rounds[1]!.diff).toMatchObject({ hasChange: true, totalStakeAfter: 0, totalStakeBefore: 600 });
    expect(view.close!.rounds[1]!.diff!.removed).toHaveLength(3);
  });

  it("failed・skipped の回は、理由つきで配分・差分なし", () => {
    const failed: StoredCloseRound = { round: 1, status: "failed", reason: "blocked", dueAt: "a", firedAt: "b", lateMs: 5, oddsOfficialDatetime: null, allocation: null };
    const skipped: StoredCloseRound = { round: 2, status: "skipped", reason: "too-late", dueAt: "a", firedAt: "b", lateMs: 9, oddsOfficialDatetime: null, allocation: null };
    const view = buildAnalysisView(detail(), BASE, [failed, skipped]);
    expect(view.close!.rounds.map((r) => [r.round, r.status, r.reason, r.allocation, r.diff])).toEqual([
      [1, "failed", "blocked", null, null],
      [2, "skipped", "too-late", null, null],
    ]);
  });

  it("分析時の提案の行が無い(配分なし)ときは、ok の回でも差分は null(配分は返す)", () => {
    const view = buildAnalysisView(detail(), undefined, [okRound(1, BASE)]);
    expect(view.allocation).toBeNull();
    expect(view.close!.rounds[0]!.allocation).not.toBeNull();
    expect(view.close!.rounds[0]!.diff).toBeNull();
  });

  it("知らない回の番号は leadMinutes が null(回の定数にない値を、リードの分数に偽らない)", () => {
    const view = buildAnalysisView(detail(), BASE, [okRound(9, BASE)]);
    expect(view.close!.rounds[0]!.leadMinutes).toBeNull();
  });
});
