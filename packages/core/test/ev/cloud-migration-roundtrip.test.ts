import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../../src/ev/analysis-store.js";
import {
  MIGRATION_TABLES,
  MIGRATION_TABLE_NAMES,
  MigrationTally,
  parseMigrationLine,
  type MigrationLine,
  type MigrationRow,
  type MigrationTableName,
} from "../../src/ev/cloud-migration-format.js";
import { generateMigrationLines } from "../../src/ev/cloud-migration-lines.js";
import { createCloudMigrationSource } from "../../src/ev/cloud-migration-reader.js";
import {
  FIXTURE_ANALYSIS_COUNT,
  FIXTURE_RESULT_RACE_IDS,
  TRICKY_RAW_RESPONSE,
  populateMigrationFixture,
} from "./cloud-migration-fixture.js";

/**
 * Issue #215(#167-A)AC2: 往復の一致。
 * 既存のストアで保存した DB(LLM なし・配分なし・NULL を含む列・日本語・改行を含む)を、実際の書き出しの経路
 * (生成器 → 改行で連結 → gzip)で書き、展開 → 1 行ずつ読む → 各表の行を復元すると、各表の SELECT * と一致する。
 */

function exportGz(store: AnalysisStore): Buffer {
  const gen = generateMigrationLines(createCloudMigrationSource(store.rawDatabase), {
    exportedAt: "2026-10-09T00:00:00.000Z",
    appVersion: "1.27.0",
    analysisPageSize: 2,
    resultPageSize: 2,
  });
  const lines: string[] = [];
  for (const l of gen) lines.push(l);
  return gzipSync(`${lines.join("\n")}\n`);
}

/** 展開した NDJSON を 1 行ずつ読んで検証し(タリーも通す)、各表の行を復元する。 */
function readBack(gz: Buffer): { lines: MigrationLine[]; tables: Record<MigrationTableName, MigrationRow[]>; tally: MigrationTally } {
  const text = gunzipSync(gz).toString("utf-8");
  expect(text.endsWith("\n")).toBe(true);
  const raw = text.slice(0, -1).split("\n");
  const tally = new MigrationTally();
  const lines = raw.map((l) => parseMigrationLine(l));
  for (const l of lines) tally.accept(l);
  const tables = Object.fromEntries(MIGRATION_TABLE_NAMES.map((t) => [t, [] as MigrationRow[]])) as Record<MigrationTableName, MigrationRow[]>;
  for (const l of lines) {
    if (l.type === "analysis") {
      tables.analyses.push(l.analysis);
      tables.analysis_horses.push(...l.horses);
      tables.analysis_bets.push(...l.bets);
      if (l.allocationMeta !== null) tables.analysis_allocation_meta.push(l.allocationMeta);
    } else if (l.type === "result") {
      tables.race_results.push(...l.results);
      if (l.meta !== null) tables.race_result_meta.push(l.meta);
      tables.race_combo_payouts.push(...l.comboPayouts);
      tables.race_combo_payout_imports.push(...l.comboPayoutImports);
    }
  }
  return { lines, tables, tally };
}

describe("往復の一致(AC2)", () => {
  const store = new AnalysisStore();
  populateMigrationFixture(store);
  const gz = exportGz(store);
  const { lines, tables, tally } = readBack(gz);
  const db = store.rawDatabase;

  it("前提: 8 表すべてに行がある・NULL と非 NULL の両方がある(退化した入力でない)", () => {
    for (const t of MIGRATION_TABLE_NAMES) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(n, t).toBeGreaterThan(0);
    }
    expect(tables.analyses.some((a) => a["model"] === null)).toBe(true);
    expect(tables.analyses.some((a) => typeof a["model"] === "string")).toBe(true);
    expect(tables.analysis_allocation_meta.some((m) => m["include_quinella"] === null)).toBe(true);
    expect(tables.analysis_allocation_meta.some((m) => m["include_quinella"] === 1)).toBe(true);
  });

  it("行数: ヘッダ 1 + 分析 5 + 結果 5 + フッタ 1", () => {
    expect(lines).toHaveLength(1 + FIXTURE_ANALYSIS_COUNT + FIXTURE_RESULT_RACE_IDS.length + 1);
    expect(lines.map((l) => l.type)).toEqual(["header", "analysis", "analysis", "analysis", "analysis", "analysis", "result", "result", "result", "result", "result", "footer"]);
  });

  it.each(MIGRATION_TABLE_NAMES.map((t) => [t] as const))("%s: 復元した行が SELECT * と一致する", (table) => {
    const order = MIGRATION_TABLES[table].keyColumns.join(", ");
    const expected = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    expect(tables[table]).toEqual(expected);
  });

  it("フッタの件数は、書いた行数と一致し、静止した DB では各表の COUNT(*) とも一致する", () => {
    const footer = lines[lines.length - 1]!;
    expect(footer.type).toBe("footer");
    if (footer.type !== "footer") return;
    for (const t of MIGRATION_TABLE_NAMES) {
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(footer.counts[t], t).toBe(count);
      expect(tables[t].length, t).toBe(count);
    }
    expect(footer.analysisLines).toBe(FIXTURE_ANALYSIS_COUNT);
    expect(footer.resultLines).toBe(FIXTURE_RESULT_RACE_IDS.length);
    expect(() => tally.assertComplete()).not.toThrow();
  });

  it("値はそのまま載る(NULL は null、文字列の JSON 列は文字列のまま、改行・日本語・絵文字は崩れない)", () => {
    const a2 = tables.analyses.find((a) => a["id"] === 2)!;
    expect(a2["raw_response"]).toBe(TRICKY_RAW_RESPONSE);
    expect(typeof a2["race_snapshot_json"]).toBe("string");
    expect(JSON.parse(a2["race_snapshot_json"] as string)).toMatchObject({ raceName: "福島民報杯" });
    const h = tables.analysis_horses.find((x) => x["analysis_id"] === 2 && x["umaban"] === 1)!;
    expect(typeof h["contributions_json"]).toBe("string");
    expect(h["reason"]).toBe("内枠で先行できる\n二行目");
    expect(tables.analyses.find((a) => a["id"] === 1)!["race_snapshot_json"]).toBeNull();
    // exe の分析 id が載っている(取り込み側の冪等性の鍵)
    expect(tables.analyses.map((a) => a["id"])).toEqual([1, 2, 3, 4, 5]);
  });

  it("gzip は実際に圧縮されている(展開すると NDJSON、先頭はヘッダ)", () => {
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(lines[0]).toMatchObject({ type: "header", format: "keiba-cloud-migration", version: 1, appVersion: "1.27.0" });
  });
});
