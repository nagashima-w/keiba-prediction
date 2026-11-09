/**
 * JRA の過去の結果(過去検索・月の頁・場日の頁・結果の頁)を 1 本取る取得口(Issue #698)。`jra-blinker-backfill-do.ts` が 1 箇所だけで作る。
 * `POST accessS.html`、本文 `cname=<cname>`。部品は `jra-http.ts` の `fetchOne`(1 本 1 回・再試行なし・リダイレクトを追わない・タイムアウト 10 秒・例外のメッセージを残さない)。
 * 本文の上限は既定の {@link JRA_MAX_BODY_BYTES}(256KB。取った最大は 97KB 前後)。間隔は呼び出し側(`jra-blinker-backfill-core.ts`)が守る。URL・本文はログに出さない。
 * グローバルの `fetch` を呼ぶのは、`deps.fetch` を省いたときの既定の 1 箇所だけ。
 */
import type { ResultFetchOutcome } from "./jra-blinker-backfill-core";
import { decodeShiftJis, fetchOne, JRA_ACCESS_S_URL, JRA_TIMEOUT_MS, type JraFetchLike } from "./jra-http";

export interface CreateJraResultFetcherDeps {
  readonly fetch?: JraFetchLike;
  readonly timeoutMs?: number;
}

export function createJraResultFetcher(deps: CreateJraResultFetcherDeps = {}): (cname: string) => Promise<ResultFetchOutcome> {
  const fetchFn: JraFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const timeoutMs = deps.timeoutMs ?? JRA_TIMEOUT_MS;
  return async (cname) => {
    const init: RequestInit = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `cname=${cname}` };
    const fetched = await fetchOne(fetchFn, JRA_ACCESS_S_URL, init, timeoutMs);
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
