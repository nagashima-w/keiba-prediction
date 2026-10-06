import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSaveStatements } from "../src/analysis-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #175: 1回の保存が D1 に書く行数(`meta.rows_written`)の測定。`docs/current-spec.md` の「書き込み行数」(#171 では約 60 行の暫定値で、
 * リポジトリに再現手段が無かった)を、**このテストで確定する**。再現: `cd cloud && pnpm exec vitest run test/rows-written.test.ts`。
 *
 * 内訳(16 頭・買い目 10 件・配分あり): R2 の操作回数のカウンタ 1(`r2_ops` の upsert。#173。`ym INTEGER PRIMARY KEY` なので索引なし。月の最初の保存は INSERT、以降は UPDATE で、どちらも 1 行)・
 * analyses 5(表 1 + 索引 3〈idx_analyses_race・kaisai_date・prompt_version_race〉+ sqlite_sequence 1)・
 * detail_key の UPDATE 1・馬 32(16 頭 × 2。複合主キーの自動索引で行が2倍)・配分メタ 1(`analysis_id INTEGER PRIMARY KEY` なので索引なし)・買い目 20(10 件 × 2)= 60。
 * 一般式: 1 + 5 + 1 + 2H + (配分ありなら 1 + 2B)(H = 馬の数、B = 買い目の数)。R2 に書かない保存(柵でスキップ)はカウンタと detail_key の UPDATE が無く、5 + 2H + (配分ありなら 1 + 2B)。
 * #171 の暫定値(約 60 行)・#175 の 59 行(カウンタなし)の後継。
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
  const results = await local.db.batch(buildSaveStatements(local.db, rec, 202610));
  return results.map((r) => r.meta.rows_written);
}

describe("1回の保存の D1 の書き込み行数(meta.rows_written)", () => {
  it("16 頭・買い目 10 件・配分あり: 文ごとに [1, 5, 1, 32, 1, 20]、合計 60(カウンタ 1 行が加わり、#175 の 59 行から 60 行)", async () => {
    const per = await rowsWritten(record(16, 10));
    expect(per).toEqual([1, 5, 1, 32, 1, 20]);
    expect(per.reduce((a, b) => a + b, 0)).toBe(60);
  });

  it("カウンタは、月の最初の保存(INSERT)でも、2 回目以降(UPDATE)でも 1 行", async () => {
    const first = await rowsWritten(record(2, null));
    const second = await rowsWritten(record(2, null));
    expect(first[0]).toBe(1);
    expect(second[0]).toBe(1);
    // 前提: 2 回目は実際に UPDATE 経由(r2_ops の行は 1 つのまま、Class A が 2)
    const row = await local.db.prepare("SELECT count(*) AS c, max(class_a) AS a FROM r2_ops").first<{ c: number; a: number }>();
    expect(row).toEqual({ c: 1, a: 2 });
  });

  it("一般式 1 + 5 + 1 + 2H + (配分ありなら 1 + 2B)に従う(H=18・B=60 は 164、配分なしの H=16 は 39)", async () => {
    expect((await rowsWritten(record(18, 60))).reduce((a, b) => a + b, 0)).toBe(1 + 5 + 1 + 2 * 18 + 1 + 2 * 60);
    await local.reset();
    expect((await rowsWritten(record(16, null))).reduce((a, b) => a + b, 0)).toBe(1 + 5 + 1 + 2 * 16);
    await local.reset();
    // 買い目 0 件でも配分メタの 1 行は書く(買い目の文は 0 行)
    expect(await rowsWritten(record(16, 0))).toEqual([1, 5, 1, 32, 1, 0]);
  });

  it("R2 に書かない保存(柵でスキップ。カウンタ・detail_key の UPDATE なし): 5 + 2H + (配分ありなら 1 + 2B) = 16 頭・買い目 10 件で 58", async () => {
    const results = await local.db.batch(buildSaveStatements(local.db, record(16, 10), null));
    const per = results.map((r) => r.meta.rows_written);
    expect(per).toEqual([5, 32, 1, 20]);
    expect(per.reduce((a, b) => a + b, 0)).toBe(58);
  });
});
