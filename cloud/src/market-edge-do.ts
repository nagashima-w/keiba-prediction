/**
 * 騎手・調教師の「市場の予測との差」の指標を毎晩作る Durable Object `RaceMarketEdgeDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #642。親は #548)。
 *
 * ロジックは `RaceMarketEdgeCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・目録と R2 の読み出し(`D1RaceArchiveStore`)・
 * 市場の行と指標の D1 への読み書き(`D1MarketEdgeStore`)・毎晩の集計(`aggregateMarketEdges`)を配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。
 * 取得の DO(`RaceArchiveFetchDO`)・変換の DO(`RaceArchiveRunsDO`)とは別のインスタンス・別のアラームなので、互いに止め合わない。**netkeiba にも gate にも出ない**(`fetch` も socket も持たない)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v13)に固定される。
 *
 * 動きを変える設定は Worker の var の 1 つだけ(任意): `RACE_MARKET_EDGE_NIGHTLY_LIMIT`(1 晩の書き込み行数を**下げる**上書き。未設定は既定の 20,000 行。**文字列 `"0"` だけは動きを止める**)。
 * **smoke 専用の `options()` の差し替え**は行わない(smoke は var `"0"` で止める。本番のクラスは何もしない)。
 */
import { DurableObject } from "cloudflare:workers";
import { parseLimitOverride } from "./limit-override";
import { aggregateMarketEdges } from "./market-edge-aggregate";
import { isMarketEdgeDisabled, MARKET_EDGE_NIGHTLY_ROWS_MAX, RaceMarketEdgeCore, type MarketEdgeOptions, type RaceMarketEdgeStatus } from "./market-edge-core";
import { D1MarketEdgeStore, type MarketEdgeDb } from "./market-edge-repository";
import { D1RaceArchiveStore, type RaceArchiveBucket, type RaceArchiveDb } from "./race-archive-repository";

export interface RaceMarketEdgeEnv {
  DB: MarketEdgeDb & RaceArchiveDb;
  /** R2(目録の読み出しが get だけを使う。Class B の計数と柵は D1 の `r2_ops`)。 */
  ANALYSIS_DETAIL: RaceArchiveBucket;
  /**
   * 任意(var)。1 晩の書き込み行数を**下げる**上書き(1 以上の整数。それ以外・上限超えは無視して既定の 20,000)。**文字列 `"0"` だけは動きを止める**。
   * ★止める var を `RACE_MARKET_EDGE` にしてはならない: それは DO の binding の名前で、同じ名前の var は binding と衝突する。
   */
  RACE_MARKET_EDGE_NIGHTLY_LIMIT?: string;
}

export class RaceMarketEdgeDO extends DurableObject<RaceMarketEdgeEnv> {
  private readonly core: RaceMarketEdgeCore;

  constructor(ctx: DurableObjectState, env: RaceMarketEdgeEnv) {
    super(ctx, env);
    const archive = new D1RaceArchiveStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL });
    const store = new D1MarketEdgeStore(env.DB);
    this.core = new RaceMarketEdgeCore(
      {
        sql: ctx.storage.sql,
        now: () => Date.now(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        store,
        archive: { readRaceArchives: (ids) => archive.readRaceArchives(ids) },
        aggregate: (today) => aggregateMarketEdges(store, today),
        log: (line, level) => (level === "error" ? console.error(line) : console.log(line)),
      },
      this.options(),
    );
  }

  /** コアの設定。var から決める(止める `"0"`・書き込み行数を下げる上書き)。 */
  protected options(): MarketEdgeOptions {
    const nightlyRows = parseLimitOverride(this.env.RACE_MARKET_EDGE_NIGHTLY_LIMIT, MARKET_EDGE_NIGHTLY_ROWS_MAX);
    return { ...(isMarketEdgeDisabled(this.env.RACE_MARKET_EDGE_NIGHTLY_LIMIT) ? { disabled: true } : {}), ...(nightlyRows === null ? {} : { nightlyRows }) };
  }

  /** アラームが無ければ張る(RPC)。cron の `scheduled` が 21 時と 23 時に呼ぶ。 */
  kick(): Promise<void> {
    return this.core.kick();
  }

  /** 進捗の読み取り(RPC)。状態は変えないが、アラームが無ければ張り直す(自己回復)。 */
  async getStatus(): Promise<RaceMarketEdgeStatus> {
    await this.core.kick();
    return this.core.getStatus();
  }

  /** アラーム: 次のステップを 1 つ実行する(例外は握る: 失敗は 10 分後の再試行になる)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
