import { describe, expect, it } from "vitest";
import type { StoredAllocation, StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { buildRaceSnapshot } from "../../packages/app/src/main/analysis-export";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";
import { scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #183(#165-a): `GET /api/analyses/{id}` の応答の整形(`buildAnalysisView`。純関数)。
 * 画面に必要なものだけ(許可したキーの集合を固定する)。`rawResponse`・`contributions`・raceSnapshot の全体は返さない。
 */

const RAW_SECRET = "RAW-RESPONSE-SECRET-aaaa";
const CONTRIB_SECRET = "CONTRIB-SECRET-bbbb";
const JOCKEY_SECRET = "JOCKEY-SECRET-cccc";
const COMBO_SECRET = "COMBO-SECRET-dddd";

function horse(umaban: number, over: Partial<StoredAnalysisHorse> = {}): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: { secret: CONTRIB_SECRET }, mark: "◎", reason: "根拠", ...over };
}

const SNAPSHOT = {
  race: { raceName: "テストステークス", courseType: "芝", distance: 1800, weather: "晴", trackCondition: "良", startTime: "15:45", fence: "A", oddsStatus: "確定", officialDatetime: "2026-06-28 15:00" },
  horses: [
    { umaban: 1, name: "アルファ", jockeyName: JOCKEY_SECRET, wakuban: 1 },
    { umaban: 2, name: "ブラボー", jockeyName: JOCKEY_SECRET, wakuban: 2 },
  ],
  wideCombo: { "0102": COMBO_SECRET },
};

function analysis(over: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1), horse(2, { mark: null, reason: null, placeOddsMin: null, ev: null, isPositive: false }), horse(3)],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: "ADDITIONAL-INSTRUCTION-SECRET",
    kaisaiDate: "20260628",
    model: null,
    rawResponse: RAW_SECRET,
    raceSnapshot: SNAPSHOT,
    historyCutoffDate: "20260627",
    ...over,
  } as StoredAnalysis;
}

const ALLOCATION: StoredAllocation = {
  route: "mixed",
  unavailableReason: null,
  fallbackReason: "FALLBACK-SECRET",
  skipReasonCode: null,
  bankroll: 10000,
  perRaceCap: 3000,
  kellyFraction: 0.25,
  evThreshold: 1.1,
  includeComboOdds: true,
  includeWide: true,
  includeTrio: false,
  includeQuinella: null,
  includeExacta: true,
  includeTrifecta: false,
  includeBracketQuinella: null,
  betUnit: 777777,
  oddsStatus: "確定",
  bets: [
    { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
    { betType: "wide", comboKey: "0102", stake: 200, odds: null, ev: null },
  ],
};

function detail(a: StoredAnalysis, status: DetailStatus, note: string | null = null): AnalysisDetailResult {
  return { analysis: a, detail: status, llmNote: note };
}

const sorted = (o: object): string[] => Object.keys(o).sort();

describe("buildAnalysisView の llmNote(Issue #194)", () => {
  const NOTE = "LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました";

  it("D1 の理由(固定文言)をそのまま載せる。理由なしは null(キーは常にある)", () => {
    expect(buildAnalysisView(detail(analysis(), "present", NOTE), ALLOCATION).llmNote).toBe(NOTE);
    expect(buildAnalysisView(detail(analysis(), "present"), ALLOCATION).llmNote).toBeNull();
    expect("llmNote" in buildAnalysisView(detail(analysis(), "none"), undefined)).toBe(true);
  });

  it("詳細が present でないとき(none・missing)も、理由は載せる(詳細の状態に依らない)", () => {
    for (const status of ["none", "missing"] as const) {
      expect(buildAnalysisView(detail(analysis(), status, NOTE), undefined).llmNote, status).toBe(NOTE);
    }
  });
});

describe("buildAnalysisView(Issue #183)", () => {
  it("present: 馬名・レース情報を raceSnapshot から結合し、場名・R は raceId から導く", () => {
    const view = buildAnalysisView(detail(analysis(), "present"), ALLOCATION);
    expect(view).toMatchObject({
      id: 7,
      raceId: "202603020211",
      analyzedAt: "2026-06-28T05:00:00.000Z",
      kaisaiDate: "20260628",
      evEstimated: false,
      model: null,
      promptVersion: null,
      detail: "present",
      race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", startTime: "15:45", courseType: "芝", distance: 1800, weather: "晴", trackCondition: "良" },
    });
    expect(view.horses.map((h) => [h.umaban, h.name])).toEqual([
      [1, "アルファ"],
      [2, "ブラボー"],
      [3, null], // スナップショットに無い馬は null
    ]);
    expect(view.horses[1]).toEqual({ umaban: 2, name: "ブラボー", prior: 0.2, adjustedProb: 0.18, placeOddsMin: null, ev: null, isPositive: false, mark: null, reason: null });
    expect(view.horses[0]).toEqual({ umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, mark: "◎", reason: "根拠" });
  });

  it("【漏洩】許可したキーの集合だけ。rawResponse・contributions・馬の騎手名・組合せオッズ・追加指示・戦績の基準日は、応答のどこにも現れない(fallbackReason・betUnit は #185 で意図して返す)", () => {
    const view = buildAnalysisView(detail(analysis(), "present"), ALLOCATION);
    expect(sorted(view)).toEqual(["allocation", "analyzedAt", "detail", "evEstimated", "horses", "id", "kaisaiDate", "llmNote", "model", "promptVersion", "race", "raceId"]);
    expect(sorted(view.race)).toEqual(["courseType", "distance", "raceName", "raceNumber", "startTime", "trackCondition", "venueName", "weather"]);
    for (const h of view.horses) {
      expect(sorted(h)).toEqual(["adjustedProb", "ev", "isPositive", "mark", "name", "placeOddsMin", "prior", "reason", "umaban"]);
    }
    expect(sorted(view.allocation!)).toEqual([
      "bankroll", "betUnit", "bets", "evThreshold", "fallbackReason", "includeBracketQuinella", "includeComboOdds", "includeExacta", "includeQuinella", "includeTrifecta", "includeTrio", "includeWide",
      "kellyFraction", "oddsStatus", "perRaceCap", "route", "skipReasonCode", "unavailableReason",
    ]);
    for (const b of view.allocation!.bets) {
      expect(sorted(b)).toEqual(["betType", "comboKey", "ev", "odds", "stake"]);
    }
    const text = JSON.stringify(view);
    for (const secret of [RAW_SECRET, CONTRIB_SECRET, JOCKEY_SECRET, COMBO_SECRET, "ADDITIONAL-INSTRUCTION-SECRET", "historyCutoffDate"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("配分: 設定の要約と買い目を写す(odds・ev の null を保つ)。記録なし(null)の券種も null のまま。配分が無ければ null", () => {
    const view = buildAnalysisView(detail(analysis(), "present"), ALLOCATION);
    expect(view.allocation).toEqual({
      route: "mixed",
      skipReasonCode: null,
      unavailableReason: null,
      fallbackReason: "FALLBACK-SECRET",
      betUnit: 777777,
      bankroll: 10000,
      perRaceCap: 3000,
      kellyFraction: 0.25,
      evThreshold: 1.1,
      includeComboOdds: true,
      includeWide: true,
      includeTrio: false,
      includeQuinella: null,
      includeExacta: true,
      includeTrifecta: false,
      includeBracketQuinella: null,
      oddsStatus: "確定",
      bets: [
        { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
        { betType: "wide", comboKey: "0102", stake: 200, odds: null, ev: null },
      ],
    });
    expect(buildAnalysisView(detail(analysis(), "present"), undefined).allocation).toBeNull();
    // #185: fallbackReason・betUnit は値をそのまま写す(null も null のまま。0 や空文字に潰さない。exe の表示関数が「記録なし」と「値あり」を区別するため)
    const nulls = buildAnalysisView(detail(analysis(), "present"), { ...ALLOCATION, fallbackReason: null, betUnit: null }).allocation!;
    expect(nulls.fallbackReason).toBeNull();
    expect(nulls.betUnit).toBeNull();
    const other = buildAnalysisView(detail(analysis(), "present"), { ...ALLOCATION, fallbackReason: "no-combo-candidates", betUnit: 100 }).allocation!;
    expect(other.fallbackReason).toBe("no-combo-candidates");
    expect(other.betUnit).toBe(100);
    // 配分はあるが買い目が 0 件
    expect(buildAnalysisView(detail(analysis(), "present"), { ...ALLOCATION, bets: [] }).allocation!.bets).toEqual([]);
  });

  it.each([["missing"], ["none"]] as const)("detail が %s: present と同じキーの形で、馬名・レース情報の詳細は null(スナップショットが万一入っていても使わない)。D1 の要約は残る", (status) => {
    const present = buildAnalysisView(detail(analysis(), "present"), ALLOCATION);
    const view = buildAnalysisView(detail(analysis({ rawResponse: null }), status), ALLOCATION);
    expect(view.detail).toBe(status);
    expect(sorted(view)).toEqual(sorted(present));
    expect(sorted(view.race)).toEqual(sorted(present.race));
    expect(view.horses.map((h) => h.name)).toEqual([null, null, null]);
    expect(view.race).toEqual({ venueName: "福島", raceNumber: 11, raceName: null, startTime: null, courseType: null, distance: null, weather: null, trackCondition: null });
    // D1 の値(馬の prior・印・配分)は残る
    expect(view.horses.map((h) => [h.umaban, h.prior, h.mark])).toEqual([[1, 0.2, "◎"], [2, 0.2, null], [3, 0.2, "◎"]]);
    expect(view.allocation).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain("アルファ");
  });

  it("壊れたスナップショットで例外を投げない(null・文字列・horses が配列でない・race が数値・名前が文字列でない・umaban が文字列)。取れないものは null", () => {
    const broken: unknown[] = [
      null,
      "text",
      42,
      { race: 5, horses: "x" },
      { race: { raceName: 123, distance: "1800", weather: { a: 1 } }, horses: [{ umaban: "1", name: "文字列の馬番" }, { umaban: 1, name: 123 }, null, "x"] },
    ];
    for (const raceSnapshot of broken) {
      const view = buildAnalysisView(detail(analysis({ raceSnapshot }), "present"), undefined);
      expect(view.horses.map((h) => h.name), JSON.stringify(raceSnapshot)).toEqual([null, null, null]);
      expect(view.race.raceName).toBeNull();
      expect(view.race.distance).toBeNull();
      expect(view.race.weather).toBeNull();
      expect(view.race.venueName).toBe("福島"); // raceId から導く値は、スナップショットが壊れていても取れる
    }
  });

  it("退化入力: 馬 0 頭・不正な raceId(12 桁でない)でも例外を投げず、場名・R は null", () => {
    const view = buildAnalysisView(detail(analysis({ horses: [], raceId: "R0001" }), "present"), undefined);
    expect(view.horses).toEqual([]);
    expect(view.race.venueName).toBeNull();
    expect(view.race.raceNumber).toBeNull();
  });

  it("地方のレースIDは、場名(地方の表)と R を raceId から導く", () => {
    const view = buildAnalysisView(detail(analysis({ raceId: "202654071210" }), "missing"), undefined);
    expect(view.race.venueName).toBe("高知");
    expect(view.race.raceNumber).toBe(10);
  });

  it("書き込み側との drift: 実フィクスチャの RaceData から buildRaceSnapshot で作ったスナップショットを通すと、全頭の馬名・レース名が取れる", async () => {
    const { race } = await scrapeFixtureRace();
    expect(race.horses.length).toBeGreaterThan(0); // 前提(空振り防止)
    const snapshot = buildRaceSnapshot(race);
    const horses = race.horses.map((h) => horse(h.shutuba.umaban));
    const view = buildAnalysisView(detail(analysis({ horses, raceSnapshot: JSON.parse(JSON.stringify(snapshot)) }), "present"), undefined);
    expect(view.horses.map((h) => h.name)).toEqual(race.horses.map((h) => h.shutuba.name));
    expect(view.horses.every((h) => typeof h.name === "string" && h.name.length > 0)).toBe(true);
    expect(view.race.raceName).toBe(race.race.raceName);
    expect(view.race.distance).toBe(race.race.distance);
    expect(view.race.courseType).toBe(race.race.courseType);
  });
});
