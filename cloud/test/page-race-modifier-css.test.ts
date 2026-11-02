import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import type { TargetRace } from "../client/api-targets";
import { buildListModel } from "../client/list";
import { parseHash } from "../client/route";
import { buildTargetsModel } from "../client/targets-model";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { renderPage } from "../src/page";
import { WEB_DARK, WEB_LIGHT } from "../src/palette";
import { noopActions } from "./client-fakes";
import { contrastRatio } from "./color-science";

/**
 * Issue #346(レビューの【要修正】): レース行(`a.race`)に足す修飾のクラス(発走済み・見送り)の名前が、page.ts の既存の CSS の規則と衝突しないこと(静的な検査)。
 * 実際に起きた事故: 発走済みのクラスを `past` にしたところ、詳細カードの `ul.past`(`.prior, .past, .horse-list, … { margin: 8px 0 0; padding: 0 }`)の規則が
 * `.race { padding: 10px 12px }` と詳細度が同じで後ろにあるため勝ち、薄くした行だけ padding が 0 になった(一覧と、公開済みの #336 の狙い目)。
 * 守ること(クラス名は、実際に VNode に出ているものから集める=名前を書き換えても検査が追従する):
 *  - 修飾のクラス `x` は、CSS の中で `.race.x` の規則(セレクタ)の中にしか現れない(単独の `.x`・別の要素の `.x li` などに使われていない)。
 *  - その規則(`.race.x`)が指定するのは `color` だけ。
 * Issue #570: 薄く見せる方法を opacity から文字の色(`color: var(--muted)`)に変えた(opacity だと muted の文字のコントラスト比がライトで約 2.5・ダークで約 3.4 まで落ちて、WCAG の 4.5 を割るため)。
 * 発走済み・見送りの規則は、それぞれ `.race.started`・`.race.skipped` の 1 つずつ。バッジ(`.badges .badge.*`)は自前の `color` を持つので、行の色の影響を受けない。
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

function listTreeWithBoard(): VNode {
  const race = (n: number, startTime: string): RaceRow => ({ raceId: `2026020201${String(n).padStart(2, "0")}`, venueName: "福島", raceNumber: n, raceName: `R${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime });
  const route = parseHash("#date=20260628&venue=central", "20260628");
  const model = buildListModel({ route, list: { kind: "ready", races: [race(1, "10:00"), race(2, "15:00")] }, board: { kind: "ready", rows: [] }, now: NOW, choices: new Map([["福島#0", true]]) });
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
  /** 宣言(プロパティ → 値)。 */
  readonly values: ReadonlyMap<string, string>;
}
const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.trim()).filter((s) => s !== ""),
  properties: m[2]!.split(";").map((d) => d.split(":")[0]!.trim()).filter((p) => p !== ""),
  values: new Map(m[2]!.split(";").map((d) => d.trim()).filter((d) => d !== "").map((d): [string, string] => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()])),
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

  // Issue #570: 発走済み(started)・見送り(skipped)の行は、行の文字の色を muted にして薄く見せる(opacity は使わない)。
  // 色は継承なので、二重がけは起きない(opacity 版の `:not(.skipped)` は不要になった)。自前の色を持つ子(.race-detail〈muted〉・.t-left.soon〈wait〉・バッジ)はそれが勝つ。
  // 単独の `.x`・`ul.past` などとの衝突を防ぐ意図は、「`x` を含むセレクタはすべて `.race.` で始まる」で保つ。
  /** 修飾のクラスを含むセレクタの全部。 */
  const EXPECTED_SELECTORS: Readonly<Record<string, readonly string[]>> = { skipped: [".race.skipped"], started: [".race.started"] };

  it("前提: 修飾のクラスごとの期待するセレクタを決めてある(増えたら、この表と数を直す)", () => {
    expect([...modifiers].sort()).toEqual(Object.keys(EXPECTED_SELECTORS).sort());
  });

  it.each(modifiers)("修飾のクラス「%s」は、CSS では `.race.` で始まる決まった形のセレクタの中にしか現れない(単独の `.x`・別の要素の `.x li` などに使われていない)", (cls) => {
    const selectors = rules.flatMap((r) => r.selectors).filter((s) => mentions(s, cls));
    expect(selectors.length, `「.${cls}」を使う規則がある`).toBeGreaterThan(0);
    expect(selectors.filter((s) => !s.startsWith(".race."))).toEqual([]);
    expect([...selectors].sort()).toEqual([...EXPECTED_SELECTORS[cls]!].sort()); // 規則の形は決まった数だけ
  });

  it.each(modifiers)("修飾のクラス「%s」を含む規則が指定するのは color だけ(padding・margin・opacity などを足さない)", (cls) => {
    const own = rules.filter((r) => r.selectors.some((s) => mentions(s, cls)));
    expect(own.length).toBe(EXPECTED_SELECTORS[cls]!.length); // 規則ごとに 1 つのセレクタ(グループにしていない)
    for (const r of own) expect(r.properties).toEqual(["color"]);
  });

  /** 行のクラスに対して、CSS の `.race.X { color }` が決める行の文字色(CSS 変数の式)。何もかからなければ null(= `.race` の既定の fg)。 */
  const rowColor = (rowClasses: readonly string[]): string | null => {
    let color: string | null = null;
    for (const rule of rules) {
      const value = rule.values.get("color");
      if (value === undefined) continue;
      for (const sel of rule.selectors) {
        const m = /^\.race\.([\w-]+)$/.exec(sel);
        if (m !== null && rowClasses.includes(m[1]!)) color = value;
      }
    }
    return color;
  };
  const kidsOf = (n: VNode): VNode[] => (n.children ?? []).filter((c): c is VNode => typeof c !== "string");

  it("Issue #570 R1: 見送りだけ・発走済みだけ・両方の行の文字色は muted(二重にかからない。ふつうの行はかからない)。不透明度は変えない", () => {
    const list = raceRows(listTreeWithBoard());
    const targets = raceRows(targetsTree());
    const both = targets.filter((n) => classesOf(n).includes("skipped") && classesOf(n).includes("started"));
    const skippedOnly = targets.filter((n) => classesOf(n).includes("skipped") && !classesOf(n).includes("started"));
    const startedOnly = list.filter((n) => classesOf(n).includes("started"));
    const plain = list.filter((n) => !classesOf(n).includes("started") && !classesOf(n).includes("skipped"));
    // 前提: 4 種類の行が実際にある(両方付く行は狙い目の画面にだけ出る)
    expect(both.length).toBeGreaterThan(0);
    expect(skippedOnly.length).toBeGreaterThan(0);
    expect(startedOnly.length).toBeGreaterThan(0);
    expect(plain.length).toBeGreaterThan(0);
    for (const row of [...both, ...skippedOnly, ...startedOnly]) expect(rowColor(classesOf(row)), classesOf(row).join(" ")).toBe("var(--muted)");
    for (const row of plain) expect(rowColor(classesOf(row)), "ふつうの行").toBeNull();
    // 薄さは色だけ。行・子のどちらにも opacity はかからない
    expect(rules.filter((r) => r.selectors.some((s) => s.startsWith(".race."))).filter((r) => r.values.has("opacity"))).toEqual([]);
  });

  it("対照(検出が空振りでない): 発走済みの規則の色を変える/消すと、実効の色が変わる(rowColor が規則を見ている)", () => {
    const row = raceRows(listTreeWithBoard()).find((n) => classesOf(n).includes("started"))!;
    expect(rowColor(classesOf(row))).toBe("var(--muted)");
    const target = rules.find((r) => r.selectors.includes(".race.started"))!;
    const saved = target.values.get("color");
    try {
      (target.values as Map<string, string>).set("color", "var(--fg)");
      expect(rowColor(classesOf(row))).toBe("var(--fg)");
      (target.values as Map<string, string>).delete("color");
      expect(rowColor(classesOf(row))).toBeNull();
    } finally {
      (target.values as Map<string, string>).set("color", saved!);
    }
  });

  it("Issue #570: 薄い行の文字(muted)はライトでもダークでも card の上で 4.5 以上(opacity 版は約 2.5 / 約 3.4 で割っていた)", () => {
    for (const p of [WEB_LIGHT, WEB_DARK]) expect(contrastRatio(p.muted, p.card)).toBeGreaterThanOrEqual(4.5);
  });

  it("Issue #558・#570: バッジは発走済みでも薄くならない(行の直下に `.badges` が 1 つ、薄くなる側の子が 2 つ以上。バッジの tone は自前の color を持つので行の色が及ばない)", () => {
    const row2 = raceRows(listTreeWithBoard()).find((n) => classesOf(n).includes("started"))!;
    const kids2 = kidsOf(row2);
    expect(kids2.filter((k) => classesOf(k).includes("badges"))).toHaveLength(1); // 前提: .badges は行の直下に 1 つ
    expect(kids2.filter((k) => !classesOf(k).includes("badges")).length).toBeGreaterThanOrEqual(2); // 薄くする側(名前・詳細)が残る
    // `.badges .badge.{ok,wait,fail,none}` がそれぞれ自前の color を持つ(継承で行の muted にならない)
    for (const tone of ["ok", "wait", "fail", "none"]) {
      const own = rules.filter((r) => r.selectors.includes(`.badges .badge.${tone}`) && r.values.has("color"));
      expect(own.length, `.badges .badge.${tone} の color`).toBeGreaterThan(0);
    }
  });
});
