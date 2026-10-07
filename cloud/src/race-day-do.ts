/**
 * 日単位の Durable Object `RaceDay`(SQLite バックエンド。`idFromName(kaisaiDate)`。Issue #177〈#164-b〉)。
 *
 * ロジックは `RaceDayCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・ゲート(`NetkeibaGate` の RPC)を
 * 配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。
 *
 * 呼び出す入口は、手動の `POST /api/analyses/run`(#180。定時の起動は #166)。この DO は `worker.ts` から export される(wrangler が binding のクラスを要求する)。
 * **朝のタスクは D1・R2 に触れない**(朝の prior は DO のストレージにだけ置く)。発走前の分析(`pre_race`。#178)だけが、D1(設定の読み出し・分析の要約)と
 * R2(詳細)を使う。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v2)に固定される。
 */
import { DurableObject } from "cloudflare:workers";
import { D1AnalysisStore, type AnalysisBucket, type AnalysisDb } from "./analysis-repository";
import { createAnalysisSink } from "./analysis-sink";
import { createCloudLlm } from "./llm-sender";
import { createDiscordNotifier, webhookStatus } from "./notify-send";
import { withPutTimeout } from "./bucket-timeout";
import type { GateStatus } from "./gate-core";
import type { GateLike } from "./gate-fetch";
import { RaceDayCore, type AutoRunResults, type Board, type NotificationRecord, type MorningPrior, type RaceListResult, type RaceListVenue, type RequestPlanResult, type ScheduleInput, type ScheduleResult } from "./race-day-core";
import { loadSettings } from "./settings";

/** netkeiba への取得の出口(NetkeibaGate)の固定名。handler.ts の GATE_NAME と同じ(全取得をこの1つのインスタンスに通す)。 */
const GATE_NAME = "gate";

/** R2 の put の上限時間(ミリ秒)。超えたら例外にして、ストアが再試行する(Issue #178)。 */
export const R2_PUT_TIMEOUT_MS = 15_000;

/**
 * RaceDay が使う binding。NetkeibaGate の名前空間(取得)と、**発走前の分析(`pre_race`)の保存先・設定の D1・R2**(Issue #178)。
 * 朝のタスクは D1・R2 に触れない(`RaceDayCore` が、朝のタスクでは保存先と設定を一切呼ばない)。
 */
export interface RaceDayEnv {
  DB: AnalysisDb & Pick<D1Database, "prepare">;
  ANALYSIS_DETAIL: AnalysisBucket;
  /**
   * 発走前の分析の LLM の API キー(Worker の secret。**ユーザーがダッシュボードまたは wrangler で登録する**。値はリポジトリ・チャットに書かない)。
   * 未登録・空白だけなら、LLM を使わず統計のみで保存し、理由を残す(Issue #194)。
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * 通知(Discord。Issue #205)の Webhook URL(Worker の secret。**ユーザーがダッシュボードまたは wrangler で登録する**。値はリポジトリ・チャットに書かない)。
   * 未登録・形式不正なら通知の仕組み全体を無効にする(材料も行も積まず、通知のためのアラームも張らない)。URL は `createDiscordNotifier` のクロージャの中にだけあり、`RaceDayCore` には渡らない。
   */
  DISCORD_WEBHOOK_URL?: string;
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
    if (webhookStatus(env.DISCORD_WEBHOOK_URL) === "invalid") {
      console.warn("DISCORD_WEBHOOK_URL の形式が Discord の Webhook ではないため、通知は送りません(値は出しません)");
    }
    this.core = new RaceDayCore({
      sql: ctx.storage.sql,
      now: () => Date.now(),
      gate: { fetchRaw: (url) => gate.fetchRaw(url) },
      setAlarm: (at) => ctx.storage.setAlarm(at),
      onWarn: (message) => console.warn(message),
      // 発走前の分析の保存先(D1 の要約 + R2 の詳細。R2 の put には上限時間を掛ける)と、設定(D1 の1行)。
      sink: createAnalysisSink(new D1AnalysisStore({ db: env.DB, bucket: withPutTimeout(env.ANALYSIS_DETAIL, R2_PUT_TIMEOUT_MS) })),
      // 発走前の分析の LLM(Issue #194)。キーが未登録なら undefined(LLM なしで保存し、理由を残す)。朝のタスクでは使わない。
      llm: createCloudLlm(env.ANTHROPIC_API_KEY),
      // 通知(Issue #205)。Webhook が未登録・形式不正なら undefined(通知は無効)。
      notifier: createDiscordNotifier(env.DISCORD_WEBHOOK_URL),
      loadSettings: async () => {
        const loaded = await loadSettings(env.DB);
        if (loaded.source === "invalid") {
          console.warn("設定の行(cloud_settings)が JSON として読めないので、既定値で続けます");
        }
        return loaded.settings;
      },
    });
  }

  /** レースの朝の準備を予約する(RPC。予約だけをして戻る)。 */
  schedule(input: ScheduleInput): Promise<ScheduleResult> {
    return this.core.schedule(input);
  }

  /**
   * 朝の計画を依頼する(RPC。Issue #203。cron〈#206〉から呼ぶ入口。依頼だけをして戻る。2回目以降は `already-planned`)。
   * ★まだ本番から呼ぶ入口は無い(`scheduled` ハンドラ・cron は #206)。
   */
  requestPlan(input: { readonly kaisaiDate: string }): Promise<RequestPlanResult> {
    return this.core.requestPlan(input);
  }

  /** 自動実行の各レースの結果(RPC。Issue #204。#205 の通知が状態から作るための読み取り。状態は変えない)。 */
  getAutoRunResults(): AutoRunResults {
    return this.core.getAutoRunResults();
  }

  /** 通知の一覧(RPC。Issue #205。送信の失敗が状態から読める。URL・例外の文面は含まない。状態は変えない)。 */
  getNotifications(): NotificationRecord[] {
    return this.core.getNotifications();
  }

  /** その日のレースの状態(RPC)。 */
  getBoard(): Board {
    return this.core.getBoard();
  }

  /** 朝の prior(RPC。無ければ null)。 */
  getMorningPrior(raceId: string): MorningPrior | null {
    return this.core.getMorningPrior(raceId);
  }

  /** 開催日のレース一覧(RPC。Issue #183。想定内の失敗は例外にせず `{ ok: false, reason }`)。 */
  getRaceList(kaisaiDate: string, venue: RaceListVenue): Promise<RaceListResult> {
    return this.core.getRaceList(kaisaiDate, venue);
  }

  /** アラーム: 次のステップを1つ実行する(例外は握らずに投げ直さない: 失敗は状態に記録される。インフラ例外のときだけ DO のアラームが再実行される)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
