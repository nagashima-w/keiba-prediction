import { describe, expect, it } from "vitest";
import type { ReportDetail } from "../client/api-report";
import { mount, type DomDocument } from "../client/dom";
import { buildReportModel, type ReportModelInput } from "../client/report-model";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #246(V1〜V5。#241 の【記録】): 日報画面の VNode(`view.ts` の日報の描画)。
 * モデル(`client-report-model.test.ts`)が正しくても、VNode への写し間違い(節を落とす・良かった点と改善点を取り違える・一言や印の行を落とす)は
 * モデルのテストでは見えない。ここでは、モデルを実際に VNode にして、文章・印・一言が**正しい場所に、そのまま**出ることを固定する。
 * 期待値の文字列は、このファイルにリテラルで持つ(実装の定数を参照しない)。
 */

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const classesOf = (n: VNode): string[] => String(n.attrs?.["class"] ?? "").split(" ");
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => classesOf(n).includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const kids = (n: VNode): readonly (VNode | string)[] => n.children ?? [];

function mountAll(tree: VNode): void {
  const doc: DomDocument = { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }), createTextNode: () => ({}) };
  mount(doc, { replaceChildren() {} }, tree);
}

function report(over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    date: "20261010", createdAt: "2026-10-10T11:12:00.000Z", model: "claude-sonnet-5-5", raceCount: 2, totalStake: 1000, totalReturn: 1300, summary: "総括の要約",
    stats: {
      raceCount: 2, resultRaceCount: 1, noResultRaceCount: 1, betRaceCount: 2, llmUsedRaceCount: 2, totalStake: 1000, totalReturn: 1300, recoveryRate: 1.3, judgedBetCount: 4, hitBetCount: 1, unjudgedBetCount: 1, unjudgedStake: 300,
      byBetType: { win: { betCount: 2, hitCount: 1, stake: 600, payout: 1300 } },
      byMark: [{ mark: "◎", count: 3, win: 1, top3: 3 }, { mark: "〇", count: 2, win: 0, top3: 2 }],
    },
    races: [
      { raceId: "202605030801", analysisId: 1, title: "東京1R 3歳未勝利", llmUsed: true, hasResult: true, top3: [{ umaban: 1, name: "アルファ", finishPosition: 1 }], marks: [{ mark: "◎", umaban: 1, name: "アルファ", finishPosition: 1 }, { mark: "〇", umaban: 2, name: "ブラボー", finishPosition: 3 }], totalStake: 700, totalReturn: 1300, judgedBetCount: 3, hitCount: 1, unjudgedBetCount: 0, allocationNote: null, comment: "◎が快勝した一言" },
      { raceId: "202605030802", analysisId: 2, title: "東京2R", llmUsed: false, hasResult: false, top3: [], marks: [], totalStake: 0, totalReturn: 0, judgedBetCount: 0, hitCount: 0, unjudgedBetCount: 1, allocationNote: null, comment: null },
    ],
    narrative: { summary: "全体の総括の文章", good: ["良かった点その1", "良かった点その2"], improve: ["改善点その1"] },
    narrativeRaw: null,
    note: null,
    ...over,
  };
}

const input = (r: ReportDetail = report(), over: Partial<ReportModelInput> = {}): ReportModelInput => ({
  today: "20261010", shownDate: "20261010", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: r, job: null }, run: { kind: "idle" }, pollStopped: false, ...over,
});
const tree = (r: ReportDetail = report()): VNode => renderScreen(buildReportModel(input(r)), noopActions);

/** 画面の直下の子から、見出し(h2・h3)の文字が `heading` の要素の、次の要素を返す。 */
function after(root: VNode, tag: "h2" | "h3", heading: string): VNode | undefined {
  const siblings = kids(root);
  const i = siblings.findIndex((c) => typeof c !== "string" && c.tag === tag && textOf(c) === heading);
  const next = i === -1 ? undefined : siblings[i + 1];
  return typeof next === "string" ? undefined : next;
}
const headings = (root: VNode): string[] => kids(root).filter((c): c is VNode => typeof c !== "string" && (c.tag === "h2" || c.tag === "h3")).map(textOf);
const liTexts = (list: VNode | undefined): string[] => (list === undefined ? [] : findAll(list, (n) => n.tag === "li").map(textOf));

describe("日報画面の VNode: LLM の文章(総括・良かった点・改善点)", () => {
  it("V1: 見出し『総括』の直後に、文章をそのまま出す(report-summary)", () => {
    const next = after(tree(), "h3", "総括");
    expect(next, "『総括』の直後の要素がある").toBeDefined();
    expect(classesOf(next!)).toContain("report-summary");
    expect(textOf(next!)).toBe("全体の総括の文章");
  });

  it("V2: 見出し『良かった点』の直後の箇条書きに、良かった点を順にそのまま出す", () => {
    const list = after(tree(), "h3", "良かった点");
    expect(list?.tag).toBe("ul");
    expect(liTexts(list)).toEqual(["良かった点その1", "良かった点その2"]);
  });

  it("V3: 見出し『改善点』の直後の箇条書きに、改善点を出す(良かった点と取り違えない)", () => {
    const list = after(tree(), "h3", "改善点");
    expect(list?.tag).toBe("ul");
    expect(liTexts(list)).toEqual(["改善点その1"]);
    expect(liTexts(after(tree(), "h3", "良かった点"))).not.toEqual(liTexts(list)); // 前提: 2 つは別の内容(取り違えると変わる)
  });

  it("節の順序: 総括 → 良かった点 → 改善点 → 券種別 → 印別 → レースごと", () => {
    const hs = headings(tree());
    const order = ["総括", "良かった点", "改善点", "券種別の成績", "印別の成績(結果のあるレース。頭数 / 1着 / 3着内)", "レースごと"].map((h) => hs.indexOf(h));
    expect(order.every((i) => i >= 0), `見出し: ${hs.join(" | ")}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("文章が無い日報(narrative が null)では、総括・良かった点・改善点の見出しを出さない。空の配列の節も出さない", () => {
    const none = headings(tree(report({ narrative: null, narrativeRaw: null, model: null })));
    expect(none).not.toContain("総括");
    expect(none).not.toContain("良かった点");
    expect(none).not.toContain("改善点");
    expect(none).toContain("レースごと"); // 前提: 日報の本文自体は出ている
    const noGood = headings(tree(report({ narrative: { summary: "要約", good: [], improve: ["改善点その1"] } })));
    expect(noGood).not.toContain("良かった点");
    expect(noGood).toContain("改善点");
  });
});

describe("日報画面の VNode: レースごと(一言・印)と印別の成績", () => {
  const raceNode = (id: string): VNode => {
    const found = findAll(tree(), (n) => n.tag === "section" && n.attrs?.["data-race"] === id);
    expect(found, `data-race=${id} のレースが 1 つある`).toHaveLength(1);
    return found[0]!;
  };

  it("V4: レースごとの一言は『一言: …』の行(report-comment)で、そのレースの中に出る。一言が無いレースには行を出さない", () => {
    const r1 = raceNode("202605030801");
    const comment = byClass(r1, "report-comment");
    expect(comment).toHaveLength(1);
    expect(textOf(comment[0]!)).toBe("一言: ◎が快勝した一言");
    const r2 = raceNode("202605030802");
    expect(byClass(r2, "report-comment")).toHaveLength(0);
    expect(textOf(r2)).not.toContain("一言");
  });

  it("V5: 印の付いた馬は、そのレースの中の report-marks の行に『印 馬番 馬名 → 着順』で出る。印が無いレースには行を出さない", () => {
    const r1 = raceNode("202605030801");
    const marks = byClass(r1, "report-marks");
    expect(marks).toHaveLength(1);
    expect(textOf(marks[0]!)).toBe("◎ 1番 アルファ → 1着 / 〇 2番 ブラボー → 3着");
    expect(byClass(raceNode("202605030802"), "report-marks")).toHaveLength(0);
  });

  it("レースの見出し・着順・買い目の成績も、そのレースの中に出る", () => {
    const r1 = raceNode("202605030801");
    expect(textOf(kids(r1).find((c): c is VNode => typeof c !== "string" && c.tag === "h3")!)).toBe("東京1R 3歳未勝利");
    expect(textOf(byClass(r1, "report-result")[0]!)).toBe("1着 1番 アルファ");
    expect(textOf(byClass(r1, "report-bets")[0]!)).toBe("買い目: 3 点中 1 点的中・賭け金 700円・払戻 1,300円");
    expect(textOf(byClass(raceNode("202605030802"), "report-result")[0]!)).toContain("結果なし");
  });

  it("V5: 印別の成績は、見出しの直後の行(ラベル=印、値=『頭数 / 1着 / 3着内』)に出る", () => {
    const list = after(tree(), "h3", "印別の成績(結果のあるレース。頭数 / 1着 / 3着内)");
    expect(list?.tag).toBe("ul");
    const rows = findAll(list!, (n) => n.tag === "li").map((li) => findAll(li, (n) => n.tag === "span").map(textOf));
    expect(rows).toEqual([["◎", "3 頭 / 1 / 3"], ["〇", "2 頭 / 0 / 2"]]);
  });

  it("Issue #255 境界: 印別の成績は 1 行だけでも節(見出しと行)を出す。0 行のときは見出しごと出さない", () => {
    const MARK_HEADING = "印別の成績(結果のあるレース。頭数 / 1着 / 3着内)";
    const withMarks = (byMark: ReportDetail["stats"]["byMark"]): ReportDetail => {
      const base = report();
      return report({ stats: { ...base.stats, byMark } });
    };
    // 前提(空振り防止): 見出しは固定の文字列で、基準の日報(2 行)には出ている
    expect(headings(tree())).toContain(MARK_HEADING);
    // 1 行だけ(`markRows.length > 0` の境界。`> 1` に変えると落ちる)
    const one = tree(withMarks([{ mark: "◎", count: 1, win: 1, top3: 1 }]));
    const list = after(one, "h3", MARK_HEADING);
    expect(list?.tag).toBe("ul");
    expect(findAll(list!, (n) => n.tag === "li").map((li) => findAll(li, (n) => n.tag === "span").map(textOf))).toEqual([["◎", "1 頭 / 1 / 1"]]);
    // 0 行: 見出しも出ない
    expect(headings(tree(withMarks([])))).not.toContain(MARK_HEADING);
  });

  it("Issue #255: 文章が無い日報には、理由の注記(notice)を出す。文章がある日報には出さない", () => {
    const NOTE = "LLM の文章はありません(キーが未登録、または LLM を使えなかったため、統計だけの日報です)。";
    const noticeTexts = (t: VNode): string[] => byClass(t, "notice").map(textOf);
    // 前提(空振り防止): 文章のある日報の画面には、この注記が無い
    expect(noticeTexts(tree())).not.toContain(NOTE);
    const none = tree(report({ narrative: null, narrativeRaw: null, model: null }));
    expect(noticeTexts(none)).toContain(NOTE);
    const raw = tree(report({ narrative: null, narrativeRaw: "生の文章です" }));
    expect(noticeTexts(raw)).toContain("LLM の応答を構造として読めなかったため、生の文章を載せています。");
  });

  it("生の文章(構造として読めなかった日報)は report-raw に出し、総括の節は出さない", () => {
    const t = tree(report({ narrative: null, narrativeRaw: "生の文章です" }));
    expect(textOf(byClass(t, "report-raw")[0]!)).toBe("生の文章です");
    expect(headings(t)).not.toContain("総括");
  });
});

describe("日報画面の VNode: 許可リスト(dom.ts)の範囲で組める", () => {
  it("文章あり・文章なし・生の文章・日報なしのどれも、mount で例外にならない", () => {
    for (const r of [report(), report({ narrative: null, model: null }), report({ narrative: null, narrativeRaw: "生" })]) {
      expect(() => mountAll(tree(r))).not.toThrow();
    }
    const empty = renderScreen(buildReportModel(input(report(), { detail: { kind: "ready", report: null, job: null } })), noopActions);
    expect(() => mountAll(empty)).not.toThrow();
  });
});

describe("Issue #264: 日報画面の VNode: 直近 28 日の累計", () => {
  const stats = { ...report().stats, expectedBetCount: 4, expectedHits: 1.25, expectedBaseHits: 1, maxPayout: 1300, maxPayoutStake: 600 };
  const total = { ...stats, fromDate: "20260913", toDate: "20261010", dayCount: 7, raceCount: 156, totalStake: 52000, totalReturn: 49400, recoveryRate: 0.95, judgedBetCount: 360, hitBetCount: 30, expectedBetCount: 360, expectedHits: 27.25, expectedBaseHits: 30 };
  const withRolling = (): ReportDetail => ({ ...report({ stats }), rolling: { windowDays: 28, prior: { ...total, dayCount: 6 }, total } });

  it("見出し『直近 28 日の累計(その日を含む)』の直後に期間の説明、その次にタイル。その日のタイルより後、総括より前に出る", () => {
    const t = tree(withRolling());
    const hs = headings(t);
    expect(hs.indexOf("直近 28 日の累計(その日を含む)")).toBeGreaterThanOrEqual(0);
    expect(hs.indexOf("直近 28 日の累計(その日を含む)")).toBeLessThan(hs.indexOf("総括"));
    const meta = after(t, "h3", "直近 28 日の累計(その日を含む)");
    expect(meta).toBeDefined();
    expect(textOf(meta!)).toBe("2026年9月13日〜2026年10月10日・開催 7 日・156 レース");
    const tiles = kids(t)[kids(t).indexOf(meta!) + 1] as VNode;
    expect(classesOf(tiles)).toContain("verify-tiles");
    const text = textOf(tiles);
    expect(text).toContain("52,000円");
    expect(text).toContain("95.0%");
    expect(text).toContain("360 点中 30 点");
    expect(text).toContain("見込み 27.25 点・実際 30 点");
  });

  it("その日のタイルにも『見込みと実際』が出る(累計と取り違えない: その日は 1.25 点、累計は 27.25 点)", () => {
    const tilesNodes = byClass(tree(withRolling()), "verify-tiles");
    expect(tilesNodes).toHaveLength(2); // その日 + 累計
    expect(textOf(tilesNodes[0]!)).toContain("見込み 1.25 点・実際 1 点");
    expect(textOf(tilesNodes[0]!)).not.toContain("27.25");
    expect(textOf(tilesNodes[1]!)).toContain("見込み 27.25 点・実際 30 点");
  });

  it("累計が無い日報(この項目を持つ前の日報)では、節を出さない。タイルは 1 組だけ", () => {
    const t = tree(report());
    expect(headings(t)).not.toContain("直近 28 日の累計(その日を含む)");
    expect(byClass(t, "verify-tiles")).toHaveLength(1);
    mountAll(tree(withRolling())); // DOM への写しも落ちない
  });
});

describe("Issue #272: 日報画面の VNode: 印の定型の買い方(もしも)と惜しかったレース", () => {
  const tpl = (over: Record<string, number> = {}) => ({ betCount: 10, hitCount: 2, stake: 1000, payout: 1500, unjudgedCount: 0, inapplicableCount: 0, ...over });
  const DAY = { win: tpl(), place: tpl({ hitCount: 5, payout: 1100 }), wide: tpl({ betCount: 0, hitCount: 0, stake: 0, payout: 0 }), quinella: tpl(), trio: tpl() };
  const TOTAL = { win: tpl({ betCount: 41, hitCount: 9, stake: 4100, payout: 3550 }), place: tpl(), wide: tpl(), quinella: tpl(), trio: tpl() };
  const withWhatIf = (): ReportDetail => {
    const base = report();
    const total = { ...base.stats, fromDate: "20260913", toDate: "20261010", dayCount: 7, whatIf: TOTAL };
    return { ...base, stats: { ...base.stats, whatIf: DAY }, rolling: { windowDays: 28, prior: { ...total, dayCount: 6 }, total }, nearMisses: { total: 4, shown: [{ raceId: "202605030801", templateId: "trio", payout: 12340 }] } };
  };

  it("見出し『もしも…』は、印別の成績の後・レースごとの前。その日と累計の 2 組が、型の順の行で出る", () => {
    const t = tree(withWhatIf());
    const hs = headings(t);
    const at = hs.indexOf("もしも(印の定型の買い方。各100円)");
    expect(at).toBeGreaterThan(hs.indexOf("印別の成績(結果のあるレース。頭数 / 1着 / 3着内)"));
    expect(at).toBeLessThan(hs.indexOf("レースごと"));
    const lists = byClass(t, "verify-rows");
    const whatIfLists = lists.filter((l) => textOf(l).includes("◎単勝"));
    expect(whatIfLists).toHaveLength(2);
    // その日の先頭行と、累計の先頭行を取り違えない(10 レースと 41 レース)
    expect(textOf(whatIfLists[0]!)).toContain("◎単勝 判定できた 10 レース中 2 的中");
    expect(textOf(whatIfLists[1]!)).toContain("◎単勝 判定できた 41 レース中 9 的中");
    expect(textOf(whatIfLists[0]!)).toContain("◎-〇ワイド 判定できたレースなし");
    expect(kids(whatIfLists[0]!)).toHaveLength(5);
  });

  it("惜しかったレースの見出し(全件数つき)と、レース名・型・払戻・実際の買い目の行が出る。件数が上限を超えるので件数の説明つき", () => {
    const t = tree(withWhatIf());
    expect(headings(t)).toContain("惜しかったレース(全 4 件のうち、払戻の多い順に 1 件)");
    const items = byClass(t, "report-list").filter((l) => textOf(l).includes("が的中していた"));
    expect(items).toHaveLength(1);
    expect(textOf(items[0]!)).toContain("東京1R 3歳未勝利: ◎〇▲の3連複が的中していた(定型の払戻 12,340円)。実際の買い目: 3 点中 1 点的中");
  });

  it("惜しかったレースが 0 件なら案内の 1 文。もしもの節を持たない日報(旧形)は見出しごと出さない", () => {
    const zero = { ...withWhatIf(), nearMisses: { total: 0, shown: [] } };
    expect(textOf(tree(zero))).toContain("該当するレースはありませんでした。");
    const t = tree(report());
    expect(headings(t).some((h) => h.startsWith("もしも"))).toBe(false);
    expect(headings(t).some((h) => h.startsWith("惜しかった"))).toBe(false);
  });

  it("DOM への写しも落ちない", () => {
    expect(() => mountAll(tree(withWhatIf()))).not.toThrow();
  });
});
