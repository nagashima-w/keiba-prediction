import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { dayBabaLines, type DayBaba } from "../../packages/core/src/analyzer/day-baba";
import { parseAnalysisResponse, type AnalysisDetail } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { BABA_HEADING, buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { buildAnalysisView } from "../src/analysis-view";
import { noopActions } from "./client-fakes";

/**
 * Issue #295: 分析の画面に出す「そのとき LLM が見た当日の馬場の値」。サーバの本物の整形(`buildAnalysisView`)の出力を JSON にして、クライアントの解析・表示用データ・VNode に通す(契約を兼ねる)。
 * 地方・値が無いとき・古い分析・古いサーバの応答は、何も出さない。
 */

const BABA: DayBaba = {
  measuredAt: "2026-06-28T07:00+09:00",
  cushion: 9.6,
  turf: { condition: "良", goalCondition: "良", corner4Condition: "良", goalMoisture: 13.2, corner4Moisture: 11.8 },
  dirt: null,
  usedCourse: "Aコース（内柵を最内に設置）",
  turfStateText: "1週使用しましたが、傷みは少なく概ね良好な状態です。",
};

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

/** サーバの本物の整形 → JSON → クライアントの解析。 */
function parsedWith(snapshot: unknown, detail: "present" | "none" = "present"): AnalysisDetail {
  const analysis = {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1), horse(2)],
    evEstimated: false,
    promptVersion: "2026-10-13.2",
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: "claude-sonnet-5-5",
    rawResponse: null,
    raceSnapshot: snapshot,
    historyCutoffDate: "20260627",
  } as StoredAnalysis;
  const view = buildAnalysisView({ analysis, detail, llmNote: null, llmCalls: null }, undefined);
  const result = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: view })));
  if (!result.ok) throw new Error("サーバの応答をクライアントが読めない(契約の食い違い)");
  return result.analysis;
}
const SNAP = { race: { raceName: "テスト", courseType: "芝" }, horses: [{ umaban: 1, name: "アルファ" }, { umaban: 2, name: "ブラボー" }], baba: BABA };

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const rawText = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(rawText).join(""));

const ROUTE = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false } as const;
const treeOf = (a: AnalysisDetail): VNode => renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a } }), noopActions);

describe("クライアントの解析(api-analysis.ts)", () => {
  it("サーバの本物の応答の baba.lines を、そのまま読む", () => {
    const a = parsedWith(SNAP);
    expect(a.baba).toEqual({ lines: dayBabaLines(BABA) });
    expect(a.baba!.lines.length).toBeGreaterThan(3); // 前提: 行が実際にある
  });

  it("値が無い(null)・キー無し(古いサーバの応答)は null。ほかの項目の解析は失敗しない", () => {
    expect(parsedWith({ ...SNAP, baba: undefined }).baba ?? null).toBeNull();
    expect(parsedWith(SNAP, "none").baba ?? null).toBeNull();
    // キー無し(古いサーバの応答)
    const view = buildAnalysisView({ analysis: { id: 7, raceId: "202603020211", analyzedAt: "2026-06-28T05:00:00.000Z", horses: [horse(1)], evEstimated: false, promptVersion: null, additionalInstruction: null, kaisaiDate: "20260628", model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: null } as unknown as StoredAnalysis, detail: "none", llmNote: null, llmCalls: null }, undefined);
    const { baba: _omit, ...withoutKey } = view;
    const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: withoutKey })));
    expect(parsed.ok && (parsed.analysis.baba ?? null)).toBeNull();
    expect(parsed.ok).toBe(true);
  });

  it("形が不正な baba(lines が配列でない・文字列でない要素・空・多すぎる・長すぎる)は null にする(分析全体の解析は成功のまま)", () => {
    const view = buildAnalysisView({ analysis: { id: 7, raceId: "202603020211", analyzedAt: "2026-06-28T05:00:00.000Z", horses: [horse(1)], evEstimated: false, promptVersion: null, additionalInstruction: null, kaisaiDate: "20260628", model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: null } as unknown as StoredAnalysis, detail: "none", llmNote: null, llmCalls: null }, undefined);
    const bads: unknown[] = ["x", 1, {}, { lines: "a" }, { lines: [1] }, { lines: [] }, { lines: Array.from({ length: 13 }, () => "a") }, { lines: ["あ".repeat(601)] }];
    for (const bad of bads) {
      const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...view, baba: bad } })));
      expect(parsed.ok, JSON.stringify(bad)).toBe(true);
      expect(parsed.ok && (parsed.analysis.baba ?? null), JSON.stringify(bad)).toBeNull();
    }
    // 対照: 上限ちょうどは読める
    const ok = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...view, baba: { lines: Array.from({ length: 12 }, () => "あ".repeat(600)) } } })));
    expect(ok.ok && ok.analysis.baba?.lines.length).toBe(12);
  });
});

describe("表示用データ(result.ts)", () => {
  it("baba があれば見出し(AI に渡した当日の馬場)と行。無ければ null", () => {
    const withBaba = buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: parsedWith(SNAP) } }).content!;
    expect(withBaba.baba).toEqual({ heading: BABA_HEADING, lines: dayBabaLines(BABA) });
    expect(BABA_HEADING).toContain("AI に渡した");
    const without = buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: parsedWith({ ...SNAP, baba: undefined }) } }).content!;
    expect(without.baba).toBeNull();
  });
});

describe("画面(view.ts)", () => {
  it("値があれば section.baba に見出しと行が出る。位置は「3着内率の上位5頭」の後・「馬ごとの評価」の前", () => {
    const tree = treeOf(parsedWith(SNAP));
    const sections = byClass(tree, "baba");
    expect(sections).toHaveLength(1);
    const lines = byClass(sections[0]!, "baba-line").map(rawText);
    expect(lines).toEqual(dayBabaLines(BABA));
    expect(rawText(sections[0]!)).toContain(BABA_HEADING);
    const order = findAll(tree, (n) => n.tag === "section").map((n) => (n.attrs?.["class"] ?? "").toString());
    expect(order.indexOf("baba")).toBeGreaterThan(order.indexOf("top-probs"));
    expect(order.indexOf("baba")).toBe(order.indexOf("horses") - 1);
  });

  it("値が無い(地方・LLM を使わない・計測が無い日・詳細なし・古い分析)ときは、何も出ない", () => {
    expect(byClass(treeOf(parsedWith({ ...SNAP, baba: undefined })), "baba")).toHaveLength(0);
    expect(byClass(treeOf(parsedWith(SNAP, "none")), "baba")).toHaveLength(0);
  });

  it("外から来た文字列でも、許可リストの要素・属性だけで組み立てられる(HTML として解釈しない)", () => {
    const evil = { ...SNAP, baba: { ...BABA, turfStateText: "<img src=x onerror=alert(1)>" } };
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
