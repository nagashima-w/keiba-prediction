import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { pathFromMeta } from "./meta-path";

/**
 * Issue #729(段階 A)の突き合わせの道具 `scripts/person-year-compare-729/compare.sql`。本番の jockey_results・trainer_results(netkeiba から取った年度別成績)と person_year(自前の集計)を比べる SELECT が、
 * 一致・差・自前に無い行を正しく分けること、中央だけ・確定年(2021〜2025)だけを比べること、読むだけ(SELECT だけ)であることを、小さな表で固定する。実行は本番を読むメイン(このテストは本番に触れない)。
 */

const SQL = readFileSync(pathFromMeta("../../scripts/person-year-compare-729/compare.sql", import.meta.url), "utf-8");
const [detailSql, summarySql] = SQL.split(/^-- ==== .*$/m).slice(1).map((x) => x.trim());

const dbs: DatabaseSync[] = [];
function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec("CREATE TABLE jockey_results (jockey_id TEXT NOT NULL, kind TEXT NOT NULL, years_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (jockey_id, kind))");
  db.exec("CREATE TABLE trainer_results (trainer_id TEXT NOT NULL, kind TEXT NOT NULL, years_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (trainer_id, kind))");
  db.exec("CREATE TABLE person_year (person_kind TEXT NOT NULL, person_id TEXT NOT NULL, year INTEGER NOT NULL, starts INTEGER NOT NULL, placed INTEGER NOT NULL, computed_on TEXT NOT NULL, PRIMARY KEY (person_kind, person_id, year)) WITHOUT ROWID");
  return db;
}
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function seed(db: DatabaseSync): void {
  const j = db.prepare("INSERT INTO jockey_results VALUES (?, ?, ?, 0)");
  j.run("J1", "central", JSON.stringify([[2026, 100, 30], [2025, 200, 60], [2024, 150, 40], [2020, 5, 1]])); // 2026(進行中)と 2020(範囲外)は比べない
  j.run("J2", "central", JSON.stringify([[2025, 50, 10]]));
  j.run("J3", "nar", JSON.stringify([[2025, 50, 10]])); // 地方は比べない
  const t = db.prepare("INSERT INTO trainer_results VALUES (?, ?, ?, 0)");
  t.run("T1", "central", JSON.stringify([[2025, 80, 20], [2024, 70, 10]]));
  const p = db.prepare("INSERT INTO person_year VALUES (?, ?, ?, ?, ?, '2026-11-20')");
  p.run("jockey", "J1", 2025, 200, 60); // 一致
  p.run("jockey", "J1", 2024, 148, 40); // starts が 2 少ない
  p.run("jockey", "J1", 2026, 1, 0); // 進行中の年は比べない
  // J2 の 2025 は自前に無い
  p.run("trainer", "T1", 2025, 80, 21); // placed が 1 多い
  p.run("trainer", "T1", 2024, 70, 10); // 一致
  p.run("jockey", "J9", 2025, 10, 1); // 基準(netkeiba 側)に無い人は出さない
}

describe("compare.sql", () => {
  it("2 つの文に分かれ、どちらも SELECT(WITH)だけ。書き込み・DDL を含まない", () => {
    expect(detailSql).toBeTruthy();
    expect(summarySql).toBeTruthy();
    for (const q of [detailSql!, summarySql!]) {
      expect(q).toMatch(/^WITH /);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA)\b/i);
      expect(q.trim().endsWith(";")).toBe(true);
    }
  });

  it("詳細: 一致しない行だけ、差の大きい順に出す。地方・範囲外の年・進行中の年・基準に無い人は出さない", () => {
    const db = open();
    seed(db);
    const rows = db.prepare(detailSql!).all() as Array<Record<string, string | number | null>>;
    expect(rows.map((r) => [r["person_kind"], r["person_id"], r["year"], r["status"], r["d_starts"], r["d_placed"]])).toEqual([
      ["jockey", "J2", 2025, "missing_own", -50, -10], // 自前に無い(starts の差は 0 − 50)。差の大きい順で先頭
      ["jockey", "J1", 2024, "diff", -2, 0],
      ["trainer", "T1", 2025, "diff", 0, 1],
    ]);
  });

  it("要約: 種別 × 状態の件数と差の合計。一致も数える", () => {
    const db = open();
    seed(db);
    const rows = db.prepare(summarySql!).all() as Array<Record<string, string | number>>;
    expect(rows.map((r) => [r["person_kind"], r["status"], r["n"], r["sum_d_starts"], r["sum_d_placed"]])).toEqual([
      ["jockey", "diff", 1, -2, 0],
      ["jockey", "match", 1, 0, 0],
      ["jockey", "missing_own", 1, -50, -10],
      ["trainer", "diff", 1, 0, 1],
      ["trainer", "match", 1, 0, 0],
    ]);
  });

  it("全部一致なら詳細は空", () => {
    const db = open();
    db.prepare("INSERT INTO jockey_results VALUES ('J1', 'central', ?, 0)").run(JSON.stringify([[2025, 10, 3]]));
    db.prepare("INSERT INTO person_year VALUES ('jockey', 'J1', 2025, 10, 3, '2026-11-20')").run();
    expect(db.prepare(detailSql!).all()).toEqual([]);
  });
});
