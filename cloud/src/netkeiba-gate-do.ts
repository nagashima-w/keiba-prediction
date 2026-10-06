/**
 * netkeiba への取得の出口(SQLite バックエンドの Durable Object。Issue #161〈#21-C〉の雛形 → #162 段階2a で中身を入れた)。
 *
 * **netkeiba への全取得は、この DO の単一インスタンス(`idFromName` の固定名)を経由させる。** 取得は DO の中の TCP ソケット
 * (`cloudflare:sockets`。Workers の `fetch` は CloudFront から HTTP 400 になるので使わない。#160)で行い、アカウント全体で
 * 直列化・最小間隔 2 秒・サーキットブレーカーを掛ける。ロジックは `GateCore`(純ロジック。Node でテストできる)にあり、
 * ここは本物の `ctx.storage.kv`・時計・`connect` を配線するだけの薄いラッパ(テストでは import できない `cloudflare:*` を持つため)。
 *
 * クラス名は migration(wrangler.toml の new_sqlite_classes)に固定されるため、変えるときは migration が要る。メソッドや保存する値を
 * 足すだけなら要らない(v1 のまま)。
 */
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { GateCore, type GateResult, type GateStatus } from "./gate-core";
import { createSocketFetcher, type ConnectFn } from "./socket-fetch";

export class NetkeibaGate extends DurableObject {
  private readonly core: GateCore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.core = new GateCore({
      // 同期 API(SQLite バックエンドの DO だけ)。読み書きの間に割り込みが入らない。
      kv: ctx.storage.kv,
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      fetcher: createSocketFetcher(connect as ConnectFn),
    });
  }

  /** SQLite が使えることの確認(RPC)。sqlite_version() 等の関数は DO の SQLite では許可されていない。 */
  async ping(): Promise<{ sqlite: boolean }> {
    const rows = this.ctx.storage.sql.exec("SELECT 1 + 1 AS two").toArray();
    return { sqlite: rows[0]?.["two"] === 2 };
  }

  /**
   * URL を1本取得する(RPC)。許可リスト・直列化・間隔・ブレーカーは {@link GateCore.fetchRaw}。
   * 期待される拒否は例外ではなく値(`kind: "refused"`)で返す(RPC 越しの例外は型・プロパティが落ちる)。
   */
  fetchRaw(url: string): Promise<GateResult> {
    return this.core.fetchRaw(url);
  }

  /** ブレーカーの状態・最後の開始時刻・待ちの数(RPC)。 */
  status(): GateStatus {
    return this.core.status();
  }
}
