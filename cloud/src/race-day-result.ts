/**
 * 結果の取り込みの保存層(Issue #208〈#182-B〉。親 #182)。日単位の DO(`RaceDayCore`)の SQLite に、**新しい表だけ**を足す(既存の表には ALTER しない。`CREATE TABLE IF NOT EXISTS`)。
 * 純ロジック: `cloudflare:workers` を import しない。時計・gate・アラーム・D1 は持たない(呼び出し側の `RaceDayCore` が持つ)。ここは SQL の読み書きと、依頼の判定表だけ。
 *
 * `race_day_result`(1 レース 1 行。**`race_day_tasks` には入れない**: 1 日の上限 100 を食うため。中央 36R の計画だけで 72 行を使う)
 *  - `state`: `queued`(取り込み待ち。再試行待ちを含む)→ `imported`(D1 に保存した)/ `gave_up`(この依頼としては諦めた)
 *  - `attempts`: 取得を試みた回数(取得の前に永続化する)。`deferrals`: 試行に数えない保留(gate の混雑・ブレーカー)の回数
 *  - `next_try_at`: 次に試みる時刻(`queued` のときだけ意味がある)
 *  - `requested_on`: 依頼を受けた日(JST の暦日 YYYYMMDD。DO の時計から。**1 日 1 回**の判定に使う)
 *  - `last_class`: 直近の結果の分類(固定の語 {@link ResultClass}。メッセージ・例外の文面は持たない)
 *
 * ## 依頼の判定表({@link ResultImportStore.request})
 *  | 行の状態 | 動作 |
 *  | 行なし | 積む(`requested_on` = 今日) |
 *  | `queued` | 無視(進行中。別の日の依頼でも積み直さない) |
 *  | `imported` かつ `requested_on` = 今日 | 無視(取り込み完了後に来た古い列挙の重複) |
 *  | `imported` かつ `requested_on` < 今日 | 積み直す(呼び出し側が D1 を正として「未取込」と判断している) |
 *  | `gave_up` かつ `requested_on` = 今日 | 無視(同じ日の再依頼・cron の重複配信) |
 *  | `gave_up` かつ `requested_on` < 今日 | 積み直す(1 日 1 回。試行・保留を 0 に戻す) |
 *
 * ## 当日中の取り込み(Issue #209)
 * 計画の確定時に、`requested_on` = **開催日**の行を積む(`RaceDayCore.runPlanFinalize`)。`requested_on` が開催日と同じ行を「当日の行」と呼ぶ(過去日の依頼の行は `requested_on` が開催日より後)。
 * 当日の行だけ、(1) 最初の試行は発走 + {@link SAME_DAY_RESULT_DELAY_MS}、(2) 保存の条件に「全頭の着順がそろった」が加わる(分類 `incomplete`)、
 * (3) 再試行は {@link SAME_DAY_RETRY_DELAY_MS} おきに {@link MAX_SAME_DAY_ATTEMPTS} 回まで。**スキーマは変えない**(列を足さない: 稼働中の DO の表に ALTER が要るため)。
 * 判定表は変わらない: 当日に `gave_up` になった行は、翌日以降の cron(`requested_on` < 今日)の依頼で 1 回だけ積み直され、過去日の方式(3 試行・10 分おき)で取り込まれる。
 *
 * **起きたときに必ず状態が変わる**(アラームの候補になる行は、起きた処理が必ず状態を変える): `queued` の行 → 試行回数か保留の回数・状態({@link RaceDayCore} の結果のステップ)。
 */
import type { SqlLike } from "./sql-like";

/** 1 回の依頼での取得の試行の上限(取得の前に数える)。 */
export const MAX_RESULT_ATTEMPTS = 3;
/** 試行どうしの間隔(ミリ秒)。審議・未確定は短時間では直らないので、朝の取得の再試行(60 秒)より長い。 */
export const RESULT_RETRY_DELAY_MS = 10 * 60_000;
/** 保留(gate の混雑 `queue-full`・ブレーカー `blocked`)の間隔(ミリ秒)。`blocked` は解除時刻が分かればその 1 秒後。 */
export const RESULT_BUSY_DELAY_MS = 60_000;
/** 保留の上限(試行に数えない)。6 回目で諦める。 */
export const MAX_RESULT_DEFERRALS = 5;
/**
 * 当日中の取り込み(Issue #209)。計画の確定時に積む行(`requested_on` = 開催日。過去日の行は `requested_on` が開催日より後)に使う。
 * 最初の試行は発走の 15 分後(地方の実測: 払戻は発走 +9.7 分で出るが、全頭の着順は +13.7 分にそろった。1 レースの実測)、
 * 再試行は 5 分おきに最大 10 回(最後の試行は発走 + 60 分)。上限に達したら諦め、翌日以降の cron の取り込み(#208)が拾う。
 */
export const SAME_DAY_RESULT_DELAY_MS = 15 * 60_000;
export const SAME_DAY_RETRY_DELAY_MS = 5 * 60_000;
export const MAX_SAME_DAY_ATTEMPTS = 10;
/** 結果ページの「N頭」が取れず、全頭の着順がそろったか判定できないときの試行の上限(構造が変わったときに、全行が 10 回ずつ無駄に再試行しないための歯止め)。 */
export const MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS = 2;
/** 当日中の取り込みとして積む結果の行の上限(1 日の上限 120 のうち、翌日以降の cron の依頼が足す新しい行のために 20 を残す)。 */
export const MAX_SAME_DAY_RESULT_ROWS = 100;
/** 1 日(1 つの DO)の結果の行の上限。`race_day_tasks` の上限(100)とは別枠。 */
export const MAX_RESULT_ROWS_PER_DAY = 120;
/** 1 回の `requestResultImport` で受けるレースの数の上限。 */
export const MAX_RESULT_RACES_PER_REQUEST = 120;

export type ResultState = "queued" | "imported" | "gave_up";

/**
 * 直近の結果の分類(固定の語)。
 *  - `imported`: 保存した / `not-confirmed`: 結果の行が無い(未確定・中止) / `no-payout`: 着順はあるが払戻のテーブルが無い(審議中。保存しない)
 *  - `parse-error`: 構造の異常 / `fetch-failed`: 取得の失敗(HTTP エラー・通信の失敗・タイムアウト) / `save-failed`: D1 への保存の失敗
 *  - `blocked`: ブレーカーが開いている・許可リスト外 / `busy`: gate の待ち行列が上限
 *  - `incomplete`(Issue #209。当日の行だけ): 払戻のテーブルはあるが、全頭の着順がそろっていない(着順が確定している行〈`finishPosition` が null でない行。非数値の着順を含み、空の行は含まない〉の数 < 結果ページの「N頭」)、または「N頭」が取れず判定できない。保存しない
 */
export type ResultClass = "imported" | "not-confirmed" | "no-payout" | "incomplete" | "parse-error" | "fetch-failed" | "save-failed" | "blocked" | "busy";

export interface ResultRow {
  readonly race_id: string;
  readonly state: ResultState;
  readonly attempts: number;
  readonly deferrals: number;
  readonly next_try_at: number;
  readonly requested_on: string;
  readonly last_class: ResultClass | null;
  readonly queued_at: number;
  readonly updated_at: number;
}

/** 依頼 1 件の判定。 */
export type RequestDecision = "accepted" | "in-progress" | "imported" | "already-today";

export class ResultImportStore {
  constructor(private readonly sql: SqlLike) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_result (
         race_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL, deferrals INTEGER NOT NULL, next_try_at INTEGER NOT NULL,
         requested_on TEXT NOT NULL, last_class TEXT, queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    );
  }

  row(raceId: string): ResultRow | null {
    const rows = this.sql.exec("SELECT * FROM race_day_result WHERE race_id = ?", raceId).toArray() as ResultRow[];
    return rows[0] ?? null;
  }

  count(): number {
    return (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_result").toArray() as { n: number }[])[0]?.n ?? 0;
  }

  /** 依頼 1 件の判定(上の表)。状態は変えない。 */
  decide(raceId: string, today: string): RequestDecision {
    const row = this.row(raceId);
    if (row === null) {
      return "accepted";
    }
    if (row.state === "queued") {
      return "in-progress";
    }
    if (row.requested_on < today) {
      return "accepted";
    }
    return row.state === "imported" ? "imported" : "already-today";
  }

  /**
   * 積む(新しい行、または前の日の依頼の行の積み直し)。試行・保留・分類を作り直す。
   * `nextTryAt`: 最初の試行の時刻(省略は now = すぐ)。当日中の取り込み(Issue #209)は発走 + 15 分を渡す。
   */
  enqueue(raceId: string, today: string, now: number, nextTryAt: number = now): void {
    this.sql.exec(
      `INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at)
       VALUES (?, 'queued', 0, 0, ?, ?, NULL, ?, ?)
       ON CONFLICT(race_id) DO UPDATE SET state = 'queued', attempts = 0, deferrals = 0, next_try_at = excluded.next_try_at,
         requested_on = excluded.requested_on, last_class = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at`,
      raceId,
      nextTryAt,
      today,
      now,
      now,
    );
  }

  /** 時刻が来ている `queued` の行(次の試行の時刻の早い順、同じなら レースID 順)。無ければ null。 */
  nextDue(now: number): ResultRow | null {
    const rows = this.sql
      .exec("SELECT * FROM race_day_result WHERE state = 'queued' AND next_try_at <= ? ORDER BY next_try_at, race_id LIMIT 1", now)
      .toArray() as ResultRow[];
    return rows[0] ?? null;
  }

  /** `queued` の行の次の試行の時刻の最小(アラームの候補)。無ければ null。 */
  nextTryAtMs(): number | null {
    const rows = this.sql.exec("SELECT MIN(next_try_at) AS at FROM race_day_result WHERE state = 'queued'").toArray() as { at: number | null }[];
    return rows[0]?.at ?? null;
  }

  /** 取得の前に、試行回数を永続化する(取得の途中でクラッシュしても、再実行が無限に続かない)。 */
  markAttempt(raceId: string, attempts: number, now: number): void {
    this.sql.exec("UPDATE race_day_result SET attempts = ?, updated_at = ? WHERE race_id = ?", attempts, now, raceId);
  }

  markImported(raceId: string, now: number): void {
    this.sql.exec("UPDATE race_day_result SET state = 'imported', last_class = 'imported', updated_at = ? WHERE race_id = ?", now, raceId);
  }

  /** 再試行する(試行回数は `markAttempt` で数え済み)。 */
  markRetry(raceId: string, nextTryAt: number, lastClass: ResultClass, now: number): void {
    this.sql.exec("UPDATE race_day_result SET state = 'queued', next_try_at = ?, last_class = ?, updated_at = ? WHERE race_id = ?", nextTryAt, lastClass, now, raceId);
  }

  /** 保留する: 試行回数を `attempts`(取得の前に数えた分を戻した値)にし、保留の回数を `deferrals` にする。 */
  markDeferred(raceId: string, attempts: number, deferrals: number, nextTryAt: number, lastClass: ResultClass, now: number): void {
    this.sql.exec(
      "UPDATE race_day_result SET state = 'queued', attempts = ?, deferrals = ?, next_try_at = ?, last_class = ?, updated_at = ? WHERE race_id = ?",
      attempts,
      deferrals,
      nextTryAt,
      lastClass,
      now,
      raceId,
    );
  }

  markGaveUp(raceId: string, deferrals: number, lastClass: ResultClass, now: number): void {
    this.sql.exec("UPDATE race_day_result SET state = 'gave_up', deferrals = ?, last_class = ?, updated_at = ? WHERE race_id = ?", deferrals, lastClass, now, raceId);
  }

  rows(): ResultRow[] {
    return this.sql.exec("SELECT * FROM race_day_result ORDER BY race_id").toArray() as ResultRow[];
  }
}
