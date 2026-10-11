/**
 * LLM の応答の記録の保存先(DO の SQLite の表 `race_day_llm_responses`。Issue #194〈#179-b〉)。
 * 冪等のため、**成功した応答を保存の前に記録**し、計算ステップの再実行では再生して LLM へ送り直さない(`createRecordingSender`。`llm-run.ts`)。
 * キーは (race_id, mode, 番号)。記録を消すのは、タスクが done・failed になったとき・再予約(新しい実行)のとき・掃除のとき(進行中でないタスクの孤立した行)。
 * ⚠️ DO の SQLite の表は `CREATE TABLE IF NOT EXISTS` だけで作る(`RaceDayCore` のコンストラクタが {@link SqlLlmResponseStore.ensureTable} を呼ぶ。新しい表なので ALTER は不要)。
 */
import type { LlmResponseStore, StoredLlmResponse } from "./llm-run";
import type { SqlLike } from "./sql-like";

export class SqlLlmResponseStore implements LlmResponseStore {
  constructor(
    private readonly sql: SqlLike,
    private readonly raceId: string,
    private readonly mode: string,
  ) {}

  static ensureTable(sql: SqlLike): void {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS race_day_llm_responses (race_id TEXT NOT NULL, mode TEXT NOT NULL, seq INTEGER NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY (race_id, mode, seq))",
    );
  }

  /** そのレース・mode の記録を消す。 */
  static clear(sql: SqlLike, raceId: string, mode: string): void {
    sql.exec("DELETE FROM race_day_llm_responses WHERE race_id = ? AND mode = ?", raceId, mode);
  }

  /** 進行中(queued・fetched)でないタスクの記録を消す(掃除。仕事が無い状態で呼ぶので、通常は全部が孤立した行)。 */
  static clearOrphans(sql: SqlLike): void {
    sql.exec(
      `DELETE FROM race_day_llm_responses WHERE NOT EXISTS (
         SELECT 1 FROM race_day_tasks t
          WHERE t.race_id = race_day_llm_responses.race_id AND t.mode = race_day_llm_responses.mode AND t.status IN ('queued', 'fetched'))`,
    );
  }

  get(index: number): StoredLlmResponse | undefined {
    const rows = this.sql.exec("SELECT response_json FROM race_day_llm_responses WHERE race_id = ? AND mode = ? AND seq = ?", this.raceId, this.mode, index).toArray() as { response_json: string }[];
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(row.response_json) as StoredLlmResponse;
    } catch {
      return undefined; // 壊れた行は、記録なしとして扱う(再生できないので実送信になる)
    }
  }

  put(index: number, response: StoredLlmResponse): void {
    this.sql.exec(
      `INSERT INTO race_day_llm_responses (race_id, mode, seq, response_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(race_id, mode, seq) DO UPDATE SET response_json = excluded.response_json`,
      this.raceId,
      this.mode,
      index,
      JSON.stringify(response),
    );
  }
}
