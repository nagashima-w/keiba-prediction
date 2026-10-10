import { describe, expect, it } from "vitest";

import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { buildRaceSnapshot } from "../../packages/app/src/main/analysis-export";
import { estimateFairWinOdds } from "../../packages/core/src/ev/win-odds-estimate";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";
import { scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #247: `GET /api/analyses/{id}` の応答に、馬ごとの勝率(`winProb`)・想定単勝オッズ(`fairWinOdds`)・分析時点の実際の単勝オッズ(`winOdds`)と、
 * オッズの状態(`race.oddsStatus`)を載せる。想定は D1 の `adjustedProb` から配分と同じ関数(`estimateFairWinOdds`)で、実際は R2 の raceSnapshot から。
 */

function horse(umaban: number, over: Partial<StoredAnalysisHorse> = {}): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [], ...over };
}

const RACE = { raceName: "テストステークス", courseType: "芝", distance: 1800, weather: "晴", trackCondition: "良", startTime: "15:45", fence: "A", oddsStatus: "result", officialDatetime: "2026-06-28 15:00" };

function analysis(over: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: null,
    rawResponse: null,
    raceSnapshot: { race: RACE, horses: [] },
    historyCutoffDate: "20260627",
    ...over,
  } as StoredAnalysis;
}

function detail(a: StoredAnalysis, status: DetailStatus): AnalysisDetailResult {
  return { analysis: a, detail: status, llmNote: null, llmCalls: null };
}

/** 12頭の典型的な補正後の3着内率(Σp=2.88。固定馬が出ない)。 */
const PROBS = [0.55, 0.45, 0.38, 0.33, 0.28, 0.24, 0.2, 0.17, 0.12, 0.08, 0.05, 0.03];
const twelve = (over: (i: number) => Partial<StoredAnalysisHorse> = () => ({})): StoredAnalysisHorse[] =>
  PROBS.map((p, i) => horse(i + 1, { prior: p, adjustedProb: p, ...over(i) }));
const snapshotWith = (winOdds: (umaban: number) => unknown, oddsStatus: string | null = "result"): unknown => ({
  race: { ...RACE, oddsStatus },
  horses: PROBS.map((_, i) => ({ umaban: i + 1, name: `馬${i + 1}`, winOdds: winOdds(i + 1) })),
});

describe("buildAnalysisView の想定単勝オッズ・実際の単勝オッズ(Issue #247)", () => {
  it("想定は D1 の adjustedProb だけから計算する(詳細〈R2〉の状態に依らない)。配分と同じ関数 estimateFairWinOdds の値と一致し、Σ勝率=1・均等ではない", () => {
    const hs = twelve();
    const expected = estimateFairWinOdds(hs.map((h) => ({ umaban: h.umaban, placeProb: h.adjustedProb })));
    expect(expected.every((e) => e.fairWinOdds !== null && e.winProb !== null)).toBe(true); // 前提: 判定可能な入力
    for (const status of ["present", "missing", "none"] as const) {
      const view = buildAnalysisView(detail(analysis({ horses: hs, raceSnapshot: snapshotWith(() => 5) }), status), undefined);
      expect(view.horses.map((h) => h.winProb), status).toEqual(expected.map((e) => e.winProb));
      expect(view.horses.map((h) => h.fairWinOdds), status).toEqual(expected.map((e) => e.fairWinOdds));
    }
    const probs = buildAnalysisView(detail(analysis({ horses: hs }), "present"), undefined).horses.map((h) => h.winProb!);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Math.max(...probs) - Math.min(...probs)).toBeGreaterThan(0.1);
  });

  it("実際の単勝オッズは raceSnapshot の winOdds。馬を取り違えない。oddsStatus も載せる", () => {
    const view = buildAnalysisView(detail(analysis({ horses: twelve(), raceSnapshot: snapshotWith((u) => u * 1.5 + 1, "middle") }), "present"), undefined);
    expect(view.horses.map((h) => h.winOdds)).toEqual(PROBS.map((_, i) => (i + 1) * 1.5 + 1));
    expect(view.race.oddsStatus).toBe("middle");
  });

  it.each([["missing"], ["none"]] as const)("詳細が %s: 実際(winOdds)と oddsStatus は null。想定は出る(スナップショットが入っていても使わない)", (status) => {
    const view = buildAnalysisView(detail(analysis({ horses: twelve(), raceSnapshot: snapshotWith(() => 7) }), status), undefined);
    expect(view.horses).toHaveLength(12);
    expect(view.horses.every((h) => h.winOdds === null)).toBe(true);
    expect(view.race.oddsStatus).toBeNull();
    expect(view.horses.every((h) => h.fairWinOdds !== null)).toBe(true);
  });

  it("実際のオッズの欠損・不正は null(未確定 null・文字列・NaN・Infinity・1.0 未満・0・負・オブジェクト・未定義)。1.0 ちょうどは有効", () => {
    const bad: Record<number, unknown> = { 1: null, 2: "5.0", 3: Number.NaN, 4: Number.POSITIVE_INFINITY, 5: 0.9, 6: 0, 7: -3, 8: { odds: 5 }, 9: undefined, 10: 1.0, 11: 1.5, 12: 999.9 };
    const view = buildAnalysisView(detail(analysis({ horses: twelve(), raceSnapshot: snapshotWith((u) => bad[u]) }), "present"), undefined);
    expect(view.horses.map((h) => h.winOdds)).toEqual([null, null, null, null, null, null, null, null, null, 1.0, 1.5, 999.9]);
    // 想定は実際の欠損に影響されない
    expect(view.horses.every((h) => h.fairWinOdds !== null)).toBe(true);
  });

  it("スナップショットに無い馬は winOdds が null", () => {
    const snap = { race: RACE, horses: [{ umaban: 1, name: "a", winOdds: 3.2 }] };
    const view = buildAnalysisView(detail(analysis({ horses: twelve(), raceSnapshot: snap }), "present"), undefined);
    expect(view.horses[0]!.winOdds).toBe(3.2);
    expect(view.horses).toHaveLength(12);
    expect(view.horses.slice(1).every((h) => h.winOdds === null)).toBe(true);
  });

  it("3着内率が 0 の馬は winProb=0・fairWinOdds=null(Infinity にしない)。JSON にしても値が残る", () => {
    const view = buildAnalysisView(detail(analysis({ horses: twelve((i) => (i >= 10 ? { adjustedProb: 0 } : {})) }), "present"), undefined);
    expect(view.horses[11]!.winProb).toBe(0);
    expect(view.horses[11]!.fairWinOdds).toBeNull();
    expect(view.horses[0]!.fairWinOdds).not.toBeNull();
    expect(JSON.parse(JSON.stringify(view)).horses[11].winProb).toBe(0);
  });

  it("判定不能(頭数が3頭)は全馬 winProb・fairWinOdds が null(例外を投げない)", () => {
    const view = buildAnalysisView(detail(analysis({ horses: [horse(1), horse(2), horse(3)] }), "present"), undefined);
    expect(view.horses).toHaveLength(3); // 前提
    expect(view.horses.every((h) => h.winProb === null && h.fairWinOdds === null)).toBe(true);
  });

  it("不正な adjustedProb(NaN)が混ざっても例外を投げず、全馬の想定は null", () => {
    const view = buildAnalysisView(detail(analysis({ horses: twelve((i) => (i === 0 ? { adjustedProb: Number.NaN } : {})) }), "present"), undefined);
    expect(view.horses).toHaveLength(12);
    expect(view.horses.every((h) => h.winProb === null && h.fairWinOdds === null)).toBe(true);
  });

  it("馬 0 頭は空配列(例外を投げない)", () => {
    expect(buildAnalysisView(detail(analysis(), "present"), undefined).horses).toEqual([]);
  });

  it("書き込み側との drift: 実フィクスチャ(16頭)の buildRaceSnapshot を通すと、全頭の winOdds が race.odds.win と一致し、想定が全頭に付く", async () => {
    const { race } = await scrapeFixtureRace();
    const snapshot = JSON.parse(JSON.stringify(buildRaceSnapshot(race))) as unknown;
    const horses = race.horses.map((h, i) => horse(h.shutuba.umaban, { prior: 0.5 - i * 0.025, adjustedProb: 0.5 - i * 0.025 }));
    const view = buildAnalysisView(detail(analysis({ horses, raceSnapshot: snapshot }), "present"), undefined);
    const expected = race.horses.map((h) => race.odds.win[h.shutuba.umaban]?.odds ?? null);
    expect(view.horses).toHaveLength(16);
    expect(expected.some((o) => o !== null)).toBe(true); // 前提(空振り防止)
    expect(view.horses.map((h) => h.winOdds)).toEqual(expected.map((o) => (o !== null && o >= 1 ? o : null)));
    expect(view.horses.every((h) => h.fairWinOdds !== null)).toBe(true);
    expect(view.race.oddsStatus).toBe(race.odds.oddsStatus);
  });
});
