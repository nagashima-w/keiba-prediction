/**
 * 騎手・調教師の指標の一覧(`#edges`。Issue #644)の表示用データ(純関数)。`view.ts` がこれを VNode にする。
 * 行はサーバの並び(指標の大きい順)のまま。値は #643 の結果画面と同じ `signedPtText`(「+3.0pt」)、3着内率・市場の予測は %。
 * 件数が少ない人(`MARKET_EDGE_FEW_N` 未満)は `few`(画面は薄い字と「少」)。
 */
import type { EdgeKind, MarketEdgesData } from "./api-market-edges";
import { MARKET_EDGE_FEW_N, signedPtText } from "./result";
import { buildEdgesHash } from "./route";

export interface EdgesRow {
  readonly rank: number;
  readonly name: string;
  readonly value: string;
  readonly n: string;
  readonly few: boolean;
  readonly hit: string;
  readonly pred: string;
}

export interface EdgesModel {
  readonly kind: "edges";
  /** 一覧のトップへ戻るリンク先。 */
  readonly backHref: string;
  /** 騎手/調教師の切り替え(今のほうが current)。 */
  readonly tabs: readonly { readonly label: string; readonly href: string; readonly current: boolean }[];
  readonly loading: boolean;
  readonly error: string | null;
  /** サーバの注記(取れていなければ null)。 */
  readonly note: string | null;
  readonly rows: readonly EdgesRow[];
}

export interface EdgesModelInput {
  readonly kind: EdgeKind;
  readonly data: MarketEdgesData | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly backHref: string;
}

const percent = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function buildMarketEdgesModel(input: EdgesModelInput): EdgesModel {
  return {
    kind: "edges",
    backHref: input.backHref,
    tabs: [
      { label: "騎手", href: buildEdgesHash("jockey"), current: input.kind === "jockey" },
      { label: "調教師", href: buildEdgesHash("trainer"), current: input.kind === "trainer" },
    ],
    loading: input.loading,
    error: input.error,
    note: input.data === null ? null : input.data.note,
    rows: (input.data?.rows ?? []).map((r, i) => ({ rank: i + 1, name: r.name, value: signedPtText(r.edge), n: String(r.n), few: r.n < MARKET_EDGE_FEW_N, hit: percent(r.hitRate), pred: percent(r.predMean) })),
  };
}
