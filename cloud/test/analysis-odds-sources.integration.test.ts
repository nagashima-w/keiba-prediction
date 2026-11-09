import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import type { OddsSourcesMeta } from "../../packages/core/src/scraper/odds-override";
import { D1AnalysisStore } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import { serializeOddsSources } from "../src/odds-sources-json";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #675 段階 B: オッズの取得元の記録(`analyses.odds_sources_json`。migration 0042。cloud 専用の列)を、本物の(ローカルの workerd の)D1・R2 で確かめる。
 * 文の組み立ては `analysis-odds-sources.test.ts`(ユニット)。
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

const SOURCES: OddsSourcesMeta = {
  winPlace: { source: "jra", officialDatetime: "2026-11-08 10:37:00" },
  trifecta: { source: "netkeiba", officialDatetime: null, fallbackReason: "override-unavailable" },
};

function mkRecord(i: number): AnalysisRecord {
  const meta = contractCases[0]!.record.allocation!.meta;
  return {
    raceId: `R${String(i).padStart(4, "0")}`,
    analyzedAt: `2026-11-08T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    kaisaiDate: "20261108",
    promptVersion: "v-test",
    horses: [1, 2, 3].map((n) => ({ umaban: n, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: { n }, mark: null, reason: null })),
    allocation: { meta, bets: [{ betType: "wide", comboKey: `${i}-0`, stake: 100, odds: 5.5, ev: 1.2 }] },
  };
}
const store = (): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
const rawOf = (id: number) => local.db.prepare("SELECT llm_note AS note, odds_sources_json AS odds FROM analyses WHERE id = ?").bind(id).first<{ note: string | null; odds: string | null }>();

describe("保存: odds_sources_json 列", () => {
  it("取得元の記録を渡して保存すると、その分析の行に JSON 文字列で入る。ほかの分析の行は NULL のまま。理由も同じ文で入る", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: "理由", oddsSources: SOURCES });
    const b = await s.saveAnalysis(mkRecord(2), { llmNote: null });
    const rowA = (await rawOf(a.id))!;
    expect(rowA.note).toBe("理由");
    expect(rowA.odds).toBe(serializeOddsSources(SOURCES));
    expect(JSON.parse(rowA.odds!).sources.winPlace.source).toBe("jra");
    expect(JSON.parse(rowA.odds!).sources.trifecta.fallbackReason).toBe("override-unavailable");
    expect(await rawOf(b.id)).toEqual({ note: null, odds: null });
  });
  it.each([[undefined], [null], [{}]])("記録なし(oddsSources=%j)は NULL", async (oddsSources) => {
    const saved = await store().saveAnalysis(mkRecord(1), { llmNote: null, oddsSources: oddsSources as OddsSourcesMeta | null | undefined });
    expect((await rawOf(saved.id))!.odds).toBeNull();
  });
  it("保存先(createAnalysisSink)も oddsSources を渡す", async () => {
    const saved = await createAnalysisSink(store()).save(mkRecord(1), { llmNote: null, oddsSources: SOURCES });
    expect((await rawOf(saved.id))!.odds).toBe(serializeOddsSources(SOURCES));
  });
  it("10 件を同時に保存しても、記録は自分の分析に付く(取り違え 0)", async () => {
    const s = store();
    const saved = await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.saveAnalysis(mkRecord(i + 1), { llmNote: null, oddsSources: { winPlace: { source: "jra", officialDatetime: `2026-11-08 10:${String(i).padStart(2, "0")}:00` } } }).then((r) => ({ i, id: r.id }))),
    );
    for (const { i, id } of saved) {
      const row = await local.db.prepare("SELECT race_id AS raceId, odds_sources_json AS o FROM analyses WHERE id = ?").bind(id).first<{ raceId: string; o: string }>();
      expect(row!.raceId, `id=${id}`).toBe(`R${String(i + 1).padStart(4, "0")}`);
      expect(JSON.parse(row!.o).sources.winPlace.officialDatetime).toBe(`2026-11-08 10:${String(i).padStart(2, "0")}:00`);
    }
  });
  it("集計の入口: 券種ごとの取得元を SQL で数えられる(json_each(odds_sources_json, '$.sources'))", async () => {
    await store().saveAnalysis(mkRecord(1), { llmNote: null, oddsSources: SOURCES });
    const rows = (await local.db.prepare("SELECT s.key AS k, s.value ->> '$.source' AS source, count(*) AS n FROM analyses a, json_each(a.odds_sources_json, '$.sources') s GROUP BY s.key, source ORDER BY s.key").all<{ k: string; source: string; n: number }>()).results;
    expect(rows).toEqual([
      { k: "trifecta", source: "netkeiba", n: 1 },
      { k: "winPlace", source: "jra", n: 1 },
    ]);
  });
  it("読み出し(Issue #677): getAnalysisDetail が記録の JSON を返す。記録なしの分析は null", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: null, oddsSources: SOURCES });
    const b = await s.saveAnalysis(mkRecord(2), { llmNote: null });
    expect((await s.getAnalysisDetail(a.id))!.oddsSourcesJson).toBe(serializeOddsSources(SOURCES));
    expect((await s.getAnalysisDetail(b.id))!.oddsSourcesJson).toBeNull();
  });
});
