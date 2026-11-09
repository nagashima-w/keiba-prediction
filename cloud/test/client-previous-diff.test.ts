import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { parseAnalysisResponse, type AnalysisDetail } from "../client/api-analysis";
import { buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { buildPreviousDiff } from "../src/analysis-diff-view";
import { buildAnalysisView } from "../src/analysis-view";
import { noopActions } from "./client-fakes";

/**
 * Issue #583: 前の分析との差の節(クライアントは、サーバが組み立てた見出しと行を並べるだけ)。サーバの本物の組み立て(`buildPreviousDiff`)の出力を JSON にして、
 * クライアントの解析と描画を通す。差が無い(null)・キー無し(古いサーバの応答)・形が不正なときは節ごと出さず、ほかの解析は失敗しない。閲覧者と管理者で同じに出る。
 */

function horse(umaban: number, over: Partial<StoredAnalysisHorse> = {}): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [], ...over } as StoredAnalysisHorse;
}

function viewJson(previousDiff: unknown): unknown {
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
  return JSON.parse(JSON.stringify({ ok: true, analysis: previousDiff === undefined ? view : { ...view, previousDiff } }));
}

/** サーバの本物の組み立て: 1 番の印と確率が動いた差。 */
const REAL_DIFF = (() => {
  const mk = (mark: string | null, adj: number) => [
    { umaban: 1, name: "アルファ", mark, prior: 0.2, adjustedProb: adj },
    { umaban: 2, name: "ブラボー", mark: null, prior: 0.2, adjustedProb: 0.2 },
  ];
  return buildPreviousDiff(
    { model: "m", llmNote: null, allocation: null, horses: mk("◎", 0.3) },
    { id: 3, analyzedAt: "2026-06-28T01:00:00.000Z", model: "m", llmNote: null, allocation: null, horses: mk(null, 0.2) },
  );
})();

function parse(previousDiff: unknown): AnalysisDetail {
  const r = parseAnalysisResponse(200, viewJson(previousDiff));
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
  it("サーバの本物の差の見出しと行を、そのまま読む", () => {
    const a = parse(REAL_DIFF);
    expect(a.previousDiff?.title).toBe(REAL_DIFF.title);
    expect(a.previousDiff?.lines).toEqual(REAL_DIFF.lines);
    expect(REAL_DIFF.lines.length).toBeGreaterThanOrEqual(2); // 前提: 印と確率の行が実際にある
  });

  it.each([
    ["null(前の分析なし・読み出し失敗)", null],
    ["行が空", { previousId: 3, title: "t", lines: [] }],
    ["行が配列でない", { previousId: 3, title: "t", lines: "x" }],
    ["行に文字列でないものが混じる", { previousId: 3, title: "t", lines: ["a", 1] }],
    ["行が多すぎる", { previousId: 3, title: "t", lines: Array.from({ length: 41 }, () => "a") }],
    ["行が長すぎる", { previousId: 3, title: "t", lines: ["a".repeat(301)] }],
    ["見出しが文字列でない", { previousId: 3, title: 5, lines: ["a"] }],
    ["見出しが長すぎる", { previousId: 3, title: "t".repeat(101), lines: ["a"] }],
  ])("%s は節ごと null にし、ほかの解析は失敗しない", (_name, value) => {
    const a = parse(value);
    expect(a.previousDiff ?? null).toBeNull();
    expect(a.id).toBe(7);
  });

  it("キー無し(古いサーバの応答)は null", () => {
    expect(parse(undefined).previousDiff ?? null).toBeNull();
  });
});

describe("描画", () => {
  it.each([
    ["管理者", false],
    ["閲覧者", true],
  ])("%s: 見出しと全部の行を、1 つの節に並べる", (_role, readOnly) => {
    const tree = treeOf(parse(REAL_DIFF), readOnly);
    const sections = byClass(tree, "prev-diff");
    expect(sections).toHaveLength(1);
    const text = rawText(sections[0]!);
    expect(text).toContain(REAL_DIFF.title);
    for (const line of REAL_DIFF.lines) expect(text).toContain(line);
  });

  it("差が無い(null)ときは節を出さない", () => {
    expect(byClass(treeOf(parse(null), false), "prev-diff")).toHaveLength(0);
  });

  it("「変わったところはありません」も節として出す", () => {
    const none = buildPreviousDiff(
      { model: "m", llmNote: null, allocation: null, horses: [] },
      { id: 3, analyzedAt: "2026-06-28T01:00:00.000Z", model: "m", llmNote: null, allocation: null, horses: [] },
    );
    const text = rawText(byClass(treeOf(parse(none), true), "prev-diff")[0]!);
    expect(text).toContain("変わったところはありません");
  });
});
