import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #216(#167-B1): 一覧(`listAnalysisSummaries`)の並びは**分析日時の降順**(同時刻は id の降順)。
 * 移行した分析は D1 の id が新しいのに分析日時は古いので、`ORDER BY id DESC` では古い分析が最新として並ぶ。
 * あわせて、並びを変えても D1 の読み取り行数が増えない(索引で先頭の N 件だけを読む。一時ソートを使わない)ことを固定する。
 */

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

const store = (): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2 });

function rec(raceId: string, analyzedAt: string, kaisaiDate: string | null = "20261006"): AnalysisRecord {
  return {
    raceId,
    analyzedAt,
    kaisaiDate,
    promptVersion: "v-test",
    horses: [{ umaban: 1, prior: 0.5, adjustedProb: 0.5, placeOddsMin: 1.5, ev: 1, isPositive: false, contributions: null, mark: null, reason: "r" }],
  };
}

describe("一覧の並び: 分析日時の降順(同時刻は id の降順)", () => {
  it("id の順と分析日時の順が逆の3件(移行した古い分析が、後から保存された)は、分析日時の新しい順に並ぶ", async () => {
    const newest = await store().saveAnalysis(rec("R1", "2026-10-06T12:00:00.000Z"));
    const middle = await store().saveAnalysis(rec("R1", "2026-10-06T06:00:00.000Z"));
    const oldest = await store().saveAnalysis(rec("R1", "2026-01-01T00:00:00.000Z"));
    // 前提: id は保存順(oldest が最大)で、分析日時の順と逆になっている(そうでないと、旧実装でも通る)。
    expect(oldest.id).toBeGreaterThan(middle.id);
    expect(middle.id).toBeGreaterThan(newest.id);
    for (const filter of [{}, { raceId: "R1" }, { kaisaiDate: "20261006" }, { raceId: "R1", kaisaiDate: "20261006" }]) {
      const list = await store().listAnalysisSummaries(filter);
      expect(list.map((s) => s.id), JSON.stringify(filter)).toEqual([newest.id, middle.id, oldest.id]);
    }
  });

  it("分析日時が同じなら、id の大きい方が先(旧実装と同じ向き)", async () => {
    const a = await store().saveAnalysis(rec("R1", "2026-10-06T12:00:00.000Z"));
    const b = await store().saveAnalysis(rec("R1", "2026-10-06T12:00:00.000Z"));
    expect(b.id).toBeGreaterThan(a.id);
    expect((await store().listAnalysisSummaries({ raceId: "R1" })).map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it("limit は「分析日時の新しい N 件」(id の新しい N 件ではない)。馬は選ばれた N 件のものだけが付く", async () => {
    const oldFirst = await store().saveAnalysis(rec("R1", "2026-10-06T01:00:00.000Z"));
    const recent = await store().saveAnalysis(rec("R1", "2026-10-06T23:00:00.000Z"));
    const ancient = await store().saveAnalysis(rec("R1", "2025-01-01T00:00:00.000Z"));
    const list = await store().listAnalysisSummaries({ limit: 2 });
    expect(list.map((s) => s.id)).toEqual([recent.id, oldFirst.id]);
    expect(list.every((s) => s.horses.length === 1)).toBe(true);
    expect(list.map((s) => s.id)).not.toContain(ancient.id);
  });
});

describe("並びを変えても読み取り行数が増えない(索引で先頭の N 件だけを読む)", () => {
  let planCounter = 0;
  async function plan(sql: string, binds: unknown[]): Promise<string[]> {
    planCounter += 1;
    return (await local.db.prepare(`EXPLAIN QUERY PLAN ${sql} /* order-plan-${planCounter} */`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail);
  }

  async function seed(n: number): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < n; i += 1) {
      // 分析日時は id と逆順(後から入れたものほど古い)。
      const at = new Date(Date.UTC(2026, 9, 6, 12) - i * 60_000).toISOString();
      statements.push(local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, kaisai_date, prompt_version) VALUES (?, ?, ?, 'v')").bind(i % 2 === 0 ? "RACE-A" : "RACE-B", at, "20261006"));
    }
    await local.db.batch(statements);
  }

  const cases: ReadonlyArray<readonly [string, Record<string, string>, unknown[], RegExp]> = [
    ["絞り込みなし", {}, [10], /^SCAN analyses USING INDEX idx_analyses_analyzed_at/],
    ["raceId", { raceId: "RACE-A" }, ["RACE-A", 10], /^SEARCH analyses USING INDEX idx_analyses_race_analyzed \(race_id=\?\)/],
    ["kaisaiDate", { kaisaiDate: "20261006" }, ["20261006", 10], /^SEARCH analyses USING INDEX idx_analyses_kaisai_analyzed \(kaisai_date=\?\)/],
  ];

  it.each(cases)("%s: 実行計画は新しい索引を使い、一時ソート(TEMP B-TREE)を使わない", async (_name, filter, binds, expected) => {
    const db = spyDb(local.db);
    await new D1AnalysisStore({ db: db.db, bucket: spyBucket(local.r2).bucket }).listAnalysisSummaries({ ...filter, limit: 10 });
    const details = await plan(db.prepared[0]!, binds);
    expect(details.some((d) => expected.test(d)), details.join(" / ")).toBe(true);
    expect(details.some((d) => /TEMP B-TREE/.test(d)), details.join(" / ")).toBe(false);
  });

  it.each(cases)("%s: 400 件のうち limit=10 を引くとき、分析の文が読む行数は 10 件ぶん程度(全件を読まない)", async (_name, filter, binds) => {
    await seed(400);
    const db = spyDb(local.db);
    await new D1AnalysisStore({ db: db.db, bucket: spyBucket(local.r2).bucket }).listAnalysisSummaries({ ...filter, limit: 10 });
    const meta = (await local.db.prepare(db.prepared[0]!).bind(...binds).all()).meta;
    // 前提: 条件に合う行は 200 件以上ある(全件を読む実装なら、それだけの行を読む)。
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses").first<{ c: number }>())!.c).toBe(400);
    expect(meta.rows_read).toBeGreaterThanOrEqual(10);
    expect(meta.rows_read).toBeLessThan(40);
  });

  it("対照(検出が空振りでない): 新しい索引が無ければ、絞り込みなしは全件を読む", async () => {
    await seed(400);
    const db = spyDb(local.db);
    await new D1AnalysisStore({ db: db.db, bucket: spyBucket(local.r2).bucket }).listAnalysisSummaries({ limit: 10 });
    await local.db.prepare("DROP INDEX idx_analyses_analyzed_at").run();
    try {
      const meta = (await local.db.prepare(`${db.prepared[0]!} /* no-index */`).bind(10).all()).meta;
      expect(meta.rows_read).toBeGreaterThanOrEqual(400);
    } finally {
      await local.db.prepare("CREATE INDEX idx_analyses_analyzed_at ON analyses (analyzed_at)").run();
    }
  });
});
