import { describe, expect, it } from "vitest";
import type { BoardRow, RaceRow, TaskMode } from "../client/api";
import type { DomDocument } from "../client/dom";
import { buildListModel, type ListModelInput } from "../client/list";
import { parseHash } from "../client/route";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";
import { mount } from "./support/dom-mount";

/**
 * Issue #559: 一覧の先頭の「次に発走するレース」のカード(VNode)。
 * カードは controls の直後。`h2`・`li`・`a.race` は使わない(既存の一覧の木を数える検査と衝突させない)。ボタンは `class=run` と `data-*` を持ち、`onRun` を呼ぶ。
 */

const DATE = "20260628";
const NOW = new Date("2026-06-28T02:00:00Z"); // JST 11:00
const ROUTE = parseHash(`#date=${DATE}&venue=central`, DATE);

function race(n: number, startTime: string | null): RaceRow {
  return { raceId: `2026020201${String(n).padStart(2, "0")}`, venueName: "福島", raceNumber: n, raceName: `レース${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime };
}
const ID = (n: number): string => race(n, null).raceId;
const row = (n: number, mode: TaskMode, status: BoardRow["status"]): BoardRow => ({ raceId: ID(n), mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: status === "done" ? 5 : null });

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const classes = (n: VNode): string[] => String(n.attrs?.["class"] ?? "").split(" ");
const byClass = (t: VNode, cls: string): VNode[] => findAll(t, (n) => classes(n).includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));

function tree(over: Partial<ListModelInput> = {}, actions: ViewActions = noopActions): VNode {
  const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: [race(1, "12:00"), race(2, "13:00")] }, board: { kind: "ready", rows: [] }, now: NOW, choices: new Map([["福島#0", true]]), ...over });
  return renderScreen(model, actions);
}
const card = (t: VNode): VNode => byClass(t, "next-races")[0]!;

describe("一覧の画面: 次に発走するレースのカード(Issue #559)", () => {
  it("カードは controls の直後(画面の 2 番目の子)。見出しは p の strong。1 つのレースの内容: ラベル・レース名・発走時刻と残り・リンク・バッジ", () => {
    const t = tree();
    expect(classes(t.children![0] as VNode)).toContain("controls"); // 前提
    expect(classes(t.children![1] as VNode)).toContain("next-races");
    const c = card(t);
    expect(findAll(c, (n) => n.tag === "p" && classes(n).includes("next-head") && n.children!.some((x) => typeof x !== "string" && x.tag === "strong"))).toHaveLength(1);
    expect(textOf(c)).toContain("次に発走するレース");
    expect(byClass(c, "next-race")).toHaveLength(1); // 前提: 12:00 の 1R だけ(13:00 の 2R は次ではない)
    const text = textOf(c);
    expect(text).toContain("福島 1R");
    expect(text).toContain("レース1");
    expect(text).toContain("12:00");
    expect(text).toContain("あと1時間");
    expect(text).not.toContain("レース2");
    const link = findAll(c, (n) => n.tag === "a");
    expect(link).toHaveLength(1);
    expect(link[0]!.attrs?.["href"]).toBe(`#date=${DATE}&venue=central&race=${ID(1)}`);
    expect(textOf(byClass(c, "badges")[0]!)).toContain("発走前: 未実行");
  });

  it("カードは h2・li・a.race を使わない(一覧の木を数える既存の検査と衝突させない)。場の見出し h2 は 1 つのまま", () => {
    const t = tree();
    expect(findAll(card(t), (n) => n.tag === "h2" || n.tag === "li" || (n.tag === "a" && classes(n).includes("race")))).toHaveLength(0);
    expect(findAll(t, (n) => n.tag === "h2")).toHaveLength(1);
    expect(findAll(t, (n) => n.tag === "a" && classes(n).includes("race"))).toHaveLength(2); // 場のレース行 2 つだけ
    expect(findAll(t, (n) => n.tag === "li")).toHaveLength(2);
  });

  it("同じ時刻の 2 レースは 2 つ並ぶ", () => {
    const t = tree({ list: { kind: "ready", races: [race(2, "12:00"), race(1, "12:00"), race(3, "13:00")] } });
    expect(byClass(card(t), "next-race").map((n) => textOf(n).slice(0, 6))).toEqual(["福島 1R ", "福島 2R "]);
  });

  it.each([
    ["now なし", { now: undefined }],
    ["全部発走済み", { now: new Date("2026-06-28T04:00:00Z") }],
    ["一覧が loading", { list: { kind: "loading" } as const }],
  ])("カードを出さない: %s(controls の次は通常の子になる)", (_label, over) => {
    const t = tree(over as Partial<ListModelInput>);
    expect(byClass(t, "next-races")).toHaveLength(0);
  });

  it("管理者の実行ボタン: class=run・data-date/data-race/data-mode・押すと onRun(日付, レース, pre_race)", () => {
    const calls: [string, string, TaskMode][] = [];
    const t = tree({}, { ...noopActions, onRun: (d, r, m) => void calls.push([d, r, m]) });
    const buttons = byClass(card(t), "run");
    expect(buttons).toHaveLength(1);
    const b = buttons[0]!;
    expect(b.tag).toBe("button");
    expect(b.attrs).toMatchObject({ "data-date": DATE, "data-race": ID(1), "data-mode": "pre_race", disabled: false });
    expect(textOf(b)).toBe("発走前の分析を実行");
    b.on!.click!();
    expect(calls).toEqual([[DATE, ID(1), "pre_race"]]);
  });

  it("ボタンはリンクの中に入れない(a の中の button は不正)", () => {
    const c = card(tree());
    expect(findAll(c, (n) => n.tag === "a").flatMap((a) => findAll(a, (n) => n.tag === "button"))).toHaveLength(0);
    expect(byClass(c, "run")).toHaveLength(1); // 前提: ボタンはある
  });

  it("実行中(queued)はボタンが押せない(disabled)・文言は「待ち」", () => {
    const t = tree({ board: { kind: "ready", rows: [row(1, "pre_race", "queued")] } });
    const b = byClass(card(t), "run")[0]!;
    expect(b.attrs?.["disabled"]).toBe(true);
    expect(textOf(b)).toBe("待ち");
  });

  it("板が取れていないとき: バッジなし・ボタンは押せない", () => {
    const t = tree({ board: { kind: "none" } });
    expect(byClass(card(t), "badges")).toHaveLength(0);
    expect(byClass(card(t), "run")[0]!.attrs?.["disabled"]).toBe(true);
  });

  it("完了(done)のレース: ボタンなし。バッジ「発走前: 完了」とリンクだけ", () => {
    const t = tree({ board: { kind: "ready", rows: [row(1, "pre_race", "done")] } });
    const c = card(t);
    expect(byClass(c, "run")).toHaveLength(0);
    expect(findAll(c, (n) => n.tag === "button")).toHaveLength(0);
    expect(textOf(byClass(c, "badges")[0]!)).toContain("発走前: 完了");
    expect(findAll(c, (n) => n.tag === "a")).toHaveLength(1);
  });

  it("閲覧者: ボタンなし(バッジとリンクは出る)", () => {
    const t = tree({ readOnly: true });
    const c = card(t);
    expect(byClass(c, "next-race")).toHaveLength(1); // 前提
    expect(findAll(c, (n) => n.tag === "button")).toHaveLength(0);
    expect(byClass(c, "badges")).toHaveLength(1);
  });

  it("実行の失敗は role=alert の注記。すでに実行中の注記も出る", () => {
    const runs = (): ReadonlyMap<TaskMode, { kind: "error"; message: string }> => new Map([["pre_race", { kind: "error", message: "実行に失敗しました" }]]);
    const t = tree({ runs });
    const alerts = findAll(card(t), (n) => n.attrs?.["role"] === "alert");
    expect(alerts).toHaveLength(1);
    expect(textOf(alerts[0]!)).toContain("実行に失敗しました");
    const info = tree({ board: { kind: "ready", rows: [row(1, "pre_race", "queued")] }, runs: () => new Map([["pre_race", { kind: "already" as const }]]) });
    expect(textOf(card(info))).toContain("すでに実行中です");
  });

  it("許可リストの検査(mount)を通る", () => {
    const doc: DomDocument = { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }), createTextNode: () => ({}) };
    expect(() => mount(doc, { replaceChildren() {} }, tree())).not.toThrow();
  });
});
