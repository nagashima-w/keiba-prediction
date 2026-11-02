import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import type { AnalysisDetail } from "../client/api-analysis";
import type { DomDocument } from "../client/dom";
import { buildRaceModel } from "../client/race";
import { buildResultModel } from "../client/result";
import type { Route } from "../client/route";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";
import { mount } from "./support/dom-mount";

/**
 * Issue #571: レース画面・結果画面のパンくず(見出しの上)と前後のレース(見出しの下)の VNode。
 * モデル(純関数。client-race.test・client-result.test)→ VNode の写し間違い(出し忘れ・位置・属性)と、外から来た文字列(競馬場名)がテキストノードだけになること。
 */

const RACE_ID = "202603020211";
const ROUTE: Route = { date: "20260628", venue: "central", race: RACE_ID, analysis: null, settings: false };

const listRow = (raceId: string, venueName: string | null = "福島"): RaceRow => ({ raceId, venueName, raceNumber: Number(raceId.slice(10)), raceName: `R${raceId.slice(10)}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: null });
const SIBLINGS = ["202603020210", RACE_ID, "202603020212"].map((id) => listRow(id));

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const rawTextOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(rawTextOf).join(""));
const navOf = (tree: VNode, label: string): VNode | undefined => findAll(tree, (n) => n.tag === "nav" && n.attrs?.["aria-label"] === label)[0];
/** 画面の直下の子の並び順での位置(見出し h1・パンくず・前後・最初のカードなど)。 */
const indexOf = (tree: VNode, pred: (n: VNode) => boolean): number => (tree.children ?? []).findIndex((c) => typeof c !== "string" && pred(c));
const isH1 = (n: VNode): boolean => n.tag === "h1";
const isNav = (label: string) => (n: VNode): boolean => n.tag === "nav" && n.attrs?.["aria-label"] === label;

function mountAll(tree: VNode): { tags: string[]; texts: string[] } {
  const tags: string[] = [];
  const texts: string[] = [];
  const doc: DomDocument = {
    createElement: (tag) => {
      tags.push(tag);
      return { setAttribute() {}, appendChild() {}, addEventListener() {} };
    },
    createTextNode: (text) => {
      texts.push(text);
      return {};
    },
  };
  mount(doc, { replaceChildren() {} }, tree);
  return { tags, texts };
}

const raceTree = (over: Parameters<typeof buildRaceModel>[0] extends infer I ? Partial<I> : never = {}): VNode =>
  renderScreen(buildRaceModel({ route: ROUTE, status: { kind: "ready", rows: [], prior: null }, past: { kind: "ready", analyses: [] }, listRow: listRow(RACE_ID), siblings: SIBLINGS, ...over }), noopActions);

function analysis(over: Partial<AnalysisDetail> = {}): AnalysisDetail {
  return {
    id: 7,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: "result", placeBasis: "top3" },
    horses: [],
    allocation: null,
    detail: "present",
    ...over,
  };
}
const RESULT_ROUTE: Route = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false };
/** `siblings` は null で「一覧が無い」(省略時の既定値と区別するため)。 */
const resultTree = (siblings: readonly RaceRow[] | null = SIBLINGS, a: AnalysisDetail = analysis()): VNode =>
  renderScreen(buildResultModel({ route: RESULT_ROUTE, source: { kind: "ready", analysis: a }, ...(siblings === null ? {} : { siblings }) }), noopActions);

describe("レース画面: パンくず", () => {
  it("見出し(h1)の上に nav(aria-label=パンくず)。一覧(#)と日付(その日の一覧)はリンク、競馬場はリンクなしの文字、R は現在地(aria-current=page・リンクなし)", () => {
    const tree = raceTree();
    const crumbs = navOf(tree, "パンくず");
    expect(crumbs, "前提: パンくずが出る").toBeDefined();
    expect(findAll(crumbs!, (n) => n.tag === "a").map((a) => [rawTextOf(a), a.attrs?.["href"]])).toEqual([
      ["一覧", "#"],
      ["6/28(日)", "#date=20260628&venue=central"],
    ]);
    const current = findAll(crumbs!, (n) => n.attrs?.["aria-current"] !== undefined);
    expect(current).toHaveLength(1);
    expect(current[0]!.attrs?.["aria-current"]).toBe("page");
    expect(rawTextOf(current[0]!)).toBe("11R");
    expect(current[0]!.tag, "現在地はリンクにしない").not.toBe("a");
    expect(rawTextOf(crumbs!)).toBe("一覧›6/28(日)›福島›11R");
    expect(indexOf(tree, isNav("パンくず"))).toBeGreaterThanOrEqual(0);
    expect(indexOf(tree, isNav("パンくず")), "見出しより上").toBeLessThan(indexOf(tree, isH1));
  });

  it("区切りの「›」は読み上げない(aria-hidden)", () => {
    const seps = findAll(navOf(raceTree(), "パンくず")!, (n) => rawTextOf(n) === "›");
    expect(seps.length, "区切りは 3 つ(4 節の間)").toBe(3);
    expect(seps.every((s) => s.attrs?.["aria-hidden"] === "true")).toBe(true);
  });

  it("「一覧へ戻る」は残る", () => {
    const back = findAll(raceTree(), (n) => n.tag === "a" && rawTextOf(n) === "一覧へ戻る");
    expect(back).toHaveLength(1);
    expect(back[0]!.attrs?.["href"]).toBe("#date=20260628&venue=central");
  });

  it("一覧が無くてもパンくずは出る(前後は出ない)", () => {
    const tree = raceTree({ siblings: undefined, listRow: undefined });
    expect(navOf(tree, "パンくず")).toBeDefined();
    expect(navOf(tree, "前後のレース")).toBeUndefined();
  });

  it("競馬場名は外から来た文字列: 要素・属性にならず、テキストノードのまま(許可リストのアダプタが投げない)", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const tree = raceTree({ listRow: listRow(RACE_ID, evil) });
    const { tags, texts } = mountAll(tree);
    expect(tags).not.toContain("img");
    expect(texts).toContain(evil);
  });
});

describe("レース画面: 前後のレース", () => {
  it("見出しの下・最初のカードの上に nav(aria-label=前後のレース)。「前のレース 10R」「次のレース 12R」は前後のレース画面へのリンク", () => {
    const tree = raceTree();
    const nav = navOf(tree, "前後のレース");
    expect(nav, "前提: 前後が出る").toBeDefined();
    expect(findAll(nav!, (n) => n.tag === "a").map((a) => [rawTextOf(a), a.attrs?.["href"]])).toEqual([
      ["前のレース 10R", "#date=20260628&venue=central&race=202603020210"],
      ["次のレース 12R", "#date=20260628&venue=central&race=202603020212"],
    ]);
    const at = indexOf(tree, isNav("前後のレース"));
    expect(at, "見出しの下").toBeGreaterThan(indexOf(tree, isH1));
    expect(at, "カード(section)の上").toBeLessThan(indexOf(tree, (n) => n.tag === "section"));
  });

  it("端では、その側のリンクを出さない", () => {
    const first = raceTree({ route: { ...ROUTE, race: "202603020210" }, listRow: listRow("202603020210") });
    const links = findAll(navOf(first, "前後のレース")!, (n) => n.tag === "a").map(rawTextOf);
    expect(links).toEqual(["次のレース 11R"]);
    const last = raceTree({ route: { ...ROUTE, race: "202603020212" }, listRow: listRow("202603020212") });
    expect(findAll(navOf(last, "前後のレース")!, (n) => n.tag === "a").map(rawTextOf)).toEqual(["前のレース 11R"]);
  });

  it("前後が無いとき(1 レースだけ・一覧が無い)は nav ごと出さない", () => {
    expect(navOf(raceTree({ siblings: [listRow(RACE_ID)] }), "前後のレース")).toBeUndefined();
    expect(navOf(raceTree({ siblings: undefined }), "前後のレース")).toBeUndefined();
  });

  it("閲覧者でも出る", () => {
    expect(navOf(raceTree({ readOnly: true }), "前後のレース")).toBeDefined();
  });
});

describe("結果画面: パンくずと前後のレース", () => {
  it("パンくずは見出し(h1)の上、前後は見出しの下。前後の行き先はレース画面(analysis を持たない)", () => {
    const tree = resultTree();
    const crumbs = navOf(tree, "パンくず");
    expect(crumbs).toBeDefined();
    expect(rawTextOf(crumbs!)).toBe("一覧›6/28(日)›福島›11R");
    const nav = navOf(tree, "前後のレース");
    expect(nav, "前提: 前後が出る").toBeDefined();
    expect(findAll(nav!, (n) => n.tag === "a").map((a) => a.attrs?.["href"])).toEqual(["#date=20260628&venue=central&race=202603020210", "#date=20260628&venue=central&race=202603020212"]);
    const h1 = indexOf(tree, isH1);
    expect(indexOf(tree, isNav("パンくず"))).toBeGreaterThanOrEqual(0);
    expect(indexOf(tree, isNav("パンくず"))).toBeLessThan(h1);
    expect(indexOf(tree, isNav("前後のレース"))).toBeGreaterThan(h1);
  });

  it("「戻る」は残る。一覧が無いときは前後だけ出ない", () => {
    const tree = resultTree(null);
    expect(findAll(tree, (n) => n.tag === "a" && rawTextOf(n) === "戻る")).toHaveLength(1);
    expect(navOf(tree, "パンくず")).toBeDefined();
    expect(navOf(tree, "前後のレース")).toBeUndefined();
  });

  it("読み込み中・失敗のときは、どちらも出さない", () => {
    for (const source of [{ kind: "loading" }, { kind: "error", message: "失敗" }] as const) {
      const tree = renderScreen(buildResultModel({ route: RESULT_ROUTE, source, siblings: SIBLINGS }), noopActions);
      expect(navOf(tree, "パンくず")).toBeUndefined();
      expect(navOf(tree, "前後のレース")).toBeUndefined();
    }
  });

  it("競馬場名はテキストノードのまま", () => {
    const evil = "<script>alert(1)</script>";
    const { tags, texts } = mountAll(resultTree(SIBLINGS, analysis({ race: { ...analysis().race, venueName: evil } })));
    expect(tags).not.toContain("script");
    expect(texts).toContain(evil);
  });
});
