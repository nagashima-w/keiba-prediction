/**
 * VNode → DOM のアダプタ(Issue #184)。`document` 互換のオブジェクトを受け取る(Node の vitest では偽物を渡せる)。
 *
 * **XSS・CSP の守り**: 外から来た文字列(レース名・馬名・エラー文など)は、必ずテキストノードとして入れる(HTML として解釈する API は使わない)。
 * 要素・属性は許可リストのものだけで、それ以外は投げる(`script`・`iframe`・`style` の要素、`on*`・`style`・`src` の属性を作れない)。
 * `href` は `#` で始まるものだけ(`javascript:`・外部の URL を作れない)。
 */
import type { VNode } from "./vnode";

export interface DomElement {
  setAttribute(name: string, value: string): void;
  appendChild(child: any): unknown;
  addEventListener(type: string, listener: (event: any) => void): void;
  value?: string;
}

export interface DomDocument {
  createElement(tag: string): DomElement;
  createTextNode(text: string): unknown;
}

export interface DomRoot {
  replaceChildren(...nodes: any[]): void;
}

const ALLOWED_TAGS = new Set(["div", "span", "p", "h1", "h2", "h3", "a", "button", "input", "label", "ul", "li", "section", "nav", "strong", "small"]);
const ALLOWED_ATTRS = new Set(["class", "type", "value", "disabled", "href", "role"]);

function attrAllowed(name: string): boolean {
  return ALLOWED_ATTRS.has(name) || /^aria-[a-z-]+$/.test(name) || /^data-[a-z0-9-]+$/.test(name);
}

function build(doc: DomDocument, node: VNode | string): unknown {
  if (typeof node === "string") {
    return doc.createTextNode(node);
  }
  if (!ALLOWED_TAGS.has(node.tag)) {
    throw new Error(`許可されていない要素です: ${node.tag}`);
  }
  const el = doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (!attrAllowed(name)) {
      throw new Error(`許可されていない属性です: ${name}`);
    }
    if (value === undefined || value === false) {
      continue;
    }
    if (name === "href" && (typeof value !== "string" || !value.startsWith("#"))) {
      throw new Error("href は # で始まるものだけです");
    }
    if (name === "value" && node.tag === "input") {
      el.value = String(value);
      continue;
    }
    el.setAttribute(name, value === true ? "" : value);
  }
  for (const child of node.children ?? []) {
    el.appendChild(build(doc, child));
  }
  const on = node.on;
  if (on?.click !== undefined) {
    const click = on.click;
    el.addEventListener("click", () => click());
  }
  if (on?.change !== undefined) {
    const change = on.change;
    el.addEventListener("change", (event: { target?: { value?: unknown } }) => change(String(event.target?.value ?? "")));
  }
  return el;
}

/** root の中身を、VNode から作った 1 つの新しい要素に置き換える(積み増さない)。 */
export function mount(doc: DomDocument, root: DomRoot, vnode: VNode): void {
  root.replaceChildren(build(doc, vnode));
}
