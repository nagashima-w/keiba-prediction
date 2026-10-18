/**
 * 日単位の Durable Object `RaceDay`(SQLite バックエンド。`idFromName(kaisaiDate)`。Issue #177〈#164-b〉)。
 *
 * ロジックは `RaceDayCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・ゲート(`NetkeibaGate` の RPC)を
 * 配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。
 *
 * 呼び出す入口は、手動の `POST /api/analyses/run`(#180)と、cron の `scheduled`(#206。`requestPlan`)、結果の取り込みの依頼(#208。`requestResultImport`。cron の `scheduled` と手動の `POST /api/results/import` が `dispatchResultImports` 経由で呼ぶ)。この DO は `worker.ts` から export される(wrangler が binding のクラスを要求する)。
 * **朝のタスクは、分析の結果(prior)を D1・R2 に書かない**(DO のストレージにだけ置く)。朝のタスクが D1 に触れるのは、設定の読み出し(#218)・
 * 騎手の成績の保存先 `jockey_results`(#226)・各馬の戦績の蓄積 `horse_runs`(#256 段階A)だけで、R2 には触れない。分析履歴(D1 の要約と R2 の詳細)を保存するのは
 * 発走前の分析(`pre_race`。#178)だけ。結果の取り込み(#208)は D1 に結果を保存する(`D1ResultStore`。取得は gate 経由・キャッシュなし)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v2)に固定される。
 */
import { DurableObject } from "cloudflare:workers";
import { D1AnalysisStore, type AnalysisBucket, type AnalysisDb } from "./analysis-repository";
import { createAnalysisSink } from "./analysis-sink";
import { D1BabaStore } from "./baba-repository";
import { babaUrlStatus, createBabaFetcher } from "./baba-fetch";
import { createCloudLlm } from "./llm-sender";
import { createDiscordNotifier, webhookStatus } from "./notify-send";
import { resolveAppBaseUrl } from "./notify-link";
import { withPutTimeout } from "./bucket-timeout";
import type { GateStatus } from "./gate-core";
import type { GateLike } from "./gate-fetch";
import { RaceDayCore, type AutoRunResults, type Board, type NotificationRecord, type MorningPrior, type PlanProgress, type RaceListResult, type RaceListVenue, type RequestPlanResult, type RequestResultImportResult, type ResultImportProgress, type ScheduleInput, type ScheduleManyInput, type ScheduleManyResult, type ScheduleResult } from "./race-day-core";
import { DAILY_REPORT_NAME, isRequestSettled, type RequestReportResult } from "./daily-report-core";
import { D1JockeyResultsStore } from "./jockey-results-repository";
import { D1TrainerResultsStore } from "./trainer-results-repository";
import { D1HorseRunsStore } from "./horse-runs-repository";
import { D1ResultStore } from "./result-repository";
import { loadSettings } from "./settings";

/** netkeiba への取得の出口(NetkeibaGate)の固定名。handler.ts の GATE_NAME と同じ(全取得をこの1つのインスタンスに通す)。 */
const GATE_NAME = "gate";

/** R2 の put の上限時間(ミリ秒)。超えたら例外にして、ストアが再試行する(Issue #178)。 */
export const R2_PUT_TIMEOUT_MS = 15_000;

/**
 * RaceDay が使う binding。NetkeibaGate の名前空間(取得)と、**発走前の分析(`pre_race`)の保存先・設定の D1・R2**(Issue #178)。
 * 朝のタスクは、この保存先(分析履歴の D1・R2)を呼ばない(`RaceDayCore` が朝のタスクでは `save` を呼ばない)。朝のタスクが D1 に触れるのは、設定の読み出し・騎手の成績・各馬の戦績だけ(上の冒頭の説明)。
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
  /**
   * 通知のタイトルのリンク(分析画面)の基点(Issue #230。Worker の secret。**ユーザーがダッシュボードまたは wrangler で登録する**。サイトの URL はリポジトリ・チャットに書かない)。
   * https のオリジンだけ有効。未登録・形式不正ならリンクを付けない(通知は送る)。検証済みの値だけを `RaceDayCore` に渡し、材料(`payload_json`)には入れない(送信の直前に足す)。値はログに出さない。
   */
  APP_BASE_URL?: string;
  /**
   * 外部の馬場の API(JRA の競馬場の最新の馬場状態。Issue #294)の URL(Worker の secret。**ユーザーがダッシュボードまたは wrangler で登録する**。URL はリポジトリ・チャットに書かない)。
   * 未登録・https の URL として使えない形なら、取得の段階全体を無効にする(印も書かず、アラームの候補にもしない。分析は従来どおり)。URL は `createBabaFetcher` のクロージャの中にだけあり、`RaceDayCore` には渡らない。
   * 利用の条件は「JRA の開催日に、利用者全体で 1 日 1 回」。
   */
  BABA_API_URL?: string;
  NETKEIBA_GATE: {
    idFromName(name: string): any;
    get(id: any): Required<GateLike> & { status(): Promise<GateStatus> };
  };
  /**
   * 日報の DO(`DailyReportDO`。Issue #235)。その日が静かになったとき(`isDayQuiet`)、`RaceDayCore` が `requestReport` を 1 回呼ぶ。無い構成(binding の設定漏れ)では依頼しない。
   * 日報の DO は単一インスタンス(固定名 `main`)。
   */
  DAILY_REPORT?: {
    idFromName(name: string): any;
    get(id: any): { requestReport(input: { readonly kaisaiDate: string; readonly mode: "auto" }): Promise<RequestReportResult> };
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
    if (babaUrlStatus(env.BABA_API_URL) === "invalid") {
      console.warn("BABA_API_URL の形式が https の URL ではないため、馬場の API の取得は行いません(値は出しません)");
    }
    const appBase = resolveAppBaseUrl(env.APP_BASE_URL);
    if (appBase.status === "invalid") {
      console.warn("APP_BASE_URL の形式が https のオリジン(パス・クエリ・認証情報なし)ではないため、通知にリンクは付けません(値は出しません)");
    }
    // 日報の作成の依頼(Issue #235)。その日が静かになったとき、`RaceDayCore` が 1 回だけ呼ぶ。作成済み・進行中は日報の DO が断る(それも完了として扱う)。
    const reportNamespace = env.DAILY_REPORT;
    const requestReport =
      reportNamespace === undefined
        ? undefined
        : async (kaisaiDate: string): Promise<void> => {
            const result = await reportNamespace.get(reportNamespace.idFromName(DAILY_REPORT_NAME)).requestReport({ kaisaiDate, mode: "auto" });
            // 受理・作成済み・進行中・古すぎる日(too-old)は完了として扱う。日付が不正・未来のとき(日付の食い違い)だけは失敗として扱う(依頼済みにしない)。
            if (!isRequestSettled(result)) {
              throw new Error("日報の依頼が断られました");
            }
          };
    this.core = new RaceDayCore({
      sql: ctx.storage.sql,
      now: () => Date.now(),
      gate: { fetchRaw: (url) => gate.fetchRaw(url), postRaw: (request) => gate.postRaw(request) },
      setAlarm: (at) => ctx.storage.setAlarm(at),
      onWarn: (message) => console.warn(message),
      // 発走前の分析の保存先(D1 の要約 + R2 の詳細。R2 の put には上限時間を掛ける)と、設定(D1 の1行)。
      sink: createAnalysisSink(new D1AnalysisStore({ db: env.DB, bucket: withPutTimeout(env.ANALYSIS_DETAIL, R2_PUT_TIMEOUT_MS) })),
      // 発走前の分析の LLM(Issue #194)。キーが未登録なら undefined(LLM なしで保存し、理由を残す)。朝のタスクでは使わない。
      llm: createCloudLlm(env.ANTHROPIC_API_KEY),
      // 通知(Issue #205)。Webhook が未登録・形式不正なら undefined(通知は無効)。
      notifier: createDiscordNotifier(env.DISCORD_WEBHOOK_URL),
      // 通知のリンクの基点(Issue #230)。検証済みのオリジンだけを渡す(未登録・形式不正は undefined = リンクなしで通知する)。
      appBaseUrl: appBase.status === "valid" ? appBase.origin : undefined,
      // 結果の取り込み(Issue #208)。D1 に結果を保存する（exe の AnalysisStore.saveResult と同じ 4 表。1 レース 1 batch・最大 6 文）。
      resultStore: new D1ResultStore({ db: env.DB }),
      // 騎手の年ごとの成績の保存先(Issue #226。D1 の jockey_results〈migration 0012〉)。日をまたいで共有し、取得日時から 7 日以内なら netkeiba に出ない(週に 1 回の更新)。
      // 読み書きの失敗は取得へフォールバックする(分析は止めない)ので、migration の適用前に Worker が先に出ても動く。
      jockeyStore: new D1JockeyResultsStore({ db: env.DB }),
      // 調教師の年ごとの成績の保存先(Issue #354。D1 の trainer_results〈migration 0020〉)。取得日時がレースの年の 1 月 1 日(JST)以降なら netkeiba に出ない。
      trainerStore: new D1TrainerResultsStore({ db: env.DB }),
      // 各馬の戦績の蓄積先(Issue #256 段階A。D1 の horse_runs・horse_run_saves〈migration 0014〉)。事前分析の計算ステップの末尾だけで保存する(取得は増やさない)。
      // 失敗は握って警告にする(分析は止めない)ので、migration の適用前に Worker が先に出ても動く。
      horseRunsStore: new D1HorseRunsStore({ db: env.DB }),
      // 馬場の API の取得(Issue #294)。secret が未登録・形式不正なら undefined(取得の段階全体が無効)。URL は取得口の中にだけあり、core には渡らない。保存先は D1(baba_fetches・baba_conditions〈migration 0017〉)。
      fetchBaba: createBabaFetcher(env.BABA_API_URL),
      babaStore: new D1BabaStore({ db: env.DB }),
      // 貯めた当日の馬場の値の読み出し(Issue #295)。発走前の分析が、そのレースの開催日 × 場コードの 1 行を D1 から読む(表が無い間は読み出しが失敗して値なしで続ける)。
      babaReader: new D1BabaStore({ db: env.DB }),
      // 日報の作成の依頼(Issue #235)。DAILY_REPORT が無い構成では渡さない(依頼しない)。
      ...(requestReport === undefined ? {} : { requestReport }),
      loadSettings: async () => {
        const loaded = await loadSettings(env.DB);
        if (loaded.source === "invalid") {
          console.warn("設定の行(cloud_settings)が JSON として読めないので、既定値で続けます");
        }
        return loaded.settings;
      },
    });
  }

  /** レースの事前分析を予約する(RPC。予約だけをして戻る)。 */
  schedule(input: ScheduleInput): Promise<ScheduleResult> {
    return this.core.schedule(input);
  }

  /**
   * 同じ開催日の複数のレースに、同じ種類のタスクを一括で予約する(RPC。Issue #251。予約だけをして戻る。1 日の上限は全か無か)。
   * 呼ぶのは `POST /api/analyses/run/bulk`(handler.ts の `handleRunBulk`)だけ。
   */
  scheduleMany(input: ScheduleManyInput): Promise<ScheduleManyResult> {
    return this.core.scheduleMany(input);
  }

  /**
   * 事前分析(旧「朝の準備」)の計画を依頼する(RPC。Issue #203。依頼だけをして戻る。2回目以降は `already-planned`で、アラームだけ状態から張り直す〈Issue #206 G-E2〉)。
   * `rescue: true`(Issue #249。23 時の再実行)は、21 時に失敗した一覧・事前分析を **1 回だけ** 救済し、救済の後の失敗の判定・通知を有効にする(2 回目以降は何も変えない)。
   * 呼ぶのは cron の `scheduled`(scheduled.ts。Issue #206)だけ。
   */
  requestPlan(input: { readonly kaisaiDate: string; readonly rescue?: boolean }): Promise<RequestPlanResult> {
    return this.core.requestPlan(input);
  }

  /**
   * 結果の取り込みを依頼する(RPC。Issue #208。依頼だけをして戻る。冪等)。呼ぶのは `dispatchResultImports`（result-dispatch.ts）だけ。
   * 今日以降の開催日・無効な入力は例外（RPC 越しは型が落ちる）。
   */
  requestResultImport(input: { readonly kaisaiDate: string; readonly raceIds: readonly string[]; readonly winOddsOnly?: boolean }): Promise<RequestResultImportResult> {
    return this.core.requestResultImport(input);
  }

  /** 結果の取り込みの観測（RPC。Issue #208 `GET /api/plan` が使う。状態は変えない。固定の語と数値だけ）。 */
  getResultImportProgress(): ResultImportProgress {
    return this.core.getResultImportProgress();
  }

  /** 事前分析の計画の読み取り(RPC。Issue #206 `GET /api/plan` が使う。状態は変えない)。 */
  getPlanProgress(): PlanProgress {
    return this.core.getPlanProgress();
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
