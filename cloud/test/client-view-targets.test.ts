import { describe, expect, it } from "vitest";
import type { TargetRace, TargetsData } from "../client/api-targets";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel } from "../client/list";
import { buildTargetsModel } from "../client/targets-model";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #336 段階 B: 今日の狙い目の画面(VNode)。構造・クラス・リンク・押したときの処理。DOM への組み立て(許可リストの範囲・外から来た文字列はテキストノード)と、
 * 一覧の入口のリンクも確かめる。実機の描画は確認できないので、組み立てが投げないこと・許可リストの要素だけを使うことで代える。
 */

const MIN = 60_000;
const NOW = Date.parse("2026-10-17T05:00:00Z");

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

function race(id: string, startMs: number | null, overrides: Partial<TargetRace> = {}): TargetRace {
  return { raceId: id, analysisId: Number(id.slice(-4)), startMs, startTime: startMs === null ? null : "15:40", place: "東京11R", pick: "◎7", skipped: false, detail: "5点 1,200円 EV 1.42・分析時", ...overrides };
}
const R = (n: number) => `2026050508${String(n).padStart(2, "0")}`;

function tree(races: TargetRace[], extra: { loading?: boolean; error?: string | null; summary?: string; actions?: ViewActions; noData?: boolean } = {}): VNode {
  const data: TargetsData | null = extra.noData === true ? null : { date: "20261017", nowMs: NOW, summary: extra.summary ?? "分析済み 5 レース中、狙い目 4", races };
  return renderScreen(buildTargetsModel({ date: "20261017", data, error: extra.error ?? null, loading: extra.loading ?? false, nowMs: NOW }), extra.actions ?? noopActions);
}

describe("狙い目画面(view.ts)", () => {
  const races = [race(R(1), NOW - 30 * MIN), race(R(3), NOW + 5 * MIN), race(R(4), NOW + 40 * MIN, { skipped: true, pick: null, detail: "見送り・発走2分前の再計算で0点" }), race(R(5), null)];

  it("見出し・戻るリンク・日付・要約・更新ボタンが出る", () => {
    const t = tree(races);
    expect(byClass(t, "back").map((n) => [textOf(n), n.attrs?.["href"]])).toEqual([["一覧へ戻る", "#date=20261017&venue=central"]]);
    expect(findAll(t, (n) => n.tag === "h1").map(textOf)).toEqual(["狙い目 2026-10-17"]);
    expect(byClass(t, "meta").map(textOf)).toEqual(["分析済み 5 レース中、狙い目 4"]);
    expect(byClass(t, "refresh").map(textOf)).toEqual(["更新"]);
  });

  it("未発走の行が先、発走済みは「発走済み」の見出しの下に出る。行は結果画面へのリンクで、時刻・場と R・◎・残り・2 行目を持つ", () => {
    const t = tree(races);
    const lists = findAll(t, (n) => n.tag === "ul");
    expect(lists).toHaveLength(2); // 前提: 未発走と発走済みの両方に行がある
    const upcoming = byClass(lists[0]!, "race");
    expect(upcoming.map((n) => n.attrs?.["href"])).toEqual(["#date=20261017&venue=central&analysis=803", "#date=20261017&venue=central&analysis=804", "#date=20261017&venue=central&analysis=805"]);
    expect(textOf(upcoming[0]!)).toContain("15:40");
    expect(textOf(upcoming[0]!)).toContain("東京11R");
    expect(textOf(upcoming[0]!)).toContain("◎7");
    expect(textOf(upcoming[0]!)).toContain("あと5分");
    expect(textOf(upcoming[0]!)).toContain("5点 1,200円 EV 1.42・分析時");
    expect(textOf(upcoming[2]!)).toContain("時刻不明");
    expect(findAll(t, (n) => n.tag === "h2").map(textOf)).toEqual(["発走済み"]);
    const past = byClass(lists[1]!, "race");
    expect(past).toHaveLength(1);
    expect(textOf(past[0]!)).toContain("発走済み");
  });

  it("間近(10 分以内)と見送りの行は、区別できるクラスを持つ", () => {
    const t = tree(races);
    expect(byClass(t, "t-left").map((n) => String(n.attrs?.["class"]))).toEqual(["t-left soon", "t-left", "t-left", "t-left"]);
    expect(byClass(t, "race").map((n) => String(n.attrs?.["class"]).includes("skipped"))).toEqual([false, true, false, false]);
  });

  it("発走済みの行だけが past のクラスを持つ(未発走の行・見送りの行は持たない)。見送りの発走済みは skipped と past の両方", () => {
    const t = tree([race(R(1), NOW - 30 * MIN), race(R(2), NOW - 5 * MIN, { skipped: true }), race(R(3), NOW + 5 * MIN), race(R(4), NOW + 40 * MIN, { skipped: true }), race(R(5), null)]);
    const rows = byClass(t, "race");
    expect(rows).toHaveLength(5); // 前提: 全行がある
    const classes = rows.map((n) => String(n.attrs?.["class"]).split(" "));
    // 並びは 未発走(R3・R4・R5)→ 発走済み(新しい順: R2・R1)
    expect(rows.map((n) => textOf(n).includes("発走済み"))).toEqual([false, false, false, true, true]);
    expect(classes.map((c) => c.includes("past"))).toEqual([false, false, false, true, true]);
    expect(classes.map((c) => c.includes("skipped"))).toEqual([false, true, false, true, false]);
    // 「発走済み」の見出しの下の一覧の行がすべて past で、未発走の一覧の行に past は無い
    const lists = findAll(t, (n) => n.tag === "ul");
    expect(byClass(lists[0]!, "past")).toHaveLength(0);
    expect(byClass(lists[1]!, "past")).toHaveLength(2);
  });

  it("発走済みが無ければ、発走済みの見出しも出さない。未発走が無ければ、未発走の一覧を出さない", () => {
    expect(findAll(tree([race(R(3), NOW + MIN)]), (n) => n.tag === "h2")).toEqual([]);
    const onlyPast = tree([race(R(1), NOW - MIN)]);
    expect(findAll(onlyPast, (n) => n.tag === "ul")).toHaveLength(1);
    expect(findAll(onlyPast, (n) => n.tag === "h2").map(textOf)).toEqual(["発走済み"]);
  });

  it("狙い目が 0 件: 一覧は出さず、要約(理由)を出す", () => {
    const t = tree([], { summary: "分析済み 12 レースのうち、狙い目はありません" });
    expect(findAll(t, (n) => n.tag === "ul")).toEqual([]);
    expect(byClass(t, "meta").map(textOf)).toEqual(["分析済み 12 レースのうち、狙い目はありません"]);
  });

  it("読み込み中: 更新ボタンは無効で「読み込み中…」。データが無い間は本文にも「読み込み中…」を出す", () => {
    const t = tree([], { noData: true, loading: true });
    const refresh = byClass(t, "refresh")[0]!;
    expect(textOf(refresh)).toBe("読み込み中…");
    expect(refresh.attrs?.["disabled"]).toBe(true);
    expect(byClass(t, "empty").map(textOf)).toEqual(["読み込み中…"]);
  });

  it("エラー: 注記(role=alert)を出す。前の一覧があれば残る", () => {
    const t = tree(races, { error: "通信に失敗しました。" });
    const notices = byClass(t, "notice");
    expect(notices.map(textOf)).toEqual(["通信に失敗しました。"]);
    expect(notices[0]!.attrs?.["role"]).toBe("alert");
    expect(byClass(t, "race").length).toBe(4);
  });

  it("「更新」を押すと onRefresh が呼ばれる", () => {
    let called = 0;
    const t = tree(races, { actions: { ...noopActions, onRefresh: () => (called += 1) } });
    byClass(t, "refresh")[0]!.on!.click!();
    expect(called).toBe(1);
  });
});

describe("DOM への組み立て(dom.ts の許可リストの範囲だけで組める。外から来た文字列は HTML として解釈しない)", () => {
  const ALLOWED = new Set(["div", "span", "p", "h1", "h2", "h3", "a", "button", "input", "label", "ul", "li", "section", "nav", "strong", "small", "textarea", "select", "option", "progress", "canvas"]);
  const mountTags = (t: VNode): { tags: string[]; texts: string[] } => {
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
    mount(doc, { replaceChildren() {} }, t);
    return { tags, texts };
  };
  const evil = "<img src=x onerror=alert(1)>";

  it("組み立てが投げず、許可リストのタグだけを使い、img は作らず、サーバの文字列はテキストノードになる", () => {
    const hostile = [race(R(1), NOW - MIN, { place: evil, detail: evil, pick: evil }), race(R(3), NOW + MIN, { place: evil, detail: evil }), race(R(4), null)];
    const { tags, texts } = mountTags(tree(hostile, { summary: evil, error: evil }));
    expect(tags.length).toBeGreaterThan(10); // 前提: 実際に組み立てている
    expect(tags.every((t) => ALLOWED.has(t))).toBe(true);
    expect(tags).not.toContain("img");
    expect(texts.filter((t) => t.includes(evil)).length).toBeGreaterThanOrEqual(5);
  });

  it("空・読み込み中・エラーのどの状態でも組み立てが投げない", () => {
    for (const t of [tree([]), tree([], { noData: true, loading: true }), tree([], { noData: true, error: "失敗" })]) {
      expect(() => mountTags(t)).not.toThrow();
    }
  });
});

describe("一覧の入口", () => {
  it("一覧の操作欄に「狙い目」のリンクがあり、リンク先は #targets=日付。閲覧者にも出る", () => {
    const route = { date: "20261017", venue: "central" as const, race: null, analysis: null, settings: false };
    for (const readOnly of [false, true]) {
      const model = buildListModel({ route, list: { kind: "ready", races: [] }, board: { kind: "none" }, readOnly });
      const link = byClass(renderScreen(model, noopActions), "targets-link");
      expect(link.map((n) => [textOf(n), n.attrs?.["href"]]), String(readOnly)).toEqual([["狙い目", "#targets=20261017"]]);
    }
  });
});
