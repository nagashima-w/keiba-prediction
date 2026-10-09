import { describe, expect, it } from "vitest";
import type { ProposedSummaryView, VerifyOutcome, VerifyReportView } from "../client/api-verify";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel } from "../client/list";
import { buildVerifyModel, type VerifyModelInput } from "../client/verify-model";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #219: 検証画面の VNode と、一覧の入口のリンク。モデル(`client-verify-model.test.ts`)→ VNode の写し間違い、許可リスト(`dom.ts`)を通ること、ボタンが動作に繋がること。
 * スマホ幅で横に伸びないこと(表〈table〉・横スクロールを使わず、タイルと行〈ul〉で組む)。
 */

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));

function mountAll(tree: VNode): void {
  const doc: DomDocument = { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }), createTextNode: () => ({}) };
  mount(doc, { replaceChildren() {} }, tree);
}

const summary = (over: Partial<ProposedSummaryView> = {}): ProposedSummaryView => ({ betCount: 2, totalStake: 200, totalReturn: 300, recoveryRate: 1.5, unjudgedCount: 0, ...over });
const REPORT: VerifyReportView = {
  includedAnalysisCount: 120, excludedAnalysisCount: 7, supersededAnalysisCount: 30, excludedEstimatedCount: 4, excludedLookaheadSuspectCount: 3, excludedLookaheadUnknownCount: 2,
  bet: { betCount: 52, totalStake: 5200, totalReturn: 4994, recoveryRate: 0.96, actualPayoutCount: 20, approximatePayoutCount: 1 },
  proposedBet: {
    population: { allocated: 90, skipped: 10, unreached: 15, noRecord: 5 },
    overall: summary({ betCount: 300, totalStake: 123456, unjudgedCount: 4 }),
    byType: { place: summary(), win: summary(), wide: summary({ unjudgedCount: 4 }), trio: summary(), quinella: summary(), exacta: summary(), trifecta: summary(), bracketQuinella: summary() },
    unknownBetType: { count: 1, totalStake: 100, betTypes: ["x"] },
  },
};
const READY: VerifyOutcome = { kind: "ready", venue: "all", report: REPORT, computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, startTimeGaps: { lost: 5, affecting: 2 } };
const input = (over: Partial<VerifyModelInput> = {}): VerifyModelInput => ({ load: { kind: "ready", outcome: READY }, venue: "all", busy: false, pollStopped: false, ...over });
const tree = (over: Partial<VerifyModelInput> = {}, actions: ViewActions = noopActions): VNode => renderScreen(buildVerifyModel(input(over)), actions);

describe("検証画面の VNode", () => {
  it("許可リスト(dom.ts)の範囲で組める(状態ごと)", () => {
    const cases: Partial<VerifyModelInput>[] = [
      {},
      { load: { kind: "loading" } },
      { load: { kind: "error", message: "失敗" } },
      { load: { kind: "ready", outcome: { kind: "preparing", remaining: 5, blocked: null, resumeAt: null } } },
      { load: { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z" } } },
      { load: { kind: "ready", outcome: { ...READY, stale: true, staleReason: "min-interval", nextRecomputeAt: "2026-10-10T03:05:00.000Z" } } },
      { venue: "nar", busy: true, pollStopped: true },
    ];
    for (const over of cases) {
      expect(() => mountAll(tree(over))).not.toThrow();
    }
  });

  it("スマホ幅で横に伸びない: table・横スクロールを使わず、数値はタイル、内訳は ul の行で組む", () => {
    const t = tree();
    expect(findAll(t, (n) => n.tag === "table")).toEqual([]);
    expect(byClass(t, "verify-tiles")).toHaveLength(2); // 累積回収率・配分ベース
    for (const tiles of byClass(t, "verify-tiles")) {
      expect(byClass(tiles, "verify-tile")).toHaveLength(4);
    }
    expect(byClass(t, "verify-tile strong").length + byClass(t, "verify-tile").filter((n) => String(n.attrs?.["class"]).includes("strong")).length).toBeGreaterThanOrEqual(2);
  });

  it("累積回収率: 見出し・説明・4 タイル(値)・払戻内訳・集計の内訳 6 行・除外の補足", () => {
    const t = tree();
    const text = textOf(t);
    expect(text).toContain("累積回収率");
    expect(text).toContain("52点");
    expect(text).toContain("5,200円");
    expect(text).toContain("4,994円");
    expect(text).toContain("96.0%");
    expect(text).toContain("払戻内訳: 実配当 20件 / 近似 1件");
    const rows = byClass(t, "verify-rows")[0]!;
    expect(findAll(rows, (n) => n.tag === "li")).toHaveLength(6);
    expect(textOf(rows)).toContain("リーク疑い(発走後に分析・先読み未遮断)のため除外");
    expect(text).toContain("該当レースを分析し直すと");
  });

  it("配分ベース: 4 タイル・券種 8 行・判定不能 8 行・母集団 4 行・未知の券種の注記", () => {
    const t = tree();
    const text = textOf(t);
    expect(text).toContain("配分ベースの回収率");
    expect(text).toContain("123,456円");
    const lists = byClass(t, "verify-rows");
    // 累積の内訳 6 + 券種 8 + 判定不能 8 + 母集団 4
    expect(lists.map((l) => findAll(l, (n) => n.tag === "li").length)).toEqual([6, 8, 8, 4]);
    expect(text).toContain("判定不能(集計対象外)");
    expect(text).toContain("母集団");
    expect(text).toContain("未対応の券種コード(x)");
  });

  it("集計時点・発走時刻の欠落の注記を出す。集計が出せない間は集計を出さず、理由だけを出す", () => {
    const text = textOf(tree());
    expect(text).toContain("集計時点: 2026-10-10 12:00(JST)");
    expect(text).toContain("発走時刻を確認できなかった旧い分析が 5件");
    const prep = tree({ load: { kind: "ready", outcome: { kind: "preparing", remaining: 321, blocked: null, resumeAt: null } } });
    expect(textOf(prep)).toContain("321件");
    expect(textOf(prep)).not.toContain("累積回収率");
    expect(byClass(prep, "verify-tiles")).toHaveLength(0);
  });

  it("集計対象が 0 件なら、タイルの代わりに『集計対象がありません。』", () => {
    const t = tree({ load: { kind: "ready", outcome: { ...READY, report: { ...REPORT, includedAnalysisCount: 0 } } } });
    expect(textOf(t)).toContain("集計対象がありません。");
    expect(byClass(t, "verify-tiles")).toHaveLength(0);
  });

  it("区分の切替(3 つ)は押すとアクションが呼ばれ、いまの区分は aria-pressed。更新ボタンは通信中は無効", () => {
    const venues: string[] = [];
    const t = tree({}, { ...noopActions, onVerifyVenue: (v) => venues.push(v) });
    const tabs = byClass(t, "verify-venue");
    expect(tabs.map((n) => textOf(n))).toEqual(["全体", "中央のみ", "地方のみ"]);
    expect(tabs.map((n) => n.attrs?.["aria-pressed"])).toEqual(["true", "false", "false"]);
    tabs[2]!.on?.click?.();
    tabs[0]!.on?.click?.();
    expect(venues).toEqual(["nar", "all"]);
    expect(byClass(t, "refresh")[0]!.attrs?.["disabled"]).toBe(false);
    expect(byClass(tree({ busy: true }), "refresh")[0]!.attrs?.["disabled"]).toBe(true);
    let refreshed = 0;
    byClass(tree({}, { ...noopActions, onRefresh: () => (refreshed += 1) }), "refresh")[0]!.on?.click?.();
    expect(refreshed).toBe(1);
  });

  it("一覧へ戻るリンクがある。エラーは role=alert で出す", () => {
    expect(byClass(tree(), "back")[0]?.attrs?.["href"]).toBe("#");
    const err = tree({ load: { kind: "error", message: "取得できません" } });
    expect(findAll(err, (n) => n.attrs?.["role"] === "alert").map(textOf)).toEqual(["取得できません"]);
  });
});

describe("一覧の入口", () => {
  it("一覧のモデルに検証画面へのリンク先(#verify)があり、一覧の画面に『検証』のリンクが出る(設定のリンクの前)", () => {
    const model = buildListModel({ route: { date: "20261010", venue: "central", race: null, analysis: null, settings: false }, list: { kind: "loading" }, board: { kind: "none" } });
    expect(model.verifyHref).toBe("#verify");
    const t = renderScreen(model, noopActions);
    const links = findAll(t, (n) => n.tag === "a" && (n.attrs?.["class"] === "verify-link" || n.attrs?.["class"] === "settings-link"));
    expect(links.map((n) => [n.attrs?.["class"], n.attrs?.["href"], textOf(n)])).toEqual([["verify-link", "#verify", "検証"], ["settings-link", "#settings", "設定"]]);
  });
});
