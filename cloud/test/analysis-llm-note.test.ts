import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { analysesInsertIndex, buildSaveStatements, D1AnalysisStore, type AnalysisDb } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #194(#179-b。b2): LLM が使われなかった・一部しか使われなかった理由(固定文言。`llm_note` 列。migration 0005)の永続化。
 * 保存(`saveAnalysis(record, { llmNote })`)・読み出し(一覧・詳細)・保存先(`createAnalysisSink`)を、本物の(ローカルの workerd の)D1・R2 で確かめる。
 * core の `AnalysisRecord`(exe と共有)は変えず、cloud の保存先だけが `extra` で受け取る。
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

const NOTE = "LLM呼び出しに失敗したため、3着内率をそのまま採用しました";

function mkRecord(i: number, withAllocation = true): AnalysisRecord {
  const base: AnalysisRecord = {
    raceId: `R${String(i).padStart(4, "0")}`,
    analyzedAt: `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    kaisaiDate: "20261006",
    promptVersion: "v-test",
    horses: [1, 2, 3].map((n) => ({ umaban: n, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: { n }, mark: null, reason: null })),
  };
  if (!withAllocation) return base;
  const meta = contractCases[0]!.record.allocation!.meta;
  return { ...base, allocation: { meta, bets: [{ betType: "wide", comboKey: `${i}-0`, stake: 100, odds: 5.5, ev: 1.2 }] } };
}

const store = (now?: () => Date): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2, ...(now === undefined ? {} : { now }) });
const noteOf = async (id: number): Promise<string | null> => (await local.db.prepare("SELECT llm_note AS n FROM analyses WHERE id = ?").bind(id).first<{ n: string | null }>())!.n;

describe("保存: llm_note 列", () => {
  it("理由(固定文言)を渡して保存すると、その分析の行の llm_note に入る。ほかの分析の行は NULL のまま", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: NOTE });
    const b = await s.saveAnalysis(mkRecord(2));
    expect(await noteOf(a.id)).toBe(NOTE);
    expect(await noteOf(b.id)).toBeNull();
  });

  it.each([[undefined], [{ llmNote: null }]])("理由なし(extra=%j)は NULL(LLM が問題なく効いた・LLM を使わない旧い経路)", async (extra) => {
    const saved = await store().saveAnalysis(mkRecord(1), extra);
    expect(await noteOf(saved.id)).toBeNull();
  });

  it("R2 の柵(Class A が上限)でスキップするときも、理由は保存する(D1 の要約に付く)", async () => {
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(202610, R2_FENCE_LIMITS.classA).run();
    const saved = await store(() => new Date("2026-10-06T12:00:00Z")).saveAnalysis(mkRecord(1), { llmNote: NOTE });
    expect(saved.detail).toBe("skipped");
    expect(await noteOf(saved.id)).toBe(NOTE);
  });

  it("配分なしの分析にも付く。子の行(馬)は正しい親に紐づいたまま", async () => {
    const saved = await store().saveAnalysis(mkRecord(1, false), { llmNote: NOTE });
    expect(await noteOf(saved.id)).toBe(NOTE);
    expect((await local.db.prepare("SELECT count(*) AS c FROM analysis_horses WHERE analysis_id = ?").bind(saved.id).first<{ c: number }>())!.c).toBe(3);
  });

  it("10 件を同時に保存しても、理由は自分の分析に付く(取り違え 0。`max(id)` の前提を、新しい UPDATE にも使うため)", async () => {
    const s = store();
    const saved = await Promise.all(Array.from({ length: 10 }, (_, i) => s.saveAnalysis(mkRecord(i + 1), { llmNote: `理由${i + 1}` }).then((r) => ({ i: i + 1, id: r.id }))));
    expect(new Set(saved.map((x) => x.id)).size).toBe(10);
    for (const { i, id } of saved) {
      const row = await local.db.prepare("SELECT race_id AS raceId, llm_note AS n FROM analyses WHERE id = ?").bind(id).first<{ raceId: string; n: string }>();
      expect(row, `id=${id}`).toEqual({ raceId: `R${String(i).padStart(4, "0")}`, n: `理由${i}` });
    }
  });
});

describe("保存の文: 理由があるときだけ UPDATE を1文足す(理由なしは、これまでと同じ文・同じ数)", () => {
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

  it("理由なし(省略・null)は、配分ありで 6 文・なしで 4 文のまま。llm_note の文は無い", () => {
    for (const note of [undefined, null]) {
      const withAllocation = fake();
      expect(buildSaveStatements(withAllocation.db, mkRecord(1), YM, note)).toHaveLength(6);
      expect(withAllocation.statements.some((st) => /llm_note/.test(st.sql))).toBe(false);
      const noAllocation = fake();
      expect(buildSaveStatements(noAllocation.db, mkRecord(1, false), YM, note)).toHaveLength(4);
    }
  });

  it("理由あり: +1 文(配分ありで 7・なしで 5)。UPDATE の束縛値は理由1個だけで、対象は直前に採番された行。analyses の INSERT の位置は変わらない", () => {
    const withAllocation = fake();
    expect(buildSaveStatements(withAllocation.db, mkRecord(1), YM, NOTE)).toHaveLength(7);
    const update = withAllocation.statements.filter((st) => /llm_note/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe("UPDATE analyses SET llm_note = ? WHERE id = (SELECT max(id) FROM analyses)");
    expect(update[0]!.binds).toEqual([NOTE]);
    expect(withAllocation.statements[analysesInsertIndex(YM)]!.sql).toMatch(/^INSERT INTO analyses\b/);
    // 馬・配分メタ・買い目より前(analyses の INSERT の直後の並びに入れる。子の行の文の順は変えない)
    const order = withAllocation.statements.map((st) => (/llm_note/.test(st.sql) ? "note" : /INTO analysis_horses/.test(st.sql) ? "horses" : /^INSERT INTO analyses\b/.test(st.sql) ? "analyses" : "other"));
    expect(order.indexOf("note")).toBeGreaterThan(order.indexOf("analyses"));
    expect(order.indexOf("note")).toBeLessThan(order.indexOf("horses"));
    const noAllocation = fake();
    expect(buildSaveStatements(noAllocation.db, mkRecord(1, false), YM, NOTE)).toHaveLength(5);
  });

  it("柵を超えた保存(ym = null)も、理由ありで +1(配分ありで 5・なしで 3)。INSERT の位置は 0 のまま", () => {
    const withAllocation = fake();
    expect(buildSaveStatements(withAllocation.db, mkRecord(1), null, NOTE)).toHaveLength(5);
    expect(withAllocation.statements[analysesInsertIndex(null)]!.sql).toMatch(/^INSERT INTO analyses\b/);
    const noAllocation = fake();
    expect(buildSaveStatements(noAllocation.db, mkRecord(1, false), null, NOTE)).toHaveLength(3);
    const none = fake();
    expect(buildSaveStatements(none.db, mkRecord(1), null, null)).toHaveLength(4);
  });
});

describe("読み出し: 一覧・詳細に llmNote が載る", () => {
  it("一覧(listAnalysisSummaries): 分析ごとの llmNote(理由あり・なしが混ざっても、それぞれの行の値)", async () => {
    const s = store();
    await s.saveAnalysis(mkRecord(1), { llmNote: NOTE });
    await s.saveAnalysis(mkRecord(2));
    const list = await s.listAnalysisSummaries();
    expect(list.map((x) => [x.raceId, x.llmNote])).toEqual([
      ["R0002", null],
      ["R0001", NOTE],
    ]);
  });

  it("詳細(getAnalysisDetail): llmNote が載る。理由なしは null。存在しない id は undefined のまま", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: NOTE });
    const b = await s.saveAnalysis(mkRecord(2));
    expect((await s.getAnalysisDetail(a.id))!.llmNote).toBe(NOTE);
    expect((await s.getAnalysisDetail(b.id))!.llmNote).toBeNull();
    expect(await s.getAnalysisDetail(999_999)).toBeUndefined();
  });

  it("詳細が R2 に無い(none・missing)ときも、llmNote は D1 の値で返る(詳細の状態に依らない)", async () => {
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(202610, R2_FENCE_LIMITS.classA).run();
    const s = store(() => new Date("2026-10-06T12:00:00Z"));
    const saved = await s.saveAnalysis(mkRecord(1), { llmNote: NOTE });
    const result = (await s.getAnalysisDetail(saved.id))!;
    expect(result.detail).toBe("none");
    expect(result.llmNote).toBe(NOTE);
  });

  it("一覧の SQL は llm_note を読む(大きな列は読まない)。一覧は 2 文の batch のまま", async () => {
    const prepared: string[] = [];
    const batches: number[] = [];
    const spy = {
      prepare: (sql: string) => {
        prepared.push(sql);
        return local.db.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => {
        batches.push(statements.length);
        return local.db.batch(statements);
      },
    } as unknown as AnalysisDb;
    await new D1AnalysisStore({ db: spy, bucket: local.r2 }).listAnalysisSummaries();
    expect(batches).toEqual([2]);
    expect(prepared.some((sql) => /llm_note AS llmNote/.test(sql))).toBe(true);
    expect(prepared.some((sql) => /raw_response|race_snapshot_json/.test(sql.replace(/NULL AS \w+/g, "")))).toBe(false);
  });
});

describe("AnalysisSink(DO が使う保存先)", () => {
  it("save(record, { llmNote }) は理由を D1 に保存する。第2引数なしは NULL", async () => {
    const sink = createAnalysisSink(store());
    const a = await sink.save(mkRecord(1), { llmNote: NOTE });
    const b = await sink.save(mkRecord(2));
    expect(await noteOf(a.id)).toBe(NOTE);
    expect(await noteOf(b.id)).toBeNull();
  });
});
