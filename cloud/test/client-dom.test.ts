import { describe, expect, it } from "vitest";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel } from "../client/list";
import type { RaceRow } from "../client/api";
import { renderScreen } from "../client/view";
import { h, type VNode } from "../client/vnode";

/**
 * Issue #184: VNode → DOM のアダプタ(偽の document)と、画面の VNode。
 * 守ること(XSS・CSP): 馬名・レース名・エラー文などの「外から来た文字列」は、必ずテキストノードとして入り、HTML として解釈されない。
 * 要素・属性は許可リストのものだけ(script・iframe・style の要素、`on*`・`style`・`src` の属性、`javascript:` の href を作れない)。
 */

class FakeText {
  constructor(readonly data: string) {}
}

class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly children: (FakeElement | FakeText)[] = [];
  readonly listeners = new Map<string, ((event: { target: { value: string } }) => void)[]>();
  value = "";
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  appendChild(child: FakeElement | FakeText): FakeElement | FakeText {
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, listener: (event: { target: { value: string } }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  // HTML 文字列として解釈させる経路は、触れたら失敗させる。
  set innerHTML(_value: string) {
    throw new Error("innerHTML は使わない");
  }
  set outerHTML(_value: string) {
    throw new Error("outerHTML は使わない");
  }
  insertAdjacentHTML(): never {
    throw new Error("insertAdjacentHTML は使わない");
  }
}

class FakeRoot {
  children: unknown[] = [];
  replaceChildren(...nodes: unknown[]): void {
    this.children = nodes;
  }
}

const doc: DomDocument = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
};

function mounted(vnode: VNode): FakeElement {
  const root = new FakeRoot();
  mount(doc, root, vnode);
  expect(root.children).toHaveLength(1); // 前提: 描画の結果が 1 つの要素として root に入った
  return root.children[0] as FakeElement;
}

function allElements(el: FakeElement): FakeElement[] {
  return [el, ...el.children.flatMap((c) => (c instanceof FakeElement ? allElements(c) : []))];
}
function textNodes(el: FakeElement): string[] {
  return el.children.flatMap((c) => (c instanceof FakeText ? [c.data] : allTextOf(c)));
}
function allTextOf(c: FakeElement | FakeText): string[] {
  return c instanceof FakeText ? [c.data] : textNodes(c);
}

describe("mount(外から来た文字列はテキストノードで、HTML として解釈されない)", () => {
  const PAYLOADS = [`<img src=x onerror=alert(1)>`, `<script>alert(1)</script>`, `"><svg/onload=alert(1)>`, `&lt;b&gt;`];
  for (const payload of PAYLOADS) {
    it(`${payload} は、そのままの文字列のテキストノードになり、要素は増えない`, () => {
      const el = mounted(h("p", {}, [payload, h("span", {}, [payload])]));
      expect(allElements(el).map((e) => e.tag)).toEqual(["p", "span"]); // img・script・svg の要素ができていない
      expect(textNodes(el)).toEqual([payload, payload]); // 文字列がそのまま(エスケープ・解釈なし)
    });
  }

  it("要素・属性の値(value・href のハッシュ)も、文字列として属性に入るだけ", () => {
    const el = mounted(h("input", { type: "date", value: `"><script>x</script>` }, []));
    expect(el.attrs.get("type")).toBe("date");
    expect(el.value).toBe(`"><script>x</script>`);
  });
});

describe("mount(要素・属性の許可リスト)", () => {
  it("許可されていない要素(script・iframe・style・img)は作らない(投げる)", () => {
    for (const tag of ["script", "iframe", "style", "img", "object", "svg"]) {
      expect(() => mounted(h(tag, {}, [])), tag).toThrow();
    }
  });

  it("許可されていない属性(on*・style・src・srcdoc・formaction)は付けない(投げる)", () => {
    for (const name of ["onclick", "onerror", "onload", "style", "src", "srcdoc", "formaction", "ONCLICK"]) {
      expect(() => mounted(h("div", { [name]: "x" }, [])), name).toThrow();
    }
  });

  it("href は # で始まるものだけ。javascript:・data:・https: は投げる", () => {
    expect(mounted(h("a", { href: "#date=20261003&venue=nar" }, ["x"])).attrs.get("href")).toBe("#date=20261003&venue=nar");
    for (const href of ["javascript:alert(1)", "data:text/html,x", "https://example.com/", "//example.com", " #x", ""]) {
      expect(() => mounted(h("a", { href }, ["x"])), href).toThrow();
    }
  });

  it("許可された属性(class・aria-*・data-*・role・type・value・disabled)は付く。disabled は true のときだけ付き、false・undefined では付かない", () => {
    const el = mounted(h("button", { class: "refresh", "aria-label": "更新", "data-x": "1", role: "button", disabled: true }, ["更新"]));
    expect(el.attrs.get("class")).toBe("refresh");
    expect(el.attrs.get("aria-label")).toBe("更新");
    expect(el.attrs.get("data-x")).toBe("1");
    expect(el.attrs.has("disabled")).toBe(true);
    expect(mounted(h("button", { disabled: false }, [])).attrs.has("disabled")).toBe(false);
    expect(mounted(h("button", { disabled: undefined }, [])).attrs.has("disabled")).toBe(false);
  });
});

describe("mount(イベントと置き換え)", () => {
  it("click は handler を呼ぶ。change は、イベントの対象の value を文字列で渡す", () => {
    const seen: string[] = [];
    const button = mounted(h("button", {}, ["x"], { click: () => void seen.push("click") }));
    button.listeners.get("click")![0]!({ target: { value: "" } });
    expect(seen).toEqual(["click"]);
    const input = mounted(h("input", { type: "date" }, [], { change: (value) => void seen.push(value) }));
    input.listeners.get("change")![0]!({ target: { value: "2026-06-27" } });
    expect(seen).toEqual(["click", "2026-06-27"]);
  });

  it("mount は root の中身を 1 つの新しい要素に置き換える(積み増さない)", () => {
    const root = new FakeRoot();
    mount(doc, root, h("p", {}, ["a"]));
    mount(doc, root, h("p", {}, ["b"]));
    expect(root.children).toHaveLength(1);
    expect(textNodes(root.children[0] as FakeElement)).toEqual(["b"]);
  });
});

const RACE: RaceRow = { raceId: "202603020211", venueName: "福島", raceNumber: 11, raceName: "福島民報杯", courseType: "芝", distance: 1800, entryCount: 16, grade: null };
const noop = { onDateChange: () => {}, onRefresh: () => {} };

describe("renderScreen(一覧の VNode)", () => {
  const route = { date: "20260628", venue: "central", race: null, analysis: null } as const;

  it("外から来た文字列(レース名・会場名・エラー文)を含んでいても、描画した結果に script・img などの要素ができない(実際のアダプタを通す)", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const model = buildListModel({ route, list: { kind: "ready", races: [{ ...RACE, raceName: evil, venueName: evil, courseType: evil }] }, board: { kind: "error", message: evil } });
    const el = mounted(renderScreen(model, noop));
    const tags = new Set(allElements(el).map((e) => e.tag));
    expect([...tags].filter((t) => ["img", "script", "svg", "iframe"].includes(t))).toEqual([]);
    expect(allElements(el).flatMap((e) => [...e.attrs.keys()]).filter((n) => n.startsWith("on"))).toEqual([]);
    // 前提(空振り防止): 文字列は実際に描画されている
    expect(textNodes(el).filter((t) => t.includes(evil)).length).toBeGreaterThanOrEqual(3);
  });

  it("日付の入力(type=date・value は YYYY-MM-DD)・区分のタブ(現在のものに aria-current)・レースへのリンク(# から始まる)・更新ボタン", () => {
    const model = buildListModel({ route, list: { kind: "ready", races: [RACE] }, board: { kind: "none" } });
    const el = mounted(renderScreen(model, noop));
    const input = allElements(el).find((e) => e.tag === "input")!;
    expect(input.attrs.get("type")).toBe("date");
    expect(input.value).toBe("2026-06-28");
    const links = allElements(el).filter((e) => e.tag === "a");
    const hrefs = links.map((a) => a.attrs.get("href"));
    expect(hrefs).toContain("#date=20260628&venue=central");
    expect(hrefs).toContain("#date=20260628&venue=nar");
    expect(hrefs).toContain("#date=20260628&venue=central&race=202603020211");
    expect(hrefs.every((href) => href!.startsWith("#"))).toBe(true);
    const current = links.filter((a) => a.attrs.get("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(textNodes(current[0]!)).toEqual(["中央"]);
    expect(allElements(el).some((e) => e.tag === "button" && textNodes(e).includes("更新"))).toBe(true);
  });

  it("入力・更新のハンドラは、actions に繋がる", () => {
    const seen: string[] = [];
    const model = buildListModel({ route, list: { kind: "ready", races: [] }, board: { kind: "none" } });
    const el = mounted(renderScreen(model, { onDateChange: (v) => void seen.push(`date:${v}`), onRefresh: () => void seen.push("refresh") }));
    allElements(el).find((e) => e.tag === "input")!.listeners.get("change")![0]!({ target: { value: "2026-06-27" } });
    allElements(el).find((e) => e.tag === "button")!.listeners.get("click")![0]!({ target: { value: "" } });
    expect(seen).toEqual(["date:2026-06-27", "refresh"]);
  });

  it("エラーは role=alert の要素に出す。読み込み中は更新ボタンが disabled。開催なしは文言を出す", () => {
    const err = mounted(renderScreen(buildListModel({ route, list: { kind: "error", message: "失敗した" }, board: { kind: "none" } }), noop));
    const alert = allElements(err).filter((e) => e.attrs.get("role") === "alert");
    expect(alert).toHaveLength(1);
    expect(textNodes(alert[0]!)).toEqual(["失敗した"]);
    const loading = mounted(renderScreen(buildListModel({ route, list: { kind: "loading" }, board: { kind: "none" } }), noop));
    expect(allElements(loading).find((e) => e.tag === "button")!.attrs.has("disabled")).toBe(true);
    const empty = mounted(renderScreen(buildListModel({ route, list: { kind: "ready", races: [] }, board: { kind: "none" } }), noop));
    expect(textNodes(empty).join(" ")).toContain("開催はありません");
  });
});
