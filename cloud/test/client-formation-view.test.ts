import { describe, expect, it } from "vitest";
import type { AnalysisDetail, AnalysisHorse, LegStyle } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { buildFormation } from "../client/formation-model";
import { buildRaceModel } from "../client/race";
import { buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #362(想定隊列図): 結果画面・発走前のカードの結果の VNode。
 * 節の位置(AI の展開予想のあと・「馬ごとの評価」の前)、出す条件、図の構造(列は data-slot)、凡例、許可リストで組み立てられること(canvas・style は使わない)。
 */

function horse(umaban: number, over: Partial<AnalysisHorse> = {}): AnalysisHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.3, adjustedProb: 0.25, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: 0.25, fairWinOdds: 3.2, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, earlyPos: null, legStyle: null, ...over };
}

const STYLES: LegStyle[] = ["逃げ", "先行", "差し", "追込"];
const four = (): AnalysisHorse[] => [1, 2, 3, 4].map((u) => horse(u, { legStyle: STYLES[u - 1]!, earlyPos: u / 5 }));

function analysis(horses: AnalysisHorse[] = four(), development: AnalysisDetail["development"] = null): AnalysisDetail {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テスト", grade: null, oddsStatus: "result", placeBasis: "top3", distance: 1800, turn: "right", pace: "平均" },
    development,
    horses,
    allocation: null,
    detail: "present",
  } as AnalysisDetail;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const classesOf = (n: VNode): string[] => (n.attrs?.["class"] ?? "").toString().split(" ");
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => classesOf(n).includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(""));

const ROUTE = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false } as const;
const view = (a: AnalysisDetail): VNode => renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a } }), noopActions);

describe("結果画面の想定隊列図の節(VNode)", () => {
  it("節は 1 つ。見出し・注記・想定ペースの行・局面ごとの見出しと軸と図。順は『3着内率の上位5頭』のあと・『馬ごとの評価』の前、AI の展開予想のあと", () => {
    const tree = view(analysis(four(), { text: "前が競る", pace: "ハイ" }));
    const sections = byClass(tree, "formation");
    expect(sections.length).toBe(1);
    const sec = sections[0]!;
    const f = buildFormation(analysis(four(), { text: "前が競る", pace: "ハイ" }))!;
    expect(textOf(findAll(sec, (n) => n.tag === "h2")[0]!)).toBe(f.heading);
    expect(byClass(sec, "formation-note").map(textOf)).toEqual([f.note]);
    expect(byClass(sec, "formation-pace").map(textOf)).toEqual([f.paceLine]);
    expect(byClass(sec, "formation-phase-title").map(textOf)).toEqual(["道中", "4コーナー"]);
    expect(byClass(sec, "formation-axis").map(textOf)).toEqual(["先頭後方", "先頭後方"]);
    expect(byClass(sec, "formation-track").length).toBe(2);
    const order = findAll(tree, (n) => n.tag === "section").map((n) => classesOf(n)[0]!);
    expect(order.indexOf("formation")).toBeGreaterThan(order.indexOf("top-probs"));
    expect(order.indexOf("formation")).toBeGreaterThan(order.indexOf("development"));
    expect(order.indexOf("formation")).toBeLessThan(order.indexOf("horses"));
  });

  it("図は role=img で aria-label に読み上げ文。チップは馬番だけで data-slot が列。◎の馬のチップだけ formation-main(強調)", () => {
    const horses = four().map((h) => (h.umaban === 3 ? { ...h, mark: "◎" } : h));
    const tree = view(analysis(horses));
    const f = buildFormation(analysis(horses))!;
    const tracks = byClass(tree, "formation-track");
    expect(tracks.map((t) => t.attrs?.["role"])).toEqual(["img", "img"]);
    expect(tracks.map((t) => t.attrs?.["aria-label"])).toEqual(f.phases.map((p) => p.ariaLabel));
    tracks.forEach((track, i) => {
      const chips = byClass(track, "formation-chip");
      expect(chips.map(textOf)).toEqual(f.phases[i]!.chips.map((c) => String(c.umaban)));
      expect(chips.map((c) => c.attrs?.["data-slot"])).toEqual(f.phases[i]!.chips.map((c) => String(c.slot)));
      expect(chips.filter((c) => classesOf(c).includes("formation-main")).map(textOf)).toEqual(["3"]);
    });
    // 前提: 4 頭・列が少なくとも 2 種類(全部同じ列では列の検証にならない)
    expect(new Set(f.phases[0]!.chips.map((c) => c.slot)).size).toBeGreaterThan(1);
  });

  it("凡例: 全馬の「馬番 馬名」(◎は先頭に◎)。馬名は外から来た文字列なのでテキストとして入る。位置を推定できない馬の行は、いるときだけ", () => {
    const horses = [...four().map((h) => (h.umaban === 2 ? { ...h, mark: "◎", name: "<b>x" } : h)), horse(5, { legStyle: null })];
    const tree = view(analysis(horses));
    const legend = byClass(tree, "formation-legend")[0]!;
    expect(findAll(legend, (n) => n.tag === "li").map(textOf)).toEqual(["1 馬1", "◎ 2 <b>x", "3 馬3", "4 馬4", "5 馬5"]);
    expect(byClass(tree, "formation-unknown").map(textOf)).toEqual(["位置を推定できない馬: 5"]);
    expect(byClass(view(analysis()), "formation-unknown").length).toBe(0);
  });

  it("脚質の分かる馬が 2 頭未満の分析(#314 より前の分析など)は節ごと出さない", () => {
    const old = [1, 2, 3, 4].map((u) => horse(u, { legStyle: u === 1 ? "逃げ" : null }));
    expect(byClass(view(analysis(old)), "formation").length).toBe(0);
  });

  it("勝率が判定不能(winProb が null)でも出る。再生の節・ボタン・canvas は出ない", () => {
    const tree = view(analysis(four().map((h) => ({ ...h, winProb: null }))));
    expect(byClass(tree, "formation").length).toBe(1);
    expect(byClass(tree, "replay").length).toBe(0);
    expect(findAll(tree, (n) => n.tag === "canvas").length).toBe(0);
    expect(findAll(tree, (n) => n.tag === "button" && classesOf(n).some((c) => c.startsWith("replay"))).length).toBe(0);
  });

  it("許可リスト(dom.ts)で組み立てられる: 使う要素は div・span・p・section・ul・li・h2・strong だけで canvas・style は使わない", () => {
    const tags = new Set<string>();
    const attrs = new Set<string>();
    const doc: DomDocument = {
      createElement: (tag) => {
        tags.add(tag);
        return { setAttribute: (n: string) => attrs.add(n), appendChild() {}, addEventListener() {} };
      },
      createTextNode: () => ({}),
    };
    mount(doc, { replaceChildren() {} }, byClass(view(analysis()), "formation")[0]!);
    expect([...tags].sort()).toEqual(["div", "h2", "li", "p", "section", "span", "strong", "ul"]);
    expect(attrs.has("style")).toBe(false);
    expect(attrs.has("data-slot")).toBe(true);
    expect(attrs.has("role")).toBe(true);
    expect(attrs.has("aria-label")).toBe(true);
  });
});

describe("発走前のカードの中の結果にも同じ節が出る", () => {
  it("レース画面の発走前のカード: 最新の分析の結果の中に『想定隊列図』の節(見出しはカードの下なので h3)", () => {
    const board = [{ raceId: "202603020211", mode: "pre_race", status: "done", attempts: 1, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: 7 }] as const;
    const model = buildRaceModel({
      route: { date: "20260628", venue: "central", race: "202603020211", analysis: null, settings: false },
      status: { kind: "ready", rows: board as never, prior: null },
      past: { kind: "ready", analyses: [] },
      listRow: undefined,
      result: { kind: "ready", analysis: analysis() },
    });
    const tree = renderScreen(model, noopActions);
    const sec = byClass(tree, "formation")[0]!;
    expect(sec).toBeDefined();
    expect(findAll(sec, (n) => n.tag === "h3").map(textOf)).toEqual(["想定隊列図"]);
    expect(byClass(sec, "formation-track").length).toBe(2);
  });
});
