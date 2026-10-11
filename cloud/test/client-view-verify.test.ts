import { describe, expect, it } from "vitest";
import type { ProposedSummaryView, VerifyOutcome, VerifyReportView } from "../client/api-verify";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel } from "../client/list";
import { buildVerifyModel, type VerifyModelInput } from "../client/verify-model";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";
import { calibrationFixture, LONG_INSTRUCTION, trendFixture, versionsFixture } from "./verify-fixtures";

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
  calibration: calibrationFixture(),
  trend: trendFixture(),
  proposedBet: {
    population: { allocated: 90, skipped: 10, unreached: 15, noRecord: 5 },
    overall: summary({ betCount: 300, totalStake: 123456, unjudgedCount: 4 }),
    byType: { place: summary(), win: summary(), wide: summary({ unjudgedCount: 4 }), trio: summary(), quinella: summary(), exacta: summary(), trifecta: summary(), bracketQuinella: summary() },
    unknownBetType: { count: 1, totalStake: 100, betTypes: ["x"] },
  },
};
const READY: VerifyOutcome = { kind: "ready", venue: "all", report: REPORT, promptVersions: versionsFixture(), computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, startTimeGaps: { lost: 5, affecting: 2 } };
const input = (over: Partial<VerifyModelInput> = {}): VerifyModelInput => ({ load: { kind: "ready", outcome: READY }, venue: "all", busy: false, pollStopped: false, expandedVersions: [], ...over });
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
    expect(byClass(t, "verify-tiles")).toHaveLength(5); // 累積回収率・配分ベース・版別の 3 カード
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

  it("補正方向×結果・キャリブレーション・印別的中率(Issue #220): 見出しと、行(ul)で組む。表は使わない", () => {
    const t = tree();
    const text = textOf(t);
    for (const heading of ["補正方向×結果", "キャリブレーション(推定確率帯ごとの実複勝率・過信バイアス)", "印別的中率"]) {
      expect(text).toContain(heading);
    }
    const lists = byClass(t, "verify-stats");
    expect(lists.map((l) => findAll(l, (n) => n.tag === "li").length)).toEqual([3, 20, 7]);
    // 行の中身: ラベルと「名前 値」の項目(折り返せる span)
    const direction = findAll(lists[0]!, (n) => n.tag === "li")[0]!;
    expect(textOf(byClass(direction, "verify-stat-label")[0]!)).toBe("上げ");
    expect(byClass(direction, "verify-stat-cell").map(textOf)).toEqual(["件数 40件", "実複勝率 55.0%", "平均補正幅 +5.2pt"]);
    // キャリブレーション: 20 行すべてに帯グラフ(progress。value・max は整数の文字列)
    const bars = findAll(lists[1]!, (n) => n.tag === "progress");
    expect(bars).toHaveLength(20);
    expect(bars[10]!.attrs).toMatchObject({ value: "700", max: "1000", "aria-label": "実複勝率 70.0%" });
    expect(findAll(lists[0]!, (n) => n.tag === "progress")).toHaveLength(0);
    expect(findAll(t, (n) => n.tag === "table")).toEqual([]);
  });

  it("プロンプト版別比較(Issue #220): 版ごとのカード(見出し・追加指示・集計件数・4 タイル・開閉ボタン)。既定はたたんでいて、キャリブレーションの行を持たない", () => {
    const t = tree();
    const cards = byClass(t, "verify-version");
    expect(cards).toHaveLength(3);
    expect(textOf(t)).toContain("プロンプト版別比較");
    expect(textOf(t)).toContain("全体の集計です");
    expect(textOf(t)).toContain("「版不明」は版記録導入前の旧データ");
    expect(cards.map((c) => textOf(byClass(c, "verify-version-title")[0]!))).toEqual(["2026-10-09.2", "2026-10-09.2-clip015", "版不明"]);
    expect(textOf(byClass(cards[0]!, "verify-version-instructions")[0]!)).toBe(`追加指示: ${LONG_INSTRUCTION.slice(0, 30)}… / なし`);
    for (const c of cards) {
      expect(byClass(c, "verify-tile")).toHaveLength(4);
      expect(byClass(c, "verify-stats")).toHaveLength(0);
      expect(findAll(c, (n) => n.tag === "progress")).toHaveLength(0);
      const toggle = byClass(c, "verify-version-toggle")[0]!;
      expect(toggle.tag).toBe("button");
      expect(toggle.attrs?.["aria-expanded"]).toBe("false");
      expect(toggle.attrs?.["data-open-after"]).toBe("true");
      expect(textOf(toggle)).toBe("キャリブレーションを表示");
    }
    // 版別の位置: 配分ベースの回収率の後、補正方向×結果の前(exe の並び)
    const text = textOf(t);
    const order = ["累積回収率", "配分ベースの回収率", "プロンプト版別比較", "補正方向×結果", "キャリブレーション(推定確率帯", "印別的中率"].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("版別のキャリブレーションを開いた版: 見出し・追加指示の全文・20 帯の行(帯グラフ付き)。ほかの版はたたんだまま。閉じるボタンの引数は false", () => {
    const t = tree({ expandedVersions: ["v:2026-10-09.2"] });
    const [first, second] = byClass(t, "verify-version");
    expect(byClass(first!, "verify-version-toggle")[0]!.attrs?.["aria-expanded"]).toBe("true");
    expect(byClass(first!, "verify-version-toggle")[0]!.attrs?.["data-open-after"]).toBe("false");
    expect(textOf(byClass(first!, "verify-version-calibration-heading")[0]!)).toBe(`2026-10-09.2 (追加指示: ${LONG_INSTRUCTION.slice(0, 30)}… / なし)`);
    expect(textOf(byClass(first!, "verify-version-instructions-full")[0]!)).toBe(`追加指示(全文): ${LONG_INSTRUCTION} / なし`);
    const rows = byClass(first!, "verify-stats")[0]!;
    expect(findAll(rows, (n) => n.tag === "li")).toHaveLength(20);
    expect(findAll(rows, (n) => n.tag === "progress")).toHaveLength(20);
    expect(byClass(second!, "verify-stats")).toHaveLength(0);
    expect(findAll(t, (n) => n.tag === "table")).toEqual([]);
    expect(() => mountAll(t)).not.toThrow();
  });

  it("開閉ボタンを押すと、版のキーと押したあとの状態でアクションが呼ばれる", () => {
    const calls: Array<[string, boolean]> = [];
    const actions: ViewActions = { ...noopActions, onVerifyVersionToggle: (key, open) => calls.push([key, open]) };
    const closed = byClass(tree({}, actions), "verify-version-toggle");
    closed[0]!.on?.click?.();
    closed[2]!.on?.click?.();
    const opened = byClass(tree({ expandedVersions: ["v:2026-10-09.2"] }, actions), "verify-version-toggle");
    opened[0]!.on?.click?.();
    expect(calls).toEqual([["v:2026-10-09.2", true], ["unknown", true], ["v:2026-10-09.2", false]]);
    // data 属性は描画の差分検出(関数は比較されない)に使う: 版のキーを持つ
    expect(closed.map((n) => n.attrs?.["data-version-key"])).toEqual(["v:2026-10-09.2", "v:2026-10-09.2-clip015", "unknown"]);
  });

  it("版別が 0 件なら『集計対象がありません。』", () => {
    const t = tree({ load: { kind: "ready", outcome: { ...READY, promptVersions: [] } } });
    expect(byClass(t, "verify-version")).toHaveLength(0);
    expect(textOf(t)).toContain("プロンプト版別比較");
    expect(textOf(byClass(t, "empty").find((n) => textOf(n) === "集計対象がありません。")!)).toBe("集計対象がありません。");
  });

  it("キャリブレーションの帯が 0 本なら『データがありません。』", () => {
    const t = tree({ load: { kind: "ready", outcome: { ...READY, report: { ...REPORT, calibration: [] } } } });
    expect(textOf(t)).toContain("データがありません。");
    expect(byClass(t, "verify-stats")).toHaveLength(2); // 補正方向・印別。キャリブレーションの行は無い
  });

  it("集計対象が 0 件でも、3 つの節は出す(exe と同じ)", () => {
    const t = tree({ load: { kind: "ready", outcome: { ...READY, report: { ...REPORT, includedAnalysisCount: 0 } } } });
    expect(byClass(t, "verify-stats")).toHaveLength(3);
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
    expect(byClass(t, "verify-tiles")).toHaveLength(3); // 累積・配分のタイルは出ない。残るのは版別の 3 カード(版別は別の集計)
    expect(byClass(t, "verify-version")).toHaveLength(3);
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
