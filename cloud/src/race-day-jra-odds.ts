/**
 * JRA のオッズの段階(Issue #675。#668-D)の進み具合の表 `race_day_jra_odds`(DO の SQLite)と、取る頁の決め方。
 *
 * ## なぜ別の段階か
 * 発走前の取得ステップ(netkeiba の窓口を通す。1 回のアラームで最大 43 本)に、JRA の頁(最大 9 本)を足すと、Free のサブリクエスト 50 に余裕が無い。
 * そこで取得ステップは今までどおりにし、JRA の頁は**別のアラーム**で取る(地方三連単の段階〈`race-day-nar-trifecta.ts`〉と同じ型)。
 * 取った頁はその場でパースし、JSON を取得キャッシュに置く(`jra-odds-cache.ts`)。計算ステップはその JSON を読むだけ。
 *
 * ## 起床の分け方
 * 三連単以外の頁(単勝複勝・枠連・馬連・ワイド・馬単・3連複)を 1 起床、**三連単は単独の 1 起床**にする(三連単のパースは重い。メモリのピークを重ねない)。
 *
 * ## 表
 * 主キーは (race_id, instance, page)。`instance` はタスクの `queued_at`(再予約で新しくなる)。`state`: `pending` → `done`(JSON を置いた)| `failed`(取れなかった。その券種は netkeiba のまま)。
 *
 * ⚠️ DO の SQLite の表は `CREATE TABLE IF NOT EXISTS` だけで作る(新しい表なので ALTER は不要)。
 */
import { JRA_ODDS_PAGES, type JraOddsPage } from "../../packages/core/src/scraper/parse-jra-odds-index";
import type { SqlLike } from "./sql-like";

export type JraOddsPageState = "pending" | "done" | "failed";

/** 取る頁(取る順)。組合せが OFF なら単勝複勝だけ、ON なら単勝複勝 + 6 式別(三連単が最後)。 */
export function jraOddsPagesFor(includeComboOdds: boolean): readonly JraOddsPage[] {
  if (!includeComboOdds) {
    return ["tanpuku"];
  }
  return [...JRA_ODDS_PAGES.filter((p) => p !== "sanrentan"), "sanrentan"];
}

export class JraOddsStageStore {
  constructor(private readonly sql: SqlLike) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_jra_odds (
         race_id TEXT NOT NULL, instance INTEGER NOT NULL, page TEXT NOT NULL, state TEXT NOT NULL,
         PRIMARY KEY (race_id, instance, page))`,
    );
  }

  /** 新しい実行の頁を全部 pending で登録する。同じレースの古い行は先に消す。頁が空なら何も入れない。 */
  begin(raceId: string, instance: number, pages: readonly JraOddsPage[]): void {
    this.clear(raceId);
    for (const page of pages) {
      this.sql.exec("INSERT INTO race_day_jra_odds (race_id, instance, page, state) VALUES (?, ?, ?, 'pending')", raceId, instance, page);
    }
  }

  private pending(raceId: string, instance: number): JraOddsPage[] {
    const rows = this.sql.exec("SELECT page FROM race_day_jra_odds WHERE race_id = ? AND instance = ? AND state = 'pending'", raceId, instance).toArray() as { page: JraOddsPage }[];
    const wanted = new Set(rows.map((r) => r.page));
    return JRA_ODDS_PAGES.filter((p) => wanted.has(p));
  }

  hasPending(raceId: string, instance: number): boolean {
    return this.pending(raceId, instance).length > 0;
  }

  /** 次の起床で取る頁。三連単以外が残っていればそれらをまとめて、三連単だけが残っていれば三連単だけ。 */
  nextBatch(raceId: string, instance: number): JraOddsPage[] {
    const pending = this.pending(raceId, instance);
    const rest = pending.filter((p) => p !== "sanrentan");
    return rest.length > 0 ? rest : pending;
  }

  mark(raceId: string, instance: number, page: JraOddsPage, state: Exclude<JraOddsPageState, "pending">): void {
    this.sql.exec("UPDATE race_day_jra_odds SET state = ? WHERE race_id = ? AND instance = ? AND page = ?", state, raceId, instance, page);
  }

  /** 残りの pending を failed にする(開催選択・レース選択が失敗したとき等の打ち切り)。変えた件数を返す。 */
  failAllPending(raceId: string, instance: number): number {
    const n = this.pending(raceId, instance).length;
    this.sql.exec("UPDATE race_day_jra_odds SET state = 'failed' WHERE race_id = ? AND instance = ? AND state = 'pending'", raceId, instance);
    return n;
  }

  counts(raceId: string, instance: number): Record<JraOddsPageState, number> {
    const rows = this.sql
      .exec("SELECT state, COUNT(*) AS n FROM race_day_jra_odds WHERE race_id = ? AND instance = ? GROUP BY state", raceId, instance)
      .toArray() as { state: JraOddsPageState; n: number }[];
    const result: Record<JraOddsPageState, number> = { pending: 0, done: 0, failed: 0 };
    for (const r of rows) {
      result[r.state] = r.n;
    }
    return result;
  }

  clear(raceId: string): void {
    this.sql.exec("DELETE FROM race_day_jra_odds WHERE race_id = ?", raceId);
  }

  /** 進行中(queued・fetched)の発走前のタスクのインスタンスに一致しない行を消す(掃除)。 */
  clearOrphans(): void {
    this.sql.exec(
      `DELETE FROM race_day_jra_odds WHERE NOT EXISTS (
         SELECT 1 FROM race_day_tasks t
          WHERE t.race_id = race_day_jra_odds.race_id AND t.mode = 'pre_race' AND t.queued_at = race_day_jra_odds.instance AND t.status IN ('queued', 'fetched'))`,
    );
  }
}
