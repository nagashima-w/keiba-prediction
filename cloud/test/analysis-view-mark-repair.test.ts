import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult } from "../src/analysis-repository";
import type { MarkRepairRecord } from "../src/mark-repair";

/**
 * Issue #317: `buildAnalysisView` の馬ごとの `markFrom`(補修で印が変わった馬の、補修前の印)。
 * D1 の `mark_repair_json` を復元した記録(`markRepair`)から作る。値は固定の語彙(6種の印・「なし」・「不明」)だけで、
 * 語彙の外の値は復元の段階で捨てられている(`parseMarkRepair`)。補修していない馬は null。
 */

function horse(umaban: number, mark: StoredAnalysisHorse["mark"]): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: false, contributions: null, mark, reason: null, highlights: [], concerns: [] };
}

function analysis(): StoredAnalysis {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1, "◎"), horse(2, "〇"), horse(3, null), horse(4, "▲")],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: null,
    rawResponse: null,
    raceSnapshot: null,
    historyCutoffDate: null,
  } as unknown as StoredAnalysis;
}

function detail(markRepair: MarkRepairRecord | null | undefined): AnalysisDetailResult {
  return { analysis: analysis(), detail: "none", llmNote: null, llmCalls: null, ...(markRepair === undefined ? {} : { markRepair }) };
}

const REPAIRED: MarkRepairRecord = {
  v: 1,
  repaired: true,
  adoptedAttempt: 2,
  attempts: [{ n: 1, kinds: ["over-◎"] }],
  horses: [
    { umaban: 2, from: "◎", to: "〇" },
    { umaban: 3, from: "不明", to: null },
    { umaban: 4, from: "なし", to: "▲" },
  ],
};

describe("buildAnalysisView の markFrom(Issue #317)", () => {
  it("補修した馬だけ、補修前の印を持つ。補修していない馬(1番)は null。現在の印(mark)は D1 の馬の値のまま", () => {
    const view = buildAnalysisView(detail(REPAIRED), undefined);
    expect(view.horses.map((h) => [h.umaban, h.mark, h.markFrom])).toEqual([
      [1, "◎", null],
      [2, "〇", "◎"],
      [3, null, "不明"],
      [4, "▲", "なし"],
    ]);
  });

  it("全馬がキー markFrom を持つ(クライアントの検証が必須として読む)", () => {
    for (const d of [detail(REPAIRED), detail(null), detail(undefined)]) {
      for (const h of buildAnalysisView(d, undefined).horses) expect("markFrom" in h).toBe(true);
    }
  });

  it("記録なし(null・省略)・聞き直しで解消した記録(repaired:false)は、全馬 null(「直」を付けない)", () => {
    const resolved: MarkRepairRecord = { ...REPAIRED, repaired: false, horses: [] };
    for (const d of [detail(null), detail(undefined), detail(resolved)]) {
      expect(buildAnalysisView(d, undefined).horses.every((h) => h.markFrom === null)).toBe(true);
    }
  });

  it("repaired:false でも horses に変更が入っている不整合な記録は、信用せず「直」を付けない(repaired が正)", () => {
    const odd: MarkRepairRecord = { ...REPAIRED, repaired: false };
    expect(buildAnalysisView(detail(odd), undefined).horses.every((h) => h.markFrom === null)).toBe(true);
  });

  it("現在の印が記録の補修後の印(to)と食い違う馬(保存後に印を書き換えた等)には付けない(表示が事実と違うのを避ける)", () => {
    const stale: MarkRepairRecord = { ...REPAIRED, horses: [{ umaban: 2, from: "◎", to: "▲" }] }; // 2番の現在の印は〇
    expect(buildAnalysisView(detail(stale), undefined).horses.find((h) => h.umaban === 2)!.markFrom).toBeNull();
  });

  it("記録にある馬番が、この分析に居なくても落ちない", () => {
    const extra: MarkRepairRecord = { ...REPAIRED, horses: [{ umaban: 99, from: "◎", to: "〇" }] };
    expect(() => buildAnalysisView(detail(extra), undefined)).not.toThrow();
  });
});
