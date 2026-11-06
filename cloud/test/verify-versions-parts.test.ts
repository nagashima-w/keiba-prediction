import { describe, expect, it } from "vitest";
import { PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { computeVerifyReportByPromptVersion as legacyByVersion } from "../../packages/core/test/support/verify-legacy.js";
import { randomVerifyData, shuffled, splitByRace } from "../../packages/core/test/support/verify-random-data.js";
import {
  buildPromptVersionSummaryParts,
  computePromptVersionSummaries,
  finalizePromptVersionSummaries,
  mergePromptVersionSummaryParts,
  summarizePromptVersions,
} from "../src/verify-versions";

/**
 * Issue #625: 版別比較の「部分を作る・合わせる・確定する」。今の関数(`computePromptVersionSummaries`)は基点の実装(core の `support/verify-legacy.ts`)と同じ結果で、
 * 分け方・合わせる順を変えても確定した結果は完全に同じ。馬ごとの小数の和(帯の平均・Brier・補正量)だけは、旧実装と下位の桁がずれうるので相対 1e-12 まで許す(ユーザーの決定 11/6)。
 */
function closeTo(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Object.is(actual, expected)) return;
    expect(Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected)), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1e-12);
    expect(path).toMatch(/(meanPredictedProb|priorBrier|adjustedBrier|overconfidenceGaps)/);
    return;
  }
  if (Array.isArray(expected)) {
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, i) => closeTo((actual as unknown[])[i], e, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) closeTo((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  expect(actual, path).toBe(expected);
}

describe("版別比較の部分(Issue #625)", () => {
  for (const seed of [61, 62, 63]) {
    it(`今の関数は基点の実装と同じ結果(seed=${seed})`, () => {
      const { source } = randomVerifyData(seed, 40);
      const legacy = summarizePromptVersions(legacyByVersion(source, PRODUCTION_VERIFY_CONFIG));
      expect(legacy.length).toBeGreaterThan(2);
      closeTo(computePromptVersionSummaries(source), legacy);
    });

    it(`分け方・合わせる順を変えても完全に同じ(seed=${seed})`, () => {
      const { source, analyses } = randomVerifyData(seed, 40);
      const baseline = computePromptVersionSummaries(source);
      expect(baseline.some((s) => s.additionalInstructions.length > 1)).toBe(true);
      for (const chunks of [splitByRace(analyses, (_r, i) => i), splitByRace(analyses, (_r, i) => i % 3)]) {
        expect(chunks.length).toBeGreaterThan(2);
        const lists = chunks.map((c) => buildPromptVersionSummaryParts(source, c));
        for (const order of [lists, shuffled(lists, seed), [...lists].reverse()]) {
          expect(finalizePromptVersionSummaries(mergePromptVersionSummaryParts(order))).toStrictEqual(baseline);
        }
      }
    });
  }
});
