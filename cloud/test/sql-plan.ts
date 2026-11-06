/**
 * Issue #632: D1 の SQL の実行計画を、ユニットの層(workerd を開かない)で調べる補助。
 * `node:sqlite` に `cloud/migrations` を順に当てた DB で `EXPLAIN QUERY PLAN` を見る。
 * ★限界: Node 組込みの SQLite は本番の D1 と同じビルドとは限らない。計画の細部は本番とずれうる(索引を使うか全走査かの大筋は同じ)。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_DIR = path.join(CLOUD, "src");

/** `cloud/migrations/*.sql` を名前の順に全部当てた、メモリ上の DB。 */
export function openMigratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(CLOUD, "migrations");
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(path.join(dir, name), "utf8"));
  return db;
}

/** 束縛する値の数: 無名の `?` の数と、`?N` の最大の N の大きいほう(計画は値に依らない)。 */
export function placeholderCount(sql: string): number {
  const bare = (sql.match(/\?(?!\d)/g) ?? []).length;
  const numbered = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return Math.max(bare, numbered);
}

export function planDetails(db: DatabaseSync, sql: string): string[] {
  const binds = Array.from({ length: placeholderCount(sql) }, () => "x");
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[]).map((r) => r.detail);
}

export interface PlanKinds {
  /** 表(別名を含む)の全走査 `SCAN <表>`。`SCAN json_each`・`SCAN CONSTANT ROW`・`SCAN n-ROW VALUES CLAUSE`・副問い合わせ・CTE の読み出しは含めない。索引を使った全走査(`SCAN t USING INDEX …`)は含める。 */
  readonly scans: string[];
  /** `USE TEMP B-TREE …`(並べ替え・グループ化・DISTINCT の一時の構造)。 */
  readonly tempBtrees: string[];
}

export function classifyPlan(details: readonly string[]): PlanKinds {
  // CO-ROUTINE・MATERIALIZE で名前が付く副問い合わせ(CTE・派生表)は、その読み出しの `SCAN <名前>` を表の走査とみなさない。
  const derived = new Set<string>();
  for (const d of details) {
    const m = /^(?:CO-ROUTINE|MATERIALIZE) (\S+)/.exec(d);
    if (m) derived.add(m[1]!);
  }
  const scans: string[] = [];
  for (const d of details) {
    const m = /^SCAN (\S+)/.exec(d);
    if (!m) continue;
    const name = m[1]!;
    if (name === "json_each" || name === "CONSTANT" || /^\d+-ROW$/.test(name) || name.startsWith("(subquery") || derived.has(name)) continue;
    scans.push(d);
  }
  return { scans, tempBtrees: details.filter((d) => d.startsWith("USE TEMP B-TREE")) };
}

/** SQL かどうか(export された文字列定数から SQL を拾うための判定)。 */
export const SQL_HEAD = /^\s*(SELECT|WITH|UPDATE|INSERT|DELETE)\b/i;

/** 取り込めない入口(Workers ランタイムの `cloudflare:workers` に依存する DO・worker)。SQL の定数は持たない。 */
export const NOT_IMPORTABLE = /(?:-do|^worker)\.ts$/;

/**
 * `cloud/src` の各モジュールが export する文字列定数のうち SQL のもの(オブジェクトの値の中も含む)を、`<ファイル>::<名前>` を鍵に集める。
 * 取り込めないモジュールは `NOT_IMPORTABLE` の入口だけに限り、ほかが取り込めなければ投げる(黙って飛ばすと、新しい SQL を見落とす)。
 */
export async function collectExportedSql(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SRC_DIR).filter((n) => n.endsWith(".ts") && !n.endsWith(".generated.ts")).sort()) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(path.join(SRC_DIR, f))) as Record<string, unknown>;
    } catch (error) {
      if (NOT_IMPORTABLE.test(f)) continue;
      throw new Error(`${f} を取り込めません: ${String(error)}`);
    }
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === "string") {
        if (SQL_HEAD.test(v)) out.set(`${f}::${k}`, v);
      } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) if (typeof v2 === "string" && SQL_HEAD.test(v2)) out.set(`${f}::${k}.${k2}`, v2);
      }
    }
  }
  return out;
}

export interface DoPlanException {
  /** 文(空白を詰めたもの)に当てはまる正規表現。 */
  readonly match: RegExp;
  /** 全走査・一時の並べ替えを許す理由(起床の経路か status だけの経路か、表の大きさの上限)。 */
  readonly reason: string;
}

/**
 * Durable Object の SQLite の文の実行計画を、記録した文の全部について調べる(Issue #632)。
 * 全走査(実在の表の SCAN)か一時の並べ替え(USE TEMP B-TREE)がある文は、`exceptions` のどれかに当てはまらなければ `unexpected`。
 * `exceptions` のうち、記録した文に当てはまらない、または当てはまる文がもう全走査も一時の並べ替えも持たないものは `stale`。
 */
export function checkDoStatements(
  statements: readonly string[],
  plan: (query: string) => string[],
  exceptions: readonly DoPlanException[],
): { readonly checked: number; readonly flagged: number; readonly unexpected: string[]; readonly stale: string[] } {
  const distinct = [...new Set(statements.map((q) => q.replace(/\s+/g, " ").trim()))].filter((q) => /^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(q));
  const flaggedSql = new Set<string>();
  const unexpected: string[] = [];
  const used = new Set<DoPlanException>();
  for (const q of distinct) {
    const kinds = classifyPlan(plan(q));
    if (kinds.scans.length === 0 && kinds.tempBtrees.length === 0) continue;
    flaggedSql.add(q);
    const hit = exceptions.find((e) => e.match.test(q));
    if (hit === undefined) unexpected.push(`${q} => ${[...kinds.scans, ...kinds.tempBtrees].join(" / ")}`);
    else used.add(hit);
  }
  const stale = exceptions.filter((e) => !used.has(e)).map((e) => String(e.match));
  return { checked: distinct.length, flagged: flaggedSql.size, unexpected, stale };
}
