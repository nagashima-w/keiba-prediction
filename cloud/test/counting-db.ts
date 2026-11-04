/**
 * テスト用: D1 の窓口の記録つき転送(Issue #598)。`prepare(sql).bind(...).all()` ごとに、SQL と `meta.rows_read` を記録する。
 * 補完の「1 晩ぶんの列挙の回数と rows_read の合計」を測るためのもの(`first()`・`run()`・`batch()` は記録せずに転送する)。
 */
import type { ResultDb } from "../src/result-repository";

export interface AllCall {
  readonly sql: string;
  readonly rowsRead: number;
}

const REAL = Symbol("real");

export function countingDb(real: D1Database): { db: ResultDb; calls: AllCall[] } {
  const calls: AllCall[] = [];
  const db = {
    prepare(sql: string) {
      const statement = real.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            [REAL]: bound,
            async all<T>() {
              const result = await bound.all<T>();
              calls.push({ sql, rowsRead: result.meta.rows_read ?? 0 });
              return result;
            },
            first: (...args: unknown[]) => (bound.first as (...a: unknown[]) => Promise<unknown>)(...args),
            run: () => bound.run(),
          };
        },
      };
    },
    batch(statements: Array<{ [REAL]?: D1PreparedStatement }>) {
      return real.batch(statements.map((s) => s[REAL] ?? (s as unknown as D1PreparedStatement)));
    },
  } as unknown as ResultDb;
  return { db, calls };
}

/** 補完の列挙の SQL か(旧版の `LIST_*_BACKFILL_SQL` も、新版の待ち行列用の SQL も当たる。件数の SQL・他の SQL は当たらない)。 */
export function isBackfillListSql(sql: string): boolean {
  return sql.includes("FROM analyses a") && sql.includes("SELECT raceId, firstDate FROM u");
}
