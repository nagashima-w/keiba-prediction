/**
 * 過去の結果の毎晩の取得(Issue #554)の、管理者の口(`GET /api/race-archive`)が返す状態の型。純粋な型だけ(core・DO・handler が共有する)。
 */

export interface RaceArchiveFetchStatus {
  /** `disabled`: 止める設定 / `running`: 動作中(待ちの理由は waitReason)/ `night-stopped`: 次の晩に自動で再開する / `manual-stopped`・`capacity-stopped`: 手で再開するまで動かさない。 */
  readonly state: "disabled" | "running" | "night-stopped" | "manual-stopped" | "capacity-stopped";
  /** いま動いていない理由(`active`・`before-start`・`outside-window`・`kaisai-day`・`day-undetermined`・`gate-breaker`・`gate-refusing`・`gate-busy`・`interval`・`night-limit`・`paused-failures`・`caught-up`・`stopped`…)。 */
  readonly waitReason: string;
  readonly nextRunAt: number | null;
  readonly notBeforeMs: number;
  readonly night: { readonly date: string | null; readonly requests: number; readonly saved: number; readonly failed: number; /** その晩に core の SQL が読んだ行数(本物の DO だけ数える。Issue #593) */ readonly rowsRead: number };
  readonly totals: {
    readonly months: { readonly pending: number; readonly done: number; readonly dead: number };
    readonly days: { readonly pending: number; readonly listed: number; readonly done: number; readonly dead: number };
    readonly races: { readonly pending: number; readonly done: number; readonly existing: number; readonly skipped: number; readonly dead: number };
  };
  /** 読めなくて以後取らないレースの、分類ごとの数。 */
  readonly skippedByClass: Readonly<Record<string, number>>;
  readonly lastStop: { readonly kind: string; readonly detail: string; readonly at: number; readonly resumeAt: number | null } | null;
  readonly autoResume: { readonly used: boolean; readonly resumedNight: string | null };
  readonly dbSizeBytes: number | null;
  readonly lastRequestAt: number | null;
}
