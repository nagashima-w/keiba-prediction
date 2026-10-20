/**
 * 日単位の DO(`RaceDayCore`)の、**Discord への通知の段階**(Issue #205〈#166-D〉。Issue #399〈#390 R-9c〉で `race-day-core.ts` から切り出した)。
 * **純ロジック**: `cloudflare:workers` を import しない。DO の SQLite の表(`race_day_notify`)と間隔の meta は `NotifyStore`(`notify-store.ts`)が持ち、この段階は**計画の判定・送る内容の作成・送信・材料の積み上げ**の手順だけを持つ。
 * 時計・保存先・送信口・警告の出口・状態の読み取りは注入({@link NotifyStageDeps})。`BabaStage`(`race-day-baba.ts`)・`CloseStage`(`race-day-close-stage.ts`)・`ReportHoldStage`(`race-day-report-hold-stage.ts`)と同じ形で、`setAlarm`・`rearm` には触れない
 * (アラームの候補〈{@link NotificationPlan.nextAtMs}〉を返すだけで、張るのは本体の `rearm`)。
 *
 * ## 本体との境界
 *  - 計画: 本体の `notifyPlan`(`runNextStep`・`peekNotifyPlan`・`rearm` の 3 箇所から呼ぶ薄い委譲)が {@link NotifyStage.plan} を呼ぶ。webhook が無効(`notifier` なし)なら、計画は何も返さない。
 *  - 送信: 本体の `runNextStep` が、昇格・計画の後・タスクの前に、計画の `sendNow` を {@link NotifyStage.runStep} に渡す。戻り値のあとの `armAlarm` は本体。
 *  - 材料: 本体の計算ステップ(`runPreRaceCompute`)の `saveAnalysis` が、分析の保存と**同じ同期区間**で、`analysis_id` の永続化より前に {@link NotifyStage.putAnalysisMaterial} を呼ぶ(2 箇所)。
 *  - 他の段階に有るもの: 23 時の再実行の後の失敗の判定(`race-day-rescue-stage.ts` の `RescueStage.judge`。救済の判定と一緒に計画の側に置く)。`plan-failure` の材料はそこが `NotifyStore` へ直接積み、送るのはこの段階。
 *
 * 手順の仕様(**多くとも 1 回**・送る前に `sending` の行を書く・落ちたものは再送しない)は、各メソッドの JSDoc と `race-day-core.ts` 冒頭の「通知」の項を参照。メソッドの本体は切り出し前から変えていない。
 */
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { buildAnalysisLink } from "./notify-link";
import {
  buildAnalysisNotificationEmbed,
  buildFailureEmbed,
  buildManualSkipEmbed,
  buildMinimalAnalysisEmbed,
  buildSummaryEmbed,
  notificationText,
  type CloudEmbed,
  type RaceLabel,
} from "./notify-embeds";
import { FAILURE_COOLDOWN_MS, planNotifications, SEND_SPACING_MS, type NotificationPlan, type NotifyItem } from "./notify-plan";
import { classifyNotifyError, type DiscordNotifier } from "./notify-send";
import type { NotifyStore } from "./notify-store";
import type { LlmOutcome } from "./llm-run";
import type { PlanRowRecord } from "./race-day-plan";
import { errorMessage } from "./race-day-support";
import type { AutoRunResults, PlanProgress, TaskMode } from "./race-day-core";

/** 1 ステップの結果(`StepOutcome` の 1 種)。`raceId` は、レースごとの通知ではそのレース、事前分析のまとめでは `summary`、23 時の失敗の通知では `plan-failure`。`failed` は送信の失敗か送る内容を作れなかったこと(再送しない)。 */
export interface NotifyStepOutcome {
  readonly kind: "ran";
  readonly raceId: string;
  readonly mode: "notify";
  readonly step: "send";
  readonly result: "ok" | "failed";
}

/** 材料の積み上げに要る、発走前のタスクの列(`TaskRow` の一部)。自動の印の判定(`isAutoTask`)に渡す。 */
export interface NotifyMaterialTask {
  readonly race_id: string;
  readonly mode: TaskMode;
  readonly queued_at: number;
}

export interface NotifyStageDeps {
  readonly store: NotifyStore;
  /** Discord への送信。無ければ(webhook が無効)通知の仕組み全体が無効。 */
  readonly notifier: DiscordNotifier | undefined;
  /** サイトの基点(分析の通知のタイトルのリンク用)。無ければリンクを付けない。 */
  readonly appBaseUrl: string | undefined;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`。鍵の形を伏せる包みを通した後のもの)。 */
  readonly onWarn: (message: string) => void;
  /** `race_day_meta` の読み(本体の `metaGet`。呼ぶたびに読む)。 */
  readonly metaGet: (key: string) => string | null;
  /** 自動の実行の結果(本体の `getAutoRunResults`)。 */
  readonly getAutoRunResults: () => AutoRunResults;
  /** 計画の読み取り(本体の `getPlanProgress`)。 */
  readonly getPlanProgress: () => PlanProgress;
  /** 計画の行(本体の `plan.planRow`)。 */
  readonly planRow: (raceId: string) => PlanRowRecord | null;
  /** このタスクは、昇格が積んだもの(自動)か(本体の `isAutoTask`)。 */
  readonly isAutoTask: (task: NotifyMaterialTask) => boolean;
}

export class NotifyStage {
  private readonly store: NotifyStore;
  private readonly notifier: DiscordNotifier | undefined;
  private readonly appBaseUrl: string | undefined;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly metaGet: (key: string) => string | null;
  private readonly getAutoRunResults: () => AutoRunResults;
  private readonly getPlanProgress: () => PlanProgress;
  private readonly planRow: (raceId: string) => PlanRowRecord | null;
  private readonly isAutoTask: (task: NotifyMaterialTask) => boolean;

  constructor(deps: NotifyStageDeps) {
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.appBaseUrl = deps.appBaseUrl;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.metaGet = deps.metaGet;
    this.getAutoRunResults = deps.getAutoRunResults;
    this.getPlanProgress = deps.getPlanProgress;
    this.planRow = deps.planRow;
    this.isAutoTask = deps.isAutoTask;
  }

  /** 通知の計画。webhook が無効(`notifier` なし)なら何もしない(行も材料も積まず、アラームの候補も出さない)。 */
  plan(): NotificationPlan {
    if (this.notifier === undefined) {
      return { sendNow: null, nextAtMs: null };
    }
    return planNotifications({
      enabled: true,
      nowMs: this.now(),
      auto: this.getAutoRunResults(),
      progress: this.getPlanProgress(),
      rows: this.store.stateMap(),
      paceUntilMs: this.store.paceUntil(),
    });
  }

  /**
   * 通知を1件送る(**多くとも1回**)。順序: (1)送る内容を作る(同期)→ (2)**送る前に `sending` の行を書く**(同期)→ (3)`await` で送る → (4)`sent`・`failed` を書き、次の送信の時刻(間隔・クールダウン)を置く(同期)。
   * 落ちて `sending` のまま残った行は、計画({@link planNotifications})が二度と候補にしない(再送しない)。送信の失敗は分析の状態に影響しない(例外は握り、分類だけを残す)。
   * **URL・例外のメッセージ・応答の本文は、状態にもログにも出さない**(`classifyNotifyError` の分類だけ)。
   */
  async runStep(item: NotifyItem): Promise<NotifyStepOutcome> {
    const raceId = item.kind === "summary" ? "summary" : item.kind === "plan-failure" ? "plan-failure" : item.raceId;
    const outcomeOf_ = (result: "ok" | "failed"): NotifyStepOutcome => ({ kind: "ran", raceId, mode: "notify", step: "send", result });
    let payloadJson: string;
    let analysisId: number | null = null;
    try {
      if (item.kind === "analysis" || item.kind === "plan-failure") {
        // 材料(`ready` の行)から送る。分析は計算ステップが、23 時の失敗の通知は救済の段階の `RescueStage.judge` が、積んだもの。
        const row = this.store.row(item.key);
        if (row === null || row.payload_json === null) {
          throw new Error("通知の材料がありません");
        }
        payloadJson = row.payload_json;
        analysisId = row.analysis_id;
      } else if (item.kind === "summary") {
        const kaisaiDate = this.metaGet("kaisai_date");
        if (kaisaiDate === null) {
          throw new Error("開催日が未確定です");
        }
        payloadJson = JSON.stringify(buildSummaryEmbed({ kaisaiDate, progress: this.getPlanProgress() }));
      } else {
        const result = this.getAutoRunResults().results.find((r) => r.raceId === item.raceId);
        if (result === undefined) {
          throw new Error("結果が見つかりません");
        }
        const label: RaceLabel = { raceId: result.raceId, venueName: result.venueName, raceNumber: result.raceNumber, raceName: result.raceName, startTime: result.startTime, grade: result.grade };
        const embed = item.kind === "skipped-manual" ? buildManualSkipEmbed(label) : buildFailureEmbed(label, notificationText(result.outcome));
        payloadJson = JSON.stringify(embed);
      }
    } catch (error) {
      // 送る内容を作れなかった: 送らず、failed(分類 build)にして終える(同じ項目を、毎回の起床で作り直し続けない)。
      const now = this.now();
      this.store.begin(item.key, item.kind, null, analysisId, now);
      this.store.finish(item.key, "failed", "build", now);
      this.store.setPaceUntil(now + SEND_SPACING_MS);
      this.onWarn(`Discord の通知の内容を作れませんでした(${item.key}): ${errorMessage(error)}`);
      return outcomeOf_("failed");
    }
    // 送る前に sending を書く(ここまで同期。落ちても再送しない)。
    if (!this.store.begin(item.key, item.kind, payloadJson, analysisId, this.now())) {
      return outcomeOf_("failed"); // 到達しない(計画は ready か行なしだけを返す)。二重に送らない。
    }
    let errorClass: string | null = null;
    try {
      await this.notifier!.send({ embeds: [this.withAnalysisLink(JSON.parse(payloadJson) as CloudEmbed, item, analysisId)] });
    } catch (error) {
      errorClass = classifyNotifyError(error);
    }
    const end = this.now();
    this.store.finish(item.key, errorClass === null ? "sent" : "failed", errorClass, end);
    this.store.setPaceUntil(end + (errorClass === null ? SEND_SPACING_MS : FAILURE_COOLDOWN_MS));
    if (errorClass !== null) {
      this.onWarn(`Discord への通知に失敗しました(${item.key}。分類: ${errorClass}。再送しません)`);
    }
    return outcomeOf_(errorClass === null ? "ok" : "failed");
  }

  /**
   * 分析の通知の embed に、タイトルのリンク(分析画面)を足す(Issue #230)。**送信の直前**に足す(材料には URL を入れない)。
   * 足すのは分析の通知(`kind: "analysis"`)で、基点(`appBaseUrl`)があり、分析 id が分かるときだけ。それ以外は embed のまま(リンクなしで通知する)。
   * 開催日は日のメタ(`kaisai_date`)、会場区分は計画の行(`venue`。行が無ければ中央)から取る。
   */
  private withAnalysisLink(embed: CloudEmbed, item: NotifyItem, analysisId: number | null): CloudEmbed {
    if (this.appBaseUrl === undefined || item.kind !== "analysis" || analysisId === null) {
      return embed;
    }
    const link = buildAnalysisLink(this.appBaseUrl, {
      date: this.metaGet("kaisai_date") ?? "",
      venue: this.planRow(item.raceId)?.venue === "nar" ? "nar" : "central",
      raceId: item.raceId,
      analysisId,
    });
    return link === undefined ? embed : { ...embed, url: link };
  }

  /**
   * 発走前の分析が保存された直後に、通知の材料(完成した embed)を積む。**保存した `record` から作る**(馬名・コース・距離は `record.raceSnapshot` にある。D1 の要約には無く、R2 は使えないことがある)。
   * 呼び出しは、`analysis_id` を永続化する**より前**(同じ同期区間)。ここで例外になれば `analysis_id` は永続されず、再試行が保存済みを検出して、もう一度ここを通る
   * (`analysis_id` があるのに材料が無い状態が、一瞬も現れない)。**webhook が無効・手動の pre_race(自動の印が無い)なら何もしない。**
   * embed の構築の失敗は握り、最小の embed(画面で確認)に代える(通知の失敗が分析を止めない)。材料の書き込みの SQL の例外は握らない(上の理由)。
   */
  putAnalysisMaterial(task: NotifyMaterialTask, record: AnalysisRecord, outcome: LlmOutcome, analysisId: number): void {
    if (this.notifier === undefined || !this.isAutoTask(task)) {
      return;
    }
    const row = this.planRow(task.race_id);
    const label: RaceLabel = {
      raceId: task.race_id,
      venueName: row?.venue_name ?? null,
      raceNumber: row?.race_number ?? null,
      raceName: row?.race_name ?? null,
      startTime: row?.start_time ?? null,
      grade: row?.grade ?? null,
    };
    let embed: CloudEmbed;
    try {
      embed = buildAnalysisNotificationEmbed(record, outcome, label);
    } catch (error) {
      this.onWarn(`発走前の分析(${task.race_id}): 通知の材料を組み立てられませんでした(最小の通知に代えます): ${errorMessage(error)}`);
      embed = buildMinimalAnalysisEmbed(label);
    }
    this.store.putReady(`race:${task.race_id}`, JSON.stringify(embed), analysisId, this.now());
  }
}
