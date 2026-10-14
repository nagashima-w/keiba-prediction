/**
 * Durable Object の SQLite ストレージ(`ctx.storage.sql`)のうち、ここで使う部分(Issue #177)。
 * 本物の `SqlStorage` もこの形を満たし、テストでは Node 組込みの `node:sqlite` を同じ形に包んだもの(`test/node-sql.ts`)を差し込む。
 * `exec` は同期。SELECT の結果は `toArray()` で取り出す。
 */
export interface SqlLike {
  exec(query: string, ...bindings: any[]): { toArray(): any[] };
}
