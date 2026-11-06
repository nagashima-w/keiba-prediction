import { describe, expect, it } from "vitest";
import type { StoredAnalysis, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";
import { mulberry32 } from "../../packages/core/src/common/random.js";
import { collectProposedBetEvents, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { randomVerifyData, shuffled, splitByRace } from "../../packages/core/test/support/verify-random-data.js";
import {
  buildVerifyBreakdownParts,
  computeVerifyBreakdowns,
  finalizeVerifyBreakdowns,
  mergeBreakdownParts,
} from "../src/verify-breakdown";
import { computeVerifyBreakdowns as legacyBreakdowns } from "./support/verify-breakdown-legacy";
import type { RaceConditionFacts } from "../src/verify-race-conditions";
import type { VerifyBetRow } from "../src/verify-read";

/**
 * Issue #625: 人気帯・条件ごとの内訳の「部分を作る・合わせる・確定する」。今の関数は基点の実装と同じ結果で、分け方・合わせる順を変えても確定した結果は完全に同じ。
 * 区間の端(ブートストラップ)は、クラスタを分析 ID の順にそろえてから再標本を作るので、基点と同じ乱数の引き方になる。
 * 小数(予想した的中数・期待値の加重和)は、足し順がレースごとの小計になるので、基点と下位の桁がずれうる(相対 1e-12 まで)。
 */
function randomInputs(seed: number, races: number): { source: VerifyDataSource; analyses: StoredAnalysis[]; betRows: VerifyBetRow[]; facts: Map<number, RaceConditionFacts> } {
  const { source, analyses } = randomVerifyData(seed, races);
  const rnd = mulberry32(seed + 1000);
  const betRows: VerifyBetRow[] = [];
  const facts = new Map<number, RaceConditionFacts>();
  for (const a of analyses) {
    for (const b of source.getAllocationForVerify(a.id)?.bets ?? []) {
      betRows.push({ analysisId: a.id, betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: rnd() < 0.9 ? 1 + rnd() * 30 : null, ev: rnd() < 0.85 ? 0.5 + rnd() : null });
    }
    if (rnd() < 0.8) {
      facts.set(a.id, {
        courseType: ["芝", "ダ", "障", null][Math.floor(rnd() * 4)]!,
        distance: [1200, 1600, 2000, 2400, null][Math.floor(rnd() * 5)]!,
        trackCondition: ["良", "稍重", "重", "不良", null][Math.floor(rnd() * 5)]!,
        raceClass: ["新馬", "未勝利", "1勝クラス", "オープン", null][Math.floor(rnd() * 5)]!,
      });
    }
  }
  return { source, analyses, betRows, facts };
}

/** 実測でビット一致にならなかった項目(予想した的中数とその比。買い目ごとの ev÷odds の和)。期待値の加重和〈meanEv〉は一致したが、足し順に依る項目なので許す側に含める。 */
const FLOAT_SUM = /\.(expectedHits|hitRatio|meanEv)$/;

function closeTo(actual: unknown, expected: unknown, path: string, inexact: string[]): void {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Object.is(actual, expected)) return;
    expect(Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected)), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1e-12);
    inexact.push(path);
    return;
  }
  if (Array.isArray(expected)) {
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, i) => closeTo((actual as unknown[])[i], e, `${path}[${i}]`, inexact));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) closeTo((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`, inexact);
    return;
  }
  expect(actual, path).toBe(expected);
}

describe("内訳の部分(Issue #625)", () => {
  for (const seed of [81, 82, 83, 84]) {
    it(`今の関数は基点の実装と同じ結果(seed=${seed})`, () => {
      const { source, betRows, facts } = randomInputs(seed, 60);
      const legacy = legacyBreakdowns(source, betRows, facts);
      // 前提: 3 区分とも作られ、複数の帯・条件の行があり、区間が出る行がある
      expect(legacy.all).not.toBeNull();
      expect(legacy.central).not.toBeNull();
      expect(legacy.nar).not.toBeNull();
      expect(legacy.all!.stats.groups.flatMap((g) => g.bands).filter((b) => b.bets > 0).length).toBeGreaterThan(3);
      expect(legacy.all!.stats.groups.flatMap((g) => g.bands).some((b) => b.recoveryInterval !== null)).toBe(true);
      expect(legacy.all!.conditions.dimensions.find((d) => d.key === "venue")!.rows.length).toBeGreaterThan(1);
      const inexact: string[] = [];
      closeTo(computeVerifyBreakdowns(source, betRows, facts), legacy, "$", inexact);
      // 区間の端・件数・賭け金は完全一致(外れてよいのは小数の和から導いた項目だけ)
      expect(inexact.filter((p) => !FLOAT_SUM.test(p))).toEqual([]);
    });

    it(`分け方・合わせる順を変えても完全に同じ(seed=${seed})`, () => {
      const { source, analyses, betRows, facts } = randomInputs(seed, 60);
      const baseline = computeVerifyBreakdowns(source, betRows, facts);
      for (const chunks of [splitByRace(analyses, (_r, i) => i), splitByRace(analyses, (_r, i) => i % 5), splitByRace(analyses, (r) => Number(r.slice(8, 10)))]) {
        expect(chunks.length).toBeGreaterThan(2);
        const parts = chunks.map((c) => buildVerifyBreakdownParts(source, betRows, c, facts));
        for (const order of [parts, shuffled(parts, seed), [...parts].reverse()]) {
          expect(finalizeVerifyBreakdowns(mergeBreakdownParts(order))).toStrictEqual(baseline);
        }
      }
    });
  }

  it("部分は構造化複製できる", () => {
    const { source, analyses, betRows, facts } = randomInputs(85, 40);
    const part = buildVerifyBreakdownParts(source, betRows, analyses, facts);
    expect(part.races.length).toBeGreaterThan(10);
    expect(JSON.parse(JSON.stringify(part))).toStrictEqual(part);
    expect(structuredClone(part)).toStrictEqual(part);
  });

  it("collectProposedBetEvents に分析の集合を渡すと、その分析の事象だけになる(全分析の事象の部分集合)", () => {
    const { source, analyses } = randomInputs(86, 40);
    const all = collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG);
    const raceIds = [...new Set(analyses.map((a) => a.raceId))].slice(0, 10);
    const subset = analyses.filter((a) => raceIds.includes(a.raceId));
    const events = collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG, subset);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(all.length);
    expect(events).toStrictEqual(all.filter((e) => raceIds.includes(e.raceId)));
  });
});
