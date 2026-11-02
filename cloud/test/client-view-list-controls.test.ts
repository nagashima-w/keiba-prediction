import { describe, expect, it, vi } from "vitest";
import { buildListModel, type ListModelInput } from "../client/list";
import { parseHash } from "../client/route";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #560: 一覧の上の並び(controls)を、役割で 2 つの塊に分ける。
 *  - 一覧の絞り込み(`div.list-filters`): 開催日・中央/地方・更新
 *  - 画面の移動(`nav.list-nav`): 狙い目・検証・日報・月報・設定
 * リンクのクラス名・href・並び順は変えない(既存のテストが完全一致で探す)。
 */

const DATE = "20261102";
const ROUTE = parseHash(`#date=${DATE}&venue=central`, DATE);
const NOW = new Date("2026-11-02T02:00:00Z");

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const classOf = (n: VNode): string => String(n.attrs?.["class"] ?? "");
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(""));

function tree(over: Partial<ListModelInput> = {}, actions: ViewActions = noopActions): VNode {
  const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: [] }, board: { kind: "none" }, now: NOW, ...over });
  return renderScreen(model, actions);
}
const controlsOf = (t: VNode): VNode => t.children![0] as VNode;
/** 塊が無いとき(Red)は、TypeError ではなく「ちょうど 1 つ」の失敗にする。 */
function only(found: VNode[], what: string): VNode {
  expect(found, what).toHaveLength(1);
  return found[0]!;
}
const filtersOf = (t: VNode): VNode => only(findAll(t, (n) => n.tag === "div" && classOf(n) === "list-filters"), "div.list-filters");
const navOf = (t: VNode): VNode => only(findAll(t, (n) => n.tag === "nav" && classOf(n) === "list-nav"), "nav.list-nav");
const LINK_CLASSES = ["targets-link", "verify-link", "report-link", "monthly-link", "settings-link"];
const linksOf = (n: VNode): VNode[] => findAll(n, (x) => x.tag === "a");

describe("一覧の上の並び: 2 つの塊(Issue #560)", () => {
  it("controls の直下の子は、絞り込み(div.list-filters)と画面の移動(nav.list-nav)のちょうど 2 つで、この順", () => {
    const c = controlsOf(tree());
    expect(classOf(c)).toBe("controls"); // 前提: 画面の先頭が controls
    const kids = (c.children ?? []).map((k) => (typeof k === "string" ? k : `${k.tag}.${classOf(k)}`));
    expect(kids).toEqual(["div.list-filters", "nav.list-nav"]);
  });

  it("絞り込み: role=group・aria-label=一覧の絞り込み。中身は 開催日(label.date の中に date の入力)・中央/地方(nav.tabs)・更新 の順", () => {
    const f = filtersOf(tree());
    expect(f.attrs?.["role"]).toBe("group");
    expect(f.attrs?.["aria-label"]).toBe("一覧の絞り込み");
    const kids = (f.children ?? []).map((k) => (typeof k === "string" ? k : `${k.tag}.${classOf(k)}`));
    expect(kids).toEqual(["label.date", "nav.tabs", "button.refresh"]);
    expect(findAll(f, (n) => n.tag === "input" && n.attrs?.["type"] === "date")).toHaveLength(1);
    expect(findAll(f, (n) => n.tag === "nav" && n.attrs?.["aria-label"] === "中央・地方").flatMap(linksOf).map(textOf)).toEqual(["中央", "地方"]);
  });

  it("画面の移動: aria-label=画面の移動。リンクは 狙い目・検証・日報・月報・設定 の順で、クラス・href・文言は従来どおり", () => {
    const n = navOf(tree());
    expect(n.attrs?.["aria-label"]).toBe("画面の移動");
    expect(linksOf(n).map((a) => [classOf(a), a.attrs?.["href"], textOf(a)])).toEqual([
      ["targets-link", `#targets=${DATE}`, "狙い目"],
      ["verify-link", "#verify", "検証"],
      ["report-link", "#report", "日報"],
      ["monthly-link", expect.stringMatching(/^#report=\d{6}$/), "月報"],
      ["settings-link", "#settings", "設定"],
    ]);
  });

  it("取り違えがない: 5 つのリンクは絞り込みの中に無く、日付の入力・中央/地方・更新は画面の移動の中に無い", () => {
    const t = tree();
    // 前提: 5 つのリンクと、絞り込みの 3 つが、どちらも画面にある
    expect(findAll(t, (x) => LINK_CLASSES.includes(classOf(x)))).toHaveLength(5);
    expect(findAll(filtersOf(t), (x) => LINK_CLASSES.includes(classOf(x)))).toHaveLength(0);
    expect(findAll(navOf(t), (x) => x.tag === "input" || x.tag === "button" || classOf(x) === "tabs" || classOf(x) === "date")).toHaveLength(0);
  });

  it("閲覧者(readOnly)は設定のリンクが無い 4 つ。月報の行き先が無いモデル(now を省く)は月報が無い。どちらも塊は残る", () => {
    const viewer = tree({ readOnly: true });
    expect(linksOf(navOf(viewer)).map(classOf)).toEqual(["targets-link", "verify-link", "report-link", "monthly-link"]);
    const noNow = tree({ now: undefined });
    expect(linksOf(navOf(noNow)).map(classOf)).toEqual(["targets-link", "verify-link", "report-link", "settings-link"]);
    filtersOf(noNow); // 塊が残る(ちょうど 1 つ)
  });

  it("読み込み中の更新ボタンは絞り込みの中で「読み込み中…」・disabled。通常は「更新」・押せる", () => {
    const loading = findAll(filtersOf(tree({ list: { kind: "loading" } })), (n) => n.tag === "button")[0]!;
    expect([textOf(loading), loading.attrs?.["disabled"]]).toEqual(["読み込み中…", true]);
    const idle = findAll(filtersOf(tree()), (n) => n.tag === "button")[0]!;
    expect([textOf(idle), idle.attrs?.["disabled"]]).toEqual(["更新", false]);
  });

  it("塊の中でも操作が生きる: 更新のクリックで onRefresh が 1 回、日付の change で onDateChange が値つきで 1 回", () => {
    const onRefresh = vi.fn();
    const onDateChange = vi.fn();
    const t = tree({}, { ...noopActions, onRefresh, onDateChange });
    const f = filtersOf(t);
    findAll(f, (n) => n.tag === "button")[0]!.on!.click!();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    findAll(f, (n) => n.tag === "input")[0]!.on!.change!("2026-11-03");
    expect(onDateChange).toHaveBeenCalledTimes(1);
    expect(onDateChange).toHaveBeenCalledWith("2026-11-03");
  });

  it("controls の直後は、これまでどおり次に発走するレースのカード(位置を保つ)", () => {
    const t = tree({
      list: { kind: "ready", races: [{ raceId: "202602020101", venueName: "福島", raceNumber: 1, raceName: "R1", courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: "12:00" }] },
    });
    expect(classOf(t.children![0] as VNode)).toBe("controls");
    expect(classOf(t.children![1] as VNode)).toBe("next-races");
  });
});
