/**
 * 統計モデルの見直し用の書き出しの Durable Object `PriorExportDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #266)。
 *
 * ロジックは `PriorExportCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.kv`・時計・`setAlarm`・D1 と R2 のストア(`D1PriorExportStore`)を配線するだけの薄いラッパ
 * (`cloudflare:workers` を持つため、テストでは import できない)。他の DO とは別のインスタンス・別のアラームで、netkeiba にも LLM にも出ない。
 * 検証の DO(`VerifyReportDO`)に足さない理由: アラームが 1 つしか張れず、発走時刻の補完の状態機械と干渉するため。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v7)に固定される。クラスの名前は `PriorExportDO`(binding は `PRIOR_EXPORT`)。
 */
import { DurableObject } from "cloudflare:workers";
import { parseLimitOverride } from "./limit-override";
import { PriorExportCore, PRIOR_EXPORT_DAILY_LIMIT, type ExportMode, type ExportResponse } from "./prior-export-core";
import { D1PriorExportStore, type PriorExportBucket, type PriorExportDb } from "./prior-export-store";

export interface PriorExportEnv {
  DB: PriorExportDb;
  /** 分析の詳細(R2)。詳細の読み出し(get)と、完成したファイルの書き込み(put)だけを使う。 */
  ANALYSIS_DETAIL: PriorExportBucket;
  /** 任意(Worker の var)。1 日(JST)に始められる回数の上書き(1〜既定の 3 の整数。それ以外・既定を超える値は無視)。**ローカルの測定用**。既定より増やせない(柵を緩める手段にしない)。 */
  PRIOR_EXPORT_DAILY_LIMIT?: string;
}

export class PriorExportDO extends DurableObject<PriorExportEnv> {
  private readonly core: PriorExportCore;

  constructor(ctx: DurableObjectState, env: PriorExportEnv) {
    super(ctx, env);
    const dailyLimit = parseLimitOverride(env.PRIOR_EXPORT_DAILY_LIMIT, PRIOR_EXPORT_DAILY_LIMIT);
    this.core = new PriorExportCore(
      {
        kv: ctx.storage.kv,
        now: () => Date.now(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        store: new D1PriorExportStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL }),
        onWarn: (message) => console.warn(message),
      },
      dailyLimit === null ? {} : { dailyLimit },
    );
  }

  /** 要求(RPC)。呼ぶのは Worker の `GET /api/export/prior-dataset` だけ。 */
  request(mode: ExportMode): Promise<ExportResponse> {
    return this.core.request(mode);
  }

  /** アラーム: 次の段を 1 つ進める(例外は握る: 失敗は状態に記録され、退避の間隔で再試行される)。 */
  async alarm(): Promise<void> {
    await this.core.runTick();
  }
}
