import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { parseAnalysisResponse, type AnalysisDetail } from "../client/api-analysis";
import { buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { buildAnalysisView } from "../src/analysis-view";
import { noopActions } from "./client-fakes";

/**
 * Issue #677: オッズの取得元の行(クライアントは、サーバが組み立てた行を並べるだけ)。サーバの本物の組み立て(`buildAnalysisView` の `oddsSources`)の出力を JSON にして、
 * クライアントの解析と描画を通す。記録なし(null)・キー無し(古いサーバの応答)・形が不正なときは節ごと出さず、ほかの解析は失敗しない。閲覧者と管理者で同じに出る。
 */

function horse(umaban: number, over: Partial<StoredAnalysisHorse> = {}): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [], ...over } as StoredAnalysisHorse;
}

function viewJson(oddsSources: unknown): unknown {
  const analysis = {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses: [horse(1), horse(2)],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: "claude-sonnet-5-5",
    rawResponse: null,
    raceSnapshot: null,
    historyCutoffDate: null,
  } as StoredAnalysis;
  const view = buildAnalysisView({ analysis, detail: "none", llmNote: null, llmCalls: null }, undefined);
  const { oddsSources: _o, ...rest } = view;
  return JSON.parse(JSON.stringify({ ok: true, analysis: oddsSources === undefined ? rest : { ...rest, oddsSources } }));
}

const SRC = JSON.stringify({ v: 1, sources: { winPlace: { source: "jra", officialDatetime: "2026-06-28 14:05:00" }, trifecta: { source: "netkeiba", officialDatetime: null } } });
/** サーバの本物の組み立て。 */
const REAL = (() => {
  const analysis = { id: 7, raceId: "202603020211", analyzedAt: "2026-06-28T05:00:00.000Z", horses: [horse(1)], evEstimated: false, promptVersion: null, additionalInstruction: null, kaisaiDate: "20260628", model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: null } as StoredAnalysis;
  return buildAnalysisView({ analysis, detail: "none", llmNote: null, llmCalls: null, oddsSourcesJson: SRC }, undefined).oddsSources!;
})();

function parse(value: unknown): AnalysisDetail {
  const r = parseAnalysisResponse(200, viewJson(value));
  if (!r.ok) throw new Error("応答が読めない");
  return r.analysis;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const rawText = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(rawText).join("\n"));
const ROUTE = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false } as const;
const treeOf = (a: AnalysisDetail, readOnly: boolean): VNode => renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a }, readOnly }), noopActions);

describe("クライアントの解析", () => {
  it("サーバの本物の行を、そのまま読む", () => {
    expect(REAL.lines).toEqual(["オッズ: 単勝・複勝は JRA(6/28 14:05 現在)、3連単は netkeiba"]);
    expect(parse(REAL).oddsSources?.lines).toEqual(REAL.lines);
  });

  it.each([
    ["null(記録なし)", null],
    ["行が空", { lines: [] }],
    ["行が配列でない", { lines: "x" }],
    ["行に文字列でないものが混じる", { lines: ["a", 1] }],
    ["行が 3 行以上", { lines: ["a", "b", "c"] }],
    ["行が長すぎる", { lines: ["a".repeat(301)] }],
  ])("%s は節ごと null にし、ほかの解析は失敗しない", (_name, value) => {
    const a = parse(value);
    expect(a.oddsSources ?? null).toBeNull();
    expect(a.id).toBe(7);
  });

  it("キー無し(古いサーバの応答)は null", () => {
    expect(parse(undefined).oddsSources ?? null).toBeNull();
  });
});

describe("描画", () => {
  it.each([
    ["管理者", false],
    ["閲覧者", true],
  ])("%s: 全部の行を、1 つの節に並べる", (_role, readOnly) => {
    const sections = byClass(treeOf(parse(REAL), readOnly), "odds-sources");
    expect(sections).toHaveLength(1);
    expect(rawText(sections[0]!)).toContain(REAL.lines[0]!);
  });

  it("2 行のときは 2 行とも出す", () => {
    const two = { lines: ["オッズ: A、B", "C"] };
    const text = rawText(byClass(treeOf(parse(two), true), "odds-sources")[0]!);
    expect(text).toContain("オッズ: A、B");
    expect(text).toContain("C");
  });

  it("記録なし(null)・キー無しのときは節を出さない", () => {
    expect(byClass(treeOf(parse(null), false), "odds-sources")).toHaveLength(0);
    expect(byClass(treeOf(parse(undefined), false), "odds-sources")).toHaveLength(0);
  });
});
