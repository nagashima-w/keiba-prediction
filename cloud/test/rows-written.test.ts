import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSaveStatements } from "../src/analysis-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #175: 1回の保存が D1 に書く行数(`meta.rows_written`)の測定。`docs/current-spec.md` の「書き込み行数」(#171 では約 60 行の暫定値で、
 * リポジトリに再現手段が無かった)を、**このテストで確定する**。再現: `cd cloud && pnpm exec vitest run test/rows-written.test.ts`。
 *
 * 内訳(16 頭・買い目 10 件・配分あり): analyses 5(表 1 + 索引 3〈idx_analyses_race・kaisai_date・prompt_version_race〉+ sqlite_sequence 1)・
 * detail_key の UPDATE 1・馬 32(16 頭 × 2。複合主キーの自動索引で行が2倍)・配分メタ 1(`analysis_id INTEGER PRIMARY KEY` なので索引なし)・買い目 20(10 件 × 2)= 59。
 * 一般式: 5 + 1 + 2H + (配分ありなら 1 + 2B)(H = 馬の数、B = 買い目の数)。#173 のカウンタ(1 行)が加われば 60。
 *
 * 限界: ローカルの workerd の D1 が報告する値で、本番の D1 が数える行数と同じとは限らない(公式ドキュメントには「索引は書き込み行を追加する」とある。
 * 最初の本番の実保存の `meta.rows_written` で確かめる)。Free の 10 万行/日に対して、中央の全レース約 36 件/日なら 59 × 36 ≒ 2,100 行で約 2%。
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

function record(nHorses: number, nBets: number | null): AnalysisRecord {
  const base: AnalysisRecord = {
    raceId: "202603020211",
    analyzedAt: "2026-10-06T09:00:00.000Z",
    kaisaiDate: "20261006",
    promptVersion: "v-test",
    horses: Array.from({ length: nHorses }, (_, k) => ({ umaban: k + 1, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 2, ev: 1, isPositive: false, contributions: null, mark: null, reason: "r" })),
  };
  if (nBets === null) {
    return base;
  }
  return { ...base, allocation: { meta: contractCases[0]!.record.allocation!.meta, bets: Array.from({ length: nBets }, (_, b) => ({ betType: "wide", comboKey: `0${b}`, stake: 100, odds: 5, ev: 1.1 })) } };
}

async function rowsWritten(rec: AnalysisRecord): Promise<number[]> {
  const results = await local.db.batch(buildSaveStatements(local.db, rec));
  return results.map((r) => r.meta.rows_written);
}

describe("1回の保存の D1 の書き込み行数(meta.rows_written)", () => {
  it("16 頭・買い目 10 件・配分あり: 文ごとに [5, 1, 32, 1, 20]、合計 59", async () => {
    const per = await rowsWritten(record(16, 10));
    expect(per).toEqual([5, 1, 32, 1, 20]);
    expect(per.reduce((a, b) => a + b, 0)).toBe(59);
  });

  it("一般式 5 + 1 + 2H + (配分ありなら 1 + 2B)に従う(H=18・B=60 は 163、配分なしの H=16 は 38)", async () => {
    expect((await rowsWritten(record(18, 60))).reduce((a, b) => a + b, 0)).toBe(5 + 1 + 2 * 18 + 1 + 2 * 60);
    await local.reset();
    expect((await rowsWritten(record(16, null))).reduce((a, b) => a + b, 0)).toBe(5 + 1 + 2 * 16);
    await local.reset();
    // 買い目 0 件でも配分メタの 1 行は書く(買い目の文は 0 行)
    expect(await rowsWritten(record(16, 0))).toEqual([5, 1, 32, 1, 0]);
  });
});
