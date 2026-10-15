import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MarkRepairReport } from "@keiba/core/llm";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { analysesInsertIndex, buildSaveStatements, D1AnalysisStore, type AnalysisDb } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import { serializeMarkRepair } from "../src/mark-repair";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #317: 印の補修の記録(`analyses.mark_repair_json`。migration 0018。cloud 専用の列)の永続化。
 * 保存(`saveAnalysis(record, { llmNote, llmCalls, markRepair })`)・読み出し(詳細。一覧には載せない)・保存先(`createAnalysisSink`)を、
 * 本物の(ローカルの workerd の)D1・R2 で確かめる。core の `AnalysisRecord`(exe と共有)は変えない。
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

const NOTE = "印の一部を規則に合わせて直しました(3着内率の補正は反映しています)";
const REPAIRED: MarkRepairReport = {
  repaired: true,
  adoptedAttempt: 2,
  attempts: [{ n: 1, kinds: ["over-◎"] }, { n: 2, kinds: ["over-◎", "gap-〇"] }],
  changes: [{ umaban: 2, from: "◎", to: "〇" }, { umaban: 3, from: "不明", to: null }],
};
const RESOLVED: MarkRepairReport = { repaired: false, adoptedAttempt: 2, attempts: [{ n: 1, kinds: ["missing-◎"] }], changes: [] };

function mkRecord(i: number, withAllocation = true): AnalysisRecord {
  const base: AnalysisRecord = {
    raceId: `R${String(i).padStart(4, "0")}`,
    analyzedAt: `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    kaisaiDate: "20261006",
    promptVersion: "v-test",
    horses: [1, 2, 3].map((n) => ({ umaban: n, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: { n }, mark: n === 2 ? "〇" : null, reason: null })),
  };
  if (!withAllocation) return base;
  const meta = contractCases[0]!.record.allocation!.meta;
  return { ...base, allocation: { meta, bets: [{ betType: "wide", comboKey: `${i}-0`, stake: 100, odds: 5.5, ev: 1.2 }] } };
}

const store = (now?: () => Date): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2, ...(now === undefined ? {} : { now }) });
const rawOf = async (id: number) => local.db.prepare("SELECT llm_note AS note, llm_calls_json AS calls, mark_repair_json AS repair FROM analyses WHERE id = ?").bind(id).first<{ note: string | null; calls: string | null; repair: string | null }>();

describe("保存: mark_repair_json 列", () => {
  it("補修の記録を渡して保存すると、その分析の行に JSON 文字列で入る。ほかの分析の行は NULL のまま。理由も同じ文で入る", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: NOTE, llmCalls: null, markRepair: REPAIRED });
    const b = await s.saveAnalysis(mkRecord(2));
    const rowA = await rawOf(a.id);
    expect(rowA!.note).toBe(NOTE);
    expect(rowA!.repair).toBe(serializeMarkRepair(REPAIRED));
    expect(JSON.parse(rowA!.repair!).horses).toEqual([{ umaban: 2, from: "◎", to: "〇" }, { umaban: 3, from: "不明", to: null }]);
    expect(await rawOf(b.id)).toEqual({ note: null, calls: null, repair: null });
  });

  it("聞き直しで解消した記録(repaired:false)も保存する(どの規則でよく外れるかを数えるため)。理由はない", async () => {
    const saved = await store().saveAnalysis(mkRecord(1), { llmNote: null, markRepair: RESOLVED });
    const row = await rawOf(saved.id);
    expect(row!.note).toBeNull();
    expect(JSON.parse(row!.repair!)).toMatchObject({ v: 1, repaired: false, adoptedAttempt: 2, attempts: [{ n: 1, kinds: ["missing-◎"] }], horses: [] });
  });

  it.each([[undefined], [null]])("記録なし(markRepair=%j)は NULL", async (markRepair) => {
    const saved = await store().saveAnalysis(mkRecord(1), { llmNote: null, markRepair });
    expect((await rawOf(saved.id))!.repair).toBeNull();
  });

  it("R2 の柵(Class A が上限)でスキップするときも、記録は保存する", async () => {
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(202610, R2_FENCE_LIMITS.classA).run();
    const saved = await store(() => new Date("2026-10-06T12:00:00Z")).saveAnalysis(mkRecord(1), { llmNote: NOTE, markRepair: REPAIRED });
    expect(saved.detail).toBe("skipped");
    expect((await rawOf(saved.id))!.repair).toBe(serializeMarkRepair(REPAIRED));
  });

  it("10 件を同時に保存しても、記録は自分の分析に付く(取り違え 0)", async () => {
    const s = store();
    const saved = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.saveAnalysis(mkRecord(i + 1), { llmNote: null, markRepair: { ...REPAIRED, changes: [{ umaban: i + 1, from: "◎", to: "〇" }] } }).then((r) => ({ i, id: r.id })),
      ),
    );
    expect(new Set(saved.map((x) => x.id)).size).toBe(10);
    for (const { i, id } of saved) {
      const row = await local.db.prepare("SELECT race_id AS raceId, mark_repair_json AS r FROM analyses WHERE id = ?").bind(id).first<{ raceId: string; r: string }>();
      expect(row!.raceId, `id=${id}`).toBe(`R${String(i + 1).padStart(4, "0")}`);
      expect(JSON.parse(row!.r).horses).toEqual([{ umaban: i + 1, from: "◎", to: "〇" }]);
    }
  });

  it("保存先(createAnalysisSink)も markRepair を渡す", async () => {
    const sink = createAnalysisSink(store());
    const saved = await sink.save(mkRecord(1), { llmNote: NOTE, markRepair: REPAIRED });
    expect((await rawOf(saved.id))!.repair).toBe(serializeMarkRepair(REPAIRED));
  });
});

describe("保存の文: 補修の記録があるときも、UPDATE は1文のまま(文の数を増やさない)", () => {
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
  const YM = 202610;
  const REPAIR_JSON = serializeMarkRepair(REPAIRED)!;
  const CALLS_JSON = '[{"ok":true}]';
  const where = "WHERE id = (SELECT max(id) FROM analyses)";

  it("記録だけ: +1 文で mark_repair_json だけを更新する。何も無ければ、これまでと同じ 6 文(配分あり)", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(1), YM, null, null, null, null)).toHaveLength(6);
    expect(f.statements.some((st) => /mark_repair_json/.test(st.sql))).toBe(false);
    const g = fake();
    expect(buildSaveStatements(g.db, mkRecord(1), YM, null, null, null, REPAIR_JSON)).toHaveLength(7);
    const update = g.statements.filter((st) => /mark_repair_json/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe(`UPDATE analyses SET mark_repair_json = ? ${where}`);
    expect(update[0]!.binds).toEqual([REPAIR_JSON]);
  });

  it("理由 + 記録: 1文で llm_note と mark_repair_json を更新(束縛値の順は SET の列の順)", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(1), YM, NOTE, null, null, REPAIR_JSON)).toHaveLength(7);
    const update = f.statements.filter((st) => /llm_note|mark_repair_json/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe(`UPDATE analyses SET llm_note = ?, mark_repair_json = ? ${where}`);
    expect(update[0]!.binds).toEqual([NOTE, REPAIR_JSON]);
  });

  it("3つ全部: 1文で llm_note・llm_calls_json・mark_repair_json。配分ありで 7・なしで 5。INSERT の位置は変わらず、UPDATE は馬の前", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(1), YM, NOTE, CALLS_JSON, null, REPAIR_JSON)).toHaveLength(7);
    const update = f.statements.filter((st) => /SET llm_note/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe(`UPDATE analyses SET llm_note = ?, llm_calls_json = ?, mark_repair_json = ? ${where}`);
    expect(update[0]!.binds).toEqual([NOTE, CALLS_JSON, REPAIR_JSON]);
    expect(f.statements[analysesInsertIndex(YM)]!.sql).toMatch(/^INSERT INTO analyses\b/);
    const order = f.statements.map((st) => (/^UPDATE analyses SET llm_note/.test(st.sql) ? "update" : /INTO analysis_horses/.test(st.sql) ? "horses" : /^INSERT INTO analyses\b/.test(st.sql) ? "analyses" : "other"));
    expect(order.indexOf("update")).toBeGreaterThan(order.indexOf("analyses"));
    expect(order.indexOf("update")).toBeLessThan(order.indexOf("horses"));
    const g = fake();
    expect(buildSaveStatements(g.db, mkRecord(1, false), YM, NOTE, CALLS_JSON, null, REPAIR_JSON)).toHaveLength(5);
  });

  it("記録が無い保存では、mark_repair_json を SQL に出さない(列が無い旧スキーマでも、補修の無い分析の保存は壊れない)", () => {
    for (const [note, calls] of [[null, null], [NOTE, null], [null, CALLS_JSON], [NOTE, CALLS_JSON]] as const) {
      const f = fake();
      buildSaveStatements(f.db, mkRecord(1), YM, note, calls, null, null);
      expect(f.statements.some((st) => /mark_repair_json/.test(st.sql)), `${note}/${calls}`).toBe(false);
    }
  });
});

describe("読み出し: 詳細に markRepair が載る。一覧には載せない", () => {
  it("詳細(getAnalysisDetail): 保存した記録が復元される。記録なしは null", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: NOTE, markRepair: REPAIRED });
    const b = await s.saveAnalysis(mkRecord(2));
    expect((await s.getAnalysisDetail(a.id))!.markRepair).toEqual({ v: 1, repaired: true, adoptedAttempt: 2, attempts: REPAIRED.attempts, horses: REPAIRED.changes });
    expect((await s.getAnalysisDetail(b.id))!.markRepair).toBeNull();
  });

  it("詳細が R2 に無い(none)ときも、markRepair は D1 の値で返る(詳細の状態に依らない)", async () => {
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(202610, R2_FENCE_LIMITS.classA).run();
    const s = store(() => new Date("2026-10-06T12:00:00Z"));
    const saved = await s.saveAnalysis(mkRecord(1), { llmNote: NOTE, markRepair: REPAIRED });
    const result = (await s.getAnalysisDetail(saved.id))!;
    expect(result.detail).toBe("none");
    expect(result.markRepair?.repaired).toBe(true);
  });

  it("壊れた値が入っていても読み出しは落ちない(null)", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1));
    await local.db.prepare("UPDATE analyses SET mark_repair_json = ? WHERE id = ?").bind("これはJSONではない", a.id).run();
    expect((await s.getAnalysisDetail(a.id))!.markRepair).toBeNull();
  });

  it("一覧(要約)には markRepair を載せない・読まない", async () => {
    const s = store();
    await s.saveAnalysis(mkRecord(1), { llmNote: NOTE, markRepair: REPAIRED });
    const list = await s.listAnalysisSummaries({});
    expect(list).toHaveLength(1);
    expect("markRepair" in list[0]!).toBe(false);
  });

  it("集計の入口: 違反の種類を SQL で数えられる(json_each(mark_repair_json -> '$.attempts'))", async () => {
    const s = store();
    await s.saveAnalysis(mkRecord(1), { llmNote: NOTE, markRepair: REPAIRED });
    await s.saveAnalysis(mkRecord(2), { llmNote: null, markRepair: RESOLVED });
    await s.saveAnalysis(mkRecord(3));
    const rows = await local.db
      .prepare(
        `SELECT k.value AS kind, count(*) AS c
           FROM analyses a, json_each(a.mark_repair_json, '$.attempts') t, json_each(t.value, '$.kinds') k
          WHERE a.mark_repair_json IS NOT NULL GROUP BY k.value ORDER BY k.value`,
      )
      .all<{ kind: string; c: number }>();
    expect(rows.results).toEqual([
      { kind: "gap-〇", c: 1 },
      { kind: "missing-◎", c: 1 },
      { kind: "over-◎", c: 2 },
    ]);
  });
});
