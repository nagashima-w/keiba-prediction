import { describe, expect, it } from "vitest";
import type { StoredAllocation, StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { parseAnalysisResponse, type AnalysisDetail } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { buildRaceModel } from "../client/race";
import { buildResultModel, contentOf, UNSET_ALLOCATION_NOTE, UNSET_ALLOCATION_NOTE_VIEWER } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import type { StoredCloseRound } from "../src/analysis-close";
import { buildAnalysisView } from "../src/analysis-view";
import { noopActions } from "./client-fakes";

/**
 * Issue #344(#335-A2): 結果画面(と発走前のカード)の「締切直前の再計算」の節。サーバの本物の整形(`buildAnalysisView`)の出力を JSON にして、
 * クライアントの解析・表示用データ・VNode に通す(契約を兼ねる)。値が無い・古いサーバの応答・形が不正な値は、節ごと出さない。
 */

const RACE_ID = "202603020211";

function horse(umaban: number): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

const PROPOSAL: StoredAllocation = {
  route: "mixed",
  unavailableReason: null,
  fallbackReason: null,
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
  betUnit: 100,
  oddsStatus: "middle",
  bets: [
    { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
    { betType: "win", comboKey: "03", stake: 100, odds: 9, ev: 1.15 },
  ],
};
const AFTER: StoredAllocation = {
  ...PROPOSAL,
  bets: [
    { betType: "place", comboKey: "01", stake: 500, odds: 1.7, ev: 1.1 }, // 賭け金の変化
    { betType: "exacta", comboKey: "0301", stake: 100, odds: 40, ev: 1.4 }, // 追加(win:03 は削除)
  ],
};
const NO_BETS: StoredAllocation = { ...PROPOSAL, skipReasonCode: "no-edge", bets: [] };

const ok = (round: number, allocation: StoredAllocation): StoredCloseRound => ({ round, status: "ok", reason: null, dueAt: "2026-06-28T06:40:00.000Z", firedAt: "2026-06-28T06:40:02.000Z", lateMs: 2000, oddsOfficialDatetime: null, allocation });
const skipped = (round: number): StoredCloseRound => ({ round, status: "skipped", reason: "nar-unsupported", dueAt: "2026-06-28T06:43:00.000Z", firedAt: "2026-06-28T06:43:00.000Z", lateMs: 0, oddsOfficialDatetime: null, allocation: null });

function viewOf(close: readonly StoredCloseRound[] | undefined, proposal: StoredAllocation | undefined = PROPOSAL) {
  const analysis = {
    id: 7, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", horses: [horse(1), horse(2), horse(3)], evEstimated: false, promptVersion: null, additionalInstruction: null,
    kaisaiDate: "20260628", model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: null,
  } as StoredAnalysis;
  return buildAnalysisView({ analysis, detail: "none", llmNote: null, llmCalls: null }, proposal, close);
}

/** サーバの本物の整形 → JSON → クライアントの解析。 */
function parsedWith(close: readonly StoredCloseRound[] | undefined, proposal: StoredAllocation | undefined = PROPOSAL): AnalysisDetail {
  const result = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: viewOf(close, proposal) })));
  if (!result.ok) throw new Error("サーバの応答をクライアントが読めない(契約の食い違い)");
  return result.analysis;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));

const ROUTE = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false } as const;
const resultTree = (a: AnalysisDetail, readOnly = false): VNode => renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a }, readOnly }), noopActions);
const cardTree = (a: AnalysisDetail, resultOpen = true): VNode => {
  const rows = [{ raceId: RACE_ID, mode: "pre_race", status: "done", attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: 7 } as const];
  return renderScreen(
    buildRaceModel({ route: { ...ROUTE, race: RACE_ID, analysis: null }, status: { kind: "ready", rows, prior: null }, past: { kind: "ready", analyses: [] }, listRow: undefined, result: { kind: "ready", analysis: a }, resultOpen }),
    noopActions,
  );
};

describe("クライアントの解析(api-analysis.ts)", () => {
  it("サーバの本物の応答の close を読む: 回の見出し・文言の行・配分・差分の行(配分が無い回は null)", () => {
    const a = parsedWith([ok(1, AFTER), skipped(2)]);
    expect(a.close?.rounds.length).toBe(2); // 前提
    expect(a.close!.note).toBe("オッズだけを取り直し、確率は分析時のまま計算した結果です(分析時の提案は変わりません)。");
    const [r1, r2] = a.close!.rounds;
    expect(r1!.label).toBe("発走5分前");
    expect(r1!.summaryLines).toEqual(["再計算した", "15:40に実行"]);
    expect(r1!.allocation?.bets.length).toBe(2);
    expect(r1!.diffLines.length).toBeGreaterThan(0);
    expect(r2!.label).toBe("発走2分前");
    expect(r2!.summaryLines).toEqual(["行わなかった(地方は対象外です)", "15:43に実行"]);
    expect(r2!.allocation).toBeNull();
    expect(r2!.diffLines).toEqual([]);
  });

  it("結果が無い(null)・キー無し(古いサーバの応答)は close が null。ほかの項目の解析は失敗しない", () => {
    expect(parsedWith(undefined).close ?? null).toBeNull();
    const { close: _omit, ...withoutKey } = viewOf([ok(1, AFTER)]);
    const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: withoutKey })));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && (parsed.analysis.close ?? null)).toBeNull();
  });

  it("形が不正な close(rounds が配列でない・空・多すぎる・文字列でない行・多すぎる行・不正な配分・note が文字列でない)は null にする(分析全体の解析は成功のまま)", () => {
    const good = JSON.parse(JSON.stringify(viewOf([ok(1, AFTER), skipped(2)]).close));
    expect(good.rounds.length).toBe(2); // 前提: 加工の元は実際に 2 回ぶんある
    const r0 = good.rounds[0];
    const bads: [string, unknown][] = [
      ["rounds が配列でない", { ...good, rounds: "x" }],
      ["rounds が空", { ...good, rounds: [] }],
      ["rounds が多すぎる", { ...good, rounds: Array.from({ length: 5 }, () => r0) }],
      ["note が文字列でない", { ...good, note: 1 }],
      ["label が文字列でない", { ...good, rounds: [{ ...r0, label: 1 }] }],
      ["summaryLines に文字列でない要素", { ...good, rounds: [{ ...r0, summaryLines: [1] }] }],
      ["summaryLines が空", { ...good, rounds: [{ ...r0, summaryLines: [] }] }],
      ["diffLines が多すぎる", { ...good, rounds: [{ ...r0, diffLines: Array.from({ length: 11 }, () => "あ") }] }],
      ["diffLines の行が長すぎる", { ...good, rounds: [{ ...r0, diffLines: ["あ".repeat(301)] }] }],
      ["配分の形が不正", { ...good, rounds: [{ ...r0, allocation: { route: "mixed" } }] }],
    ];
    for (const [name, bad] of bads) {
      const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...viewOf(undefined), close: bad } })));
      expect(parsed.ok, name).toBe(true);
      expect(parsed.ok && (parsed.analysis.close ?? null), name).toBeNull();
    }
    // 対照: 上限ちょうど(4 回・各 10 行・各 300 字)は読める
    const edge = { ...good, rounds: Array.from({ length: 4 }, () => ({ ...r0, diffLines: Array.from({ length: 10 }, () => "あ".repeat(300)) })) };
    const okParsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...viewOf(undefined), close: edge } })));
    expect(okParsed.ok && okParsed.analysis.close?.rounds.length).toBe(4);
  });
});

describe("表示用データ(result.ts)", () => {
  it("close が無ければ content.close は null", () => {
    expect(contentOf(parsedWith(undefined)).close).toBeNull();
  });

  it("ok の回: 見出し・文言の行・表(分析時と同じ部品の行)・差分の行。行わなかった回は表も差分も空", () => {
    const content = contentOf(parsedWith([ok(1, AFTER), skipped(2)]));
    const close = content.close!;
    expect(close.heading).toBe("締切直前の再計算");
    expect(close.rounds.length).toBe(2); // 前提
    const [r1, r2] = close.rounds;
    expect(r1!.heading).toBe("発走5分前");
    expect(r1!.summaryLines).toEqual(["再計算した", "15:40に実行"]);
    expect(r1!.bets.map((b) => [b.betTypeLabel, b.comboLabel, b.stake])).toEqual([["複勝", "1番", "500円"], ["馬単", "3→1", "100円"]]);
    expect(r1!.diffLines[0]).toBe("追加 1点・削除 1点・賭け金の変化 1点(合計 400円 → 600円)");
    expect(r2!.heading).toBe("発走2分前");
    expect([r2!.bets, r2!.notices, r2!.diffLines]).toEqual([[], [], []]);
  });

  it("ok で配分が 0 点: 表は空で、見送りの理由(core の注記)と「配分は0点です」が出る", () => {
    const r = contentOf(parsedWith([ok(1, NO_BETS)], NO_BETS)).close!.rounds[0]!;
    expect(r.bets).toEqual([]);
    expect(r.notices.length).toBeGreaterThan(0);
    expect(r.diffLines).toEqual(["配分は0点です", "分析時から変わりませんでした"]);
  });

  it("閲覧者の扱いは配分の提案と同じ: 両方未設定の注記は、管理者と閲覧者で差し替えが分かれる(同じ関数を共有)。ほかの内容は同じ", () => {
    const UNSET: StoredAllocation = { ...PROPOSAL, route: "unset", bankroll: 0, perRaceCap: 0, skipReasonCode: "bankroll-unset", bets: [] };
    const a = parsedWith([ok(1, UNSET)], UNSET);
    const admin = contentOf(a, false);
    const viewer = contentOf(a, true);
    expect(admin.allocation.notices).toContain(UNSET_ALLOCATION_NOTE); // 前提: 提案の側の差し替えが効いている
    expect(viewer.allocation.notices).toContain(UNSET_ALLOCATION_NOTE_VIEWER);
    expect(admin.close!.rounds[0]!.notices).toEqual(admin.allocation.notices);
    expect(viewer.close!.rounds[0]!.notices).toEqual(viewer.allocation.notices);
    expect({ ...admin.close!, rounds: admin.close!.rounds.map((r) => ({ ...r, notices: [] })) }).toEqual({ ...viewer.close!, rounds: viewer.close!.rounds.map((r) => ({ ...r, notices: [] })) });
  });
});

describe("画面(view.ts)", () => {
  it("結果画面: 「配分の提案」の節の直後に section.close が出る。見出し(h2)・説明・回ごとの見出し・表・差分の行", () => {
    const tree = resultTree(parsedWith([ok(1, AFTER), skipped(2)]));
    const sections = findAll(tree, (n) => n.tag === "section").map((n) => String(n.attrs?.["class"]));
    expect(sections.indexOf("allocation")).toBeGreaterThan(-1);
    expect(sections.indexOf("close")).toBe(sections.indexOf("allocation") + 1);
    const close = byClass(tree, "close")[0]!;
    expect(findAll(close, (n) => n.tag === "h2").map(textOf)).toEqual(["締切直前の再計算"]);
    expect(textOf(byClass(close, "close-note")[0]!)).toContain("確率は分析時のまま");
    const rounds = byClass(close, "close-round");
    expect(rounds.length).toBe(2);
    expect(byClass(rounds[0]!, "close-round-title").map(textOf)).toEqual(["発走5分前"]);
    expect(textOf(rounds[0]!)).toContain("再計算した");
    expect(byClass(rounds[0]!, "bet").length).toBe(2); // 前提: 表の行がある
    expect(textOf(rounds[0]!)).toContain("追加 1点・削除 1点・賭け金の変化 1点");
    expect(byClass(rounds[1]!, "close-round-title").map(textOf)).toEqual(["発走2分前"]);
    expect(textOf(rounds[1]!)).toContain("行わなかった(地方は対象外です)");
    expect(byClass(rounds[1]!, "bet").length).toBe(0);
  });

  it("close が無ければ section.close は出ない(結果画面・カードとも)", () => {
    expect(byClass(resultTree(parsedWith(undefined)), "close").length).toBe(0);
    expect(byClass(cardTree(parsedWith(undefined)), "close").length).toBe(0);
  });

  it("発走前のカード(開いたとき): 同じ節が h3 の見出しで出る(回の見出しは結果画面と同じ形)。畳んだときは出ない(描画と状態が一致する)", () => {
    const a = parsedWith([ok(1, AFTER), skipped(2)]);
    const open = byClass(cardTree(a, true), "close");
    expect(open.length).toBe(1);
    expect(findAll(open[0]!, (n) => n.tag === "h3").map(textOf)).toContain("締切直前の再計算");
    expect(byClass(open[0]!, "close-round-title").map(textOf)).toEqual(["発走5分前", "発走2分前"]);
    expect(byClass(cardTree(a, false), "close").length).toBe(0);
  });

  it("閲覧者の画面にも出る(配分の提案と同じ扱い)", () => {
    expect(byClass(resultTree(parsedWith([ok(1, AFTER)]), true), "close").length).toBe(1);
  });
});

describe("DOM への組み立て(dom.ts の許可リストの範囲だけで組める。外から来た文字列は HTML として解釈しない)", () => {
  const mountTags = (tree: VNode): { tags: string[]; texts: string[] } => {
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
    return { tags, texts };
  };
  const evil = "<img src=x onerror=alert(1)>";
  const withEvil = (): AnalysisDetail => {
    const view = viewOf([ok(1, AFTER), skipped(2)]);
    const parsed = parseAnalysisResponse(200, JSON.parse(JSON.stringify({ ok: true, analysis: { ...view, close: { ...view.close, rounds: view.close!.rounds.map((r) => ({ ...r, diffLines: [evil] })) } } })));
    if (!parsed.ok) throw new Error("読めるはず");
    return parsed.analysis;
  };

  it.each([
    ["結果画面", (a: AnalysisDetail) => resultTree(a)],
    ["発走前のカード", (a: AnalysisDetail) => cardTree(a)],
  ] as const)("%s: 組み立てが投げず、img は作らず、文字列はテキストノードになる", (_name, tree) => {
    const { tags, texts } = mountTags(tree(withEvil()));
    expect(tags).not.toContain("img");
    expect(texts.some((t) => t.includes(evil))).toBe(true);
    expect(tags).toContain("section");
  });
});
