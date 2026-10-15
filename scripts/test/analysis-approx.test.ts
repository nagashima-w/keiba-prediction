import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../packages/core/src/analyzer/build-prompt.js";
import { checkResponse, SCHEMA_EXAMPLE_DEVELOPMENT, SCHEMA_EXAMPLE_PACE } from "../analysis-approx/check.js";
import { buildSyntheticScenarios, renderScenario, ruleFactsOf, SYNTHETIC_SCENARIO_IDS, type ScenarioFacts } from "../analysis-approx/scenarios.js";

/**
 * Issue #315: 近似確認の道具(scripts/analysis-approx/)の純関数の検査。実 API には出ない。
 * シナリオは固定(乱数なし)で、規則の想定ペース(旧プロンプトの結論)が意図どおりになる入力であること、
 * プロンプトに規則の結論が載らないこと、応答の観察項目が本番の解析と一致することを固定する。
 */
describe("合成シナリオ S1〜S6", () => {
  const scenarios = buildSyntheticScenarios();

  it("S1〜S6 が順にそろう(id の列)", () => {
    expect(scenarios.map((s) => s.id)).toEqual([...SYNTHETIC_SCENARIO_IDS]);
  });

  it("決定的: 2 回作ると全文が一致する", () => {
    const a = buildSyntheticScenarios().map((s) => buildPrompt(s.input));
    const b = buildSyntheticScenarios().map((s) => buildPrompt(s.input));
    expect(a).toEqual(b);
  });

  const expected: ReadonlyArray<{ readonly id: string; readonly pace: string; readonly heads: number; readonly escapers: number | null }> = [
    { id: "S1", pace: "ハイ", heads: 12, escapers: 3 },
    { id: "S2", pace: "スロー", heads: 10, escapers: 0 },
    { id: "S3", pace: "平均", heads: 14, escapers: 1 },
    { id: "S4", pace: "不明", heads: 9, escapers: null },
    { id: "S5", pace: "ハイ", heads: 12, escapers: 2 },
    { id: "S6", pace: "ハイ", heads: 18, escapers: 2 },
  ];
  for (const e of expected) {
    it(`${e.id}: 規則の想定ペースは ${e.pace}・${e.heads} 頭${e.escapers === null ? "(全頭不明)" : `・逃げ ${e.escapers} 頭`}`, () => {
      const s = scenarios.find((x) => x.id === e.id)!;
      const rule = ruleFactsOf(s.input);
      expect(rule.pace).toBe(e.pace);
      expect(s.input.horses).toHaveLength(e.heads);
      if (e.escapers !== null) expect(rule.styleCounts.逃げ).toBe(e.escapers);
      else expect(rule.unknownCount).toBe(e.heads);
    });
  }

  it("新しいプロンプトには規則の結論(ペース想定・恵まれる/損する脚質の行)が載らない。全シナリオ", () => {
    for (const s of scenarios) {
      const lines = buildPrompt(s.input).split("\n");
      expect(lines.some((l) => /^(ペース想定|恵まれる脚質|損する脚質)/.test(l)), s.id).toBe(false);
    }
  });

  it("S5 は地方・不良(地方の前残りの行が出る)、S4 は全頭不明の注記が出る、他は出ない", () => {
    const p = (id: string): string => buildPrompt(scenarios.find((x) => x.id === id)!.input);
    expect(p("S5")).toContain("地方競馬は前残り");
    expect(p("S1")).not.toContain("地方競馬は前残り");
    expect(p("S4")).toContain("注記: 出走全頭の脚質が不明です");
    expect(p("S1")).not.toContain("注記: 出走全頭の脚質が不明です");
  });

  it("facts: 馬番の昇順・prior が全馬分・プロンプトの長さが全文のコードポイント数と一致", () => {
    for (const s of scenarios) {
      const { prompt, facts } = renderScenario(s, 0.1);
      expect(facts.priors.map((p) => p.umaban), s.id).toEqual([...s.input.horses].map((h) => h.umaban).sort((a, b) => a - b));
      expect(facts.promptLength).toBe(Array.from(prompt).length);
      expect(facts.maxAdjust).toBe(0.1);
    }
  });
});

describe("checkResponse(応答の観察項目)", () => {
  const facts: ScenarioFacts = {
    scenario: "S1",
    title: "t",
    observe: "o",
    maxAdjust: 0.1,
    priors: [1, 2, 3, 4].map((umaban) => ({ umaban, prior: 0.3 })),
    rule: { pace: "ハイ", styleCounts: { 逃げ: 2, 先行: 0, 差し: 1, 追込: 1 }, unknownCount: 0, paceSetterUmaban: 1 },
    promptLength: 100,
  };
  const horses = (marks: Array<string | null> = ["◎", "〇", "▲", "△"]): unknown[] => marks.map((m, i) => ({ number: i + 1, place_prob: 0.3, reason: "r", mark: m }));
  const make = (top: Record<string, unknown>, hs: unknown[] = horses()): string => JSON.stringify({ ...top, horses: hs });

  it("正常: ok・規則と一致・development が pace の語を含む・キー順 OK", () => {
    const r = checkResponse(make({ development: "逃げ馬が2頭でハイペースの見立て。", pace: "ハイ" }), facts);
    expect(r.outcome).toBe("ok");
    expect(r.allUmabansPresent).toBe(true);
    expect(r.pace).toBe("ハイ");
    expect(r.paceMatchesRule).toBe(true);
    expect(r.developmentMentionsPace).toBe(true);
    expect(r.keyOrderOk).toBe(true);
    expect(r.copiedSchemaExample).toBe(false);
    expect(r.developmentHasForbiddenChars).toBe(false);
    expect(r.overInstructedLength).toBe(false);
  });

  it("規則と違う pace は paceMatchesRule=false(不具合ではなく観察項目)。development が語を含まなければ developmentMentionsPace=false", () => {
    const r = checkResponse(make({ development: "隊列は縦長になる。", pace: "スロー" }), facts);
    expect(r.pace).toBe("スロー");
    expect(r.paceMatchesRule).toBe(false);
    expect(r.developmentMentionsPace).toBe(false);
  });

  it("pace が null のとき: pace・規則との一致・語の有無はいずれも null", () => {
    const r = checkResponse(make({ development: "脚質が不明。", pace: null }), facts);
    expect(r.pace).toBeNull();
    expect(r.paceMatchesRule).toBeNull();
    expect(r.developmentMentionsPace).toBeNull();
  });

  it("例のコピー(スキーマの例の値をそのまま返した)を検出する", () => {
    expect(checkResponse(make({ development: SCHEMA_EXAMPLE_DEVELOPMENT, pace: "ハイ" }), facts).copiedSchemaExample).toBe(true);
    expect(checkResponse(make({ development: "d", pace: SCHEMA_EXAMPLE_PACE }), facts).copiedSchemaExample).toBe(true);
  });

  it("キー順が horses → development → pace なら keyOrderOk=false(解析はできる)", () => {
    const text = JSON.stringify({ horses: horses(), development: "d", pace: "ハイ" });
    const r = checkResponse(text, facts);
    expect(r.outcome).toBe("ok");
    expect(r.keyOrderOk).toBe(false);
  });

  it("200 字超は overInstructedLength=true、改行を含む development(エスケープされた \\n)は forbiddenChars=true", () => {
    expect(checkResponse(make({ development: "あ".repeat(201), pace: "ハイ" }), facts).overInstructedLength).toBe(true);
    expect(checkResponse(make({ development: "一行目\n二行目", pace: "ハイ" }), facts).developmentHasForbiddenChars).toBe(true);
    expect(checkResponse(make({ development: 'a "b" c', pace: "ハイ" }), facts).developmentHasForbiddenChars).toBe(true);
  });

  it("印の制約違反(◎が 0 頭)は mark-violation。確率は救済され、development は取り出せる", () => {
    const r = checkResponse(make({ development: "印違反でも残る", pace: "ハイ" }, horses([null, "〇", "▲", "△"])), facts);
    expect(r.outcome).toBe("mark-violation");
    expect(r.allUmabansPresent).toBe(true);
    expect(r.development).toBe("印違反でも残る");
  });

  it("本番ではフォールバックになる応答(JSON でない・horses が無い)は unusable。development は取り出せなければ null", () => {
    expect(checkResponse("申し訳ありません", facts).outcome).toBe("unusable");
    const noHorses = checkResponse(JSON.stringify({ development: "d", pace: "ハイ" }), facts);
    expect(noHorses.outcome).toBe("unusable");
    expect(noHorses.development).toBe("d");
    expect(checkResponse("申し訳ありません", facts).development).toBeNull();
  });

  it("馬が欠けた応答は ok だが allUmabansPresent=false・missingCount>0", () => {
    const r = checkResponse(make({ development: "d", pace: "ハイ" }, horses().slice(0, 3)), facts);
    expect(r.outcome).toBe("ok");
    expect(r.missingCount).toBeGreaterThan(0);
    expect(r.allUmabansPresent).toBe(false);
  });
});
