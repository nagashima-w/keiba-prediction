import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import type { DomDocument } from "../client/dom";
import { mount } from "./support/dom-mount";
import { buildListModel } from "../client/list";
import { parseHash } from "../client/route";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/** Issue #346: 一覧の発走済みのレース行は、`a.race` に `started` を足して薄く出す(見出し・要素は増えない)。並べ替えは VNode の子の順に出る。 */

const DATE = "20260628";
const NOW = new Date("2026-06-28T05:00:00Z"); // JST 14:00
const ROUTE = parseHash(`#date=${DATE}&venue=central`, DATE);

function race(n: number, startTime: string | null): RaceRow {
  return { raceId: `2026020201${String(n).padStart(2, "0")}`, venueName: "福島", raceNumber: n, raceName: `レース${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime };
}
const RACES = [race(1, "10:00"), race(2, "15:00"), race(3, null), race(4, "13:00")];

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const classes = (n: VNode): string[] => String(n.attrs?.["class"] ?? "").split(" ");
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));

function tree(now: Date | undefined, open = true): VNode {
  const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board: { kind: "none" }, ...(now === undefined ? {} : { now }), choices: new Map([["福島#0", open]]) });
  return renderScreen(model, noopActions);
}
const rows = (t: VNode): VNode[] => findAll(t, (n) => n.tag === "a" && classes(n).includes("race"));

describe("一覧の画面: 発走済みの行(Issue #346)", () => {
  it("発走済みの行だけ class に started が付く。行の順は未発走(R 順)→ 発走済み(R 順)", () => {
    const r = rows(tree(NOW));
    expect(r.map((n) => textOf(n).slice(0, 3).trim())).toEqual(["2R", "3R", "1R", "4R"]); // 前提: 並べ替わっている
    expect(r.map((n) => classes(n).includes("started"))).toEqual([false, false, true, true]);
  });

  it("now を渡さない(今日でない・並べ替えない)ときは started が付かない。行の順は元のまま", () => {
    const r = rows(tree(undefined));
    expect(r.map((n) => classes(n).includes("started"))).toEqual([false, false, false, false]);
    expect(r.map((n) => String(n.attrs?.["href"]).slice(-2))).toEqual(["01", "02", "03", "04"]);
  });

  it("見出し・区切りの要素は増えない(h2 は場の見出しの 1 つだけ。ul も 1 つ)", () => {
    const t = tree(NOW);
    expect(findAll(t, (n) => n.tag === "h2")).toHaveLength(1);
    expect(findAll(t, (n) => n.tag === "ul" && classes(n).includes("races"))).toHaveLength(1);
    expect(findAll(t, (n) => n.tag === "li")).toHaveLength(4);
  });

  it("発走済みの行も、リンク先・内容は通常の行と同じ(押せる・読める)。許可リストの検査(mount)も通る", () => {
    const t = tree(NOW);
    const past = rows(t).filter((n) => classes(n).includes("started"));
    expect(past).toHaveLength(2); // 前提
    for (const n of past) {
      expect(String(n.attrs?.["href"])).toMatch(/^#date=20260628&venue=central&race=2026020201\d\d$/);
      expect(textOf(n)).toContain("発走・");
    }
    const doc: DomDocument = { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }), createTextNode: () => ({}) };
    expect(() => mount(doc, { replaceChildren() {} }, t)).not.toThrow();
  });

  it("場を閉じているときは行を作らない(これまでどおり)", () => {
    expect(rows(tree(NOW, false))).toHaveLength(0);
  });
});
