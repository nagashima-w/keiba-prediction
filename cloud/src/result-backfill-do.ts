/**
 * 結果の補完の Durable Object `ResultBackfill`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #217〈#167-C〉)。
 *
 * ロジックは `ResultBackfillCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・D1 のストア・日単位の DO(`RaceDay`)・
 * 移行の DO(`CloudMigration`)・gate(`NetkeibaGate`。**状態の読み取り `status()` だけ**。取得には出ない)を配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。
 * `RaceDay` とは別のインスタンス・別のアラームなので、定時の自動実行(cron → `RaceDay`)と干渉しない。netkeiba への取得は、依頼を受けた日単位の DO が gate 経由で行う。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v4)に固定される。
 */
import { DurableObject } from "cloudflare:workers";
import type { GateStatus } from "./gate-core";
import { BACKFILL_NIGHTLY_LIMIT, ResultBackfillCore, type BackfillDayStub, type BackfillStatus } from "./result-backfill-core";
import { parseLimitOverride, type MigrationState } from "./migration-core";
import { D1ResultStore, type ResultDb } from "./result-repository";

/** netkeiba への取得の出口(NetkeibaGate)の固定名。handler.ts・race-day-do.ts の GATE_NAME と同じ。 */
const GATE_NAME = "gate";
/** 移行の DO(CloudMigration)の固定名。handler.ts の MIGRATION_NAME と同じ。 */
const MIGRATION_NAME = "main";

export interface ResultBackfillEnv {
  DB: ResultDb;
  /** 日単位の DO(RaceDay)。補完は `requestResultImport` と `getResultImportProgress` だけを呼ぶ。 */
  RACE_DAY: { idFromName(name: string): any; get(id: any): BackfillDayStub };
  /** gate。**`status()` だけ**を呼ぶ(ブレーカー・待ちの数を見て、混んでいれば引く)。 */
  NETKEIBA_GATE: { idFromName(name: string): any; get(id: any): { status(): Promise<GateStatus> } };
  /** 移行の DO。`getStatus()` の `state` だけを見る(`completed` のときだけ補完を動かす)。 */
  CLOUD_MIGRATION: { idFromName(name: string): any; get(id: any): { getStatus(): Promise<{ readonly state: MigrationState }> } };
  /**
   * 任意(Worker の var・secret)。1 晩に依頼するレースの数の上限を**下げる**ための上書き(1〜150 の整数。それ以外・150 を超える値は無視して既定の 150)。
   * Free の枠を超える値は受け付けない(`parseLimitOverride` の流儀)。
   */
  RESULT_BACKFILL_NIGHTLY_LIMIT?: string;
}

export class ResultBackfill extends DurableObject<ResultBackfillEnv> {
  private readonly core: ResultBackfillCore;

  constructor(ctx: DurableObjectState, env: ResultBackfillEnv) {
    super(ctx, env);
    const nightlyLimit = parseLimitOverride(env.RESULT_BACKFILL_NIGHTLY_LIMIT, BACKFILL_NIGHTLY_LIMIT);
    this.core = new ResultBackfillCore(
      {
        sql: ctx.storage.sql,
        now: () => Date.now(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        migrationState: async () => (await env.CLOUD_MIGRATION.get(env.CLOUD_MIGRATION.idFromName(MIGRATION_NAME)).getStatus()).state,
        gateStatus: async () => {
          const status = await env.NETKEIBA_GATE.get(env.NETKEIBA_GATE.idFromName(GATE_NAME)).status();
          return { blockedUntil: status.blockedUntil, pending: status.pending };
        },
        store: new D1ResultStore({ db: env.DB }),
        stubFor: (kaisaiDate) => env.RACE_DAY.get(env.RACE_DAY.idFromName(kaisaiDate)),
        log: (line, level) => (level === "error" ? console.error(line) : console.log(line)),
        onWarn: (message) => console.warn(message),
      },
      nightlyLimit === null ? {} : { nightlyLimit },
    );
  }

  /** アラームが無ければ張る(RPC)。cron の `scheduled` が毎日 1 回呼ぶ。 */
  kick(): Promise<void> {
    return this.core.kick();
  }

  /** 進捗の読み取り(RPC)。状態は変えないが、アラームが無ければ張り直す(自己回復。画面の更新で動き出す)。 */
  async getStatus(): Promise<BackfillStatus> {
    await this.core.kick();
    return this.core.getStatus();
  }

  /** アラーム: 次のステップを 1 つ実行する(例外は握る: 失敗は 10 分後の再試行になる)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
