import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AnalysisStore,
  type AnalysisRecord,
  type StoredAllocation,
  type StoredAnalysis,
} from "../../src/ev/analysis-store.js";

/**
 * Issue #168(#163-a)AC-a6: 保存→取得の契約(共有フィクスチャ)。
 *
 * フィクスチャ `test/fixtures/analysis-store-contract.json` は、cloud の D1 実装(#169)も相対パスで読む。
 * 両方の実装が**同じ入力から同じ期待値**を得ることで、変換(NULL・0/1・JSON 化)が実装ごとに食い違わないことを保つ。
 * ここでは exe 側(better-sqlite3 の AnalysisStore)がその期待値になることを固定する。
 *
 * 期待値は切り出し前の実装で生成し、入力と1項目ずつ突き合わせて確認した(NULL の復元・0/1 の真偽値化・JSON 往復・並び順)。
 */

interface ContractCase {
  readonly name: string;
  readonly record: AnalysisRecord;
  readonly expectedAnalysis: Omit<StoredAnalysis, "id">;
  readonly expectedAllocation: StoredAllocation | null;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/analysis-store-contract.json", import.meta.url),
);
const cases = (
  JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { cases: ContractCase[] }
).cases;

describe("共有フィクスチャの前提(空振りを防ぐ。入力が退化していないこと)", () => {
  it("ケースは3件で、保存する馬は合計5頭", () => {
    expect(cases).toHaveLength(3);
    expect(cases.reduce((n, c) => n + c.record.horses.length, 0)).toBe(5);
  });

  it("promptLookaheadGuarded は true・false・未指定(null に復元)の3値がそろう", () => {
    const values = cases.map((c) => c.expectedAnalysis.promptLookaheadGuarded);
    expect(values).toContain(true);
    expect(values).toContain(false);
    expect(values).toContain(null);
  });

  it("配分は『あり(買い目あり)』『あり(買い目なし)』『なし(null)』の3通りがそろう", () => {
    const allocations = cases.map((c) => c.expectedAllocation);
    expect(allocations.filter((a) => a === null)).toHaveLength(1);
    expect(allocations.filter((a) => a !== null && a.bets.length > 0)).toHaveLength(1);
    expect(allocations.filter((a) => a !== null && a.bets.length === 0)).toHaveLength(1);
  });

  it("falsy な値(0・空文字・空オブジェクト・false)が入っていて、null と区別されている", () => {
    const horse = cases[0]!.expectedAnalysis.horses[1]!;
    expect(horse.prior).toBe(0);
    expect(horse.placeOddsMin).toBe(0);
    expect(horse.ev).toBe(0);
    expect(horse.reason).toBe("");
    expect(horse.contributions).toEqual({});
    expect(cases[0]!.expectedAllocation!.bets.some((b) => b.odds === 0 && b.ev === 0)).toBe(true);
  });
});

describe("AnalysisStore(better-sqlite3)は共有フィクスチャの期待値どおりに保存・取得する", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const store = new AnalysisStore();
    const id = store.saveAnalysis(c.record);

    const stored = store.listAnalyses({ raceId: c.record.raceId });
    expect(stored).toHaveLength(1);
    const { id: storedId, ...rest } = stored[0]!;
    expect(storedId).toBe(id);
    expect(rest).toStrictEqual(c.expectedAnalysis);

    const allocation = store.getStoredAllocation(id);
    expect(allocation ?? null).toStrictEqual(c.expectedAllocation);
  });
});
