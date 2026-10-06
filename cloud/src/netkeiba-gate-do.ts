/**
 * SQLite バックエンドの Durable Object の雛形(Issue #161〈#21-C〉)。
 *
 * #162 で、netkeiba への取得(TCP ソケット)と間隔制御を全体で1本にまとめる場所として使う予定。今は、本番で
 * SQLite バックエンドが効いていること(`ctx.storage.sql` が使える)を `GET /api/health` から確かめるだけ。
 * クラス名は migration(wrangler.toml の new_sqlite_classes)に固定されるため、変えるときは migration が要る。
 */
import { DurableObject } from "cloudflare:workers";

export class NetkeibaGate extends DurableObject {
  /** SQLite が使えることの確認(RPC)。sqlite_version() 等の関数は DO の SQLite では許可されていない。 */
  async ping(): Promise<{ sqlite: boolean }> {
    const rows = this.ctx.storage.sql.exec("SELECT 1 + 1 AS two").toArray();
    return { sqlite: rows[0]?.["two"] === 2 };
  }
}
