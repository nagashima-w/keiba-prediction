import { describe, expect, it } from "vitest";
import { createApp } from "../client/app";
import { createMounter, mount, type DomDocument } from "../client/dom";
import { buildListModel } from "../client/list";
import type { RaceRow } from "../client/api";
import { renderScreen } from "../client/view";
import { h, type VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

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
  /** replaceChildren を呼んだ回数(DOM を触った回数)。 */
  replaced = 0;
  replaceChildren(...nodes: unknown[]): void {
    this.replaced += 1;
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

  it("data-* は小文字・数字・ハイフンの名前だけ(Issue #186 の data-key は通る。大文字・空・下線・記号の名前は投げる=on* などを data- で偽装できない)", () => {
    expect(mounted(h("button", { "data-key": "福島#0" }, [])).attrs.get("data-key")).toBe("福島#0");
    for (const name of ["data-", "data-Key", "data-a_b", "data-a b", "data-a.b", "data:key", "dataset-key"]) {
      expect(() => mounted(h("button", { [name]: "x" }, [])), name).toThrow();
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

/**
 * Issue #186 段階1: 同じ木なら DOM を触らない(`createMounter`)。ポーリング(段階2)の再描画が、タップ・場の開閉・日付ピッカーを壊さないための土台。
 * 比較は `JSON.stringify`(関数は落ちる)なので、クリック処理が違っても JSON が同じなら置き換えない。
 * **この契約を安全にするのは「クリック処理の引数は data-* にも出す」こと**(`view.ts`。`client-view.test.ts` が固定)。
 */
describe("createMounter(同じ木なら DOM を触らない)", () => {
  const tree = (label: string, key = "a", clicks: string[] = []): VNode =>
    h("div", {}, [h("button", { class: "t", "data-key": key }, [label], { click: () => void clicks.push(key) })]);

  it("最初の描画は root に 1 つの要素を入れる。同じ木(JSON が等しい別のオブジェクト)は置き換えない(DOM の要素・呼び出し回数とも不変)", () => {
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    render(tree("x"));
    expect(root.replaced).toBe(1);
    expect(root.children).toHaveLength(1);
    const first = root.children[0];
    render(tree("x")); // 新しいオブジェクトだが JSON は同じ
    render(tree("x"));
    expect(root.replaced).toBe(1);
    expect(root.children[0]).toBe(first); // 同じ DOM 要素のまま(フォーカス・開閉・入力は壊れない)
  });

  it("木が違えば置き換える(文字・属性・構造のどれが違っても)。置き換えたあとの同じ木は、また置き換えない", () => {
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    render(tree("x"));
    expect(root.replaced).toBe(1); // 前提
    render(tree("y")); // 文字
    expect(root.replaced).toBe(2);
    render(tree("y", "b")); // 属性(data-key)
    expect(root.replaced).toBe(3);
    render(h("div", {}, [])); // 構造
    expect(root.replaced).toBe(4);
    expect(root.children).toHaveLength(1);
    render(h("div", {}, []));
    expect(root.replaced).toBe(4);
    // 違う木が、直前の木に戻ったときも置き換える(「2 つ前と同じ」でスキップしない)
    render(tree("y", "b"));
    render(h("div", {}, []));
    expect(root.replaced).toBe(6);
  });

  it("置き換えた木のクリック処理は、最新の木のもの(data-key が違えば置き換わるので、古い引数の処理が残らない)", () => {
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    const clicks: string[] = [];
    render(tree("x", "a", clicks));
    render(tree("x", "b", clicks)); // 文字は同じで data-key だけが違う
    expect(root.replaced).toBe(2); // 前提: 置き換わった(スキップされていない)
    const button = allElements(root.children[0] as FakeElement).find((e) => e.tag === "button")!;
    button.listeners.get("click")![0]!({ target: { value: "" } });
    expect(clicks).toEqual(["b"]);
  });

  it("契約の確認(特性): data-* に出ない違い(クリック処理だけ)は、木が同じとみなされ置き換えない。だから引数は data-* に出す", () => {
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    const first: string[] = [];
    const second: string[] = [];
    render(tree("x", "a", first));
    render(tree("x", "a", second));
    expect(root.replaced).toBe(1);
    const button = allElements(root.children[0] as FakeElement).find((e) => e.tag === "button")!;
    button.listeners.get("click")![0]!({ target: { value: "" } });
    expect(first).toEqual(["a"]); // 古い処理のまま
    expect(second).toEqual([]);
  });

  it("許可リスト外の要素で組み立てに失敗したら投げ、画面(root)は変えない。その後の描画は、直前に成功した木を基準にする", () => {
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    render(tree("x"));
    const shown = root.children[0];
    expect(() => render(h("script", {}, []))).toThrow();
    expect(root.replaced).toBe(1);
    expect(root.children[0]).toBe(shown);
    render(tree("x")); // 画面は「x」のままなので、置き換えない
    expect(root.replaced).toBe(1);
    render(tree("z"));
    expect(root.replaced).toBe(2);
  });

  it("force を渡すと、同じ木でも置き換える(日付の入力欄を画面の値に戻すため)。そのあと force なしの同じ木は置き換えない", () => {
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    render(tree("x"));
    render(tree("x"));
    expect(root.replaced).toBe(1); // 前提: 同じ木は置き換えない
    const first = root.children[0];
    render(tree("x"), true);
    expect(root.replaced).toBe(2);
    expect(root.children[0]).not.toBe(first); // 新しい DOM 要素になった
    render(tree("x"));
    expect(root.replaced).toBe(2);
  });

  it("日付の入力欄に不正な値・空を入れたとき、画面(createApp)は入力欄を、画面のデータの日付に戻す(段階1の【記録】1。旧版は同じ木の省略で、空のまま残った)", async () => {
    const DATE = "20260628";
    const fetchStub = async (url: string) => {
      if (url.startsWith("/api/races")) return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, venue: "central", races: [] }) };
      return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, races: [] }) };
    };
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    const app = createApp({ fetch: fetchStub, now: () => new Date("2026-06-28T00:00:00Z"), render, getHash: () => `#date=${DATE}&venue=central`, setHash: () => {}, timers: { set: () => 0, clear: () => {} }, isVisible: () => true });
    app.start();
    await app.whenIdle();
    const dateInput = () => allElements(root.children[0] as FakeElement).find((e) => e.tag === "input")!;
    expect(dateInput().value).toBe("2026-06-28"); // 前提: 画面の日付
    for (const typed of ["", "2026-02-30", "garbage"]) {
      dateInput().value = typed; // 利用者が入力欄を書き換えた(DOM は画面のデータと食い違う)
      dateInput().listeners.get("change")![0]!({ target: { value: typed } });
      expect(dateInput().value, `入力「${typed}」のあと、入力欄は画面の日付に戻る`).toBe("2026-06-28");
    }
  });

  it("画面の制御(createApp)と繋ぐと、状態が変わらない再描画(同じハッシュの hashchange)で DOM を触らない。状態が変わる描画(場の開閉)では触る", async () => {
    const DATE = "20260628";
    const row = (raceId: string, venue: string) => ({ race_id: raceId, venue_name: venue, race_number: Number(raceId.slice(-2)), race_name: "レース", course_type: "芝", distance: 1800, entry_count: 16, grade: null });
    const fetchStub = async (url: string) => {
      if (url.startsWith("/api/races")) return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, venue: "central", races: [row("202602010101", "函館"), row("202603020211", "福島")] }) };
      return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, races: [] }) };
    };
    const root = new FakeRoot();
    const render = createMounter(doc, root);
    const hashState = { hash: `#date=${DATE}&venue=central` };
    const app = createApp({ fetch: fetchStub, now: () => new Date("2026-06-28T00:00:00Z"), render, getHash: () => hashState.hash, setHash: () => {}, timers: { set: () => 0, clear: () => {} }, isVisible: () => true });
    app.start();
    await app.whenIdle();
    expect(root.children).toHaveLength(1);
    const settled = root.replaced;
    const shown = root.children[0];
    const toggles = () => allElements(root.children[0] as FakeElement).filter((e) => e.attrs.get("class") === "venue-toggle");
    expect(toggles()).toHaveLength(2); // 前提: 見出しが 2 つ(場が 2 つ以上なので既定は全部閉)
    app.onHashChange();
    app.onHashChange();
    expect(root.replaced).toBe(settled); // 同じ状態の再描画では、DOM を触らない
    expect(root.children[0]).toBe(shown);
    toggles()[0]!.listeners.get("click")![0]!({ target: { value: "" } });
    expect(root.replaced).toBe(settled + 1); // 開閉で木が変わるので置き換える
    expect(toggles()[0]!.attrs.get("aria-expanded")).toBe("true");
  });
});

const RACE: RaceRow = { raceId: "202603020211", venueName: "福島", raceNumber: 11, raceName: "福島民報杯", courseType: "芝", distance: 1800, entryCount: 16, grade: null };

describe("renderScreen(一覧の VNode)", () => {
  const route = { date: "20260628", venue: "central", race: null, analysis: null } as const;

  it("外から来た文字列(レース名・会場名・エラー文)を含んでいても、描画した結果に script・img などの要素ができない(実際のアダプタを通す)", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const model = buildListModel({ route, list: { kind: "ready", races: [{ ...RACE, raceName: evil, venueName: evil, courseType: evil }] }, board: { kind: "error", message: evil } });
    const el = mounted(renderScreen(model, noopActions));
    const tags = new Set(allElements(el).map((e) => e.tag));
    expect([...tags].filter((t) => ["img", "script", "svg", "iframe"].includes(t))).toEqual([]);
    expect(allElements(el).flatMap((e) => [...e.attrs.keys()]).filter((n) => n.startsWith("on"))).toEqual([]);
    // 前提(空振り防止): 文字列は実際に描画されている
    expect(textNodes(el).filter((t) => t.includes(evil)).length).toBeGreaterThanOrEqual(3);
  });

  it("日付の入力(type=date・value は YYYY-MM-DD)・区分のタブ(現在のものに aria-current)・レースへのリンク(# から始まる)・更新ボタン", () => {
    const model = buildListModel({ route, list: { kind: "ready", races: [RACE] }, board: { kind: "none" } });
    const el = mounted(renderScreen(model, noopActions));
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

  it("場の見出しのボタンには、実際のアダプタを通しても data-key が付く(値は場のキー。外から来た会場名を含んでも属性値の文字列でしかない)", () => {
    const evil = `"><img src=x onerror=alert(1)>`;
    const model = buildListModel({ route, list: { kind: "ready", races: [{ ...RACE, venueName: evil }, { ...RACE, raceId: "202602010101", venueName: "函館" }] }, board: { kind: "none" } });
    const el = mounted(renderScreen(model, noopActions));
    const toggles = allElements(el).filter((e) => e.attrs.get("class") === "venue-toggle");
    expect(toggles).toHaveLength(2); // 前提: 2 つの場
    expect(toggles.map((t) => t.attrs.get("data-key"))).toEqual(model.groups.map((g) => g.key));
    expect(allElements(el).some((e) => e.tag === "img")).toBe(false);
  });

  it("入力・更新のハンドラは、actions に繋がる", () => {
    const seen: string[] = [];
    const model = buildListModel({ route, list: { kind: "ready", races: [] }, board: { kind: "none" } });
    const el = mounted(renderScreen(model, { onDateChange: (v) => void seen.push(`date:${v}`), onRefresh: () => void seen.push("refresh"), onToggleGroup: () => {}, onToggleResult: () => {}, onRun: () => {}, onRetrack: () => {} }));
    allElements(el).find((e) => e.tag === "input")!.listeners.get("change")![0]!({ target: { value: "2026-06-27" } });
    allElements(el).find((e) => e.tag === "button")!.listeners.get("click")![0]!({ target: { value: "" } });
    expect(seen).toEqual(["date:2026-06-27", "refresh"]);
  });

  it("エラーは role=alert の要素に出す。読み込み中は更新ボタンが disabled。開催なしは文言を出す", () => {
    const err = mounted(renderScreen(buildListModel({ route, list: { kind: "error", message: "失敗した" }, board: { kind: "none" } }), noopActions));
    const alert = allElements(err).filter((e) => e.attrs.get("role") === "alert");
    expect(alert).toHaveLength(1);
    expect(textNodes(alert[0]!)).toEqual(["失敗した"]);
    const loading = mounted(renderScreen(buildListModel({ route, list: { kind: "loading" }, board: { kind: "none" } }), noopActions));
    expect(allElements(loading).find((e) => e.tag === "button")!.attrs.has("disabled")).toBe(true);
    const empty = mounted(renderScreen(buildListModel({ route, list: { kind: "ready", races: [] }, board: { kind: "none" } }), noopActions));
    expect(textNodes(empty).join(" ")).toContain("開催はありません");
  });
});
