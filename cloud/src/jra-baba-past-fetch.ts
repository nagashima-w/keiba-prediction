/**
 * JRA の過去の含水率・クッション値(年の頁と PDF)を 1 本取る取得口(Issue #769)。`jra-baba-past-backfill-do.ts` が 1 箇所だけで作る。
 * 年の頁は `GET /keiba/baba/archive/{年}.html`(Shift_JIS)、PDF は `GET /keiba/baba/archive/{年}pdf/{場}{回}.pdf`(バイト列のまま)。部品は `jra-http.ts` の `fetchOne`
 * (1 本 1 回・再試行なし・リダイレクトを追わない・タイムアウト 10 秒・例外のメッセージを残さない)。間隔は呼び出し側(`jra-baba-past-backfill-core.ts`)が守る。URL・本文はログに出さない。
 * 本文の上限: 年の頁は既定の {@link JRA_MAX_BODY_BYTES}(256KB。取った頁は約 71KB)、PDF は {@link BABA_PAST_MAX_PDF_BYTES}(1MB。取った PDF は 35〜45KB)。
 * グローバルの `fetch` を呼ぶのは、`deps.fetch` を省いたときの既定の 1 箇所だけ。
 */
import type { BabaPastPdfOutcome, BabaPastYearOutcome } from "./jra-baba-past-backfill-core";
import { BABA_PAST_MAX_PDF_BYTES } from "./jra-baba-past-pdf";
import { babaPastPdfUrl, babaPastYearUrl, decodeShiftJis, fetchOne, JRA_TIMEOUT_MS, type JraFetchLike } from "./jra-http";

export interface CreateJraBabaPastFetcherDeps {
  readonly fetch?: JraFetchLike;
  readonly timeoutMs?: number;
}

export interface JraBabaPastFetcher {
  fetchYear(year: number): Promise<BabaPastYearOutcome>;
  fetchPdf(path: string): Promise<BabaPastPdfOutcome>;
}

/** 年の頁から読んだ PDF の名前の形(`2021pdf/tokyo01.pdf`)。ほかの形は URL に使わない。 */
const PDF_PATH = /^\d{4}pdf\/[a-z]+\d{2}\.pdf$/;

export function createJraBabaPastFetcher(deps: CreateJraBabaPastFetcherDeps = {}): JraBabaPastFetcher {
  const fetchFn: JraFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const timeoutMs = deps.timeoutMs ?? JRA_TIMEOUT_MS;
  const init: RequestInit = {};
  return {
    async fetchYear(year) {
      if (!Number.isInteger(year) || year < 1000 || year > 9999) return { kind: "failed", reason: "http-400" };
      const fetched = await fetchOne(fetchFn, babaPastYearUrl(year), init, timeoutMs);
      const status = fetched.summary.status;
      if (typeof status !== "number") return { kind: "failed", reason: status };
      if (status !== 200 || fetched.body === null) return { kind: "failed", reason: `http-${status}` };
      try {
        return { kind: "page", html: decodeShiftJis(fetched.body) };
      } catch {
        return { kind: "failed", reason: "http-200" };
      }
    },
    async fetchPdf(path) {
      if (!PDF_PATH.test(path)) return { kind: "failed", reason: "http-400" };
      const fetched = await fetchOne(fetchFn, babaPastPdfUrl(path), init, timeoutMs, BABA_PAST_MAX_PDF_BYTES);
      const status = fetched.summary.status;
      if (typeof status !== "number") return { kind: "failed", reason: status };
      if (status !== 200 || fetched.body === null) return { kind: "failed", reason: `http-${status}` };
      return { kind: "pdf", bytes: fetched.body };
    },
  };
}
