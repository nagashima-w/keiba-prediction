/**
 * 日報の Durable Object `DailyReportDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #235)。
 *
 * ロジックは `DailyReportCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.kv`・時計・`setAlarm`・D1/R2 の読み出し・LLM・Discord を
 * 配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。netkeiba には出ない(結果の取り込みは日単位の DO `RaceDay` の仕事)。
 *
 * 呼び出す入口(RPC)は `requestReport`(日報の作成の依頼)と `getStatus`(進行状況)の 2 つ。依頼するのは、日単位の DO `RaceDay`(その日が静かになったとき。`mode: "auto"`)、
 * 朝の cron(`scheduled.ts`。取り残しの補完。`mode: "catchup"`)、手動の `POST /api/reports/run`(`mode: "manual"`)。1 回のアラームで 1 段階だけ進める(`alarm`)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v6)に固定される。binding は `DAILY_REPORT`。
 */
import { DurableObject } from "cloudflare:workers";
import { D1AnalysisStore, type AnalysisBucket, type AnalysisDb } from "./analysis-repository";
import { DailyReportCore, type ReportMode, type ReportStatus, type RequestReportResult } from "./daily-report-core";
import { D1ReportSource, D1ReportStore } from "./daily-report-repository";
import { createCloudLlm } from "./llm-sender";
import { resolveAppBaseUrl } from "./notify-link";
import { createDiscordNotifier, webhookStatus } from "./notify-send";
import { loadSettings } from "./settings";

export interface DailyReportEnv {
  DB: AnalysisDb & Pick<D1Database, "prepare" | "batch">;
  /** 分析の詳細(R2)。馬名・レース情報の読み出しに get だけを使う。 */
  ANALYSIS_DETAIL: AnalysisBucket;
  /** LLM の API キー(Worker の secret)。未登録・空白だけなら、LLM を使わず統計だけの日報にする。 */
  ANTHROPIC_API_KEY?: string;
  /** Discord の Webhook URL(Worker の secret)。未登録・形式不正なら通知しない。 */
  DISCORD_WEBHOOK_URL?: string;
  /** 通知のリンクの基点(Worker の secret。https のオリジンだけ有効)。未登録・形式不正ならリンクなしで通知する。 */
  APP_BASE_URL?: string;
}

export class DailyReportDO extends DurableObject<DailyReportEnv> {
  private readonly core: DailyReportCore;

  constructor(ctx: DurableObjectState, env: DailyReportEnv) {
    super(ctx, env);
    if (webhookStatus(env.DISCORD_WEBHOOK_URL) === "invalid") {
      console.warn("DISCORD_WEBHOOK_URL の形式が Discord の Webhook ではないため、日報の通知は送りません(値は出しません)");
    }
    const appBase = resolveAppBaseUrl(env.APP_BASE_URL);
    if (appBase.status === "invalid") {
      console.warn("APP_BASE_URL の形式が https のオリジン(パス・クエリ・認証情報なし)ではないため、日報の通知にリンクは付けません(値は出しません)");
    }
    const llm = createCloudLlm(env.ANTHROPIC_API_KEY);
    const notifier = createDiscordNotifier(env.DISCORD_WEBHOOK_URL);
    this.core = new DailyReportCore({
      kv: ctx.storage.kv,
      now: () => Date.now(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      onWarn: (message) => console.warn(message),
      source: new D1ReportSource({ db: env.DB, analyses: new D1AnalysisStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL }) }),
      store: new D1ReportStore({ db: env.DB }),
      loadSettings: async () => (await loadSettings(env.DB)).settings,
      ...(llm === undefined ? {} : { llm }),
      ...(notifier === undefined ? {} : { notifier }),
      ...(appBase.status === "valid" ? { appBaseUrl: appBase.origin } : {}),
    });
  }

  /** 日報の作成を依頼する(RPC。依頼だけをして戻る。冪等: 進行中・作成済みは断る)。 */
  requestReport(input: { readonly kaisaiDate: string; readonly mode: ReportMode }): Promise<RequestReportResult> {
    return this.core.requestReport(input);
  }

  /** 進行状況(RPC。無ければ null。状態は変えない)。 */
  getStatus(kaisaiDate: string): ReportStatus | null {
    return this.core.getStatus(kaisaiDate);
  }

  /** アラーム: 時刻が来ているジョブを 1 段階進める(段階の失敗は状態に記録され、間隔を空けて再試行される)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
