/**
 * SQLite バックエンドの Durable Object(Issue #159〈#21-A〉)。
 *
 * ドキュメント上、SQLite バックエンドの DO は CPU 30 秒/リクエストだが、limits のページに Free/Paid の
 * 区別が書かれていない。これが Free プランで本当に成り立つかを、普通の Worker と同じ処理を同じ反復回数で
 * 動かして比べる(本スパイクの最重要の問い)。`limits.cpu_ms` は設定せず、既定の上限を測る。
 */

import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";
import { handleNetkeibaSocket } from "./origin-handlers.js";
import { handleCpu, json } from "./router.js";

export class SpikeDO extends DurableObject {
  /** このインスタンスの識別子(コンストラクタで作る乱数)。同じインスタンスで再取得したかを事実として残すため。 */
  private readonly instanceId = crypto.randomUUID();
  /** このインスタンスが受けた `/do/netkeiba-socket` の呼び出し回数。 */
  private socketCalls = 0;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/do/noop") {
      // Worker から DO を繰り返し呼ぶ試験(subrequest の数え方。netkeiba へは出ない)用の、何もしない応答。
      return new Response("ok");
    }
    if (url.pathname === "/do/netkeiba-socket" && request.method === "POST") {
      // Issue #162 段階1: DO の中から、ソケットで netkeiba を1本取得する(入力検査は handleNetkeibaSocket が行う)。
      this.socketCalls += 1;
      return handleNetkeibaSocket(request, connect, { id: this.instanceId, call: this.socketCalls });
    }
    if (url.pathname === "/do/ping") {
      // SQLite バックエンドで動いていることの確認(ctx.storage.sql が使える)。
      // sqlite_version() 等の関数は DO の SQLite では許可されていない(スモークテストで判明)。
      const rows = this.ctx.storage.sql.exec("SELECT 1 + 1 AS two").toArray();
      return json({ ok: true, runtime: "durableObject", sqliteOk: rows[0]?.["two"] === 2 });
    }
    const match = /^\/do\/cpu\/([^/]+)$/.exec(url.pathname);
    if (match) {
      // 処理のあとに挟む I/O: ストレージの読み(時計が進む契機になる)。
      return handleCpu("durableObject", match[1]!, url, () => this.ctx.storage.get("spike-io"));
    }
    return json({ ok: false, error: "not found" }, 404);
  }
}
