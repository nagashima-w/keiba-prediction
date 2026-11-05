import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeDetail } from "../src/analysis-detail";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1AllocationExportStore, type AllocationExportBucket } from "../src/allocation-export-store";
import { ALLOCATION_EXPORT_BATCH_SIZE, ALLOCATION_EXPORT_TICK_OVERHEAD_QUERIES, type AllocationDetailOutcome } from "../src/allocation-export-core";
import { D1ResultStore } from "../src/result-repository";
import type { AnalysisAllocationMetaRecord, AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";
import { fixedLength, streamBucket } from "./stream-put-support";

/**
 * Issue #463: 配分の再計算用の書き出しの D1・R2 の読み書き(`D1AllocationExportStore`)を、ローカル(workerd)の D1・R2 で確かめる。
 * ★限界(本番との差): ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しない。文の数は記録した値で直接 assert する。
 * ★限界: この Node 側のテストには `FixedLengthStream`(workerd の組み込み)が無いので、長さを検査する偽の実装を注入する。本物の `FixedLengthStream` で R2 に流せることは、
 *   スモークテスト(`cloud/smoke.ts`。本物の workerd の DO)が確かめる。
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
  await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run();
});

const NOW = new Date("2026-10-10T12:00:00.000Z");

const META: AnalysisAllocationMetaRecord = {
  route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: "present", comboOddsTrio: "empty",
  bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1.05, includeComboOdds: true, includeWide: true, includeTrio: false,
  includeQuinella: true, includeExacta: false, includeTrifecta: true, includeBracketQuinella: false, betUnit: 100, greedySteps: 1000, candidateCap: 2000,
  modelId: "plackett-luce", modelApproximate: false, oddsStatus: "result", minHitProb: 0.02, belowFloorCount: 4, maxWinBets: 2, maxPlaceBets: 3,
  missed: [{ betType: "trifecta", comboKey: "010203", hitProb: 0.001, odds: 900, ev: 1.2, wouldStake: 100 }],
};

function mkRecord(i: number, over: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    raceId: `2026060308${String(10 + i).padStart(2, "0")}`,
    analyzedAt: "2026-10-01T00:00:00.000Z",
    kaisaiDate: "20261001",
    promptVersion: "v-test",
    historyCutoffDate: "20260930",
    raceSnapshot: {
      race: { raceName: "SECRET-RACE", courseType: "芝", distance: 1600, grade: "G3" },
      horses: [
        { umaban: 1, wakuban: 1, name: "SECRET-HORSE", jockeyName: "SECRET-JOCKEY", winOdds: 3.4, popularity: 1, placeOddsMin: 1.5, placeOddsMax: 2.1 },
        { umaban: 2, wakuban: 2, winOdds: 8, popularity: 2, placeOddsMin: 2, placeOddsMax: 3 },
      ],
      wideCombo: { "0102": 5.5 },
      exactaCombo: { "0102": 12.3, "0201": 15.4 },
      comboOdds: { wide: { state: "available" } },
    },
    rawResponse: "SECRET-RAW",
    additionalInstruction: "SECRET-INSTRUCTION",
    horses: [
      { umaban: 1, prior: 0.3, adjustedProb: 0.31, placeOddsMin: 1.5, ev: 1.2, isPositive: true, contributions: [{ biasName: "a", applied: true, reason: "SECRET-REASON", weight: 0.1, correction: 0.02 }], mark: "◎", reason: "SECRET-HREASON" },
      { umaban: 2, prior: 0.2, adjustedProb: 0.21, placeOddsMin: null, ev: null, isPositive: false, contributions: null, mark: null },
    ],
    allocation: {
      meta: META,
      bets: [
        { betType: "place", comboKey: "01", stake: 300, odds: 1.5, ev: 1.2 },
        { betType: "exacta", comboKey: "0201", stake: 100, odds: 15.4, ev: 1.3 },
      ],
    },
    ...over,
  };
}

const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => NOW });
const store = (bucket: AllocationExportBucket = local.r2 as unknown as AllocationExportBucket, db = local.db) =>
  new D1AllocationExportStore({ db, bucket, now: () => NOW, fixedLengthStream: fixedLength });
const results = () => new D1ResultStore({ db: local.db });

async function seedPayouts(raceId: string): Promise<void> {
  await local.db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, 'exacta', '0102', 1230), (?, 'exacta', '0201', 1540), (?, 'wide', '0102', 220)").bind(raceId, raceId, raceId).run();
  await local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, 'exacta'), (?, 'wide'), (?, 'trifecta')").bind(raceId, raceId, raceId).run();
}

describe("readCandidates", () => {
  it("結果のあるレースの分析だけを id 昇順に返す(自由文・大きな列は読まない)", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    await analyses().saveAnalysis(mkRecord(2));
    await results().saveResult(mkRecord(1).raceId, [{ umaban: 1, finishPosition: 1 }]);
    const out = await store().readCandidates();
    expect(out.rows.map((r) => r.id)).toEqual([1]);
    expect(out.rows[0]).toMatchObject({ raceId: mkRecord(1).raceId, detailKey: "analyses/1.json.gz", historyCutoffDate: "20260930", promptVersion: "v-test" });
    expect(out.rowsRead).toBeGreaterThan(0);
    expect(JSON.stringify(out.rows)).not.toMatch(/SECRET/);
  });
});

describe("readRaceData", () => {
  async function seed(): Promise<void> {
    for (let i = 1; i <= 3; i += 1) {
      await analyses().saveAnalysis(mkRecord(i));
      await results().saveResult(
        mkRecord(i).raceId,
        [
          { umaban: 1, finishPosition: 2, placePayout: 130, winPayout: null, winOdds: 3.4, ninki: 2, scratched: false, wakuban: 1 },
          { umaban: 2, finishPosition: null, scratched: true, wakuban: 2 },
        ],
        "芝",
      );
      await seedPayouts(mkRecord(i).raceId);
    }
  }

  it("馬・結果・配分のメタ・買い目・組合せ払戻・取込印を 1 回の batch(6 文)で読む。対象外の分析・レースは読まない", async () => {
    await seed();
    const spy = spyDb(local.db);
    const out = await store(local.r2 as unknown as AllocationExportBucket, spy.db as never).readRaceData([1, 3], [mkRecord(1).raceId, mkRecord(3).raceId]);
    expect(spy.batches).toEqual([6]);
    expect(spy.prepared).toHaveLength(6);
    expect(ALLOCATION_EXPORT_BATCH_SIZE + ALLOCATION_EXPORT_TICK_OVERHEAD_QUERIES).toBeLessThanOrEqual(40);
    expect(out.horses.map((h) => [h.analysisId, h.umaban])).toEqual([[1, 1], [1, 2], [3, 1], [3, 2]]);
    expect(out.horses[0]).toEqual({ analysisId: 1, umaban: 1, prior: 0.3, adjustedProb: 0.31, placeOddsMin: 1.5, ev: 1.2 });
    expect(out.horses[1]).toMatchObject({ umaban: 2, placeOddsMin: null, ev: null });
    // 結果: 着順・払戻・取消(1/0)・枠番・確定の単勝オッズ・人気
    expect(out.results).toHaveLength(4);
    expect(out.results.find((r) => r.raceId === mkRecord(1).raceId && r.umaban === 1)).toEqual({
      raceId: mkRecord(1).raceId, umaban: 1, finishPosition: 2, placePayout: 130, winPayout: null, scratched: 0, wakuban: 1, winOdds: 3.4, ninki: 2,
    });
    expect(out.results.find((r) => r.raceId === mkRecord(1).raceId && r.umaban === 2)).toMatchObject({ finishPosition: null, scratched: 1, wakuban: 2, winOdds: null });
    // 配分のメタ: 全列(D1 の 0/1 のまま。下限・外した買い目も)
    expect(out.metas.map((m) => m.analysisId)).toEqual([1, 3]);
    expect(out.metas[0]).toEqual({
      analysisId: 1, route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: "present", comboOddsTrio: "empty",
      bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1.05, includeComboOdds: 1, includeWide: 1, includeTrio: 0, includeQuinella: 1,
      includeExacta: 0, includeTrifecta: 1, includeBracketQuinella: 0, betUnit: 100, greedySteps: 1000, candidateCap: 2000, modelId: "plackett-luce",
      modelApproximate: 0, oddsStatus: "result", minHitProb: 0.02, belowFloorCount: 4, maxWinBets: 2, maxPlaceBets: 3,
      missedJson: JSON.stringify([{ bet_type: "trifecta", combo_key: "010203", hit_prob: 0.001, odds: 900, ev: 1.2, would_stake: 100 }]),
    });
    // 買い目(主キーの順)・組合せ払戻・取込印
    expect(out.bets.filter((b) => b.analysisId === 1).map((b) => [b.betType, b.comboKey, b.stake, b.odds, b.ev])).toEqual([
      ["exacta", "0201", 100, 15.4, 1.3],
      ["place", "01", 300, 1.5, 1.2],
    ]);
    expect(out.bets.map((b) => b.analysisId)).toEqual([1, 1, 3, 3]);
    expect(out.payouts.filter((p) => p.raceId === mkRecord(1).raceId).map((p) => [p.betType, p.comboKey, p.payout])).toEqual([
      ["exacta", "0102", 1230], ["exacta", "0201", 1540], ["wide", "0102", 220],
    ]);
    expect(out.imports.filter((i) => i.raceId === mkRecord(1).raceId).map((i) => i.betType)).toEqual(["exacta", "trifecta", "wide"]);
    expect(out.payouts.some((p) => p.raceId === mkRecord(2).raceId)).toBe(false);
    expect(out.rowsRead).toBeGreaterThan(0);
  });

  it("配分を保存していない分析は、メタも買い目も返さない(馬は返る)。NULL の設定(旧い行)は NULL のまま読める", async () => {
    await analyses().saveAnalysis(mkRecord(1, { allocation: undefined }));
    await analyses().saveAnalysis(mkRecord(2));
    await local.db.prepare("UPDATE analysis_allocation_meta SET include_quinella = NULL, include_trifecta = NULL, min_hit_prob = NULL, below_floor_count = NULL, missed_json = NULL, max_win_bets = NULL, max_place_bets = NULL WHERE analysis_id = 2").run();
    for (const i of [1, 2]) await results().saveResult(mkRecord(i).raceId, [{ umaban: 1, finishPosition: 1 }]);
    const out = await store().readRaceData([1, 2], [mkRecord(1).raceId, mkRecord(2).raceId]);
    expect(out.metas.map((m) => m.analysisId)).toEqual([2]);
    expect(out.metas[0]).toMatchObject({ includeQuinella: null, includeTrifecta: null, minHitProb: null, belowFloorCount: null, missedJson: null, maxWinBets: null, maxPlaceBets: null });
    expect(out.bets.map((b) => b.analysisId)).toEqual([2, 2]);
    expect(out.horses.filter((h) => h.analysisId === 1)).toHaveLength(2);
  });

  it("読み取り行数は束縛した ID に比例する(索引を引く)。無関係な行を足してもほとんど増えない = 全件走査ではない", async () => {
    await seed();
    const out = await store().readRaceData([1, 3], [mkRecord(1).raceId, mkRecord(3).raceId]);
    for (let i = 4; i <= 9; i += 1) {
      await analyses().saveAnalysis(mkRecord(i));
      await results().saveResult(mkRecord(i).raceId, [{ umaban: 1, finishPosition: 1 }, { umaban: 2, finishPosition: 2 }], "芝");
      await seedPayouts(mkRecord(i).raceId);
    }
    const again = await store().readRaceData([1, 3], [mkRecord(1).raceId, mkRecord(3).raceId]);
    // 足した無関係な行は 6 レース × (馬 2 + 結果 2 + メタ 1 + 買い目 2 + 払戻 3 + 取込印 3 = 13) = 78 行。全件走査なら 78 行以上増える
    expect(again.rowsRead - out.rowsRead).toBeLessThan(78 / 3);
  });

  it("SQL は自由文・大きな列(race_snapshot_json・reason・raw_response・contributions_json・additional_instruction)を読まない", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    await results().saveResult(mkRecord(1).raceId, [{ umaban: 1, finishPosition: 1 }]);
    const spy = spyDb(local.db);
    const s = store(local.r2 as unknown as AllocationExportBucket, spy.db as never);
    await s.readCandidates();
    const out = await s.readRaceData([1], [mkRecord(1).raceId]);
    for (const sql of spy.prepared) {
      for (const col of ["race_snapshot_json", "reason", "raw_response", "contributions_json", "additional_instruction", "highlights_json", "concerns_json"]) {
        expect(sql, `SQL が ${col} を読まない`).not.toMatch(new RegExp(`\\b${col}\\b`));
      }
    }
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
  });
});

describe("fetchDetails", () => {
  it("詳細の raceSnapshot から配分の再計算に要る分を返す。detail_key が無い・R2 に無い・壊れている・別のレースのものは none。取得を試みた回数だけ gets に数える", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    await analyses().saveAnalysis(mkRecord(2));
    await analyses().saveAnalysis(mkRecord(3));
    await analyses().saveAnalysis(mkRecord(4));
    await local.r2.put("analyses/3.json.gz", new Uint8Array([1, 2, 3]));
    await local.r2.put("analyses/4.json.gz", encodeDetail(mkRecord(1)));
    const spy = spyBucket(local.r2);
    const out = await store(spy.bucket as unknown as AllocationExportBucket).fetchDetails([
      { id: 1, raceId: mkRecord(1).raceId, detailKey: "analyses/1.json.gz" },
      { id: 2, raceId: mkRecord(2).raceId, detailKey: null },
      { id: 3, raceId: mkRecord(3).raceId, detailKey: "analyses/3.json.gz" },
      { id: 4, raceId: mkRecord(4).raceId, detailKey: "analyses/4.json.gz" },
      { id: 5, raceId: mkRecord(5).raceId, detailKey: "analyses/not-found.json.gz" },
    ]);
    expect(out.outcomes.map((o) => o.kind)).toEqual(["ok", "none", "none", "none", "none"]);
    const ok = out.outcomes[0] as Extract<AllocationDetailOutcome, { kind: "ok" }>;
    expect(ok.snapshot.present).toBe(true);
    expect(ok.snapshot.race).toEqual({ course_type: "芝", distance: 1600, grade: "G3" });
    expect(ok.snapshot.horses.get(1)).toEqual({ wakuban: 1, win_odds: 3.4, ninki: 1, place_min: 1.5, place_max: 2.1 });
    expect(ok.snapshot.combos.exacta).toEqual({ "0102": 12.3, "0201": 15.4 });
    expect(ok.snapshot.comboStates).toEqual({ wide: "available" });
    expect(out.gets).toBe(4);
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(4);
    expect(spy.calls.filter((c) => c.op === "put")).toHaveLength(0);
    expect(JSON.stringify(ok.snapshot.race)).not.toContain("SECRET");
  });

  it("スナップショットが null の詳細は ok のまま present が false(詳細なし〈none〉とは別)", async () => {
    await analyses().saveAnalysis(mkRecord(1, { raceSnapshot: null }));
    const out = await store().fetchDetails([{ id: 1, raceId: mkRecord(1).raceId, detailKey: "analyses/1.json.gz" }]);
    const o = out.outcomes[0]!;
    expect(o.kind === "ok" && o.snapshot.present).toBe(false);
  });

  it("R2 の get が例外のときは failed(none にしない。再試行できる)", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    const spy = spyBucket(local.r2, { failGet: true });
    const out = await store(spy.bucket as unknown as AllocationExportBucket).fetchDetails([{ id: 1, raceId: mkRecord(1).raceId, detailKey: "analyses/1.json.gz" }]);
    expect(out.outcomes).toEqual([{ kind: "failed" }]);
    expect(out.gets).toBe(1);
  });
});

describe("Class A・B の計数と putFileStream", () => {
  it("countReads は今月の class_b に加算する(0 回なら D1 に何も発行しない)", async () => {
    const spy = spyDb(local.db);
    const s = store(local.r2 as unknown as AllocationExportBucket, spy.db as never);
    await s.countReads(0);
    expect(spy.prepared).toEqual([]);
    await s.countReads(10);
    await s.countReads(5);
    expect(await s.readUsage()).toEqual({ classA: 0, classB: 15 });
  });

  const INFO = { generatedAt: "2026-10-10T12:00:00.000Z", rows: 3, races: 3 };

  it("class_a を 1 数えてから、塊を 1 つずつ流して固定キーに put する(メタデータつき)。上書きは 1 つのオブジェクトのまま", async () => {
    const sb = streamBucket(local.r2);
    const s = store(sb.bucket);
    const read: number[] = [];
    await s.putFileStream("exports/allocation-dataset.ndjson.gz", function* () { for (const p of [[1, 2], [3], [4, 5, 6]]) { read.push(p.length); yield new Uint8Array(p); } }, 6, INFO);
    await s.putFileStream("exports/allocation-dataset.ndjson.gz", () => [new Uint8Array([9, 9])], 2, { ...INFO, generatedAt: "2026-10-10T13:00:00.000Z" });
    expect(read).toEqual([2, 1, 3]);
    expect(await s.readUsage()).toEqual({ classA: 2, classB: 0 });
    expect(sb.keys).toEqual(["exports/allocation-dataset.ndjson.gz", "exports/allocation-dataset.ndjson.gz"]);
    expect([...sb.bodies[0]!]).toEqual([1, 2, 3, 4, 5, 6]);
    const obj = await local.r2.get("exports/allocation-dataset.ndjson.gz");
    expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([9, 9]);
    expect(obj!.customMetadata).toMatchObject({ generatedAt: "2026-10-10T13:00:00.000Z", rows: "3", races: "3" });
  });

  it("Class A は put の前に数える: 流している途中の例外・総バイト数の食い違い・put の失敗でも数え、例外を投げる。固定キーの古いファイルは変わらない", async () => {
    const sb = streamBucket(local.r2);
    const s = store(sb.bucket);
    await s.putFileStream("k", () => [new Uint8Array([7])], 1, INFO); // 古いファイル
    const before = (await s.readUsage()).classA;
    await expect(s.putFileStream("k", function* () { yield new Uint8Array([1, 1]); throw new Error("塊が失われています"); }, 4, INFO)).rejects.toThrow();
    await expect(s.putFileStream("k", () => [new Uint8Array([1, 1])], 5, INFO)).rejects.toThrow(); // 宣言より短い
    await expect(s.putFileStream("k", () => [new Uint8Array([1, 1, 1])], 2, INFO)).rejects.toThrow(); // 宣言より長い
    // 宣言した長さをちょうど流したあとに例外になっても、put は失敗として終わり、古いファイルを上書きしない(流し込みを閉じて成功させない)
    await expect(s.putFileStream("k", function* () { yield new Uint8Array([2, 2]); throw new Error("最後の塊の後で例外"); }, 2, INFO)).rejects.toThrow("最後の塊の後で例外");
    const spy = spyBucket(local.r2, { failPut: () => true });
    await expect(store(spy.bucket as unknown as AllocationExportBucket).putFileStream("k", () => [new Uint8Array([1])], 1, INFO)).rejects.toThrow();
    expect((await s.readUsage()).classA).toBe(before + 5);
    const obj = await local.r2.get("k");
    expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([7]);
  });
});
