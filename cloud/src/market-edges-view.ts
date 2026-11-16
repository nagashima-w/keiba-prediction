/**
 * 騎手・調教師の指標の一覧(`GET /api/market-edges`。Issue #644。指標の作り方は #642、`market-edge-calc.ts`)の応答の組み立て(純関数)。
 *
 *  - 並びは指標の大きい順。同点は件数の多い順、それも同じなら ID の昇順(決まった順。クライアントは並べ替えない)。
 *  - 文(注記)はここで組み立てる(クライアントの束に日本語を置くと、`\uXXXX` で 1 文字 6 バイトになるため)。値の整形(「+3.0pt」)と「少」の判定(件数)は画面側。
 *  - 計算前(`market_edge_meta` が無い)は行を返さず、「まだ計算していません」の文を返す。
 *  - 名前が無い人は ID を名前の代わりに返す(画面に空の名前を出さない)。ID を別の項目としては返さない。
 */
import type { MarketEdgeMeta, StoredMarketEdge } from "./market-edge-repository";

export type MarketEdgeKind = "jockey" | "trainer";

export interface MarketEdgesRow {
  readonly name: string;
  readonly edge: number;
  readonly n: number;
  readonly hit_rate: number;
  readonly pred_mean: number;
}

export interface MarketEdgesView {
  readonly ok: true;
  readonly kind: MarketEdgeKind;
  readonly note: string;
  readonly rows: readonly MarketEdgesRow[];
}

const NOT_READY_NOTE = "まだ計算していません。毎晩の計算(JST 3:00 以降)が終わると、ここに一覧が出ます。参考(確かめ中)の値で、分析(LLM・配分)には使いません。";

function noteOf(meta: MarketEdgeMeta): string {
  return (
    `この一覧は参考(確かめ中)です。時期を分けて確かめた値ではなく、分析(LLM・配分)には使っていません。` +
    `指標は、${meta.windowFrom}〜${meta.windowTo} の中央のレースで、その騎手(調教師)の馬が、単勝オッズから見込まれる3着内の確率より何ポイント多く3着内に来たかです` +
    `(+3.0pt なら、100 回で約 3 回多い)。件数が少ないほど 0 に寄せてあります(「少」の印は 50 回未満)。` +
    `3着内率は実際の3着内の割合、市場の予測は単勝オッズから見込まれる3着内の確率の平均です。` +
    `値は ${meta.computedOn} に計算したものです。芝・ダート別や競馬場別の値はありません(掛け合わせは偶然と区別できる上乗せが見つからなかったため作っていません)。`
  );
}

export function buildMarketEdgesView(kind: MarketEdgeKind, edges: readonly StoredMarketEdge[], meta: MarketEdgeMeta | null): MarketEdgesView {
  if (meta === null) return { ok: true, kind, note: NOT_READY_NOTE, rows: [] };
  const sorted = [...edges].sort((a, b) => b.edge - a.edge || b.n - a.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ok: true,
    kind,
    note: noteOf(meta),
    rows: sorted.map((e) => ({ name: e.name ?? e.id, edge: e.edge, n: e.n, hit_rate: e.hitRate, pred_mean: e.predMean })),
  };
}
