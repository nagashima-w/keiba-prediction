/**
 * 日単位の Durable Object `RaceDay`(SQLite バックエンド。`idFromName(kaisaiDate)`。Issue #177〈#164-b〉)。
 *
 * ロジックは `RaceDayCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・ゲート(`NetkeibaGate` の RPC)を
 * 配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。
 *
 * **本番から呼び出す入口は、まだ無い**(入口は #180。定時の起動は #166)。この DO は `worker.ts` から export され(wrangler が binding のクラスを要求する)、
 * ローカルの smoke(`smoke-worker.ts`)だけが RPC を呼んで通す。**D1・R2 には触れない**(朝の prior は DO のストレージにだけ置く)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v2)に固定される。
 */
import { DurableObject } from "cloudflare:workers";
import type { GateStatus } from "./gate-core";
import type { GateLike } from "./gate-fetch";
import { RaceDayCore, type Board, type MorningPrior, type ScheduleInput, type ScheduleResult } from "./race-day-core";

/** netkeiba への取得の出口(NetkeibaGate)の固定名。handler.ts の GATE_NAME と同じ(全取得をこの1つのインスタンスに通す)。 */
const GATE_NAME = "gate";

/** RaceDay が使う binding(NetkeibaGate の名前空間だけ)。 */
export interface RaceDayEnv {
  NETKEIBA_GATE: {
    idFromName(name: string): any;
    get(id: any): GateLike & { status(): Promise<GateStatus> };
  };
}

export class RaceDay extends DurableObject<RaceDayEnv> {
  private readonly core: RaceDayCore;

  constructor(ctx: DurableObjectState, env: RaceDayEnv) {
    super(ctx, env);
    const gate = env.NETKEIBA_GATE.get(env.NETKEIBA_GATE.idFromName(GATE_NAME));
    this.core = new RaceDayCore({
      sql: ctx.storage.sql,
      now: () => Date.now(),
      gate: { fetchRaw: (url) => gate.fetchRaw(url) },
      setAlarm: (at) => ctx.storage.setAlarm(at),
      onWarn: (message) => console.warn(message),
    });
  }

  /** レースの朝の準備を予約する(RPC。予約だけをして戻る)。 */
  schedule(input: ScheduleInput): Promise<ScheduleResult> {
    return this.core.schedule(input);
  }

  /** その日のレースの状態(RPC)。 */
  getBoard(): Board {
    return this.core.getBoard();
  }

  /** 朝の prior(RPC。無ければ null)。 */
  getMorningPrior(raceId: string): MorningPrior | null {
    return this.core.getMorningPrior(raceId);
  }

  /** アラーム: 次のステップを1つ実行する(例外は握らずに投げ直さない: 失敗は状態に記録される。インフラ例外のときだけ DO のアラームが再実行される)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
