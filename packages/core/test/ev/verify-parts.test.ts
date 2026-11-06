import { describe, expect, it } from "vitest";
import {
  buildPromptVersionParts,
  buildVerifyPart,
  computeVerifyReport,
  computeVerifyReportByPromptVersion,
  DEFAULT_VERIFY_CONFIG,
  finalizePromptVersionParts,
  finalizeVerifyPart,
  mergePromptVersionParts,
  mergeVerifyParts,
  PRODUCTION_VERIFY_CONFIG,
  type VerifyConfig,
  type VerifyPart,
} from "../../src/ev/verify.js";
import { computeVerifyReport as legacyReport, computeVerifyReportByPromptVersion as legacyByVersion } from "../support/verify-legacy.js";
import { randomVerifyData, shuffled, splitByRace } from "../support/verify-random-data.js";

/**
 * Issue #625: 検証の集計を「部分を作る・部分を合わせる・確定する」に分ける。
 * 保証すること:
 *  (1) 今の関数(`computeVerifyReport`・`computeVerifyReportByPromptVersion`)は、基点の実装(`support/verify-legacy.ts`)と同じ値を返す。
 *      件数・金額・集合は完全一致、小数は相対 1e-12 まで。
 *  (2) 分け方(1 レースずつ・塊ごと・全部を一度)と合わせる順によらず、確定した結果は同じ(完全一致 = ビット単位)。
 *  (3) 部分は構造化複製できる(JSON 往復で変わらない)。
 */

const CONFIGS: ReadonlyArray<readonly [string, VerifyConfig]> = [
  ["既定", DEFAULT_VERIFY_CONFIG],
  ["本番", PRODUCTION_VERIFY_CONFIG],
  ["全件モード・帯 7", { ...DEFAULT_VERIFY_CONFIG, includeAllAnalyses: true, calibrationBins: 7 }],
];

/**
 * ビット一致にならない項目(実測)。馬ごとの小数(確率・補正量・二乗誤差)の和は、旧実装が全馬を 1 本の列で足すのに対し、
 * 部分はレースごとの小計を足すので、足し順が変わり下位の桁がずれる。件数・金額・払戻の和(整数)と配分ベースの項目は完全一致する。
 * これらも相対 1e-12 には収まる(ユーザーの決定 11/6)。
 */
const FLOAT_SUM_FIELDS = /\.(meanPredictedProb|priorBrier|adjustedBrier|averageAdjustment)$/;

/** 数は相対 1e-12 まで、それ以外は完全一致で比べ、ビット一致でない数の個数を返す。 */
function expectCloseDeep(actual: unknown, expected: unknown, path: string, stats: { inexact: string[] }): void {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Object.is(actual, expected)) return;
    const scale = Math.max(Math.abs(actual), Math.abs(expected));
    expect(Math.abs(actual - expected) / scale, `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1e-12);
    stats.inexact.push(path);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, `${path} の長さ`).toBe(expected.length);
    expected.forEach((e, i) => expectCloseDeep((actual as unknown[])[i], e, `${path}[${i}]`, stats));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object", path).toBe(true);
    expect(Object.keys(actual as object).sort(), `${path} のキー`).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected)) {
      expectCloseDeep((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`, stats);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

describe("今の関数は基点の実装と同じ値を返す(Issue #625)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const [name, config] of CONFIGS) {
      for (const venue of ["all", "central", "nar"] as const) {
        it(`全体の集計(seed=${seed}, 設定=${name}, 区分=${venue})`, () => {
          const { source, analyses } = randomVerifyData(seed, 40, { dirtyProbability: seed % 3 === 0 });
          // 前提: 乱数のデータが退化していない(件数が 0 でなく、複数のレース・区分を含む)
          const legacy = legacyReport(source, config, venue);
          const probe = legacyReport(source, config, "all");
          expect(probe.includedAnalysisCount).toBeGreaterThan(5);
          expect(probe.proposedBet.population.allocated).toBeGreaterThan(3);
          expect(probe.proposedBet.overall.betCount).toBeGreaterThan(3);
          expect(new Set(analyses.map((a) => a.raceId.slice(4, 6))).size).toBeGreaterThan(3);
          const stats = { inexact: [] as string[] };
          expectCloseDeep(computeVerifyReport(source, config, venue), legacy, "report", stats);
          // ビット一致を目指す: 外れてよいのは馬ごとの小数の和だけ
          expect(stats.inexact.filter((p) => !FLOAT_SUM_FIELDS.test(p))).toEqual([]);
        });
      }
    }
  }

  for (const seed of [11, 12, 13]) {
    for (const [name, config] of CONFIGS) {
      it(`版別の集計(seed=${seed}, 設定=${name})`, () => {
        const { source } = randomVerifyData(seed, 40);
        const legacy = legacyByVersion(source, config);
        expect(legacy.length).toBeGreaterThan(2);
        expect(legacy.some((v) => v.additionalInstructions.length > 1)).toBe(true);
        const stats = { inexact: [] as string[] };
        expectCloseDeep(computeVerifyReportByPromptVersion(source, config), legacy, "versions", stats);
        expect(stats.inexact.filter((p) => !FLOAT_SUM_FIELDS.test(p))).toEqual([]);
      });
    }
  }
});

describe("分け方によらず確定した結果が同じ(Issue #625)", () => {
  function splits(seed: number, analyses: Parameters<typeof splitByRace>[0]) {
    return {
      一度: [analyses],
      "1 レースずつ": splitByRace(analyses, (_r, i) => i),
      "3 塊": splitByRace(analyses, (_r, i) => i % 3),
      "塊(不揃い)": splitByRace(analyses, (r) => Number(r.slice(8, 10))),
    };
  }

  for (const seed of [21, 22, 23, 24]) {
    for (const [name, config] of CONFIGS) {
      it(`全体: 分け方を変えても完全一致(seed=${seed}, 設定=${name})`, () => {
        const { source, analyses } = randomVerifyData(seed, 36, { dirtyProbability: seed === 22 });
        const baseline = finalizeVerifyPart(buildVerifyPart(source, analyses, config), config, "all");
        for (const [label, chunks] of Object.entries(splits(seed, analyses))) {
          // 前提: 1 レースずつ・塊のときは複数の塊に分かれている
          if (label !== "一度") expect(chunks.length).toBeGreaterThan(2);
          const parts = chunks.map((c) => buildVerifyPart(source, c, config));
          for (const order of [parts, shuffled(parts, seed), [...parts].reverse()]) {
            const merged = mergeVerifyParts(order);
            for (const venue of ["all", "central", "nar"] as const) {
              const expected = finalizeVerifyPart(buildVerifyPart(source, analyses, config), config, venue);
              expect(finalizeVerifyPart(merged, config, venue), `${label}/${venue}`).toStrictEqual(expected);
            }
            expect(finalizeVerifyPart(merged, config, "all"), label).toStrictEqual(baseline);
          }
        }
      });
    }
  }

  it("区分で絞った確定は、絞った分析だけで作った集計と一致する", () => {
    const { source, analyses } = randomVerifyData(31, 40);
    const part = buildVerifyPart(source, analyses, PRODUCTION_VERIFY_CONFIG);
    for (const venue of ["central", "nar"] as const) {
      const report = finalizeVerifyPart(part, PRODUCTION_VERIFY_CONFIG, venue);
      expect(report.includedAnalysisCount).toBeGreaterThan(0);
      expect(report).toStrictEqual(computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, venue));
    }
  });

  for (const seed of [41, 42, 43]) {
    it(`版別: 分け方を変えても完全一致(seed=${seed})`, () => {
      const { source, analyses } = randomVerifyData(seed, 40);
      const baseline = finalizePromptVersionParts(buildPromptVersionParts(source, analyses, PRODUCTION_VERIFY_CONFIG), PRODUCTION_VERIFY_CONFIG);
      expect(baseline.length).toBeGreaterThan(2);
      for (const chunks of [splitByRace(analyses, (_r, i) => i), splitByRace(analyses, (_r, i) => i % 4)]) {
        expect(chunks.length).toBeGreaterThan(3);
        const lists = chunks.map((c) => buildPromptVersionParts(source, c, PRODUCTION_VERIFY_CONFIG));
        for (const order of [lists, shuffled(lists, seed)]) {
          expect(finalizePromptVersionParts(mergePromptVersionParts(order), PRODUCTION_VERIFY_CONFIG)).toStrictEqual(baseline);
        }
      }
    });
  }
});

describe("部分の性質(Issue #625)", () => {
  it("構造化複製できる値だけで持つ(JSON 往復と structuredClone で変わらない)", () => {
    const { source, analyses } = randomVerifyData(51, 30);
    const part = buildVerifyPart(source, analyses, PRODUCTION_VERIFY_CONFIG);
    expect(part.races.length).toBeGreaterThan(10);
    expect(JSON.parse(JSON.stringify(part))).toStrictEqual(part);
    expect(structuredClone(part)).toStrictEqual(part);
    const versions = buildPromptVersionParts(source, analyses, PRODUCTION_VERIFY_CONFIG);
    expect(JSON.parse(JSON.stringify(versions))).toStrictEqual(versions);
  });

  it("畳む順は、レースで採用した分析の ID の最小値の昇順(race_id の順ではない)", () => {
    const { source, analyses } = randomVerifyData(55, 30);
    const part = mergeVerifyParts(splitByRace(analyses, (_r, i) => i).map((c) => buildVerifyPart(source, c, PRODUCTION_VERIFY_CONFIG)));
    const keys = part.races.map((r) => r.orderKey);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    // 前提: 並びが race_id の昇順と一致していない(一致していると順の取り違えを検出できない)
    const ids = part.races.map((r) => r.raceId);
    expect(ids).not.toEqual([...ids].sort());
    // 鍵は「採用した分析の ID の最小値」: 採用された分析を持つレースで確かめる
    const withIncluded = part.races.filter((r) => r.includedAnalysisCount > 0);
    expect(withIncluded.length).toBeGreaterThan(5);
    for (const race of withIncluded) {
      const ids = analyses.filter((a) => a.raceId === race.raceId).map((a) => a.id);
      expect(ids).toContain(race.orderKey);
      expect(race.orderKey).toBeGreaterThanOrEqual(Math.min(...ids));
    }
  });

  it("同じレースが複数の部分にあると合わせられない", () => {
    const { source, analyses } = randomVerifyData(52, 10);
    const part = buildVerifyPart(source, analyses, DEFAULT_VERIFY_CONFIG);
    expect(() => mergeVerifyParts([part, part])).toThrow(/同じレース/);
  });

  it("帯の数が違う部分は合わせられず、設定と違う帯の数では確定できない", () => {
    const { source, analyses } = randomVerifyData(53, 10);
    const a = buildVerifyPart(source, analyses.slice(0, 3), DEFAULT_VERIFY_CONFIG);
    const b = buildVerifyPart(source, analyses.slice(3), { ...DEFAULT_VERIFY_CONFIG, calibrationBins: 5 });
    expect(() => mergeVerifyParts([a, b])).toThrow(/帯の数/);
    expect(() => finalizeVerifyPart(b, DEFAULT_VERIFY_CONFIG)).toThrow(/帯の数/);
  });

  it("部分の無い集合は、分析が 0 件のときの今の結果と同じ", () => {
    const { source } = randomVerifyData(54, 5);
    const empty: VerifyPart = mergeVerifyParts([]);
    expect(finalizeVerifyPart(empty, DEFAULT_VERIFY_CONFIG)).toStrictEqual(legacyReport({ ...source, listAnalyses: () => [] }, DEFAULT_VERIFY_CONFIG));
  });
});
