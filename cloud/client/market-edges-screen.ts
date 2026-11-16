/**
 * 騎手・調教師の指標の一覧の画面(`#edges`。Issue #644)の制御。取得だけ(タイマー・自動の取り直しは無い。値は毎晩の計算のもの)。
 * DOM・fetch は注入する(Node でテストできる)。画面ごとの状態を closure に持ち、画面を離れたら破棄する(`app.ts` が `enter`・`leave` を呼ぶ)。
 *
 *  - 開く(`enter(kind)`): `GET /api/market-edges?kind=…` を 1 回(D1 の読み取りだけ)。同じ kind で重ねて呼んでも取得は増えない。「更新」(`onRefresh`)は取得中は無視。
 *  - 最初の取得の失敗は固定の文言(`failureMessage`)で、自動では再試行しない。
 *  - 世代(`gen`)と通し番号(`seq`): 離れる・開き直す・kind を変えるたびに進め、古い応答は反映しない。
 */
import { failureMessage } from "./api";
import { fetchMarketEdges, type EdgeKind, type MarketEdgesData } from "./api-market-edges";
import { buildMarketEdgesModel, type EdgesModel } from "./market-edges-model";

export interface MarketEdgesScreenDeps {
  readonly fetch: Parameters<typeof fetchMarketEdges>[0];
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
}

export interface MarketEdgesScreen {
  enter(kind: EdgeKind): void;
  leave(): void;
  onRefresh(): void;
  /** 画面に居ないとき null。 */
  model(backHref: string): EdgesModel | null;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

export function createMarketEdgesScreen(deps: MarketEdgesScreenDeps): MarketEdgesScreen {
  let kind: EdgeKind | null = null;
  let data: MarketEdgesData | null = null;
  let error: string | null = null;
  let busy = false;
  let seq = 0;
  const inflight = new Set<Promise<unknown>>();

  function fetchOnce(): void {
    if (kind === null) return;
    const target = kind;
    seq += 1;
    const mySeq = seq;
    busy = true;
    deps.onChange();
    const p: Promise<unknown> = fetchMarketEdges(deps.fetch, target).then((result) => {
      inflight.delete(p);
      if (mySeq !== seq) return; // 離れた・開き直した・kind が変わった(古い応答)
      busy = false;
      if (result.ok) {
        data = result.data;
        error = null;
      } else {
        error = failureMessage(result.error);
      }
      deps.onChange();
    });
    inflight.add(p);
  }

  return {
    enter(next) {
      if (kind === next) return;
      kind = next;
      data = null;
      error = null;
      fetchOnce();
    },
    leave() {
      kind = null;
      data = null;
      error = null;
      busy = false;
      seq += 1;
    },
    onRefresh() {
      if (kind !== null && !busy) fetchOnce();
    },
    model(backHref) {
      return kind === null ? null : buildMarketEdgesModel({ kind, data, error, loading: busy, backHref });
    },
    pending() {
      return [...inflight];
    },
  };
}
