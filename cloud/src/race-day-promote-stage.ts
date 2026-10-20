/**
 * 日単位の DO(`RaceDayCore`)の、**計画の昇格の段階**(Issue #203 段階2・#204。Issue #399〈#390 R-9e の e2〉で `race-day-core.ts` から切り出した)。
 * **純ロジック**: `cloudflare:workers` を import しない。期限が来た計画の行(planned)を、手動の分析との重複・上限・時刻を見て pre_race のタスクに昇格する(またはスキップにする)。
 * 計画の表(`PlanStore`)・保存先(D1 の `findRecentByRace` だけ)・設定・タスクの表の読み書き(本体の `task`・`taskCount`・`enqueueTask`)・時計・警告の出口は注入({@link PromoteStageDeps})。
 * `BabaStage`・`CloseStage`・`ReportHoldStage`・`NotifyStage`・`ResultStage` と同じ形で、`setAlarm`・`rearm`・`armAlarm` には触れない(状態を必ず変えるので、張り直しは本体の `armAlarm`)。
 *
 * ## 本体との境界
 *  - 本体の `runNextStep` が、**ステップの先頭**で {@link PromoteStage.promoteDue} を 1 回 await する(続けて、同じ起床の中で、積んだ pre_race を処理できる)。
 *  - 本体に残るもの: 計画の一覧の取得・確定(`race-day-plan-stage.ts` の `PlanStage`。e1)、救済(`race-day-rescue-stage.ts` の `RescueStage`。e3)、タスクの表の操作(`task`・`taskCount`・`enqueueTask`)、`requestPlan`・`getPlanProgress` などの公開 RPC。
 *
 * 手順の仕様(確定済みの日だけ・重複の確認の条件・昇格の判定の順序)は {@link PromoteStage.promoteDue}・{@link PromoteStage.promoteRow} の JSDoc を参照。メソッドの本体は切り出し前から変えていない。
 */
import type { AnalysisSink, TaskMode, TaskStatus } from "./race-day-core";
import { resolveClipVariant } from "@keiba/core/pipeline";
import { redactSecrets } from "./llm-run";
import type { PlanRowRecord, PlanStore } from "./race-day-plan";
import { errorMessage } from "./race-day-support";
import type { CloudSettings } from "./settings";

/** 保存先のうち、この段階が使う部分(`AnalysisSink.findRecentByRace`。手動の分析との重複の確認だけ。`save` 系は渡さない)。 */
export type PromoteSink = Pick<AnalysisSink, "findRecentByRace">;

/** 昇格の判定に要る、タスクの行の列(本体の `TaskRow` の一部)。 */
export interface PromoteTaskRow {
  readonly status: TaskStatus;
  readonly queued_at: number;
}

export interface PromoteStageDeps {
  /** 計画の表(本体も同じものを持つ)。 */
  readonly plan: PlanStore;
  /** 手動の分析との重複の確認に使う D1 の窓口。無ければ(保存先が無い構成)確認は失敗として握られ、重複なし扱いになる。 */
  readonly sink: PromoteSink | undefined;
  /** 設定の読み取り(重複の確認で、現行の prompt_version を決めるために、候補があるときだけ呼ぶ)。 */
  readonly loadSettings: (() => Promise<CloudSettings>) | undefined;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`。鍵の形を伏せる包みを通した後のもの)。 */
  readonly onWarn: (message: string) => void;
  /** そのレース・モードのタスクの行(本体の `task`。呼ぶたびに読む)。 */
  readonly task: (raceId: string, mode: TaskMode) => PromoteTaskRow | null;
  /** タスクの行の総数(本体の `taskCount`。呼ぶたびに読む)。 */
  readonly taskCount: () => number;
  /** タスクを queued で積む(本体の `enqueueTask`)。 */
  readonly enqueueTask: (raceId: string, mode: TaskMode, now: number) => void;
  /** 1 日に積めるタスクの上限(本体の `MAX_TASKS_PER_DAY`)。 */
  readonly maxTasksPerDay: number;
  /** 手動の分析との重複とみなす窓(ミリ秒。本体の `MANUAL_DUPLICATE_WINDOW_MS`)。 */
  readonly manualDuplicateWindowMs: number;
}

export class PromoteStage {
  private readonly plan: PlanStore;
  private readonly sink: PromoteSink | undefined;
  private readonly loadSettings: (() => Promise<CloudSettings>) | undefined;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly task: (raceId: string, mode: TaskMode) => PromoteTaskRow | null;
  private readonly taskCount: () => number;
  private readonly enqueueTask: (raceId: string, mode: TaskMode, now: number) => void;
  private readonly maxTasksPerDay: number;
  private readonly manualDuplicateWindowMs: number;

  constructor(deps: PromoteStageDeps) {
    this.plan = deps.plan;
    this.sink = deps.sink;
    this.loadSettings = deps.loadSettings;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.task = deps.task;
    this.taskCount = deps.taskCount;
    this.enqueueTask = deps.enqueueTask;
    this.maxTasksPerDay = deps.maxTasksPerDay;
    this.manualDuplicateWindowMs = deps.manualDuplicateWindowMs;
  }

  /**
   * 期限が来た計画の行(planned で `due_ms ≤ now`)を昇格する。**確定済みの日だけ**(Issue #204 G-C3: 確定の途中で落ちた状態で先に昇格すると、その行には morning が積まれず、
   * `morningAllTerminal` が偽のまま残る。確定の前の期限は、アラームの候補にもしない〈{@link PlanStore.nextDueMs}〉)。
   * 行ごとに: 手動の分析との重複の確認(D1。必要なときだけ。{@link PromoteStage.hasRecentManualAnalysis})→ 同期の判定と投入({@link PromoteStage.promoteRow})。
   * **起きたときに必ず状態が変わる**(積めなくても skipped にする)。
   */
  async promoteDue(): Promise<void> {
    if (this.plan.finalizedAt() === null) {
      return;
    }
    for (const row of this.plan.dueRows(this.now())) {
      // D1 に出るのは、DO にそのレースの pre_race の行(done・failed)があるときだけ(D1 の analyses を書くのは pre_race の計算だけで、起動するのは schedule〈手動・この昇格〉だけ。
      // 行が無ければ手動の分析は存在しえない)。時刻の判定でスキップになる行・実行中の手動(queued・fetched)も、D1 に聞くまでもない。
      const existing = this.task(row.race_id, "pre_race");
      const duplicate =
        existing !== null && (existing.status === "done" || existing.status === "failed") && this.promotionTiming(row).kind !== "skip"
          ? await this.hasRecentManualAnalysis(row)
          : false;
      this.promoteRow(row.race_id, duplicate);
    }
  }

  /**
   * 昇格の時点の時刻の判定: **発走済み(`now ≥ start_ms`)だけ**をスキップ(`started`)にする。発走前なら、何分前でも昇格する。
   * 「発走まで 10 分未満〈too-late〉」は**計画の時点の判定にだけ**残す(`planPreRaceDue`)。昇格の時点でも判定すると、offset = 10 分(設定の最小値)では、アラームが期限から 1ms 遅れただけで
   * 全レースが too-late になる(期限 = 発走 − 10 分のため)。昇格が遅れて発走が近いときは走らせ、発走を過ぎたら取得・計算の各ステップの直前のガード(`failIfStarted`)が止める。
   * `start_ms` が null の行は計画の時点で `no-start-time` のスキップになっていて planned には来ない(到達しない分岐。来たらスキップにする)。
   */
  private promotionTiming(row: PlanRowRecord): { readonly kind: "ok" } | { readonly kind: "skip"; readonly reason: "started" | "no-start-time" } {
    if (row.start_ms === null) {
      return { kind: "skip", reason: "no-start-time" };
    }
    return this.now() >= row.start_ms ? { kind: "skip", reason: "started" } : { kind: "ok" };
  }

  /**
   * 手動の分析が直前にあるか(Issue #204 AC-C4)。同じレースの、分析時刻が **[期限 − 15 分, 今]**(両端を含む)の分析のうち、**現行の prompt_version で、LLM が実際に効いた**もの
   * (`model` あり。LLM が効かなかった fallback と、キー未登録の分析は数えない: 数えると、そのレースには prior のままの分析しか残らない)が 1 件でもあれば true。
   * 現行 = `resolveClipVariant(設定の clipVariant).promptVersion`。設定は、候補があるときだけ読む。
   * **読み取り(D1・設定)が失敗したら false(走らせる側に倒す)**: スキップに倒すと、そのレースの分析と通知が無くなる(利用者に見える損失)。重複した場合の被害は LLM 1 回分の費用と重複行だけ。
   */
  private async hasRecentManualAnalysis(row: PlanRowRecord): Promise<boolean> {
    try {
      const dueMs = row.due_ms;
      if (dueMs === null) {
        return false; // 到達しない(planned の行は期限を持つ)
      }
      const recent = await this.sink!.findRecentByRace(row.race_id, new Date(dueMs - this.manualDuplicateWindowMs).toISOString(), new Date(this.now()).toISOString());
      const candidates = recent.filter((a) => a.promptVersion !== null && a.model !== null);
      if (candidates.length === 0) {
        return false;
      }
      const settings = await this.loadSettings!();
      const current = resolveClipVariant(settings.clipVariant).promptVersion;
      return candidates.some((a) => a.promptVersion === current);
    } catch (error) {
      this.onWarn(`事前分析の計画: ${row.race_id} の手動の分析の確認に失敗したため、重複なしとして続けます(${redactSecrets(errorMessage(error))})`);
      return false;
    }
  }

  /**
   * 1行の昇格(同期。await なし)。`duplicate` は、手動の分析との重複の確認の結果(await の前に調べたもの)。**判定はここで、状態を読み直してから行う**(確認の await の間に、手動の予約が入りうる)。
   *  1. 行が planned でなければ何もしない
   *  2. 同じレースの pre_race が実行中(queued・fetched): 自動の印が今のタスクを指していれば(昇格で積んだあと、promoted にする前に落ちた再実行)promoted にするだけ。
   *     そうでなければ手動の実行中なので、積み直さず skipped(manual)
   *  3. 時刻の判定(発走済み〈started〉。時刻なしは到達しない)でスキップ(too-late は昇格の時点では判定しない: {@link PromoteStage.promotionTiming})
   *  4. 手動の分析との重複 → skipped(manual)
   *  5. 上限に達していれば skipped(cap)
   *  6. pre_race を積み、自動の印を書き、promoted にする(同じ `now`)
   */
  private promoteRow(raceId: string, duplicate: boolean): void {
    const row = this.plan.planRow(raceId);
    if (row === null || row.state !== "planned") {
      return;
    }
    const now = this.now();
    const existing = this.task(raceId, "pre_race");
    if (existing !== null && (existing.status === "queued" || existing.status === "fetched")) {
      const marker = this.plan.autoMarker(raceId);
      if (marker !== null && marker.enqueuedAt === existing.queued_at) {
        this.plan.markPromoted(raceId, now);
      } else {
        this.plan.markSkipped(raceId, "manual");
      }
      return;
    }
    const timing = this.promotionTiming(row);
    if (timing.kind === "skip") {
      this.plan.markSkipped(raceId, timing.reason);
      return;
    }
    if (duplicate) {
      this.plan.markSkipped(raceId, "manual");
      return;
    }
    if (existing === null && this.taskCount() >= this.maxTasksPerDay) {
      this.plan.markSkipped(raceId, "cap");
      return;
    }
    this.enqueueTask(raceId, "pre_race", now);
    this.plan.markAuto(raceId, now);
    this.plan.markPromoted(raceId, now);
  }
}
