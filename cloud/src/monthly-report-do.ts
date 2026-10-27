/**
 * 月報の Durable Object `MonthlyReportDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #265・#279・#280)。
 *
 * ロジックは `MonthlyReportCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.kv`・時計・`setAlarm`・D1 の読み書き・LLM・Discord を
 * 配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。netkeiba には出ない(結果の取り込みは日単位の DO `RaceDay` の仕事)。
 * **日報の DO(`DailyReportDO`)に相乗りしない理由**: アラームは DO ごとに 1 つで、2 つのコアが別々に `setAlarm` を張ると互いを上書きするため。
 *
 * 呼び出す入口(RPC)は `requestMonthlyReport`(月報の作成の依頼)と `getStatus`(進行状況)の 2 つ。依頼するのは cron(`scheduled.ts`。`mode: "auto"` と `"catchup"`)と、
 * 管理者の手動の入口(`POST /api/monthly-reports/run`。`mode: "manual"` と、`regenerate: true` を付けた作り直しの `"regenerate"`)。
 * 1 回のアラームで 1 段階だけ進める(`alarm`)。クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v8)に固定される。binding は `MONTHLY_REPORT`。
 */
import { DurableObject } from "cloudflare:workers";
import type { AnalysisDb } from "./analysis-repository";
import { createCloudLlm } from "./llm-sender";
import { MonthlyReportCore, type MonthlyMode, type MonthlyStatus, type RequestMonthlyResult } from "./monthly-report-core";
import { D1MonthlySource, D1MonthlyStore } from "./monthly-report-repository";
import { resolveAppBaseUrl } from "./notify-link";
import { createDiscordNotifier, webhookStatus } from "./notify-send";
import { loadSettings } from "./settings";

export interface MonthlyReportEnv {
  DB: AnalysisDb & Pick<D1Database, "prepare" | "batch">;
  /** LLM の API キー(Worker の secret)。未登録・空白だけなら、LLM を使わず統計だけの月報にする。 */
  ANTHROPIC_API_KEY?: string;
  /** Discord の Webhook URL(Worker の secret)。未登録・形式不正なら通知しない。 */
  DISCORD_WEBHOOK_URL?: string;
  /** 通知のリンクの基点(Worker の secret。https のオリジンだけ有効)。未登録・形式不正ならリンクなしで通知する。 */
  APP_BASE_URL?: string;
}

export class MonthlyReportDO extends DurableObject<MonthlyReportEnv> {
  private readonly core: MonthlyReportCore;

  constructor(ctx: DurableObjectState, env: MonthlyReportEnv) {
    super(ctx, env);
    if (webhookStatus(env.DISCORD_WEBHOOK_URL) === "invalid") {
      console.warn("DISCORD_WEBHOOK_URL の形式が Discord の Webhook ではないため、月報の通知は送りません(値は出しません)");
    }
    const appBase = resolveAppBaseUrl(env.APP_BASE_URL);
    if (appBase.status === "invalid") {
      console.warn("APP_BASE_URL の形式が https のオリジン(パス・クエリ・認証情報なし)ではないため、月報の通知にリンクは付けません(値は出しません)");
    }
    const llm = createCloudLlm(env.ANTHROPIC_API_KEY);
    const notifier = createDiscordNotifier(env.DISCORD_WEBHOOK_URL);
    this.core = new MonthlyReportCore({
      kv: ctx.storage.kv,
      now: () => Date.now(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      onWarn: (message) => console.warn(message),
      source: new D1MonthlySource({ db: env.DB, onWarn: (message) => console.warn(message) }),
      store: new D1MonthlyStore({ db: env.DB }),
      loadSettings: async () => (await loadSettings(env.DB)).settings,
      ...(llm === undefined ? {} : { llm }),
      ...(notifier === undefined ? {} : { notifier }),
      ...(appBase.status === "valid" ? { appBaseUrl: appBase.origin } : {}),
    });
  }

  /** 月報の作成を依頼する(RPC。依頼だけをして戻る。冪等: 進行中・作成済みは断る)。`startAt` はこの時刻(エポックミリ秒)まで始めない(今から 24 時間以内のときだけ有効)。 */
  requestMonthlyReport(input: { readonly month: string; readonly mode: MonthlyMode; readonly startAt?: number }): Promise<RequestMonthlyResult> {
    return this.core.requestMonthly(input);
  }

  /** 進行状況(RPC。無ければ null。状態は変えない)。 */
  getStatus(month: string): MonthlyStatus | null {
    return this.core.getStatus(month);
  }

  /** アラーム: 時刻が来ているジョブを 1 段階進める(段階の失敗は状態に記録され、間隔を空けて再試行される)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
