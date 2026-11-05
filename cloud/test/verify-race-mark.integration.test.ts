import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1ResultStore } from "../src/result-repository";
import { D1VerifyStore } from "../src/verify-store";
import { MARK_VERIFY_BY_ANALYSIS_IDS_SQL, MARK_VERIFY_RACES_SQL } from "../src/verify-race-mark";
import type { CloseSavePayload } from "../src/analysis-close";
import { contractCases } from "./fixtures-contract";
import type { AnalysisRecord, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #624(#616 の段階 1): 検証が読む表に書く 8 つの経路は、batch の最後に「そのレースの変更の印」(verify_race_mark)を付ける。
 * 経路ごとに「batch の最後の文が印である」「実行後に印の seq が増える」ことと、印の性質(開催日は分析の最小・seq は重ならない・既にあるレースは新しい seq)を固定する。
 * ★限界: ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しない。文の数は記録した値で assert する。
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
const RACE_A = "202606030811";
const RACE_B = "202606030812";
const RACE_C = "202606030813";

function mkRecord(raceId: string, kaisaiDate = "20261001"): AnalysisRecord {
  return {
    raceId,
    analyzedAt: "2026-10-01T00:00:00.000Z",
    kaisaiDate,
    promptVersion: "v-test",
    raceSnapshot: { race: { raceName: "x" } },
    horses: [{ umaban: 1, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null }],
  };
}

const entry = (umaban: number, over: Partial<RaceResultEntry> = {}): RaceResultEntry => ({ umaban, finishPosition: umaban, ...over });

interface Mark {
  readonly race_id: string;
  readonly kaisai_date: string | null;
  readonly seq: number;
}
async function marks(): Promise<Mark[]> {
  return (await local.db.prepare("SELECT race_id, kaisai_date, seq FROM verify_race_mark ORDER BY seq").all<Mark>()).results;
}
const seqOf = async (raceId: string): Promise<number | undefined> => (await marks()).find((m) => m.race_id === raceId)?.seq;

const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => NOW });
const results = () => new D1ResultStore({ db: local.db });

/** 最後の batch の文の SQL の並び。 */
const lastBatch = (spy: ReturnType<typeof spyDb>): string[] => spy.batchSqls[spy.batchSqls.length - 1]!;

describe("経路ごとの印(batch の最後の文が印で、実行後に seq が増える)", () => {
  it("saveAnalysis: 最後の文が印。開催日は分析のもの。保存のたびに seq が増える(同じレースの再保存も新しい seq)", async () => {
    const spy = spyDb(local.db);
    const store = new D1AnalysisStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    await store.saveAnalysis(mkRecord(RACE_A));
    expect(lastBatch(spy).at(-1)).toBe(MARK_VERIFY_RACES_SQL);
    expect(await marks()).toEqual([{ race_id: RACE_A, kaisai_date: "20261001", seq: 1 }]);
    await store.saveAnalysis(mkRecord(RACE_B));
    expect(await seqOf(RACE_B)).toBe(2);
    await store.saveAnalysis(mkRecord(RACE_A));
    expect(await seqOf(RACE_A)).toBe(3); // 既にあるレースは UPDATE で seq が新しくなる
    expect((await marks()).map((m) => m.race_id)).toEqual([RACE_B, RACE_A]);
  });

  it("saveResult: 最後の文が印。結果が空で組合せ払戻だけのときも印が付く。書く文が無ければ印も無い(batch 自体が無い)", async () => {
    const spy = spyDb(local.db);
    const store = new D1ResultStore({ db: spy.db });
    await store.saveResult(RACE_A, [entry(1)]);
    expect(lastBatch(spy).at(-1)).toBe(MARK_VERIFY_RACES_SQL);
    expect(await seqOf(RACE_A)).toBe(1);
    const batchesBefore = spy.batches.length;
    await store.saveResult(RACE_B, [], null, { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }] } } as never);
    expect(spy.batches.length).toBe(batchesBefore + 1); // 前提: 組合せ払戻だけでも batch は流れている
    expect(lastBatch(spy).at(-1)).toBe(MARK_VERIFY_RACES_SQL);
    expect(await seqOf(RACE_B)).toBe(2);
    await store.saveResult(RACE_C, []); // 書く文が無い
    expect(spy.batches.length).toBe(batchesBefore + 1);
    expect(await seqOf(RACE_C)).toBeUndefined();
  });

  it.each([
    ["saveWinOdds", (s: D1ResultStore) => s.saveWinOdds(RACE_A, [entry(1, { winOdds: 3.5, ninki: 1 })])],
    ["saveScratched", (s: D1ResultStore) => s.saveScratched(RACE_A, [entry(1, { finishPosition: null, scratched: true })])],
    ["saveWinPayout", (s: D1ResultStore) => s.saveWinPayout(RACE_A, [entry(1, { winPayout: 350 })])],
    ["saveRaceClass", (s: D1ResultStore) => s.saveRaceClass(RACE_A, "G1")],
  ] as const)("%s: 最後の文が印で、実行後に seq が増える。書く文が無い入力では印も付かない", async (_name, call) => {
    const spy = spyDb(local.db);
    const store = new D1ResultStore({ db: spy.db });
    await results().saveResult(RACE_B, [entry(1)]); // 別のレースの印(seq 1)
    await call(store);
    expect(lastBatch(spy).at(-1)).toBe(MARK_VERIFY_RACES_SQL);
    expect(await seqOf(RACE_A)).toBe(2);
    await call(store); // 同じレースの 2 回目(補完は冪等で何も書かなくても、文は流れる)も seq が新しくなる
    expect(await seqOf(RACE_A)).toBe(3);
  });

  it("書く文が無い入力(オッズ無し・クラス無し)では印を付けない", async () => {
    const store = results();
    await store.saveWinOdds(RACE_A, [entry(1)]);
    await store.saveWinPayout(RACE_A, [entry(1)]);
    await store.saveRaceClass(RACE_A, null);
    await store.saveRaceClass(RACE_A, "");
    expect(await marks()).toEqual([]);
  });

  it("commitStartTimes: 最後の文(Class B のカウントの前)に印。複数レースを 1 文で書き、seq は「表の最大値 + 行番号」で重ならない。既にあるレースは新しい seq", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A)); // id 1: 印 seq 1
    await analyses().saveAnalysis(mkRecord(RACE_A)); // id 2: 同じレース: 印 seq 2
    await analyses().saveAnalysis(mkRecord(RACE_B)); // id 3: 印 seq 3
    await analyses().saveAnalysis(mkRecord(RACE_C)); // id 4: 印 seq 4
    expect(Object.fromEntries((await marks()).map((m) => [m.race_id, m.seq]))).toEqual({ [RACE_A]: 2, [RACE_B]: 3, [RACE_C]: 4 }); // 前提
    const spy = spyDb(local.db);
    const verify = new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    // id 1・2 は同じレース(A)、id 3 は B。C は触れない。
    await verify.commitStartTimes([{ id: 1, value: "15:45" }, { id: 2, value: "15:45" }, { id: 3, value: "16:00" }], 3);
    const batch = lastBatch(spy);
    expect(batch.filter((sql) => sql === MARK_VERIFY_BY_ANALYSIS_IDS_SQL)).toHaveLength(1); // 印はレース数ではなく 1 文
    expect(batch.indexOf(MARK_VERIFY_BY_ANALYSIS_IDS_SQL)).toBe(batch.length - 2); // 末尾の Class B のカウントの直前
    const after = await marks();
    const max = 4; // 書く前の seq の最大値
    const touched = after.filter((m) => m.race_id !== RACE_C);
    expect(touched.map((m) => m.race_id).sort()).toEqual([RACE_A, RACE_B]); // 前提: 2 レース(重複を除いた数)
    expect(touched.map((m) => m.seq).sort()).toEqual([max + 1, max + 2]); // 最大値 + 行番号(1, 2)。重ならない
    expect(after.find((m) => m.race_id === RACE_C)!.seq).toBe(4); // 触れていないレースは変わらない
    expect(new Set(after.map((m) => m.seq)).size).toBe(after.length); // 全体でも seq は一意
  });

  it("commitStartTimes: 取得の数(gets)だけで書く行が無ければ印も付かない", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A));
    const before = await marks();
    const verify = new D1VerifyStore({ db: local.db, bucket: local.r2, now: () => NOW });
    await verify.commitStartTimes([], 2);
    expect(await marks()).toEqual(before);
  });

  it("saveClose: 最後の文が印(分析 id からレースを引く)で、実行後に seq が増える", async () => {
    const saved = await analyses().saveAnalysis(contractCases[0]!.record);
    const raceId = contractCases[0]!.record.raceId;
    const seqBefore = await seqOf(raceId);
    const spy = spyDb(local.db);
    const store = new D1AnalysisStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    const payload: CloseSavePayload = { round: 1, status: "skipped", reason: "too-late", dueAtMs: 1, firedAtMs: 2, lateMs: 1, oddsOfficialDatetime: null, allocation: null };
    await store.saveClose(saved.id, payload);
    expect(lastBatch(spy).at(-1)).toBe(MARK_VERIFY_BY_ANALYSIS_IDS_SQL);
    expect(await seqOf(raceId)).toBe(seqBefore! + 1);
  });
});

describe("印の性質", () => {
  it("分析の行がまだ無いレース(結果が先に来る)でも失敗せず、開催日は NULL。後から分析が入ると開催日が入る", async () => {
    await results().saveResult(RACE_A, [entry(1)]);
    expect(await marks()).toEqual([{ race_id: RACE_A, kaisai_date: null, seq: 1 }]);
    await analyses().saveAnalysis(mkRecord(RACE_A, "20261003"));
    expect(await marks()).toEqual([{ race_id: RACE_A, kaisai_date: "20261003", seq: 2 }]);
  });

  it("開催日は、そのレースの分析の最小の開催日(日付違いの分析が 2 つあっても)", async () => {
    await analyses().saveAnalysis(mkRecord(RACE_A, "20261005"));
    await analyses().saveAnalysis(mkRecord(RACE_A, "20261002"));
    expect(await marks()).toEqual([{ race_id: RACE_A, kaisai_date: "20261002", seq: 2 }]);
  });
});

describe("書き込みの行数(印 1 回の増分。測定)", () => {
  it("印の 1 文の rows_written: 新規・更新とも", async () => {
    const insert = await local.db.prepare(MARK_VERIFY_RACES_SQL).bind(JSON.stringify([RACE_A])).run();
    const update = await local.db.prepare(MARK_VERIFY_RACES_SQL).bind(JSON.stringify([RACE_A])).run();
    const two = await local.db.prepare(MARK_VERIFY_RACES_SQL).bind(JSON.stringify([RACE_B, RACE_C])).run();
    // 測定(ローカルの D1): 1 レースの印は、表と seq の索引で 2 行。新規でも更新でも同じ(更新も seq の索引を書き換える)。
    expect(insert.meta.rows_written).toBe(2);
    expect(update.meta.rows_written).toBe(2);
    expect(two.meta.rows_written).toBe(4);
  });
});
