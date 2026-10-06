/**
 * D1 の疎通確認(`GET /api/health` が使う。Issue #171・#169-a)。
 *
 * `SELECT detail_key FROM analyses LIMIT 1` は、**migration 0001(analyses)と 0002(detail_key 列)が適用済みで、D1 の binding が
 * 実際に繋がっている**ことを1回の読み取りで確かめる(`SELECT 1` では、migration の未適用を見逃す)。読み取り専用で、
 * 書き込み行は増えない(Free の書き込み 10 万行/日に影響しない)。失敗の理由(例外の文面・SQL・ID)は呼び出し元へ返さない。
 */

/** D1Database のうち、疎通確認が使う部分だけの型(テストで偽物を渡せる)。 */
export interface D1HealthDb {
  prepare(sql: string): { first(): Promise<unknown> };
}

export const D1_HEALTH_SQL = "SELECT detail_key FROM analyses LIMIT 1";

/** D1 に繋がり、必要な表・列があるか。例外を投げない(binding が無い・クエリが失敗する場合は ok:false)。 */
export async function checkD1(db: D1HealthDb | undefined): Promise<{ readonly ok: boolean }> {
  try {
    await db!.prepare(D1_HEALTH_SQL).first();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
