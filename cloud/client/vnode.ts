/**
 * 画面の木(Issue #184)。描画(DOM)から切り離したプレーンなデータで、純関数(`view.ts`)が作り、アダプタ(`dom.ts`)が DOM にする。
 * 文字列の子は必ずテキストノードになる(HTML として解釈されない)。
 */

export type AttrValue = string | boolean | undefined;

export interface VNode {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, AttrValue>>;
  readonly children?: readonly (VNode | string)[];
  readonly on?: {
    readonly click?: () => void;
    /** 入力欄の value(文字列)を受け取る。 */
    readonly change?: (value: string) => void;
  };
}

export function h(tag: string, attrs: Readonly<Record<string, AttrValue>> = {}, children: readonly (VNode | string)[] = [], on?: VNode["on"]): VNode {
  return on === undefined ? { tag, attrs, children } : { tag, attrs, children, on };
}
