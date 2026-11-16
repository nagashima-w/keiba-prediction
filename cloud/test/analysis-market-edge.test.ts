import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { attachMarketEdge, loadMarketEdge, type MarketEdgeReader } from "../src/analysis-market-edge";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";
import type { MarketEdgeForRace, MarketEdgeMeta } from "../src/market-edge-repository";

/**
 * Issue #643: `GET /api/analyses/{id}` の馬ごとの `marketEdge`(騎手・調教師の指標)と、分析ごとの `marketEdgeNote`(注記の文)。
 * ID は分析の記録(`raceSnapshot`)から直接読む(core の `toSafeRaceSnapshot` は ID を捨てる)。名前は出馬表の書き方(`jockeyName`・`trainerName`)。
 * 列が出ない条件(地方・詳細なし・記録なし・読み出しの失敗・値が 1 つも無い)は、`marketEdgeNote` が null。
 */

const CENTRAL = "202603020211";
const NAR = "202644062911";

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

type SnapHorse = Record<string, unknown>;
const snapHorse = (umaban: number, extra: SnapHorse = {}): SnapHorse => ({ umaban, name: `馬${umaban}`, jockeyName: `騎${umaban}`, jockeyId: `J${umaban}`, trainerName: `厩${umaban}`, trainerId: `T${umaban}`, ...extra });

function result(snapHorses: SnapHorse[], opts: { raceId?: string; status?: DetailStatus; snapshot?: unknown } = {}): AnalysisDetailResult {
  const analysis = {
    id: 7,
    raceId: opts.raceId ?? CENTRAL,
    analyzedAt: "2026-11-16T05:00:00.000Z",
    horses: snapHorses.map((h) => horse(h["umaban"] as number)),
    evEstimated: false,
    promptVersion: "x",
    additionalInstruction: null,
    kaisaiDate: "20261116",
    model: null,
    rawResponse: null,
    raceSnapshot: opts.snapshot === undefined ? { race: { raceName: "テスト" }, horses: snapHorses } : opts.snapshot,
    historyCutoffDate: "20261115",
  } as StoredAnalysis;
  return { analysis, detail: opts.status ?? "present", llmNote: null, llmCalls: null };
}

const META: MarketEdgeMeta = { computedOn: "2026-11-16", windowFrom: "2024-11-16", windowTo: "2026-11-15", coef: [1, 1, 1], converged: true, iterations: 7, races: 6929, horses: 95233 };

function reader(data: { jockeys?: [string, number, number][]; trainers?: [string, number, number][]; meta?: MarketEdgeMeta | null }, calls: { args: (readonly string[])[][] } = { args: [] }): MarketEdgeReader {
  const toMap = (rows: [string, number, number][] = []) => new Map(rows.map(([id, n, edge]) => [id, { n, edge }]));
  return {
    async readForRace(jockeyIds, trainerIds): Promise<MarketEdgeForRace> {
      calls.args.push([jockeyIds, trainerIds]);
      return { jockeys: toMap(data.jockeys), trainers: toMap(data.trainers), meta: data.meta === undefined ? META : data.meta, rowsRead: 0 };
    },
  };
}

const viewOf = (r: AnalysisDetailResult) => buildAnalysisView(r, undefined);

describe("loadMarketEdge / attachMarketEdge(Issue #643)", () => {
  it("ID で引いた値と件数を馬ごとに付ける。名前は分析の記録の騎手名・調教師名(出馬表の書き方)", async () => {
    const r = result([snapHorse(1), snapHorse(2)]);
    const loaded = await loadMarketEdge(reader({ jockeys: [["J1", 312, 0.03], ["J2", 20, -0.0125]], trainers: [["T1", 80, 0.0449], ["T2", 49, 0]] }), r);
    expect(loaded).not.toBeNull();
    const view = attachMarketEdge(viewOf(r), loaded);
    expect(view.horses.map((h) => h.marketEdge)).toEqual([
      { jockey: { name: "騎1", edge: 0.03, n: 312 }, trainer: { name: "厩1", edge: 0.0449, n: 80 } },
      { jockey: { name: "騎2", edge: -0.0125, n: 20 }, trainer: { name: "厩2", edge: 0, n: 49 } },
    ]);
    expect(typeof view.marketEdgeNote).toBe("string");
  });

  it("ID を持たない馬・指標の表に無い人は、名前は残して値と件数が null(名前での引き当てはしない)", async () => {
    const r = result([snapHorse(1, { jockeyId: undefined }), snapHorse(2), snapHorse(3, { trainerId: null, jockeyName: "<b>騎3</b>" })]);
    const loaded = await loadMarketEdge(reader({ jockeys: [["J1", 999, 0.5], ["J2", 100, 0.01], ["J3", 100, 0.02]], trainers: [["T1", 10, 0.01]] }), r);
    const view = attachMarketEdge(viewOf(r), loaded);
    const me = view.horses.map((h) => h.marketEdge);
    expect(me[0], "騎手 ID なし(J1 が表にあっても、名前では引かない)").toEqual({ jockey: { name: "騎1", edge: null, n: null }, trainer: { name: "厩1", edge: 0.01, n: 10 } });
    expect(me[1], "調教師 T2 は表に無い").toEqual({ jockey: { name: "騎2", edge: 0.01, n: 100 }, trainer: { name: "厩2", edge: null, n: null } });
    expect(me[2], "調教師 ID が null。名前の文字列はそのまま(エスケープはクライアントがテキストノードで)").toEqual({ jockey: { name: "<b>騎3</b>", edge: 0.02, n: 100 }, trainer: { name: "厩3", edge: null, n: null } });
  });

  it("D1 に束縛する ID は、スナップショットの騎手 ID・調教師 ID(重複なし、順序は馬の順。種別を取り違えない)", async () => {
    const calls = { args: [] as (readonly string[])[][] };
    const r = result([snapHorse(1, { jockeyId: "JJ" }), snapHorse(2, { jockeyId: "JJ", trainerId: "TT" }), snapHorse(3, { jockeyId: "" })]);
    await loadMarketEdge(reader({ jockeys: [["JJ", 100, 0.01]] }, calls), r);
    expect(calls.args).toEqual([[["JJ"], ["T1", "TT", "T3"]]]);
  });

  it("★地方のレースは、D1 を読まず列ごと出さない(marketEdgeNote が null)", async () => {
    const calls = { args: [] as (readonly string[])[][] };
    const r = result([snapHorse(1)], { raceId: NAR });
    expect(await loadMarketEdge(reader({ jockeys: [["J1", 100, 0.01]] }, calls), r)).toBeNull();
    expect(calls.args, "前提: 読んでいない").toEqual([]);
    const view = attachMarketEdge(viewOf(r), null);
    expect(view.marketEdgeNote).toBeNull();
    expect(view.horses.map((h) => h.marketEdge)).toEqual([null]);
  });

  it("詳細が present でない(スナップショットを使わない分析)は、D1 を読まず列を出さない", async () => {
    const calls = { args: [] as (readonly string[])[][] };
    const r = result([snapHorse(1)], { status: "missing" });
    expect(await loadMarketEdge(reader({ jockeys: [["J1", 100, 0.01]] }, calls), r)).toBeNull();
    expect(calls.args).toEqual([]);
  });

  it("指標の記録(meta)が無い・値が 1 つも付かない・スナップショットが壊れているときも、列を出さない", async () => {
    const r = result([snapHorse(1)]);
    expect(await loadMarketEdge(reader({ jockeys: [["J1", 100, 0.01]], meta: null }), r), "meta なし").toBeNull();
    expect(await loadMarketEdge(reader({ jockeys: [["J9", 100, 0.01]] }), r), "どの馬の ID も表に無い").toBeNull();
    expect(await loadMarketEdge(reader({ jockeys: [["J1", 100, 0.01]] }), result([snapHorse(1)], { snapshot: "壊れた" })), "スナップショットが文字列").toBeNull();
    expect(await loadMarketEdge(reader({ jockeys: [["J1", 100, 0.01]] }), result([snapHorse(1)], { snapshot: null })), "スナップショットが null").toBeNull();
  });

  it("非有限の値・負の件数は、その人の値なし(null)にする", async () => {
    const r = result([snapHorse(1), snapHorse(2)]);
    const loaded = await loadMarketEdge(reader({ jockeys: [["J1", 100, Number.NaN], ["J2", -1, 0.02]], trainers: [["T1", 100, 0.01]] }), r);
    const me = attachMarketEdge(viewOf(r), loaded).horses.map((h) => h.marketEdge);
    expect(me[0]!.jockey).toEqual({ name: "騎1", edge: null, n: null });
    expect(me[1]!.jockey).toEqual({ name: "騎2", edge: null, n: null });
    expect(me[0]!.trainer.edge, "前提: 他の値は残る").toBe(0.01);
  });

  it("★読み出しが失敗(throw)しても投げない: null(列を出さない。応答の本体は壊れない)", async () => {
    const failing: MarketEdgeReader = {
      async readForRace(): Promise<MarketEdgeForRace> {
        throw new Error("D1 が落ちた(この文面は返さない)");
      },
    };
    expect(await loadMarketEdge(failing, result([snapHorse(1)]))).toBeNull();
  });

  it("注記の文: 参考(確かめ中)・分析に使っていない・窓の期間・計算日・意味(ポイント)・件数が少ない人は 0 に寄せる・分析の時点の値でない", async () => {
    const r = result([snapHorse(1)]);
    const note = attachMarketEdge(viewOf(r), await loadMarketEdge(reader({ jockeys: [["J1", 100, 0.01]] }), r)).marketEdgeNote!;
    for (const part of ["参考(確かめ中)", "分析(LLM・配分)には使っていません", "2024-11-16〜2026-11-15", "2026-11-16", "単勝オッズから見込まれる3着内の確率", "ポイント", "0 に寄せ", "分析した時点の値ではありません"]) {
      expect(note, part).toContain(part);
    }
  });

  it("attachMarketEdge は元の view を変えない。null を渡すと、全馬 marketEdge が null・marketEdgeNote が null", async () => {
    const r = result([snapHorse(1)]);
    const base = viewOf(r);
    const before = JSON.stringify(base);
    const withEdge = attachMarketEdge(base, await loadMarketEdge(reader({ jockeys: [["J1", 100, 0.01]] }), r));
    expect(JSON.stringify(base), "元は変わらない").toBe(before);
    expect(withEdge.horses[0]!.marketEdge, "前提: 付いている").not.toBeNull();
    expect(attachMarketEdge(base, null).horses.map((h) => h.marketEdge)).toEqual([null]);
  });
});
