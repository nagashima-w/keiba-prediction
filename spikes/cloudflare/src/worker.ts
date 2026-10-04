/**
 * Cloudflare 移行スパイク(Issue #159〈#21-A〉・#160〈#21-B〉)の Worker。実測のためだけの使い捨てで、
 * 実行ごとに GitHub Actions がデプロイし、終了時に削除する(本番コードではない)。
 *
 * **公開 URL になるため、すべてのリクエストに共有秘密(`x-spike-secret`)を要求する。** 一致しなければ
 * 何もせず 403 を返す。秘密は実行ごとにランダムに生成し、`wrangler deploy --secrets-file` で渡す。
 */

import { connect } from "cloudflare:sockets";
import iconv from "iconv-lite";
import { HttpClient } from "../../../packages/core/src/scraper/http-client.js";
import { isAuthorized } from "../../../scripts/cloudflare-spike/auth.js";
import { handleEcho, handleNetkeibaSocket } from "./origin-handlers.js";
import { handleCpu, handleNetkeiba, json } from "./router.js";

export { SpikeDO } from "./do.js";

export interface Env {
  /** 共有秘密。未設定なら誰も認可されない(isAuthorized が false を返す)。 */
  SPIKE_SECRET?: string;
  SPIKE_DO: DurableObjectNamespace;
}

/**
 * EUC-JP のデコードの確認(ネットワークを使わない)。日本語を EUC-JP にエンコードし、core の
 * `HttpClient.fetchText({encoding:"euc-jp"})` で戻して一致するかを見る。
 * `iconv-lite` は Buffer に依存するため、Workers の `nodejs_compat` で動くかの確認になる。
 */
async function selftestEucJp(): Promise<{ roundTrip: boolean; decoded: string }> {
  const original = "競馬 出馬表 ラジオＮＩＫＫＥＩ賞 馬体重 ダート";
  const bytes = iconv.encode(original, "euc-jp");
  const client = new HttpClient({
    minIntervalMs: 0,
    maxRetries: 0,
    fetch: async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "text/html" } }),
  });
  const decoded = await client.fetchText("https://selftest.invalid/", { encoding: "euc-jp" });
  return { roundTrip: decoded === original, decoded };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request.headers.get("x-spike-secret"), env.SPIKE_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ping") {
        return json({ ok: true, runtime: "worker" });
      }
      if (url.pathname === "/selftest/euc-jp") {
        return json({ ok: true, ...(await selftestEucJp()) });
      }
      if (url.pathname === "/netkeiba" && request.method === "POST") {
        return await handleNetkeiba(request);
      }
      // Issue #160: 400 の原因の切り分け。/echo はヘッダの観測(netkeiba へは出ない。宛先は固定表)、
      // /netkeiba-socket は TCP ソケットでの取得(E3)。
      if (url.pathname === "/echo" && request.method === "POST") {
        return await handleEcho(request);
      }
      if (url.pathname === "/netkeiba-socket" && request.method === "POST") {
        return await handleNetkeibaSocket(request, connect);
      }
      const cpu = /^\/cpu\/([^/]+)$/.exec(url.pathname);
      if (cpu && request.method === "POST") {
        // 処理のあとに挟む I/O: Cache API の参照(外部へは出ない。時計が進む契機になる)。
        return await handleCpu("worker", cpu[1]!, url, () => caches.default.match("https://spike.invalid/io"));
      }
      if (url.pathname === "/do/ping" || /^\/do\/cpu\/[^/]+$/.test(url.pathname)) {
        const stub = env.SPIKE_DO.get(env.SPIKE_DO.idFromName("spike"));
        try {
          // 前面の Worker は薄く保つ。DO 側の CPU 超過などの例外はここで捕まえ、本文に載せて返す。
          return await stub.fetch(new Request(request.url, { method: request.method }));
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
