import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { PARSE_DEVELOPMENT_MAX_CODEPOINTS } from "../../packages/core/src/analyzer/parse-response";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";

/**
 * Issue #315(想定ペースを LLM に展開予想させて決める): 応答に足した `development`(展開予想の短文と想定ペース)と、
 * `race.pace`(LLM の値があればそれ、無ければ従来の規則の値)・`race.paceSource`("llm"|"rule")。
 * 元は保存済みの生応答(R2 の詳細。`detail` が present のときだけ入る)から core の `extractDevelopment` で取り出す。
 * 生応答の本文そのものは返さない(許可した項目だけ)。
 */

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: {}, mark: null, reason: null, highlights: [], concerns: [] };
}

/** 脚質が全頭「差し」のスナップショット(規則の想定ペースは逃げ 0 頭 = スロー)。 */
const SNAPSHOT_RULE_SLOW = { race: {}, horses: [1, 2, 3, 4].map((umaban) => ({ umaban, legStyle: "差し" })) };

function analysis(rawResponse: string | null, over: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    id: 7,
    raceId: "202605020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1), horse(2), horse(3), horse(4)],
    evEstimated: false,
    promptVersion: "2026-10-15.1",
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: "m",
    rawResponse,
    raceSnapshot: SNAPSHOT_RULE_SLOW,
    historyCutoffDate: "20260627",
    ...over,
  } as StoredAnalysis;
}

const detail = (a: StoredAnalysis, status: DetailStatus = "present"): AnalysisDetailResult => ({ analysis: a, detail: status, llmNote: null, llmCalls: null });
const raw = (top: Record<string, unknown>): string => JSON.stringify({ ...top, horses: [{ number: 1, place_prob: 0.4, reason: "r", mark: "◎" }] });

describe("buildAnalysisView の development・race.pace(Issue #315)", () => {
  it("前提(空振り防止): 全頭差しのスナップショットでは、規則の想定ペースはスロー", () => {
    const view = buildAnalysisView(detail(analysis(null)), undefined);
    expect(view.race.pace).toBe("スロー");
    expect(view.race.paceSource).toBe("rule");
  });

  it("LLM の展開予想と想定ペースがあれば、development に載せ、race.pace は LLM の値(規則の値と違うときも LLM が勝つ)・paceSource は llm", () => {
    const view = buildAnalysisView(detail(analysis(raw({ development: "逃げ馬は不在だが先行馬が競り、流れは速くなる見立て。", pace: "ハイ" }))), undefined);
    expect(view.development).toEqual({ text: "逃げ馬は不在だが先行馬が競り、流れは速くなる見立て。", pace: "ハイ" });
    expect(view.race.pace).toBe("ハイ");
    expect(view.race.paceSource).toBe("llm");
  });

  it("LLM が pace を null にした(全頭脚質不明など)ときは、development の文だけ載せ、race.pace は規則の値・paceSource は rule", () => {
    const view = buildAnalysisView(detail(analysis(raw({ development: "脚質が不明で判断できない。", pace: null }))), undefined);
    expect(view.development).toEqual({ text: "脚質が不明で判断できない。", pace: null });
    expect(view.race.pace).toBe("スロー");
    expect(view.race.paceSource).toBe("rule");
  });

  it("pace だけあって development が無いときも載せる(text は null)。race.pace は LLM の値", () => {
    const view = buildAnalysisView(detail(analysis(raw({ pace: "平均" }))), undefined);
    expect(view.development).toEqual({ text: null, pace: "平均" });
    expect(view.race.pace).toBe("平均");
    expect(view.race.paceSource).toBe("llm");
  });

  it("スナップショットに脚質が無くても(規則は「不明」)、LLM の pace があれば race.pace はその値", () => {
    const a = analysis(raw({ development: "d", pace: "スロー" }), { raceSnapshot: { race: {}, horses: [{ umaban: 1 }] } });
    const view = buildAnalysisView(detail(a), undefined);
    expect(view.race.pace).toBe("スロー");
    expect(view.race.paceSource).toBe("llm");
  });

  const empties: ReadonlyArray<{ readonly name: string; readonly rawResponse: string | null }> = [
    { name: "生応答が無い(LLM を使わなかった・フォールバック)", rawResponse: null },
    { name: "旧い応答(development・pace のキーが無い)", rawResponse: raw({}) },
    { name: "JSON として読めない応答", rawResponse: "申し訳ありません" },
    { name: "development・pace がどちらも不正な値", rawResponse: raw({ development: 5, pace: "不明" }) },
  ];
  for (const t of empties) {
    it(`${t.name}: development は null・race.pace は規則の値・paceSource は rule`, () => {
      const view = buildAnalysisView(detail(analysis(t.rawResponse)), undefined);
      expect(view.development).toBeNull();
      expect(view.race.pace).toBe("スロー");
      expect(view.race.paceSource).toBe("rule");
    });
  }

  it("詳細が present でない(none・missing)ときは、生応答が万一入っていても使わず、development は null・pace は規則の「不明」・paceSource は rule", () => {
    for (const status of ["none", "missing"] as const) {
      const view = buildAnalysisView(detail(analysis(raw({ development: "漏れてはいけない", pace: "ハイ" })), status), undefined);
      expect(view.development, status).toBeNull();
      expect(view.race.pace, status).toBe("不明");
      expect(view.race.paceSource, status).toBe("rule");
      expect(JSON.stringify(view), status).not.toContain("漏れてはいけない");
    }
  });

  it("【漏洩】development のキーは text・pace だけ。生応答の他の項目(reason・別のキー)は応答のどこにも現れない", () => {
    const text = JSON.stringify({
      development: "展開",
      pace: "ハイ",
      system_prompt: "SECRET-TOP-LEVEL",
      horses: [{ number: 1, place_prob: 0.4, reason: "SECRET-REASON", mark: "◎", highlights: ["SECRET-HL"], concerns: [] }],
    });
    const view = buildAnalysisView(detail(analysis(text)), undefined);
    expect(Object.keys(view.development!).sort()).toEqual(["pace", "text"]);
    const json = JSON.stringify(view);
    for (const secret of ["SECRET-TOP-LEVEL", "SECRET-REASON", "SECRET-HL", "system_prompt"]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(Object.keys(view)).not.toContain("rawResponse");
  });

  it("長すぎる development は core の上限(500 コードポイント)で切られて届く", () => {
    const view = buildAnalysisView(detail(analysis(raw({ development: "あ".repeat(PARSE_DEVELOPMENT_MAX_CODEPOINTS + 50), pace: "平均" }))), undefined);
    expect(Array.from(view.development!.text!)).toHaveLength(PARSE_DEVELOPMENT_MAX_CODEPOINTS);
  });

  it("「ハイペース」「ミドル」などの表記ゆれは core の規則で 3 値に整って届く", () => {
    expect(buildAnalysisView(detail(analysis(raw({ development: "d", pace: "ハイペース" }))), undefined).development!.pace).toBe("ハイ");
    expect(buildAnalysisView(detail(analysis(raw({ development: "d", pace: "ミドル" }))), undefined).race.pace).toBe("平均");
  });
});
