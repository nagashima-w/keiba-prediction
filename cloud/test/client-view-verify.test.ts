import { describe, expect, it } from "vitest";
import type { ProposedSummaryView, VerifyOutcome, VerifyReportView } from "../client/api-verify";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel } from "../client/list";
import { buildVerifyModel, type VerifyModelInput } from "../client/verify-model";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";
import { breakdownFixture, calibrationFixture, closeFixture, priorCalibrationFixture, LONG_INSTRUCTION, trendFixture, versionsFixture } from "./verify-fixtures";

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

const summary = (over: Partial<ProposedSummaryView> = {}): ProposedSummaryView => ({ betCount: 2, totalStake: 200, totalReturn: 300, recoveryRate: 1.5, unjudgedCount: 0, refundedCount: 0, refundedStake: 0, flatStake: 0, flatReturn: 0, flatRecoveryRate: null, ...over });
const REPORT: VerifyReportView = {
  includedAnalysisCount: 120, excludedAnalysisCount: 7, supersededAnalysisCount: 30, excludedEstimatedCount: 4, excludedLookaheadSuspectCount: 3, excludedLookaheadUnknownCount: 2,
  bet: { betCount: 52, totalStake: 5200, totalReturn: 4994, recoveryRate: 0.96, actualPayoutCount: 20, approximatePayoutCount: 1 },
  calibration: calibrationFixture(),
  priorCalibration: priorCalibrationFixture(),
  trend: trendFixture(),
  proposedBet: {
    population: { allocated: 90, skipped: 10, unreached: 15, noRecord: 5 },
    overall: summary({ betCount: 300, totalStake: 123456, unjudgedCount: 4 }),
    byType: { place: summary(), win: summary(), wide: summary({ unjudgedCount: 4 }), trio: summary(), quinella: summary(), exacta: summary(), trifecta: summary(), bracketQuinella: summary() },
    unknownBetType: { count: 1, totalStake: 100, betTypes: ["x"] },
  },
};
const READY: VerifyOutcome = { kind: "ready", venue: "all", report: REPORT, promptVersions: versionsFixture(), closeComparison: null, breakdown: null, computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, startTimeGaps: { lost: 5, affecting: 2 } };
const input = (over: Partial<VerifyModelInput> = {}): VerifyModelInput => ({ load: { kind: "ready", outcome: READY }, venue: "all", busy: false, pollStopped: false, expandedVersions: [], calibrationTarget: "adjusted", admin: true, ...over });
const tree = (over: Partial<VerifyModelInput> = {}, actions: ViewActions = noopActions): VNode => renderScreen(buildVerifyModel(input(over)), actions);

describe("検証画面の VNode", () => {
  it("許可リスト(dom.ts)の範囲で組める(状態ごと)", () => {
    const cases: Partial<VerifyModelInput>[] = [
      {},
      { load: { kind: "loading" } },
      { load: { kind: "error", message: "失敗" } },
      { load: { kind: "ready", outcome: { kind: "preparing", remaining: 5, blocked: null, resumeAt: null } } },
      { load: { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" } } },
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

  it("Issue #72: 返還があれば「うち返還 N点(金額)」の 1 行を配分ベースのタイルの下に出す。無ければ出さない(行の数は増えない)", () => {
    expect(textOf(tree())).not.toContain("うち返還");
    const withRefund: VerifyOutcome = { ...READY, report: { ...REPORT, proposedBet: { ...REPORT.proposedBet, overall: summary({ betCount: 300, totalStake: 123456, unjudgedCount: 4, refundedCount: 2, refundedStake: 900 }) } } };
    const t = tree({ load: { kind: "ready", outcome: withRefund } });
    expect(textOf(t)).toContain("うち返還 2点(900円)");
    // 行(ul)の数と中身は変わらない(返還は段落 1 行で、券種別の行を増やさない)
    expect(byClass(t, "verify-rows").map((l) => findAll(l, (n) => n.tag === "li").length)).toEqual([6, 8, 8, 4]);
  });

  it("Issue #16: 一律 100 円の行を配分ベースのタイルの下に 1 行出す。一律の賭け金が 0 なら出さない(行の数は増えない)", () => {
    expect(textOf(tree())).not.toContain("同じ買い目に一律 100 円なら");
    const withFlat: VerifyOutcome = { ...READY, report: { ...REPORT, proposedBet: { ...REPORT.proposedBet, overall: summary({ betCount: 300, totalStake: 123456, unjudgedCount: 4, flatStake: 30000, flatReturn: 29490, flatRecoveryRate: 0.983 }) } } };
    const t = tree({ load: { kind: "ready", outcome: withFlat } });
    // 説明文にも「同じ買い目に一律 100 円」の語があるので、行の文(「なら」以降の値まで)で確かめる
    expect(textOf(t)).toContain("同じ買い目に一律 100 円なら 回収率 98.3%(投資額 30,000円 / 回収額 29,490円)");
    expect(byClass(t, "verify-rows").map((l) => findAll(l, (n) => n.tag === "li").length)).toEqual([6, 8, 8, 4]);
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

  it("Issue #271: 閉じた版にも Brier の 1 行を出し(レース数不足の版は不足の文言)、開いた版は補正後・補正前の 2 つの表(それぞれ 20 帯)を見出し付きで続けて出す", () => {
    const closed = byClass(tree(), "verify-version");
    expect(closed.map((c) => textOf(byClass(c, "verify-version-quality")[0]!))).toEqual([
      "Brier 補正前 0.1661 / 補正後 0.1655(395頭・80レース)",
      "Brier: レース数不足(30レース未満)",
      "Brier: レース数不足(30レース未満)",
    ]);
    expect(closed.every((c) => byClass(c, "verify-version-table-label").length === 0)).toBe(true);
    const [first, second] = byClass(tree({ expandedVersions: ["v:2026-10-09.2"] }), "verify-version");
    expect(byClass(first!, "verify-version-table-label").map(textOf)).toEqual(["補正後(AI)", "補正前(統計)"]);
    const tables = byClass(first!, "verify-stats");
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(findAll(table, (n) => n.tag === "li")).toHaveLength(20);
      expect(findAll(table, (n) => n.tag === "progress")).toHaveLength(20);
    }
    // 2 つの表は別物(補正前の帯 3 は 300 件、補正後の帯 3 は 0 件)
    expect(textOf(tables[0]!)).not.toBe(textOf(tables[1]!));
    expect(textOf(findAll(tables[1]!, (n) => n.tag === "li")[3]!)).toContain("300件");
    expect(textOf(findAll(tables[0]!, (n) => n.tag === "li")[3]!)).not.toContain("300件");
    // 閉じたままの版は表を持たない
    expect(byClass(second!, "verify-stats")).toHaveLength(0);
    expect(() => mountAll(tree({ expandedVersions: ["v:2026-10-09.2"] }))).not.toThrow();
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

  it("Issue #254: 対応表の見出しの下に 補正後(AI)・補正前(統計) の切替(ボタン 2 つ。今のほうが aria-pressed=true)。押すと対象とともにアクションが呼ばれる", () => {
    const calls: string[] = [];
    const actions: ViewActions = { ...noopActions, onVerifyCalibrationTarget: (target) => calls.push(target) };
    const t = tree({}, actions);
    const group = byClass(t, "verify-targets")[0]!;
    expect(group.attrs?.["role"]).toBe("group");
    const buttons = byClass(group, "verify-target");
    expect(buttons.map(textOf)).toEqual(["補正後(AI)", "補正前(統計)"]);
    expect(buttons.map((b) => b.attrs?.["aria-pressed"])).toEqual(["true", "false"]);
    expect(buttons.every((b) => b.tag === "button")).toBe(true);
    for (const b of buttons) b.on?.click?.();
    expect(calls).toEqual(["adjusted", "prior"]);
    // 補正前を選んだ状態
    const p = tree({ calibrationTarget: "prior" }, actions);
    expect(byClass(byClass(p, "verify-targets")[0]!, "verify-target").map((b) => b.attrs?.["aria-pressed"])).toEqual(["false", "true"]);
    // 切替は対応表の節にだけある(他の節・版別カードにはない)
    expect(byClass(t, "verify-targets")).toHaveLength(1);
    // 見出し → 説明 → 切替 → 行 の順
    const text = textOf(t);
    expect(text.indexOf("キャリブレーション(推定確率帯ごとの実複勝率・過信バイアス)")).toBeLessThan(text.indexOf("補正後(AI)"));
    expect(() => mountAll(t)).not.toThrow();
    expect(() => mountAll(p)).not.toThrow();
  });

  it("Issue #254: 対応表の行に 平均予測・95%区間・判定 が文字で出る(色だけに頼らない)。件数のある帯の判定は 整合/予測が高い/予測が低い/件数不足", () => {
    const t = tree();
    const rows = findAll(byClass(t, "verify-stats")[1]!, (n) => n.tag === "li");
    expect(rows).toHaveLength(20);
    const cellTexts = (i: number) => byClass(rows[i]!, "verify-stat-cell").map(textOf);
    expect(cellTexts(4)).toEqual(["予測件数 200件", "複勝件数 46件", "実複勝率 23.0%", "予測−実績 -0.4pt(過小評価)", "平均予測 22.6%", "95%区間 17.7〜29.3%", "判定 整合"]);
    expect(cellTexts(6).slice(4)).toEqual(["平均予測 33.1%", "95%区間 13.8〜28.0%", "判定 予測が高い(過信)"]);
    expect(cellTexts(14).slice(4)).toEqual(["平均予測 72.0%", "95%区間 76.9〜96.0%", "判定 予測が低い(過小評価)"]);
    expect(cellTexts(2).slice(4)).toEqual(["平均予測 12.0%", "95%区間 0.0〜49.0%", "判定 件数不足(30件未満)"]);
    expect(cellTexts(0).slice(4)).toEqual(["平均予測 -", "95%区間 -", "判定 -"]);
    expect(findAll(t, (n) => n.tag === "table")).toEqual([]);
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

describe("Issue #263: 閲覧者の検証画面の VNode", () => {
  it("更新ボタン(.refresh)が無い。一覧へ戻るリンク・区分の切替・対応表の切替・版別の開閉は残る。管理者には更新ボタンがある(対照)", () => {
    expect(byClass(tree(), "refresh")).toHaveLength(1); // 前提(空振り防止): 管理者には更新ボタンがある
    const t = tree({ admin: false });
    expect(byClass(t, "refresh")).toHaveLength(0);
    expect(findAll(t, (n) => n.tag === "button" && textOf(n).includes("更新"))).toEqual([]);
    expect(byClass(t, "back")).toHaveLength(1);
    expect(byClass(t, "verify-venue")).toHaveLength(3);
    expect(byClass(t, "verify-target")).toHaveLength(2);
    expect(byClass(t, "verify-version-toggle").length).toBeGreaterThan(0);
    // 区分の切替・対応表の切替は押せる(閲覧用の操作)
    const venues: string[] = [];
    const targets: string[] = [];
    const t2 = tree({ admin: false }, { ...noopActions, onVerifyVenue: (v) => venues.push(v), onVerifyCalibrationTarget: (x) => targets.push(x) });
    byClass(t2, "verify-venue")[1]!.on?.click?.();
    byClass(t2, "verify-target")[1]!.on?.click?.();
    expect(venues).toEqual(["central"]);
    expect(targets).toEqual(["prior"]);
  });

  it("集計がまだ無い(not-computed): 『まだ集計されていません』を出し、集計の節は出さない。更新ボタンも無い。許可リストの範囲で組める", () => {
    const t = tree({ admin: false, load: { kind: "ready", outcome: { kind: "not-computed" } } });
    expect(textOf(t)).toContain("まだ集計されていません");
    expect(byClass(t, "refresh")).toHaveLength(0);
    expect(byClass(t, "verify-tiles")).toHaveLength(0);
    expect(() => mountAll(t)).not.toThrow();
    expect(() => mountAll(tree({ admin: false }))).not.toThrow();
  });

  it("集計時点と『管理者が更新したときの内容』の注記が文字で出る。追加指示の全文は出ない(版別カードは『あり/なし』)", () => {
    const keys = buildVerifyModel(input({ admin: false })).versions?.cards.map((c) => c.key) ?? [];
    const t = tree({ admin: false, expandedVersions: keys });
    const text = textOf(t);
    expect(text).toContain("集計時点: 2026-10-10 12:00(JST)");
    expect(text).toContain("管理者が更新したときの内容");
    expect(text).toContain("追加指示: あり / なし");
    expect(text).not.toContain("逃げ馬");
    expect(text).not.toContain("追加指示(全文)");
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

  it("Issue #263: 閲覧者(readOnly)の一覧にも『検証』の入口が出る(#verify)。設定の入口は出ない", () => {
    const model = buildListModel({ route: { date: "20261010", venue: "central", race: null, analysis: null, settings: false }, list: { kind: "loading" }, board: { kind: "none" }, readOnly: true });
    expect(model.verifyHref).toBe("#verify");
    expect(model.settingsHref).toBeNull();
    const t = renderScreen(model, noopActions);
    const links = findAll(t, (n) => n.tag === "a" && (n.attrs?.["class"] === "verify-link" || n.attrs?.["class"] === "settings-link"));
    expect(links.map((n) => [n.attrs?.["class"], n.attrs?.["href"], textOf(n)])).toEqual([["verify-link", "#verify", "検証"]]);
  });
});

describe("Issue #352: 締切直前の再計算との比較の VNode", () => {
  const withClose = (over: Partial<VerifyModelInput> = {}): VNode => tree({ load: { kind: "ready", outcome: { ...READY, closeComparison: closeFixture() } }, ...over });

  it("比較がなければ節を出さない", () => {
    expect(textOf(tree())).not.toContain("締切直前の再計算との比較");
  });

  it("見出し・説明・行(5 分前・直前)・固定の注記を出す。行は他の統計と同じ行の形(表〈table〉は使わない)。閲覧者にも出る", () => {
    for (const admin of [true, false]) {
      const t = withClose({ admin });
      expect(textOf(t)).toContain("締切直前の再計算との比較");
      expect(findAll(t, (n) => n.tag === "table")).toHaveLength(0);
      const section = byClass(t, "verify-close-stats")[0]!;
      const rows = byClass(section, "verify-stat");
      expect(rows.map((r) => textOf(byClass(r, "verify-stat-label")[0]!))).toEqual(["5分前", "直前(発走2分前・暫定)"]);
      expect(textOf(rows[0]!)).toContain("12/15件");
      expect(textOf(rows[0]!)).toContain("参考(件数が少ない)");
      expect(textOf(rows[1]!)).not.toContain("参考");
      expect(textOf(t)).toContain("件数が少ないうちは、回収率の差に意味がありません。");
    }
  });

  it("許可リスト(dom.ts)の範囲で組める", () => {
    mountAll(withClose());
  });
});


describe("Issue #384: 人気帯ごとの期待値と回収率の VNode", () => {
  const withBreakdown = (over: Partial<VerifyModelInput> = {}): VNode => tree({ load: { kind: "ready", outcome: { ...READY, breakdown: breakdownFixture() } }, ...over });

  it("内訳がなければ節を出さない", () => {
    expect(textOf(tree())).not.toContain("人気帯ごとの期待値と回収率");
    expect(byClass(tree(), "verify-breakdown-stats")).toHaveLength(0);
  });

  it("節ごとに見出し・説明・行・注記を出す。行は他の統計と同じ行の形(表〈table〉は使わない)。閲覧者にも出る", () => {
    for (const admin of [true, false]) {
      const t = withBreakdown({ admin });
      const text = textOf(t);
      expect(text).toContain("人気帯ごとの期待値と回収率(複勝)");
      expect(text).toContain("サーバが組み立てた説明文(複勝)");
      expect(text).toContain("サーバが組み立てた注記(複勝)");
      expect(text).toContain("単勝人気と複勝順位のずれ");
      expect(findAll(t, (n) => n.tag === "table")).toHaveLength(0);
      // 行が 0 本の節は行の一覧を出さない(空の ul を作らない)ので、一覧は複勝の節の 1 つだけ。
      const lists = byClass(t, "verify-breakdown-stats");
      expect(lists).toHaveLength(1);
      const rows = byClass(lists[0]!, "verify-stat");
      expect(rows.map((r) => textOf(byClass(r, "verify-stat-label")[0]!))).toEqual(["1〜3番人気", "4〜6番人気"]);
      expect(textOf(rows[0]!)).toContain("2点(1R)");
      expect(textOf(rows[0]!)).toContain("参考(30レース未満)");
      expect(textOf(rows[1]!)).toContain("0点(0R)");
    }
  });

  it("許可リスト(dom.ts)の範囲で組める", () => {
    mountAll(withBreakdown());
  });
});
