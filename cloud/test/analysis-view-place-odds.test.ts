import { describe, expect, it } from "vitest";

import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { buildRaceSnapshot } from "../../packages/core/src/analysis/analysis-export";
import { estimateFairPlaceOdds } from "../../packages/core/src/ev/place-odds-estimate";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";
import { scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #253: `GET /api/analyses/{id}` の応答に、馬ごとの想定複勝オッズ(`fairPlaceOdds`)と分析時点の実際の複勝オッズの下限・上限
 * (`actualPlaceOddsMin`・`actualPlaceOddsMax`)、レースの想定の基準(`race.placeBasis`。top3=3着内率・top2=2着内率・null=出さない)を載せる。
 * 想定は D1 の `adjustedProb` から(`estimatePlaceOddsForRace`)、実際は R2 の raceSnapshot の馬の `placeOddsMin`・`placeOddsMax` から。
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

/** 12頭の典型的な補正後の3着内率(Σp=2.88)。 */
const TWELVE = [0.55, 0.45, 0.38, 0.33, 0.28, 0.24, 0.2, 0.17, 0.12, 0.08, 0.05, 0.03];
/** 6頭(Σp=3。複勝は2着まで)。 */
const SIX = [0.7, 0.6, 0.5, 0.5, 0.4, 0.3];

const horsesOf = (probs: readonly number[], over: (i: number) => Partial<StoredAnalysisHorse> = () => ({})): StoredAnalysisHorse[] =>
  probs.map((p, i) => horse(i + 1, { prior: p, adjustedProb: p, ...over(i) }));

/** 馬 i+1 の下限=1.5+i*0.5、上限=2.0+i*0.5(馬ごとに違う値で、下限と上限・馬の取り違えを検出する)。 */
const minOf = (umaban: number): number => 1 + umaban * 0.5;
const maxOf = (umaban: number): number => 1.6 + umaban * 0.5;
const snapshotFor = (n: number, place: (umaban: number) => { min?: unknown; max?: unknown } = (u) => ({ min: minOf(u), max: maxOf(u) }), oddsStatus: string | null = "result"): unknown => ({
  race: { ...RACE, oddsStatus },
  horses: Array.from({ length: n }, (_, i) => {
    const p = place(i + 1);
    return { umaban: i + 1, name: `馬${i + 1}`, winOdds: 5, placeOddsMin: p.min, ...("max" in p ? { placeOddsMax: p.max } : {}) };
  }),
});

describe("buildAnalysisView の想定複勝オッズ(Issue #253)", () => {
  it("12頭(8頭以上): race.placeBasis=top3。想定は 0.8 ÷ D1 の補正後の3着内率(詳細〈R2〉の状態に依らない)", () => {
    for (const status of ["present", "missing", "none"] as const) {
      const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE), raceSnapshot: snapshotFor(12) }), status), undefined);
      expect(view.race.placeBasis, status).toBe("top3");
      expect(view.horses.map((h) => h.fairPlaceOdds), status).toEqual(TWELVE.map((p) => 0.8 / p));
    }
  });

  it("6頭(5〜7頭): race.placeBasis=top2。想定は2着内率から(core の estimateFairPlaceOdds top2 と一致)で、3着内率から出した値より高い", () => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(SIX) }), "present"), undefined);
    expect(view.race.placeBasis).toBe("top2");
    const expected = estimateFairPlaceOdds(SIX.map((p, i) => ({ umaban: i + 1, placeProb: p })), "top2");
    expect(expected.every((e) => e.fairPlaceOdds !== null)).toBe(true); // 前提
    expect(view.horses.map((h) => h.fairPlaceOdds)).toEqual(expected.map((e) => e.fairPlaceOdds));
    for (let i = 0; i < SIX.length; i++) {
      expect(view.horses[i]!.fairPlaceOdds! - 0.8 / SIX[i]!).toBeGreaterThan(0.1);
    }
  });

  it.each([[1], [2], [3], [4]])("%d頭(複勝が発売されない): race.placeBasis=null。想定は全馬 null(例外を投げない)", (n) => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf([0.9, 0.7, 0.6, 0.5].slice(0, n)) }), "present"), undefined);
    expect(view.horses).toHaveLength(n); // 前提
    expect(view.race.placeBasis).toBeNull();
    expect(view.horses.every((h) => h.fairPlaceOdds === null)).toBe(true);
  });

  it("境界: 7頭は top2・8頭は top3(頭数が変わるだけで基準が切り替わる)", () => {
    const seven = buildAnalysisView(detail(analysis({ horses: horsesOf([0.9, 0.8, 0.5, 0.4, 0.2, 0.1, 0.1]) }), "present"), undefined);
    const eight = buildAnalysisView(detail(analysis({ horses: horsesOf([0.9, 0.8, 0.5, 0.4, 0.2, 0.1, 0.05, 0.05]) }), "present"), undefined);
    expect(seven.horses).toHaveLength(7);
    expect(eight.horses).toHaveLength(8);
    expect(seven.race.placeBasis).toBe("top2");
    expect(eight.race.placeBasis).toBe("top3");
  });

  it("馬 0 頭: placeBasis=null・馬は空配列(例外を投げない)", () => {
    const view = buildAnalysisView(detail(analysis(), "present"), undefined);
    expect(view.horses).toEqual([]);
    expect(view.race.placeBasis).toBeNull();
  });

  it("3着内率が 0 の馬は fairPlaceOdds=null(他の馬は出る)。1.0 倍未満になる馬(3着内率 90%)は 0.8/0.9 をそのまま返す(丸めない・1.0 に切り上げない)", () => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf([0.9, ...TWELVE.slice(1, 11), 0]) }), "present"), undefined);
    expect(view.horses[11]!.fairPlaceOdds).toBeNull();
    expect(view.horses[0]!.fairPlaceOdds).toBe(0.8 / 0.9);
    expect(view.horses[0]!.fairPlaceOdds!).toBeLessThan(1);
    expect(view.horses[1]!.fairPlaceOdds).not.toBeNull();
  });

  it("8頭以上で NaN の3着内率が混ざっても例外を投げず、その馬だけ null(馬ごとに独立)", () => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE, (i) => (i === 0 ? { adjustedProb: Number.NaN } : {})) }), "present"), undefined);
    expect(view.horses).toHaveLength(12);
    expect(view.horses[0]!.fairPlaceOdds).toBeNull();
    expect(view.horses.slice(1).every((h) => h.fairPlaceOdds !== null)).toBe(true);
  });

  it("5〜7頭で判定不能(固定馬2頭以上・NaN)は全馬 null。placeBasis は top2 のまま。例外を投げない", () => {
    for (const probs of [[0.99, 0.98, 0.3, 0.1, 0.05, 0.05], [Number.NaN, ...SIX.slice(1)]]) {
      const view = buildAnalysisView(detail(analysis({ horses: horsesOf(probs) }), "present"), undefined);
      expect(view.horses).toHaveLength(6);
      expect(view.race.placeBasis).toBe("top2");
      expect(view.horses.every((h) => h.fairPlaceOdds === null)).toBe(true);
    }
  });

  it("勝率・想定単勝オッズ(Issue #247)は変わらない(複勝を足しても単勝の値は同じ)", () => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE) }), "present"), undefined);
    expect(view.horses.every((h) => h.winProb !== null && h.fairWinOdds !== null)).toBe(true);
    expect(view.horses[0]!.fairWinOdds!).toBeGreaterThan(3.5);
    expect(view.horses[0]!.fairWinOdds!).toBeLessThan(3.8);
  });
});

describe("buildAnalysisView の実際の複勝オッズ(下限・上限。Issue #253)", () => {
  it("下限・上限は raceSnapshot の placeOddsMin・placeOddsMax。馬を取り違えず、下限と上限も取り違えない", () => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE), raceSnapshot: snapshotFor(12) }), "present"), undefined);
    expect(view.horses.map((h) => h.actualPlaceOddsMin)).toEqual(TWELVE.map((_, i) => minOf(i + 1)));
    expect(view.horses.map((h) => h.actualPlaceOddsMax)).toEqual(TWELVE.map((_, i) => maxOf(i + 1)));
    expect(view.horses[0]!.actualPlaceOddsMin).not.toBe(view.horses[0]!.actualPlaceOddsMax); // 前提
  });

  it.each([["missing"], ["none"]] as const)("詳細が %s: 下限・上限は null(スナップショットが入っていても使わない)。想定と placeBasis は出る", (status) => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE), raceSnapshot: snapshotFor(12) }), status), undefined);
    expect(view.horses).toHaveLength(12);
    expect(view.horses.every((h) => h.actualPlaceOddsMin === null && h.actualPlaceOddsMax === null)).toBe(true);
    expect(view.horses.every((h) => h.fairPlaceOdds !== null)).toBe(true);
    expect(view.race.placeBasis).toBe("top3");
  });

  it("上限のキーを持たない過去のスナップショットでも読める: 下限は出て、上限は null", () => {
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE), raceSnapshot: snapshotFor(12, (u) => ({ min: minOf(u) })) }), "present"), undefined);
    expect(view.horses.map((h) => h.actualPlaceOddsMin)).toEqual(TWELVE.map((_, i) => minOf(i + 1)));
    expect(view.horses.every((h) => h.actualPlaceOddsMax === null)).toBe(true);
  });

  it("欠損・不正は null(未確定 null・文字列・NaN・Infinity・1.0 未満・0・負・オブジェクト・未定義)。1.0 ちょうどは有効。下限と上限は独立に判定する", () => {
    const bad: Record<number, unknown> = { 1: null, 2: "5.0", 3: Number.NaN, 4: Number.POSITIVE_INFINITY, 5: 0.9, 6: 0, 7: -3, 8: { odds: 5 }, 9: undefined, 10: 1.0, 11: 1.5, 12: 999.9 };
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE), raceSnapshot: snapshotFor(12, (u) => ({ min: bad[u], max: bad[13 - u] })) }), "present"), undefined);
    const expectedMin = [null, null, null, null, null, null, null, null, null, 1.0, 1.5, 999.9];
    expect(view.horses.map((h) => h.actualPlaceOddsMin)).toEqual(expectedMin);
    expect(view.horses.map((h) => h.actualPlaceOddsMax)).toEqual([...expectedMin].reverse());
    // 想定は実際の欠損に影響されない
    expect(view.horses.every((h) => h.fairPlaceOdds !== null)).toBe(true);
  });

  it("スナップショットに無い馬は下限・上限が null", () => {
    const snap = { race: RACE, horses: [{ umaban: 1, name: "a", placeOddsMin: 1.5, placeOddsMax: 2.3 }] };
    const view = buildAnalysisView(detail(analysis({ horses: horsesOf(TWELVE), raceSnapshot: snap }), "present"), undefined);
    expect(view.horses[0]).toMatchObject({ actualPlaceOddsMin: 1.5, actualPlaceOddsMax: 2.3 });
    expect(view.horses).toHaveLength(12);
    expect(view.horses.slice(1).every((h) => h.actualPlaceOddsMin === null && h.actualPlaceOddsMax === null)).toBe(true);
  });

  it("書き込み側との drift: 実フィクスチャ(16頭)の buildRaceSnapshot を通すと、全頭の下限・上限が race.odds.place と一致する", async () => {
    const { race } = await scrapeFixtureRace();
    const snapshot = JSON.parse(JSON.stringify(buildRaceSnapshot(race))) as unknown;
    const horses = race.horses.map((h, i) => horse(h.shutuba.umaban, { prior: 0.5 - i * 0.025, adjustedProb: 0.5 - i * 0.025 }));
    const view = buildAnalysisView(detail(analysis({ horses, raceSnapshot: snapshot }), "present"), undefined);
    const place = (umaban: number) => race.odds.place[umaban];
    expect(view.horses).toHaveLength(16);
    const withMax = race.horses.filter((h) => place(h.shutuba.umaban)?.oddsMax != null);
    expect(withMax.length, "前提(空振り防止): 上限が取れている馬がいる").toBeGreaterThan(8);
    const valid = (v: number | null | undefined): number | null => (v != null && v >= 1 ? v : null);
    expect(view.horses.map((h) => h.actualPlaceOddsMin)).toEqual(race.horses.map((h) => valid(place(h.shutuba.umaban)?.oddsMin)));
    expect(view.horses.map((h) => h.actualPlaceOddsMax)).toEqual(race.horses.map((h) => valid(place(h.shutuba.umaban)?.oddsMax)));
    expect(view.horses.every((h) => h.fairPlaceOdds !== null)).toBe(true);
    expect(view.race.placeBasis).toBe("top3");
  });
});
