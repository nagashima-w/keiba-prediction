/**
 * 23 時の再実行(救済)の後に、翌日の事前分析が失敗しているかの判定(Issue #249)。**純関数**: DO・SQL・時計・送信を持たない。
 * 日単位の DO(`RaceDayCore`)が、`getPlanProgress` の写しと救済の要求の時刻から呼ぶ(判定の結果を永続化し、失敗なら Discord の通知の材料を積む)。
 *
 * 失敗の定義(利用者の決定の範囲。`reasons` に件数で返す):
 *  - F1 `planNotFinal`: 計画が確定していない(判定の期限になっても確定しない)
 *  - F2 `venueFailures`: 一覧の取得に失敗した(failed の)会場がある。**その会場のレースは自動では分析されない**(最も重い)
 *  - F3 `morningFailed` / `capSkipped`: 事前分析(morning)が failed のレースがある。**上限超過(cap)のスキップも失敗に数える**(既存のまとめと同じ)。
 *    事前分析の失敗は発走前の分析を止めない(軽い失敗)
 *  - F4 `morningIncomplete`: 判定の期限になっても、事前分析が実行中(queued・fetched)のまま
 * 失敗ではないもの: スキップ(時刻不明・発走済み・間に合わない・手動の分析あり)・会場が ok で対象が 0 件・開催なしの日・morning を積んでいない行(morning = null)。
 *
 * **実行中は、それだけでは失敗にしない**: 落ち着く(確定済みで、会場が終端で、事前分析に実行中が無い)のを待って判定する。待つ上限は救済の要求から {@link RESCUE_WATCH_MS}(60 分)。
 */
import type { PlanProgress } from "./race-day-core";

/** 判定を待つ上限(ミリ秒)。救済の要求からこれだけ過ぎたら、落ち着いていなくても判定する(未完了は F4)。まとめの保険(`SUMMARY_INSURANCE_MS`)と同じ 60 分。 */
export const RESCUE_WATCH_MS = 60 * 60_000;

export interface PlanFailureReasons {
  /** F1: 計画が確定していない。 */
  readonly planNotFinal: boolean;
  /** F2: 一覧の取得に失敗した会場(理由は固定の語。無ければ null)。 */
  readonly venueFailures: readonly { readonly venue: "central" | "nar"; readonly reason: string | null }[];
  /** F3: 事前分析が failed のレースの数(上限超過のスキップを含まない)。 */
  readonly morningFailed: number;
  /** F3: 上限超過(cap)でスキップされたレースの数。 */
  readonly capSkipped: number;
  /** F4: 事前分析が実行中のままのレースの数。 */
  readonly morningIncomplete: number;
}

/**
 * 判定の結果。`none` = 救済の要求が無い(判定しない)/ `wait` = 落ち着くのを待つ(`dueMs` = 判定の期限)/ `ok` = 失敗なし / `failed` = 失敗(理由つき)。
 */
export type PlanVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "wait"; readonly dueMs: number }
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly reasons: PlanFailureReasons };

export interface JudgePlanRescueInput {
  readonly progress: PlanProgress;
  /** 救済を要求した時刻(`plan_rescue_at`。無ければ null)。 */
  readonly rescueAtMs: number | null;
  readonly nowMs: number;
}

export function judgePlanRescue(input: JudgePlanRescueInput): PlanVerdict {
  const { progress, rescueAtMs, nowMs } = input;
  if (rescueAtMs === null) {
    return { kind: "none" };
  }
  const running = progress.rows.filter((r) => r.morning === "queued" || r.morning === "fetched").length;
  const planNotFinal = progress.stage !== "done";
  const settled = !planNotFinal && !progress.venues.some((v) => v.state === "pending") && running === 0;
  const dueMs = rescueAtMs + RESCUE_WATCH_MS;
  if (!settled && nowMs < dueMs) {
    return { kind: "wait", dueMs };
  }
  const reasons: PlanFailureReasons = {
    planNotFinal,
    venueFailures: progress.venues.filter((v) => v.state === "failed").map((v) => ({ venue: v.venue, reason: v.reason })),
    morningFailed: progress.rows.filter((r) => r.morning === "failed").length,
    capSkipped: progress.rows.filter((r) => r.state === "skipped" && r.skipReason === "cap").length,
    morningIncomplete: running,
  };
  const failed = reasons.planNotFinal || reasons.venueFailures.length > 0 || reasons.morningFailed > 0 || reasons.capSkipped > 0 || reasons.morningIncomplete > 0;
  return failed ? { kind: "failed", reasons } : { kind: "ok" };
}
