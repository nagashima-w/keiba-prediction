import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeDetail, detailKeyOf } from "../src/analysis-detail";
import { buildSaveStatements, D1AnalysisStore, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, type AnalysisDb, type AnalysisSummary } from "../src/analysis-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #175(#172-b): D1AnalysisStore(D1 の要約 + R2 の詳細)を、ローカル(workerd)の D1・R2 で確かめる。
 * AC-b2〜b10(#172)と、追加の検査(COVERING INDEX・一覧が2文・getStoredAllocation の undefined)。
 *
 * ★限界(本番との差): ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しない(bind 100 個は強制する)。このため文の数は、
 *   記録した値で直接 assert している(AC-b3)。**batch が他の保存と交錯しないこと**(`(SELECT max(id) FROM analyses)` の前提)は、
 *   ローカルの並行テスト(AC-b3b)で確かめるが、本番の D1 の保証ではない。浮動小数の丸め・SQLite のビルド差も本番の最初の実保存で確かめる。
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

async function count(table: string): Promise<number> {
  return (await local.db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
}

const ALL_TABLES = ["analyses", "analysis_horses", "analysis_allocation_meta", "analysis_bets", "race_results", "race_result_meta", "race_combo_payouts", "race_combo_payout_imports"];

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of ALL_TABLES) {
    result[table] = await count(table);
  }
  return result;
}

/** 最小の分析(配分あり・馬と買い目の数を指定できる)。 */
function mkRecord(i: number, nHorses: number, nBets: number | null, extra: Partial<AnalysisRecord> = {}): AnalysisRecord {
  const base: AnalysisRecord = {
    raceId: `R${String(i).padStart(4, "0")}`,
    analyzedAt: `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    kaisaiDate: "20261006",
    promptVersion: "v-test",
    horses: Array.from({ length: nHorses }, (_, k) => ({
      umaban: k + 1,
      prior: 0.5 + i / 1000 + k / 1e6,
      adjustedProb: 0.25,
      placeOddsMin: 1.5,
      ev: 1.1,
      isPositive: k % 2 === 0,
      contributions: { k, i },
      mark: null,
      reason: `根拠 ${i}-${k}`,
    })),
    ...extra,
  };
  if (nBets === null) {
    return base;
  }
  const meta = contractCases[0]!.record.allocation!.meta;
  return { ...base, allocation: { meta, bets: Array.from({ length: nBets }, (_, b) => ({ betType: "wide", comboKey: `${i}-${b}`, stake: 100 * (i + 1), odds: 5.5, ev: 1.2 })) } };
}

const store = (): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2 });

describe("AC-b4: 共有フィクスチャ(#168)の期待値と一致する", () => {
  it("前提(空振り防止): フィクスチャの先頭ケースは、3 つの大きな列(raceSnapshot・rawResponse・馬の contributions)がすべて非 null", () => {
    const rec = contractCases[0]!.record;
    expect(rec.raceSnapshot).not.toBeNull();
    expect(rec.raceSnapshot).toBeDefined();
    expect(typeof rec.rawResponse).toBe("string");
    expect(rec.horses.some((h) => h.contributions !== null && h.contributions !== undefined)).toBe(true);
    expect(contractCases).toHaveLength(3);
  });

  it.each(contractCases.map((c) => [c.name, c] as const))("詳細(R2 から復元): %s", async (_name, c) => {
    const saved = await store().saveAnalysis(c.record);
    expect(saved.detail).toBe("stored");
    const detail = await store().getAnalysisDetail(saved.id);
    expect(detail).toBeDefined();
    expect(detail!.detail).toBe("present");
    const { id, ...rest } = detail!.analysis;
    expect(id).toBe(saved.id);
    expect(rest).toStrictEqual(c.expectedAnalysis);
    expect((await store().getStoredAllocation(saved.id)) ?? null).toStrictEqual(c.expectedAllocation);
  });

  it.each(contractCases.map((c) => [c.name, c] as const))("要約: 期待値から大きな列(rawResponse・raceSnapshot・馬の contributions)を除いたものと一致する。%s", async (_name, c) => {
    const saved = await store().saveAnalysis(c.record);
    const list = await store().listAnalysisSummaries({ raceId: c.record.raceId });
    expect(list).toHaveLength(1);
    const { rawResponse: _r, raceSnapshot: _s, horses, ...expectedRest } = c.expectedAnalysis;
    const expected = {
      ...expectedRest,
      id: saved.id,
      horses: horses.map(({ contributions: _c, ...h }) => h),
      hasDetail: true,
    };
    expect(list[0]).toStrictEqual(expected);
    // 大きな列のキーそのものが無い(null で持たない)
    expect("rawResponse" in list[0]!).toBe(false);
    expect("raceSnapshot" in list[0]!).toBe(false);
    expect(list[0]!.horses.every((h) => !("contributions" in h))).toBe(true);
  });
});

describe("D1 には大きな列を置かない(方式 A)", () => {
  it("保存後の D1: raw_response・race_snapshot_json・contributions_json はすべて NULL で、detail_key は R2 のキー。R2 には詳細がある", async () => {
    const rec = contractCases[0]!.record;
    const { id } = await store().saveAnalysis(rec);
    const row = await local.db.prepare("SELECT raw_response AS r, race_snapshot_json AS s, detail_key AS k FROM analyses WHERE id = ?").bind(id).first<{ r: unknown; s: unknown; k: string }>();
    expect(row).toEqual({ r: null, s: null, k: detailKeyOf(id) });
    expect(await count("analysis_horses")).toBe(rec.horses.length);
    expect(await count("analysis_horses WHERE contributions_json IS NOT NULL")).toBe(0);
    // 前提: 馬の行は実際に入っている(上の 0 が「馬が無いから 0」でない)
    const object = await local.r2.get(detailKeyOf(id));
    expect(object).not.toBeNull();
    const decoded = decodeDetail(new Uint8Array(await object!.arrayBuffer()));
    expect(decoded?.rawResponse).toBe(rec.rawResponse);
    expect(decoded?.raceSnapshot).toStrictEqual(rec.raceSnapshot);
    expect(Object.keys(decoded!.contributions).sort()).toEqual(["1", "2"]);
  });

  it("D1 の detail_key の式(SQL)と、R2 に書くキー(TypeScript の detailKeyOf)が一致する", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await store().saveAnalysis(mkRecord(i, 2, null))).id);
    }
    const rows = (await local.db.prepare("SELECT id, detail_key AS k FROM analyses ORDER BY id").all<{ id: number; k: string }>()).results;
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.map((r) => r.k)).toEqual(ids.map(detailKeyOf));
  });
});

describe("AC-b7: R2 への書き込み(D1 が先。put はちょうど 1 回。LIST・HEAD は使わない)", () => {
  it("1回の保存で put がちょうど 1 回・get は 0 回。キーは analyses/{id}.json.gz。本文はバイト列(再試行できる)", async () => {
    const spy = spyBucket(local.r2);
    const s = new D1AnalysisStore({ db: local.db, bucket: spy.bucket });
    const { id } = await s.saveAnalysis(contractCases[0]!.record);
    expect(spy.calls.map((c) => c.op)).toEqual(["put"]);
    expect(spy.calls[0]!.key).toBe(`analyses/${id}.json.gz`);
    expect(spy.calls[0]!.body).toBeInstanceOf(Uint8Array);
  });

  it("put の時点で、D1 のコミットは済んでいる(行があり、detail_key が同じキーを指している)", async () => {
    let seen: { id: number; detail_key: string } | null = null;
    const spy = spyBucket(local.r2, {
      beforePut: async (key) => {
        seen = await local.db.prepare("SELECT id, detail_key FROM analyses WHERE detail_key = ?").bind(key).first<{ id: number; detail_key: string }>();
      },
    });
    const { id } = await new D1AnalysisStore({ db: local.db, bucket: spy.bucket }).saveAnalysis(mkRecord(1, 3, 2));
    expect(seen).toEqual({ id, detail_key: detailKeyOf(id) });
    expect(await count("analysis_horses")).toBe(3);
  });

  it("ストアは get と put だけを使う(窓口に list・head・delete を渡さなくても、保存・一覧・詳細・配分・版別がすべて動く)", async () => {
    const spy = spyBucket(local.r2); // get と put しか持たない
    const s = new D1AnalysisStore({ db: local.db, bucket: spy.bucket });
    const { id } = await s.saveAnalysis(mkRecord(1, 3, 2));
    await s.listAnalysisSummaries({});
    await s.getAnalysisDetail(id);
    await s.getStoredAllocation(id);
    await s.listAnalyzedRaceIdsByPromptVersion("v-test");
    expect(new Set(spy.calls.map((c) => c.op))).toEqual(new Set(["put", "get"]));
    // 詳細の読み出しだけが get(1 回)。一覧・配分・版別は R2 に触れない
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(1);
  });
});

describe("AC-b8: R2 が失敗しても save は throw せず、要約は残る(detail_key は NULL)", () => {
  it("put が常に失敗: 1 + 再試行 2 = 3 回試し(同じキー・同じ本文)、detail: failed。行は残り、detail_key は NULL", async () => {
    const spy = spyBucket(local.r2, { failPut: () => true });
    const s = new D1AnalysisStore({ db: local.db, bucket: spy.bucket });
    const saved = await s.saveAnalysis(mkRecord(1, 3, 2));
    expect(saved.detail).toBe("failed");
    const puts = spy.calls.filter((c) => c.op === "put");
    expect(puts).toHaveLength(3);
    expect(new Set(puts.map((p) => p.key)).size).toBe(1);
    expect(puts[0]!.key).toBe(detailKeyOf(saved.id));
    expect(Array.from(puts[1]!.body!)).toEqual(Array.from(puts[0]!.body!));
    // 要約は残る(馬・配分・買い目も)
    const row = await local.db.prepare("SELECT detail_key AS k FROM analyses WHERE id = ?").bind(saved.id).first<{ k: unknown }>();
    expect(row).toEqual({ k: null });
    expect(await count("analysis_horses")).toBe(3);
    expect(await count("analysis_bets")).toBe(2);
    const list = await s.listAnalysisSummaries({});
    expect(list).toHaveLength(1);
    expect(list[0]!.hasDetail).toBe(false);
    // R2 には何も無い
    expect(await local.r2.get(detailKeyOf(saved.id))).toBeNull();
  });

  it("1 回だけ失敗して 2 回目に成功: detail: stored・detail_key は保持・2 回の put は同じキー(冪等)", async () => {
    const spy = spyBucket(local.r2, { failPut: (n) => n === 1 });
    const s = new D1AnalysisStore({ db: local.db, bucket: spy.bucket });
    const saved = await s.saveAnalysis(mkRecord(1, 2, null));
    expect(saved.detail).toBe("stored");
    const puts = spy.calls.filter((c) => c.op === "put");
    expect(puts).toHaveLength(2);
    expect(puts[0]!.key).toBe(puts[1]!.key);
    expect((await local.db.prepare("SELECT detail_key AS k FROM analyses WHERE id = ?").bind(saved.id).first<{ k: string }>())!.k).toBe(detailKeyOf(saved.id));
    expect((await s.getAnalysisDetail(saved.id))!.detail).toBe("present");
  });

  it("2 回失敗して 3 回目に成功(再試行の上限ちょうど): stored。4 回目は無い", async () => {
    const spy = spyBucket(local.r2, { failPut: (n) => n <= 2 });
    const saved = await new D1AnalysisStore({ db: local.db, bucket: spy.bucket }).saveAnalysis(mkRecord(1, 2, null));
    expect(saved.detail).toBe("stored");
    expect(spy.calls.filter((c) => c.op === "put")).toHaveLength(3);
  });

  it("detail_key を NULL に戻す UPDATE が失敗しても throw しない(detail: failed。読み出し側が『詳細なし』として扱う)", async () => {
    const spy = spyBucket(local.r2, { failPut: () => true });
    const failingUpdate = {
      prepare(sql: string) {
        if (sql.startsWith("UPDATE analyses SET detail_key = NULL")) {
          return { bind: () => ({ run: async () => Promise.reject(new Error("D1_ERROR: injected")) }) };
        }
        return local.db.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => local.db.batch(statements),
    } as unknown as AnalysisDb;
    const s = new D1AnalysisStore({ db: failingUpdate, bucket: spy.bucket });
    const saved = await s.saveAnalysis(mkRecord(1, 2, null));
    expect(saved.detail).toBe("failed");
    // detail_key が残っていても(R2 に無いので)読み出しはクラッシュしない
    const detail = await s.getAnalysisDetail(saved.id);
    expect(detail!.detail).toBe("missing");
  });
});

describe("AC-b2: batch の原子性(途中で失敗したら、全 8 表の行数が変わらない)", () => {
  /** 買い目の主キー(analysis_id, bet_type, combo_key)が重複する分析: 最後の文(買い目)が失敗する。 */
  const duplicateBets = (): AnalysisRecord => {
    const rec = mkRecord(1, 3, 2);
    const bet = rec.allocation!.bets[0]!;
    return { ...rec, allocation: { ...rec.allocation!, bets: [bet, { ...bet }] } };
  };

  it("失敗の前後で、8 表すべての行数が同じ(0 のまま)。save は throw し、R2 には書かない", async () => {
    const before = await counts();
    expect(Object.keys(before)).toHaveLength(8);
    const spy = spyBucket(local.r2);
    await expect(new D1AnalysisStore({ db: local.db, bucket: spy.bucket }).saveAnalysis(duplicateBets())).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await counts()).toEqual(before);
    expect(spy.calls).toEqual([]);
  });

  it("対照: 同じ文を batch を使わず 1 文ずつ実行すると、孤児の行が残る(この検査は、batch でなければ失敗する)", async () => {
    const before = await counts();
    await expect(
      (async () => {
        for (const statement of buildSaveStatements(local.db, duplicateBets())) {
          await statement.run();
        }
      })(),
    ).rejects.toThrow(/UNIQUE|constraint/i);
    const after = await counts();
    expect(after["analyses"]).toBe(1);
    expect(after["analysis_horses"]).toBe(3);
    expect(after["analysis_allocation_meta"]).toBe(1);
    expect(after).not.toEqual(before);
  });
});

describe("詳細を符号化できない入力は、何も書かれない(D1 に書く前に符号化する)", () => {
  it("循環参照を含む raceSnapshot: save は throw し、8 表の行数は変わらず、R2 にも触れない", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const before = await counts();
    const spy = spyBucket(local.r2);
    await expect(new D1AnalysisStore({ db: local.db, bucket: spy.bucket }).saveAnalysis(mkRecord(1, 2, 1, { raceSnapshot: circular }))).rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect(spy.calls).toEqual([]);
    // 対照: 循環でなければ同じ入力が保存できる(上の失敗が、入力の他の部分のせいでない)
    await expect(new D1AnalysisStore({ db: local.db, bucket: spy.bucket }).saveAnalysis(mkRecord(1, 2, 1, { raceSnapshot: { ok: true } }))).resolves.toMatchObject({ detail: "stored" });
  });
});

describe("AC-b3: 発行する文の数は馬・買い目の数によらず一定で、bind 変数は 1 文あたり 100 個以下", () => {
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
  const shapes: ReadonlyArray<readonly [number, number | null]> = [
    [1, 0],
    [1, 1],
    [16, 10],
    [18, 60],
    [18, 200],
    [100, 500],
  ];

  it.each(shapes.map(([h, b]) => [h, b] as const))("馬 %i 頭・買い目 %i 件: 配分ありは 5 文(#173 のカウンタが 1 文足す余地がある)", (nHorses, nBets) => {
    const { db, statements } = fake();
    const built = buildSaveStatements(db, mkRecord(1, nHorses, nBets));
    expect(built).toHaveLength(5);
    expect(statements).toHaveLength(5);
    for (const s of statements) {
      expect(s.binds.length, s.sql.slice(0, 40)).toBeLessThanOrEqual(100);
    }
  });

  it.each([1, 16, 18, 100])("配分なしは馬 %i 頭でも 3 文", (nHorses) => {
    const { db, statements } = fake();
    expect(buildSaveStatements(db, mkRecord(1, nHorses, null))).toHaveLength(3);
    expect(statements).toHaveLength(3);
  });

  it("bind 変数の内訳(手計算): analyses 11 + detail_key の UPDATE 0 + 馬 1(JSON) + 配分メタ 23 + 買い目 1(JSON) = 36", () => {
    const { db, statements } = fake();
    buildSaveStatements(db, mkRecord(1, 16, 10));
    expect(statements.map((s) => s.binds.length)).toEqual([11, 0, 1, 23, 1]);
    expect(statements.reduce((n, s) => n + s.binds.length, 0)).toBe(36);
  });

  it("馬・買い目の行は JSON の 1 つの文字列で渡す(馬の数だけ bind が増えない)", () => {
    const { db, statements } = fake();
    buildSaveStatements(db, mkRecord(1, 18, 60));
    const horses = JSON.parse(statements[2]!.binds[0] as string) as unknown[][];
    const bets = JSON.parse(statements[4]!.binds[0] as string) as unknown[][];
    expect(horses).toHaveLength(18);
    expect(bets).toHaveLength(60);
    // 大きな列(contributions)は D1 に渡さない: 馬の行の contributions の位置は null
    expect(horses.every((row) => row[6] === null)).toBe(true);
  });

  it("D1 に渡す analyses の束縛値に、大きな列(raw_response・race_snapshot_json)は入らない", () => {
    const { db, statements } = fake();
    buildSaveStatements(db, contractCases[0]!.record);
    const binds = statements[0]!.binds;
    expect(binds).toHaveLength(11);
    // 前提: 入力は 3 つの大きな列を持つ
    expect(contractCases[0]!.record.rawResponse).toBeTruthy();
    expect(binds[7], "raw_response").toBeNull();
    expect(binds[8], "race_snapshot_json").toBeNull();
  });

  it("対照: 馬ごとに 1 文ずつ発行する実装なら、文の数は馬の数で増える(この検査が増加を見分けられる)", () => {
    const perRow = (nHorses: number): number => {
      const { db, statements } = fake();
      for (let k = 0; k < nHorses; k += 1) {
        db.prepare("INSERT INTO analysis_horses VALUES (?)").bind(k);
      }
      return statements.length;
    };
    expect(perRow(18)).toBeGreaterThan(perRow(1));
  });
});

describe("AC-b3b: 同時に保存しても、子の行が取り違えられない", () => {
  const N = 20;
  const shapeOf = (i: number): { horses: number; bets: number } => ({ horses: 1 + (i % 7), bets: 2 + (i % 5) });

  async function mismatches(): Promise<{ rows: number; wrong: number }> {
    const rows = (
      await local.db
        .prepare(
          `SELECT a.id, a.race_id AS raceId,
                  (SELECT count(*) FROM analysis_horses h WHERE h.analysis_id = a.id) AS nh,
                  (SELECT count(*) FROM analysis_bets b WHERE b.analysis_id = a.id) AS nb,
                  (SELECT min(stake) FROM analysis_bets b WHERE b.analysis_id = a.id) AS stake,
                  (SELECT min(prior) FROM analysis_horses h WHERE h.analysis_id = a.id) AS prior,
                  (SELECT count(*) FROM analysis_allocation_meta m WHERE m.analysis_id = a.id) AS meta
             FROM analyses a ORDER BY a.id`,
        )
        .all<{ id: number; raceId: string; nh: number; nb: number; stake: number; prior: number; meta: number }>()
    ).results;
    let wrong = 0;
    for (const r of rows) {
      const i = Number(r.raceId.slice(1));
      const shape = shapeOf(i);
      if (r.nh !== shape.horses || r.nb !== shape.bets || r.stake !== 100 * (i + 1) || Math.floor(r.prior * 1000) !== 500 + i || r.meta !== 1) {
        wrong += 1;
      }
    }
    return { rows: rows.length, wrong };
  }

  it(`${N} 件の保存を Promise.all で同時に走らせても、馬・買い目・配分メタの行は自分の分析に付く(取り違え 0)`, async () => {
    const results = await Promise.all(Array.from({ length: N }, (_, i) => store().saveAnalysis(mkRecord(i, shapeOf(i).horses, shapeOf(i).bets))));
    expect(new Set(results.map((r) => r.id)).size).toBe(N);
    const { rows, wrong } = await mismatches();
    expect(rows).toBe(N);
    expect(wrong).toBe(0);
    expect(results.every((r) => r.detail === "stored")).toBe(true);
  }, 120_000);

  it("対照: 同じ文を batch を使わず 1 文ずつ並行に実行すると、取り違え(または失敗)が起きる(この検査は、batch でなければ失敗する)", async () => {
    let thrown = 0;
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        try {
          for (const statement of buildSaveStatements(local.db, mkRecord(i, shapeOf(i).horses, shapeOf(i).bets))) {
            await statement.run();
          }
        } catch {
          thrown += 1;
        }
      }),
    );
    const { wrong } = await mismatches();
    expect(thrown + wrong, "逐次の並行実行では、失敗か取り違えが起きる").toBeGreaterThan(0);
  }, 120_000);
});

describe("AC-b5: 有限の double はビット一致で戻る。Infinity・NaN・-0 は差分(文書化して固定。【記録】)", () => {
  /** 固定の種の乱数(mulberry32)。 */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("確率型・広い指数・特殊な有限値の合計 N=3,010 件の double が、馬・買い目・R2 の往復でビット一致する", async () => {
    const r = rng(20261006);
    const values: number[] = [];
    for (let i = 0; i < 1000; i += 1) values.push(r());
    for (let i = 0; i < 1000; i += 1) values.push(r() * Math.pow(10, Math.floor(r() * 40) - 20));
    for (let i = 0; i < 1000; i += 1) {
      const view = new DataView(new ArrayBuffer(8));
      view.setUint32(0, Math.floor(r() * 0x7fefffff));
      view.setUint32(4, Math.floor(r() * 4294967296));
      const x = view.getFloat64(0);
      values.push(Number.isFinite(x) ? x : 0.5);
    }
    values.push(0.1 + 0.2, 1 / 3, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 9007199254740993, 1e21, 123456789.123456789, 1e-7, 0.30000000000000004);
    expect(values).toHaveLength(3010);
    // 馬の列(prior・adjustedProb・placeOddsMin・ev)と買い目の列(odds・ev)と contributions(R2)に、同じ値を配る
    const horses = values.slice(0, 1500).map((v, k) => ({ umaban: k + 1, prior: v, adjustedProb: v, placeOddsMin: values[k + 1500 > 3009 ? 0 : k + 1500]!, ev: v, isPositive: false, contributions: { v }, mark: null }));
    const bets = values.slice(1500, 3000).map((v, k) => ({ betType: "wide", comboKey: `k${k}`, stake: 100, odds: v, ev: values[(k + 7) % 3010]! }));
    const rec: AnalysisRecord = { ...mkRecord(1, 1, 1), horses, allocation: { meta: contractCases[0]!.record.allocation!.meta, bets } };
    const saved = await store().saveAnalysis(rec);
    expect(saved.detail).toBe("stored");
    const detail = (await store().getAnalysisDetail(saved.id))!;
    let diffs = 0;
    detail.analysis.horses.forEach((h, k) => {
      const src = horses[k]!;
      if (!Object.is(h.prior, src.prior) || !Object.is(h.adjustedProb, src.adjustedProb) || !Object.is(h.placeOddsMin, src.placeOddsMin) || !Object.is(h.ev, src.ev)) diffs += 1;
      if (!Object.is((h.contributions as { v: number }).v, src.contributions.v)) diffs += 1;
    });
    const allocation = (await store().getStoredAllocation(saved.id))!;
    expect(allocation.bets).toHaveLength(1500);
    const byKey = new Map(allocation.bets.map((b) => [b.comboKey, b]));
    for (const src of bets) {
      const b = byKey.get(src.comboKey)!;
      if (!Object.is(b.odds, src.odds) || !Object.is(b.ev, src.ev)) diffs += 1;
    }
    expect(detail.analysis.horses).toHaveLength(1500);
    expect(diffs, "ビット不一致の件数").toBe(0);
  }, 120_000);

  it("【記録】Infinity・NaN は NULL(null)、-0 は 0 になる(nullable な列。D1 の bind と同じ挙動)。R2 の contributions も JSON のため同じ", async () => {
    const mk = (umaban: number, v: number) => ({ umaban, prior: 0.5, adjustedProb: 0.5, placeOddsMin: v, ev: v, isPositive: false, contributions: { v }, mark: null });
    const rec: AnalysisRecord = { ...mkRecord(1, 1, null), horses: [mk(1, Infinity), mk(2, -Infinity), mk(3, NaN), mk(4, -0), mk(5, 0)] };
    const saved = await store().saveAnalysis(rec);
    const horses = (await store().getAnalysisDetail(saved.id))!.analysis.horses;
    expect(horses.map((h) => h.placeOddsMin)).toEqual([null, null, null, 0, 0]);
    expect(Object.is(horses[3]!.placeOddsMin, 0)).toBe(true);
    expect(Object.is(horses[3]!.placeOddsMin, -0)).toBe(false);
    expect(horses.map((h) => (h.contributions as { v: number | null }).v)).toEqual([null, null, null, 0, 0]);
  });

  it("【記録】NOT NULL の列(prior)に NaN を渡すと NULL になり、制約違反で保存全体が失敗する(throw。孤児の行は残らない)", async () => {
    const rec: AnalysisRecord = { ...mkRecord(1, 2, 1), horses: [{ ...mkRecord(1, 1, null).horses[0]!, prior: NaN }, mkRecord(1, 2, null).horses[1]!] };
    await expect(store().saveAnalysis(rec)).rejects.toThrow(/NOT NULL|constraint/i);
    expect((await counts())["analyses"]).toBe(0);
  });
});

describe("AC-b6: json_each を通しても、文字列の内容が壊れない", () => {
  const strings = [
    "日本語の根拠 ◎ 〇 ▲ △ ☆ 注",
    '引用"符"と\\バックスラッシュ',
    "改行\nと\tタブと\r\nCRLF",
    "絵文字 😀 🐎 𠮷",
    "NUL\u0000の後ろ",
    "  ",
    '{"a":[1,2]}',
    "",
    " ",
    "0",
    "null",
    "true",
    "1e5",
    "'; DROP TABLE analyses; --",
    "制御\u0001\u001f\u007f",
    "x".repeat(20000),
    "﻿BOM",
    "é 結合文字",
  ];

  it(`馬の reason・買い目の combo_key の ${strings.length} 通りの文字列が、そのまま戻る(空文字は空文字、"null" は文字列のまま)`, async () => {
    const rec: AnalysisRecord = {
      ...mkRecord(1, strings.length, null),
      horses: strings.map((s, k) => ({ umaban: k + 1, prior: 0.5, adjustedProb: 0.5, placeOddsMin: null, ev: null, isPositive: false, contributions: null, mark: null, reason: s })),
      allocation: { meta: contractCases[0]!.record.allocation!.meta, bets: strings.map((s, k) => ({ betType: "wide", comboKey: `${k}:${s}`, stake: 100, odds: null, ev: null })) },
    };
    const saved = await store().saveAnalysis(rec);
    const horses = (await store().getAnalysisDetail(saved.id))!.analysis.horses;
    expect(horses.map((h) => h.reason)).toEqual(strings);
    const bets = (await store().getStoredAllocation(saved.id))!.bets;
    expect(bets.map((b) => b.comboKey).sort()).toEqual(strings.map((s, k) => `${k}:${s}`).sort());
    // 前提: 文字列の種類が実際に多い(退化していない)
    expect(new Set(strings).size).toBe(strings.length);
  });

  it("【記録】孤立サロゲートは元に戻らない(json_each 経由では U+FFFD に置き換わる。D1 の bind でも別の形で壊れる。LLM の応答は正しい UTF-8 のため、実害は見込まない)", async () => {
    const lone = "孤立サロゲート\ud800後";
    const rec: AnalysisRecord = { ...mkRecord(1, 1, null), horses: [{ ...mkRecord(1, 1, null).horses[0]!, reason: lone }] };
    const saved = await store().saveAnalysis(rec);
    const back = (await store().getAnalysisDetail(saved.id))!.analysis.horses[0]!.reason!;
    expect(back).not.toBe(lone);
    expect(back).toContain("�");
    expect(back.startsWith("孤立サロゲート")).toBe(true);
    expect(back.endsWith("後")).toBe(true);
  });
});

describe("AC-b9: R2 に詳細が無くても、読み出しでクラッシュしない(detail の状態を返す)", () => {
  it("detail_key があり R2 にオブジェクトが無い: detail: missing。大きな列は null・馬の contributions も null・要約の項目は残る", async () => {
    const saved = await store().saveAnalysis(contractCases[0]!.record);
    await local.r2.delete(detailKeyOf(saved.id));
    const detail = (await store().getAnalysisDetail(saved.id))!;
    expect(detail.detail).toBe("missing");
    expect(detail.analysis.rawResponse).toBeNull();
    expect(detail.analysis.raceSnapshot).toBeNull();
    expect(detail.analysis.horses.every((h) => h.contributions === null)).toBe(true);
    expect(detail.analysis.horses).toHaveLength(3);
    expect(detail.analysis.raceId).toBe(contractCases[0]!.record.raceId);
    expect(detail.analysis.model).toBe("claude-test");
    // 配分は D1 だけで読める
    expect((await store().getStoredAllocation(saved.id))!.route).toBe("mixed");
  });

  it.each([
    ["gzip でない中身", new TextEncoder().encode("not gzip at all")],
    ["空のバイト列", new Uint8Array(0)],
  ])("R2 の中身が壊れている(%s): 例外を投げず detail: missing", async (_name, bytes) => {
    const saved = await store().saveAnalysis(mkRecord(1, 2, null));
    await local.r2.put(detailKeyOf(saved.id), bytes);
    const detail = (await store().getAnalysisDetail(saved.id))!;
    expect(detail.detail).toBe("missing");
    expect(detail.analysis.rawResponse).toBeNull();
  });

  it("R2 の中身が別のレースのもの(raceId が D1 の行と違う): detail: missing(キーの取り違えを、別の分析の詳細として出さない)", async () => {
    const a = await store().saveAnalysis(mkRecord(1, 2, null, { rawResponse: "A の応答" }));
    const b = await store().saveAnalysis(mkRecord(2, 2, null, { rawResponse: "B の応答" }));
    // a のキーに b の詳細を置く
    const bObject = await local.r2.get(detailKeyOf(b.id));
    await local.r2.put(detailKeyOf(a.id), new Uint8Array(await bObject!.arrayBuffer()));
    const detail = (await store().getAnalysisDetail(a.id))!;
    expect(detail.detail).toBe("missing");
    expect(detail.analysis.rawResponse).toBeNull();
    // 対照: 正しい b は present で、b の応答が出る
    const ok = (await store().getAnalysisDetail(b.id))!;
    expect(ok.detail).toBe("present");
    expect(ok.analysis.rawResponse).toBe("B の応答");
  });

  it("R2 の get が失敗(例外): detail: missing(例外を外へ投げない)", async () => {
    const saved = await store().saveAnalysis(mkRecord(1, 2, null));
    const spy = spyBucket(local.r2, { failGet: true });
    const detail = await new D1AnalysisStore({ db: local.db, bucket: spy.bucket }).getAnalysisDetail(saved.id);
    expect(detail!.detail).toBe("missing");
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(1);
  });

  it("detail_key が NULL(R2 に書いていない): detail: none で、R2 の get は 0 回", async () => {
    const failing = spyBucket(local.r2, { failPut: () => true });
    const saved = await new D1AnalysisStore({ db: local.db, bucket: failing.bucket }).saveAnalysis(mkRecord(1, 2, null));
    expect(saved.detail).toBe("failed");
    const reading = spyBucket(local.r2);
    const detail = await new D1AnalysisStore({ db: local.db, bucket: reading.bucket }).getAnalysisDetail(saved.id);
    expect(detail!.detail).toBe("none");
    expect(reading.calls).toEqual([]);
    expect(detail!.analysis.horses).toHaveLength(2);
  });

  it("存在しない分析 id: undefined(R2 にも触れない)", async () => {
    const reading = spyBucket(local.r2);
    expect(await new D1AnalysisStore({ db: local.db, bucket: reading.bucket }).getAnalysisDetail(987654)).toBeUndefined();
    expect(reading.calls).toEqual([]);
  });
});

describe("getStoredAllocation(配分)", () => {
  it("配分を持たない分析(メタ行なし)は undefined。存在しない id も undefined。買い目 0 件の配分は、bets が空の配分", async () => {
    const without = await store().saveAnalysis(mkRecord(1, 2, null));
    expect(await store().getStoredAllocation(without.id)).toBeUndefined();
    expect(await store().getStoredAllocation(987654)).toBeUndefined();
    const empty = await store().saveAnalysis(mkRecord(2, 2, 0));
    const allocation = await store().getStoredAllocation(empty.id);
    expect(allocation).toBeDefined();
    expect(allocation!.bets).toEqual([]);
    // 前提: 配分ありの分析では、メタ行が実際に読める(undefined が「常に undefined の実装」でない)
    const full = await store().saveAnalysis(mkRecord(3, 2, 3));
    expect((await store().getStoredAllocation(full.id))!.bets).toHaveLength(3);
  });

  it("買い目は (bet_type, combo_key) の昇順で返る(exe と同じ並び)", async () => {
    const rec = mkRecord(1, 1, null);
    const meta = contractCases[0]!.record.allocation!.meta;
    const bets = [
      { betType: "wide", comboKey: "02", stake: 100, odds: 1, ev: 1 },
      { betType: "place", comboKey: "09", stake: 100, odds: 1, ev: 1 },
      { betType: "wide", comboKey: "01", stake: 100, odds: 1, ev: 1 },
    ];
    const saved = await store().saveAnalysis({ ...rec, allocation: { meta, bets } });
    expect((await store().getStoredAllocation(saved.id))!.bets.map((b) => `${b.betType}:${b.comboKey}`)).toEqual(["place:09", "wide:01", "wide:02"]);
  });
});

describe("listAnalysisSummaries(一覧。D1 だけ。問い合わせは 2 文で、N+1 にしない)", () => {
  async function saveMany(n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push((await store().saveAnalysis(mkRecord(i, 3, 1, { kaisaiDate: i % 2 === 0 ? "20261006" : "20261007", raceId: `RACE${String(i % 5).padStart(4, "0")}` }))).id);
    }
    return ids;
  }

  it("定数: limit の既定は 50・上限は 200", () => {
    expect(LIST_DEFAULT_LIMIT).toBe(50);
    expect(LIST_MAX_LIMIT).toBe(200);
  });

  it("文の数は 2 で、分析の件数(0・1・60)によらない。R2 には触れない。D1 の発行は batch 1 回だけ", async () => {
    for (const n of [0, 1, 60]) {
      await local.reset();
      await saveMany(n);
      const db = spyDb(local.db);
      const bucket = spyBucket(local.r2);
      const list = await new D1AnalysisStore({ db: db.db, bucket: bucket.bucket }).listAnalysisSummaries({ limit: 200 });
      expect(list, `n=${n}`).toHaveLength(n);
      expect(db.batches, `n=${n}`).toEqual([2]);
      expect(db.prepared, `n=${n}`).toHaveLength(2);
      expect(bucket.calls).toEqual([]);
    }
  }, 120_000);

  it("大きな列を読まない: 発行した SQL に raw_response・race_snapshot_json は現れず、contributions_json は NULL AS の形だけ", async () => {
    const db = spyDb(local.db);
    await new D1AnalysisStore({ db: db.db, bucket: spyBucket(local.r2).bucket }).listAnalysisSummaries({ raceId: "x" });
    for (const sql of db.prepared) {
      expect(sql).not.toMatch(/raw_response/);
      expect(sql).not.toMatch(/race_snapshot_json/);
      expect(sql.replace(/NULL AS contributions_json/g, "")).not.toMatch(/contributions_json/);
    }
    // 前提: 検査対象の SQL が実際に取れている(空配列だと上の for が何も確かめない)
    expect(db.prepared).toHaveLength(2);
    expect(db.prepared[0]).toMatch(/FROM analyses/);
    expect(db.prepared[1]).toMatch(/FROM analysis_horses/);
  });

  it("新しい順(id の降順)に limit 件。既定は 50 件・上限指定の 200 で全件・小さい limit はその件数の最新", async () => {
    const ids = await saveMany(60);
    const byDefault = await store().listAnalysisSummaries({});
    expect(byDefault).toHaveLength(50);
    expect(byDefault.map((s) => s.id)).toEqual([...ids].reverse().slice(0, 50));
    expect(await store().listAnalysisSummaries({ limit: 200 })).toHaveLength(60);
    expect((await store().listAnalysisSummaries({ limit: 7 })).map((s) => s.id)).toEqual([...ids].reverse().slice(0, 7));
    expect(await store().listAnalysisSummaries()).toHaveLength(50);
  }, 120_000);

  it("馬の取得も limit で絞られる(60 件・180 頭のうち limit=5 なら、馬の文が読む行は 15 頭ぶん程度。全件を読まない)", async () => {
    await saveMany(60);
    const db = spyDb(local.db);
    await new D1AnalysisStore({ db: db.db, bucket: spyBucket(local.r2).bucket }).listAnalysisSummaries({ limit: 5 });
    const horsesSql = db.prepared[1]!;
    const meta = (await local.db.prepare(horsesSql).bind(5).all()).meta;
    // 前提: 全件を読む文なら 180 行以上(analysis_horses は 60 × 3 = 180 行)になる。5 件に絞れていれば、馬 15 行 + 分析の副問い合わせ数行
    expect(await count("analysis_horses")).toBe(180);
    expect(meta.rows_read).toBeLessThan(60);
    expect(meta.rows_read).toBeGreaterThanOrEqual(15);
  }, 120_000);

  it("limit が範囲外(0・201・小数・NaN・負)は RangeError(黙って丸めない)", async () => {
    for (const limit of [0, 201, 1.5, Number.NaN, -3]) {
      await expect(store().listAnalysisSummaries({ limit }), `limit=${limit}`).rejects.toThrow(RangeError);
    }
    await expect(store().listAnalysisSummaries({ limit: 200 })).resolves.toEqual([]);
    await expect(store().listAnalysisSummaries({ limit: 1 })).resolves.toEqual([]);
  });

  it("raceId・kaisaiDate で絞り込める(両方なら AND)。馬は、その分析のものだけが付く", async () => {
    await saveMany(10);
    const byRace = await store().listAnalysisSummaries({ raceId: "RACE0001" });
    expect(byRace.map((s) => s.raceId)).toEqual(["RACE0001", "RACE0001"]);
    const byDate = await store().listAnalysisSummaries({ kaisaiDate: "20261007" });
    expect(byDate).toHaveLength(5);
    expect(byDate.every((s) => s.kaisaiDate === "20261007")).toBe(true);
    // RACE0001 は i=1(奇数 → 20261007)と i=6(偶数 → 20261006)。両方を指定すると AND で 1 件ずつ
    const both = await store().listAnalysisSummaries({ raceId: "RACE0001", kaisaiDate: "20261007" });
    expect(both.map((s) => [s.raceId, s.kaisaiDate])).toEqual([["RACE0001", "20261007"]]);
    const other = await store().listAnalysisSummaries({ raceId: "RACE0001", kaisaiDate: "20261006" });
    expect(other.map((s) => [s.raceId, s.kaisaiDate])).toEqual([["RACE0001", "20261006"]]);
    expect(both[0]!.id).not.toBe(other[0]!.id);
    expect((await store().listAnalysisSummaries({ raceId: "RACE0001", kaisaiDate: "20260101" }))).toEqual([]);
    expect(await store().listAnalysisSummaries({ raceId: "NOPE" })).toEqual([]);
    // 馬の取り違えが無い: 各要約の馬は 3 頭で、reason が自分の分析のもの
    const all = await store().listAnalysisSummaries({ limit: 200 });
    expect(all).toHaveLength(10);
    for (const s of all as AnalysisSummary[]) {
      const i = Number(s.analyzedAt.slice(17, 19)); // mkRecord は analyzedAt の秒に i を入れる
      expect(s.horses).toHaveLength(3);
      expect(s.horses.map((h) => h.reason)).toEqual([`根拠 ${i}-0`, `根拠 ${i}-1`, `根拠 ${i}-2`]);
    }
    const sample = all[0]!;
    expect(sample.horses.map((h) => h.umaban)).toEqual([1, 2, 3]);
  }, 120_000);

  it("馬の並びは馬番昇順(複数の分析が混ざっても、分析ごとに昇順)", async () => {
    await store().saveAnalysis({ ...mkRecord(1, 3, null), horses: [3, 1, 2].map((u) => ({ ...mkRecord(1, 1, null).horses[0]!, umaban: u })) });
    await store().saveAnalysis({ ...mkRecord(2, 3, null), horses: [2, 3, 1].map((u) => ({ ...mkRecord(2, 1, null).horses[0]!, umaban: u })) });
    const list = await store().listAnalysisSummaries({});
    expect(list.map((s) => s.horses.map((h) => h.umaban))).toEqual([[1, 2, 3], [1, 2, 3]]);
  });
});

describe("listAnalyzedRaceIdsByPromptVersion(版別の分析済みレース)", () => {
  it("その版のレース ID を昇順・重複なしで返す。版が NULL の分析は含まない", async () => {
    await store().saveAnalysis(mkRecord(3, 1, null, { raceId: "RACE0003", promptVersion: "vA" }));
    await store().saveAnalysis(mkRecord(1, 1, null, { raceId: "RACE0001", promptVersion: "vA" }));
    await store().saveAnalysis(mkRecord(1, 1, null, { raceId: "RACE0001", promptVersion: "vA" }));
    await store().saveAnalysis(mkRecord(2, 1, null, { raceId: "RACE0002", promptVersion: "vB" }));
    await store().saveAnalysis(mkRecord(4, 1, null, { raceId: "RACE0004", promptVersion: null }));
    expect(await store().listAnalyzedRaceIdsByPromptVersion("vA")).toEqual(["RACE0001", "RACE0003"]);
    expect(await store().listAnalyzedRaceIdsByPromptVersion("vB")).toEqual(["RACE0002"]);
    expect(await store().listAnalyzedRaceIdsByPromptVersion("none")).toEqual([]);
  });

  /**
   * ストアが実際に発行する文(spy で取得)の実行計画。**毎回文字列を変える**(同じ文字列だと、索引を落とした後も古い計画が返る。#171 の実測)。
   */
  let planCounter = 0;
  async function plan(sql: string): Promise<string[]> {
    planCounter += 1;
    return (await local.db.prepare(`EXPLAIN QUERY PLAN ${sql} /* b-plan-${planCounter} */`).bind("x").all<{ detail: string }>()).results.map((r) => r.detail);
  }

  it("ストアが発行する文は COVERING INDEX(idx_analyses_prompt_version_race)を使い、一時ソートも表のスキャンも要しない。索引を落とすと SCAN になる(対照)", async () => {
    const db = spyDb(local.db);
    await new D1AnalysisStore({ db: db.db, bucket: spyBucket(local.r2).bucket }).listAnalyzedRaceIdsByPromptVersion("v");
    expect(db.prepared).toHaveLength(1);
    const sql = db.prepared[0]!;
    const details = await plan(sql);
    expect(details.some((d) => /^SEARCH analyses USING COVERING INDEX idx_analyses_prompt_version_race \(prompt_version=\?\)/.test(d))).toBe(true);
    expect(details.some((d) => d.startsWith("SCAN"))).toBe(false);
    expect(details.some((d) => /TEMP B-TREE/.test(d))).toBe(false);
    // 対照
    await local.db.prepare("DROP INDEX idx_analyses_prompt_version_race").run();
    try {
      const without = await plan(sql);
      expect(without.some((d) => d.startsWith("SCAN"))).toBe(true);
      expect(without.some((d) => d.includes("idx_analyses_prompt_version_race"))).toBe(false);
    } finally {
      await local.db.prepare("CREATE INDEX idx_analyses_prompt_version_race ON analyses (prompt_version, race_id)").run();
    }
  });

  it("一覧の絞り込み(raceId・kaisaiDate)も索引を使い、表のフルスキャンをしない", async () => {
    for (const filter of [{ raceId: "x" }, { kaisaiDate: "x" }]) {
      const db = spyDb(local.db);
      await new D1AnalysisStore({ db: db.db, bucket: spyBucket(local.r2).bucket }).listAnalysisSummaries(filter);
      const analysesSql = db.prepared[0]!;
      planCounter += 1;
      const binds = Object.keys(filter).length + 1; // 絞り込みの値 + limit
      const details = (
        await local.db
          .prepare(`EXPLAIN QUERY PLAN ${analysesSql} /* list-plan-${planCounter} */`)
          .bind(...Array.from({ length: binds }, (_, k) => (k === binds - 1 ? 50 : "x")))
          .all<{ detail: string }>()
      ).results.map((r) => r.detail);
      expect(details.some((d) => /^SEARCH analyses USING (COVERING )?INDEX idx_analyses_(race|kaisai_date)/.test(d)), JSON.stringify(filter) + " " + details.join(" / ")).toBe(true);
      expect(details.some((d) => /^SCAN analyses/.test(d))).toBe(false);
    }
  });
});
