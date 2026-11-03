import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import { buildListModel, updatedLabel, type ListModelInput } from "../client/list";
import { parseHash } from "../client/route";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #572: 一覧の「最終更新」の表示(純関数・表示用データ・VNode)。
 * 時刻は端末の時計(`Date.now()` 相当)の値を、JST(UTC+9)の「HH:MM」で出す。ブラウザのタイムゾーンには依存しない。取得した日(JST)が今日(JST)と違えば「M/D」を前に付ける。
 * app を通した取得の回数・時刻の更新は `client-app-list-updated.test.ts`。
 */

const DATE = "20260628";
const ROUTE = parseHash(`#date=${DATE}&venue=central`, DATE);
const utc = (iso: string): number => Date.parse(iso);

describe("updatedLabel: 最終更新の文言(JST。日付をまたいだら M/D を前置)", () => {
  // 「今」は 2026-11-02 10:00 JST。
  const NOW = utc("2026-11-02T01:00:00Z");
  it.each([
    ["同じ日の午前(ゼロ埋め)", "2026-11-02T00:05:00Z", "最終更新 09:05"],
    ["同じ日の午後", "2026-11-02T00:48:00Z", "最終更新 09:48"],
    ["JST の日付が変わった直後(UTC では前日の 15:00)は同じ日", "2026-11-01T15:00:00Z", "最終更新 00:00"],
    ["JST の前日の 23:59(UTC では前日の 14:59)は前日", "2026-11-01T14:59:00Z", "最終更新 11/1 23:59"],
    ["数日前", "2026-10-29T03:07:00Z", "最終更新 10/29 12:07"],
  ])("%s", (_name, at, expected) => {
    expect(updatedLabel(utc(at), NOW)).toBe(expected);
  });

  it("年をまたぐ: 12/31 の取得を 1/1 に見ると『12/31』(月・日はゼロ埋めしない)", () => {
    expect(updatedLabel(utc("2025-12-31T05:00:00Z"), utc("2026-01-01T01:00:00Z"))).toBe("最終更新 12/31 14:00");
    expect(updatedLabel(utc("2026-01-01T05:00:00Z"), utc("2026-01-02T01:00:00Z"))).toBe("最終更新 1/1 14:00");
  });

  it("対照: 上の表の文言は互いに異なる(時・分・日付のどれかを落とす実装を見逃さない)", () => {
    const labels = ["2026-11-02T00:05:00Z", "2026-11-02T00:48:00Z", "2026-11-01T15:00:00Z", "2026-11-01T14:59:00Z"].map((t) => updatedLabel(utc(t), NOW));
    expect(new Set(labels).size).toBe(4);
  });
});

function race(n: number): RaceRow {
  return { raceId: `2026020201${String(n).padStart(2, "0")}`, venueName: "福島", raceNumber: n, raceName: `レース${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: "12:00" };
}
const NOW = new Date("2026-06-28T01:00:00Z"); // JST 10:00
const AT = utc("2026-06-28T00:48:00Z"); // JST 09:48

function model(over: Partial<ListModelInput> = {}) {
  return buildListModel({ route: ROUTE, list: { kind: "ready", races: [race(1)] }, board: { kind: "ready", rows: [] }, now: NOW, updatedAt: AT, ...over });
}

describe("buildListModel: updatedLabel と listLoading(Issue #572)", () => {
  it("一覧が取れていて updatedAt があれば、文言が出る", () => {
    expect(model().updatedLabel).toBe("最終更新 09:48");
  });

  it("開催が 0 件(空)でも出す(確かめた時刻として)", () => {
    const m = model({ list: { kind: "ready", races: [] } });
    expect(m.empty).toBe(true); // 前提
    expect(m.updatedLabel).toBe("最終更新 09:48");
  });

  it.each([
    ["updatedAt を渡さない", { updatedAt: undefined }],
    ["updatedAt が null", { updatedAt: null }],
    ["一覧が読み込み中", { list: { kind: "loading" } as const }],
    ["一覧が失敗", { list: { kind: "error", message: "失敗" } as const }],
  ])("出さない(null): %s", (_name, over) => {
    // 前提: 対照の既定では出る
    expect(model().updatedLabel).not.toBeNull();
    expect(model(over as Partial<ListModelInput>).updatedLabel).toBeNull();
  });

  it("now を渡さないときは日付を前置しない(updatedAt 自身を今として扱う)", () => {
    expect(model({ now: undefined }).updatedLabel).toBe("最終更新 09:48");
  });

  it("listLoading: 一覧が読み込み中のときだけ true。板だけの取得中(boardLoading)・取得済み・失敗は false", () => {
    expect(model({ list: { kind: "loading" } }).listLoading).toBe(true);
    expect(model({ boardLoading: true }).listLoading).toBe(false);
    expect(model({ boardLoading: true }).loading).toBe(true); // 前提: 板だけの取得中でも loading(更新ボタン)は true
    expect(model().listLoading).toBe(false);
    expect(model({ list: { kind: "error", message: "失敗" } }).listLoading).toBe(false);
  });
});

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const classes = (n: VNode): string[] => String(n.attrs?.["class"] ?? "").split(" ");
const byClass = (t: VNode, cls: string): VNode[] => findAll(t, (n) => classes(n).includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const tree = (over: Partial<ListModelInput> = {}): VNode => renderScreen(model(over), noopActions);

describe("一覧の画面: 最終更新の行と読み込み中の本文(Issue #572)", () => {
  it("p.list-updated が controls の直後(画面の 2 番目の子)にあり、絞り込みの塊(.list-filters)の外にある", () => {
    const t = tree();
    expect(classes(t.children![0] as VNode)).toContain("controls"); // 前提
    const line = t.children![1] as VNode;
    expect(line.tag).toBe("p");
    expect(classes(line)).toContain("list-updated");
    expect(textOf(line)).toBe("最終更新 09:48");
    expect(byClass(byClass(t, "list-filters")[0]!, "list-updated")).toHaveLength(0);
    expect(byClass(t, "list-updated")).toHaveLength(1);
  });

  it("「次に発走するレース」のカードがあるときは、最終更新の行の次にカードが来る", () => {
    const t = tree({ list: { kind: "ready", races: [race(1)] } });
    expect(model().next).toHaveLength(1); // 前提: カードが出る(10:00 の時点で 12:00 発走)
    expect(classes(t.children![1] as VNode)).toContain("list-updated");
    expect(classes(t.children![2] as VNode)).toContain("next-races");
  });

  it("文言が null のときは行を出さない(読み込み中・失敗・updatedAt なし)", () => {
    expect(byClass(tree({ updatedAt: null }), "list-updated")).toHaveLength(0);
    expect(byClass(tree({ list: { kind: "loading" } }), "list-updated")).toHaveLength(0);
    expect(byClass(tree({ list: { kind: "error", message: "失敗" } }), "list-updated")).toHaveLength(0);
  });

  it("一覧が読み込み中のときだけ、本文に p.empty『読み込み中…』を出す(開催なしの文言は出さない)", () => {
    const loading = tree({ list: { kind: "loading" } });
    const empties = byClass(loading, "empty");
    expect(empties).toHaveLength(1);
    expect(textOf(empties[0]!)).toBe("読み込み中…");
    expect(empties[0]!.tag).toBe("p");
    // 取得済み・板だけの取得中・失敗・空では出さない
    expect(byClass(tree(), "empty")).toHaveLength(0);
    expect(byClass(tree({ boardLoading: true }), "empty")).toHaveLength(0);
    expect(byClass(tree({ list: { kind: "error", message: "失敗" } }), "empty")).toHaveLength(0);
    const empty = byClass(tree({ list: { kind: "ready", races: [] } }), "empty");
    expect(empty).toHaveLength(1);
    expect(textOf(empty[0]!)).toBe("この日・この区分の開催はありません。");
  });
});
