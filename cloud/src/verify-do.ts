/**
 * 検証の集計の Durable Object `VerifyReportDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #219〈web の検証画面(1)〉)。
 *
 * ロジックは `VerifyCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.kv`・時計・`setAlarm`・D1 と R2 のストア(`D1VerifyStore`)を配線するだけの薄いラッパ
 * (`cloudflare:workers` を持つため、テストでは import できない)。他の DO とは別のインスタンス・別のアラームで、netkeiba にも LLM にも出ない。
 * 集計を DO で行う理由: 分析・結果の全件を読んで core の `computeVerifyReport` を回すため、Workers Free の CPU 10ms に収まらない。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v5)に固定される。クラスの名前は `VerifyReportDO`(binding は `VERIFY_REPORT`)。
 */
import { DurableObject } from "cloudflare:workers";
import { parseLimitOverride } from "./migration-core";
import { VerifyCore, VERIFY_DAILY_LIMIT, VERIFY_MIN_INTERVAL_MS, type GetReportOptions, type VerifyResponse } from "./verify-core";
import { D1VerifyStore, type VerifyBucket, type VerifyDb } from "./verify-store";
import type { VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";

export interface VerifyReportEnv {
  DB: VerifyDb;
  /** 分析の詳細(R2)。発走時刻の補完が `get` だけを使う。 */
  ANALYSIS_DETAIL: VerifyBucket;
  /**
   * 任意(Worker の var)。再計算の最短間隔(ミリ秒)の上書き(1〜既定の 300,000 の整数。それ以外・既定を超える値は無視)。**ローカルの測定用**
   * (`scripts/measure-verify.ts`)。既定より**長くはできない**(柵を緩める手段にしない)。
   */
  VERIFY_MIN_INTERVAL_MS?: string;
  /** 任意。1 日(JST)の再計算の上限の上書き(1〜既定の値の整数。それ以外・既定を超える値は無視)。測定用で、既定より増やせない。 */
  VERIFY_DAILY_LIMIT?: string;
}

export class VerifyReportDO extends DurableObject<VerifyReportEnv> {
  private readonly core: VerifyCore;

  constructor(ctx: DurableObjectState, env: VerifyReportEnv) {
    super(ctx, env);
    const minIntervalMs = parseLimitOverride(env.VERIFY_MIN_INTERVAL_MS, VERIFY_MIN_INTERVAL_MS);
    const dailyLimit = parseLimitOverride(env.VERIFY_DAILY_LIMIT, VERIFY_DAILY_LIMIT);
    this.core = new VerifyCore({
      kv: ctx.storage.kv,
      now: () => Date.now(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      getAlarm: () => ctx.storage.getAlarm(),
      store: new D1VerifyStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL }),
      onWarn: (message) => console.warn(message),
    }, { ...(minIntervalMs === null ? {} : { minIntervalMs }), ...(dailyLimit === null ? {} : { dailyLimit }) });
  }

  /** 検証の集計(RPC)。キャッシュ・費用の柵・発走時刻の補完の確認を含む。呼ぶのは Worker の `GET /api/verify` だけ。 */
  getReport(venue: VerifyVenueFilter, options?: GetReportOptions): Promise<VerifyResponse> {
    return this.core.getReport(venue, options);
  }

  /** アラーム: 発走時刻の補完を 1 tick 進める(例外は握る: 失敗は状態に記録され、退避の間隔で再試行される)。 */
  async alarm(): Promise<void> {
    await this.core.runBackfillTick();
  }
}
