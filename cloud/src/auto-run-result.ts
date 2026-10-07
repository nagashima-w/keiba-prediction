/**
 * 自動実行(Issue #166)の各レースの結果を、状態から一意に読み取る分類器(Issue #204〈#166-C〉)。**純関数**: DO・SQL・時計を持たない。
 *
 * 通知(#205〈D〉)は、コールバックではなく**状態から作る**(DO の状態から「通知すべき結果」を読み、送った印は D が残す)。
 * ここは「何が起きたか」を決めるだけで、通知に出すか・どう出すかは決めない。
 *
 * 入力は3つの状態: 計画の行(`race_day_plan.state`・`skip_reason`)・同じレースの pre_race のタスク・自動の印(`race_day_auto_pre_race`。
 * 昇格が pre_race を積んだときに書く。手動の `schedule()` が積み直すときに消える)。
 *
 * 結果の種類:
 *  - `waiting`: 期限を待っている(planned)
 *  - `running`: 自動で積んだ pre_race が実行中(queued・fetched)
 *  - `completed`: 自動の pre_race が done(分析は D1 に保存されている。`analysisId` で引ける)
 *  - `failed`: 自動の pre_race が failed。`reason` は失敗する箇所が明示的に書いた値({@link AutoFailReason})
 *  - `skipped`: 実行しなかった。`reason` は {@link PlanSkipReason}(`manual` = 手動の分析が直前にある・手動が実行中)
 *  - `superseded`: 昇格したが、その後に手動の再実行が pre_race を上書きした(自動の結果は残っていない)
 */
import type { PlanRowState, PlanSkipReason } from "./race-day-plan";

/** 自動で積んだ pre_race の失敗の理由。 */
export type AutoFailReason =
  /** 発走済み(キューや再試行の待ちで発走を過ぎた)。netkeiba にも LLM にも出ずに failed にした。 */
  | "started"
  /** ブレーカーが開いている・許可リスト外(取得ステップ。再試行しない)。 */
  | "blocked"
  /** 取得ステップの試行が上限(3回)に尽きた。 */
  | "fetch-exhausted"
  /** 計算・保存ステップの試行が上限(3回)に尽きた。 */
  | "compute-exhausted";

/** 発走済みで実行しなかった pre_race の、タスクのエラー文(固定。板〈`getBoard`〉の `error` にそのまま出る)。 */
export const AUTO_RUN_STARTED_ERROR = "発走済みのため、自動実行しませんでした";

export type AutoRunSkipReason = PlanSkipReason | "unknown";

export type AutoRunOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "running" }
  | { readonly kind: "completed"; readonly analysisId: number | null; readonly detail: "stored" | "failed" | "skipped" | null }
  | { readonly kind: "failed"; readonly reason: AutoFailReason | "unknown"; readonly message: string | null }
  | { readonly kind: "skipped"; readonly reason: AutoRunSkipReason }
  | { readonly kind: "superseded" };

export interface ClassifyInput {
  readonly planState: PlanRowState;
  readonly skipReason: PlanSkipReason | null;
  /** 同じレースの pre_race のタスク(無ければ null)。 */
  readonly task: {
    readonly status: "queued" | "fetched" | "done" | "failed";
    readonly queuedAt: number;
    readonly analysisId: number | null;
    readonly detail: "stored" | "failed" | "skipped" | null;
    readonly error: string | null;
  } | null;
  /** 自動の印(昇格が pre_race を積んだときに書いたもの。無ければ null)。 */
  readonly marker: { readonly enqueuedAt: number; readonly failReason: AutoFailReason | null } | null;
}

export function classifyAutoRun(input: ClassifyInput): AutoRunOutcome {
  const { planState, skipReason, task, marker } = input;
  if (planState === "planned") {
    return { kind: "waiting" };
  }
  if (planState === "skipped") {
    return { kind: "skipped", reason: skipReason ?? "unknown" };
  }
  // promoted: 印が今のタスクのインスタンスを指しているときだけ、自動の結果。
  if (task === null || marker === null || marker.enqueuedAt !== task.queuedAt) {
    return { kind: "superseded" };
  }
  if (task.status === "queued" || task.status === "fetched") {
    return { kind: "running" };
  }
  if (task.status === "done") {
    return { kind: "completed", analysisId: task.analysisId, detail: task.detail };
  }
  return { kind: "failed", reason: marker.failReason ?? "unknown", message: task.error };
}

/** スキップの行が、いつ決まったか。`plan` = 計画の時点(確定のとき。`buildPlanRow`)/ `promotion` = 昇格の時点(期限が来たとき。`promoteRow`)。 */
export type SkipStage = "plan" | "promotion";

/**
 * スキップの行が計画の時点か昇格の時点かを、計画の行の期限(`dueMs`)から読む(Issue #205 G-D3。通知は、昇格の時点のスキップだけをレースごとに送り、計画の時点のスキップは朝のまとめにだけ載せる)。
 * 根拠(2つの書き手の事実。`race-day-core.ts`): 計画の時点でスキップにする行は `due_ms: null` で書かれる(`buildPlanRow`)/ 昇格の時点のスキップ(`markSkipped`)は `due_ms` を更新しない
 * (planned だった行の期限が残る)。`disposition` は両方とも `skip` になるので判別に使えない。テスト(`race-day-notify.test.ts`)が、実際の確定と昇格を通して、この関係を固定している。
 */
export function skipStage(dueMs: number | null): SkipStage {
  return dueMs === null ? "plan" : "promotion";
}
