import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertClosePayload, type CloseSavePayload } from "../src/analysis-close";
import { D1AnalysisStore } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import type { AnalysisAllocationRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #338(#335-A1): 締切の直前の再計算の結果の保存と読み出し(D1 の `analysis_close`・`analysis_close_bets`。migration 0019)。
 * ローカル(workerd)の D1 で、CI と同じ実コマンドの migration を適用して確かめる。分析時の提案の行(`analysis_allocation_meta`・`analysis_bets`)は上書きしない。
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

/** 分析時の提案(フィクスチャ)を保存して id を得る。 */
async function saveBase(): Promise<number> {
  const saved = await store().saveAnalysis(contractCases[0]!.record);
  return saved.id;
}

const BASE_META = contractCases[0]!.record.allocation!.meta;

function allocation(stakes: readonly number[], oddsStatus = "middle"): AnalysisAllocationRecord {
  return {
    meta: { ...BASE_META, route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, bankroll: 100000, perRaceCap: 30000, oddsStatus },
    bets: stakes.map((stake, i) => ({ betType: i % 2 === 0 ? "place" : "wide", comboKey: i % 2 === 0 ? `0${i + 1}` : `010${i + 1}`, stake, odds: 2.5 + i, ev: 1.1 + i / 100 })),
  };
}

const DUE = Date.parse("2026-10-17T06:40:00Z");

function okPayload(round: 1 | 2, stakes: readonly number[], extra: Partial<CloseSavePayload> = {}): CloseSavePayload {
  return { round, status: "ok", reason: null, dueAtMs: DUE, firedAtMs: DUE + 1500, lateMs: 1500, oddsOfficialDatetime: "2026-10-17 15:41:30", allocation: allocation(stakes), ...extra };
}

async function count(table: string): Promise<number> {
  return (await local.db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
}

describe("D1AnalysisStore.saveClose / getStoredClose(Issue #338)", () => {
  it("ok の回を保存して読み戻せる: 状態・時刻・遅れ・配分(メタと買い目)が、分析時の提案と同じ形で戻る", async () => {
    const id = await saveBase();
    await store().saveClose(id, okPayload(1, [300, 200, 100]));
    const rounds = await store().getStoredClose(id);
    expect(rounds).toHaveLength(1);
    const r = rounds[0]!;
    expect(r).toMatchObject({ round: 1, status: "ok", reason: null, dueAt: "2026-10-17T06:40:00.000Z", firedAt: "2026-10-17T06:40:01.500Z", lateMs: 1500, oddsOfficialDatetime: "2026-10-17 15:41:30" });
    expect(r.allocation).not.toBeNull();
    expect(r.allocation!.route).toBe("mixed");
    expect(r.allocation!.bankroll).toBe(100000);
    expect(r.allocation!.oddsStatus).toBe("middle");
    expect(r.allocation!.includeComboOdds).toBe(BASE_META.includeComboOdds);
    expect(r.allocation!.includeBracketQuinella).toBe(BASE_META.includeBracketQuinella);
    expect(r.allocation!.bets.map((b) => `${b.betType}:${b.comboKey}:${b.stake}:${b.odds}`)).toEqual(["place:01:300:2.5", "wide:0102:200:3.5", "place:03:100:4.5"].sort((a, b) => (a < b ? -1 : 1)));
    // 前提: 買い目が複数券種・複数点(退化していない)
    expect(r.allocation!.bets.length).toBe(3);
  });

  it("failed・skipped の回は、理由つきで配分なしの 1 行になり、買い目の行は作られない", async () => {
    const id = await saveBase();
    await store().saveClose(id, { round: 1, status: "failed", reason: "blocked", dueAtMs: DUE, firedAtMs: DUE + 10, lateMs: 10, oddsOfficialDatetime: null, allocation: null });
    await store().saveClose(id, { round: 2, status: "skipped", reason: "too-late", dueAtMs: DUE, firedAtMs: DUE + 5000, lateMs: 5000, oddsOfficialDatetime: null, allocation: null });
    const rounds = await store().getStoredClose(id);
    expect(rounds.map((r) => [r.round, r.status, r.reason, r.allocation])).toEqual([
      [1, "failed", "blocked", null],
      [2, "skipped", "too-late", null],
    ]);
    expect(await count("analysis_close_bets")).toBe(0);
  });

  it("Issue #379: combo-missing(failed)を保存して読める(migration なしで通る=理由の列に CHECK が無い)。Issue #338 の時点で書かれた旧い nar-unsupported の skipped 行も、理由つきで読める", async () => {
    const id = await saveBase();
    await store().saveClose(id, { round: 1, status: "failed", reason: "combo-missing", dueAtMs: DUE, firedAtMs: DUE + 10, lateMs: 10, oddsOfficialDatetime: null, allocation: null });
    // 旧い行(Issue #338 の Worker が書いた形)を直接入れる。新しい Worker は nar-unsupported を書かないが、読めなければならない
    await local.db
      .prepare("INSERT INTO analysis_close (analysis_id, round, status, reason, due_at, fired_at, late_ms) VALUES (?, 2, 'skipped', 'nar-unsupported', '2026-06-28T06:43:00.000Z', '2026-06-28T06:43:00.000Z', 0)")
      .bind(id)
      .run();
    const rounds = await store().getStoredClose(id);
    expect(rounds.map((r) => [r.round, r.status, r.reason, r.allocation])).toEqual([
      [1, "failed", "combo-missing", null],
      [2, "skipped", "nar-unsupported", null],
    ]);
  });

  it("2 回ぶん(回 1・回 2)が別の行になり、回の昇順で戻る(買い目は回ごとに分かれる)", async () => {
    const id = await saveBase();
    await store().saveClose(id, okPayload(2, [500]));
    await store().saveClose(id, okPayload(1, [300, 200]));
    const rounds = await store().getStoredClose(id);
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rounds[0]!.allocation!.bets).toHaveLength(2);
    expect(rounds[1]!.allocation!.bets).toHaveLength(1);
    expect(await count("analysis_close")).toBe(2);
  });

  it("同じ (分析, 回) を保存し直すと上書きされ、前の買い目は残らない(冪等: アラームは少なくとも 1 回は実行される)", async () => {
    const id = await saveBase();
    await store().saveClose(id, okPayload(1, [300, 200, 100]));
    await store().saveClose(id, okPayload(1, [700]));
    const rounds = await store().getStoredClose(id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.allocation!.bets.map((b) => b.stake)).toEqual([700]);
    expect(await count("analysis_close_bets")).toBe(1);
    // 同じ内容の再保存も 1 行のまま
    await store().saveClose(id, okPayload(1, [700]));
    expect(await count("analysis_close")).toBe(1);
    expect(await count("analysis_close_bets")).toBe(1);
  });

  it("ok の回を、後から failed で保存し直すと、買い目も配分のメタも消える", async () => {
    const id = await saveBase();
    await store().saveClose(id, okPayload(1, [300, 200]));
    await store().saveClose(id, { round: 1, status: "failed", reason: "fetch-failed", dueAtMs: DUE, firedAtMs: DUE + 10, lateMs: 10, oddsOfficialDatetime: null, allocation: null });
    const row = await local.db.prepare("SELECT status, reason, route, bankroll FROM analysis_close WHERE analysis_id = ?").bind(id).first<{ status: string; reason: string; route: string | null; bankroll: number | null }>();
    expect(row).toEqual({ status: "failed", reason: "fetch-failed", route: null, bankroll: null });
    expect(await count("analysis_close_bets")).toBe(0);
  });

  it("分析時の提案の行(analysis_allocation_meta・analysis_bets)は、保存の前後で 1 バイトも変わらない", async () => {
    const id = await saveBase();
    const snapshot = async () => ({
      meta: (await local.db.prepare("SELECT * FROM analysis_allocation_meta WHERE analysis_id = ?").bind(id).all()).results,
      bets: (await local.db.prepare("SELECT * FROM analysis_bets WHERE analysis_id = ? ORDER BY bet_type, combo_key").bind(id).all()).results,
    });
    const before = JSON.stringify(await snapshot());
    expect(JSON.parse(before).bets.length).toBeGreaterThan(0); // 前提: 比べる行がある
    await store().saveClose(id, okPayload(1, [900, 800]));
    expect(JSON.stringify(await snapshot())).toBe(before);
    expect((await store().getStoredAllocation(id))!.bets.length).toBe(JSON.parse(before).bets.length);
  });

  it("結果の無い分析は空の配列を返す。存在しない分析 id への保存は拒否され、何も書かれない(外部キー)", async () => {
    const id = await saveBase();
    expect(await store().getStoredClose(id)).toEqual([]);
    await expect(store().saveClose(id + 999, okPayload(1, [100]))).rejects.toThrow();
    expect(await count("analysis_close")).toBe(0);
    expect(await count("analysis_close_bets")).toBe(0);
  });

  it("D1 の文は 1 回の batch に 3 文(行の UPSERT・買い目の削除・買い目の挿入)で、買い目の数によらず一定。買い目が無い回は 2 文", async () => {
    const id = await saveBase();
    const spy = spyDb(local.db);
    const spied = new D1AnalysisStore({ db: spy.db, bucket: local.r2 });
    await spied.saveClose(id, okPayload(1, Array.from({ length: 40 }, (_, i) => 100 + i)));
    await spied.saveClose(id, { round: 2, status: "skipped", reason: "unset", dueAtMs: DUE, firedAtMs: DUE, lateMs: 0, oddsOfficialDatetime: null, allocation: null });
    expect(spy.batches).toEqual([3, 2]);
    expect(await count("analysis_close_bets")).toBe(40);
  });

  it("不整合な結果(ok なのに配分なし・failed に skipped の理由・skipped に配分)は、書かずに拒否される", async () => {
    const id = await saveBase();
    const bad: CloseSavePayload[] = [
      okPayload(1, [100], { allocation: null }),
      okPayload(1, [100], { reason: "blocked" }),
      { ...okPayload(1, [100]), status: "failed", reason: "too-late", allocation: null },
      { ...okPayload(1, [100]), status: "skipped", reason: "unset" },
      { ...okPayload(1, [100]), status: "failed", reason: null, allocation: null },
      okPayload(0 as 1, [100]),
    ];
    for (const payload of bad) {
      expect(() => assertClosePayload(payload)).toThrow();
      await expect(store().saveClose(id, payload)).rejects.toThrow();
    }
    expect(await count("analysis_close")).toBe(0);
  });

  it("AnalysisSink(createAnalysisSink)経由でも保存できる", async () => {
    const id = await saveBase();
    const sink = createAnalysisSink(store());
    expect(sink.saveClose).toBeDefined();
    await sink.saveClose!(id, okPayload(1, [100]));
    expect((await store().getStoredClose(id))[0]!.status).toBe("ok");
  });

  it("壊れた行(未知の状態・ok なのにメタ列が欠けた行)は読み出しから除かれ、未知の理由は null にする", async () => {
    const id = await saveBase();
    await store().saveClose(id, okPayload(1, [100]));
    // 直接 SQL で壊す(CHECK 制約は status だけなので、メタ列の欠けは作れる)
    await local.db.prepare("UPDATE analysis_close SET route = NULL WHERE analysis_id = ? AND round = 1").bind(id).run();
    await store().saveClose(id, { round: 2, status: "failed", reason: "compute-failed", dueAtMs: DUE, firedAtMs: DUE, lateMs: 0, oddsOfficialDatetime: null, allocation: null });
    await local.db.prepare("UPDATE analysis_close SET reason = 'unknown-word' WHERE analysis_id = ? AND round = 2").bind(id).run();
    const rounds = await store().getStoredClose(id);
    expect(rounds.map((r) => [r.round, r.status, r.reason])).toEqual([[2, "failed", null]]);
  });
});
