import { createMounter, type DomDocument, type DomRoot } from "../../client/dom";
import type { VNode } from "../../client/vnode";

/**
 * テスト用: root の中身を、VNode から作った 1 つの新しい要素に置き換える(積み増さない)。
 *
 * Issue #393 で、`client/dom.ts` の `mount`(production からは未使用で、テストだけが使っていた)をここへ移した。
 * 画面の描画に使う実体は `createMounter`。毎回新しい描画関数を作り `force` で必ず置き換えるので、旧 `mount` と同じ結果になる。
 */
export function mount(doc: DomDocument, root: DomRoot, vnode: VNode): void {
  createMounter(doc, root)(vnode, true);
}
