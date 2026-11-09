import { describe, expect, it } from "vitest";
import type { StoredAnalysis } from "../../packages/core/src/ev/analysis-store-types.js";
import { mulberry32 } from "../../packages/core/src/common/random.js";
import { randomVerifyData, shuffled, splitByRace } from "../../packages/core/test/support/verify-random-data.js";
import { buildCloseParts, computeCloseComparison, finalizeCloseParts, mergeCloseParts, type VerifyCloseBetRow, type VerifyCloseMetaRow, type VerifyCloseRows } from "../src/verify-close";
import { computeCloseComparison as legacyClose } from "./support/verify-close-legacy";

/**
 * Issue #625: 締切直前の比較の「部分を作る・合わせる・確定する」。今の関数は基点の実装と同じ結果(金額・件数は完全一致、回収率は相対 1e-12)で、
 * 分け方・合わせる順を変えても確定した結果は完全に同じ。
 */
function randomClose(analyses: readonly StoredAnalysis[], seed: number): { close: VerifyCloseRows; comboOnIds: Set<number> } {
  const rnd = mulberry32(seed);
  const meta: VerifyCloseMetaRow[] = [];
  const bets: VerifyCloseBetRow[] = [];
  const comboOnIds = new Set<number>();
  for (const a of analyses) {
    if (rnd() < 0.5) comboOnIds.add(a.id);
    for (const round of [1, 2, 3]) {
      const r = rnd();
      if (r < 0.15) continue; // 行なし
      if (r < 0.3) {
        meta.push({ analysisId: a.id, round, status: "failed", route: null, skipReasonCode: null, reason: "x" });
      } else if (r < 0.4) {
        meta.push({ analysisId: a.id, round, status: "skipped", route: null, skipReasonCode: null, reason: rnd() < 0.5 ? "nar-unsupported" : "y" });
      } else {
        meta.push({ analysisId: a.id, round, status: "ok", route: rnd() < 0.15 ? null : "mixed", skipReasonCode: rnd() < 0.1 ? "ev-below" : null, reason: null });
        const size = a.horses.length;
        const keys = new Set<string>();
        for (let i = 0; i < 1 + Math.floor(rnd() * 4); i += 1) {
          const u = 1 + Math.floor(rnd() * size);
          keys.add(`${rnd() < 0.5 ? "place" : "win"}:${String(u).padStart(2, "0")}`);
        }
        for (const k of keys) {
          const [betType, comboKey] = k.split(":");
          bets.push({ analysisId: a.id, round, betType: betType!, comboKey: comboKey!, stake: 100 * (1 + Math.floor(rnd() * 9)) });
        }
      }
    }
  }
  return { close: { meta, bets }, comboOnIds };
}

describe("締切直前の比較の部分(Issue #625)", () => {
  for (const seed of [71, 72, 73]) {
    for (const venue of ["all", "central", "nar"] as const) {
      it(`今の関数は基点の実装と同じ結果(seed=${seed}, 区分=${venue})`, () => {
        const { source, analyses } = randomVerifyData(seed, 50);
        const { close, comboOnIds } = randomClose(analyses, seed);
        const legacy = legacyClose(source, close, { venue, comboOnIds });
        // 前提: 比較が作られ、再計算側に買い目があり、対象の数が 0 でない行が複数ある
        expect(legacy).not.toBeNull();
        expect(legacy!.rounds.filter((r) => r.targetCount > 0).length).toBeGreaterThan(1);
        expect(legacy!.rounds.some((r) => r.recalc.betCount > 0)).toBe(true);
        expect(computeCloseComparison(source, close, { venue, comboOnIds })).toStrictEqual(legacy);
      });
    }

    it(`分け方・合わせる順を変えても完全に同じ(seed=${seed})`, () => {
      const { source, analyses } = randomVerifyData(seed, 50);
      const { close, comboOnIds } = randomClose(analyses, seed);
      for (const venue of ["all", "central", "nar"] as const) {
        const baseline = computeCloseComparison(source, close, { venue, comboOnIds });
        for (const chunks of [splitByRace(analyses, (_r, i) => i), splitByRace(analyses, (_r, i) => i % 4)]) {
          expect(chunks.length).toBeGreaterThan(3);
          const parts = chunks.map((c) => buildCloseParts(source, close, c, comboOnIds));
          for (const order of [parts, shuffled(parts, seed), [...parts].reverse()]) {
            expect(finalizeCloseParts(mergeCloseParts(order), venue)).toStrictEqual(baseline);
          }
        }
      }
    });
  }

  it("行が 1 つも無ければ null(旧い nar-unsupported だけの行も除く)", () => {
    const { source, analyses } = randomVerifyData(74, 10);
    const only = { meta: [{ analysisId: analyses[0]!.id, round: 1, status: "skipped", route: null, skipReasonCode: null, reason: "nar-unsupported" }], bets: [] };
    expect(computeCloseComparison(source, only, { venue: "all", comboOnIds: new Set() })).toBeNull();
    expect(computeCloseComparison(source, { meta: [], bets: [] }, { venue: "all", comboOnIds: new Set() })).toBeNull();
  });

  it("同じレースが複数の部分にあると合わせられない(Issue #626)", () => {
    const { source, analyses } = randomVerifyData(76, 30);
    const { close, comboOnIds } = randomClose(analyses, 76);
    const part = buildCloseParts(source, close, analyses, comboOnIds);
    // 前提: 部分にレースがある(空だと重なりが起きない)
    expect(part.races.length).toBeGreaterThan(3);
    expect(() => mergeCloseParts([part, part])).toThrow(/同じレースが複数の部分/);
    expect(() => mergeCloseParts([part])).not.toThrow();
  });

  it("部分は構造化複製できる", () => {
    const { source, analyses } = randomVerifyData(75, 30);
    const { close, comboOnIds } = randomClose(analyses, 75);
    const part = buildCloseParts(source, close, analyses, comboOnIds);
    expect(part.races.some((r) => r.cells.length > 0)).toBe(true);
    expect(JSON.parse(JSON.stringify(part))).toStrictEqual(part);
  });
});
