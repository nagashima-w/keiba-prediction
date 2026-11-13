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
import { jstKaisaiDate, planPreRaceDue, selectAutoRunTargets } from "./auto-run-plan";
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

/**
 * 計画の行を作るのに要る、1 レースの情報(一覧の行 `RaceListEntry` の一部。**構造的に `RaceListEntry` が満たす**ので、確定は一覧の行をそのまま渡す。
 * 地方の普通のレースを事前分析の完了の時点で足すとき〈Issue #566〉は、出馬表から同じ形を組み立てて渡す)。
 */
export interface PlanRowSource {
  readonly raceId: string;
  readonly name: string;
  readonly raceNumber: number;
  readonly venue?: string;
  readonly grade?: string;
  readonly startTime?: string;
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
  /**
   * 発走前のオッズの記録(Issue #732)の予定を積む(本体が段階を持つときだけ渡す。省略時は積まない)。**中央のレースごと**(分析するかどうか・計画の行の state によらない)に、発走時刻が読めたものだけ呼ぶ。
   * 同期。失敗は握る(確定を止めない。段階が警告にする)。発走を過ぎていれば積まない(段階が判断する)。
   */
  readonly registerOddsSnapshot?: (raceId: string, kaisaiDate: string, startMs: number) => boolean;
}

/** 見回し({@link PlanStage.sweepNarMorningDone})の前回の試行の時刻(`race_day_meta`)。 */
const SWEEP_TRY_KEY = "nar_pre_race_sweep_try_at";

/** 見回しが評価済みで、計画の行を足さなかったレースの race_id(`race_day_meta` の JSON 配列。Issue #573-18)。 */
const SWEEP_SETTLED_KEY = "nar_pre_race_sweep_settled";

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
  private readonly registerOddsSnapshot: ((raceId: string, kaisaiDate: string, startMs: number) => boolean) | undefined;

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
    this.registerOddsSnapshot = deps.registerOddsSnapshot;
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
      // 発走前のオッズの記録の予定(Issue #732)。中央のレースだけ。計画の行の state(planned・skipped・cap・手動)によらない。発走時刻の無いレースは積まない。
      if (this.registerOddsSnapshot !== undefined && target.venue === "central" && row.start_ms !== null) {
        this.registerOddsSnapshot(entry.raceId, kaisaiDate, row.start_ms);
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

  /**
   * 地方の普通のレース(確定の対象〈中央の全件・地方の Jpn〉に入らないレース)の事前分析(morning)が完了したとき、発走前の分析(pre_race)の計画の行を足す(Issue #566)。
   * 期限・すぐ実行・スキップの判定は確定と同じ({@link PlanStage.buildPlanRow}。offset は計画の offset が決まっていればそれ、まだなら `fallbackOffsetMinutes`〈呼び出し側の設定の値〉)。
   * **足さないもの**: 地方でないレース(中央は今までどおり確定の対象だけ)・既に計画の行があるレース(最初の計画を変えない)・開催日が未確定・
   * 判定がスキップになる行(発走済み・発走まで 10 分未満・発走時刻なし・上限。skipped の行も残さない。過去のレースや手動の再実行で自動実行の結果が skipped だらけにならないように)。
   * **morning は積まない**(この行は morning が完了した後に足すので、確定の「planned で morning が無ければ積む」にも当たらない。課金を増やさない)。同期(await なし)。足したら true。
   */
  registerNarMorningDone(source: PlanRowSource, fallbackOffsetMinutes: number): boolean {
    const kaisaiDate = this.metaGet("kaisai_date");
    if (kaisaiDate === null || Number(source.raceId.slice(4, 6)) <= 10 || this.plan.planRow(source.raceId) !== null) {
      return false;
    }
    const offset = this.plan.offset();
    const row = this.buildPlanRow("nar", source, kaisaiDate, offset === null ? fallbackOffsetMinutes : offset.minutes, this.now());
    if (row.state !== "planned") {
      return false;
    }
    this.plan.insertPlanRow(row);
    return true;
  }

  /**
   * 見回し(Issue #566。`runNextStep` の先頭から呼ぶ): 事前分析(morning)が done なのに計画の行が無い地方のレース(公開の時点で完了済みだった分・完了の時点の追加を取りこぼした分)に、
   * 地方の一覧から行を足す。**該当が無ければ何もしない**(SQL 1 本だけ。一覧は取りに行かない)。**開催日が今日〈JST〉より前の DO でも何もしない**(掃除のアラームの予約を延ばさないため)。投げない: 失敗は警告にして、次の起床で取り直す。
   * 一覧(`getRaceList`。ゲート経由のキャッシュ付き)は 1 回の見回しにつき 1 本。**試行の時刻を残し、`retryDelayMs` の間は取り直さない**(一覧に無いレースが残り続けても、起床のたびには取りに行かない)。
   *
   * **評価済みのレースは覚える**(Issue #573-18。`race_day_meta` の {@link SWEEP_SETTLED_KEY})。一覧を取れた見回しで、行を足さなかったレース(発走済み・発走まで 10 分未満・発走時刻なし・上限〈cap〉・一覧に無い)は、
   * 次の見回しの対象から外す。これらは一覧が変わらない限り足せない(時刻は戻らず、一覧の内容は同じ)のに、`done で行の無い地方のレース` の SQL には残り続けるので、外さないと、その日のうちは
   * 一覧のキャッシュ(6 時間)が切れるたびに netkeiba へ地方の一覧を取りに行く。**一覧の取得に失敗した起床と、一覧が空(ok で 0 件)の起床では覚えない**(次の起床で取り直す)。評価済みでないレース(あとから done になった分)は、今までどおり拾う。
   */
  async sweepNarMorningDone(): Promise<void> {
    try {
      // 該当の確認(SQL 1 本)を先に。該当が無い起床では、ほかの読み(開催日の meta など)を増やさない。
      if (this.unsettledNarMorningDone().length === 0) {
        return;
      }
      const kaisaiDate = this.metaGet("kaisai_date");
      // 過去の開催日の DO では見回さない(今日以降だけ)。発走済みなどで行を足せなかった morning done は過去の日にも残り続けるので、見回すと、掃除専用のアラームの起床のたびに
      // 一覧を取りに行き、一覧の掃除の予約(`purge_due_at`)を後ろへ延ばして、掃除が一度も走らなくなる。
      if (kaisaiDate === null || kaisaiDate < jstKaisaiDate(this.now())) {
        return;
      }
      const nowMs = this.now();
      const lastTry = this.metaGet(SWEEP_TRY_KEY);
      if (lastTry !== null && nowMs < Number(lastTry) + this.retryDelayMs) {
        return;
      }
      this.plan.metaSet(SWEEP_TRY_KEY, String(nowMs));
      const result = await this.getRaceList(kaisaiDate, "nar");
      if (!result.ok) {
        this.onWarn(`事前分析の計画: 地方の普通のレースの発走前の分析の計画を足せませんでした(一覧を取得できません。理由: ${result.reason})`);
        return;
      }
      if (result.races.length === 0) {
        // 空の一覧(公開前・一時的な空の応答)は、取得の失敗と同じ扱い: 評価済みにせず、`retryDelayMs` のあとに取り直す
        // (空の一覧はキャッシュされない〈`getRaceList`〉ので、次の見回しで本当に取り直す。警告は出さない: 開催のない日・公開前で毎回出ると騒がしい)。
        return;
      }
      const offsetMinutes = this.plan.offset()?.minutes ?? (await this.loadOffsetMinutes());
      const settledNow: string[] = [];
      for (const raceId of this.unsettledNarMorningDone()) {
        const entry = result.races.find((r) => r.raceId === raceId);
        if (entry === undefined || !this.registerNarMorningDone(entry, offsetMinutes)) {
          settledNow.push(raceId); // 足さなかった(一覧に無い・発走済み・間に合わない・発走時刻なし・上限)。次からは見回さない
        }
      }
      if (settledNow.length > 0) {
        this.plan.metaSet(SWEEP_SETTLED_KEY, JSON.stringify([...this.settledRaceIds(), ...settledNow]));
      }
    } catch (error) {
      this.onWarn(`事前分析の計画: 地方の普通のレースの発走前の分析の計画を足せませんでした(${errorMessage(error)})`);
    }
  }

  /** 見回しが評価済みにしたレースの race_id(`race_day_meta`。壊れていれば空)。 */
  private settledRaceIds(): string[] {
    const raw = this.metaGet(SWEEP_SETTLED_KEY);
    if (raw === null) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  /** done で行の無い地方のレースのうち、見回しがまだ評価していないもの。該当の SQL が 0 件なら、meta は読まない。 */
  private unsettledNarMorningDone(): string[] {
    const ids = this.plan.narMorningDoneWithoutPlanRow();
    if (ids.length === 0) {
      return [];
    }
    const settled = new Set(this.settledRaceIds());
    return ids.filter((id) => !settled.has(id));
  }

  /** 計画の offset が未決定のとき使う、設定の `preRaceOffsetMinutes`(設定の取得口が無い構成は既定値)。読めなければ投げる(呼び出し側が握る)。 */
  private async loadOffsetMinutes(): Promise<number> {
    return this.loadSettings === undefined ? DEFAULT_PRE_RACE_OFFSET_MINUTES : (await this.loadSettings()).preRaceOffsetMinutes;
  }

  /** 1対象の計画の行を作る(期限・すぐ実行・スキップの判定と、上限)。 */
  private buildPlanRow(venue: PlanVenue, entry: PlanRowSource, kaisaiDate: string, offsetMinutes: number, nowMs: number): PlanRowRecord {
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
