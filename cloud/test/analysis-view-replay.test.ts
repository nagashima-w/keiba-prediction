import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { buildRaceSnapshot } from "../../packages/core/src/analysis/analysis-export";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";
import { scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * 応答に足した材料: 馬ごとの `earlyPos`(Issue #311。スナップショットの馬から)・`latePos`(Issue #363)・`legStyle`(#314)・`race.pace`(#314)・`race.turn`(#311。raceId・距離から)。
 * Issue #362 でレース再生を廃止したあとも、`earlyPos`・`latePos`・`legStyle`・`race.pace` は想定隊列図(`client/formation-model.ts`)の材料として使う(`race.turn` は使い道がなくなったが、別 Issue で整理するまで残す)。
 * 画面の表示の材料で、確率・配分には使わない。
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
        { umaban: 1, name: "A", earlyPos: 0.125, latePos: 0.35 },
        { umaban: 2, name: "B", earlyPos: 0.9, latePos: 0.7 },
        { umaban: 3, name: "C", earlyPos: null, latePos: null },
        { umaban: 4, name: "D", earlyPos: "0.5", latePos: "0.5" }, // 不正(文字列)
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

describe("buildAnalysisView の latePos(終盤の位置。Issue #363)", () => {
  it("present: スナップショットの馬の latePos を写す(null・文字列などの不正は null。馬を取り違えない。earlyPos とは別の値)", () => {
    const view = buildAnalysisView(detail(analysis(), "present"), undefined);
    expect(view.horses.map((h) => [h.umaban, h.latePos])).toEqual([
      [1, 0.35],
      [2, 0.7],
      [3, null],
      [4, null],
    ]);
    expect(view.horses.map((h) => h.latePos)).not.toEqual(view.horses.map((h) => h.earlyPos));
  });

  it("Issue #363 より前のスナップショット(キー無し)は null", () => {
    const a = analysis({ raceSnapshot: { race: {}, horses: [{ umaban: 1, name: "A", earlyPos: 0.2 }] } });
    expect(buildAnalysisView(detail(a, "present"), undefined).horses[0]!.latePos).toBeNull();
  });

  it("範囲外(負・1 超)は null、境界の 0 と 1 は通す(画面の契約は 0〜1)", () => {
    const a = analysis({
      raceSnapshot: { race: {}, horses: [{ umaban: 1, latePos: -0.1 }, { umaban: 2, latePos: 1.5 }, { umaban: 3, latePos: 0 }, { umaban: 4, latePos: 1 }] },
    });
    expect(buildAnalysisView(detail(a, "present"), undefined).horses.map((h) => h.latePos)).toEqual([null, null, 0, 1]);
  });

  it("詳細が present でない(none・missing)ときは、スナップショットを使わず null", () => {
    for (const status of ["none", "missing"] as const) {
      const view = buildAnalysisView(detail(analysis(), status), undefined);
      expect(view.horses.map((h) => h.latePos), status).toEqual([null, null, null, null]);
    }
  });

  it("書き込み側との drift: 実フィクスチャの RaceData から buildRaceSnapshot で作ったスナップショットを通すと、書き込んだ値がそのまま届く", async () => {
    const { race } = await scrapeFixtureRace();
    expect(race.horses.length).toBeGreaterThan(0); // 前提(空振り防止)
    const snapshot = JSON.parse(JSON.stringify(buildRaceSnapshot(race))) as { horses: { umaban: number; latePos: number | null }[] };
    const written = snapshot.horses.map((h) => h.latePos);
    expect(written.filter((v) => v !== null).length, "前提: latePos が数の馬がいる").toBeGreaterThan(0);
    const horses = race.horses.map((h) => horse(h.shutuba.umaban));
    const view = buildAnalysisView(detail(analysis({ horses, raceSnapshot: snapshot }), "present"), undefined);
    expect(view.horses.map((h) => h.latePos)).toEqual(written);
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

describe("buildAnalysisView の legStyle(脚質。Issue #314)", () => {
  it("present: スナップショットの馬の legStyle を写す(4 値だけ通す。null・不正な文字列・数は null。馬を取り違えない)", () => {
    const a = analysis({
      raceSnapshot: {
        race: {},
        horses: [{ umaban: 1, legStyle: "逃げ" }, { umaban: 2, legStyle: "追込" }, { umaban: 3, legStyle: null }, { umaban: 4, legStyle: "まくり" }],
      },
    });
    expect(buildAnalysisView(detail(a, "present"), undefined).horses.map((h) => [h.umaban, h.legStyle])).toEqual([
      [1, "逃げ"],
      [2, "追込"],
      [3, null],
      [4, null],
    ]);
  });

  it("4 値すべてを通す(先行・差しを含む)。数や真偽値は null", () => {
    const a = analysis({
      raceSnapshot: { race: {}, horses: [{ umaban: 1, legStyle: "先行" }, { umaban: 2, legStyle: "差し" }, { umaban: 3, legStyle: 2 }, { umaban: 4, legStyle: true }] },
    });
    expect(buildAnalysisView(detail(a, "present"), undefined).horses.map((h) => h.legStyle)).toEqual(["先行", "差し", null, null]);
  });

  it("Issue #314 より前のスナップショット(キー無し)は null。詳細が present でない(none・missing)ときも null", () => {
    const old = analysis({ raceSnapshot: { race: {}, horses: [{ umaban: 1, name: "A" }] } });
    expect(buildAnalysisView(detail(old, "present"), undefined).horses[0]!.legStyle).toBeNull();
    for (const status of ["none", "missing"] as const) {
      const withStyle = analysis({ raceSnapshot: { race: {}, horses: [{ umaban: 1, legStyle: "逃げ" }] } });
      expect(buildAnalysisView(detail(withStyle, status), undefined).horses.map((h) => h.legStyle), status).toEqual([null, null, null, null]);
    }
  });

  it("書き込み側との drift: 実フィクスチャの RaceData から buildRaceSnapshot で作ったスナップショットを通すと、書き込んだ脚質がそのまま届く", async () => {
    const { race } = await scrapeFixtureRace();
    const snapshot = JSON.parse(JSON.stringify(buildRaceSnapshot(race))) as { horses: { umaban: number; legStyle: string | null }[] };
    const written = snapshot.horses.map((h) => h.legStyle);
    expect(written.filter((v) => v !== null).length, "前提: 脚質が取れた馬がいる").toBeGreaterThan(0);
    const horses = race.horses.map((h) => horse(h.shutuba.umaban));
    const view = buildAnalysisView(detail(analysis({ horses, raceSnapshot: snapshot }), "present"), undefined);
    expect(view.horses.map((h) => h.legStyle)).toEqual(written);
  });
});

describe("buildAnalysisView の race.pace(想定ペース。Issue #314)", () => {
  /** 逃げの頭数を指定したスナップショット(残りは差し)。 */
  const withRunners = (runners: number, total = 6): StoredAnalysis =>
    analysis({
      horses: Array.from({ length: total }, (_, i) => horse(i + 1)),
      raceSnapshot: { race: {}, horses: Array.from({ length: total }, (_, i) => ({ umaban: i + 1, legStyle: i < runners ? "逃げ" : "差し" })) },
    });
  const paceOf = (a: StoredAnalysis, status: DetailStatus = "present") => buildAnalysisView(detail(a, status), undefined).race.pace;

  it("プロンプトの展開想定(buildRaceDevelopment)と同じ判定: 逃げ 0 頭=スロー・1 頭=平均・2 頭以上=ハイ", () => {
    expect(paceOf(withRunners(0))).toBe("スロー");
    expect(paceOf(withRunners(1))).toBe("平均");
    expect(paceOf(withRunners(2))).toBe("ハイ");
    expect(paceOf(withRunners(4))).toBe("ハイ");
  });

  it("脚質の判定できた馬が 1 頭もいない(古いスナップショット・全員 null)は「不明」。詳細が present でないときも「不明」", () => {
    const allNull = analysis({ raceSnapshot: { race: {}, horses: [{ umaban: 1 }, { umaban: 2, legStyle: null }] } });
    expect(paceOf(allNull)).toBe("不明");
    expect(paceOf(withRunners(3), "none")).toBe("不明");
    expect(paceOf(withRunners(3), "missing")).toBe("不明");
  });

  it("一部の馬だけ脚質が判定できたとき(他は null)は、判定できた馬の分布から決める(従来の展開想定と同じ)", () => {
    const a = analysis({
      horses: [horse(1), horse(2), horse(3), horse(4)],
      raceSnapshot: { race: {}, horses: [{ umaban: 1, legStyle: "逃げ" }, { umaban: 2, legStyle: "逃げ" }, { umaban: 3 }, { umaban: 4, legStyle: null }] },
    });
    expect(paceOf(a)).toBe("ハイ");
  });
});
