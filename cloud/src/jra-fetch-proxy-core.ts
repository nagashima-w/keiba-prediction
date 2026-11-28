/**
 * JRA への取得の中継(Issue #815)の純ロジック。DO のラッパ(`jra-fetch-proxy-do.ts`)と、開催日の DO(呼ぶ側)が使う。Node でテストできる(`cloudflare:workers` を持たない)。
 *
 * ## 目的
 * 開催日の DO は作られた拠点に固定され、アムステルダムの DO から JRA の公式サイトへの取得が手前の防御(Akamai)に 403 で弾かれた(#804)。
 * そこで JRA への取得だけを、`locationHint: "apac"` で新しく作った別の小さな DO(中継。単一インスタンス)から出す。
 *
 * ## 守ること
 *  - 行き先は許可リストだけ: JRA の公式サイトのホスト(https。認証情報・ポート指定なし)と、`cdn-cgi/trace`(GET だけ。拠点の確認。`COLO_TRACE_URL`)。ほかは外へ出さず 403。
 *  - メソッドは GET と POST だけ(ほかは 405)。リダイレクトは追わない(`redirect: "manual"`。3xx はそのまま返す)。
 *  - 渡すヘッダは content-type・user-agent・accept・accept-language だけ(cookie・認証は渡さない)。応答の状態・ヘッダ・本文は変えずに返す。
 *  - 中継の側でも {@link JRA_TIMEOUT_MS} で切る(応答の待ちと本文の読み出しの合計。呼ぶ側の AbortSignal は DO 越しに効かないかもしれないため)。大きさの上限は呼ぶ側の読み取り(`fetchOne`)が守る。
 *  - 間隔(`createJraPacer`)・呼ぶ側のタイムアウト・#804 の分類は、今までどおり開催日の DO 側で動く。
 */
import { COLO_TRACE_URL } from "./jra-colo";
import { JRA_CUSHION_URL, JRA_TIMEOUT_MS, type JraFetchLike } from "./jra-http";

/** 中継の DO の名前(単一インスタンス)。 */
export const JRA_FETCH_PROXY_NAME = "main";

/** 中継を使うか(Worker の var `JRA_FETCH_VIA_PROXY`)。**文字列 `"1"`(前後の空白は無視)だけ**が使う。未設定・`"0"`・それ以外は今までどおり直接 fetch する。 */
export function isJraFetchViaProxy(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "1";
}

/** JRA の公式サイトのホスト(既存の取得先の定数から取る。ホストを二重に書かない)。 */
const JRA_HOST = new URL(JRA_CUSHION_URL).hostname;
/** 拠点の確認(`cdn-cgi/trace`。`jra-colo.ts` の定数から取る)のホストとパス。 */
const TRACE_HOST = new URL(COLO_TRACE_URL).hostname;
const TRACE_PATH = new URL(COLO_TRACE_URL).pathname;
/** 外へ渡す要求のヘッダ(小文字)。 */
const FORWARD_REQUEST_HEADERS = ["content-type", "user-agent", "accept", "accept-language"] as const;

export type ProxyCheck = { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly status: 403 | 405; readonly reason: string };

/** 行き先とメソッドを検査する。許可は上のとおり。 */
export function checkProxyTarget(rawUrl: string, method: string): ProxyCheck {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "POST") {
    return { ok: false, status: 405, reason: "method" };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 403, reason: "url" };
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return { ok: false, status: 403, reason: "scheme" };
  }
  if (url.hostname === JRA_HOST) {
    return { ok: true, url };
  }
  if (url.hostname === TRACE_HOST && url.pathname === TRACE_PATH && m === "GET") {
    return { ok: true, url };
  }
  return { ok: false, status: 403, reason: "host" };
}

function denied(status: number, reason: string): Response {
  return new Response(`jra-fetch-proxy: ${reason}`, { status, headers: { "x-jra-fetch-proxy": "denied", "content-type": "text/plain; charset=utf-8" } });
}

/**
 * 中継の本体。受けた要求を検査して外へ 1 回出し、応答を返す。投げない(上流の失敗は 502、時間切れは 504)。
 * 時間切れは応答の待ちと本文の読み出しの合計で、本文はタイムアウトの信号で中断する(`fetch` に渡した信号が本文の読み出しにも効く)。
 */
export async function handleProxyRequest(request: Request, fetchFn: JraFetchLike, timeoutMs: number = JRA_TIMEOUT_MS): Promise<Response> {
  const checked = checkProxyTarget(request.url, request.method);
  if (!checked.ok) {
    return denied(checked.status, checked.reason);
  }
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v !== null) {
      headers.set(name, v);
    }
  }
  const isPost = request.method.toUpperCase() === "POST";
  const init: RequestInit = {
    method: isPost ? "POST" : "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    ...(isPost ? { body: await request.text() } : {}),
  };
  try {
    const upstream = await fetchFn(checked.url.toString(), init);
    return new Response(withDeadline(upstream.body, init.signal as AbortSignal), { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return denied(name === "TimeoutError" || name === "AbortError" ? 504 : 502, name === "TimeoutError" || name === "AbortError" ? "timeout" : "upstream");
  }
}

/** 本文を、信号が中断したらエラーで終える流れに包む(応答の待ちに掛けた時間切れが本文の読み出しにも効くようにする。信号を無視する fetch でも切れる)。 */
function withDeadline(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): ReadableStream<Uint8Array> | null {
  if (body === null) {
    return null;
  }
  const reader = body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => undefined);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) {
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** 呼ぶ側が持つ、中継の stub の使う部分だけの型。 */
export interface ProxyStubLike {
  fetch(request: Request): Promise<Response>;
}

/**
 * 開催日の DO の取得口(`fetchOne` など)に差し込む fetch を、中継の stub から作る。url・メソッド・本文・ヘッダを Request にして stub に渡し、応答をそのまま返す。
 * 呼ぶ側の信号は stub には渡さず(DO 越しに効く保証がない)、ここで中断を待って投げる(中断の理由で。`fetchOne` の分類が名前を見る)。
 */
export function createProxyFetch(stub: ProxyStubLike): JraFetchLike {
  return async (url, init) => {
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const request = new Request(url, {
      method: init.method ?? "GET",
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
      redirect: "manual",
    });
    const pending = stub.fetch(request);
    if (signal === undefined) {
      return pending;
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (r) => {
          signal.removeEventListener("abort", onAbort);
          resolve(r);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  };
}

export interface ResolveJraFetchDeps<N> {
  /** var `JRA_FETCH_VIA_PROXY` の値。 */
  readonly viaProxyVar: string | undefined;
  /** 中継の DO の名前空間(binding)。無い構成は undefined。 */
  readonly namespace: N | undefined;
  /** 名前空間から中継の stub を作る(本番は `doStub` に固定名 `JRA_FETCH_PROXY_NAME`。locationHint apac はそこで付く)。var が "1" で binding があるときだけ呼ぶ。 */
  readonly makeStub: (namespace: N) => ProxyStubLike;
  /** 直接の fetch(本番はグローバルの `fetch`)。 */
  readonly direct: JraFetchLike;
  readonly warn: (message: string) => void;
}

/** 開催日の DO が JRA への取得(馬場・オッズ・拠点の確認)に使う fetch を決める。var が "1" で binding があれば中継の stub 経由、それ以外は直接。"1" で binding が無いときは警告 1 行を出して直接。 */
export function resolveJraFetch<N>(deps: ResolveJraFetchDeps<N>): { readonly fetch: JraFetchLike; readonly via: "proxy" | "direct" } {
  if (!isJraFetchViaProxy(deps.viaProxyVar)) {
    return { fetch: deps.direct, via: "direct" };
  }
  if (deps.namespace === undefined) {
    deps.warn("JRA_FETCH_VIA_PROXY が 1 ですが、JRA_FETCH_PROXY の binding が無いので、JRA へは直接取得します");
    return { fetch: deps.direct, via: "direct" };
  }
  return { fetch: createProxyFetch(deps.makeStub(deps.namespace)), via: "proxy" };
}
