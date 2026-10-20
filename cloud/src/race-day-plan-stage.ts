/**
 * 日単位の DO(`RaceDayCore`)の、**計画の一覧と確定の段階**(Issue #203 段階2。Issue #399〈#390 R-9e の e1〉で `race-day-core.ts` から切り出した)。
 * **純ロジック**: `cloudflare:workers` を import しない。会場の一覧を取り(`runList`)、全会場が終端になったら計画を確定する(`runFinalize`。計画の行を書き、morning を積み、結果の取り込みの行を積む)。
 * 計画の表(`PlanStore`)・設定・時計・警告の出口・開催日の読み取り・タスクの表の読み書き・一覧の取得口(本体の `getRaceList`)・結果の行を積む処理は注入({@link PlanStageDeps})。
 * `BabaStage`・`CloseStage`・`ReportHoldStage`・`NotifyStage`・`ResultStage`・`PromoteStage` と同じ形で、`setAlarm`・`rearm`・`armAlarm` には触れない(状態を必ず変えるので、張り直しは本体の `armAlarm`)。
 * 一覧の取得は本体の `getRaceList` だけを通る(段階は gate・キャッシュ・取得口を持たない)。
 *
 * ## 本体との境界
 *  - 本体の `runNextStep` が、**ステップの先頭の昇格のあと**、次の試行の時刻が来ている会場があれば {@link PlanStage.runList}、なければ確定の試行の時刻が来ていれば {@link PlanStage.runFinalize} を 1 回 await する(戻り値のあとの `armAlarm` は本体)。
 *  - 本体に残るもの: 依頼の受付(`requestPlan`。救済は `race-day-rescue-stage.ts` の `RescueStage`〈e3〉に委ねる)、計画の観測(`getPlanProgress`・`getAutoRunResults`)、
 *    結果の取り込みの行を積む処理(`enqueueSameDayResults`。確定の同期区間から呼ぶ。結果の表は本体の `results` が持つので、関数で渡す)、タスクの表の操作(`task`・`taskCount`・`enqueueTask`)。
 *
 * 手順の仕様(試行回数は取得の前に永続化・再試行の上限・offset の決定と既定値へのフォールバック・原子性に頼らない冪等性・上限 cap)は {@link PlanStage.runList}・{@link PlanStage.runFinalize} の JSDoc を参照。
 * メソッドの本体は、参照先の名前(定数・本体のメソッドを `this.` の注入された関数へ)以外、切り出し前から変えていない。
 */
import { planPreRaceDue, selectAutoRunTargets } from "./auto-run-plan";
import { DEFAULT_PRE_RACE_OFFSET_MINUTES, startTimeEpochMs } from "./pre-race-time";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import type { RaceListResult, RaceListVenue, TaskMode, TaskStatus } from "./race-day-core";
import { PLAN_VENUES, type PlanRowRecord, type PlanSkipReason, type PlanStore, type PlanVenue } from "./race-day-plan";
import { errorMessage } from "./race-day-support";
import type { CloudSettings } from "./settings";

/** 計画の段階の 1 ステップ(`StepOutcome` の 1 種。`mode: "plan"`)。`step: "list"` は 1 会場の一覧の取得(`raceId` は会場 `central`・`nar`)、`step: "finalize"` は確定(`raceId` は `plan`)。既存の `ran` と同じ形にしてあるのは、結果を `${raceId}:${mode}:${step}:${result}` のように読む呼び出し側を壊さないため。 */
export interface PlanStepOutcome {
  readonly kind: "ran";
  readonly raceId: string;
  readonly mode: "plan";
  readonly step: "list" | "finalize";
  readonly result: "ok" | "retry" | "failed";
}

/** 計画の確定が、タスクの行について知りたいこと(本体の `TaskRow` の一部。**行があるか**だけを見る)。 */
export interface PlanTaskRow {
  readonly status: TaskStatus;
}

export interface PlanStageDeps {
  /** 計画の表(本体も同じものを持つ)。 */
  readonly plan: PlanStore;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`。鍵の形を伏せる包みを通した後のもの)。 */
  readonly onWarn: (message: string) => void;
  /** `race_day_meta` の読み(本体の `metaGet`。呼ぶたびに読む)。 */
  readonly metaGet: (key: string) => string | null;
  /** 1 会場の一覧の取得(本体の `getRaceList`。gate 経由のキャッシュ・同時の呼び出しの合流・掃除のアラームは本体が持つ)。 */
  readonly getRaceList: (kaisaiDate: string, venue: RaceListVenue) => Promise<RaceListResult>;
  /** 設定の読み取り(確定の offset を決めるため)。 */
  readonly loadSettings: (() => Promise<CloudSettings>) | undefined;
  /** そのレース・モードのタスクの行(本体の `task`。呼ぶたびに読む)。 */
  readonly task: (raceId: string, mode: TaskMode) => PlanTaskRow | null;
  /** タスクの行の総数(本体の `taskCount`。呼ぶたびに読む)。 */
  readonly taskCount: () => number;
  /** タスクを queued で積む(本体の `enqueueTask`)。 */
  readonly enqueueTask: (raceId: string, mode: TaskMode, now: number) => void;
  /** 当日中の結果の取り込みの行を積む(本体の `enqueueSameDayResults`。結果ストアが無い構成などでは何もしない。確定の同期区間から呼ぶ)。 */
  readonly enqueueSameDayResults: (kaisaiDate: string, nowMs: number) => void;
  /** 取得・確定の試行の上限(本体の `MAX_ATTEMPTS`)。 */
  readonly maxAttempts: number;
  /** 再試行の間隔(ミリ秒。本体の `RETRY_DELAY_MS`)。 */
  readonly retryDelayMs: number;
  /** 1 日に積めるタスクの上限(本体の `MAX_TASKS_PER_DAY`)。 */
  readonly maxTasksPerDay: number;
}

export class PlanStage {
  private readonly plan: PlanStore;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly metaGet: (key: string) => string | null;
  private readonly getRaceList: (kaisaiDate: string, venue: RaceListVenue) => Promise<RaceListResult>;
  private readonly loadSettings: (() => Promise<CloudSettings>) | undefined;
  private readonly task: (raceId: string, mode: TaskMode) => PlanTaskRow | null;
  private readonly taskCount: () => number;
  private readonly enqueueTask: (raceId: string, mode: TaskMode, now: number) => void;
  private readonly enqueueSameDayResults: (kaisaiDate: string, nowMs: number) => void;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxTasksPerDay: number;

  constructor(deps: PlanStageDeps) {
    this.plan = deps.plan;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.metaGet = deps.metaGet;
    this.getRaceList = deps.getRaceList;
    this.loadSettings = deps.loadSettings;
    this.task = deps.task;
    this.taskCount = deps.taskCount;
    this.enqueueTask = deps.enqueueTask;
    this.enqueueSameDayResults = deps.enqueueSameDayResults;
    this.maxAttempts = deps.maxAttempts;
    this.retryDelayMs = deps.retryDelayMs;
    this.maxTasksPerDay = deps.maxTasksPerDay;
  }

  /**
   * 計画の段階: 1会場の一覧を取る(1ステップ = gate への取得 1 本)。試行回数は取得の**前**に永続化する(クラッシュしても再実行が無限に続かない)。
   * 成功(空の一覧も)→ ok。失敗は、`blocked`(ブレーカー・許可リスト外)なら再試行せず failed、それ以外(busy・failed)は上限 `maxAttempts` まで `retryDelayMs` 後に再試行して、尽きたら failed。
   * 全会場が終端(ok・failed)になったら、確定の試行を now に予約する(次のステップが確定)。
   */
  async runList(venue: PlanVenue): Promise<PlanStepOutcome> {
    const row = this.plan.venueRow(venue)!;
    const attempts = row.attempts + 1;
    this.plan.markListAttempt(venue, attempts, this.now());
    const kaisaiDate = this.metaGet("kaisai_date");
    let result: RaceListResult;
    try {
      if (kaisaiDate === null) {
        throw new Error("開催日が未確定です");
      }
      result = await this.getRaceList(kaisaiDate, venue);
    } catch (error) {
      this.onWarn(`事前分析の計画: ${venue} の一覧の取得で想定外の失敗(${errorMessage(error)})`);
      result = { ok: false, reason: "failed" };
    }
    const now = this.now();
    if (result.ok) {
      this.plan.markListOk(venue, result.races.length, JSON.stringify(result.races), now);
      this.afterPlanVenueSettled(now);
      return { kind: "ran", raceId: venue, mode: "plan", step: "list", result: "ok" };
    }
    if (result.reason === "blocked" || attempts >= this.maxAttempts) {
      this.plan.markListFailed(venue, result.reason, now);
      this.onWarn(`事前分析の計画: ${venue} の一覧を取得できませんでした(試行 ${attempts} 回。理由: ${result.reason})`);
      this.afterPlanVenueSettled(now);
      return { kind: "ran", raceId: venue, mode: "plan", step: "list", result: "failed" };
    }
    this.plan.markListRetry(venue, now + this.retryDelayMs, result.reason, now);
    return { kind: "ran", raceId: venue, mode: "plan", step: "list", result: "retry" };
  }

  /** 会場が終端になったとき、全会場が終端なら、確定の試行を今に予約する(確定は別のステップ)。 */
  private afterPlanVenueSettled(now: number): void {
    if (this.plan.allVenuesTerminal() && this.plan.finalizedAt() === null) {
      this.plan.setFinalizeNextTryAt(now);
    }
  }

  /**
   * 計画の確定: offset を決め(設定を読む。読めなければ `maxAttempts` 回まで `retryDelayMs` 後に再試行し、尽きたら**既定の 45 分で確定して `plan_offset_source` に `default-fallback` を残す**)、
   * 対象(中央は全件・地方は Jpn だけ。取得できなかった会場は 0 件)ごとに、期限を計算して計画の行を書き、pre_race を走らせる行には morning を積む。
   *
   * **原子性に頼らない冪等性**(確定の途中で落ちても、再実行で正しく続く): 確定の印(`plan_finalized_at`)は最後に書く。計画の行は `ON CONFLICT DO NOTHING`(最初の計画を変えない)、
   * morning は**行がまだ無いときだけ**積む(状態に関係なく、既にあれば積み直さない)、offset は最初に決めた値を残す。再実行は、既にある行を飛ばして、足りない行・morning だけを足す。
   * skip の行には morning を積まない(pre_race が走らないので、取得のための本数を無駄にしない。中央 16 頭で戦績などの 19 本。騎手の成績を取るときは、保存先〈D1〉に無い騎手のぶん〈最大 M 本〉がさらに掛かる)。
   * 上限: 対象1件は morning と pre_race の2行を使うので、`既存のタスク行 + 計画済み(planned)の行 + 今回の行ぶん(2、または morning が既にあれば 1)> maxTasksPerDay` なら skipped(cap)。
   */
  async runFinalize(): Promise<PlanStepOutcome> {
    const attempts = this.plan.finalizeAttempts() + 1;
    this.plan.setFinalizeAttempts(attempts);
    if (this.plan.offset() === null) {
      try {
        const settings = await this.loadSettings!();
        this.plan.decideOffset(settings.preRaceOffsetMinutes, "settings");
      } catch (error) {
        if (attempts < this.maxAttempts) {
          this.plan.setFinalizeNextTryAt(this.now() + this.retryDelayMs);
          this.onWarn(`事前分析の計画: 設定を読めませんでした(試行 ${attempts} 回。再試行します): ${errorMessage(error)}`);
          return { kind: "ran", raceId: "plan", mode: "plan", step: "finalize", result: "retry" };
        }
        this.plan.decideOffset(DEFAULT_PRE_RACE_OFFSET_MINUTES, "default-fallback");
        this.onWarn(`事前分析の計画: 設定を読めなかったため、既定の ${DEFAULT_PRE_RACE_OFFSET_MINUTES} 分で計画しました(試行 ${attempts} 回): ${errorMessage(error)}`);
      }
    }
    // ここから await なし(同期の区間)。
    const kaisaiDate = this.metaGet("kaisai_date");
    const offset = this.plan.offset();
    if (kaisaiDate === null || offset === null) {
      throw new Error("開催日または offset が未確定です"); // 到達しない(依頼で開催日を固定し、上で offset を決めている)
    }
    const nowMs = this.now();
    const entriesOf = (venue: PlanVenue): RaceListEntry[] => {
      const row = this.plan.venueRow(venue);
      return row !== null && row.state === "ok" && row.entries_json !== null ? (JSON.parse(row.entries_json) as RaceListEntry[]) : [];
    };
    const targets = selectAutoRunTargets({ central: entriesOf("central"), nar: entriesOf("nar") });
    for (const target of targets) {
      const entry = target.entry;
      let row = this.plan.planRow(entry.raceId);
      if (row === null) {
        row = this.buildPlanRow(target.venue, entry, kaisaiDate, offset.minutes, nowMs);
        this.plan.insertPlanRow(row);
      }
      if (row.state === "planned" && this.task(entry.raceId, "morning") === null) {
        this.enqueueTask(entry.raceId, "morning", nowMs);
      }
    }
    for (const venue of PLAN_VENUES) {
      // 取得できた会場だけ(取得できなかった会場の「0 件」は、対象が無かったのか取れなかったのかが区別できない)。
      // さらに、**今回の確定が一覧の本体(`entries_json`)を持っている会場だけ**数え直す: 一覧の本体は確定のたびに捨てるので、救済の再確定(Issue #249)で、成功済みの会場は本体が無く、
      // 数え直すと対象 0 件に巻き戻る(一覧は 0 件で ok の会場も本体は "[]" で持つので、最初の確定では必ず数える)。
      const venueRow = this.plan.venueRow(venue);
      if (venueRow?.state === "ok" && venueRow.entries_json !== null) {
        this.plan.setTargeted(venue, targets.filter((t) => t.venue === venue).length);
      }
    }
    this.enqueueSameDayResults(kaisaiDate, nowMs);
    this.plan.markFinalized(nowMs);
    this.plan.clearEntries();
    return { kind: "ran", raceId: "plan", mode: "plan", step: "finalize", result: "ok" };
  }

  /** 1対象の計画の行を作る(期限・すぐ実行・スキップの判定と、上限)。 */
  private buildPlanRow(venue: PlanVenue, entry: RaceListEntry, kaisaiDate: string, offsetMinutes: number, nowMs: number): PlanRowRecord {
    const due = planPreRaceDue({ kaisaiDate, startTime: entry.startTime, offsetMinutes, nowMs });
    let startMs: number | null = null;
    if (entry.startTime !== undefined) {
      try {
        startMs = startTimeEpochMs(kaisaiDate, entry.startTime);
      } catch {
        startMs = null; // 読めない時刻は no-start-time(due.kind === "skip")になっている
      }
    }
    let disposition: PlanRowRecord["disposition"] = due.kind === "skip" ? "skip" : due.kind;
    let skipReason: PlanSkipReason | null = due.kind === "skip" ? due.reason : null;
    let state: PlanRowRecord["state"] = due.kind === "skip" ? "skipped" : "planned";
    if (state === "planned") {
      const need = this.task(entry.raceId, "morning") === null ? 2 : 1; // morning(まだ無ければ)と pre_race の行
      if (this.taskCount() + this.plan.plannedCount() + need > this.maxTasksPerDay) {
        disposition = "skip";
        skipReason = "cap";
        state = "skipped";
      }
    }
    return {
      race_id: entry.raceId,
      venue,
      venue_name: entry.venue ?? null,
      race_number: entry.raceNumber,
      race_name: entry.name,
      grade: entry.grade ?? null,
      start_time: entry.startTime ?? null,
      start_ms: startMs,
      due_ms: state === "planned" && due.kind !== "skip" ? due.dueMs : null,
      offset_minutes: offsetMinutes,
      disposition,
      skip_reason: skipReason,
      state,
      planned_at: nowMs,
      promoted_at: null,
    };
  }
}
