/**
 * 通知の計画(Issue #205〈#166-D〉G-D1・G-D2)。**純関数**: DO・SQL・時計・送信を持たない。
 *
 * 通知は、コールバックではなく**状態から作る**(#204 G-C2): 自動実行の結果(`getAutoRunResults`)・朝の計画(`getPlanProgress`)・通知の表の行から、
 * 「いま何を送るか(`sendNow`)」と「次にアラームを張る時刻(`nextAtMs`)」を、**同じ関数が同じ状態から**返す。`rearm` は `nextAtMs` を、送信のステップは `sendNow` を読む。
 * 別々に計算すると、アラームは鳴るのに何も送らない(即時ループ)・送るものがあるのにアラームが無い(停止)が起きうる。
 *
 * 不変条件:
 *  - I1: `nextAtMs ≤ now` なら `sendNow` がある(鳴ったアラームは必ず仕事をする)。逆に `sendNow` があれば `nextAtMs ≤ now`。
 *  - I2: webhook が無効(`enabled=false`)なら、`sendNow` も `nextAtMs` も null(材料を積まず、アラームも張らない)。
 *  - I3: 通知の行が `sending`・`sent`・`failed` のレース(と朝のまとめ)は二度と候補にならない(多くとも1回。`sending` のまま落ちたものも再送しない)。
 *  - I4: `sendNow` を実行すると必ず状態が変わる(送信のステップが、`await` の前に `sending` の行を書く)。→ `race-day-notify.test.ts` が、実際の実行で固定する。
 *
 * 送るものの決め方(G-D3):
 *  - `completed` → 材料の行(`ready`。計算ステップが保存と同じ同期区間で書く)があるときだけ。材料が無い completed(webhook を後から登録した等)は送らない。
 *  - `failed` → 赤い通知 / 昇格の時点の `skipped`(started・cap・no-start-time)→ 赤 / 昇格の時点の `skipped(manual)` → 灰色。
 *  - 計画の時点の `skipped`・`superseded`・`waiting`・`running` → レースごとの通知は送らない(計画の時点のスキップは朝のまとめにだけ載る)。
 *  - 朝のまとめ → {@link summaryEligibility}。1日に1回。レースごとの通知が先。
 */
import { skipStage } from "./auto-run-result";
import type { AutoRunResults, PlanProgress } from "./race-day-core";

/**
 * 通知の種類。`analysis` = 分析の embed(緑・灰)/ `failed` = 赤 / `skipped-manual` = 灰色 / `summary` = 事前分析のまとめ(旧「朝のまとめ」)/
 * `plan-failure` = 23 時の再実行の後も翌日の事前分析に失敗が残っているときの通知(Issue #249。1 日に高々 1 通。材料は判定の時点で積む)。
 */
export type NotifyKind = "analysis" | "failed" | "skipped-manual" | "summary" | "plan-failure";
/** 通知の状態。`ready` = 材料だけ積んである(送る前)/ `sending` = 送信中(送る前に書く)/ `sent` / `failed`。 */
export type NotifyState = "ready" | "sending" | "sent" | "failed";

export interface NotifyRowState {
  readonly kind: NotifyKind;
  readonly state: NotifyState;
}

/** 送る項目。`key` は通知の表の主キー(`race:<raceId>` か `summary`)。 */
export type NotifyItem =
  | { readonly key: `race:${string}`; readonly kind: "analysis" | "failed" | "skipped-manual"; readonly raceId: string }
  | { readonly key: "summary"; readonly kind: "summary" }
  | { readonly key: "plan-failure"; readonly kind: "plan-failure" };

/** 送信の間隔(ミリ秒)。連続する通知を 1 秒空ける(Discord の Webhook のレート制限に当たりにくくし、その間にタスクの step が走る余地を残す)。 */
export const SEND_SPACING_MS = 1000;
/** 送信に失敗したあとのクールダウン(ミリ秒)。Discord が止まっているとき、残りの通知を毎回 5 秒待たせてタスクを押しのけない。失敗した通知は再送しない。 */
export const FAILURE_COOLDOWN_MS = 60_000;
/** 朝のまとめの保険の時刻: 確定からこの時間が過ぎたら、未完了があっても送る(確定 + 60 分。すぐ実行の行は期限が確定と同時なので、「最初の期限」にはできない)。 */
export const SUMMARY_INSURANCE_MS = 60 * 60_000;

/** 計画の時点のスキップは、レースごとには送らない。結果から、送る通知の種類を決める(`completed` は材料の行があるときだけなので、ここでは null)。 */
export function notifyKindFor(r: AutoRunResults["results"][number]): "failed" | "skipped-manual" | null {
  const outcome = r.outcome;
  if (outcome.kind === "failed") {
    return "failed";
  }
  if (outcome.kind === "skipped" && skipStage(r.dueMs) === "promotion") {
    if (outcome.reason === "manual") {
      return "skipped-manual";
    }
    if (outcome.reason === "started" || outcome.reason === "cap" || outcome.reason === "no-start-time") {
      return "failed";
    }
  }
  return null;
}

/**
 * 朝のまとめを送る資格と、保険の時刻。
 *  - 確定済み(`stage === "done"`)でなければ資格なし・保険の時刻なし。
 *  - **対象が 0 件で、取得に失敗した会場も無い日は送らない**(ユーザー判断。`morningAllTerminal` は rows が 0 件でも真になるので、空の `every` には頼らず、明示の規則にする)。
 *    取得に失敗した会場がある日は、0 件でも送る(自動実行が壊れていることを知らせる)。
 *  - 資格: `morningAllTerminal`、または `now ≥ finalizedAt + 60 分`(保険)。
 */
export function summaryEligibility(progress: PlanProgress, nowMs: number): { readonly eligibleNow: boolean; readonly dueMs: number | null } {
  if (progress.stage !== "done" || progress.finalizedAt === null) {
    return { eligibleNow: false, dueMs: null };
  }
  const hasContent = progress.rows.length > 0 || progress.venues.some((v) => v.state === "failed");
  if (!hasContent) {
    return { eligibleNow: false, dueMs: null };
  }
  const dueMs = progress.finalizedAt + SUMMARY_INSURANCE_MS;
  return { eligibleNow: progress.morningAllTerminal || nowMs >= dueMs, dueMs };
}

export interface PlanNotificationsInput {
  /** webhook が有効か(`RaceDayDeps.notifier` があるか)。 */
  readonly enabled: boolean;
  readonly nowMs: number;
  readonly auto: AutoRunResults;
  readonly progress: PlanProgress;
  /** 通知の表の行(キー → 種類・状態)。 */
  readonly rows: ReadonlyMap<string, NotifyRowState>;
  /** これ以前には送らない時刻(送信の間隔・失敗のクールダウン。無ければ 0)。 */
  readonly paceUntilMs: number;
}

export interface NotificationPlan {
  readonly sendNow: NotifyItem | null;
  /** 次にアラームを張る時刻の候補(`now` より前でもよい。呼び出し側が `max(…, now)` を取る)。送るものも保険の時刻も無ければ null。 */
  readonly nextAtMs: number | null;
}

export function planNotifications(input: PlanNotificationsInput): NotificationPlan {
  if (!input.enabled) {
    return { sendNow: null, nextAtMs: null };
  }
  const { nowMs, rows, paceUntilMs } = input;
  // 送れる項目(ペースを無視した順序つきの一覧)。レースごとの通知が先、朝のまとめは最後。
  const eligible: NotifyItem[] = [];
  for (const r of input.auto.results) {
    const key = `race:${r.raceId}` as const;
    const existing = rows.get(key);
    if (existing !== undefined && existing.state !== "ready") {
      continue; // sending・sent・failed: 二度と送らない
    }
    if (r.outcome.kind === "completed") {
      if (existing !== undefined && existing.kind === "analysis") {
        eligible.push({ key, kind: "analysis", raceId: r.raceId });
      }
      continue;
    }
    if (existing !== undefined) {
      continue; // 材料の行(ready)があるが、結果が completed でなくなった(手動の再実行で superseded 等)
    }
    const kind = notifyKindFor(r);
    if (kind !== null) {
      eligible.push({ key, kind, raceId: r.raceId });
    }
  }
  // 23 時の再実行の後の失敗の通知(Issue #249)。材料(`ready`)が積まれているときだけ。sending・sent・failed は二度と候補にならない(I3)。レースごとの通知のあと・まとめの前。
  const planFailureRow = rows.get("plan-failure");
  if (planFailureRow !== undefined && planFailureRow.kind === "plan-failure" && planFailureRow.state === "ready") {
    eligible.push({ key: "plan-failure", kind: "plan-failure" });
  }
  const summaryRow = rows.get("summary");
  let summaryDueMs: number | null = null;
  if (summaryRow === undefined) {
    const summary = summaryEligibility(input.progress, nowMs);
    if (summary.eligibleNow) {
      eligible.push({ key: "summary", kind: "summary" });
    } else {
      summaryDueMs = summary.dueMs;
    }
  }
  if (eligible.length > 0) {
    // 送れる項目がある: ペースの時刻になれば送る。
    return { sendNow: nowMs >= paceUntilMs ? eligible[0]! : null, nextAtMs: paceUntilMs };
  }
  // 送れる項目が無い: まとめの保険の時刻(未来)だけが候補。ペースの時刻より前には送らない。
  return { sendNow: null, nextAtMs: summaryDueMs === null ? null : Math.max(summaryDueMs, paceUntilMs) };
}
