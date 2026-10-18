import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import type { TargetRace } from "../client/api-targets";
import { buildListModel } from "../client/list";
import { parseHash } from "../client/route";
import { buildTargetsModel } from "../client/targets-model";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { renderPage } from "../src/page";
import { noopActions } from "./client-fakes";

/**
 * Issue #346(レビューの【要修正】): レース行(`a.race`)に足す修飾のクラス(発走済み・見送り)の名前が、page.ts の既存の CSS の規則と衝突しないこと(静的な検査)。
 * 実際に起きた事故: 発走済みのクラスを `past` にしたところ、詳細カードの `ul.past`(`.prior, .past, .horse-list, … { margin: 8px 0 0; padding: 0 }`)の規則が
 * `.race { padding: 10px 12px }` と詳細度が同じで後ろにあるため勝ち、薄くした行だけ padding が 0 になった(一覧と、公開済みの #336 の狙い目)。
 * 守ること(クラス名は、実際に VNode に出ているものから集める=名前を書き換えても検査が追従する):
 *  - 修飾のクラス `x` は、CSS の中で `.race.x` の規則(セレクタ)の中にしか現れない(単独の `.x`・別の要素の `.x li` などに使われていない)。
 *  - その規則(`.race.x`)が指定するのは `opacity` だけ。
 */

const NOW = new Date("2026-06-28T05:00:00Z"); // JST 14:00(開催日 20260628 の今日)
const NOW_MS = NOW.getTime();

const classesOf = (n: VNode): string[] => String(n.attrs?.["class"] ?? "").split(" ").filter((c) => c !== "");
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const raceRows = (tree: VNode): VNode[] => findAll(tree, (n) => n.tag === "a" && classesOf(n).includes("race"));

function listTree(): VNode {
  const race = (n: number, startTime: string): RaceRow => ({ raceId: `2026020201${String(n).padStart(2, "0")}`, venueName: "福島", raceNumber: n, raceName: `R${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime });
  const route = parseHash("#date=20260628&venue=central", "20260628");
  const model = buildListModel({ route, list: { kind: "ready", races: [race(1, "10:00"), race(2, "15:00")] }, board: { kind: "none" }, now: NOW, choices: new Map([["福島#0", true]]) });
  return renderScreen(model, noopActions);
}

function targetsTree(): VNode {
  const r = (n: number, startMs: number, skipped: boolean): TargetRace => ({ raceId: `2026050508${String(n).padStart(2, "0")}`, analysisId: n, startMs, startTime: "15:40", place: "東京11R", pick: "◎7", skipped, detail: "x", resultState: null, result: null });
  const data = { date: "20261017", nowMs: NOW_MS, summary: "s", ledger: null, races: [r(1, NOW_MS - 600_000, false), r(2, NOW_MS - 300_000, true), r(3, NOW_MS + 300_000, true), r(4, NOW_MS + 900_000, false)] };
  return renderScreen(buildTargetsModel({ date: "20261017", data, error: null, loading: false, nowMs: NOW_MS }), noopActions);
}

/** `<style>` の中身(コメントを除く)。 */
const css = ((): string => (/<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", "admin"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, ""))();
interface Rule {
  readonly selectors: string[];
  readonly properties: string[];
}
const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.trim()).filter((s) => s !== ""),
  properties: m[2]!.split(";").map((d) => d.split(":")[0]!.trim()).filter((p) => p !== ""),
}));
const mentions = (selector: string, cls: string): boolean => new RegExp(`\\.${cls}(?![\\w-])`).test(selector);

const modifiers = [...new Set([...raceRows(listTree()), ...raceRows(targetsTree())].flatMap(classesOf))].filter((c) => c !== "race").sort();

describe("レース行の修飾のクラスは、既存の CSS の規則と衝突しない(Issue #346)", () => {
  it("前提: 一覧と狙い目の行から、発走済み・見送りの修飾のクラスが集まっている(空振りにしない)", () => {
    const listClasses = raceRows(listTree()).map(classesOf);
    expect(listClasses.some((c) => c.length > 1), "一覧に、発走済みの修飾のクラスを持つ行がある").toBe(true);
    expect(modifiers).toContain("skipped");
    expect(modifiers.length).toBe(2); // 発走済みと見送りの 2 つ(増えたら、この検査の対象に入っていることを確認して数を直す)
    expect(rules.length).toBeGreaterThan(50); // CSS を読めている
  });

  it.each(modifiers)("修飾のクラス「%s」は、CSS では `.race.(そのクラス)` のセレクタの中にしか現れない", (cls) => {
    const selectors = rules.flatMap((r) => r.selectors).filter((s) => mentions(s, cls));
    expect(selectors.length, `「.${cls}」を使う規則がある`).toBeGreaterThan(0);
    expect(selectors.filter((s) => s !== `.race.${cls}`)).toEqual([]);
  });

  it.each(modifiers)("修飾のクラス「%s」の規則(`.race.(そのクラス)`)が指定するのは opacity だけ", (cls) => {
    const own = rules.filter((r) => r.selectors.includes(`.race.${cls}`));
    expect(own).toHaveLength(1);
    expect(own[0]!.properties).toEqual(["opacity"]);
  });
});
