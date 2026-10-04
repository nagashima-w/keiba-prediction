/**
 * SQLite バックエンドの Durable Object(Issue #159〈#21-A〉)。
 *
 * ドキュメント上、SQLite バックエンドの DO は CPU 30 秒/リクエストだが、limits のページに Free/Paid の
 * 区別が書かれていない。これが Free プランで本当に成り立つかを、普通の Worker と同じ処理を同じ反復回数で
 * 動かして比べる(本スパイクの最重要の問い)。`limits.cpu_ms` は設定せず、既定の上限を測る。
 */

import { DurableObject } from "cloudflare:workers";
import { handleCpu, json } from "./router.js";

export class SpikeDO extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
