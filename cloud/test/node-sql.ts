/**
 * テスト用: Node 組込みの `node:sqlite`(本物の SQLite エンジン)を、Durable Object の `ctx.storage.sql` と同じ形(`SqlLike`)で包む。
 * DO の SQLite ストレージを、Node の vitest で(偽の SQL ではなく本物の SQL の意味論で)テストするためのもの。
 * 違い: DO の SQLite は一部の機能(PRAGMA・トランザクション文など)を禁じるが、このコードベースが使う文はそれらを使わない。
 */
import { DatabaseSync } from "node:sqlite";
import type { SqlLike } from "../src/sql-like";

export interface NodeSql extends SqlLike {
  /** 実行した文の数(キャッシュの読み書きの回数を数えるテストに使う)。 */
  readonly statements: string[];
  close(): void;
}

export function openNodeSql(): NodeSql {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  return {
    statements,
    exec(query: string, ...bindings: unknown[]) {
      statements.push(query);
      const stmt = db.prepare(query);
      // SELECT 系(列を返す文)は all()、それ以外は run()
      if (/^\s*(SELECT|WITH)\b/i.test(query)) {
        const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows.map((r) => ({ ...r })) };
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
    close() {
      db.close();
    },
  };
}
