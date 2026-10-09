/**
 * exe から移したファイルの取り込みの Durable Object `CloudMigration`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #216〈#167-B1〉)。
 *
 * ロジックは `MigrationCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.kv`・時計・`setAlarm`・R2 のファイル・D1 のストアを配線するだけの薄いラッパ
 * (`cloudflare:workers` を持つため、テストでは import できない)。**`RaceDay` とは別のインスタンス・別のアラーム**なので、定時の自動実行(cron → `RaceDay`)と干渉しない。
 * netkeiba の取得口(`NETKEIBA_GATE`)には触れない(取得に出ない)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v3)に固定される。
 */
import { DurableObject } from "cloudflare:workers";
import { D1AnalysisStore, type AnalysisBucket, type AnalysisDb } from "./analysis-repository";
import { withPutTimeout } from "./bucket-timeout";
import { D1_FREE_DAILY_WRITE_ROWS, FREE_QUERIES_PER_INVOCATION, MigrationCore, parseLimitOverride, type MigrationStatus, type StartResult } from "./migration-core";
import { D1ResultStore } from "./result-repository";

/** R2 の put の上限時間(ミリ秒)。超えたら例外にして、ストアが再試行する(RaceDay と同じ値)。 */
export const MIGRATION_R2_PUT_TIMEOUT_MS = 15_000;

export interface CloudMigrationEnv {
  DB: AnalysisDb;
  /** 分析の詳細(analyses/{id}.json.gz)と、アップロードされた移行ファイル(migration/…)の置き場(同じバケット)。 */
  ANALYSIS_DETAIL: AnalysisBucket & Pick<R2Bucket, "delete"> & { get(key: string): Promise<R2ObjectBody | null> };
  /**
   * 任意(Worker の var・secret)。移行が 1 日に D1 へ書いてよい行数の上限を上書きする(1〜100,000 の整数。それ以外は無視して既定の 60,000)。
   * ローカルの測定と、上限を下げたいとき用。Free の枠(100,000 行/日)を超える値は受け付けない。
   */
  MIGRATION_DAILY_ROW_LIMIT?: string;
  /** 任意。1 回のアラームの問い合わせ数の上限の上書き(1〜50 の整数。それ以外は無視して既定の 40)。 */
  MIGRATION_TICK_QUERY_LIMIT?: string;
}

/** 値があるときだけ `{ [key]: value }` にする(`exactOptionalPropertyTypes` の undefined を避ける)。 */
function optionalNumber<K extends string>(key: K, value: number | null): { [P in K]?: number } {
  return value === null ? {} : ({ [key]: value } as { [P in K]?: number });
}

export class CloudMigration extends DurableObject<CloudMigrationEnv> {
  private readonly core: MigrationCore;

  constructor(ctx: DurableObjectState, env: CloudMigrationEnv) {
    super(ctx, env);
    this.core = new MigrationCore({
      kv: ctx.storage.kv,
      now: () => Date.now(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      getAlarm: () => ctx.storage.getAlarm(),
      openFile: async (key) => {
        const object = await env.ANALYSIS_DETAIL.get(key);
        return object === null ? null : object.body;
      },
      deleteFile: (key) => env.ANALYSIS_DETAIL.delete(key),
      // 分析は、web の分析と同じ保存経路(D1 の要約 + R2 の詳細。R2 の put には上限時間を掛ける)。
      analyses: new D1AnalysisStore({ db: env.DB, bucket: withPutTimeout(env.ANALYSIS_DETAIL, MIGRATION_R2_PUT_TIMEOUT_MS) }),
      results: new D1ResultStore({ db: env.DB }),
      onWarn: (message) => console.warn(message),
    }, {
      ...optionalNumber("dailyRowLimit", parseLimitOverride(env.MIGRATION_DAILY_ROW_LIMIT, D1_FREE_DAILY_WRITE_ROWS)),
      ...optionalNumber("tickQueryLimit", parseLimitOverride(env.MIGRATION_TICK_QUERY_LIMIT, FREE_QUERIES_PER_INVOCATION)),
    });
  }

  /** アップロードされたファイル(R2 のキー)の取り込みを始める(RPC)。取り込み中なら `{ accepted: false, reason: "busy" }`。呼ぶのは Worker の `POST /api/migration/upload` だけ。 */
  start(input: { readonly key: string; readonly size: number }): Promise<StartResult> {
    return this.core.start(input);
  }

  /**
   * 進捗の読み取り(RPC)。状態は変えないが、取り込み中なのにアラームが無ければ張り直す(自己回復。Cloudflare のアラームの再試行の上限を超えて落ちたとき、
   * 画面の更新やアップロードの受付で動き出す)。
   */
  async getStatus(): Promise<MigrationStatus> {
    await this.core.ensureAlarm();
    return this.core.getStatus();
  }

  /** アラーム: 次のステップを 1 つ実行する(例外は握る: 失敗は状態に記録される)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
