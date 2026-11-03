import { describe, expect, it } from "vitest";
import { createMounter, type DomDocument } from "../client/dom";
import { h, type VNode } from "../client/vnode";

/**
 * Issue #578-2: 馬ごとの評価の表の並べ替えは木を作り直す(`replaceChildren`)ので、表の枠(`.horse-table-wrap`)の横スクロールの位置と、
 * 押した列見出しのボタン(`.sort-button`)のフォーカスが戻っていた。作り直しのあとに同じ分析の表へ戻すことを、木を持つ偽の DOM で確かめる。
 */

class FakeEl {
  readonly attrs = new Map<string, string>();
  readonly children: unknown[] = [];
  scrollLeft = 0;
  constructor(readonly tag: string, private readonly doc: FakeDoc) {}
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  appendChild(c: unknown): unknown {
    this.children.push(c);
    return c;
  }
  addEventListener(): void {}
  /** 戻すときに渡された focus の引数(テスト側の `focus()` は引数なし=undefined)。 */
  focusOptions: unknown[] = [];
  focus(options?: { preventScroll?: boolean }): void {
    this.focusOptions.push(options);
    this.doc.activeElement = this;
  }
  descendants(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.descendants()] : []));
  }
}

class FakeDoc implements DomDocument {
  activeElement: FakeEl | null = null;
  createElement(tag: string): FakeEl {
    return new FakeEl(tag, this);
  }
  createTextNode(text: string): unknown {
    return { text };
  }
}

/** 使う 2 形だけの selector 照合: `.horse-table-wrap` と `button.sort-button[data-sort-key="K"][data-analysis="A"]`。 */
function matches(el: FakeEl, selector: string): boolean {
  if (selector === ".horse-table-wrap") return el.getAttribute("class") === "horse-table-wrap";
  const m = /^button\.sort-button\[data-sort-key="([^"]+)"\]\[data-analysis="([^"]+)"\]$/.exec(selector);
  if (m === null) throw new Error(`この偽の DOM が扱わない selector: ${selector}`);
  return el.tag === "button" && el.getAttribute("class") === "sort-button" && el.getAttribute("data-sort-key") === m[1] && el.getAttribute("data-analysis") === m[2];
}

class FakeRoot {
  children: FakeEl[] = [];
  replaceChildren(...nodes: FakeEl[]): void {
    this.children = nodes;
  }
  querySelector(selector: string): FakeEl | null {
    return this.children.flatMap((c) => [c, ...c.descendants()]).find((e) => matches(e, selector)) ?? null;
  }
}

const table = (analysis: number, sortedBy: string): VNode =>
  h("div", {}, [
    h("div", { class: "horse-table-wrap", "data-analysis": String(analysis) }, [
      h("table", {}, [
        h(
          "tr",
          {},
          ["umaban", "ev", "winOdds"].map((key) =>
            h("th", { "aria-sort": key === sortedBy ? "ascending" : "none" }, [h("button", { class: "sort-button", "data-analysis": String(analysis), "data-sort-key": key, "data-sort-dir": "asc" }, [key])]),
          ),
        ),
      ]),
    ]),
  ]);

function setup() {
  const doc = new FakeDoc();
  const root = new FakeRoot();
  return { doc, root, mount: createMounter(doc, root) };
}
const wrapOf = (root: FakeRoot): FakeEl => root.querySelector(".horse-table-wrap")!;
const button = (root: FakeRoot, analysis: number, key: string): FakeEl => root.querySelector(`button.sort-button[data-sort-key="${key}"][data-analysis="${analysis}"]`)!;

describe("createMounter: 作り直しのあとに、表の横スクロールと並べ替えボタンのフォーカスを戻す(Issue #578-2)", () => {
  it("横スクロールの位置: 並べ替えで木が変わっても、同じ分析の表の枠は同じ位置のまま", () => {
    const { root, mount } = setup();
    mount(table(5, "umaban"));
    wrapOf(root).scrollLeft = 120;
    const before = wrapOf(root);
    mount(table(5, "ev"));
    expect(wrapOf(root), "前提: 枠は作り直された(別の要素)").not.toBe(before);
    expect(wrapOf(root).scrollLeft).toBe(120);
  });

  it("フォーカス: 押した列のボタンが、作り直した木の同じ列のボタンにフォーカスされる(別の列のボタンではない)", () => {
    const { doc, root, mount } = setup();
    mount(table(5, "umaban"));
    button(root, 5, "ev").focus();
    expect(doc.activeElement, "前提: 「ev」のボタンにフォーカスがある").toBe(button(root, 5, "ev"));
    const before = button(root, 5, "ev");
    mount(table(5, "ev"));
    expect(button(root, 5, "ev"), "前提: ボタンは作り直された").not.toBe(before);
    expect(doc.activeElement).toBe(button(root, 5, "ev"));
    expect(doc.activeElement).not.toBe(button(root, 5, "winOdds"));
    expect(button(root, 5, "ev").focusOptions, "戻すときは preventScroll: true を付ける(ブラウザによってはページ側がスクロールするため)").toEqual([{ preventScroll: true }]);
  });

  it("別の分析の表へ移ったときは戻さない(スクロールもフォーカスも)", () => {
    const { doc, root, mount } = setup();
    mount(table(5, "umaban"));
    wrapOf(root).scrollLeft = 120;
    button(root, 5, "ev").focus();
    mount(table(6, "umaban"));
    expect(wrapOf(root).scrollLeft).toBe(0);
    expect(doc.activeElement).not.toBe(button(root, 6, "ev"));
  });

  it("表が無い画面へ移っても、表のある画面へ戻っても、投げない・勝手にスクロールしない", () => {
    const { root, mount } = setup();
    mount(table(5, "umaban"));
    wrapOf(root).scrollLeft = 120;
    mount(h("div", {}, ["表なし"]));
    expect(root.querySelector(".horse-table-wrap")).toBeNull();
    mount(table(5, "umaban"));
    expect(wrapOf(root).scrollLeft, "表の無い画面を挟んだら、位置は引き継がない").toBe(0);
  });

  it("フォーカスが表と無関係な要素(別のボタン)にあるときは、フォーカスを動かさない", () => {
    const { doc, root, mount } = setup();
    mount(h("div", {}, [h("button", { class: "other" }, ["x"]), table(5, "umaban")]));
    const other = root.children[0]!.children[0] as FakeEl;
    other.focus();
    mount(h("div", {}, [h("button", { class: "other" }, ["x"]), table(5, "ev")]));
    expect(doc.activeElement, "前提: フォーカスは前の要素のまま(新しい木のどれにも移していない)").toBe(other);
  });

  it("root に querySelector が無い・document に activeElement が無い環境(既存のテストの偽物)でも、従来どおり描画できる", () => {
    const mount = createMounter({ createElement: (t: string) => new FakeEl(t, new FakeDoc()), createTextNode: (s: string) => ({ s }) }, { replaceChildren: () => {} });
    expect(() => mount(table(5, "umaban"))).not.toThrow();
    expect(() => mount(table(5, "ev"))).not.toThrow();
  });
});
