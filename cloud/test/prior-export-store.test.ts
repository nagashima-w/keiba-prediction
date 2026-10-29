import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeDetail } from "../src/analysis-detail";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1PriorExportStore, type PriorExportBucket } from "../src/prior-export-store";
import { PRIOR_EXPORT_BATCH_SIZE, PRIOR_EXPORT_TICK_OVERHEAD_QUERIES, type DetailOutcome } from "../src/prior-export-core";
import { D1ResultStore } from "../src/result-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";
import { fixedLength, streamBucket } from "./stream-put-support";

/**
 * Issue #266: 書き出しの D1・R2 の読み書き(`D1PriorExportStore`)を、ローカル(workerd)の D1・R2 で確かめる。
 * ★限界(本番との差): ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しない。文の数は記録した値で直接 assert する。
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

function mkRecord(i: number, over: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    raceId: `2026060308${String(10 + i).padStart(2, "0")}`,
    analyzedAt: "2026-10-01T00:00:00.000Z",
    kaisaiDate: "20261001",
    promptVersion: "v-test",
    historyCutoffDate: "20260930",
    raceSnapshot: { race: { raceName: "x" } },
    rawResponse: "SECRET-RAW",
    additionalInstruction: "SECRET-INSTRUCTION",
    horses: [
      { umaban: 1, prior: 0.3, adjustedProb: 0.31, placeOddsMin: 2, ev: 1, isPositive: true, contributions: [{ biasName: "a", applied: true, reason: "SECRET-REASON", weight: 0.1, correction: 0.02 }], mark: "◎", reason: "SECRET-HREASON" },
      { umaban: 2, prior: 0.2, adjustedProb: 0.21, placeOddsMin: null, ev: null, isPositive: false, contributions: [{ biasName: "a", applied: false, reason: "r", weight: 0.1, correction: 0 }], mark: null },
    ],
    ...over,
  };
}

const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => NOW });
const store = (bucket: PriorExportBucket = local.r2, db = local.db) => new D1PriorExportStore({ db, bucket, now: () => NOW, fixedLengthStream: fixedLength });
const results = () => new D1ResultStore({ db: local.db });

describe("readCandidates", () => {
  it("結果のあるレースの分析だけを id 昇順に返す(結果の無いレースの分析は返さない)。start_time の印・遮断・EV 推定の列を持つ", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    await analyses().saveAnalysis(mkRecord(2));
    await analyses().saveAnalysis(mkRecord(3, { evEstimated: true, historyCutoffDate: null }));
    await results().saveResult(mkRecord(1).raceId, [{ umaban: 1, finishPosition: 1 }]);
    await results().saveResult(mkRecord(3).raceId, [{ umaban: 1, finishPosition: 1 }]);
    await local.db.prepare("UPDATE analyses SET start_time = '10:05' WHERE id = 3").run();
    const out = await store().readCandidates();
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
    expect(out.rows[0]).toMatchObject({ raceId: mkRecord(1).raceId, analyzedAt: "2026-10-01T00:00:00.000Z", kaisaiDate: "20261001", promptVersion: "v-test", detailKey: "analyses/1.json.gz", historyCutoffDate: "20260930", startTime: null });
    expect(out.rows[1]).toMatchObject({ evEstimated: 1, historyCutoffDate: null, startTime: "10:05" });
    expect(out.rowsRead).toBeGreaterThan(0);
    // 大きな列・自由文は読まない
    expect(JSON.stringify(out.rows)).not.toMatch(/SECRET/);
  });
});

describe("readRaceData", () => {
  it("馬・結果・面を 1 回の batch(3 文)で読む。対象外の分析・レースは読まない。結果の列(着順・確定オッズ・人気)を持つ", async () => {
    for (let i = 1; i <= 3; i += 1) await analyses().saveAnalysis(mkRecord(i));
    for (let i = 1; i <= 3; i += 1) {
      await results().saveResult(mkRecord(i).raceId, [{ umaban: 1, finishPosition: 2, winOdds: 3.4, ninki: 2 }, { umaban: 2, finishPosition: null }], "ダ");
    }
    const spy = spyDb(local.db);
    const out = await store(local.r2, spy.db as never).readRaceData([1, 3], [mkRecord(1).raceId, mkRecord(3).raceId]);
    expect(spy.batches).toEqual([3]);
    expect(PRIOR_EXPORT_BATCH_SIZE + PRIOR_EXPORT_TICK_OVERHEAD_QUERIES).toBeLessThanOrEqual(40);
    expect(out.horses.map((h) => [h.analysisId, h.umaban])).toEqual([[1, 1], [1, 2], [3, 1], [3, 2]]);
    expect(out.horses[0]).toEqual({ analysisId: 1, umaban: 1, prior: 0.3, adjustedProb: 0.31, placeOddsMin: 2 });
    expect(out.horses[1]).toMatchObject({ umaban: 2, placeOddsMin: null });
    expect(out.results).toHaveLength(4);
    expect(out.results.find((r) => r.raceId === mkRecord(1).raceId && r.umaban === 1)).toEqual({ raceId: mkRecord(1).raceId, umaban: 1, finishPosition: 2, winOdds: 3.4, ninki: 2 });
    expect(out.results.find((r) => r.raceId === mkRecord(1).raceId && r.umaban === 2)).toMatchObject({ finishPosition: null, winOdds: null, ninki: null });
    expect(out.courseTypes.map((c) => c.courseType)).toEqual(["ダ", "ダ"]);
    // 読み取り行数 = 馬 4 + 結果 4 + 面 2(束縛した ID の行だけ。全件走査ではない)
    // 読み取り行数は返した行(馬 4 + 結果 4 + 面 2 = 10)以上。束縛した ID に比例し(索引を引く)、無関係な行を足してもほとんど増えない = 全件走査ではない
    // (足した無関係な行は 6 レース × (馬 2 + 結果 2 + 面 1) = 30 行。全件走査なら 30 行以上増える。索引の深さの分だけ数行は増えうる)
    expect(out.rowsRead).toBeGreaterThanOrEqual(10);
    for (let i = 4; i <= 9; i += 1) {
      await analyses().saveAnalysis(mkRecord(i));
      await results().saveResult(mkRecord(i).raceId, [{ umaban: 1, finishPosition: 1 }, { umaban: 2, finishPosition: 2 }], "ダ");
    }
    const again = await store().readRaceData([1, 3], [mkRecord(1).raceId, mkRecord(3).raceId]);
    expect(again.rowsRead - out.rowsRead).toBeLessThan(30 / 3);
  });
});

describe("Issue #341: 形式 v2 は D1 の読み取りを増やさない", () => {
  it("候補・馬・結果・面の SQL は、スナップショットの列(race_snapshot_json)にも枠番(wakuban)にも触れず、readRaceData の batch は 3 文のまま", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    await results().saveResult(mkRecord(1).raceId, [{ umaban: 1, finishPosition: 1 }]);
    const spy = spyDb(local.db);
    const s = store(local.r2, spy.db as never);
    await s.readCandidates();
    await s.readRaceData([1], [mkRecord(1).raceId]);
    expect(spy.batches).toEqual([3]);
    expect(spy.prepared).toHaveLength(4); // 候補 1 + 馬・結果・面 3
    for (const sql of spy.prepared) {
      expect(sql, "SQL が race_snapshot_json を読まない").not.toContain("race_snapshot_json");
      expect(sql, "SQL が wakuban を読まない").not.toContain("wakuban");
    }
  });
});

describe("fetchDetails", () => {
  it("詳細の寄与度を返す。detail_key が無い・R2 に無い・壊れている・別のレースのものは none(失敗ではない)。取得を試みた回数だけ gets に数える", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    await analyses().saveAnalysis(mkRecord(2));
    await analyses().saveAnalysis(mkRecord(3));
    await analyses().saveAnalysis(mkRecord(4));
    await local.r2.put("analyses/3.json.gz", new Uint8Array([1, 2, 3])); // 壊れている
    await local.r2.put("analyses/4.json.gz", encodeDetail(mkRecord(1))); // 別のレース
    const spy = spyBucket(local.r2);
    const out = await store(spy.bucket as unknown as PriorExportBucket).fetchDetails([
      { id: 1, raceId: mkRecord(1).raceId, detailKey: "analyses/1.json.gz" },
      { id: 2, raceId: mkRecord(2).raceId, detailKey: null },
      { id: 3, raceId: mkRecord(3).raceId, detailKey: "analyses/3.json.gz" },
      { id: 4, raceId: mkRecord(4).raceId, detailKey: "analyses/4.json.gz" },
      { id: 5, raceId: mkRecord(5).raceId, detailKey: "analyses/not-found.json.gz" },
    ]);
    expect(out.outcomes.map((o) => o.kind)).toEqual(["ok", "none", "none", "none", "none"]);
    const ok = out.outcomes[0]!;
    expect(ok.kind === "ok" && Object.keys(ok.contributions)).toEqual(["1", "2"]);
    expect(out.gets).toBe(4); // detail_key が NULL の 1 件は取得しない
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(4);
    expect(spy.calls.filter((c) => c.op === "put")).toHaveLength(0);
  });

  it("Issue #341(形式 v2): 詳細の raceSnapshot から v2 の列を返す。追加の R2 操作はない(get は取得を試みた回数だけ。この窓口は get と put しか持たず、list・head は呼べない)", async () => {
    const snapshot = {
      race: { raceName: "テストS", grade: "G2", distance: 2000, trackCondition: "稍重", courseType: "芝" },
      horses: [
        { umaban: 1, wakuban: 1, name: "SECRET-HORSE", sex: "牝", age: 4, kinryo: 54, jockeyName: "騎手ウ", jockeyId: "01234", trainerName: "SECRET-TRAINER", bodyWeight: 456, winOdds: 99.9, oikiriCritic: "気配上々", oikiriRank: "B" },
        { umaban: 2, wakuban: 2, sex: "牡", age: 3, kinryo: 56, bodyWeight: null, oikiriCritic: null, oikiriRank: null },
      ],
    };
    await analyses().saveAnalysis(mkRecord(1, { raceSnapshot: snapshot }));
    await analyses().saveAnalysis(mkRecord(2, { raceSnapshot: null }));
    const spy = spyBucket(local.r2);
    const out = await store(spy.bucket as unknown as PriorExportBucket).fetchDetails([
      { id: 1, raceId: mkRecord(1).raceId, detailKey: "analyses/1.json.gz" },
      { id: 2, raceId: mkRecord(2).raceId, detailKey: "analyses/2.json.gz" },
    ]);
    const snapshotOf = (o: DetailOutcome | undefined) => {
      if (o?.kind !== "ok") throw new Error("ok のはず");
      return o.snapshot;
    };
    const a = snapshotOf(out.outcomes[0]);
    const b = snapshotOf(out.outcomes[1]);
    expect(a.race).toEqual({ race_name: "テストS", grade: "G2", distance: 2000, track_condition: "稍重" });
    expect(a.horses.get(1)).toEqual({ wakuban: 1, sex: "牝", age: 4, body_weight: 456, kinryo: 54, oikiri_rank: "B", oikiri_critic: "気配上々" });
    expect(a.horses.get(2)).toMatchObject({ wakuban: 2, sex: "牡", body_weight: null, oikiri_rank: null });
    // Issue #526(形式 v4): 今回の騎手は R2 の詳細のスナップショットから馬番ごとに取れる(騎手の無い馬は両列 null。追加の R2 操作はない)
    expect(a.jockeys.get(1)).toEqual({ jockey_name: "騎手ウ", jockey_id: "01234" });
    expect(a.jockeys.get(2)).toEqual({ jockey_name: null, jockey_id: null });
    // スナップショットが null の詳細は ok のまま、列がすべて null(詳細なし〈none〉とは別)
    expect(b.race).toEqual({ race_name: null, grade: null, distance: null, track_condition: null });
    expect(b.horses.size).toBe(0);
    expect(out.gets).toBe(2);
    expect(spy.calls.map((c) => c.op)).toEqual(["get", "get"]);
    // 人名・馬名は取り出した結果のどこにも無い
    expect(JSON.stringify(out.outcomes.map((o) => (o.kind === "ok" ? { race: o.snapshot.race, horses: [...o.snapshot.horses.values()] } : null)))).not.toContain("SECRET");
  });

  it("R2 の get が例外のときは failed(none にしない。再試行できる)", async () => {
    await analyses().saveAnalysis(mkRecord(1));
    const spy = spyBucket(local.r2, { failGet: true });
    const out = await store(spy.bucket as unknown as PriorExportBucket).fetchDetails([{ id: 1, raceId: mkRecord(1).raceId, detailKey: "analyses/1.json.gz" }]);
    expect(out.outcomes).toEqual([{ kind: "failed" }]);
    expect(out.gets).toBe(1);
  });
});

describe("Class A・B の計数と put", () => {
  it("countReads は今月(UTC)の class_b に加算する(0 回なら D1 に何も発行しない)。readUsage で読める", async () => {
    const spy = spyDb(local.db);
    const s = store(local.r2, spy.db as never);
    await s.countReads(0);
    expect(spy.prepared).toEqual([]);
    await s.countReads(30);
    await s.countReads(5);
    expect(await s.readUsage()).toEqual({ classA: 0, classB: 35 });
  });

  const INFO = { generatedAt: "2026-10-10T12:00:00.000Z", rows: 3, races: 1 };

  it("putFileStream は class_a を 1 数えてから、塊を 1 つずつ流して固定キーに put する(メタデータつき)。上書きは 1 つのオブジェクトのまま", async () => {
    const sb = streamBucket(local.r2);
    const s = store(sb.bucket);
    const read: number[] = [];
    await s.putFileStream("exports/prior-dataset.ndjson.gz", function* () { for (const p of [[1, 2], [3], [4, 5, 6]]) { read.push(p.length); yield new Uint8Array(p); } }, 6, INFO);
    await s.putFileStream("exports/prior-dataset.ndjson.gz", () => [new Uint8Array([4, 5])], 2, { generatedAt: "2026-10-10T13:00:00.000Z", rows: 2, races: 1 });
    expect(read).toEqual([2, 1, 3]);
    expect(await s.readUsage()).toEqual({ classA: 2, classB: 0 });
    expect(sb.keys).toEqual(["exports/prior-dataset.ndjson.gz", "exports/prior-dataset.ndjson.gz"]);
    expect([...sb.bodies[0]!]).toEqual([1, 2, 3, 4, 5, 6]);
    const obj = await local.r2.get("exports/prior-dataset.ndjson.gz");
    expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([4, 5]);
    expect(obj!.customMetadata).toMatchObject({ generatedAt: "2026-10-10T13:00:00.000Z", rows: "2", races: "1" });
  });

  it("Class A は put の前に数える: 流している途中の例外・総バイト数の食い違い・put の失敗でも数え、例外を投げる。固定キーの古いファイルは変わらない", async () => {
    const sb = streamBucket(local.r2);
    const s = store(sb.bucket);
    await s.putFileStream("k", () => [new Uint8Array([7])], 1, INFO); // 古いファイル
    const before = (await s.readUsage()).classA;
    await expect(s.putFileStream("k", function* () { yield new Uint8Array([1, 1]); throw new Error("塊が失われています"); }, 4, INFO)).rejects.toThrow();
    await expect(s.putFileStream("k", () => [new Uint8Array([1, 1])], 5, INFO)).rejects.toThrow(); // 宣言より短い
    await expect(s.putFileStream("k", () => [new Uint8Array([1, 1, 1])], 2, INFO)).rejects.toThrow(); // 宣言より長い
    // 宣言した長さをちょうど流したあとに例外になっても、put は失敗として終わり、古いファイルを上書きしない
    await expect(s.putFileStream("k", function* () { yield new Uint8Array([2, 2]); throw new Error("最後の塊の後で例外"); }, 2, INFO)).rejects.toThrow("最後の塊の後で例外");
    const spy = spyBucket(local.r2, { failPut: () => true });
    await expect(store(spy.bucket as unknown as PriorExportBucket).putFileStream("k", () => [new Uint8Array([1])], 1, INFO)).rejects.toThrow();
    expect((await s.readUsage()).classA).toBe(before + 5);
    const obj = await local.r2.get("k");
    expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([7]);
  });
});
