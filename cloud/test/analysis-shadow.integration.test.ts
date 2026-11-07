import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { buildShadowStatements, INSERT_SHADOW_HORSES_SQL, INSERT_SHADOW_PROBS_SQL, shadowRowCount } from "../src/analysis-shadow-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import type { ShadowRecord } from "../../packages/core/src/ev/stat-shadow-record.js";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #649 段階 2・3: 統計モデルの並走(影の計算)の D1 への書き込みを、ローカル(workerd)の D1・R2 で確かめる。
 * 分析の保存と別の呼び出しで書き、書けなくても分析の保存は成功のまま(戻り値 `shadow: "failed"`)であること。
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

const shadow = (n: number): ShadowRecord => ({
  horses: Array.from({ length: n }, (_, k) => ({
    umaban: k + 1,
    inputWinOdds: k === 1 ? null : 3.5 + k,
    marketQ: k === 1 ? null : 0.1 + k / 100,
    flagLongRest: k === 0 ? null : (k % 2) as 0 | 1,
    flagSurfaceChange: 0 as const,
    flagFrontRunner: null,
    flagLongshotSlump: 1 as const,
  })),
  probs: ["lr649-odds-x", "lr649-noodds-x"].flatMap((model, m) =>
    Array.from({ length: n }, (_, k) => ({ umaban: k + 1, model, winProb: 0.05 + m / 100 + k / 1000, top2Prob: 0.1 + k / 1000, top3Prob: 0.2 + k / 1000 })),
  ),
});

function record(i: number, extra: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    raceId: `S${String(i).padStart(4, "0")}`,
    analyzedAt: `2026-11-07T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    kaisaiDate: "20261107",
    promptVersion: "v-test",
    horses: Array.from({ length: 4 }, (_, k) => ({ umaban: k + 1, prior: 0.5, adjustedProb: 0.25, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: { k }, mark: null, reason: "x" })),
    ...extra,
  };
}

const count = async (table: string): Promise<number> => (await local.db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;

describe("影の記録の書き込み", () => {
  it("書いた行が、馬の表と確率の表に、値どおり(null を含む)入る。戻り値は shadow: saved", async () => {
    const s = shadow(4);
    const saved = await store().saveAnalysis(record(1, { shadow: s }));
    expect(saved.shadow).toBe("saved");
    expect(saved.detail).toBe("stored");
    expect(await count("analysis_shadow_horses")).toBe(4);
    expect(await count("analysis_shadow_probs")).toBe(8);
    expect(shadowRowCount(s)).toBe(12);
    const h = await local.db.prepare("SELECT * FROM analysis_shadow_horses WHERE analysis_id = ? ORDER BY umaban").bind(saved.id).all<Record<string, number | null>>();
    expect(h.results).toHaveLength(4);
    expect(h.results[0]).toEqual({ analysis_id: saved.id, umaban: 1, input_win_odds: 3.5, market_q: 0.1, flag_long_rest: null, flag_surface_change: 0, flag_front_runner: null, flag_longshot_slump: 1 });
    // null のオッズ・q は null のまま(0 にならない)。
    expect(h.results[1]).toMatchObject({ umaban: 2, input_win_odds: null, market_q: null, flag_long_rest: 1 });
    const p = await local.db.prepare("SELECT * FROM analysis_shadow_probs WHERE analysis_id = ? AND umaban = 3 ORDER BY model").bind(saved.id).all<Record<string, number | string>>();
    expect(p.results).toEqual([
      { analysis_id: saved.id, umaban: 3, model: "lr649-noodds-x", win_prob: 0.05 + 1 / 100 + 2 / 1000, top2_prob: 0.1 + 2 / 1000, top3_prob: 0.2 + 2 / 1000 },
      { analysis_id: saved.id, umaban: 3, model: "lr649-odds-x", win_prob: 0.05 + 2 / 1000, top2_prob: 0.1 + 2 / 1000, top3_prob: 0.2 + 2 / 1000 },
    ]);
  });

  it("記録の無い分析は、影の表に何も書かず、戻り値に shadow のキーが無い", async () => {
    const saved = await store().saveAnalysis(record(2));
    expect("shadow" in saved).toBe(false);
    expect(await count("analysis_shadow_horses")).toBe(0);
    expect(await count("analysis_shadow_probs")).toBe(0);
  });

  it("オッズなしの版だけ(確率が馬の数だけ)でも書ける", async () => {
    const s = shadow(4);
    const only = { horses: s.horses, probs: s.probs.filter((x) => x.model === "lr649-noodds-x") };
    const saved = await store().saveAnalysis(record(3, { shadow: only }));
    expect(saved.shadow).toBe("saved");
    expect(await count("analysis_shadow_probs")).toBe(4);
  });

  it("別々の分析の行が混ざらない(analysis_id で分かれる)", async () => {
    const a = await store().saveAnalysis(record(4, { shadow: shadow(4) }));
    const b = await store().saveAnalysis(record(5, { shadow: shadow(4) }));
    expect(a.id).not.toBe(b.id);
    for (const id of [a.id, b.id]) {
      expect((await local.db.prepare("SELECT count(*) AS c FROM analysis_shadow_probs WHERE analysis_id = ?").bind(id).first<{ c: number }>())!.c).toBe(8);
    }
  });

  it("影の表に書けなくても、分析の保存は成功のまま(戻り値 shadow: failed)。馬の行だけが残ることもない(batch は一括)", async () => {
    await local.db.prepare("ALTER TABLE analysis_shadow_probs RENAME TO analysis_shadow_probs_off").run();
    try {
      const saved = await store().saveAnalysis(record(6, { shadow: shadow(4) }));
      expect(saved.shadow).toBe("failed");
      expect(saved.detail).toBe("stored");
      expect(saved.id).toBeGreaterThan(0);
      // 分析の本体は保存されている。
      expect(await count("analyses")).toBe(1);
      expect(await count("analysis_horses")).toBe(4);
      // 馬の影の行は残らない(同じ batch が巻き戻る)。
      expect(await count("analysis_shadow_horses")).toBe(0);
    } finally {
      await local.db.prepare("ALTER TABLE analysis_shadow_probs_off RENAME TO analysis_shadow_probs").run();
    }
  });

  it("文は 2 つ以内(batch の文数の上限 50 に対して十分小さい)で、束縛値は文ごとに 2 つ(id と JSON)", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const fakeDb = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => (calls.push({ sql, args }), { sql, args }) }), batch: async () => [] };
    const stmts = buildShadowStatements(fakeDb as never, 7, shadow(18));
    expect(stmts).toHaveLength(2);
    expect(calls.map((c) => c.sql)).toEqual([INSERT_SHADOW_HORSES_SQL, INSERT_SHADOW_PROBS_SQL]);
    for (const c of calls) {
      expect(c.args).toHaveLength(2);
      expect(c.args[0]).toBe(7);
    }
    expect(JSON.parse(calls[1]!.args[1] as string)).toHaveLength(36);
  });
});
