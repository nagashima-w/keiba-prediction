import { describe, expect, it, vi } from "vitest";

import type { AnalysisResult, AnalysisRow } from "../src/shared/analysis-types.js";
import type { MixedAllocationSettings } from "../src/shared/mixed-race-allocation.js";
import { buildMixedAllocationDisplay } from "../src/renderer/mixed-allocation-view.js";
import {
  handleAllocationWorkerRequest,
  type AllocationWorkerRequest,
} from "../src/renderer/mixed-allocation-worker-handler.js";

// AC-4の「計算失敗はstatus:errorのメッセージとして返す(Worker自体はクラッシュさせない)」を
// 確かめたいが、`buildMixedAllocationDisplay`はAC17(mixed-race-allocation.tsのクラッシュ耐性)に
// より深い層の例外を`kind:"invalid"`という**正常な戻り値**へ吸収する設計であり、通常の入力・
// 異常値では本当にthrowする経路を再現できない(`mixed-race-allocation-crash-safety.test.ts`が
// 同じ理由で下層関数をvi.mockしている)。ここでは`handleAllocationWorkerRequest`自体のtry/catchが
// 正しく機能すること**そのもの**を確認したいので、`buildMixedAllocationDisplay`を
// vi.mock+importOriginalで条件付きthrowに差し替える(mixed-race-allocation-crash-safety.test.tsと
// 同じ流儀: 巻き上げ回避のため被テストモジュールは動的importで読み込む)。
let throwOnRaceId: string | null = null;
vi.mock("../src/renderer/mixed-allocation-view.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/mixed-allocation-view.js")>();
  return {
    ...actual,
    buildMixedAllocationDisplay: (
      ...args: Parameters<typeof actual.buildMixedAllocationDisplay>
    ): ReturnType<typeof actual.buildMixedAllocationDisplay> => {
      if ((args[0] as AnalysisResult).raceId === throwOnRaceId) {
        throw new Error("テスト用スタブ: buildMixedAllocationDisplayが必ずthrowする");
      }
      return actual.buildMixedAllocationDisplay(...args);
    },
  };
});

/** テスト用のAnalysisRow(mixed-allocation-view.test.tsのrow()と同じ流儀)。 */
function row(overrides: Partial<AnalysisRow> & { umaban: number }): AnalysisRow {
  return {
    umaban: overrides.umaban,
    wakuban: overrides.wakuban ?? 1,
    horseName: `${overrides.umaban}番`,
    prior: overrides.prior === undefined ? 0.3 : overrides.prior,
    adjustedProb: overrides.adjustedProb ?? 0.5,
    placeOddsMin: overrides.placeOddsMin === undefined ? 3 : overrides.placeOddsMin,
    winOdds: overrides.winOdds === undefined ? 10 : overrides.winOdds,
    ev: overrides.ev === undefined ? 1.5 : overrides.ev,
    isPositive: overrides.isPositive ?? true,
    reason: null,
    careerRunCount: overrides.careerRunCount === undefined ? 999 : overrides.careerRunCount,
    mark: null,
    evEstimated: overrides.evEstimated ?? false,
    conditionChangeTags: [],
  };
}

/** テスト用のAnalysisResult(必須フィールドのみ既定値で埋める)。 */
function analysisResult(overrides: Partial<AnalysisResult> & { rows: readonly AnalysisRow[] }): AnalysisResult {
  return {
    raceId: "202601010101",
    venueName: "テスト競馬場",
    raceName: "テストレース",
    courseType: "芝",
    distance: 2000,
    date: "2026/01/01",
    dateApproximate: false,
    llmUsed: false,
    llmSkippedReason: null,
    fallback: false,
    fallbackReason: null,
    oddsStatus: "result",
    warnings: [],
    analyzedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    ...overrides,
  };
}

describe("handleAllocationWorkerRequest(Workerエントリのロジック本体。Issue #119・#24-C3)", () => {
  it("AC-1: 画面側と同じbuildMixedAllocationDisplayを同じ引数で呼んだ結果と完全に一致すること(別実装を作らない)", () => {
    const race = analysisResult({ rows: [row({ umaban: 1 }), row({ umaban: 2, adjustedProb: 0.2 })] });
    const s = settings();
    const request: AllocationWorkerRequest = { raceId: race.raceId, race, settings: s };

    const response = handleAllocationWorkerRequest(request);

    const direct = buildMixedAllocationDisplay(race, s);
    expect(response.raceId).toBe(race.raceId);
    expect(response.outcome).toEqual({ status: "ok", value: direct });
  });

  it("raceIdは応答にそのまま引き継がれること(相関のためraceId自体は計算内容に使わない)", () => {
    const race = analysisResult({ rows: [row({ umaban: 1 })] });
    const response = handleAllocationWorkerRequest({
      raceId: "別のraceId-999",
      race,
      settings: settings(),
    });
    expect(response.raceId).toBe("別のraceId-999");
  });

  it("buildMixedAllocationDisplayが例外を投げても、Worker全体をクラッシュさせずstatus:errorとして返すこと(AC-4の前提)", async () => {
    // ファイル冒頭のvi.mockでbuildMixedAllocationDisplayを条件付きthrowに差し替えている
    // (このraceIdのときだけthrowする。理由はファイル冒頭コメント参照)。
    // 巻き上げ回避のため、被テストモジュールはここで動的importする
    // (mixed-race-allocation-crash-safety.test.tsと同じ流儀)。
    throwOnRaceId = "race-broken";
    try {
      const { handleAllocationWorkerRequest: handle } = await import(
        "../src/renderer/mixed-allocation-worker-handler.js"
      );
      const race = analysisResult({ raceId: "race-broken", rows: [row({ umaban: 1 })] });
      const response = handle({ raceId: "race-broken", race, settings: settings() });

      expect(response.raceId).toBe("race-broken");
      expect(response.outcome).toEqual({ status: "error" });
    } finally {
      throwOnRaceId = null;
    }
  });
});
