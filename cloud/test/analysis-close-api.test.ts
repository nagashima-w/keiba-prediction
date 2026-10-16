import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CloseSavePayload } from "../src/analysis-close";
import { D1AnalysisStore } from "../src/analysis-repository";
import { handle, type Env } from "../src/handler";
import { contractCases } from "./fixtures-contract";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #338(#335-A1): 実際の `handle()` の `GET /api/analyses/{id}` が、締切の直前の再計算の結果を `close` で返す(ローカルの D1・R2)。
 * 結果が無い分析は null、表が無い(migration の適用前に Worker が先に出た)ときは close だけ null で、ほかの応答は壊れない。
 */

const ORIGIN = "https://cloud.invalid";
const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

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

async function get(id: number, db: Env["DB"] = local.db as Env["DB"]): Promise<{ status: number; body: Record<string, any> }> {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  const env: Env = {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: db,
    ANALYSIS_DETAIL: local.r2 as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
  };
  const response = await handle(new Request(`${ORIGIN}/api/analyses/${id}`, { method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": "same-origin" } }), env, {}, deps);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const store = (): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
const BASE_META = contractCases[0]!.record.allocation!.meta;
const DUE = Date.parse("2026-10-17T06:40:00Z");

function okPayload(round: 1 | 2, bets: { betType: string; comboKey: string; stake: number }[]): CloseSavePayload {
  return {
    round,
    status: "ok",
    reason: null,
    dueAtMs: DUE,
    firedAtMs: DUE + 3000,
    lateMs: 3000,
    oddsOfficialDatetime: "2026-10-17 15:41:30",
    allocation: { meta: { ...BASE_META, route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, oddsStatus: "middle" }, bets: bets.map((b) => ({ ...b, odds: 3, ev: 1.2 })) },
  };
}

describe("GET /api/analyses/{id} の close(Issue #338)", () => {
  it("結果が無い分析は close: null。ほかの応答(allocation など)は従来どおり", async () => {
    const saved = await store().saveAnalysis(contractCases[0]!.record);
    const { status, body } = await get(saved.id);
    expect(status).toBe(200);
    expect(body.analysis.close).toBeNull();
    expect(body.analysis.allocation).not.toBeNull();
  });

  it("2 回ぶんの結果(ok と skipped)が、回の昇順で、状態・時刻・遅れ・配分・差分つきで返る。分析時の提案(allocation)は変わらない", async () => {
    const saved = await store().saveAnalysis(contractCases[0]!.record);
    const baseBets = (await store().getStoredAllocation(saved.id))!.bets;
    expect(baseBets.length).toBeGreaterThan(1); // 前提
    await store().saveClose(saved.id, okPayload(2, [{ betType: "place", comboKey: "05", stake: 400 }]));
    await store().saveClose(saved.id, { round: 1, status: "skipped", reason: "too-late", dueAtMs: DUE, firedAtMs: DUE + 1, lateMs: 1, oddsOfficialDatetime: null, allocation: null });
    const { status, body } = await get(saved.id);
    expect(status).toBe(200);
    const close = body.analysis.close;
    expect(close.rounds.map((r: any) => [r.round, r.leadMinutes, r.status, r.reason])).toEqual([
      [1, 5, "skipped", "too-late"],
      [2, 2, "ok", null],
    ]);
    expect(close.rounds[0].allocation).toBeNull();
    expect(close.rounds[0].diff).toBeNull();
    const second = close.rounds[1];
    expect(second).toMatchObject({ dueAt: "2026-10-17T06:40:00.000Z", firedAt: "2026-10-17T06:40:03.000Z", lateMs: 3000, oddsOfficialDatetime: "2026-10-17 15:41:30" });
    expect(second.allocation.bets).toEqual([{ betType: "place", comboKey: "05", stake: 400, odds: 3, ev: 1.2 }]);
    expect(second.diff.added).toHaveLength(1);
    expect(second.diff.removed).toHaveLength(baseBets.length);
    expect(second.diff.hasChange).toBe(true);
    // 分析時の提案は、締切の結果を保存した前後で同じ
    expect(body.analysis.allocation.bets).toEqual(baseBets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })));
  });

  it("D1 に締切の表が無い(migration の適用前)ときは、close だけ null で 200。ほかの応答は壊れない", async () => {
    const saved = await store().saveAnalysis(contractCases[0]!.record);
    await store().saveClose(saved.id, okPayload(1, [{ betType: "place", comboKey: "05", stake: 400 }]));
    // 締切の表を読む文だけ失敗する D1 の窓口(表が無い状況の模擬)
    const real = local.db;
    const tagged = new WeakSet<object>();
    const failing = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          const statement = real.prepare(sql).bind(...values);
          if (/analysis_close/.test(sql)) tagged.add(statement);
          return statement;
        },
      }),
      batch: (statements: D1PreparedStatement[]) => {
        if (statements.some((statement) => tagged.has(statement))) {
          return Promise.reject(new Error("D1_ERROR: no such table: analysis_close"));
        }
        return real.batch(statements);
      },
    } as unknown as Env["DB"];
    const { status, body } = await get(saved.id, failing);
    expect(status).toBe(200);
    expect(body.analysis.close).toBeNull();
    expect(body.analysis.allocation).not.toBeNull();
    expect(body.analysis.horses.length).toBeGreaterThan(0);
  });
});
