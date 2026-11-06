import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { targetsCloseSql, targetsSql } from "../src/targets-repository";
import { verifyDayCloseSql } from "../src/verify-close";
import { verifyDayAllocationSql, verifyDayHorsesSql, verifyDayResultSql } from "../src/verify-read";
import { settleRaceBackfillSql } from "../src/race-backfill-state";
import { recordSql as jockeyRecordSql } from "../src/jockey-names-repository";
import { recordSql as trainerRecordSql } from "../src/trainer-names-repository";
import { classifyPlan, collectExportedSql, openMigratedDb, planDetails, SRC_DIR, type PlanKinds } from "./sql-plan";
import { CHECK_HERE_TEMP_BTREE, EXCEPTIONS, EXCLUDED, EXISTING, HERE, type PlanEntry } from "./sql-plan-registry";

/**
 * Issue #632(#594-5): D1 の SQL の実行計画(`EXPLAIN QUERY PLAN`)の検査の一覧と、その漏れ止め。
 *
 * 1. `cloud/src` が export する SQL(文字列定数。オブジェクトの値の中も含む)を自動で集め、どれも一覧(sql-plan-registry.ts)に載っていることを確かめる。
 *    載っていない SQL があれば赤(新しい SQL を足したのに検査を忘れた、を捕まえる)。一覧にあって実在しない名前も赤。
 * 2. 「ここで検査する」SQL は、`node:sqlite` に migration を当てた DB で計画を見る。実在の表の全走査(SCAN)が無いこと。
 *    一時の並べ替え(USE TEMP B-TREE)は、範囲が絞られている理由つきで一覧に載せたものだけ許す。
 * 3. 「既知の例外」は、全走査を理由と Issue つきで載せる。新しい全走査は赤。例外の SQL が直って全走査でなくなったときも赤(一覧から外す合図)。
 * 4. 「既存の検査」は、workerd を開く integration テストが計画を見ているもの。ここでは複製せず、そのファイルが実在して SQL の名前と EXPLAIN QUERY PLAN を含むことだけ確かめる。
 *
 * ★限界: Node 組込みの SQLite は本番の D1 と同じビルドとは限らない。動的に組む SQL のうち export されていないもの(horse_runs の status など)は、ここに載らない(docs/db-sql-rules.md の一覧に「未検査」と書く)。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(CLOUD, "test");

/** export された組み立て関数(サンプルの引数で SQL にする)。鍵は `<ファイル>::<関数>(.<キー>)`。 */
function builtSql(): Map<string, string> {
  const out = new Map<string, string>();
  const ids = "1,2";
  for (const [k, v] of Object.entries(targetsSql(ids))) out.set(`targets-repository.ts::targetsSql.${k}`, v);
  for (const [k, v] of Object.entries(targetsCloseSql(ids))) out.set(`targets-repository.ts::targetsCloseSql.${k}`, v);
  out.set("verify-read.ts::verifyDayHorsesSql", verifyDayHorsesSql([1, 2]));
  for (const [k, v] of Object.entries(verifyDayAllocationSql([1, 2]))) out.set(`verify-read.ts::verifyDayAllocationSql.${k}`, v);
  for (const [k, v] of Object.entries(verifyDayResultSql(["202601010101"]))) out.set(`verify-read.ts::verifyDayResultSql.${k}`, v);
  for (const [k, v] of Object.entries(verifyDayCloseSql([1, 2]))) out.set(`verify-close.ts::verifyDayCloseSql.${k}`, v);
  out.set("race-backfill-state.ts::settleRaceBackfillSql", settleRaceBackfillSql(1));
  out.set("jockey-names-repository.ts::recordSql", jockeyRecordSql(2));
  out.set("trainer-names-repository.ts::recordSql", trainerRecordSql(2));
  return out;
}

/** 組み立て関数のうち、サンプルで SQL にせず対象外にするもの(別の定数を包むだけで、包まれた定数が一覧に載っている)。 */
const WRAPPER_FUNCTIONS = ["analysis-repository.ts::jsonEachInsertSql", "analysis-repository.ts::withNewIdSql", "result-repository.ts::jsonEachInsertSelectSql", "result-repository.ts::jsonEachDeleteSql"];

let sqlByKey: Map<string, string>;
let allKeys: Map<string, string>;
const db = openMigratedDb();
beforeAll(async () => {
  sqlByKey = await collectExportedSql();
  allKeys = new Map([...sqlByKey, ...builtSql()]);
}, 60_000);

function registered(): Map<string, PlanEntry> {
  const out = new Map<string, PlanEntry>();
  for (const group of [HERE, EXISTING, EXCEPTIONS, EXCLUDED]) {
    for (const [k, e] of Object.entries(group)) {
      expect(out.has(k), `一覧に二重に載っています: ${k}`).toBe(false);
      out.set(k, e);
    }
  }
  return out;
}

describe("一覧の漏れ止め(export された SQL は、どれかの区分に載っている)", () => {
  it("前提: 自動で集めた SQL が空でない(空だと下の検査が空振りする)", () => {
    expect(sqlByKey.size).toBeGreaterThanOrEqual(60);
    expect(allKeys.size).toBeGreaterThan(sqlByKey.size);
  });

  it("export された SQL と組み立て関数の SQL は、全部が一覧に載っている", () => {
    const reg = registered();
    const missing = [...allKeys.keys()].filter((k) => !reg.has(k));
    expect(missing, `一覧に載っていない SQL(検査を足すか、既知の例外・対象外に理由つきで載せる): ${missing.join(", ")}`).toEqual([]);
  });

  it("一覧にある名前は、実在する SQL(消えた・改名した SQL が残っていない)", () => {
    const reg = registered();
    const stale = [...reg.keys()].filter((k) => !allKeys.has(k));
    expect(stale, `一覧にあるが実在しない: ${stale.join(", ")}`).toEqual([]);
  });

  it("export された `…Sql` 関数は、サンプルで SQL にしたもの(builtSql)か対象外の包みのどちらか", async () => {
    const known = new Set([...builtSql().keys()].map((k) => k.replace(/\.[^.:]+$/, "")).map((k) => k));
    const found: string[] = [];
    for (const f of readdirSync(SRC_DIR).filter((n) => n.endsWith(".ts") && !n.endsWith(".generated.ts"))) {
      if (/(?:-do|^worker)\.ts$/.test(f)) continue;
      const src = readFileSync(path.join(SRC_DIR, f), "utf8");
      for (const m of src.matchAll(/^export function (\w*(?:Sql|SQL)\w*)\s*\(/gm)) found.push(`${f}::${m[1]}`);
    }
    expect(found.length).toBeGreaterThanOrEqual(10); // 前提: 関数を拾えている
    const unknown = found.filter((k) => !known.has(k) && !WRAPPER_FUNCTIONS.includes(k));
    expect(unknown, `サンプルの引数で検査に入れていない組み立て関数: ${unknown.join(", ")}`).toEqual([]);
  });

  it("対象外には理由がある", () => {
    for (const [k, e] of Object.entries(EXCLUDED)) expect(e.kind === "excluded" && e.reason.length > 0, k).toBe(true);
  });
});

function plan(key: string): PlanKinds & { details: string[] } {
  const sql = allKeys.get(key);
  if (sql === undefined) throw new Error(`SQL が無い: ${key}`);
  const details = planDetails(db, sql);
  return { ...classifyPlan(details), details };
}

describe("ここで検査する SQL: 実在の表の全走査が無く、一時の並べ替えは理由つきで許したものだけ", () => {
  it("前提: 検査する SQL が実際にある", () => {
    expect(Object.keys(HERE).length).toBeGreaterThanOrEqual(20);
  });

  it.each(Object.entries(HERE))("%s", (key, entry) => {
    const p = plan(key);
    expect(p.scans, `全走査が出た(索引か絞り込みを足す、または理由と Issue つきで既知の例外にする): ${p.details.join(" / ")}`).toEqual([]);
    if (entry.kind !== "here") throw new Error("区分の取り違え");
    if (p.tempBtrees.length > 0) expect(entry.tempBtree, `許していない一時の並べ替え: ${p.details.join(" / ")}`).toBeTruthy();
    else expect(entry.tempBtree, `一時の並べ替えが無くなった。tempBtree の理由を外す`).toBeUndefined();
  });

  it("対照: 一覧の許す一時の並べ替えを持つ SQL が実在する(判定が空振りでない)", () => {
    expect(Object.values(HERE).filter((e) => e.kind === "here" && e.tempBtree !== undefined).length).toBeGreaterThanOrEqual(CHECK_HERE_TEMP_BTREE);
  });
});

describe("既知の例外: 全走査を理由と Issue つきで載せる(新しい全走査は赤、直ったら外す)", () => {
  it.each(Object.entries(EXCEPTIONS))("%s", (key, entry) => {
    if (entry.kind !== "exception") throw new Error("区分の取り違え");
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.issue).toMatch(/^#\d+/);
    const p = plan(key);
    expect(p.scans.length, `全走査が無くなった。一覧(EXCEPTIONS)から外す: ${p.details.join(" / ")}`).toBeGreaterThan(0);
    if (p.tempBtrees.length > 0) expect(entry.tempBtree, `許していない一時の並べ替え`).toBeTruthy();
  });
});

describe("既存の検査(workerd を開く integration テスト)は、実在して SQL の名前と EXPLAIN QUERY PLAN を含む", () => {
  it.each(Object.entries(EXISTING))("%s", (key, entry) => {
    if (entry.kind !== "existing") throw new Error("区分の取り違え");
    const file = path.join(TEST_DIR, entry.file);
    expect(existsSync(file), entry.file).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toContain("EXPLAIN QUERY PLAN");
    expect(src).toContain(key.split("::")[1]!.split(".")[0]!);
    expect(entry.file.endsWith(".integration.test.ts")).toBe(true);
  });
});

describe("判定の自己検査(計画の読み取りが全走査を見逃さない)", () => {
  it("索引の無い列で引く文は全走査、索引のある列で引く文は全走査でない", () => {
    const d = openMigratedDb();
    expect(classifyPlan(planDetails(d, "SELECT id FROM analyses WHERE model = ?")).scans.length).toBeGreaterThan(0);
    expect(classifyPlan(planDetails(d, "SELECT id FROM analyses WHERE race_id = ?")).scans).toEqual([]);
    expect(classifyPlan(planDetails(d, "SELECT id FROM analyses WHERE kaisai_date = ? ORDER BY race_id")).tempBtrees.length).toBeGreaterThan(0);
  });

  it("json_each の走査・副問い合わせ(CTE)の読み出しは、表の全走査に数えない", () => {
    const d = openMigratedDb();
    const p = classifyPlan(planDetails(d, "SELECT race_id FROM analyses WHERE race_id IN (SELECT value FROM json_each(?))"));
    expect(p.scans).toEqual([]);
    const q = classifyPlan(planDetails(d, "WITH l AS (SELECT race_id FROM analyses WHERE kaisai_date = ?) SELECT * FROM l"));
    expect(q.scans).toEqual([]);
  });
});
