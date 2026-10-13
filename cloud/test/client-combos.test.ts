import { describe, expect, it } from "vitest";
import type { StoredAllocation, StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { parseAnalysisResponse, type AnalysisDetail } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { buildAnalysisView } from "../src/analysis-view";
import { noopActions } from "./client-fakes";

/**
 * Issue #296: 分析の画面の「配分の提案」の下に出す、組合せの券種ごとの行。サーバの本物の整形(`buildAnalysisView`)の出力を JSON にして、クライアントの解析・表示用データ・VNode に通す(契約を兼ねる)。
 * 値が無いとき・古いサーバの応答・形が不正な値は、何も出さない。
 */

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

const ALLOCATION: StoredAllocation = {
  route: "mixed",
  unavailableReason: null,
  fallbackReason: null,
  skipReasonCode: null,
  bankroll: 10000,
  perRaceCap: 300,
  kellyFraction: 0.5,
  evThreshold: 1,
  includeComboOdds: true,
  includeWide: true,
  includeTrio: true,
  includeQuinella: true,
  includeExacta: true,
  includeTrifecta: true,
  includeBracketQuinella: true,
  betUnit: 100,
  oddsStatus: "middle",
  bets: [{ betType: "win", comboKey: "04", stake: 100, odds: 5, ev: 1.2 }],
};

const SNAP = {
  race: { raceName: "テスト" },
  horses: [{ umaban: 1, name: "アルファ" }],
  wideCombo: { "0102": 12, "0103": 15 },
  trifectaCombo: { "010203": 12.3, "010302": 15.5 },
  comboOdds: {
    wide: { state: "available", diagnostics: { expectedComboCount: 2, attempts: [] } },
    exacta: { state: "unavailable", diagnostics: { expectedComboCount: 0, attempts: [] } },
    trifecta: { state: "available", diagnostics: { expectedComboCount: 2, attempts: [] } },
  },
  comboStats: { wide: { positive: 1, judged: 2 }, trifecta: { positive: 2, judged: 2 } },
};
const LINES = ["ワイド: オッズ 2 点取得・EV プラス 1 点・配分 0 点(他の買い目が優先、または 100 円未満)", "馬単: オッズなし(未発売・発売なし・読み取れず)", "三連単: オッズ 2 点取得・EV プラス 2 点・配分 0 点(他の買い目が優先、または 100 円未満)"];

function viewOf(snapshot: unknown, allocation: StoredAllocation | null = ALLOCATION, detail: "present" | "none" = "present") {
  const analysis = {
    id: 7,
    raceId: "202645101012",
    analyzedAt: "2026-10-13T08:00:00.000Z",
    horses: [horse(1), horse(2)],
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: "20261013",
    model: null,
    rawResponse: null,
    raceSnapshot: snapshot,
    historyCutoffDate: null,
  } as StoredAnalysis;
  return buildAnalysisView({ analysis, detail, llmNote: null, llmCalls: null }, allocation ?? undefined);
}

/** サーバの本物の整形 → JSON → クライアントの解析。 */
function parsedWith(snapshot: unknown, allocation: StoredAllocation | null = ALLOCATION, detail: "present" | "none" = "present"): AnalysisDetail {
  const result = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: viewOf(snapshot, allocation, detail) })));
  if (!result.ok) throw new Error("サーバの応答をクライアントが読めない(契約の食い違い)");
  return result.analysis;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const rawText = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(rawText).join(""));

const ROUTE = { date: "20261013", venue: "nar", race: null, analysis: 7, settings: false } as const;
const treeOf = (a: AnalysisDetail): VNode => renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a } }), noopActions);

describe("クライアントの解析(api-analysis.ts)", () => {
  it("サーバの本物の応答の combos.lines を、そのまま読む", () => {
    const a = parsedWith(SNAP);
    expect(a.combos).toEqual({ lines: LINES });
    expect(a.combos!.lines.length).toBe(3); // 前提: 行が実際にある
  });

  it("値が無い(null)・詳細なし・キー無し(古いサーバの応答)は null。ほかの項目の解析は失敗しない", () => {
    expect(parsedWith({ race: {}, horses: [] }).combos ?? null).toBeNull();
    expect(parsedWith(SNAP, ALLOCATION, "none").combos ?? null).toBeNull();
    const { combos: _omit, ...withoutKey } = viewOf(SNAP);
    const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: withoutKey })));
    expect(parsed.ok && (parsed.analysis.combos ?? null)).toBeNull();
    expect(parsed.ok).toBe(true);
  });

  it("形が不正な combos(lines が配列でない・文字列でない要素・空・多すぎる・長すぎる)は null にする(分析全体の解析は成功のまま)", () => {
    const view = viewOf(SNAP);
    const bads: unknown[] = ["x", 1, {}, { lines: "a" }, { lines: [1] }, { lines: [] }, { lines: Array.from({ length: 7 }, () => "a") }, { lines: ["あ".repeat(301)] }];
    for (const bad of bads) {
      const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...view, combos: bad } })));
      expect(parsed.ok, JSON.stringify(bad)).toBe(true);
      expect(parsed.ok && (parsed.analysis.combos ?? null), JSON.stringify(bad)).toBeNull();
    }
    // 対照: 上限ちょうど(6 券種・各 300 字)は読める
    const ok = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...view, combos: { lines: Array.from({ length: 6 }, () => "あ".repeat(300)) } } })));
    expect(ok.ok && ok.analysis.combos?.lines.length).toBe(6);
  });
});

describe("表示用データ(result.ts)", () => {
  it("combos があれば配分の節の comboLines に行を持つ。無ければ空配列", () => {
    const withCombos = buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: parsedWith(SNAP) } }).content!;
    expect(withCombos.allocation.comboLines).toEqual(LINES);
    const without = buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: parsedWith({ race: {}, horses: [] }) } }).content!;
    expect(without.allocation.comboLines).toEqual([]);
  });

  it("配分の記録が無い分析(kind none)でも、組合せの行は持つ(取得の点数だけの行)", () => {
    const a = parsedWith(SNAP, null);
    expect(a.allocation).toBeNull();
    const content = buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a } }).content!;
    expect(content.allocation.kind).toBe("none");
    expect(content.allocation.comboLines).toEqual(["ワイド: オッズ 2 点取得", "馬単: オッズなし(未発売・発売なし・読み取れず)", "三連単: オッズ 2 点取得"]);
  });
});

describe("画面(view.ts)", () => {
  it("値があれば、配分の提案の節の中の最後に ul.combo-counts として行が出る(設定の行の後)", () => {
    const tree = treeOf(parsedWith(SNAP));
    const lists = byClass(tree, "combo-counts");
    expect(lists).toHaveLength(1);
    expect(findAll(lists[0]!, (n) => n.tag === "li").map(rawText)).toEqual(LINES);
    const allocation = byClass(tree, "allocation")[0]!;
    const lastUl = (allocation.children ?? []).filter((c): c is VNode => typeof c !== "string" && c.tag === "ul").at(-1)!;
    expect(lastUl).toBe(lists[0]);
    const settings = byClass(allocation, "settings");
    expect(settings.length).toBeGreaterThan(0); // 前提: 設定の行がある(その後ろに出ていることの確認)
    expect((allocation.children ?? []).indexOf(lists[0]!)).toBeGreaterThan((allocation.children ?? []).indexOf(settings[0]!));
  });

  it("値が無い(組合せの記録なし・詳細なし・古い分析)ときは、何も出ない", () => {
    expect(byClass(treeOf(parsedWith({ race: {}, horses: [] })), "combo-counts")).toHaveLength(0);
    expect(byClass(treeOf(parsedWith(SNAP, ALLOCATION, "none")), "combo-counts")).toHaveLength(0);
  });

  it("外から来た文字列でも、許可リストの要素・属性だけで組み立てられる(HTML として解釈しない)", () => {
    const view = viewOf(SNAP);
    const evil = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...view, combos: { lines: ["<img src=x onerror=alert(1)>"] } } })));
    if (!evil.ok) throw new Error("読めるはず");
    const tree = treeOf(evil.analysis);
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
