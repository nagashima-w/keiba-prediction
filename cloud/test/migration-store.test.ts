import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeDetail, detailKeyOf } from "../src/analysis-detail";
import { buildSaveStatements, D1AnalysisStore } from "../src/analysis-repository";
import { toAnalysisImport, toResultImport } from "../src/migration-convert";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { INSERT_ANALYSIS_HORSE_SQL, INSERT_ANALYSIS_SQL, INSERT_ALLOCATION_BET_SQL, INSERT_COMBO_PAYOUT_SQL, MARK_COMBO_IMPORTED_SQL, UPSERT_RACE_RESULT_SQL } from "../../packages/core/src/ev/analysis-store-codec.js";
import { MIGRATION_TABLES } from "../../packages/core/src/ev/cloud-migration-format";
import { D1ResultStore, MIGRATED_COMBOS_SQL, MIGRATED_MARKERS_SQL, MIGRATED_RESULTS_SQL } from "../src/result-repository";
import { contractCases } from "./fixtures-contract";
import { GOLDEN_ANALYSES, GOLDEN_RESULTS } from "./migration-fixture";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #216(#167-B1): 移行の分析・結果の保存(D1 + R2)を、ローカル(workerd)の D1・R2 で確かめる。
 * 分析は既存の保存経路(buildSaveStatements の batch + R2 の put)を通し、web で分析したものと同じ形になること、元の値が保たれること、
 * 同じ分析を2回取り込めないこと(一意の索引)、R2 の操作回数の柵に達したら**要約だけの保存にせず**止めることを固定する。
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

const store = (bucket: R2Bucket = local.r2): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: bucket as never, now: () => new Date("2026-10-09T00:00:00Z") });
const imports = GOLDEN_ANALYSES.map(toAnalysisImport);

async function one<T>(sql: string, ...binds: unknown[]): Promise<T> {
  return (await local.db.prepare(sql).bind(...binds).first<T>())!;
}

describe("列の並びのドリフト防止: 移行の SQL・形式の定義と、codec(exe と共有)の INSERT 文の列が一致する", () => {
  const columnsOf = (sql: string): string[] => /\(([^)]*)\)\s*(?:SELECT|VALUES)/.exec(sql)![1]!.split(",").map((c) => c.trim());
  it.each([
    ["race_results", UPSERT_RACE_RESULT_SQL, MIGRATED_RESULTS_SQL],
    ["race_combo_payouts", INSERT_COMBO_PAYOUT_SQL, MIGRATED_COMBOS_SQL],
    ["race_combo_payout_imports", MARK_COMBO_IMPORTED_SQL, MIGRATED_MARKERS_SQL],
  ] as const)("%s: 移行の文の列 = 形式の定義の列 = codec の文の列", (table, codecSql, migratedSql) => {
    const spec = MIGRATION_TABLES[table].columns.map((c) => c.name);
    expect(columnsOf(codecSql)).toEqual(spec);
    expect(columnsOf(migratedSql)).toEqual(spec);
  });

  it.each([
    ["analyses", INSERT_ANALYSIS_SQL, 1],
    ["analysis_horses", INSERT_ANALYSIS_HORSE_SQL, 0],
    ["analysis_bets", INSERT_ALLOCATION_BET_SQL, 0],
  ] as const)("%s: 形式の定義の列(%s の id を除く)が codec の INSERT の列と一致する(分析の本体は id を採番に任せるので、先頭の id だけ除く)", (table, codecSql, skipSpec) => {
    const spec = MIGRATION_TABLES[table].columns.map((c) => c.name).slice(skipSpec);
    expect(columnsOf(codecSql)).toEqual(spec);
  });
});

describe("buildSaveStatements: 移行の追加指定", () => {
  const imp = imports[1]!;
  it("exe の分析 id の UPDATE が detail_key の UPDATE の直後に1文足される(配分あり: 6 → 7 文)。指定なしは従来どおり", () => {
    const plain = buildSaveStatements(local.db, imp.record, 202610);
    const migrated = buildSaveStatements(local.db, imp.record, 202610, null, null, { exeAnalysisId: 77, metaParams: imp.metaParams });
    expect(plain).toHaveLength(6);
    expect(migrated).toHaveLength(7);
  });
});

describe("saveMigratedAnalysis: 保存", () => {
  it("分析2(LLM あり): D1 の要約・exe の id・R2 の詳細が入り、分析日時などの元の値が保たれる(now で上書きされない)", async () => {
    const out = await store().saveMigratedAnalysis(imports[1]!);
    expect(out.kind).toBe("saved");
    if (out.kind !== "saved") throw new Error("unreachable");
    expect(out.detail).toBe("stored");
    const row = await one<Record<string, unknown>>("SELECT * FROM analyses WHERE id = ?", out.id);
    expect(row).toMatchObject({
      exe_analysis_id: GOLDEN_ANALYSES[1]!.analysis["id"],
      race_id: "202603020211",
      analyzed_at: "2026-03-02T02:00:00.000Z",
      kaisai_date: "20260302",
      prompt_version: "v8",
      model: "claude-sonnet-4-5",
      additional_instruction: "芝の重馬場を重視\n二行目",
      history_cutoff_date: "20260301",
      prompt_lookahead_guarded: 1,
      ev_estimated: 1,
      detail_key: detailKeyOf(out.id),
      raw_response: null,
      race_snapshot_json: null,
      llm_note: null,
      llm_calls_json: null,
    });
    // R2 の詳細(web の分析と同じ形)
    const object = await local.r2.get(detailKeyOf(out.id));
    const detail = decodeDetail(new Uint8Array(await object!.arrayBuffer()));
    expect(detail?.raceId).toBe("202603020211");
    expect(detail?.rawResponse).toBe(GOLDEN_ANALYSES[1]!.analysis["raw_response"]);
    expect(detail?.raceSnapshot).toEqual(imports[1]!.record.raceSnapshot);
    expect(Object.keys(detail!.contributions)).toEqual(["1"]);
  });

  it("5件すべて: getAnalysisDetail・getStoredAllocation で読み戻すと、exe の行の値と一致する(往復で落ちる列がない)", async () => {
    for (let i = 0; i < imports.length; i += 1) {
      const out = await store().saveMigratedAnalysis(imports[i]!);
      if (out.kind !== "saved") throw new Error("unreachable");
      const line = GOLDEN_ANALYSES[i]!;
      const got = await store().getAnalysisDetail(out.id);
      expect(got?.detail, `分析 ${i + 1}`).toBe("present");
      const a = got!.analysis;
      expect(a.analyzedAt).toBe(line.analysis["analyzed_at"]);
      expect(a.kaisaiDate).toBe(line.analysis["kaisai_date"]);
      expect(a.promptVersion).toBe(line.analysis["prompt_version"]);
      expect(a.model).toBe(line.analysis["model"]);
      expect(a.additionalInstruction).toBe(line.analysis["additional_instruction"]);
      expect(a.historyCutoffDate).toBe(line.analysis["history_cutoff_date"]);
      expect(a.rawResponse).toBe(line.analysis["raw_response"]);
      expect(a.raceSnapshot).toEqual(line.analysis["race_snapshot_json"] === null ? null : JSON.parse(line.analysis["race_snapshot_json"] as string));
      expect(a.promptLookaheadGuarded).toBe(line.analysis["prompt_lookahead_guarded"] === null ? null : line.analysis["prompt_lookahead_guarded"] === 1);
      expect(a.horses).toHaveLength(line.horses.length);
      line.horses.forEach((h, k) => {
        const g = a.horses[k]!;
        expect(g).toMatchObject({ umaban: h["umaban"], prior: h["prior"], adjustedProb: h["adjusted_prob"], placeOddsMin: h["place_odds_min"], ev: h["ev"], isPositive: h["is_positive"] === 1, mark: h["mark"], reason: h["reason"] });
        expect(g.contributions).toEqual(h["contributions_json"] === null ? null : JSON.parse(h["contributions_json"] as string));
        expect(g.highlights).toEqual(h["highlights_json"] === null ? [] : JSON.parse(h["highlights_json"] as string));
        expect(g.concerns).toEqual(h["concerns_json"] === null ? [] : JSON.parse(h["concerns_json"] as string));
      });
      const alloc = await store().getStoredAllocation(out.id);
      if (line.allocationMeta === null) {
        expect(alloc, `分析 ${i + 1}`).toBeUndefined();
      } else {
        expect(alloc?.route).toBe(line.allocationMeta["route"]);
        expect(alloc?.bets).toHaveLength(line.bets.length);
        expect(alloc?.includeQuinella).toBe(line.allocationMeta["include_quinella"] === null ? null : line.allocationMeta["include_quinella"] === 1);
      }
    }
  });

  it("配分メタの24列がそのまま D1 に入る(NULL の設定列は NULL・codec の復元が読まない6列も)。分析3(旧分析)で NULL が 0 に潰れない", async () => {
    const out2 = await store().saveMigratedAnalysis(imports[1]!);
    const out3 = await store().saveMigratedAnalysis(imports[2]!);
    if (out2.kind !== "saved" || out3.kind !== "saved") throw new Error("unreachable");
    const stored2 = await one<Record<string, unknown>>("SELECT * FROM analysis_allocation_meta WHERE analysis_id = ?", out2.id);
    const { analysis_id: _a2, ...rest2 } = stored2;
    const { analysis_id: _e2, ...exp2 } = GOLDEN_ANALYSES[1]!.allocationMeta!;
    expect(rest2).toEqual(exp2);
    const stored3 = await one<Record<string, unknown>>("SELECT * FROM analysis_allocation_meta WHERE analysis_id = ?", out3.id);
    expect(stored3["include_quinella"]).toBeNull();
    expect(stored3["include_exacta"]).toBeNull();
    expect(stored3["include_trifecta"]).toBeNull();
    expect(stored3["include_bracket_quinella"]).toBeNull();
    // 前提(空振り防止): 6列のうち、分析2では非 NULL の値が入っている。
    expect([stored2["combo_odds_wide"], stored2["combo_odds_trio"], stored2["greedy_steps"], stored2["model_id"]]).toEqual(["available", "未発売", 1000, "conditional-bernoulli"]);
  });

  it("R2 の操作回数(Class A)が +1 される(1分析1回。web の保存と同じカウンタ)", async () => {
    await store().saveMigratedAnalysis(imports[0]!);
    await store().saveMigratedAnalysis(imports[1]!);
    expect(await one("SELECT class_a AS a, class_b AS b FROM r2_ops WHERE ym = 202610")).toEqual({ a: 2, b: 0 });
  });

  it("outcome: D1 の書き込み行数(meta.rows_written の合計)と、D1・R2 の問い合わせ数を返す", async () => {
    const out = await store().saveMigratedAnalysis(imports[1]!);
    if (out.kind !== "saved") throw new Error("unreachable");
    // 分析2: 馬3頭・買い目2件・配分あり → カウンタ1 + analyses(表1+索引7〈既存3+0008 の4つのうち、部分索引は exe の id があるので入る〉+ sqlite_sequence 1) + detail_key 1 + exe の id 1 + 馬6 + メタ1 + 買い目4
    expect(out.rowsWritten).toBeGreaterThan(20);
    // 問い合わせ数: 使用量の読み取り1 + batch の文7 + R2 の put 1
    expect(out.queries).toBe(1 + 7 + 1);
  });

  it("outcome の rowsWritten は、実際に書いた行数の実測と一致する(batch の meta を合計している)", async () => {
    const before = await one<{ c: number }>("SELECT (SELECT count(*) FROM analyses) + (SELECT count(*) FROM analysis_horses) + (SELECT count(*) FROM analysis_bets) + (SELECT count(*) FROM analysis_allocation_meta) AS c");
    const out = await store().saveMigratedAnalysis(imports[1]!);
    if (out.kind !== "saved") throw new Error("unreachable");
    const after = await one<{ c: number }>("SELECT (SELECT count(*) FROM analyses) + (SELECT count(*) FROM analysis_horses) + (SELECT count(*) FROM analysis_bets) + (SELECT count(*) FROM analysis_allocation_meta) AS c");
    const tableRows = after.c - before.c;
    expect(tableRows).toBe(1 + 3 + 2 + 1);
    // 索引・カウンタ・UPDATE の行も数えるので、表の行数より多い。
    expect(out.rowsWritten).toBeGreaterThan(tableRows);
  });
});

describe("saveMigratedAnalysis: 冪等性", () => {
  it("findMigrated: 取り込み済みの exe の id → D1 の id・race_id・analyzed_at。取り込んでいない id は含まない", async () => {
    const out = await store().saveMigratedAnalysis(imports[1]!);
    if (out.kind !== "saved") throw new Error("unreachable");
    const exeIds = imports.map((i) => i.exeId);
    const found = await store().findMigrated(exeIds);
    expect([...found.keys()]).toEqual([imports[1]!.exeId]);
    expect(found.get(imports[1]!.exeId)).toEqual({ id: out.id, raceId: "202603020211", analyzedAt: "2026-03-02T02:00:00.000Z" });
    expect(exeIds.length).toBeGreaterThan(1);
    expect((await store().findMigrated([])).size).toBe(0);
  });

  it("findMigrated は部分索引 idx_analyses_exe_id を使う(全表走査しない)", async () => {
    const sql = "SELECT id, exe_analysis_id AS exeId, race_id AS raceId, analyzed_at AS analyzedAt FROM analyses WHERE exe_analysis_id IS NOT NULL AND exe_analysis_id IN (SELECT value FROM json_each(?)) /* plan-exe */";
    const details = (await local.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("[1]").all<{ detail: string }>()).results.map((r) => r.detail);
    expect(details.some((d) => /USING (COVERING )?INDEX idx_analyses_exe_id/.test(d)), details.join(" / ")).toBe(true);
  });

  it("同じ exe の id をもう一度保存すると失敗し、何も増えない(カウンタも巻き戻る。batch は1つのトランザクション)", async () => {
    await store().saveMigratedAnalysis(imports[1]!);
    const counts = async () => one("SELECT (SELECT count(*) FROM analyses) AS a, (SELECT count(*) FROM analysis_horses) AS h, (SELECT count(*) FROM analysis_bets) AS b, (SELECT count(*) FROM analysis_allocation_meta) AS m, (SELECT class_a FROM r2_ops WHERE ym = 202610) AS ops");
    const before = await counts();
    await expect(store().saveMigratedAnalysis(imports[1]!)).rejects.toThrow();
    expect(await counts()).toEqual(before);
    // 前提: 数えたものは実際に非ゼロ(0 = 0 で自明に一致しない)
    expect(before).toEqual({ a: 1, h: 3, b: 2, m: 1, ops: 1 });
  });

  it("web の分析(exe の id が NULL)は、何件あっても一意の索引に当たらない", async () => {
    for (let i = 0; i < 3; i += 1) {
      await store().saveAnalysis({ ...contractCases[0]!.record, analyzedAt: `2026-10-0${i + 1}T00:00:00.000Z` });
    }
    expect((await one<{ c: number }>("SELECT count(*) AS c FROM analyses WHERE exe_analysis_id IS NULL")).c).toBe(3);
  });

  it("web の分析の保存と交互・並行に走らせても、子の行(馬・買い目・メタ)の取り違えがない", async () => {
    const webRecords = [0, 1, 2].map((i) => ({ ...contractCases[0]!.record, analyzedAt: `2026-10-0${i + 1}T00:00:00.000Z` }));
    await Promise.all([
      ...imports.map((i) => store().saveMigratedAnalysis(i)),
      ...webRecords.map((r) => store().saveAnalysis(r)),
    ]);
    const rows = (await local.db.prepare("SELECT id, exe_analysis_id AS exeId, (SELECT count(*) FROM analysis_horses h WHERE h.analysis_id = a.id) AS horses, (SELECT count(*) FROM analysis_bets b WHERE b.analysis_id = a.id) AS bets FROM analyses a").all<{ id: number; exeId: number | null; horses: number; bets: number }>()).results;
    expect(rows).toHaveLength(8);
    for (const line of GOLDEN_ANALYSES) {
      const r = rows.find((x) => x.exeId === line.analysis["id"])!;
      expect([r.horses, r.bets]).toEqual([line.horses.length, line.bets.length]);
    }
    const web = rows.filter((x) => x.exeId === null);
    expect(web.map((w) => [w.horses, w.bets])).toEqual(webRecords.map((r) => [r.horses.length, r.allocation?.bets.length ?? 0]));
  });
});

describe("saveMigratedAnalysis: R2 の柵・失敗", () => {
  it("Class A が柵に達していたら、**D1 にも R2 にも何も書かず** fenced を返す(要約だけの保存にしない)", async () => {
    await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (202610, ?, 0)").bind(R2_FENCE_LIMITS.classA).run();
    const spy = spyBucket(local.r2);
    const out = await store(spy.bucket as never).saveMigratedAnalysis(imports[1]!);
    expect(out.kind).toBe("fenced");
    expect((await one<{ c: number }>("SELECT count(*) AS c FROM analyses")).c).toBe(0);
    expect(spy.calls).toEqual([]);
    expect((await one<{ a: number }>("SELECT class_a AS a FROM r2_ops WHERE ym = 202610")).a).toBe(R2_FENCE_LIMITS.classA);
    // 対照: 柵の1つ手前なら保存できる
    await local.db.prepare("UPDATE r2_ops SET class_a = ? WHERE ym = 202610").bind(R2_FENCE_LIMITS.classA - 1).run();
    expect((await store().saveMigratedAnalysis(imports[1]!)).kind).toBe("saved");
  });

  it("R2 の put が3回(初回+再試行2回)失敗したら detail: failed。D1 の行は残り、detail_key は消さない(あとで repairDetail で直す)", async () => {
    const spy = spyBucket(local.r2, { failPut: () => true });
    const out = await store(spy.bucket as never).saveMigratedAnalysis(imports[1]!);
    if (out.kind !== "saved") throw new Error("unreachable");
    expect(out.detail).toBe("failed");
    expect(spy.calls.filter((c) => c.op === "put")).toHaveLength(3);
    expect(out.queries).toBe(1 + 7 + 3);
    expect((await one<{ k: string | null }>("SELECT detail_key AS k FROM analyses WHERE id = ?", out.id)).k).toBe(detailKeyOf(out.id));
    expect(await local.r2.get(detailKeyOf(out.id))).toBeNull();
    // 直す
    const repaired = await store().repairDetail(out.id, imports[1]!.record);
    expect(repaired.kind).toBe("stored");
    const object = await local.r2.get(detailKeyOf(out.id));
    expect(decodeDetail(new Uint8Array(await object!.arrayBuffer()))?.rawResponse).toBe(GOLDEN_ANALYSES[1]!.analysis["raw_response"]);
  });

  it("repairDetail も柵に従う(Class A が柵に達していたら fenced で、R2 に書かない)", async () => {
    const out = await store().saveMigratedAnalysis(imports[1]!);
    if (out.kind !== "saved") throw new Error("unreachable");
    await local.db.prepare("UPDATE r2_ops SET class_a = ? WHERE ym = 202610").bind(R2_FENCE_LIMITS.classA).run();
    const spy = spyBucket(local.r2);
    expect((await store(spy.bucket as never).repairDetail(out.id, imports[1]!.record)).kind).toBe("fenced");
    expect(spy.calls).toEqual([]);
  });
});

describe("saveMigratedResult: 結果の保存(既存の行を優先)", () => {
  const results = GOLDEN_RESULTS.map(toResultImport);
  const resultStore = (): D1ResultStore => new D1ResultStore({ db: local.db });
  const byRace = (raceId: string) => results.find((r) => r.raceId === raceId)!;
  const lineOf = (raceId: string) => GOLDEN_RESULTS.find((r) => r.raceId === raceId)!;

  const ORDER: Record<string, string> = { race_results: "umaban", race_combo_payouts: "bet_type, combo_key", race_combo_payout_imports: "bet_type", race_result_meta: "race_id" };
  async function dump(table: string, raceId: string): Promise<unknown[]> {
    return (await local.db.prepare(`SELECT * FROM ${table} WHERE race_id = ? ORDER BY ${ORDER[table] ?? "1"}`).bind(raceId).all()).results;
  }

  it("5レースすべて: 4表の行が exe の行そのまま入る(passing_json は文字列のまま)", async () => {
    for (const r of results) {
      await resultStore().saveMigratedResult(r);
    }
    for (const line of GOLDEN_RESULTS) {
      const sortBy = (rows: readonly Record<string, unknown>[], ...keys: string[]) => [...rows].sort((a, b) => keys.map((k) => String(a[k]).localeCompare(String(b[k]))).find((x) => x !== 0) ?? 0);
      expect(await dump("race_results", line.raceId), line.raceId).toEqual(sortBy(line.results, "umaban").map((r) => ({ ...r })));
      expect(await dump("race_result_meta", line.raceId)).toEqual(line.meta === null ? [] : [{ ...line.meta }]);
      expect(await dump("race_combo_payouts", line.raceId)).toEqual(sortBy(line.comboPayouts, "bet_type", "combo_key").map((r) => ({ ...r })));
      expect(await dump("race_combo_payout_imports", line.raceId)).toEqual(sortBy(line.comboPayoutImports, "bet_type").map((r) => ({ ...r })));
    }
    // 前提(空振り防止): 実際に行が入っている
    expect((await one<{ c: number }>("SELECT count(*) AS c FROM race_results")).c).toBe(GOLDEN_RESULTS.reduce((n, l) => n + l.results.length, 0));
    expect((await one<{ c: number }>("SELECT count(*) AS c FROM race_results")).c).toBeGreaterThan(3);
  });

  it("outcome: 文は最大4つ。D1 の書き込み行数は meta.rows_written の合計", async () => {
    const out = await resultStore().saveMigratedResult(byRace("202603020211"));
    expect(out.queries).toBeGreaterThanOrEqual(3);
    expect(out.queries).toBeLessThanOrEqual(4);
    expect(out.rowsWritten).toBeGreaterThan(10);
  });

  it("2回目(同じ内容)は何も書かない(rows_written が 0)・行も増えない", async () => {
    await resultStore().saveMigratedResult(byRace("202603020211"));
    const before = await one<{ c: number }>("SELECT (SELECT count(*) FROM race_results) + (SELECT count(*) FROM race_combo_payouts) + (SELECT count(*) FROM race_combo_payout_imports) + (SELECT count(*) FROM race_result_meta) AS c");
    const again = await resultStore().saveMigratedResult(byRace("202603020211"));
    expect(again.rowsWritten).toBe(0);
    expect(await one("SELECT (SELECT count(*) FROM race_results) + (SELECT count(*) FROM race_combo_payouts) + (SELECT count(*) FROM race_combo_payout_imports) + (SELECT count(*) FROM race_result_meta) AS c")).toEqual(before);
    expect(before.c).toBeGreaterThan(5);
  });

  it("web が先に取り込んだレース: 結果・面・同じ券種の払戻・取込記録は上書きしない。web に無い券種の払戻は足す", async () => {
    const raceId = "202603020211";
    // web 側(exe の行とは違う値): 着順 1 頭だけ、面は ダ、ワイドの払戻は別の組合せ(マーカーあり)。
    await resultStore().saveResult(raceId, [{ umaban: 9, finishPosition: 1, placePayout: 999 }], "ダ", { wide: { state: "parsed", payouts: [{ umabans: [5, 6], payout: 111 }] } });
    const before = {
      results: await dump("race_results", raceId),
      meta: await dump("race_result_meta", raceId),
      wide: await local.db.prepare("SELECT * FROM race_combo_payouts WHERE race_id = ? AND bet_type = 'wide'").bind(raceId).all(),
    };
    await resultStore().saveMigratedResult(byRace(raceId));
    // 結果の表(馬)は丸ごと据え置き(exe の3頭は入らない。部分的な和集合にしない)
    expect(await dump("race_results", raceId)).toEqual(before.results);
    expect(before.results).toHaveLength(1);
    expect(await dump("race_result_meta", raceId)).toEqual(before.meta);
    expect(((await dump("race_result_meta", raceId))[0] as { course_type: string }).course_type).toBe("ダ");
    // ワイドは web のまま
    expect((await local.db.prepare("SELECT * FROM race_combo_payouts WHERE race_id = ? AND bet_type = 'wide'").bind(raceId).all()).results).toEqual(before.wide.results);
    // exe にだけある券種(exacta)は足される
    const exacta = lineOf(raceId).comboPayouts.filter((r) => r["bet_type"] === "exacta");
    expect(exacta.length).toBeGreaterThan(0);
    expect((await local.db.prepare("SELECT * FROM race_combo_payouts WHERE race_id = ? AND bet_type = 'exacta'").bind(raceId).all()).results).toEqual(exacta.map((r) => ({ ...r })));
    expect((await local.db.prepare("SELECT bet_type FROM race_combo_payout_imports WHERE race_id = ? ORDER BY bet_type").bind(raceId).all()).results.map((r) => (r as { bet_type: string }).bet_type)).toEqual(["exacta", "trio", "wide"]);
  });

  it("払戻の行だけがあって取込記録の無い券種(exe の行)も、取り込める", async () => {
    await resultStore().saveMigratedResult(byRace("202603020215"));
    expect(await dump("race_combo_payouts", "202603020215")).toEqual(lineOf("202603020215").comboPayouts.map((r) => ({ ...r })));
    expect(await dump("race_combo_payout_imports", "202603020215")).toEqual([]);
  });
});
