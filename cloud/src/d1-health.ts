/**
 * D1 の疎通確認(`GET /api/health` が使う。Issue #171・#169-a)。
 *
 * この文は、**migration 0001(analyses)・0002(detail_key 列)・0005(llm_note 列。Issue #194)・0006(analysis_horses の highlights_json・concerns_json 列。Issue #197)・
 * 0007(llm_calls_json 列。Issue #197 段2)・0009(start_time 列。Issue #219。検証の DO が読む)が適用済みで、D1 の binding が実際に繋がっている**ことを1回の読み取りで確かめる(`SELECT 1` では、migration の未適用を見逃す)。
 * 馬の列は、スカラーの副問い合わせで読む(行が無くても、列が無ければ文の準備で失敗する)。codec は exe と共有で、馬の INSERT がこの2列を指すので、
 * migration の反映前に新しい Worker が出ると保存が壊れる。その状態を `d1.ok=false` で気づけるようにする。読み取り専用で、
 * 書き込み行は増えない(Free の書き込み 10 万行/日に影響しない)。失敗の理由(例外の文面・SQL・ID)は呼び出し元へ返さない。
 */

/** D1Database のうち、疎通確認が使う部分だけの型(テストで偽物を渡せる)。 */
export interface D1HealthDb {
  prepare(sql: string): { first(): Promise<unknown> };
}

export const D1_HEALTH_SQL =
  "SELECT detail_key, llm_note, llm_calls_json, (SELECT highlights_json FROM analysis_horses LIMIT 1) AS highlights_json, (SELECT concerns_json FROM analysis_horses LIMIT 1) AS concerns_json, start_time FROM analyses LIMIT 1";

/** D1 に繋がり、必要な表・列があるか。例外を投げない(binding が無い・クエリが失敗する場合は ok:false)。 */
export async function checkD1(db: D1HealthDb | undefined): Promise<{ readonly ok: boolean }> {
  try {
    await db!.prepare(D1_HEALTH_SQL).first();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
