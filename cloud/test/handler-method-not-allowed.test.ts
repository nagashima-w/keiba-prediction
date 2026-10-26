import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { EMAIL, GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #445(G-3 の 10): handler.ts の 405(`method not allowed`)は、19 か所の `new Response(…)` を 1 つの関数にまとめた。
 * その前後でバイト単位で変わらないことの特性テスト(**まとめる前のコードで緑**)。19 か所を 1 件ずつ踏み、ステータス・本文・ヘッダ(固定の 5 つ。
 * 値は 4 つの固定ヘッダ + `allow`)を完全一致で固定する。裏側(DO・D1・R2)は 1 つも渡さない(405 は何にも触れずに返す)。
 */

const ORIGIN = "https://cloud.invalid";

/** 19 か所を 1 件ずつ踏む表。`method` は、そのパスで 405 になるメソッド(GET だけのルートは、先の関門〈GET・HEAD 以外は 405〉を通る HEAD)。 */
const SITES: readonly { readonly site: string; readonly method: string; readonly path: string; readonly allow: string }[] = [
  { site: "設定", method: "DELETE", path: "/api/settings", allow: "GET, POST" },
  { site: "GET・HEAD 以外の関門", method: "PUT", path: "/", allow: "GET, HEAD" },
  { site: "確認フォーム", method: "HEAD", path: "/api/netkeiba/check", allow: "GET" },
  { site: "日報の作成", method: "GET", path: "/api/reports/run", allow: "POST" },
  { site: "日報の一覧", method: "HEAD", path: "/api/reports", allow: "GET" },
  { site: "月報の作成", method: "GET", path: "/api/monthly-reports/run", allow: "POST" },
  { site: "月報の一覧", method: "HEAD", path: "/api/monthly-reports", allow: "GET" },
  { site: "検証", method: "HEAD", path: "/api/verify", allow: "GET" },
  { site: "統計モデル用の書き出し", method: "HEAD", path: "/api/export/prior-dataset", allow: "GET" },
  { site: "配分の再計算用の書き出し", method: "HEAD", path: "/api/export/allocation-dataset", allow: "GET" },
  { site: "戦績の診断", method: "HEAD", path: "/api/horse-runs", allow: "GET" },
  { site: "馬場の取得の診断", method: "HEAD", path: "/api/baba-fetch", allow: "GET" },
  { site: "結果の補完", method: "HEAD", path: "/api/results/backfill", allow: "GET" },
  { site: "分析の状態", method: "HEAD", path: "/api/analyses/status", allow: "GET" },
  { site: "計画", method: "HEAD", path: "/api/plan", allow: "GET" },
  { site: "今日の狙い目", method: "HEAD", path: "/api/targets", allow: "GET" },
  { site: "レース一覧", method: "HEAD", path: "/api/races", allow: "GET" },
  { site: "分析の実行", method: "GET", path: "/api/analyses/run", allow: "POST" },
  { site: "分析の一覧", method: "HEAD", path: "/api/analyses", allow: "GET" },
  { site: "分析の詳細", method: "HEAD", path: "/api/analyses/1", allow: "GET" },
];

describe("handler.ts の 405: 20 か所すべて(Issue #463 で配分の再計算用の書き出しが加わり 19 → 20)が、ステータス・本文・ヘッダを変えずに返す(Issue #445)", () => {
  it("前提: 表は 20 件で、パスとメソッドの組が重複しない(1 か所ずつ踏んでいる)", () => {
    expect(SITES).toHaveLength(20);
    expect(new Set(SITES.map((s) => `${s.method} ${s.path}`)).size).toBe(20);
  });

  it.each(SITES)("$site($method $path): 405・本文 method not allowed・ヘッダ 5 つ(allow: $allow)", async ({ method, path, allow }) => {
    const key = await makeKey("k1");
    const token = await signToken(key, { email: EMAIL });
    const env = GOOD_ENV as unknown as Env;
    const response = await handle(
      new Request(`${ORIGIN}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": token } }),
      env,
      {},
      { keys: () => localKeys(key), now: () => NOW, log: () => {} },
    );
    expect(response.status).toBe(405);
    // HEAD の応答は本文を持たない(Response の仕様)ので、本文は HEAD 以外でだけ見る
    if (method !== "HEAD") {
      expect(await response.text()).toBe("method not allowed");
    }
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      allow,
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });
});
