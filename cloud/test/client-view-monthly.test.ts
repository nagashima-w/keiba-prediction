import { describe, expect, it } from "vitest";
import type { MonthlyDetail } from "../client/api-monthly";
import type { DomDocument } from "../client/dom";
import { mount } from "./support/dom-mount";
import { buildMonthlyModel, type MonthlyModelInput } from "../client/monthly-model";
import { buildReportModel } from "../client/report-model";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #279(#265-A): 月報画面の VNode(`view.ts` の月報の描画)と、日報画面に足した「日 / 月」の切り替え。
 * モデル(`client-monthly-model.test.ts`)が正しくても、VNode への写し間違い(節を落とす・日付のリンクを失う・タブの現在位置を取り違える)はモデルのテストでは見えない。
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

function detail(over: Partial<MonthlyDetail> = {}, statsOver: Partial<MonthlyDetail["stats"]> = {}): MonthlyDetail {
  return {
    month: "202610", createdAt: "2026-10-31T13:05:00.000Z", model: null, raceCount: 3, totalStake: 300, totalReturn: 800, summary: null, lastDayPending: false, narrative: null, narrativeRaw: null, note: null, promptVersion: null,
    stats: {
      raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1, unjudgedBetCount: 0, unjudgedStake: 0,
      byBetType: { win: { betCount: 2, hitCount: 1, stake: 300, payout: 800 } },
      byMark: [{ mark: "◎", count: 3, win: 1, top3: 2 }],
      whatIf: { win: { betCount: 3, hitCount: 1, stake: 300, payout: 900, unjudgedCount: 0, inapplicableCount: 0 } },
      fromDate: "20261001", toDate: "20261031", dayCount: 2,
      days: [
        { date: "20261003", raceCount: 2, resultRaceCount: 2, noResultRaceCount: 0, totalStake: 200, totalReturn: 800, recoveryRate: 4, judgedBetCount: 1, hitBetCount: 1, refundedBetCount: 0 },
        { date: "20261031", raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, totalStake: 100, totalReturn: 0, recoveryRate: 0, judgedBetCount: 1, hitBetCount: 0, refundedBetCount: 0 },
      ],
      byVersion: [
        { promptVersion: "v1", raceCount: 2, resultRaceCount: 2, totalStake: 200, totalReturn: 800, recoveryRate: 4, judgedBetCount: 1, hitBetCount: 1 },
        { promptVersion: null, raceCount: 1, resultRaceCount: 1, totalStake: 100, totalReturn: 0, recoveryRate: 0, judgedBetCount: 1, hitBetCount: 0 },
      ],
      ...statsOver,
    },
    ...over,
  };
}

const input = (over: Partial<MonthlyModelInput> = {}): MonthlyModelInput => ({
  today: "20261105", shownMonth: "202610", list: { kind: "ready", items: [{ month: "202610", createdAt: "x", model: null, raceCount: 3, totalStake: 300, totalReturn: 800, summary: null }, { month: "202609", createdAt: "x", model: null, raceCount: 1, totalStake: 1, totalReturn: 1, summary: null }] },
  detail: { kind: "ready", report: detail() }, ...over,
});
const tree = (over: Partial<MonthlyModelInput> = {}): VNode => renderScreen(buildMonthlyModel(input(over)), noopActions);
const headings = (root: VNode): string[] => kids(root).filter((c): c is VNode => typeof c !== "string" && (c.tag === "h2" || c.tag === "h3")).map(textOf);

describe("月報画面の VNode", () => {
  it("画面は report-screen(日報と同じ画面の枠)。見出し・戻るリンク・更新ボタンがある。VNode が DOM に載せられる", () => {
    const t = tree();
    expect(classesOf(t)).toEqual(expect.arrayContaining(["screen", "report-screen"]));
    expect(findAll(t, (n) => n.tag === "h1").map(textOf)).toEqual(["月報"]);
    expect(findAll(t, (n) => n.tag === "a" && classesOf(n).includes("back")).map((n) => n.attrs?.["href"])).toEqual(["#"]);
    expect(byClass(t, "refresh")).toHaveLength(1);
    mountAll(t);
  });

  it("日 / 月のタブ: 『日報』は #report、『月報』は表示中の月で、月報の側が現在位置(aria-current=page)", () => {
    const tabs = findAll(tree(), (n) => n.tag === "nav" && n.attrs?.["aria-label"] === "日報と月報");
    expect(tabs).toHaveLength(1);
    const links = findAll(tabs[0]!, (n) => n.tag === "a");
    expect(links.map((a) => [textOf(a), a.attrs?.["href"], a.attrs?.["aria-current"]])).toEqual([
      ["日報", "#report", undefined],
      ["月報", "#report=202610", "page"],
    ]);
  });

  it("月の移動: 表示中の月の見出し・前の月報・次の月報・最新の月報へのリンク(あるものだけ)", () => {
    const t = tree({ shownMonth: "202609" });
    expect(textOf(byClass(t, "report-month")[0]!)).toContain("2026年9月");
    const nav = findAll(t, (n) => n.tag === "nav" && n.attrs?.["aria-label"] === "月報の移動");
    expect(nav).toHaveLength(1);
    expect(findAll(nav[0]!, (n) => n.tag === "a").map((a) => [textOf(a), a.attrs?.["href"]])).toEqual([
      ["次の月報", "#report=202610"],
      ["最新の月報", "#report=202610"],
    ]);
    const latest = findAll(tree({ shownMonth: "202610" }), (n) => n.tag === "nav" && n.attrs?.["aria-label"] === "月報の移動");
    expect(findAll(latest[0]!, (n) => n.tag === "a").map((a) => [textOf(a), a.attrs?.["href"]])).toEqual([["前の月報", "#report=202609"]]);
  });

  it("本文の節の順: 見出し・メタ・成績のタイル・注記・文章が無い旨・開催日ごと・券種別・印別・もしも・版ごと", () => {
    const t = tree();
    expect(headings(t)).toEqual(["2026年10月の月報", "開催日ごと(日付から日報を開けます)", "券種別の成績", "印別の成績(結果のあるレース。頭数 / 1着 / 3着内)", "もしも(印の定型の買い方。各100円)", "プロンプトの版ごと"]);
    expect(byClass(t, "verify-tile")).toHaveLength(4); // 賭け金・払戻・回収率・的中(見込みは確率のあるデータが無いので出ない)
    expect(textOf(byClass(t, "verify-tile")[2]!)).toContain("266.7%");
  });

  it("開催日ごとの行: 日付が日報(#report=YYYYMMDD)へのリンクで、行の値が日ごとの数字", () => {
    const t = tree();
    const links = byClass(t, "report-day-link");
    expect(links.map((a) => [textOf(a), a.attrs?.["href"]])).toEqual([
      ["2026年10月3日(土)", "#report=20261003"],
      ["2026年10月31日(土)", "#report=20261031"],
    ]);
    const rows = findAll(t, (n) => n.tag === "li" && n.children?.some((c) => typeof c !== "string" && classesOf(c).includes("report-day-link")) === true);
    expect(rows.map(textOf)).toEqual([
      "2026年10月3日(土) 2 レース・回収率 400.0%・1 点中 1 点的中・賭け金 200円・払戻 800円",
      "2026年10月31日(土) 1 レース・回収率 0.0%・1 点中 0 点的中・賭け金 100円・払戻 0円",
    ]);
  });

  it("注記は固定の文言で、最終日の未確定の注記は lastDayPending のときだけ出る", () => {
    const plain = tree();
    expect(byClass(plain, "report-note").map(textOf)).toEqual(["月の数字は、作成した時点の分析と結果から数え直したものです。日報の合計と一致しないことがあります(日報は作成後に取り込まれた結果を反映しないため)。"]);
    const pending = tree({ detail: { kind: "ready", report: detail({ lastDayPending: true }) } });
    expect(byClass(pending, "report-note").map(textOf)).toEqual([
      "最終日の結果または日報がそろう前に作ったため、最終日の分は一部が反映されていない場合があります。",
      "月の数字は、作成した時点の分析と結果から数え直したものです。日報の合計と一致しないことがあります(日報は作成後に取り込まれた結果を反映しないため)。",
    ]);
    expect(textOf(plain)).toContain("LLM の振り返りの文章はありません(統計だけの月報です)。");
  });

  it("版が 1 つだけの月は、版ごとの節を出さない。もしもが無い月は、もしもの節を出さない", () => {
    const t = tree({ detail: { kind: "ready", report: detail({}, { byVersion: [], whatIf: null }) } });
    expect(headings(t)).not.toContain("プロンプトの版ごと");
    expect(headings(t)).not.toContain("もしも(印の定型の買い方。各100円)");
  });

  it("月報が無い月: 本文なしで、案内(notice)だけを出す。読み込み中は『読み込み中…』", () => {
    const none = tree({ detail: { kind: "ready", report: null } });
    expect(headings(none)).toEqual([]);
    expect(byClass(none, "notice")).toHaveLength(1);
    expect(textOf(tree({ detail: { kind: "loading" } }))).toContain("読み込み中…");
  });

  it("取得の失敗は error の notice(role=alert)で出す", () => {
    const t = tree({ detail: { kind: "error", message: "月報の通信に失敗しました。" } });
    const alerts = findAll(t, (n) => n.attrs?.["role"] === "alert");
    expect(alerts.map(textOf)).toEqual(["月報の通信に失敗しました。"]);
  });
});

describe("LLM の文章と管理者の操作(Issue #280)", () => {
  const NARRATIVE = { summary: "10 月は 3 レースを分析した。", good: ["良い点 1", "良い点 2"], improve: ["改善点 1"], outlook: ["来月に見ておく数字"] };
  const withText = (extra: Partial<MonthlyDetail> = {}): MonthlyInput => ({ detail: { kind: "ready", report: detail({ model: "claude-sonnet-5-5", narrative: NARRATIVE, ...extra }) } });
  type MonthlyInput = Partial<MonthlyModelInput>;

  it("文章がある月報: 総括・良かった点・改善点・来月に向けての節を、注記のあと・開催日ごとの前に出す。文章が無い旨の注記は出さない", () => {
    const t = tree(withText());
    expect(headings(t)).toEqual(["2026年10月の月報", "総括", "良かった点", "改善点", "来月に向けて", "開催日ごと(日付から日報を開けます)", "券種別の成績", "印別の成績(結果のあるレース。頭数 / 1着 / 3着内)", "もしも(印の定型の買い方。各100円)", "プロンプトの版ごと"]);
    expect(textOf(byClass(t, "report-summary")[0]!)).toBe("10 月は 3 レースを分析した。");
    const lists = findAll(t, (n) => n.tag === "ul" && !classesOf(n).includes("report-days") && !classesOf(n).includes("verify-rows"));
    expect(lists.map((l) => kids(l).map(textOf))).toEqual([["良い点 1", "良い点 2"], ["改善点 1"], ["来月に見ておく数字"]]);
    expect(textOf(t)).not.toContain("LLM の振り返りの文章はありません");
    mountAll(t);
  });

  it("文章が無い月報: 従来どおり、文章が無い旨の注記だけ(節は出さない)", () => {
    const t = tree();
    expect(headings(t)).not.toContain("総括");
    expect(headings(t)).not.toContain("来月に向けて");
    expect(textOf(t)).toContain("LLM の振り返りの文章はありません(統計だけの月報です)。");
  });

  it("読めなかった応答(生の文章): 構造として読めなかった旨の注記と、生の文章(report-raw)を出す。節の見出しは出さない", () => {
    const t = tree(withText({ narrative: null, narrativeRaw: "これは生の文章 <b>タグ</b>" }));
    expect(textOf(t)).toContain("LLM の応答を構造として読めなかったため、生の文章を載せています。");
    expect(byClass(t, "report-raw").map(textOf)).toEqual(["これは生の文章 <b>タグ</b>"]); // テキストノードのまま(HTML として解釈しない)
    expect(headings(t)).not.toContain("総括");
    mountAll(t);
  });

  it("管理者: 月報がある終わった月は『月報を作り直す』のボタン。押すと onReportRegenOpen。確認が開いているときはボタンの代わりに確認(文面・実行・やめる)で、各ボタンが onReportRegenGo・onReportRegenCancel", () => {
    const calls: string[] = [];
    const actions = { ...noopActions, onReportRegenOpen: () => void calls.push("open"), onReportRegenGo: () => void calls.push("go"), onReportRegenCancel: () => void calls.push("cancel"), onReportRun: () => void calls.push("run") };
    const closed = renderScreen(buildMonthlyModel(input(withText())), actions);
    const button = byClass(closed, "report-regen");
    expect(button.map(textOf)).toEqual(["月報を作り直す"]);
    expect(byClass(closed, "report-regen-confirm")).toHaveLength(0);
    expect(byClass(closed, "report-run")).toHaveLength(0);
    button[0]!.on!.click!();
    const open = renderScreen(buildMonthlyModel(input({ ...withText(), regen: { kind: "confirm" } })), actions);
    expect(byClass(open, "report-regen")).toHaveLength(0);
    expect(textOf(byClass(open, "report-regen-confirm")[0]!)).toContain("元に戻せません");
    byClass(open, "report-regen-go")[0]!.on!.click!();
    byClass(open, "report-regen-cancel")[0]!.on!.click!();
    expect(calls).toEqual(["open", "go", "cancel"]);
    mountAll(open);
  });

  it("作り直しの依頼中は、ボタンが無効で『依頼中…』。作り直し中(requested)はボタンを出さない", () => {
    const posting = renderScreen(buildMonthlyModel(input({ ...withText(), regen: { kind: "posting" } })), noopActions);
    expect(byClass(posting, "report-regen").map((b) => [textOf(b), b.attrs?.["disabled"]])).toEqual([["依頼中…", true]]);
    const running = renderScreen(buildMonthlyModel(input({ ...withText(), regen: { kind: "requested", since: "x" } })), noopActions);
    expect(byClass(running, "report-regen")).toHaveLength(0);
    expect(findAll(running, (n) => classesOf(n).includes("notice") && classesOf(n).includes("wait")).length).toBeGreaterThan(0);
  });

  it("管理者: 月報が無い終わった月は『この月の月報を作る』のボタン(注意つき)。押すと onReportRun", () => {
    const calls: string[] = [];
    const t = renderScreen(buildMonthlyModel(input({ detail: { kind: "ready", report: null } })), { ...noopActions, onReportRun: () => void calls.push("run") });
    const run = byClass(t, "report-run");
    expect(run.map(textOf)).toEqual(["この月の月報を作る"]);
    expect(textOf(byClass(t, "report-caution")[0]!)).toContain("押した時点の分析と結果で月報を作ります");
    run[0]!.on!.click!();
    expect(calls).toEqual(["run"]);
    expect(byClass(t, "report-regen")).toHaveLength(0);
    mountAll(t);
  });

  it("閲覧者(readOnly)・今月の画面には、どちらのボタンも出ない", () => {
    for (const t of [
      renderScreen(buildMonthlyModel(input({ ...withText(), readOnly: true })), noopActions),
      renderScreen(buildMonthlyModel(input({ detail: { kind: "ready", report: null }, readOnly: true })), noopActions),
      renderScreen(buildMonthlyModel(input({ today: "20261031", ...withText() })), noopActions), // 10 月の最終日(今月)
    ]) {
      expect(byClass(t, "report-regen")).toHaveLength(0);
      expect(byClass(t, "report-run")).toHaveLength(0);
    }
  });
});

describe("日報画面に足した『日 / 月』のタブ", () => {
  const dayInput = { today: "20261010", shownDate: "20261005", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: null, job: null }, run: { kind: "idle" }, pollStopped: false } as const;

  it("日報の側が現在位置で、『月報』は表示中の日の月の月報(#report=YYYYMM)へ向かう", () => {
    const model = buildReportModel({ ...dayInput });
    expect(model.tabs).toStrictEqual({ dayHref: "#report=20261005", monthHref: "#report=202610" });
    const tabs = findAll(renderScreen(model, noopActions), (n) => n.tag === "nav" && n.attrs?.["aria-label"] === "日報と月報");
    expect(tabs).toHaveLength(1);
    expect(findAll(tabs[0]!, (n) => n.tag === "a").map((a) => [textOf(a), a.attrs?.["href"], a.attrs?.["aria-current"]])).toEqual([
      ["日報", "#report=20261005", "page"],
      ["月報", "#report=202610", undefined],
    ]);
  });
});
