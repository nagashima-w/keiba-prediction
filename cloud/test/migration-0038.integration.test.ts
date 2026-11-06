import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RECOMPUTE_RACES_SQL } from "../src/race-backfill-state";
import { MARK_VERIFY_BY_ANALYSIS_IDS_SQL } from "../src/verify-race-mark";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #630: migration 0038(開催日が NULL の分析 11 件への開催日の補完と、7 レースの補完の状態・検証の印の作り直し)。
 * ローカル(workerd)の本物の D1 に、migration の文を流して確かめる(本番の D1 には触れない)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SQL = readFileSync(path.join(ROOT, "migrations", "0038_fill_kaisai_date.sql"), "utf-8");
const statements = SQL.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter((s) => s !== "");
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

const NAR = ["202630071511", "202642071511", "202648071511", "202650071511"] as const;
const CENTRAL = ["202605020411", "202608030411", "202604010211"] as const;
const RACES = [...NAR, ...CENTRAL];
const RACES_JSON = JSON.stringify(RACES);

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

async function runMigration(): Promise<void> {
  for (const st of statements) {
    await local.db.prepare(st).run();
  }
}
async function insertAnalysis(id: number, raceId: string, kaisai: string | null): Promise<void> {
  await local.db
    .prepare("INSERT INTO analyses (id, race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, '2026-07-14T00:00:00.000Z', 0, ?)")
    .bind(id, raceId, kaisai)
    .run();
}
const dates = async (): Promise<Array<{ id: number; kaisai_date: string | null }>> =>
  (await local.db.prepare("SELECT id, kaisai_date FROM analyses ORDER BY id").all<{ id: number; kaisai_date: string | null }>()).results;

/** 本番の 11 件の写し: 地方 4 レース × 2 分析 = id 5〜12、中央 3 レース × 1 分析 = id 13〜15。 */
async function seedTarget(): Promise<void> {
  for (let i = 0; i < 8; i++) await insertAnalysis(5 + i, NAR[Math.floor(i / 2)]!, null);
  for (let i = 0; i < 3; i++) await insertAnalysis(13 + i, CENTRAL[i]!, null);
}

describe("migration 0038: 開催日が NULL の分析 11 件への補完", () => {
  it("空の D1(行が 1 つも無い。手元・CI)でも失敗せず、何も作らない", async () => {
    await runMigration();
    expect(await dates()).toEqual([]);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM race_backfill").first<{ n: number }>())!.n).toBe(0);
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM verify_race_mark").first<{ n: number }>())!.n).toBe(0);
  });

  it("対象の 11 件だけが書き換わる: 地方 8 件は 20260715、中央 3 件は 20260503。ほかの行(別の id・別のレース・開催日が既にある行・id が範囲外)は変わらない", async () => {
    await seedTarget();
    // 変わってはいけない行。
    await insertAnalysis(1, "202605020411", null); // 同じレース ID だが id が対象外
    await insertAnalysis(16, "202630071511", null); // 同じレース ID だが id が対象外
    await insertAnalysis(2, "OTHERRACE0001", null); // 別のレースの NULL
    await insertAnalysis(3, "202630071511", "20260101"); // 開催日が既にある(id も範囲外)
    await local.db.prepare("UPDATE analyses SET kaisai_date = '20260101' WHERE id = 6").run(); // 対象の id・レース ID でも、開催日が既にあれば触らない
    const before = await dates();
    expect(before.filter((r) => r.kaisai_date === null).map((r) => r.id)).toEqual([1, 2, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]); // 前提(NULL の 13 行のうち書き換わるのは 10 行)

    await runMigration();

    const after = await dates();
    const expected = before.map((r) => {
      if (r.id >= 5 && r.id <= 12 && r.kaisai_date === null) return { id: r.id, kaisai_date: "20260715" };
      if (r.id >= 13 && r.id <= 15) return { id: r.id, kaisai_date: "20260503" };
      return r;
    });
    expect(after).toEqual(expected);
    expect(after.filter((r, i) => r.kaisai_date !== before[i]!.kaisai_date).map((r) => r.id)).toEqual([5, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("11 件すべてが NULL の本番の形では、ちょうど 11 行が書き換わり、NULL が 0 になる", async () => {
    await seedTarget();
    await runMigration();
    const after = await dates();
    expect(after).toHaveLength(11);
    expect(after.filter((r) => r.kaisai_date === null)).toEqual([]);
    expect(after.filter((r) => r.kaisai_date === "20260715")).toHaveLength(8);
    expect(after.filter((r) => r.kaisai_date === "20260503")).toHaveLength(3);
  });

  it("別のレース ID の分析が id 5〜15 にあっても書き換えない(id とレース ID の両方で絞る)", async () => {
    await insertAnalysis(5, "OTHERRACE0001", null);
    await insertAnalysis(13, "OTHERRACE0002", null);
    await runMigration();
    expect(await dates()).toEqual([{ id: 5, kaisai_date: null }, { id: 13, kaisai_date: null }]);
  });

  it("7 レースの補完の状態と検証の印が作り直される。古い状態(開催日 NULL・seq 古い)は更新され、7 レース以外の行は変わらない", async () => {
    await seedTarget();
    await insertAnalysis(20, "OTHERRACE0001", "20260601");
    // 古い状態: 開催日が NULL のまま入っている(0035 の初期投入の結果の形)。
    for (const r of RACES) {
      await local.db.prepare("INSERT INTO race_backfill (race_id, kaisai_date, sm, st1, st2, st3, st4) VALUES (?, NULL, 0, 1, 0, 0, 0)").bind(r).run();
      await local.db.prepare("INSERT INTO verify_race_mark (race_id, kaisai_date, seq) VALUES (?, NULL, 1)").bind(r).run();
    }
    await local.db.prepare("INSERT INTO race_backfill (race_id, kaisai_date, sm, st1, st2, st3, st4) VALUES ('OTHERRACE0001', '20260601', 0, 1, 0, 0, 0)").run();
    await local.db.prepare("INSERT INTO verify_race_mark (race_id, kaisai_date, seq) VALUES ('OTHERRACE0001', '20260601', 7)").run();

    await runMigration();

    const bf = (await local.db.prepare("SELECT race_id, kaisai_date FROM race_backfill ORDER BY race_id").all<{ race_id: string; kaisai_date: string | null }>()).results;
    expect(bf.map((r) => [r.race_id, r.kaisai_date])).toEqual([
      ["202604010211", "20260503"],
      ["202605020411", "20260503"],
      ["202608030411", "20260503"],
      ["202630071511", "20260715"],
      ["202642071511", "20260715"],
      ["202648071511", "20260715"],
      ["202650071511", "20260715"],
      ["OTHERRACE0001", "20260601"],
    ]);
    const marks = (await local.db.prepare("SELECT race_id, kaisai_date, seq FROM verify_race_mark ORDER BY race_id").all<{ race_id: string; kaisai_date: string | null; seq: number }>()).results;
    expect(marks.find((m) => m.race_id === "OTHERRACE0001")).toEqual({ race_id: "OTHERRACE0001", kaisai_date: "20260601", seq: 7 }); // 対象外は変わらない
    const mine = marks.filter((m) => m.race_id !== "OTHERRACE0001");
    expect(mine).toHaveLength(7);
    for (const m of mine) {
      expect(m.kaisai_date, m.race_id).toBe((NAR as readonly string[]).includes(m.race_id) ? "20260715" : "20260503");
      expect(m.seq, m.race_id).toBeGreaterThan(7); // 表の最大値(7)より新しい
    }
    expect(new Set(mine.map((m) => m.seq)).size).toBe(7); // レースごとに別の seq
  });

  it("状態・印の文は、cloud/src の式と(空白を除いて)同じ文字列で、?1 だけが JSON 配列の文字列(状態は 7 レース ID、印は分析 ID 5〜15)に替わっている", () => {
    const literal = `'${RACES_JSON}'`;
    const norm = normalize(statements.join(" ; "));
    expect(norm).toContain(normalize(RECOMPUTE_RACES_SQL.replaceAll("?1", literal)));
    expect(norm).toContain(normalize(MARK_VERIFY_BY_ANALYSIS_IDS_SQL.replaceAll("?1", `'[5,6,7,8,9,10,11,12,13,14,15]'`))); // 印は分析 ID から引く(分析の行が無い D1 では何も作らない)
  });

  it("migration は UPDATE と、状態・印の upsert だけ(表・列を変えない)。UPDATE は kaisai_date IS NULL を必ず条件に持つ", () => {
    for (const st of statements) {
      expect(st, st.slice(0, 60)).toMatch(/^(UPDATE analyses SET kaisai_date|INSERT INTO race_backfill|INSERT INTO verify_race_mark)/);
      if (st.startsWith("UPDATE")) expect(st).toMatch(/kaisai_date IS NULL/);
    }
    expect(statements.filter((s) => s.startsWith("UPDATE"))).toHaveLength(2);
  });
});
