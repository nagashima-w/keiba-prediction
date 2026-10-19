import { describe, expect, it } from "vitest";
import { mount } from "./support/dom-mount";
import { h, type VNode } from "../client/vnode";

/**
 * VNode → DOM のアダプタの許可のうち、進捗バー(`progress`。Issue #222 で足し、検証画面が使っている)の検査。許可リスト方式は変えない:
 *  - 要素 `progress`(属性 `value`・`max` は数字だけ。`max` は progress だけ)
 * Issue #394(移行画面の廃止)で、`accept` 属性と `on.file` イベントの許可は外した。外したことを下の describe が固定する。
 */

class FakeText {
  constructor(readonly data: string) {}
}
class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly children: (FakeElement | FakeText)[] = [];
  readonly listeners = new Map<string, ((event: { target: { files?: unknown; value?: string } }) => void)[]>();
  value = "";
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  appendChild(child: FakeElement | FakeText): void {
    this.children.push(child);
  }
  addEventListener(type: string, listener: (event: { target: { files?: unknown; value?: string } }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
}
const doc = { createElement: (tag: string) => new FakeElement(tag), createTextNode: (t: string) => new FakeText(t) };

function build(node: VNode): FakeElement {
  const root = { child: undefined as FakeElement | undefined, replaceChildren(c: FakeElement) { this.child = c; } };
  mount(doc, root, node);
  return root.child!;
}

describe("progress 要素", () => {
  it("value と max(数字)を属性にする", () => {
    const el = build(h("progress", { value: "42", max: "100" }, []));
    expect(el.tag).toBe("progress");
    expect(el.attrs.get("value")).toBe("42");
    expect(el.attrs.get("max")).toBe("100");
  });

  it.each([["abc"], ["-1"], ["1e3"], [""], ["1 "], ["12345678901234"]])("progress の value が数字でない %j は投げる", (value) => {
    expect(() => build(h("progress", { value, max: "100" }, []))).toThrow();
  });

  it("max は progress 以外には付けられない", () => {
    expect(() => build(h("div", { max: "100" }, []))).toThrow(/max/);
    expect(() => build(h("input", { type: "text", max: "100" }, []))).toThrow(/max/);
  });
});

describe("移行画面の廃止(Issue #394)で外した許可", () => {
  it("属性 accept は、input type=file に付けても許可されない", () => {
    expect(() => build(h("input", { type: "file", accept: ".gz,application/gzip" }, []))).toThrow(/許可されていない属性/);
  });

  it("イベント on.file は、input type=file に付けても、何のリスナも登録されない(未知のイベントは無視される)", () => {
    const el = build(h("input", { type: "file" }, [], { file: (() => {}) as never } as never));
    expect(el.listeners.size).toBe(0);
  });
});
