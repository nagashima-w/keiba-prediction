/**
 * VNode → DOM のアダプタ(Issue #184)。`document` 互換のオブジェクトを受け取る(Node の vitest では偽物を渡せる)。
 *
 * **XSS・CSP の守り**: 外から来た文字列(レース名・馬名・エラー文など)は、必ずテキストノードとして入れる(HTML として解釈する API は使わない)。
 * 要素・属性は許可リストのものだけで、それ以外は投げる(`script`・`iframe`・`style` の要素、`on*`・`style`・`src` の属性を作れない)。
 * `href` は `#` で始まるものだけ(`javascript:`・外部の URL を作れない)。
 * Issue #189(設定画面)で足した許可: 要素 `textarea`・`select`・`option`、属性 `checked`・`inputmode`・`maxlength`。足したものの扱い:
 *  - `value`: `input`・`textarea` はプロパティ(HTML として解釈しない・改行をそのまま入れる)。`select` は **option を子に入れたあと**にプロパティで設定する(先だと選ばれない)。`option` は属性。
 *  - `checked`: `input` のプロパティ(属性にはしない)。`input` 以外に付けると投げる。
 *  - `inputmode`: `numeric`・`decimal`・`text` だけ。`maxlength`: 1〜5桁の数字だけ。それ以外は投げる。
 * Issue #222(移行画面)で足した許可:
 *  - 要素 `progress`(属性 `value`・`max` は数字だけ。`max` は progress だけ)。
 *  - 属性 `accept`(`input type="file"` だけ。値は拡張子・MIME の並び〈`.gz,application/gzip` 形式〉だけ)。
 *  - イベント `on.file`(`input type="file"` だけ。`change` で、選ばれた最初の File〈無ければ null〉を渡す。`value`〈偽のパス〉は読まない)。
 */
import type { VNode } from "./vnode";

export interface DomElement {
  setAttribute(name: string, value: string): void;
  appendChild(child: any): unknown;
  addEventListener(type: string, listener: (event: any) => void): void;
  value?: string;
  checked?: boolean;
}

/** `change` イベントの target のうち、ここで読む部分。 */
interface ChangeTarget {
  value?: unknown;
  checked?: unknown;
  files?: ArrayLike<unknown> | null;
}

export interface DomDocument {
  createElement(tag: string): DomElement;
  createTextNode(text: string): unknown;
}

export interface DomRoot {
  replaceChildren(...nodes: any[]): void;
}

const ALLOWED_TAGS = new Set(["div", "span", "p", "h1", "h2", "h3", "a", "button", "input", "label", "ul", "li", "section", "nav", "strong", "small", "textarea", "select", "option", "progress"]);
const ALLOWED_ATTRS = new Set(["class", "type", "value", "disabled", "href", "role", "checked", "inputmode", "maxlength", "accept", "max"]);
/** `accept` の値: 拡張子(`.gz`)・MIME(`application/gzip`)をカンマで並べたもの。 */
const ACCEPT_PATTERN = /^(?:\.[a-z0-9]{1,10}|[a-z]+\/[a-z0-9.+-]{1,40})(?:,(?:\.[a-z0-9]{1,10}|[a-z]+\/[a-z0-9.+-]{1,40})){0,5}$/;
const ALLOWED_INPUTMODES = new Set(["numeric", "decimal", "text"]);

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
  let selectValue: string | undefined;
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
    if (name === "checked") {
      if (node.tag !== "input") {
        throw new Error("checked は input だけです");
      }
      el.checked = true; // true のときだけ(false・undefined は上で飛ばしている)
      continue;
    }
    if (name === "inputmode" && !ALLOWED_INPUTMODES.has(String(value))) {
      throw new Error(`許可されていない inputmode です: ${String(value)}`);
    }
    if (name === "maxlength" && !/^[0-9]{1,5}$/.test(String(value))) {
      throw new Error("maxlength は 1〜5 桁の数字だけです");
    }
    if (name === "accept" && (node.tag !== "input" || node.attrs?.["type"] !== "file" || typeof value !== "string" || !ACCEPT_PATTERN.test(value))) {
      throw new Error("accept は input type=file の、拡張子・MIME の並びだけです");
    }
    if (name === "max" && node.tag !== "progress") {
      throw new Error("max は progress だけです");
    }
    if ((name === "max" || (name === "value" && node.tag === "progress")) && !/^[0-9]{1,12}$/.test(String(value))) {
      throw new Error("progress の value・max は数字だけです");
    }
    if (name === "value" && (node.tag === "input" || node.tag === "textarea")) {
      el.value = String(value);
      continue;
    }
    if (name === "value" && node.tag === "select") {
      selectValue = String(value); // option を入れたあとに設定する
      continue;
    }
    el.setAttribute(name, value === true ? "" : value);
  }
  for (const child of node.children ?? []) {
    el.appendChild(build(doc, child));
  }
  if (selectValue !== undefined) {
    el.value = selectValue;
  }
  const on = node.on;
  if (on?.click !== undefined) {
    const click = on.click;
    el.addEventListener("click", () => click());
  }
  if (on?.change !== undefined) {
    const change = on.change;
    // checkbox は value が常に "on" なので、チェックの状態を "true"・"false" で渡す(Issue #189)。
    const isCheckbox = node.tag === "input" && node.attrs?.["type"] === "checkbox";
    el.addEventListener("change", (event: { target?: { value?: unknown; checked?: unknown } }) =>
      change(isCheckbox ? (event.target?.checked === true ? "true" : "false") : String(event.target?.value ?? "")),
    );
  }
  if (on?.file !== undefined) {
    if (node.tag !== "input" || node.attrs?.["type"] !== "file") {
      throw new Error("on.file は input type=file だけです");
    }
    const file = on.file;
    // 選ばれた最初のファイルだけを渡す(value は偽のパスなので読まない)。
    el.addEventListener("change", (event: { target?: ChangeTarget }) => {
      const files = event.target?.files;
      file(files !== undefined && files !== null && files.length > 0 ? (files[0] as Parameters<typeof file>[0]) : null);
    });
  }
  if (on?.input !== undefined) {
    const input = on.input;
    el.addEventListener("input", (event: { target?: { value?: unknown } }) => input(String(event.target?.value ?? "")));
  }
  return el;
}

/** root の中身を、VNode から作った 1 つの新しい要素に置き換える(積み増さない)。 */
export function mount(doc: DomDocument, root: DomRoot, vnode: VNode): void {
  root.replaceChildren(build(doc, vnode));
}

/**
 * 描画の関数を作る(Issue #186 段階1)。**直前に描いた木と JSON 直列化して同一なら、DOM を触らない**。
 * ポーリング(段階2)の再描画が、タップ中のボタン・日付ピッカー・フォーカスを壊さないための土台。
 *
 * **比較は `JSON.stringify` なので、関数(`on` のクリック処理)は比較されない**。木が同じでクリック処理だけが違うと、DOM には古い処理が残る。
 * そのため呼び出し側(`view.ts`)は、クリック処理に渡す引数を必ず `data-*` 属性にも出す(引数が違えば木が違う)。
 * 組み立て(許可リストの検査を含む)が投げたときは root を変えず、「直前の木」も更新しない(画面に出ているのは直前に成功した木のまま)。
 * **`force` が true のときは、同じ木でも置き換える**(Issue #186。日付の入力欄に不正な値を入れられたとき、入力欄を画面のデータの値に戻す。木は変わっていないので、省略すると入力欄が食い違ったまま残る)。
 */
export function createMounter(doc: DomDocument, root: DomRoot): (vnode: VNode, force?: boolean) => void {
  let last: string | null = null;
  return (vnode, force = false) => {
    const serialized = JSON.stringify(vnode);
    if (!force && serialized === last) {
      return;
    }
    root.replaceChildren(build(doc, vnode));
    last = serialized;
  };
}
