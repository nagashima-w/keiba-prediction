/**
 * 地方(NAR)三連単の軸ごとの取得(Issue #283)の進み具合の表 `race_day_nar_trifecta`(DO の SQLite)。
 *
 * ## なぜ別の段階か
 * 地方の三連単は軸(1着固定)ごとに頭数ぶんのリクエストが要る(`docs/trifecta-odds-investigation.md` §3.3)。
 * 発走前の取得ステップ(1回のアラーム)に詰め込むと、地方 16 頭の冷えた状態で gate への呼び出しが 52 本になり、
 * Cloudflare の 1 呼び出しあたりのサブリクエスト上限(Free で 50)に対して余裕が無い(DO 内のソケットや RPC が
 * 数えられるか、本番のプランが Free か Paid かは未確認)。そこで、**取得ステップは三連単を除いて今までどおり**
 * (`ScrapeRaceOptions.deferNarTrifecta`)にし、三連単は**別のアラームの呼び出し**で軸を {@link NAR_TRIFECTA_AXES_PER_STEP}
 * 本ずつ取って DO の取得キャッシュ(`fetch_cache`)に積む。計算ステップは、いつもどおりキャッシュだけから
 * `scrapeRace` を走らせ、地方三連単をキャッシュからインラインで読む(専用の読み込みコードは無い)。
 *
 * ## 表
 * 主キーは (race_id, instance, axis)。`instance` はタスクの `queued_at`(再予約で新しくなる=別の実行を区別する)。
 * `state`: `pending`(未取得)→ `fetched`(本文をキャッシュに積んだ)| `failed`(取得できなかった。計算ステップでは
 * キャッシュに無い軸として `fetchFailed` になり、部分被覆の警告になる)。再開時は `pending` の軸だけを取る。
 *
 * ⚠️ DO の SQLite の表は `CREATE TABLE IF NOT EXISTS` だけで作る(`RaceDayCore` のコンストラクタが呼ぶ。新しい表なので ALTER は不要)。
 */
import type { SqlLike } from "./sql-like";

/** 1回のアラーム(1ステップ)で取る軸の最大本数(Issue #283)。18 頭立てでも 2 アラーム。 */
export const NAR_TRIFECTA_AXES_PER_STEP = 9;

export type NarTrifectaAxisState = "pending" | "fetched" | "failed";

export class NarTrifectaStore {
  constructor(private readonly sql: SqlLike) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_nar_trifecta (
         race_id TEXT NOT NULL, instance INTEGER NOT NULL, axis INTEGER NOT NULL, state TEXT NOT NULL,
         PRIMARY KEY (race_id, instance, axis))`,
    );
  }

  /** 新しい実行の軸を全部 pending で登録する。同じレースの古い行(前の実行・前の試行)は先に消す。軸が空なら何も入れない。 */
  begin(raceId: string, instance: number, axes: readonly number[]): void {
    this.clear(raceId);
    for (const axis of axes) {
      this.sql.exec("INSERT INTO race_day_nar_trifecta (race_id, instance, axis, state) VALUES (?, ?, ?, 'pending')", raceId, instance, axis);
    }
  }

  /** 未取得(pending)の軸を昇順に、最大 `limit` 件。 */
  pendingAxes(raceId: string, instance: number, limit: number): number[] {
    const rows = this.sql
      .exec("SELECT axis FROM race_day_nar_trifecta WHERE race_id = ? AND instance = ? AND state = 'pending' ORDER BY axis LIMIT ?", raceId, instance, limit)
      .toArray() as { axis: number }[];
    return rows.map((r) => r.axis);
  }

  hasPending(raceId: string, instance: number): boolean {
    const rows = this.sql
      .exec("SELECT 1 AS x FROM race_day_nar_trifecta WHERE race_id = ? AND instance = ? AND state = 'pending' LIMIT 1", raceId, instance)
      .toArray();
    return rows.length > 0;
  }

  /** 軸の結果を書く(取得の直後に、次の軸を取る前に呼ぶ=再開時に取り直さないため)。 */
  mark(raceId: string, instance: number, axis: number, state: Exclude<NarTrifectaAxisState, "pending">): void {
    this.sql.exec("UPDATE race_day_nar_trifecta SET state = ? WHERE race_id = ? AND instance = ? AND axis = ?", state, raceId, instance, axis);
  }

  /** 残りの pending を failed にする(ブレーカーが開いたとき等の打ち切り)。変えた件数を返す。 */
  failAllPending(raceId: string, instance: number): number {
    const n = this.pendingAxes(raceId, instance, Number.MAX_SAFE_INTEGER).length;
    this.sql.exec("UPDATE race_day_nar_trifecta SET state = 'failed' WHERE race_id = ? AND instance = ? AND state = 'pending'", raceId, instance);
    return n;
  }

  /** 状態ごとの軸の数(ログ用)。 */
  counts(raceId: string, instance: number): Record<NarTrifectaAxisState, number> {
    const rows = this.sql
      .exec("SELECT state, COUNT(*) AS n FROM race_day_nar_trifecta WHERE race_id = ? AND instance = ? GROUP BY state", raceId, instance)
      .toArray() as { state: NarTrifectaAxisState; n: number }[];
    const result: Record<NarTrifectaAxisState, number> = { pending: 0, fetched: 0, failed: 0 };
    for (const r of rows) {
      result[r.state] = r.n;
    }
    return result;
  }

  /** そのレースの行をすべて消す。 */
  clear(raceId: string): void {
    this.sql.exec("DELETE FROM race_day_nar_trifecta WHERE race_id = ?", raceId);
  }

  /** 進行中(queued・fetched)の発走前のタスクのインスタンスに一致しない行を消す(掃除。`wakeWithoutWork` が呼ぶ)。 */
  clearOrphans(): void {
    this.sql.exec(
      `DELETE FROM race_day_nar_trifecta WHERE NOT EXISTS (
         SELECT 1 FROM race_day_tasks t
          WHERE t.race_id = race_day_nar_trifecta.race_id AND t.mode = 'pre_race' AND t.queued_at = race_day_nar_trifecta.instance AND t.status IN ('queued', 'fetched'))`,
    );
  }
}
