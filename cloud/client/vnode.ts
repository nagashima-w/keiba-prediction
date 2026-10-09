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
    /** 入力のたび(`input` イベント)に、入力欄の value(文字列)を受け取る(Issue #189。文字を打つ欄で、保存の直前の入力を取りこぼさないため)。 */
    readonly input?: (value: string) => void;
    /** `input type="file"` の選択(`change`)。選ばれた最初のファイル(選択が空なら null)を受け取る(Issue #222。value〈パス〉は渡さない)。 */
    readonly file?: (file: PickedFile | null) => void;
  };
}

/** 選ばれたファイル(`File` が満たす。Blob 互換で、名前を持つ)。Issue #222。 */
export type PickedFile = Blob & { readonly name: string };

export function h(tag: string, attrs: Readonly<Record<string, AttrValue>> = {}, children: readonly (VNode | string)[] = [], on?: VNode["on"]): VNode {
  return on === undefined ? { tag, attrs, children } : { tag, attrs, children, on };
}
