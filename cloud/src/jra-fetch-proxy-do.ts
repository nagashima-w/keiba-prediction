/**
 * JRA への取得の中継の Durable Object `JraFetchProxy`(SQLite バックエンド。単一インスタンス〈`doStub` に固定名 `JRA_FETCH_PROXY_NAME`。Issue #815〉)。
 *
 * ロジックは `jra-fetch-proxy-core.ts`(許可リスト・タイムアウト)。ここは本物の `fetch` を渡すだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。
 * 状態は持たない(SQLite は migration の都合。クラス名は migration v19 に固定される)。`doStub` が `locationHint: "apac"` を付けて作るので、新しく作られるこの DO は日本に近い拠点に置かれる(希望であって保証ではない)。
 * 呼ぶのは開催日の DO(`race-day-do.ts`。var `JRA_FETCH_VIA_PROXY` が `"1"` のとき)だけ。
 */
import { DurableObject } from "cloudflare:workers";
import { handleProxyRequest } from "./jra-fetch-proxy-core";

export class JraFetchProxy extends DurableObject {
  fetch(request: Request): Promise<Response> {
    return handleProxyRequest(request, (url, init) => fetch(url, init));
  }
}
