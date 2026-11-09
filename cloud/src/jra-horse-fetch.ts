/**
 * JRA の馬ごとの頁を 1 本取る取得口(Issue #697)。`jra-horse-backfill-do.ts` が 1 箇所だけで作る。
 * 部品は `jra-http.ts` の `fetchOne`(1 本 1 回・再試行なし・リダイレクトを追わない・タイムアウト 10 秒・例外のメッセージを残さない)。本文の上限は {@link JRA_ENTRY_MAX_BODY_BYTES}(1MB。
 * 馬の頁は 1 走で約 1KB 増え、100 走を超える馬は 256KB に近づく)。間隔は呼び出し側(`jra-horse-backfill-core.ts`)が守る。
 * グローバルの `fetch` を呼ぶのは、`deps.fetch` を省いたときの既定の 1 箇所だけ。
 */
import type { HorseFetchOutcome } from "./jra-horse-backfill-core";
import { decodeShiftJis, fetchOne, JRA_ACCESS_U_URL, JRA_ENTRY_MAX_BODY_BYTES, JRA_TIMEOUT_MS, type JraFetchLike } from "./jra-http";

export interface CreateJraHorseFetcherDeps {
  readonly fetch?: JraFetchLike;
  readonly timeoutMs?: number;
}

export function createJraHorseFetcher(deps: CreateJraHorseFetcherDeps = {}): (horseId: string, suffix: string) => Promise<HorseFetchOutcome> {
  const fetchFn: JraFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const timeoutMs = deps.timeoutMs ?? JRA_TIMEOUT_MS;
  return async (horseId, suffix) => {
    const url = `${JRA_ACCESS_U_URL}?CNAME=pw01dud10${horseId}/${suffix}`;
    const fetched = await fetchOne(fetchFn, url, { method: "GET" }, timeoutMs, JRA_ENTRY_MAX_BODY_BYTES);
    const status = fetched.summary.status;
    if (typeof status !== "number") return { kind: "failed", reason: status };
    if (status !== 200 || fetched.body === null) return { kind: "failed", reason: "http" };
    try {
      return { kind: "page", html: decodeShiftJis(fetched.body) };
    } catch {
      return { kind: "failed", reason: "http" };
    }
  };
}
