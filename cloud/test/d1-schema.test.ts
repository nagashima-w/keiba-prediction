import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { checkD1 } from "../src/d1-health";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Issue #171(#169-a)AC-a2・AC-a3: クラウド版の D1(ローカルの workerd 上の D1)で、migration を実際に適用したあとの表が
 * 外部キーを守り、索引を使うことの確認。
 *
 * 適用は、CI と同じ実コマンド(`wrangler d1 migrations apply DB --local`)で行い(migration のファイル名・順序・wrangler.toml の
 * binding も含めて通る)、そのデータベースを `getPlatformProxy` で開く。**本番の D1 には一切触れない**(`--local`。wrangler.toml に
 * `remote = true` が無いことは scripts/test/cloud-config-guard.test.ts が固定している)。
 *
 * 限界: ローカルの D1 は workerd 内蔵の SQLite で、本番の D1 と同じビルドとは限らない。外部キーと実行計画の挙動は、本番のデプロイ後に
 * `/api/health`(D1 の疎通)と、#172 の最初の実保存で確かめる。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(CLOUD, "node_modules", ".bin", "wrangler");

let stateDir: string;
let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "keiba-d1-schema-"));
  execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir], {
    cwd: CLOUD,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    stdio: "pipe",
    timeout: 120_000,
  });
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(CLOUD, "wrangler.toml"),
    persist: { path: path.join(stateDir, "v3") },
  });
  db = proxy.env.DB;
  dispose = () => proxy.dispose();
}, 180_000);

afterAll(async () => {
  await dispose?.();
  rmSync(stateDir, { recursive: true, force: true });
});

async function rows(sql: string, ...binds: unknown[]): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return result.results;
}

describe("migration の適用(ローカルの D1)", () => {
  it("前提: 8 表と r2_ops 表(#173)と detail_key 列と、索引3つが作られている(以降の検査が空振りでない)", async () => {
    const tables = (await rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name")).map((r) => r["name"]);
    expect(tables).toEqual([
      "analyses",
      "analysis_allocation_meta",
      "analysis_bets",
      "analysis_horses",
      "race_combo_payout_imports",
      "race_combo_payouts",
      "race_result_meta",
      "race_results",
      "r2_ops",
      "cloud_settings",
    ].sort());
    expect((await rows("PRAGMA table_info(analyses)")).map((r) => r["name"])).toContain("detail_key");
    expect((await rows("PRAGMA table_info(analyses)")).map((r) => r["name"])).toContain("llm_note"); // Issue #194(0005)
    // Issue #197(0006): 馬ごとの強調材料・懸念事項。exe の analysis_horses と同じ列(並びも reason の後ろ)。
    expect((await rows("PRAGMA table_info(analysis_horses)")).map((r) => r["name"]).slice(-3)).toEqual(["reason", "highlights_json", "concerns_json"]);
    const indexes = (await rows("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx\\_%' ESCAPE '\\' ORDER BY name")).map((r) => r["name"]);
    expect(indexes).toEqual(["idx_analyses_kaisai_date", "idx_analyses_prompt_version_race", "idx_analyses_race"]);
  });

  it("migration は6本とも適用済みとして記録されている(d1_migrations)", async () => {
    expect((await rows("SELECT name FROM d1_migrations ORDER BY id")).map((r) => r["name"])).toEqual(["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql", "0006_horse_items.sql"]);
  });
});

describe("AC-a2: 外部キーが効く(analyses を親とする3つの子の表)", () => {
  const insertAnalysis = "INSERT INTO analyses (race_id, analyzed_at) VALUES ('202603020211', '2026-10-06T09:00:00.000Z')";

  const children: ReadonlyArray<readonly [string, string, (id: number) => string]> = [
    ["analysis_horses", "馬", (id) => `INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive) VALUES (${id}, 1, 0.3, 0.3, 0)`],
    [
      "analysis_allocation_meta",
      "配分メタ",
      (id) =>
        `INSERT INTO analysis_allocation_meta (analysis_id, route, bankroll, per_race_cap, kelly_fraction, ev_threshold, include_combo_odds, include_wide, include_trio, odds_status) VALUES (${id}, 'mixed', 10000, 2000, 0.25, 1, 0, 0, 0, 'result')`,
    ],
    ["analysis_bets", "買い目", (id) => `INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake) VALUES (${id}, 'place', '01', 100)`],
  ];

  it.each(children)("%s(%s): 存在しない analysis_id の行は拒否される", async (table, _label, insert) => {
    await expect(db.prepare(insert(987654321)).run()).rejects.toThrow(/FOREIGN KEY/i);
    expect((await rows(`SELECT count(*) AS c FROM ${table}`))[0]!["c"]).toBe(0);
  });

  it.each(children)("対照: %s(%s)は、親の analyses 行があれば入る(拒否が外部キー以外の理由でないことの確認)", async (table, _label, insert) => {
    const inserted = await db.prepare(insertAnalysis).run();
    const id = inserted.meta.last_row_id;
    expect(id).toBeGreaterThan(0);
    await db.prepare(insert(id)).run();
    expect((await rows(`SELECT count(*) AS c FROM ${table} WHERE analysis_id = ?`, id))[0]!["c"]).toBe(1);
    // 後始末(次のテストが同じ表の行数 0 を前提にするため)
    await db.batch([
      db.prepare(`DELETE FROM ${table} WHERE analysis_id = ?`).bind(id),
      db.prepare("DELETE FROM analyses WHERE id = ?").bind(id),
    ]);
  });

  it("子の行を持つ親は消せない(NO ACTION)", async () => {
    const id = (await db.prepare(insertAnalysis).run()).meta.last_row_id;
    await db.prepare(children[0]![2](id)).run();
    await expect(db.prepare("DELETE FROM analyses WHERE id = ?").bind(id).run()).rejects.toThrow(/FOREIGN KEY/i);
    await db.batch([db.prepare("DELETE FROM analysis_horses WHERE analysis_id = ?").bind(id), db.prepare("DELETE FROM analyses WHERE id = ?").bind(id)]);
  });
});

/**
 * #172(ストア)が発行する想定の検索の文。race_id の絞り込みは exe の `listAnalyses` と同じ文(core の codec)。
 * 版別の列挙は exe の `listAnalyzedRaceIdsByPromptVersion` と同じ文(analysis-store.ts のインライン。codec に切り出されていないので写している)。
 */
const BY_RACE_SQL = "SELECT id FROM analyses WHERE race_id = ? ORDER BY id";
const BY_KAISAI_DATE_SQL = "SELECT id FROM analyses WHERE kaisai_date = ? ORDER BY id";
const RACE_IDS_BY_PROMPT_VERSION_SQL = "SELECT DISTINCT race_id AS raceId FROM analyses WHERE prompt_version = ? ORDER BY race_id";

/**
 * 実行計画の一覧。**文ごとに別の注釈を付けて、文の文字列を毎回変える**: 同じ文字列のままだと、索引を DROP した後も、
 * 古い実行計画(索引を使う計画)が返る(ローカルの D1 で実測。別の文字列にすると新しい計画が返る)。
 */
let planCounter = 0;
async function plan(sql: string): Promise<string[]> {
  planCounter += 1;
  return (await rows(`EXPLAIN QUERY PLAN ${sql} /* plan-${planCounter} */`, "x")).map((r) => String(r["detail"]));
}

describe("AC-a3: 検索が索引を使う(EXPLAIN QUERY PLAN が SEARCH。落とすと SCAN になる対照つき)", () => {
  it("race_id の絞り込みは idx_analyses_race を使う", async () => {
    const details = await plan(BY_RACE_SQL);
    expect(details.some((d) => /^SEARCH analyses USING (COVERING )?INDEX idx_analyses_race \(race_id=\?\)/.test(d))).toBe(true);
    expect(details.some((d) => d.startsWith("SCAN"))).toBe(false);
  });

  it("開催日の絞り込みは idx_analyses_kaisai_date を使う", async () => {
    const details = await plan(BY_KAISAI_DATE_SQL);
    expect(details.some((d) => /^SEARCH analyses USING (COVERING )?INDEX idx_analyses_kaisai_date \(kaisai_date=\?\)/.test(d))).toBe(true);
    expect(details.some((d) => d.startsWith("SCAN"))).toBe(false);
  });

  it("版別のレース列挙は idx_analyses_prompt_version_race(カバリング)を使い、ORDER BY のための一時ソートを要しない", async () => {
    const details = await plan(RACE_IDS_BY_PROMPT_VERSION_SQL);
    expect(details.some((d) => /^SEARCH analyses USING COVERING INDEX idx_analyses_prompt_version_race \(prompt_version=\?\)/.test(d))).toBe(true);
    expect(details.some((d) => d.startsWith("SCAN"))).toBe(false);
    expect(details.some((d) => /TEMP B-TREE FOR ORDER BY/.test(d))).toBe(false);
  });

  /**
   * 対照: 索引を落とした(使えない)状態では、同じ文が SCAN になる。上の SEARCH の検査が、索引が無くても通る検査ではないことを示す。
   * 索引の落としと作り直しは、同じ D1 の中で行い、必ず元に戻す。
   */
  const controls: ReadonlyArray<readonly [string, string, string, string]> = [
    ["idx_analyses_race", BY_RACE_SQL, "CREATE INDEX idx_analyses_race ON analyses (race_id)", "race_id の絞り込み"],
    ["idx_analyses_kaisai_date", BY_KAISAI_DATE_SQL, "CREATE INDEX idx_analyses_kaisai_date ON analyses (kaisai_date)", "開催日の絞り込み"],
    ["idx_analyses_prompt_version_race", RACE_IDS_BY_PROMPT_VERSION_SQL, "CREATE INDEX idx_analyses_prompt_version_race ON analyses (prompt_version, race_id)", "版別のレース列挙"],
  ];
  it.each(controls)("対照: %s を落とすと、%s は SCAN になる(元に戻す)", async (name, sql, recreate, _label) => {
    const before = await plan(sql);
    expect(before.some((d) => d.includes(name))).toBe(true);
    await db.prepare(`DROP INDEX ${name}`).run();
    try {
      const without = await plan(sql);
      expect(without.some((d) => d.startsWith("SCAN"))).toBe(true);
      expect(without.some((d) => d.includes(name))).toBe(false);
    } finally {
      await db.prepare(recreate).run();
    }
    expect((await plan(sql)).some((d) => d.includes(name))).toBe(true);
  });

  it("対照: 列の順を逆にした索引 (race_id, prompt_version) では、版別の列挙は prompt_version の等価検索に使えない", async () => {
    await db.prepare("DROP INDEX idx_analyses_prompt_version_race").run();
    await db.prepare("CREATE INDEX idx_reversed ON analyses (race_id, prompt_version)").run();
    try {
      const details = await plan(RACE_IDS_BY_PROMPT_VERSION_SQL);
      expect(details.some((d) => /SEARCH analyses USING (COVERING )?INDEX idx_reversed \(prompt_version=\?\)/.test(d))).toBe(false);
      expect(details.some((d) => d.startsWith("SCAN"))).toBe(true);
    } finally {
      await db.prepare("DROP INDEX idx_reversed").run();
      await db.prepare("CREATE INDEX idx_analyses_prompt_version_race ON analyses (prompt_version, race_id)").run();
    }
  });
});

describe("D1 の疎通確認(/api/health が使う checkD1)を、実エンジンの D1 で確かめる", () => {
  it("migration を適用した D1 では ok", async () => {
    expect(await checkD1(db)).toEqual({ ok: true });
  });

  it("対照: 0002 の detail_key 列が無い状態(migration の未適用相当)では ok:false になる(SELECT 1 では見逃す)", async () => {
    await db.prepare("ALTER TABLE analyses RENAME COLUMN detail_key TO detail_key_renamed").run();
    try {
      expect(await checkD1(db)).toEqual({ ok: false });
      // SELECT 1 なら通ってしまう(疎通確認に migration の適用確認を含めた理由)
      await expect(db.prepare("SELECT 1").first()).resolves.not.toBeNull();
    } finally {
      await db.prepare("ALTER TABLE analyses RENAME COLUMN detail_key_renamed TO detail_key").run();
    }
    expect(await checkD1(db)).toEqual({ ok: true });
  });

  it("対照: analyses 表が無い状態でも例外を投げず ok:false(表の名前を変えて戻す)", async () => {
    await db.prepare("ALTER TABLE analyses RENAME TO analyses_renamed").run();
    try {
      expect(await checkD1(db)).toEqual({ ok: false });
    } finally {
      await db.prepare("ALTER TABLE analyses_renamed RENAME TO analyses").run();
    }
  });
});
