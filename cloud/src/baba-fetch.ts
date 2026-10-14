/**
 * 馬場の API を取りに行く入口(Issue #294〈#293-A〉)。Worker の secret `BABA_API_URL` の検証と、1 回の GET。
 *
 * **URL の値は、ここで作るクロージャの外に出ない**: `RaceDayCore` が受け取るのは「本文を返す関数」だけで、URL そのものを持たない
 * (`notify-send.ts` の Discord の Webhook と同じ流儀)。したがって DO の状態・ログ・応答に URL が入る経路が構造的に無い。URL は外部の API の URL で、リポジトリが public のため、リポジトリにも書かない。
 * 失敗は {@link BabaFetchError} の分類(`timeout`・`network`・`http-<status>`・`redirect`・`too-large`)だけを残し、例外のメッセージ・応答の本文は残さない。
 *
 * 利用の条件は「JRA の開催日に、利用者全体で 1 日 1 回」。**ここでは再送も追跡もしない**:
 *  - 1 回の呼び出しで fetch は 1 回だけ。再試行しない。
 *  - リダイレクトは追わない(`redirect: "manual"`)。追うと、追った先への 2 回目のアクセスになりうる。3xx は `redirect` の失敗にする。
 *  - タイムアウトは {@link BABA_TIMEOUT_MS}(本文の読み出しも含む)。本文は {@link BABA_MAX_BODY_BYTES} まで(超えたら打ち切って `too-large`)。
 * netkeiba 用の gate(1.5 秒間隔・ブレーカー・許可リスト)は通さない(gate の許可リストは netkeiba のホストだけで、この API は netkeiba ではない)。
 */
import { BabaFetchError, type BabaFetcher, type BabaResultClass } from "./baba-conditions";
export type { BabaFetcher };

/** 1 回の取得のタイムアウト(ミリ秒)。応答の待ちと本文の読み出しの合計。 */
export const BABA_TIMEOUT_MS = 10_000;
/** 本文の上限(バイト)。 */
export const BABA_MAX_BODY_BYTES = 256 * 1024;

/** 注入できる fetch(Worker のグローバル `fetch` のうち使う部分)。 */
export type BabaFetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** secret の状態。`absent` = 未登録・空白だけ / `invalid` = 登録されているが https の URL として使えない / `valid` = 使える。 */
export type BabaUrlStatus = "absent" | "invalid" | "valid";

function parseUrl(raw: string | undefined): { status: BabaUrlStatus; url?: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { status: "absent" };
  }
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { status: "invalid" };
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "" || parsed.username !== "" || parsed.password !== "") {
    return { status: "invalid" };
  }
  return { status: "valid", url: text };
}

/** secret の値(未登録なら undefined)から状態を決める。値は返さない。 */
export function babaUrlStatus(raw: string | undefined): BabaUrlStatus {
  return parseUrl(raw).status;
}

export interface CreateBabaFetcherDeps {
  /** 送信に使う fetch。省略時はグローバルの `fetch`(Worker)。テストで差し替える。 */
  readonly fetch?: BabaFetchLike;
  /** タイムアウト(ミリ秒)。省略時は {@link BABA_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
}

/** fetch が投げた例外の分類。名前だけを見る(メッセージは URL を含みうるので読まない・残さない)。 */
function classifyThrown(error: unknown): BabaResultClass {
  const name = error instanceof Error || (typeof error === "object" && error !== null && "name" in error) ? String((error as { name: unknown }).name) : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

/** 本文を上限まで読む。上限を超えたら打ち切って `too-large`。読み出しの失敗は分類して投げ直す。 */
async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BABA_MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new BabaFetchError("too-large");
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > BABA_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new BabaFetchError("too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BabaFetchError) {
      throw error;
    }
    throw new BabaFetchError(classifyThrown(error));
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/**
 * secret の値から取得口を作る。**未登録・https の URL でないなら undefined**(機能全体を止める。印も書かない)。
 */
export function createBabaFetcher(raw: string | undefined, deps: CreateBabaFetcherDeps = {}): BabaFetcher | undefined {
  const parsed = parseUrl(raw);
  if (parsed.status !== "valid") {
    return undefined;
  }
  const url = parsed.url as string;
  const fetchFn: BabaFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const timeoutMs = deps.timeoutMs ?? BABA_TIMEOUT_MS;
  return async () => {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(url, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal });
    } catch (error) {
      throw new BabaFetchError(classifyThrown(error));
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new BabaFetchError("redirect");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new BabaFetchError(`http-${response.status}`);
    }
    return readBody(response);
  };
}
