import { describe, expect, it } from "vitest";
import type { BoardRow, RaceRow } from "../client/api";
import { mount, type DomDocument } from "../client/dom";
import type { BulkUi } from "../client/bulk";
import { buildListModel, groupKeys } from "../client/list";
import { parseHash } from "../client/route";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #251: 一覧の場のまとまりに出す、一括実行のボタン・確認画面・結果(VNode)。
 * ユーザー決定: ボタンは、競馬場を開いたときだけ、中の上部に 2 つ出す(閉じている場には出さない)。管理者だけ。
 * クリック処理に渡す引数(場のキー・モード)は `data-*` にも出す(`createMounter` が同じ木の DOM を触らないため。Issue #186 の規則)。
 */

const DATE = "20260628";
const NOW = new Date("2026-06-28T05:00:00Z");
const ROUTE = parseHash(`#date=${DATE}&venue=central`, DATE);

function race(raceId: string, venueName: string, n: number): RaceRow {
  return { raceId, venueName, raceNumber: n, raceName: `R${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: "15:00" };
}
const RACES: RaceRow[] = [race("202602020101", "福島", 1), race("202602020102", "福島", 2), race("202605020101", "東京", 1)];
const KEYS = groupKeys(RACES);
const NONE = { running: 0, done: 0, started: 0, timeUnknown: 0 };

function textOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));

function render(options: { open?: boolean; readOnly?: boolean; states?: Map<string, BulkUi>; board?: BoardRow[]; actions?: Partial<ViewActions> } = {}): VNode {
  const choices = new Map<string, boolean>(KEYS.map((k) => [k, options.open ?? true] as const));
  const model = buildListModel({
    route: ROUTE,
    list: { kind: "ready", races: RACES },
    board: { kind: "ready", rows: options.board ?? [] },
    choices,
    readOnly: options.readOnly,
    bulk: { now: NOW, states: options.states ?? new Map() },
  });
  return renderScreen(model, { ...noopActions, ...options.actions });
}

function mountAll(tree: VNode): void {
  const doc: DomDocument = {
    createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }),
    createTextNode: () => ({}),
  };
  mount(doc, { replaceChildren() {} }, tree);
}

describe("一括実行のボタン(Issue #251)", () => {
  it("場を開いているときだけ、その場の中に 2 つ出す(場ごとに 2 つ。閉じた場には出さない)", () => {
    const open = render({ open: true });
    expect(byClass(open, "bulk")).toHaveLength(2); // 福島・東京
    expect(byClass(open, "bulk-run")).toHaveLength(4);
    const closed = render({ open: false });
    expect(byClass(closed, "bulk")).toHaveLength(0);
    expect(byClass(closed, "bulk-run")).toHaveLength(0);
  });

  it("ボタンは、事前分析・発走前の分析の順で、対象の件数つきの文言。場の見出しの下・レースの一覧の上に置く", () => {
    const tree = render();
    const section = byClass(tree, "venue")[0]!;
    const children = section.children as VNode[];
    expect(children.map((c) => c.tag)).toEqual(["h2", "div", "ul"]); // 見出し → 一括実行 → レースの一覧
    expect(byClass(section, "bulk-run").map((b) => textOf(b))).toEqual(["事前分析を一括実行(2)", "発走前の分析を一括実行(2)"]);
  });

  it("クリック処理の引数(場のキー・モード)が data-* に出ている。押すと onBulkOpen(場のキー, モード) を呼ぶ", () => {
    const calls: unknown[][] = [];
    const tree = render({ actions: { onBulkOpen: (...args) => void calls.push(args) } });
    const buttons = byClass(byClass(tree, "bulk")[0]!, "bulk-run");
    expect(buttons.map((b) => [b.attrs?.["data-key"], b.attrs?.["data-mode"]])).toEqual([
      [KEYS[0], "morning"],
      [KEYS[0], "pre_race"],
    ]);
    buttons[1]!.on?.click?.();
    expect(calls).toEqual([[KEYS[0], "pre_race"]]);
  });

  it("無効なボタンは disabled 属性つきで、理由の注記を出す(板が取れていないとき)", () => {
    const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board: { kind: "none" }, choices: new Map(KEYS.map((k) => [k, true] as const)), bulk: { now: NOW, states: new Map() } });
    const tree = renderScreen(model, noopActions);
    for (const button of byClass(tree, "bulk-run")) {
      expect(button.attrs?.["disabled"]).toBe(true);
    }
    expect(byClass(tree, "bulk-note").map((n) => textOf(n))).toEqual(["実行状態を取得できていないため、一括実行できません。「更新」を押してください。", "実行状態を取得できていないため、一括実行できません。「更新」を押してください。"]);
  });

  it("閲覧者(readOnly)には、場を開いていても一括実行の要素を一切出さない", () => {
    const tree = render({ readOnly: true });
    expect(byClass(tree, "venue")).toHaveLength(2); // 前提: 場は描画されている
    expect(byClass(tree, "races")).toHaveLength(2);
    for (const cls of ["bulk", "bulk-run", "bulk-note", "bulk-panel", "bulk-go", "bulk-cancel", "bulk-close"]) {
      expect(byClass(tree, cls), cls).toHaveLength(0);
    }
    expect(textOf(tree)).not.toContain("一括実行");
  });
});

describe("確認画面(Issue #251)", () => {
  const confirm = (mode: "morning" | "pre_race"): BulkUi => ({ kind: "confirm", mode, raceIds: ["202602020101", "202602020102"], excluded: { ...NONE, running: 1 } });

  it("その場の中に、見出し・対象の件数・費用の行・注意書き・「実行する」「やめる」を出す。押すと onBulkGo・onBulkDismiss に場のキーを渡す", () => {
    const go: string[] = [];
    const dismiss: string[] = [];
    const tree = render({ states: new Map([[KEYS[0]!, confirm("pre_race")]]), actions: { onBulkGo: (key) => void go.push(key), onBulkDismiss: (key) => void dismiss.push(key) } });
    const panels = byClass(tree, "bulk-panel");
    expect(panels).toHaveLength(1); // 福島だけ(東京は状態なし)
    const panel = panels[0]!;
    const text = textOf(panel);
    expect(text).toContain("福島の発走前の分析を一括実行しますか");
    expect(text).toContain("対象: 2 レース");
    expect(text).toContain("LLM の呼び出し: 通常 2 回");
    expect(text).toContain("最大 4 回");
    expect(text).toContain("除外: 実行中 1");
    expect(byClass(panel, "bulk-note-line").map((n) => textOf(n))).toHaveLength(2); // 注意書き 2 つ
    expect(text).toContain("二重に課金");
    expect(text).toContain("開始が遅れる");
    const goButton = byClass(panel, "bulk-go")[0]!;
    const cancelButton = byClass(panel, "bulk-cancel")[0]!;
    expect([textOf(goButton), textOf(cancelButton)]).toEqual(["実行する", "やめる"]);
    expect([goButton.attrs?.["data-key"], goButton.attrs?.["data-mode"]]).toEqual([KEYS[0], "pre_race"]);
    expect(cancelButton.attrs?.["data-key"]).toBe(KEYS[0]);
    goButton.on?.click?.();
    cancelButton.on?.click?.();
    expect(go).toEqual([KEYS[0]]);
    expect(dismiss).toEqual([KEYS[0]]);
  });

  it("事前分析の確認画面には、課金・遅れの注意書きを出さない(LLM を使わない)", () => {
    const tree = render({ states: new Map([[KEYS[0]!, confirm("morning")]]) });
    const text = textOf(byClass(tree, "bulk-panel")[0]!);
    expect(text).toContain("LLM は使いません");
    expect(text).not.toContain("二重に課金");
    expect(byClass(tree, "bulk-note-line")).toHaveLength(0);
  });

  it("送信中は「予約しています」の表示で、確認のボタンは出さない。ボタンは無効", () => {
    const tree = render({ states: new Map([[KEYS[0]!, { kind: "sending", mode: "morning" } as BulkUi]]) });
    const section = byClass(tree, "bulk")[0]!;
    expect(textOf(section)).toContain("事前分析を予約しています…");
    expect(byClass(section, "bulk-go")).toHaveLength(0);
    expect(byClass(section, "bulk-run").map((b) => b.attrs?.["disabled"])).toEqual([true, true]);
  });

  it("結果の表示: 成功は通常の注記、失敗は alert。どちらも「閉じる」で onBulkDismiss に場のキーを渡す", () => {
    const dismiss: string[] = [];
    const ok = render({ states: new Map([[KEYS[0]!, { kind: "result", tone: "ok", text: "2 レースを予約しました。" } as BulkUi]]), actions: { onBulkDismiss: (key) => void dismiss.push(key) } });
    const okResult = byClass(ok, "bulk-result")[0]!;
    expect(textOf(okResult)).toContain("2 レースを予約しました。");
    expect(okResult.attrs?.["role"]).toBe("status");
    byClass(okResult, "bulk-close")[0]!.on?.click?.();
    expect(dismiss).toEqual([KEYS[0]]);
    const failed = render({ states: new Map([[KEYS[0]!, { kind: "result", tone: "error", text: "失敗しました" } as BulkUi]]) });
    expect(byClass(failed, "bulk-result")[0]!.attrs?.["role"]).toBe("alert");
    expect(String(byClass(failed, "bulk-result")[0]!.attrs?.["class"])).toContain("error");
  });

  it("許可リストつきのアダプタで組み立てられる(許可されていない要素・属性を使っていない)。外から来る文字列はテキストノード", () => {
    const states = new Map<string, BulkUi>([
      [KEYS[0]!, confirm("pre_race")],
      [KEYS[1]!, { kind: "result", tone: "error", text: "<script>x</script>" }],
    ]);
    expect(() => mountAll(render({ states }))).not.toThrow();
  });
});
