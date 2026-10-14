import { describe, expect, it } from "vitest";
import { mount } from "../client/dom";
import { h, type VNode } from "../client/vnode";

/**
 * Issue #222(#167-B2): VNode → DOM のアダプタに足した許可(移行画面のファイル選択と進捗バー)。許可リスト方式は変えない:
 *  - 要素 `progress`(属性 `value`・`max` は数字だけ。`max` は progress だけ)
 *  - 属性 `accept`(`input type="file"` だけ。値は拡張子・MIME の並びだけ)
 *  - イベント `on.file`(`input type="file"` だけ。選ばれた File〈無ければ null〉を渡す。value は読まない)
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

describe("accept 属性", () => {
  it("input type=file には、拡張子・MIME の並びを付けられる", () => {
    const el = build(h("input", { type: "file", accept: ".gz,application/gzip,application/x-gzip" }, []));
    expect(el.attrs.get("accept")).toBe(".gz,application/gzip,application/x-gzip");
    expect(el.attrs.get("type")).toBe("file");
  });

  it.each([["javascript:alert(1)"], ["<script>"], [".gz;x"], ["*/*"], [""], ["a".repeat(200)]])("不正な accept %j は投げる", (accept) => {
    expect(() => build(h("input", { type: "file", accept }, []))).toThrow(/accept/);
  });

  it("input type=file 以外には付けられない", () => {
    expect(() => build(h("input", { type: "text", accept: ".gz" }, []))).toThrow(/accept/);
    expect(() => build(h("div", { accept: ".gz" }, []))).toThrow(/accept/);
  });
});

describe("on.file", () => {
  const picker = (onFile: (f: unknown) => void): VNode => h("input", { type: "file", accept: ".gz" }, [], { file: onFile as never });

  it("change で、選ばれた最初の File を渡す", () => {
    const got: unknown[] = [];
    const el = build(picker((f) => got.push(f)));
    const file = { name: "a.gz" };
    el.listeners.get("change")![0]!({ target: { files: [file, { name: "b.gz" }] } });
    expect(got).toEqual([file]);
  });

  it("選択が空(キャンセル・files が無い)なら null を渡す", () => {
    const got: unknown[] = [];
    const el = build(picker((f) => got.push(f)));
    el.listeners.get("change")![0]!({ target: { files: [] } });
    el.listeners.get("change")![0]!({ target: {} });
    expect(got).toEqual([null, null]);
  });

  it("value(ファイルのパス)は読まない・渡さない", () => {
    const got: unknown[] = [];
    const el = build(picker((f) => got.push(f)));
    el.listeners.get("change")![0]!({ target: { files: [{ name: "a.gz" }], value: "C:\\fakepath\\a.gz" } });
    expect(JSON.stringify(got)).not.toContain("fakepath");
  });

  it("input type=file 以外には付けられない", () => {
    expect(() => build(h("input", { type: "text" }, [], { file: () => {} }))).toThrow(/file/);
    expect(() => build(h("div", {}, [], { file: () => {} }))).toThrow(/file/);
  });
});
