/**
 * 朝の計画の保存層(Issue #203 段階2。親 #166)。日単位の DO(`RaceDayCore`)の SQLite に、**新しい表だけ**を足す(既存の表には ALTER しない。`CREATE TABLE IF NOT EXISTS`)。
 * 純ロジック: `cloudflare:workers` を import しない。時計・gate・アラームは持たない(呼び出し側の `RaceDayCore` が持つ)。ここは SQL の読み書きだけ。
 *
 *  - `race_day_plan_venue`: 計画の段階。会場(中央 `central`・地方 `nar`)ごとの一覧の取得の状態(pending → ok / failed)。再試行の待ちは時刻(`next_try_at`)で持つ。
 *    取得した一覧の本体(`entries_json`。`RaceListEntry` の配列の JSON)は、確定(finalize)まで持ち、確定したら捨てる。
 *  - `race_day_plan`: 対象レースごとの期限(計画時点の offset で固定)。state: `planned`(期限を待つ)→ `promoted`(pre_race を投入した)/ `skipped`(理由は `skip_reason`)。
 *  - `race_day_auto_pre_race`(Issue #204): **自動で積んだ pre_race の印**。昇格が pre_race を積んだ同じ同期区間で書き、手動の `schedule()` が pre_race を積み直すときに消す
 *    (印が有る ⇔ 今の pre_race のインスタンスは自動。**削除が主**で、到達できる経路では削除だけで足りる)。`enqueued_at` はそのタスクの `queued_at` と同じ値で、読む側が `queued_at` との等値も確かめる(**多層防御**。削除が漏れても、別の実行のタスクを自動と読まない)。`fail_reason` は、自動の pre_race が failed になる箇所が書く。
 *  - meta(`race_day_meta`)のキー: `plan_requested_at`・`plan_finalized_at`・`plan_offset`・`plan_offset_source`・`plan_finalize_attempts`・`plan_finalize_next_try_at`。
 *
 * **起きたときに必ず状態が変わる**(アラームの候補になる行は、起きた処理が必ず状態を変える。変わらないと、期限が過去のまま即時に起き続ける): pending の会場 → 試行回数・状態、
 * 確定待ち → 試行回数・確定、planned の期限 → promoted か skipped。
 */
import type { AutoFailReason } from "./auto-run-result";
import type { SqlLike } from "./sql-like";

export type PlanVenue = "central" | "nar";
/** 取得の順(中央 → 地方)。 */
export const PLAN_VENUES: readonly PlanVenue[] = ["central", "nar"];

export type VenueState = "pending" | "ok" | "failed";
export type PlanRowState = "planned" | "promoted" | "skipped";
export type PlanDisposition = "scheduled" | "immediate" | "skip";
/**
 * `cap` = 1日のタスクの上限(`MAX_TASKS_PER_DAY`)のため。`manual` = 手動の分析が直前にある(期限の 15 分前〜今に、現行の prompt_version で LLM が効いた分析がある)か、
 * 手動の pre_race が実行中(Issue #204)。ほかは `planPreRaceDue` の理由(`auto-run-plan.ts`)。
 */
export type PlanSkipReason = "no-start-time" | "started" | "too-late" | "cap" | "manual";

export interface VenueRow {
  readonly venue: PlanVenue;
  readonly state: VenueState;
  readonly attempts: number;
  readonly next_try_at: number;
  /** 直近の失敗の理由(`blocked`・`busy`・`failed`)。ok のときは null。 */
  readonly reason: string | null;
  readonly listed: number | null;
  readonly targeted: number | null;
  readonly entries_json: string | null;
  readonly updated_at: number;
}

export interface PlanRowRecord {
  readonly race_id: string;
  readonly venue: PlanVenue;
  readonly venue_name: string | null;
  readonly race_number: number | null;
  readonly race_name: string | null;
  readonly grade: string | null;
  readonly start_time: string | null;
  readonly start_ms: number | null;
  readonly due_ms: number | null;
  readonly offset_minutes: number;
  readonly disposition: PlanDisposition;
  readonly skip_reason: PlanSkipReason | null;
  readonly state: PlanRowState;
  readonly planned_at: number;
  readonly promoted_at: number | null;
}

const META_REQUESTED = "plan_requested_at";
const META_FINALIZED = "plan_finalized_at";
const META_OFFSET = "plan_offset";
const META_OFFSET_SOURCE = "plan_offset_source";
const META_FINALIZE_ATTEMPTS = "plan_finalize_attempts";
const META_FINALIZE_NEXT_TRY = "plan_finalize_next_try_at";

export class PlanStore {
  constructor(private readonly sql: SqlLike) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_plan_venue (
         venue TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL, next_try_at INTEGER NOT NULL, reason TEXT,
         listed INTEGER, targeted INTEGER, entries_json TEXT, updated_at INTEGER NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_plan (
         race_id TEXT PRIMARY KEY, venue TEXT NOT NULL, venue_name TEXT, race_number INTEGER, race_name TEXT, grade TEXT,
         start_time TEXT, start_ms INTEGER, due_ms INTEGER, offset_minutes INTEGER NOT NULL, disposition TEXT NOT NULL, skip_reason TEXT,
         state TEXT NOT NULL, planned_at INTEGER NOT NULL, promoted_at INTEGER)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_auto_pre_race (
         race_id TEXT PRIMARY KEY, enqueued_at INTEGER NOT NULL, fail_reason TEXT)`,
    );
  }

  // ---- meta ----

  metaGet(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }

  metaSet(key: string, value: string): void {
    this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** 既にあれば書かない(確定の再実行で、最初に決めた offset を変えない)。 */
  private metaSetIfAbsent(key: string, value: string): void {
    this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", key, value);
  }

  requestedAt(): number | null {
    const text = this.metaGet(META_REQUESTED);
    return text === null ? null : Number(text);
  }

  finalizedAt(): number | null {
    const text = this.metaGet(META_FINALIZED);
    return text === null ? null : Number(text);
  }

  offset(): { readonly minutes: number; readonly source: "settings" | "default-fallback" } | null {
    const minutes = this.metaGet(META_OFFSET);
    const source = this.metaGet(META_OFFSET_SOURCE);
    if (minutes === null || (source !== "settings" && source !== "default-fallback")) {
      return null;
    }
    return { minutes: Number(minutes), source };
  }

  /** offset を決める(最初の決定だけが残る)。 */
  decideOffset(minutes: number, source: "settings" | "default-fallback"): void {
    this.metaSetIfAbsent(META_OFFSET, String(minutes));
    this.metaSetIfAbsent(META_OFFSET_SOURCE, source);
  }

  finalizeAttempts(): number {
    return Number(this.metaGet(META_FINALIZE_ATTEMPTS) ?? 0);
  }

  setFinalizeAttempts(attempts: number): void {
    this.metaSet(META_FINALIZE_ATTEMPTS, String(attempts));
  }

  setFinalizeNextTryAt(at: number): void {
    this.metaSet(META_FINALIZE_NEXT_TRY, String(at));
  }

  markFinalized(now: number): void {
    this.metaSet(META_FINALIZED, String(now));
  }

  // ---- 依頼 ----

  /** 依頼済み(会場の行がある)か。 */
  requested(): boolean {
    return this.venueRows().length > 0;
  }

  /** 会場2つを pending で作り、依頼の時刻を残す。 */
  request(now: number): void {
    for (const venue of PLAN_VENUES) {
      this.sql.exec(
        "INSERT INTO race_day_plan_venue (venue, state, attempts, next_try_at, reason, listed, targeted, entries_json, updated_at) VALUES (?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?) ON CONFLICT(venue) DO NOTHING",
        venue,
        now,
        now,
      );
    }
    this.metaSetIfAbsent(META_REQUESTED, String(now));
  }

  // ---- 会場(計画の段階)----

  venueRows(): VenueRow[] {
    return this.sql.exec("SELECT * FROM race_day_plan_venue ORDER BY venue").toArray() as unknown as VenueRow[];
  }

  venueRow(venue: PlanVenue): VenueRow | null {
    const rows = this.sql.exec("SELECT * FROM race_day_plan_venue WHERE venue = ?", venue).toArray() as unknown as VenueRow[];
    return rows[0] ?? null;
  }

  /** 次に一覧を取りに行く会場(pending で、次の試行の時刻が来ているもの。中央 → 地方)。 */
  nextListVenue(now: number): PlanVenue | null {
    const rows = this.sql
      .exec("SELECT venue FROM race_day_plan_venue WHERE state = 'pending' AND next_try_at <= ? ORDER BY venue LIMIT 1", now)
      .toArray() as { venue: PlanVenue }[];
    return rows[0]?.venue ?? null;
  }

  /** 取得の前に、試行回数を永続化する(取得の途中でクラッシュしても、再実行が無限に続かない)。 */
  markListAttempt(venue: PlanVenue, attempts: number, now: number): void {
    this.sql.exec("UPDATE race_day_plan_venue SET attempts = ?, updated_at = ? WHERE venue = ?", attempts, now, venue);
  }

  markListOk(venue: PlanVenue, listed: number, entriesJson: string, now: number): void {
    this.sql.exec("UPDATE race_day_plan_venue SET state = 'ok', reason = NULL, listed = ?, entries_json = ?, updated_at = ? WHERE venue = ?", listed, entriesJson, now, venue);
  }

  markListRetry(venue: PlanVenue, nextTryAt: number, reason: string, now: number): void {
    this.sql.exec("UPDATE race_day_plan_venue SET state = 'pending', next_try_at = ?, reason = ?, updated_at = ? WHERE venue = ?", nextTryAt, reason, now, venue);
  }

  markListFailed(venue: PlanVenue, reason: string, now: number): void {
    this.sql.exec("UPDATE race_day_plan_venue SET state = 'failed', reason = ?, updated_at = ? WHERE venue = ?", reason, now, venue);
  }

  setTargeted(venue: PlanVenue, targeted: number): void {
    this.sql.exec("UPDATE race_day_plan_venue SET targeted = ? WHERE venue = ?", targeted, venue);
  }

  /** 一覧の本体を捨てる(確定のあと。DO の保存を膨らませない)。 */
  clearEntries(): void {
    this.sql.exec("UPDATE race_day_plan_venue SET entries_json = NULL");
  }

  /** すべての会場が終端(ok か failed)か(会場の行が無いときは false)。 */
  allVenuesTerminal(): boolean {
    const rows = this.venueRows();
    return rows.length > 0 && rows.every((r) => r.state !== "pending");
  }

  /** 確定待ち(全会場が終端で、確定の印が無い)か。 */
  finalizePending(): boolean {
    return this.allVenuesTerminal() && this.finalizedAt() === null;
  }

  /** 確定の試行の時刻が来ているか(時刻が無ければ来ているとみなす)。 */
  finalizeDue(now: number): boolean {
    if (!this.finalizePending()) {
      return false;
    }
    const text = this.metaGet(META_FINALIZE_NEXT_TRY);
    return text === null || Number(text) <= now;
  }

  // ---- アラームの候補 ----

  /** 計画の段階の次の試行の時刻(pending の会場の next_try_at の最小・確定待ちの試行の時刻)。無ければ null。 */
  nextTryAtMs(): number | null {
    const candidates: number[] = [];
    const venues = this.sql.exec("SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE state = 'pending'").toArray() as { at: number | null }[];
    if (venues[0]?.at !== null && venues[0]?.at !== undefined) {
      candidates.push(venues[0].at);
    }
    if (this.finalizePending()) {
      candidates.push(Number(this.metaGet(META_FINALIZE_NEXT_TRY) ?? 0));
    }
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  /**
   * 次に期限が来る planned の行の時刻。無ければ null。**確定済みの日だけ**(確定の前は null): 昇格は確定済みの日だけ動くので、確定の前に期限切れの行が候補になると、
   * 起きても状態が変わらないまま即時に起き続ける(確定待ちの再試行の待ちが未来のとき。Issue #204 G-C3)。
   */
  nextDueMs(): number | null {
    if (this.finalizedAt() === null) {
      return null;
    }
    const rows = this.sql.exec("SELECT MIN(due_ms) AS at FROM race_day_plan WHERE state = 'planned'").toArray() as { at: number | null }[];
    return rows[0]?.at ?? null;
  }

  /**
   * 計画の段階が終わっているか(Issue #209): 計画が依頼されていない、または、全会場の一覧が終端で確定済み。
   * `hasPlanWork` との違いは、**期限を待つ planned の行を「仕事」に数えない**こと。今日の DO では planned の行が最終レースまで残るので、
   * 結果の取り込み({@link RaceDayCore.resultsRunnable})が `hasPlanWork` を条件にすると、当日中は一度も動かない。
   * 期限が来た planned の行は、各ステップの先頭の昇格(`promoteDuePlans`)でタスクになり、タスクがあるあいだ結果は動かないので、発走前の分析を押しのけない。
   */
  planStageSettled(): boolean {
    if (!this.requested()) {
      return true;
    }
    return !this.venueRows().some((r) => r.state === "pending") && this.finalizedAt() !== null;
  }

  /** 計画の仕事が残っているか(依頼済みで、会場が pending・確定待ち・planned の行がある)。掃除のアラームや一覧の掃除の予約の判定に使う。 */
  hasPlanWork(): boolean {
    if (!this.requested()) {
      return false;
    }
    return this.venueRows().some((r) => r.state === "pending") || this.finalizedAt() === null || this.plannedCount() > 0;
  }

  // ---- 計画の行 ----

  planRow(raceId: string): PlanRowRecord | null {
    const rows = this.sql.exec("SELECT * FROM race_day_plan WHERE race_id = ?", raceId).toArray() as unknown as PlanRowRecord[];
    return rows[0] ?? null;
  }

  /** 行を足す(既にあれば何もしない。確定の再実行で、最初の計画を変えない)。 */
  insertPlanRow(row: PlanRowRecord): void {
    this.sql.exec(
      `INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING`,
      row.race_id,
      row.venue,
      row.venue_name,
      row.race_number,
      row.race_name,
      row.grade,
      row.start_time,
      row.start_ms,
      row.due_ms,
      row.offset_minutes,
      row.disposition,
      row.skip_reason,
      row.state,
      row.planned_at,
      row.promoted_at,
    );
  }

  /** 発走時刻のある計画の行(発走の早い順 → レースID 順)。当日中の結果の行を積むのに使う(Issue #209。skip の行も含む)。 */
  rowsWithStartTime(): { readonly race_id: string; readonly start_ms: number }[] {
    return this.sql
      .exec("SELECT race_id, start_ms FROM race_day_plan WHERE start_ms IS NOT NULL ORDER BY start_ms, race_id")
      .toArray() as { race_id: string; start_ms: number }[];
  }

  plannedCount(): number {
    return (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_plan WHERE state = 'planned'").toArray() as { n: number }[])[0]?.n ?? 0;
  }

  /** 期限が来た planned の行(期限の古い順 → レースID 順)。 */
  dueRows(now: number): PlanRowRecord[] {
    return this.sql.exec("SELECT * FROM race_day_plan WHERE state = 'planned' AND due_ms <= ? ORDER BY due_ms, race_id", now).toArray() as unknown as PlanRowRecord[];
  }

  markPromoted(raceId: string, now: number): void {
    this.sql.exec("UPDATE race_day_plan SET state = 'promoted', promoted_at = ? WHERE race_id = ? AND state = 'planned'", now, raceId);
  }

  markSkipped(raceId: string, reason: PlanSkipReason): void {
    this.sql.exec("UPDATE race_day_plan SET state = 'skipped', disposition = 'skip', skip_reason = ? WHERE race_id = ? AND state = 'planned'", reason, raceId);
  }

  // ---- 自動で積んだ pre_race の印(Issue #204)----

  /** 自動で積んだ印を書く(既にあれば作り直す。失敗の理由は消える)。pre_race を積んだのと同じ同期区間で呼ぶ。 */
  markAuto(raceId: string, enqueuedAt: number): void {
    this.sql.exec(
      "INSERT INTO race_day_auto_pre_race (race_id, enqueued_at, fail_reason) VALUES (?, ?, NULL) ON CONFLICT(race_id) DO UPDATE SET enqueued_at = excluded.enqueued_at, fail_reason = NULL",
      raceId,
      enqueuedAt,
    );
  }

  autoMarker(raceId: string): { readonly enqueuedAt: number; readonly failReason: AutoFailReason | null } | null {
    const rows = this.sql.exec("SELECT enqueued_at, fail_reason FROM race_day_auto_pre_race WHERE race_id = ?", raceId).toArray() as { enqueued_at: number; fail_reason: AutoFailReason | null }[];
    const row = rows[0];
    return row === undefined ? null : { enqueuedAt: row.enqueued_at, failReason: row.fail_reason };
  }

  /** 手動が pre_race を積み直すとき、自動の印を消す(手動が所有権を取る)。 */
  clearAuto(raceId: string): void {
    this.sql.exec("DELETE FROM race_day_auto_pre_race WHERE race_id = ?", raceId);
  }

  setAutoFailReason(raceId: string, reason: AutoFailReason): void {
    this.sql.exec("UPDATE race_day_auto_pre_race SET fail_reason = ? WHERE race_id = ?", reason, raceId);
  }

  /** 結果の読み取り用: 計画の行・同じレースの pre_race のタスク・自動の印(レースID 順)。確定の前でも返す(分類する側が stage で絞る)。 */
  rowsWithPreRace(): (PlanRowRecord & {
    readonly pre_status: "queued" | "fetched" | "done" | "failed" | null;
    readonly pre_queued_at: number | null;
    readonly pre_analysis_id: number | null;
    readonly pre_detail: "stored" | "failed" | "skipped" | null;
    readonly pre_error: string | null;
    readonly auto_enqueued_at: number | null;
    readonly auto_fail_reason: AutoFailReason | null;
  })[] {
    return this.sql
      .exec(
        `SELECT p.*, t.status AS pre_status, t.queued_at AS pre_queued_at, t.analysis_id AS pre_analysis_id, t.detail AS pre_detail, t.error AS pre_error,
                a.enqueued_at AS auto_enqueued_at, a.fail_reason AS auto_fail_reason
           FROM race_day_plan p
           LEFT JOIN race_day_tasks t ON t.race_id = p.race_id AND t.mode = 'pre_race'
           LEFT JOIN race_day_auto_pre_race a ON a.race_id = p.race_id
          ORDER BY p.race_id`,
      )
      .toArray() as never;
  }

  /** 計画の行と、同じレースの morning タスクの状態(無ければ null)。レースID 順。 */
  rowsWithMorning(): (PlanRowRecord & { readonly morning: string | null })[] {
    return this.sql
      .exec(
        `SELECT p.*, t.status AS morning FROM race_day_plan p
           LEFT JOIN race_day_tasks t ON t.race_id = p.race_id AND t.mode = 'morning' ORDER BY p.race_id`,
      )
      .toArray() as unknown as (PlanRowRecord & { readonly morning: string | null })[];
  }
}
