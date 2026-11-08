import { describe, expect, it } from "vitest";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import type { OddsSourcesMeta } from "../../packages/core/src/scraper/odds-override";
import { analysesInsertIndex, buildSaveStatements, type AnalysisDb } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import { serializeOddsSources } from "../src/odds-sources-json";
import { contractCases } from "./fixtures-contract";

/**
 * Issue #675 段階 B: オッズの取得元の記録(`analyses.odds_sources_json`。migration 0042)を保存する文。
 * 本物の D1 での永続化は `analysis-odds-sources.integration.test.ts`。ここは文の組み立て(偽の db)と、保存先への受け渡し。
 */
const SOURCES: OddsSourcesMeta = {
  winPlace: { source: "jra", officialDatetime: "2026-11-08 10:37:00" },
  wide: { source: "netkeiba", officialDatetime: null, fallbackReason: "horse-set-mismatch" },
};

function mkRecord(withAllocation: boolean): AnalysisRecord {
  const base: AnalysisRecord = {
    raceId: "R0001",
    analyzedAt: "2026-11-08T00:00:00.000Z",
    kaisaiDate: "20261108",
    promptVersion: "v-test",
    horses: [1, 2, 3].map((n) => ({ umaban: n, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: { n }, mark: null, reason: null })),
  };
  if (!withAllocation) return base;
  const meta = contractCases[0]!.record.allocation!.meta;
  return { ...base, allocation: { meta, bets: [{ betType: "wide", comboKey: "1-0", stake: 100, odds: 5.5, ev: 1.2 }] } };
}

interface FakeStatement {
  readonly sql: string;
  binds: unknown[];
}
function fake(): { db: AnalysisDb; statements: FakeStatement[] } {
  const statements: FakeStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement: FakeStatement = { sql, binds: [] };
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          statement.binds = values;
          return this;
        },
      };
    },
  } as unknown as AnalysisDb;
  return { db, statements };
}
const YM = 202611;
const where = "WHERE id = (SELECT max(id) FROM analyses)";
const ODDS_JSON = serializeOddsSources(SOURCES)!;

describe("serializeOddsSources", () => {
  it("版つきの JSON にする。取得元・頁の時刻・戻した理由が残る", () => {
    const parsed = JSON.parse(ODDS_JSON);
    expect(parsed.v).toBe(1);
    expect(parsed.sources.winPlace).toEqual({ source: "jra", officialDatetime: "2026-11-08 10:37:00" });
    expect(parsed.sources.wide).toEqual({ source: "netkeiba", officialDatetime: null, fallbackReason: "horse-set-mismatch" });
  });
  it("記録なし(null・undefined・空)は null(NULL で保存する)", () => {
    expect(serializeOddsSources(null)).toBeNull();
    expect(serializeOddsSources(undefined)).toBeNull();
    expect(serializeOddsSources({})).toBeNull();
  });
});

describe("保存の文: 取得元の記録があっても UPDATE は1文のまま(文の数を増やさない)", () => {
  it("記録だけ: +1 文で odds_sources_json だけを更新する。何も無ければ、これまでと同じ 6 文(配分あり)", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(true), YM, null, null, null)).toHaveLength(6);
    expect(f.statements.some((st) => /odds_sources_json/.test(st.sql))).toBe(false);
    const g = fake();
    expect(buildSaveStatements(g.db, mkRecord(true), YM, null, null, null, ODDS_JSON)).toHaveLength(7);
    const update = g.statements.filter((st) => /odds_sources_json/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe(`UPDATE analyses SET odds_sources_json = ? ${where}`);
    expect(update[0]!.binds).toEqual([ODDS_JSON]);
  });
  it("理由・LLM 呼び出し・印の補修・取得元の 4 つ全部: 1 文で 4 列(列の順は llm_note → llm_calls_json → mark_repair_json → odds_sources_json)。INSERT の位置は変わらない", () => {
    const f = fake();
    const statements = buildSaveStatements(f.db, mkRecord(true), YM, "理由", '[{"ok":true}]', '{"v":1}', ODDS_JSON);
    const update = f.statements.filter((st) => /odds_sources_json|llm_note/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe(`UPDATE analyses SET llm_note = ?, llm_calls_json = ?, mark_repair_json = ?, odds_sources_json = ? ${where}`);
    expect(update[0]!.binds).toEqual(["理由", '[{"ok":true}]', '{"v":1}', ODDS_JSON]);
    expect(statements).toHaveLength(7); // これまでの 3 つ全部と同じ文数(UPDATE は 1 文のまま)
    expect(analysesInsertIndex(YM)).toBe(1);
    expect(f.statements[analysesInsertIndex(YM)]!.sql).toMatch(/^INSERT INTO analyses/);
  });
  it("配分なし・R2 の柵(ym=null)でも、記録だけの UPDATE は 1 文足すだけ", () => {
    const a = fake();
    expect(buildSaveStatements(a.db, mkRecord(false), YM, null, null, null)).toHaveLength(4);
    const b = fake();
    expect(buildSaveStatements(b.db, mkRecord(false), YM, null, null, null, ODDS_JSON)).toHaveLength(5);
    const c = fake();
    expect(buildSaveStatements(c.db, mkRecord(false), null, null, null, null, ODDS_JSON)).toHaveLength(3);
  });
  it("記録が無い保存では、odds_sources_json を SQL に出さない(列が無い旧スキーマでも、JRA を使わない保存は動く)", () => {
    for (const note of [null, "理由"]) {
      const f = fake();
      buildSaveStatements(f.db, mkRecord(true), YM, note, null, null, null);
      expect(f.statements.some((st) => /odds_sources_json/.test(st.sql)), String(note)).toBe(false);
    }
  });
});

describe("保存先(createAnalysisSink)は oddsSources を保存先へ渡す", () => {
  it("渡した記録が saveAnalysis の extra に載る。無ければ載らない(null)", async () => {
    const seen: unknown[] = [];
    const store = { saveAnalysis: async (_r: AnalysisRecord, extra: unknown) => (seen.push(extra), { id: 1, detail: "stored" as const }) };
    const sink = createAnalysisSink(store as never);
    await sink.save(mkRecord(false), { llmNote: null, oddsSources: SOURCES });
    await sink.save(mkRecord(false), { llmNote: null });
    expect((seen[0] as { oddsSources: unknown }).oddsSources).toEqual(SOURCES);
    expect((seen[1] as { oddsSources: unknown }).oddsSources).toBeNull();
  });
});
