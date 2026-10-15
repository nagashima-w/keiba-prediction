import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { PARSE_DEVELOPMENT_MAX_CODEPOINTS } from "../../packages/core/src/analyzer/parse-response";
import { parseAnalysisResponse, type AnalysisDetail } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { DEVELOPMENT_HEADING, buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { buildAnalysisView } from "../src/analysis-view";
import { noopActions } from "./client-fakes";

/**
 * Issue #315: 分析の画面に出す「AI の展開予想」(LLM が展開予想して決めた想定ペースと短文)。サーバの本物の整形(`buildAnalysisView`)の出力を JSON にして、
 * クライアントの解析・表示用データ・画面を通す。LLM を使わない分析・古い分析・読めない応答・詳細なし・古いサーバの応答は、何も出さない。
 */

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

const RAW = JSON.stringify({ development: "逃げ馬が不在で隊列は落ち着く見立て。前の馬が残りやすい。", pace: "スロー", horses: [{ number: 1, place_prob: 0.4, reason: "r", mark: "◎" }] });
const SNAP = { race: { raceName: "テスト", courseType: "芝" }, horses: [{ umaban: 1, name: "アルファ" }, { umaban: 2, name: "ブラボー" }] };

function viewOf(rawResponse: string | null, detail: "present" | "none" = "present"): ReturnType<typeof buildAnalysisView> {
  const analysis = {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1), horse(2)],
    evEstimated: false,
    promptVersion: "2026-10-15.1",
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: "claude-sonnet-5-5",
    rawResponse,
    raceSnapshot: SNAP,
    historyCutoffDate: "20260627",
  } as StoredAnalysis;
  return buildAnalysisView({ analysis, detail, llmNote: null, llmCalls: null }, undefined);
}

/** サーバの本物の整形 → JSON → クライアントの解析。 */
function parsedWith(rawResponse: string | null, detail: "present" | "none" = "present"): AnalysisDetail {
  const result = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: viewOf(rawResponse, detail) })));
  if (!result.ok) throw new Error("サーバの応答をクライアントが読めない(契約の食い違い)");
  return result.analysis;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const rawText = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(rawText).join(""));

const ROUTE = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false } as const;
const treeOf = (a: AnalysisDetail): VNode => renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a } }), noopActions);
const contentOf = (a: AnalysisDetail) => buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a } }).content!;

describe("クライアントの解析(api-analysis.ts)", () => {
  it("サーバの本物の応答の development を、そのまま読む", () => {
    const a = parsedWith(RAW);
    expect(a.development).toEqual({ text: "逃げ馬が不在で隊列は落ち着く見立て。前の馬が残りやすい。", pace: "スロー" });
  });

  it("LLM の値が無い(生応答なし・旧い応答・詳細なし)は null。ほかの項目の解析は失敗しない", () => {
    expect(parsedWith(null).development ?? null).toBeNull();
    expect(parsedWith(JSON.stringify({ horses: [] })).development ?? null).toBeNull();
    expect(parsedWith(RAW, "none").development ?? null).toBeNull();
    // キー無し(古いサーバの応答)
    const { development: _omit, ...withoutKey } = viewOf(RAW);
    const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: withoutKey })));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && (parsed.analysis.development ?? null)).toBeNull();
  });

  it("pace だけ・text だけでも読める(もう一方は null)", () => {
    expect(parsedWith(JSON.stringify({ pace: "ハイ", horses: [] })).development).toEqual({ text: null, pace: "ハイ" });
    expect(parsedWith(JSON.stringify({ development: "脚質が不明のため判断できない。", pace: null, horses: [] })).development).toEqual({ text: "脚質が不明のため判断できない。", pace: null });
  });

  it("形が不正な development(型の違う値・3 値以外の pace・両方 null・長すぎる text)は null にする(分析全体の解析は成功のまま)", () => {
    const base = JSON.parse(JSON.stringify(viewOf(RAW))) as Record<string, unknown>;
    const bads: unknown[] = [
      "x", 1, [], {},
      { text: 1, pace: "ハイ" },
      { text: "d", pace: "不明" },
      { text: "d", pace: "ややハイ" },
      { text: "d", pace: 3 },
      { text: null, pace: null },
      { text: "あ".repeat(PARSE_DEVELOPMENT_MAX_CODEPOINTS * 2 + 1), pace: "ハイ" },
    ];
    for (const bad of bads) {
      const parsed = parseAnalysisResponse(200, { ok: true, analysis: { ...base, development: bad } });
      expect(parsed.ok, JSON.stringify(bad)).toBe(true);
      expect(parsed.ok && (parsed.analysis.development ?? null), JSON.stringify(bad)).toBeNull();
    }
    // 対照: 上限ちょうど(500 コードポイント = 絵文字なら UTF-16 で 1000)は読める
    const edge = parseAnalysisResponse(200, { ok: true, analysis: { ...base, development: { text: "😀".repeat(PARSE_DEVELOPMENT_MAX_CODEPOINTS), pace: "ハイ" } } });
    expect(edge.ok && edge.analysis.development?.text?.length).toBe(PARSE_DEVELOPMENT_MAX_CODEPOINTS * 2);
  });
});

describe("表示用データ(result.ts)", () => {
  it("development があれば見出し・本文・想定ペースの行。無ければ null", () => {
    const section = contentOf(parsedWith(RAW)).development;
    expect(section).toEqual({ heading: DEVELOPMENT_HEADING, text: "逃げ馬が不在で隊列は落ち着く見立て。前の馬が残りやすい。", paceLine: "想定ペース(AI): スロー" });
    expect(DEVELOPMENT_HEADING).toContain("展開予想");
    expect(contentOf(parsedWith(null)).development).toBeNull();
  });

  it("pace が null(判断できない)なら行は無く、text が null なら本文は無い", () => {
    expect(contentOf(parsedWith(JSON.stringify({ development: "判断できない。", pace: null, horses: [] }))).development).toEqual({ heading: DEVELOPMENT_HEADING, text: "判断できない。", paceLine: null });
    expect(contentOf(parsedWith(JSON.stringify({ pace: "平均", horses: [] }))).development).toEqual({ heading: DEVELOPMENT_HEADING, text: null, paceLine: "想定ペース(AI): 平均" });
  });
});

describe("画面(view.ts)", () => {
  it("値があれば section.development に見出し・本文・想定ペースが出る。位置は「3着内率の上位5頭」の後・「馬ごとの評価」の前", () => {
    const tree = treeOf(parsedWith(RAW));
    const sections = byClass(tree, "development");
    expect(sections).toHaveLength(1);
    expect(rawText(sections[0]!)).toContain(DEVELOPMENT_HEADING);
    expect(byClass(sections[0]!, "development-text").map(rawText)).toEqual(["逃げ馬が不在で隊列は落ち着く見立て。前の馬が残りやすい。"]);
    expect(byClass(sections[0]!, "development-pace").map(rawText)).toEqual(["想定ペース(AI): スロー"]);
    const order = findAll(tree, (n) => n.tag === "section").map((n) => (n.attrs?.["class"] ?? "").toString());
    expect(order.indexOf("development")).toBeGreaterThan(order.indexOf("top-probs"));
    expect(order.indexOf("development")).toBeLessThan(order.indexOf("horses"));
  });

  it("値が無い(LLM を使わない・旧い応答・詳細なし)ときは、何も出ない", () => {
    expect(byClass(treeOf(parsedWith(null)), "development")).toHaveLength(0);
    expect(byClass(treeOf(parsedWith(RAW, "none")), "development")).toHaveLength(0);
  });

  it("text が null なら本文の要素は出さず、pace が null なら想定ペースの要素は出さない", () => {
    const onlyPace = treeOf(parsedWith(JSON.stringify({ pace: "ハイ", horses: [] })));
    expect(byClass(onlyPace, "development-text")).toHaveLength(0);
    expect(byClass(onlyPace, "development-pace")).toHaveLength(1);
    const onlyText = treeOf(parsedWith(JSON.stringify({ development: "判断できない。", pace: null, horses: [] })));
    expect(byClass(onlyText, "development-text")).toHaveLength(1);
    expect(byClass(onlyText, "development-pace")).toHaveLength(0);
  });

  it("外から来た文字列(LLM の出力)でも、許可リストの要素・属性だけで組み立てられる(HTML として解釈しない)", () => {
    const evil = JSON.stringify({ development: "<img src=x onerror=alert(1)>", pace: "ハイ", horses: [] });
    const tree = treeOf(parsedWith(evil));
    const tags: string[] = [];
    const texts: string[] = [];
    const doc: DomDocument = {
      createElement: (tag) => {
        tags.push(tag);
        return { setAttribute() {}, appendChild() {}, addEventListener() {} };
      },
      createTextNode: (text) => {
        texts.push(text);
        return {};
      },
    };
    mount(doc, { replaceChildren() {} }, tree);
    expect(tags).not.toContain("img");
    expect(texts.some((t) => t.includes("<img src=x onerror=alert(1)>"))).toBe(true);
  });
});
