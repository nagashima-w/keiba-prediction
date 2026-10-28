/**
 * 通知の表(Issue #205〈#166-D〉G-D1)。日単位の DO(`RaceDayCore`)の SQLite に、**新しい表だけ**を足す(既存の表には ALTER しない。`CREATE TABLE IF NOT EXISTS`)。
 * 純ロジック: `cloudflare:workers` を import しない。時計・送信は持たない(呼び出し側の `RaceDayCore` が持つ)。ここは SQL の読み書きだけ。
 *
 * `race_day_notify`: 1通知に1行。キーは `race:<raceId>`(レースごと。自動の実行インスタンスは1日に高々1つなのでレースIDで一意)と `summary`(事前分析のまとめ。1日に1通)と `plan-failure`(Issue #249。23 時の再実行の後も失敗が残るときの通知。1日に高々1通)と `header-unread`(Issue #522。出馬表の見出しを読めなかったレースがあったときの通知。1日に高々1通)。
 *  - `state`: `ready`(材料だけ積んである。completed の embed を、計算ステップが保存と同じ同期区間で書く)→ `sending`(**送る前**に書く)→ `sent` / `failed`(応答のあとに書く)。
 *    failed・skipped の通知は材料を持たないので、送るときに初めて `sending` で行を作る。
 *  - **多くとも1回(at-most-once)**: `sending` のまま落ちた行は、二度と候補にならない(再送しない。二重送信より欠落を選ぶ)。`failed` も自動では再送しない。
 *  - `payload_json`: 送る embed(JSON)。`analysis_id`: completed の通知の分析 id(監査用)。
 *  - `error_class`: 失敗の分類だけ(`http-<status>`・`timeout`・`rate-limited`・`network`・`other`、または送る前の `build`)。**例外のメッセージ・応答の本文・URL は保存しない。**
 *  - `race_day_header_unread`(Issue #522。別の表): 出馬表の見出しから馬場状態か芝の柵を読めなかった中央のレース。1レースに1行(`race_id` が主キー。計算の再試行で増えない)。
 *    `missing` は読めなかった項目(`馬場状態,柵,天候` のカンマ区切り。固定の語だけで、netkeiba 由来の文字列は入れない)、`recorded_at` は最初に見つけた時刻。
 *    通知(`header-unread`)は、この表が空でなければ、最初の記録の `HEADER_UNREAD_DELAY_MS` 後に送る(`notify-plan.ts`)。
 *  - meta のキー `notify_pace_until`: これ以前には送らない時刻(送信の間隔・失敗のクールダウン)。
 */
import { formatHeaderItems, type HeaderItem } from "./header-unread";
import type { NotifyKind, NotifyRowState, NotifyState } from "./notify-plan";
import type { SqlLike } from "./sql-like";

export interface NotifyRow {
  readonly key: string;
  readonly kind: NotifyKind;
  readonly state: NotifyState;
  readonly payload_json: string | null;
  readonly analysis_id: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly error_class: string | null;
}

/** 見出しを読めなかったレースの表の行(Issue #522)。 */
export interface HeaderUnreadRow {
  readonly race_id: string;
  readonly missing: string;
  readonly recorded_at: number;
}

const META_PACE_UNTIL = "notify_pace_until";

export class NotifyStore {
  constructor(private readonly sql: SqlLike) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_notify (
         key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT, analysis_id INTEGER,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_class TEXT)`,
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS race_day_header_unread (race_id TEXT PRIMARY KEY, missing TEXT NOT NULL, recorded_at INTEGER NOT NULL)");
  }

  rows(): NotifyRow[] {
    return this.sql.exec("SELECT * FROM race_day_notify ORDER BY key").toArray() as NotifyRow[];
  }

  row(key: string): NotifyRow | null {
    const rows = this.sql.exec("SELECT * FROM race_day_notify WHERE key = ?", key).toArray() as NotifyRow[];
    return rows[0] ?? null;
  }

  /** 計画の判定に渡す形(キー → 種類・状態)。 */
  stateMap(): Map<string, NotifyRowState> {
    return new Map(this.rows().map((r) => [r.key, { kind: r.kind, state: r.state }]));
  }

  /** 材料(送る前の embed)を積む。既にあれば何もしない(再実行で、送信中・送信済みの行を巻き戻さない)。`kind` の既定は completed の分析(`analysis`)。23 時の失敗の通知は `plan-failure`(Issue #249)。 */
  putReady(key: string, payloadJson: string, analysisId: number | null, now: number, kind: NotifyKind = "analysis"): void {
    this.sql.exec(
      "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'ready', ?, ?, ?, ?, NULL) ON CONFLICT(key) DO NOTHING",
      key,
      kind,
      payloadJson,
      analysisId,
      now,
      now,
    );
  }

  /**
   * 送る前に `sending` にする(**`await` で送る前に、同期で**)。行が無ければ作る。`ready` の行は `sending` にする(材料の embed を残す)。
   * 既に `sending`・`sent`・`failed` なら何もせず false(二重に送らない)。
   */
  begin(key: string, kind: NotifyKind, payloadJson: string | null, analysisId: number | null, now: number): boolean {
    const existing = this.row(key);
    if (existing === null) {
      this.sql.exec(
        "INSERT INTO race_day_notify (key, kind, state, payload_json, analysis_id, created_at, updated_at, error_class) VALUES (?, ?, 'sending', ?, ?, ?, ?, NULL)",
        key,
        kind,
        payloadJson,
        analysisId,
        now,
        now,
      );
      return true;
    }
    if (existing.state !== "ready") {
      return false;
    }
    this.sql.exec("UPDATE race_day_notify SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'ready'", now, key);
    return true;
  }

  /** 応答のあとに `sent` か `failed`(分類つき)にする。`sending` の行だけ。 */
  finish(key: string, state: "sent" | "failed", errorClass: string | null, now: number): void {
    this.sql.exec("UPDATE race_day_notify SET state = ?, error_class = ?, updated_at = ? WHERE key = ? AND state = 'sending'", state, errorClass, now, key);
  }

  /** 見出しを読めなかったレースを記録する(Issue #522)。既にあれば何もしない(最初の値と時刻を保つ)。 */
  recordHeaderUnread(raceId: string, items: readonly HeaderItem[], now: number): void {
    this.sql.exec("INSERT INTO race_day_header_unread (race_id, missing, recorded_at) VALUES (?, ?, ?) ON CONFLICT(race_id) DO NOTHING", raceId, formatHeaderItems(items), now);
  }

  /** 記録の古い順(同時刻は race_id 順)。 */
  headerUnreadRows(): HeaderUnreadRow[] {
    return this.sql.exec("SELECT race_id, missing, recorded_at FROM race_day_header_unread ORDER BY recorded_at, race_id").toArray() as HeaderUnreadRow[];
  }

  /** 最初の記録の時刻。記録が無ければ null。 */
  headerUnreadFirstAt(): number | null {
    const rows = this.sql.exec("SELECT MIN(recorded_at) AS first_at FROM race_day_header_unread").toArray() as { first_at: number | null }[];
    return rows[0]?.first_at ?? null;
  }

  paceUntil(): number {
    const rows = this.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", META_PACE_UNTIL).toArray() as { value: string }[];
    const value = Number(rows[0]?.value ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  setPaceUntil(at: number): void {
    this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", META_PACE_UNTIL, String(at));
  }
}
