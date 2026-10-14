import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { buildRaceSnapshot } from "../../packages/core/src/analysis/analysis-export";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";
import { scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #311(レース再生): 応答に足した 2 つ — 馬ごとの `earlyPos`(スナップショットの馬から)と `race.turn`(raceId・距離から)。
 * 画面の演出の材料で、確率・配分には使わない。
 */

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: {}, mark: null, reason: null, highlights: [], concerns: [] };
}

function analysis(over: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    id: 7,
    raceId: "202605020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1), horse(2), horse(3), horse(4)],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: null,
    rawResponse: null,
    raceSnapshot: {
      race: { raceName: "テスト", courseType: "芝", distance: 1600 },
      horses: [
        { umaban: 1, name: "A", earlyPos: 0.125 },
        { umaban: 2, name: "B", earlyPos: 0.9 },
        { umaban: 3, name: "C", earlyPos: null },
        { umaban: 4, name: "D", earlyPos: "0.5" }, // 不正(文字列)
      ],
    },
    historyCutoffDate: "20260627",
    ...over,
  } as StoredAnalysis;
}

const detail = (a: StoredAnalysis, status: DetailStatus): AnalysisDetailResult => ({ analysis: a, detail: status, llmNote: null, llmCalls: null });

describe("buildAnalysisView の earlyPos(スタート直後の位置。Issue #311)", () => {
  it("present: スナップショットの馬の earlyPos を写す(null・文字列などの不正は null。馬を取り違えない)", () => {
    const view = buildAnalysisView(detail(analysis(), "present"), undefined);
    expect(view.horses.map((h) => [h.umaban, h.earlyPos])).toEqual([
      [1, 0.125],
      [2, 0.9],
      [3, null],
      [4, null],
    ]);
  });

  it("Issue #311 より前のスナップショット(キー無し)は null", () => {
    const a = analysis({ raceSnapshot: { race: {}, horses: [{ umaban: 1, name: "A" }] } });
    expect(buildAnalysisView(detail(a, "present"), undefined).horses[0]!.earlyPos).toBeNull();
  });

  it("範囲外(負・1 超)は null、境界の 0 と 1 は通す(画面の契約は 0〜1)", () => {
    const a = analysis({
      raceSnapshot: { race: {}, horses: [{ umaban: 1, earlyPos: -0.1 }, { umaban: 2, earlyPos: 1.5 }, { umaban: 3, earlyPos: 0 }, { umaban: 4, earlyPos: 1 }] },
    });
    // 0 と 1 は範囲内(境界)。0 は実際には出ない(pos ≥ 1)が、画面の契約としては 0〜1 を受ける。
    expect(buildAnalysisView(detail(a, "present"), undefined).horses.map((h) => h.earlyPos)).toEqual([null, null, 0, 1]);
  });

  it("詳細が present でない(none・missing)ときは、スナップショットを使わず null", () => {
    for (const status of ["none", "missing"] as const) {
      const view = buildAnalysisView(detail(analysis(), status), undefined);
      expect(view.horses.map((h) => h.earlyPos), status).toEqual([null, null, null, null]);
    }
  });

  it("書き込み側との drift: 実フィクスチャの RaceData から buildRaceSnapshot で作ったスナップショットを通すと、書き込んだ値がそのまま届く", async () => {
    const { race } = await scrapeFixtureRace();
    expect(race.horses.length).toBeGreaterThan(0); // 前提(空振り防止)
    const snapshot = JSON.parse(JSON.stringify(buildRaceSnapshot(race))) as { horses: { umaban: number; earlyPos: number | null }[] };
    const written = snapshot.horses.map((h) => h.earlyPos);
    // 前提: フィクスチャに通過順位のある馬が 1 頭以上あり(値が全部 null だと null 化の取りこぼしを検出できない)
    expect(written.filter((v) => v !== null).length, "前提: earlyPos が数の馬がいる").toBeGreaterThan(0);
    const horses = race.horses.map((h) => horse(h.shutuba.umaban));
    const view = buildAnalysisView(detail(analysis({ horses, raceSnapshot: snapshot }), "present"), undefined);
    expect(view.horses.map((h) => h.earlyPos)).toEqual(written);
  });
});

describe("buildAnalysisView の race.turn(コースの回り。Issue #311)", () => {
  it("raceId の場コードと距離から決める(東京=left・中山=right・川崎=left・大井 1650m=left)。詳細の状態に依らない", () => {
    const turnOf = (raceId: string, status: DetailStatus = "present", distance = 1600): string | undefined => {
      const a = analysis({ raceId, raceSnapshot: { race: { distance }, horses: [] } });
      return buildAnalysisView(detail(a, status), undefined).race.turn;
    };
    expect(turnOf("202605020211")).toBe("left"); // 東京
    expect(turnOf("202606020211")).toBe("right"); // 中山
    expect(turnOf("202645020211")).toBe("left"); // 川崎
    expect(turnOf("202644020211", "present", 1650)).toBe("left"); // 大井 1650m
    expect(turnOf("202644020211", "present", 1600)).toBe("right"); // 大井 1600m
    expect(turnOf("202644020211", "none", 1650), "詳細なしは距離が分からないので大井は右").toBe("right");
    expect(turnOf("202605020211", "missing")).toBe("left");
  });
});
