/**
 * 配分の再計算用の書き出しの Durable Object `AllocationExportDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #463)。
 *
 * ロジックは `AllocationExportCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.kv`・時計・`setAlarm`・D1 と R2 のストア(`D1AllocationExportStore`)を配線するだけの薄いラッパ
 * (`cloudflare:workers` を持つため、テストでは import できない)。他の DO とは別のインスタンス・別のアラームで、netkeiba にも LLM にも出ない。
 * 統計モデル用の書き出しの DO(`PriorExportDO`)に相乗りしない理由: アラームが 1 つしか張れず、2 つのジョブが互いのアラームを上書きするため。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v10)に固定される。クラスの名前は `AllocationExportDO`(binding は `ALLOCATION_EXPORT`)。
 */
import { DurableObject } from "cloudflare:workers";
import { parseLimitOverride } from "./limit-override";
import { AllocationExportCore, ALLOCATION_EXPORT_DAILY_LIMIT, type AllocationExportResponse } from "./allocation-export-core";
import { D1AllocationExportStore, type AllocationExportBucket, type AllocationExportDb } from "./allocation-export-store";
import type { ExportMode } from "./prior-export-core";

export interface AllocationExportEnv {
  DB: AllocationExportDb;
  /** 分析の詳細(R2)。詳細の読み出し(get)と、完成したファイルの書き込み(put)だけを使う。 */
  ANALYSIS_DETAIL: AllocationExportBucket;
  /** 任意(Worker の var)。1 日(JST)に始められる回数の上書き(1〜既定の 3 の整数。それ以外・既定を超える値は無視)。**ローカルの測定用**。既定より増やせない(柵を緩める手段にしない)。 */
  ALLOCATION_EXPORT_DAILY_LIMIT?: string;
}

export class AllocationExportDO extends DurableObject<AllocationExportEnv> {
  private readonly core: AllocationExportCore;

  constructor(ctx: DurableObjectState, env: AllocationExportEnv) {
    super(ctx, env);
    const dailyLimit = parseLimitOverride(env.ALLOCATION_EXPORT_DAILY_LIMIT, ALLOCATION_EXPORT_DAILY_LIMIT);
    this.core = new AllocationExportCore(
      {
        kv: ctx.storage.kv,
        now: () => Date.now(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        store: new D1AllocationExportStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL }),
        onWarn: (message) => console.warn(message),
      },
      dailyLimit === null ? {} : { dailyLimit },
    );
  }

  /** 要求(RPC)。呼ぶのは Worker の `GET /api/export/allocation-dataset` だけ。 */
  request(mode: ExportMode): Promise<AllocationExportResponse> {
    return this.core.request(mode);
  }

  /** アラーム: 次の段を 1 つ進める(例外は握る: 失敗は状態に記録され、退避の間隔で再試行される)。 */
  async alarm(): Promise<void> {
    await this.core.runTick();
  }
}
