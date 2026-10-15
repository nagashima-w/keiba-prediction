import { describe, expect, it } from "vitest";
import type { AnalysisDetail, AnalysisHorse } from "../client/api-analysis";
import { buildRaceModel } from "../client/race";
import { buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #317: 印を補修した馬の表示。「直」の目印と「元の印→今の印」を、結果画面の3か所に出す。
 *  - 馬のカード(印の横)  - 「印の付いた馬」の一覧  - 3着内率の上位5頭の行(「直」だけ)
 * 補修していない馬(markFrom が null・キー無し)の表示は、これまでと1文字も変わらない。
 */

const RACE_ID = "202603020211";
const route = { date: "20260628", venue: "central" as const, race: null, analysis: 7, settings: false };

function horse(umaban: number, mark: string | null, markFrom: string | null | undefined, adjustedProb = 0.18): AnalysisHorse {
  return {
    umaban,
    name: `馬${umaban}`,
    prior: 0.2,
    adjustedProb,
    placeOddsMin: 1.8,
    ev: 1.05,
    isPositive: false,
    mark,
    ...(markFrom === undefined ? {} : { markFrom }),
    reason: null,
    highlights: [],
    concerns: [],
    winProb: null,
    fairWinOdds: null,
    winOdds: null,
    fairPlaceOdds: null,
    actualPlaceOddsMin: null,
    actualPlaceOddsMax: null,
  };
}

function analysis(horses: AnalysisHorse[], over: Partial<AnalysisDetail> = {}): AnalysisDetail {
  return {
    id: 7,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: "claude-x",
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: "result", placeBasis: "top3" },
    horses,
    allocation: null,
    detail: "present",
    ...over,
  } as AnalysisDetail;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const rawTextOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(rawTextOf).join(""));
const resultTree = (a: AnalysisDetail): VNode => renderScreen(buildResultModel({ route, source: { kind: "ready", analysis: a } }), noopActions);

// 1番: 補修していない◎、2番: ◎→〇、3番: 印なし→◎ではなく ▲(なし→▲)、4番: ☆→印なし(印が消えた)、5番: 不明な印→印なし
const HORSES = [horse(1, "◎", null, 0.5), horse(2, "〇", "◎", 0.4), horse(3, "▲", "なし", 0.3), horse(4, null, "☆", 0.2), horse(5, null, "不明", 0.1), horse(6, null, undefined, 0.05)];

describe("buildResultModel: 補修した馬の表示データ", () => {
  const cards = () => {
    const model = buildResultModel({ route, source: { kind: "ready", analysis: analysis(HORSES) } });
    if (model.content === null) throw new Error("前提: 内容がある");
    return model.content;
  };

  it("馬のカード: 補修した馬は「元の印→今の印」を持つ。補修していない馬(null・キー無し)は null", () => {
    expect(cards().horses.map((c) => [c.umaban, c.markRepair])).toEqual([
      [1, null],
      [2, "◎→〇"],
      [3, "印なし→▲"],
      [4, "☆→印なし"],
      [5, "不明な印→印なし"],
      [6, null],
    ]);
  });

  it("「印の付いた馬」の一覧: 印が付いている馬の行だけが「元の印→今の印」を持つ(印が消えた馬は一覧に出ない)", () => {
    expect(cards().markedHorses.map((m) => [m.umaban, m.mark, m.markRepair])).toEqual([
      [1, "◎", null],
      [2, "〇", "◎→〇"],
      [3, "▲", "印なし→▲"],
    ]);
  });

  it("上位5頭の行: 補修した馬は repaired:true。印が消えた馬(4・5番)も上位5頭に入れば true(「直」だけを出す)", () => {
    const rows = cards().topProbs!.rows;
    expect(rows.map((r) => [r.umaban, r.repaired])).toEqual([
      [1, false],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
    ]);
  });

  it("補修していない分析(全馬 markFrom なし)は、すべて null・false(これまでと同じ)", () => {
    const model = buildResultModel({ route, source: { kind: "ready", analysis: analysis([horse(1, "◎", undefined), horse(2, "〇", null)]) } });
    const c = model.content!;
    expect(c.horses.every((x) => x.markRepair === null)).toBe(true);
    expect(c.markedHorses.every((x) => x.markRepair === null)).toBe(true);
    expect(c.topProbs!.rows.every((r) => !r.repaired)).toBe(true);
  });
});

describe("結果画面の VNode: 「直」と元の印", () => {
  it("馬のカード: 補修した馬の印の横に「直」と「元の印→今の印」(class mark-fixed)。補修していない馬には出ない", () => {
    const fixed = byClass(resultTree(analysis(HORSES)), "horse").flatMap((card) => byClass(card, "mark-fixed").map((n) => rawTextOf(n)));
    expect(fixed).toEqual(["直 ◎→〇", "直 印なし→▲", "直 ☆→印なし", "直 不明な印→印なし"]);
  });

  it("「印の付いた馬」の行: 補修した行だけ「◎ 3 馬名 直 元→今」の形で出る。補修していない行のテキストは、これまでと同じ", () => {
    const rows = byClass(byClass(resultTree(analysis(HORSES)), "marked-horses")[0]!, "marked").map(rawTextOf);
    expect(rows).toEqual(["◎ 1 馬1", "〇 2 馬2 直 ◎→〇", "▲ 3 馬3 直 印なし→▲"]);
  });

  it("上位5頭の行: 補修した馬には「直」だけ(元の印は出さない)", () => {
    const rows = byClass(resultTree(analysis(HORSES)), "top-prob");
    expect(rows).toHaveLength(5);
    const fixed = rows.map((r) => byClass(r, "mark-fixed").map(rawTextOf));
    expect(fixed).toEqual([[], ["直"], ["直"], ["直"], ["直"]]);
  });

  it("発走前のカードの中の結果(開いたとき)にも、同じ表示が出る(contentOf を共有)", () => {
    const rows = [
      { raceId: RACE_ID, mode: "morning", status: "done", attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: true, analysisId: null },
      { raceId: RACE_ID, mode: "pre_race", status: "done", attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: 7 },
    ] as const;
    const tree = renderScreen(
      buildRaceModel({
        route: { date: "20260628", venue: "central", race: RACE_ID, analysis: null, settings: false },
        status: { kind: "ready", rows: [...rows], prior: null },
        past: { kind: "ready", analyses: [] },
        listRow: undefined,
        result: { kind: "ready", analysis: analysis(HORSES) },
        resultOpen: true,
      }),
      noopActions,
    );
    expect(byClass(tree, "mark-fixed").length).toBeGreaterThanOrEqual(4);
  });

  it("目印の文言は固定: 外から来た文字列(LLM の生の文字列)は、元の印としては出ない。語彙の外の markFrom は model に届く前に捨てられる前提で、ここでは「直」+固定の語だけ", () => {
    const text = rawTextOf(resultTree(analysis(HORSES)));
    expect(text).toContain("直 ◎→〇");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });
});
