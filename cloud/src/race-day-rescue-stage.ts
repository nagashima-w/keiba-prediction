/**
 * 日単位の DO(`RaceDayCore`)の、**救済の段階**(Issue #249。Issue #399〈#390 R-9e の e3〉で `race-day-core.ts` から切り出した)。
 * **純ロジック**: `cloudflare:workers` を import しない。23 時の再実行(`requestPlan` の `rescue`)の救済(`rescue`)と、救済のあとの失敗の判定(`judge`・`judgeAtMs`)を持つ。
 * 計画の表(`PlanStore`)・SQL(判定の結果を `race_day_meta` に書くだけ)・時計・警告の出口・`race_day_meta` の読み・webhook の有無・通知の表(`putReady` だけ)・
 * 計画の観測(本体の `getPlanProgress`)・タスクを積む処理(本体の `enqueueTask`)は注入({@link RescueStageDeps})。
 * `BabaStage`・`CloseStage`・`ReportHoldStage`・`NotifyStage`・`ResultStage`・`PromoteStage`・`PlanStage` と同じ形で、`setAlarm`・`rearm`・`armAlarm` には触れない
 * (`rescue` は本体の `requestPlan` が、`judge` は `runNextStep` が呼び、張り直しは本体が行う)。**通知は積むだけで送らない**(送るのは `NotifyStage`。`notifier` は渡されず、有無だけを値で受ける)。
 *
 * ## 本体との境界
 *  - 本体の `requestPlan` が、依頼済みの日への rescue 付きの呼び出しで {@link RescueStage.rescue} を呼ぶ(戻り値のあとの `rearm` は本体)。
 *  - 本体の `runNextStep` が、計画の段階のあと・通知の前に {@link RescueStage.judge} を呼ぶ(同期)。本体の `rearm` が、通知の候補の一つとして {@link RescueStage.judgeAtMs} を呼ぶ。
 *  - 本体に残るもの: 依頼の受付(`requestPlan`。冪等性・開催日の検査)、計画の観測(`getPlanProgress`)、タスクの表の操作(`enqueueTask`)。
 *
 * 手順の仕様(記録は 1 回だけ・会場を戻して確定の印を外す・planned の failed の morning だけを積み直す・判定は 1 回だけ永続化・材料の組み立てが失敗しても最小の通知に代える)は
 * {@link RescueStage.rescue}・{@link RescueStage.judge} の JSDoc を参照。メソッドの本体は、参照先の名前(本体のメソッドを `this.` の注入された関数へ)以外、切り出し前から変えていない。
 */
import { buildPlanFailureEmbed, buildPlanFailureMinimalEmbed, type CloudEmbed } from "./notify-embeds";
import type { NotifyStore } from "./notify-store";
import { judgePlanRescue } from "./plan-failure";
import type { PlanStore } from "./race-day-plan";
import type { PlanProgress, TaskMode } from "./race-day-core";
import { errorMessage } from "./race-day-support";
import type { SqlLike } from "./sql-like";

/**
 * 23 時の再実行(救済)の後の失敗の判定の結果(`ok` か `failed`)を永続化するキー(Issue #249)。**判定は 1 回だけ**: 書かれたら二度と判定しない(後から手動で事前分析を再実行しても、通知は変わらない)。
 * webhook が無効(`notifier` なし)の構成では判定しない(書かない)。
 */
const RESCUE_VERDICT_KEY = "plan_rescue_verdict";

/** 通知の表のうち、この段階が使う部分(`putReady` だけ。材料を積むだけで、送信の状態は進めない)。 */
export type RescueNotifyStore = Pick<NotifyStore, "putReady">;

export interface RescueStageDeps {
  /** 計画の表(本体も同じものを持つ)。 */
  readonly plan: PlanStore;
  /** SQL(判定の結果を `race_day_meta` に書く 1 文だけに使う)。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`。鍵の形を伏せる包みを通した後のもの)。 */
  readonly onWarn: (message: string) => void;
  /** `race_day_meta` の読み(本体の `metaGet`。呼ぶたびに読む)。 */
  readonly metaGet: (key: string) => string | null;
  /** webhook が有効か(本体の `notifier !== undefined`)。無効なら判定しない・判定のためのアラームも作らない。送信そのものはこの段階の仕事ではないので、`notifier` は渡さない。 */
  readonly notifierEnabled: boolean;
  /** 通知の表(本体の `notifyStore`。`putReady` だけを使う)。 */
  readonly notifyStore: RescueNotifyStore;
  /** 計画の観測(本体の `getPlanProgress`。呼ぶたびに読む)。 */
  readonly getPlanProgress: () => PlanProgress;
  /** タスクを queued で積む(本体の `enqueueTask`)。 */
  readonly enqueueTask: (raceId: string, mode: TaskMode, now: number) => void;
}

export class RescueStage {
  private readonly plan: PlanStore;
  private readonly sql: SqlLike;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly metaGet: (key: string) => string | null;
  private readonly notifierEnabled: boolean;
  private readonly notifyStore: RescueNotifyStore;
  private readonly getPlanProgress: () => PlanProgress;
  private readonly enqueueTask: (raceId: string, mode: TaskMode, now: number) => void;

  constructor(deps: RescueStageDeps) {
    this.plan = deps.plan;
    this.sql = deps.sql;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.metaGet = deps.metaGet;
    this.notifierEnabled = deps.notifierEnabled;
    this.notifyStore = deps.notifyStore;
    this.getPlanProgress = deps.getPlanProgress;
    this.enqueueTask = deps.enqueueTask;
  }

  /**
   * 救済(Issue #249。本体の `requestPlan` の `rescue`)。**同期**(`await` なし。途中で落ちても、記録が最後に書かれる前に落ちれば次の呼び出しがやり直し、書かれたあとなら完了している)。
   *  1. 記録(`plan_rescue_at`)が既にあれば何もしない(1 回だけ)。
   *  2. 一覧の取得に失敗した会場を pending に戻し、確定の印を外す(確定は冪等: 既にある計画の行は変わらず、足りない行と morning だけが足される。最初に決めた offset も残る)。
   *  3. 計画中(planned)のレースの failed の morning を、新しい実行として積み直す(試行 0)。実行中(queued・fetched)・done・スキップの行は触れない。
   * 戻した会場の取得と再確定・積み直した morning の実行は、いつもどおりアラームの中で行う(呼び出し側が `rearm` する)。
   */
  rescue(): void {
    const now = this.now();
    // 先に記録を書く: 同期の区間なので、途中で例外になっても記録だけが残ることはない(DO の入力ゲートが、書き込みの途中で別の呼び出しを割り込ませない)。
    if (!this.plan.markRescueRequested(now)) {
      return;
    }
    if (this.plan.resetFailedVenues(now) > 0) {
      this.plan.reopenFinalize();
    }
    for (const row of this.plan.rowsWithMorning()) {
      if (row.state === "planned" && row.morning === "failed") {
        this.enqueueTask(row.race_id, "morning", now);
      }
    }
  }

  /** 失敗の判定の入力(今の状態から作る。状態は変えない)。 */
  private verdictNow(): ReturnType<typeof judgePlanRescue> {
    const rescueAtMs = this.plan.rescueRequestedAt();
    if (rescueAtMs === null) {
      return { kind: "none" }; // 救済の要求が無い日(21 時だけ・手動)は、計画の写しを作らない(毎回のアラームの張り直しを重くしない)
    }
    return judgePlanRescue({ progress: this.getPlanProgress(), rescueAtMs, nowMs: this.now() });
  }

  /**
   * 失敗の判定のためにアラームを張る時刻(Issue #249)。webhook が無効・判定済み・救済の要求が無いときは null(判定のための起床を作らない)。
   * 落ち着いた(ok・failed が決まる)なら今、落ち着くのを待つ(wait)なら判定の期限。**起きたら必ず {@link RescueStage.judge} が状態を変える**(空回りしない)。
   */
  judgeAtMs(): number | null {
    if (!this.notifierEnabled || this.metaGet(RESCUE_VERDICT_KEY) !== null) {
      return null;
    }
    const verdict = this.verdictNow();
    return verdict.kind === "none" ? null : verdict.kind === "wait" ? verdict.dueMs : this.now();
  }

  /**
   * 23 時の再実行(救済)の後の失敗の判定(Issue #249。同期)。落ち着いた・期限が来たときに 1 回だけ、結果(`ok`・`failed`)を {@link RESCUE_VERDICT_KEY} に永続化する。
   * `failed` なら、通知の材料(`plan-failure` の `ready` の行)を同じ同期区間で積む(送るのは `NotifyStage.runStep`。`sending` を先に書くので多くとも 1 回)。
   * 材料の組み立てが失敗しても判定は止めず、最小の通知に代える。webhook が無効・判定済み・救済の要求が無い・待つ(wait)あいだは何もしない。
   */
  judge(): void {
    if (!this.notifierEnabled || this.metaGet(RESCUE_VERDICT_KEY) !== null) {
      return;
    }
    const verdict = this.verdictNow();
    if (verdict.kind === "none" || verdict.kind === "wait") {
      return;
    }
    const now = this.now();
    if (verdict.kind === "failed") {
      const kaisaiDate = this.metaGet("kaisai_date") ?? "";
      let embed: CloudEmbed;
      try {
        embed = buildPlanFailureEmbed({ kaisaiDate, progress: this.getPlanProgress(), reasons: verdict.reasons });
      } catch (error) {
        this.onWarn(`事前分析の失敗の通知の材料を組み立てられませんでした(最小の通知に代えます): ${errorMessage(error)}`);
        embed = buildPlanFailureMinimalEmbed(kaisaiDate);
      }
      this.notifyStore.putReady("plan-failure", JSON.stringify(embed), null, now, "plan-failure");
    }
    this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", RESCUE_VERDICT_KEY, verdict.kind);
  }
}
