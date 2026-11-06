import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { analysesInsertIndex, buildSaveStatements, D1AnalysisStore, type AnalysisDb } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import type { LlmCallRecord } from "../src/llm-calls";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { contractCases } from "./fixtures-contract";
import { detailKeyOf } from "../src/analysis-detail";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #197(#196-a 段2): LLM 呼び出しの記録(`analyses.llm_calls_json`。migration 0007。cloud 専用の列)の永続化。
 * 保存(`saveAnalysis(record, { llmNote, llmCalls })`)・読み出し(詳細。一覧には載せない)・保存先(`createAnalysisSink`)を、本物の(ローカルの workerd の)D1・R2 で確かめる。
 * core の `AnalysisRecord`(exe と共有)は変えない。
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
const OK: LlmCallRecord = { ok: true, ms: 41_234, inputTokens: 15_001, outputTokens: 6_020, stopReason: "end_turn", model: "claude-sonnet-5-5", replayed: false, error: null };
const FAILED: LlmCallRecord = { ok: false, ms: 180_001, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "種別=timeout" };
const REPLAYED: LlmCallRecord = { ...OK, replayed: true };

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
const rawOf = async (id: number) => local.db.prepare("SELECT llm_note AS note, llm_calls_json AS calls FROM analyses WHERE id = ?").bind(id).first<{ note: string | null; calls: string | null }>();

describe("保存: llm_calls_json 列", () => {
  it("記録(失敗 → 成功の2件)を渡して保存すると、その分析の行に JSON 配列の文字列で入る。ほかの分析の行は NULL のまま。理由なしなら llm_note は NULL", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: null, llmCalls: [FAILED, OK] });
    const b = await s.saveAnalysis(mkRecord(2));
    const rowA = await rawOf(a.id);
    expect(rowA!.note).toBeNull();
    expect(JSON.parse(rowA!.calls!)).toEqual([FAILED, OK]);
    expect(await rawOf(b.id)).toEqual({ note: null, calls: null });
  });

  it("理由と記録の両方があれば、同じ行に両方入る(1文の UPDATE)", async () => {
    const saved = await store().saveAnalysis(mkRecord(1), { llmNote: NOTE, llmCalls: [FAILED, FAILED] });
    const row = await rawOf(saved.id);
    expect(row!.note).toBe(NOTE);
    expect(JSON.parse(row!.calls!)).toEqual([FAILED, FAILED]);
  });

  it.each([[undefined], [null], [[]]])("記録なし(llmCalls=%j)は NULL(LLM を使わない経路。『呼んでいない』を空配列で持たない)", async (llmCalls) => {
    const saved = await store().saveAnalysis(mkRecord(1), { llmNote: null, llmCalls: llmCalls as readonly LlmCallRecord[] | null | undefined });
    expect(await rawOf(saved.id)).toEqual({ note: null, calls: null });
  });

  it("R2 の柵(Class A が上限)でスキップするときも、記録は保存する(D1 の要約に付く)", async () => {
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(202610, R2_FENCE_LIMITS.classA).run();
    const saved = await store(() => new Date("2026-10-06T12:00:00Z")).saveAnalysis(mkRecord(1), { llmNote: null, llmCalls: [OK] });
    expect(saved.detail).toBe("skipped");
    expect(JSON.parse((await rawOf(saved.id))!.calls!)).toEqual([OK]);
  });

  it("配分なしの分析にも付く。子の行(馬)は正しい親に紐づいたまま", async () => {
    const saved = await store().saveAnalysis(mkRecord(1, false), { llmNote: null, llmCalls: [OK] });
    expect(JSON.parse((await rawOf(saved.id))!.calls!)).toEqual([OK]);
    expect((await local.db.prepare("SELECT count(*) AS c FROM analysis_horses WHERE analysis_id = ?").bind(saved.id).first<{ c: number }>())!.c).toBe(3);
  });

  it("10 件を同時に保存しても、記録は自分の分析に付く(取り違え 0。`max(id)` の前提を、この UPDATE にも使うため)", async () => {
    const s = store();
    const saved = await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.saveAnalysis(mkRecord(i + 1), { llmNote: i % 2 === 0 ? NOTE : null, llmCalls: [{ ...OK, ms: 1000 + i }] }).then((r) => ({ i, id: r.id }))),
    );
    expect(new Set(saved.map((x) => x.id)).size).toBe(10);
    for (const { i, id } of saved) {
      const row = await local.db.prepare("SELECT race_id AS raceId, llm_note AS n, llm_calls_json AS c FROM analyses WHERE id = ?").bind(id).first<{ raceId: string; n: string | null; c: string }>();
      expect(row!.raceId, `id=${id}`).toBe(`R${String(i + 1).padStart(4, "0")}`);
      expect(row!.n).toBe(i % 2 === 0 ? NOTE : null);
      expect(JSON.parse(row!.c)).toEqual([{ ...OK, ms: 1000 + i }]);
    }
  });
});

describe("保存の文: 理由か記録があるときだけ UPDATE を1文足す(理由も記録もなければ、これまでと同じ文・同じ数)", () => {
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
  const CALLS_JSON = JSON.stringify([OK]);
  const where = "WHERE id = (SELECT max(id) FROM analyses)";

  it("どちらも無いと、配分ありで 6 文・なしで 4 文のまま。llm_note・llm_calls_json の文は無い", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(1), YM, null, null)).toHaveLength(6);
    expect(f.statements.some((st) => /llm_note|llm_calls_json/.test(st.sql))).toBe(false);
    const g = fake();
    expect(buildSaveStatements(g.db, mkRecord(1, false), YM)).toHaveLength(4);
  });

  it("記録だけ: +1 文で、llm_calls_json だけを更新する(束縛値は JSON 文字列1個)。理由だけの文は変わらない(これまでと同じ SQL)", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(1), YM, null, CALLS_JSON)).toHaveLength(7);
    const update = f.statements.filter((st) => /llm_calls_json/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe(`UPDATE analyses SET llm_calls_json = ? ${where}`);
    expect(update[0]!.binds).toEqual([CALLS_JSON]);
    const g = fake();
    buildSaveStatements(g.db, mkRecord(1), YM, NOTE, null);
    expect(g.statements.filter((st) => /llm_note/.test(st.sql)).map((st) => [st.sql, st.binds])).toEqual([[`UPDATE analyses SET llm_note = ? ${where}`, [NOTE]]]);
  });

  it("両方: +1 文のまま(1文で llm_note と llm_calls_json を一緒に更新)。配分ありで 7・なしで 5。INSERT の位置は変わらず、UPDATE は馬の前", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(1), YM, NOTE, CALLS_JSON)).toHaveLength(7);
    const update = f.statements.filter((st) => /llm_note|llm_calls_json/.test(st.sql));
    expect(update).toHaveLength(1);
    expect(update[0]!.sql).toBe(`UPDATE analyses SET llm_note = ?, llm_calls_json = ? ${where}`);
    expect(update[0]!.binds).toEqual([NOTE, CALLS_JSON]);
    expect(f.statements[analysesInsertIndex(YM)]!.sql).toMatch(/^INSERT INTO analyses\b/);
    const order = f.statements.map((st) => (/llm_note|llm_calls_json/.test(st.sql) ? "update" : /INTO analysis_horses/.test(st.sql) ? "horses" : /^INSERT INTO analyses\b/.test(st.sql) ? "analyses" : "other"));
    expect(order.indexOf("update")).toBeGreaterThan(order.indexOf("analyses"));
    expect(order.indexOf("update")).toBeLessThan(order.indexOf("horses"));
    const g = fake();
    expect(buildSaveStatements(g.db, mkRecord(1, false), YM, NOTE, CALLS_JSON)).toHaveLength(5);
  });

  it("柵を超えた保存(ym = null)も、+1 文(配分ありで 5・なしで 3)", () => {
    const f = fake();
    expect(buildSaveStatements(f.db, mkRecord(1), null, null, CALLS_JSON)).toHaveLength(5);
    const g = fake();
    expect(buildSaveStatements(g.db, mkRecord(1, false), null, NOTE, CALLS_JSON)).toHaveLength(3);
  });
});

describe("読み出し: 詳細に llmCalls が載る。一覧には載せない・読まない", () => {
  it("詳細(getAnalysisDetail): 保存した記録がそのまま復元される。記録なしは null。存在しない id は undefined のまま", async () => {
    const s = store();
    const a = await s.saveAnalysis(mkRecord(1), { llmNote: null, llmCalls: [FAILED, REPLAYED] });
    const b = await s.saveAnalysis(mkRecord(2));
    expect((await s.getAnalysisDetail(a.id))!.llmCalls).toEqual([FAILED, REPLAYED]);
    expect((await s.getAnalysisDetail(b.id))!.llmCalls).toBeNull();
    expect(await s.getAnalysisDetail(999_999)).toBeUndefined();
  });

  it("詳細が R2 に無い(none)ときも、llmCalls は D1 の値で返る(詳細の状態に依らない)", async () => {
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(202610, R2_FENCE_LIMITS.classA).run();
    const s = store(() => new Date("2026-10-06T12:00:00Z"));
    const saved = await s.saveAnalysis(mkRecord(1), { llmNote: null, llmCalls: [OK] });
    const result = (await s.getAnalysisDetail(saved.id))!;
    expect(result.detail).toBe("none");
    expect(result.llmCalls).toEqual([OK]);
  });

  /**
   * Issue #198(#197 の【記録】R1): `getAnalysisDetail` が `detail: "missing"` を返す経路は、Class B の柵に達した場合と、R2 の詳細が読めない場合(無い・壊れている・get が例外)。
   * どの経路でも、`llmNote`・`llmCalls`・馬の `highlights`・`concerns` は **D1 の値のまま**返る(R2 の状態に依らない)。
   * 保存する値はすべて null・空でない値にする(null・[] にされる変異を検出するため)。`missing` であること自体を、各ケースの先頭で無条件に固定する。
   */
  const MISSING_NOW = () => new Date("2026-10-06T12:00:00Z");
  type Bucket = ConstructorParameters<typeof D1AnalysisStore>[0]["bucket"];
  const MISSING_CASES: readonly [string, (id: number) => Promise<Bucket>][] = [
    [
      "(a) Class B の柵に達した(上限ちょうど)",
      async () => {
        await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, 1, ?)").bind(202610, R2_FENCE_LIMITS.classB).run();
        return local.r2;
      },
    ],
    [
      "(b) R2 のオブジェクトが無い",
      async (id) => {
        await local.r2.delete(detailKeyOf(id));
        return local.r2;
      },
    ],
    [
      "(c) R2 のオブジェクトが壊れている(復号できない)",
      async (id) => {
        await local.r2.put(detailKeyOf(id), new Uint8Array([1, 2, 3, 4, 5]));
        return local.r2;
      },
    ],
    ["(d) R2 の get が例外", async () => spyBucket(local.r2, { failGet: true }).bucket],
  ];

  it.each(MISSING_CASES)("detail: missing の経路 %s でも、llmNote・llmCalls・馬の highlights・concerns は D1 の値のまま返る", async (_name, prepare) => {
    const base = mkRecord(1).horses[0]!;
    const record: AnalysisRecord = {
      ...mkRecord(1),
      rawResponse: "R2 にだけある応答",
      horses: [
        { ...base, umaban: 1, highlights: ["追い切り好時計"], concerns: ["距離延長"] },
        { ...base, umaban: 2, highlights: ["内枠有利", "展開向く"], concerns: [] },
      ],
    };
    const saved = await store(MISSING_NOW).saveAnalysis(record, { llmNote: NOTE, llmCalls: [FAILED, REPLAYED] });
    expect(saved.detail, "前提: R2 に詳細を保存した(その後に各経路を作る)").toBe("stored");
    const bucket = await prepare(saved.id);
    const result = (await new D1AnalysisStore({ db: local.db, bucket, now: MISSING_NOW }).getAnalysisDetail(saved.id))!;
    expect(result.detail).toBe("missing");
    expect(result.analysis.rawResponse, "前提: R2 にだけある中身(応答)は使っていない").toBeNull();
    expect(result.llmNote).toBe(NOTE);
    expect(result.llmCalls).toEqual([FAILED, REPLAYED]);
    expect(result.analysis.horses.map((h) => [h.umaban, h.highlights, h.concerns])).toEqual([
      [1, ["追い切り好時計"], ["距離延長"]],
      [2, ["内枠有利", "展開向く"], []],
    ]);
  });

  it("壊れた値(JSON でない・配列でない)が入っていても、例外にせず null(手で入れた値・旧い行)", async () => {
    const s = store();
    const saved = await s.saveAnalysis(mkRecord(1));
    for (const broken of ["[壊れ", '{"a":1}', "", "3"]) {
      await local.db.prepare("UPDATE analyses SET llm_calls_json = ? WHERE id = ?").bind(broken, saved.id).run();
      expect((await s.getAnalysisDetail(saved.id))!.llmCalls, JSON.stringify(broken)).toBeNull();
    }
  });

  it("一覧(listAnalysisSummaries)の応答に llmCalls は無く、発行する SQL は llm_calls_json を読まない(一覧は 2 文の batch のまま)", async () => {
    const s = store();
    await s.saveAnalysis(mkRecord(1), { llmNote: null, llmCalls: [OK] });
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
    const list = await new D1AnalysisStore({ db: spy, bucket: local.r2 }).listAnalysisSummaries();
    expect(list).toHaveLength(1);
    expect("llmCalls" in list[0]!).toBe(false);
    expect(batches).toEqual([2]);
    expect(prepared).toHaveLength(2);
    expect(prepared.some((sql) => /llm_calls_json/.test(sql))).toBe(false);
  });

  it("詳細の SQL は llm_calls_json を読む(詳細の1回の batch。文の数は増えない)", async () => {
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
    const saved = await store().saveAnalysis(mkRecord(1), { llmNote: null, llmCalls: [OK] });
    await new D1AnalysisStore({ db: spy, bucket: local.r2 }).getAnalysisDetail(saved.id);
    expect(batches).toEqual([3]);
    expect(prepared.filter((sql) => /llm_calls_json/.test(sql))).toHaveLength(1);
  });
});

describe("AnalysisSink(DO が使う保存先)", () => {
  it("save(record, { llmNote, llmCalls }) は記録を D1 に保存する。第2引数なし・llmCalls なしは NULL", async () => {
    const sink = createAnalysisSink(store());
    const a = await sink.save(mkRecord(1), { llmNote: null, llmCalls: [OK] });
    const b = await sink.save(mkRecord(2), { llmNote: NOTE });
    const c = await sink.save(mkRecord(3));
    expect(JSON.parse((await rawOf(a.id))!.calls!)).toEqual([OK]);
    expect((await rawOf(b.id))!.calls).toBeNull();
    expect((await rawOf(c.id))!.calls).toBeNull();
  });
});
