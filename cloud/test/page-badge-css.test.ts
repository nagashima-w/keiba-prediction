import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import { badgeOf, buildListModel } from "../client/list";
import { parseHash } from "../client/route";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { renderPage } from "../src/page";
import { WEB_DARK, WEB_LIGHT, type WebPalette } from "../src/palette";
import { noopActions } from "./client-fakes";
import { contrastRatio } from "./color-science";

/**
 * Issue #558: 一覧の分析の状態(「事前: 完了」など)をバッジ(ピル)にする。CSS の静的な検査。
 *  - 色だけに頼らない: 文字(ラベル)は VNode に残る(5 状態すべて)。
 *  - 暗い配色・明るい配色の両方で読める: 文字と背景の組が `palette.ts` の組(新しい色リテラルを足さない)で、コントラスト比 4.5 以上。
 *  - 一覧の中だけ(`.badges .badge`)。レース画面のタスクカードの `.badge` は変えない。
 *  - 発走済みの行でも読める: 行の薄さは文字の色(`color: var(--muted)`。Issue #570 で opacity から変えた)で、バッジは自前の色を持つので影響されない(page-race-modifier-css.test.ts)。ここでは、旧方式(行ごと opacity 0.65)だと基準を割ることを数値で示す。
 */

const MIN_CONTRAST = 4.5;
const css = ((): string => (/<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", "admin"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, ""))();
interface Rule {
  readonly selectors: string[];
  readonly decls: Map<string, string>;
}
const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.trim()).filter((s) => s !== ""),
  decls: new Map(
    m[2]!
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d !== "")
      .map((d): [string, string] => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  ),
}));
const ruleFor = (selector: string): Rule[] => rules.filter((r) => r.selectors.includes(selector));

const MODES: readonly (readonly [string, WebPalette])[] = [
  ["ライト", WEB_LIGHT],
  ["ダーク", WEB_DARK],
];
/** `var(--ok)` → 配色の色。それ以外(リテラル・transparent)は null。 */
function resolve(value: string | undefined, palette: WebPalette): string | null {
  const m = /^var\(--([a-z]+)\)$/.exec(value ?? "");
  return m === null ? null : ((palette as unknown as Record<string, string>)[m[1]!] ?? null);
}

const FILLED = ["ok", "wait", "fail"] as const;

describe("バッジの CSS(Issue #558): 一覧の `.badges .badge`", () => {
  it("前提: CSS を読めていて、ピルの基本の規則(丸み・余白)が 1 つある", () => {
    expect(rules.length).toBeGreaterThan(50);
    const base = ruleFor(".badges .badge");
    expect(base).toHaveLength(1);
    expect(base[0]!.decls.get("border-radius")).toBeDefined();
    expect(base[0]!.decls.get("padding")).toBeDefined();
  });

  it.each(FILLED)("%s: tone 色で塗り、文字は --bg(ピル)。新しい色を足さず palette の変数だけを使う", (tone) => {
    const found = ruleFor(`.badges .badge.${tone}`);
    expect(found).toHaveLength(1);
    expect(found[0]!.decls.get("background")).toBe(`var(--${tone})`);
    expect(found[0]!.decls.get("color")).toBe("var(--bg)");
  });

  it("未実行(none): 塗らず、--line の枠線と --muted の文字", () => {
    const found = ruleFor(".badges .badge.none");
    expect(found).toHaveLength(1);
    expect(found[0]!.decls.get("background")).toBe("transparent");
    expect(found[0]!.decls.get("border-color")).toBe("var(--line)");
    expect(found[0]!.decls.get("color")).toBe("var(--muted)");
  });

  describe.each(MODES)("%s: 文字と背景のコントラスト比が 4.5 以上", (_name, palette) => {
    it.each(FILLED)("%s(塗り=tone 色・文字=--bg)", (tone) => {
      const rule = ruleFor(`.badges .badge.${tone}`)[0]!;
      const fill = resolve(rule.decls.get("background"), palette);
      const text = resolve(rule.decls.get("color"), palette);
      expect(fill, "背景が palette の変数").not.toBeNull();
      expect(text, "文字が palette の変数").not.toBeNull();
      expect(contrastRatio(text!, fill!)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });

    it("none(文字=--muted。背景はカードまたはページ背景の上)", () => {
      const text = resolve(ruleFor(".badges .badge.none")[0]!.decls.get("color"), palette)!;
      expect(text).toBeTruthy();
      expect(contrastRatio(text, palette.card)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrastRatio(text, palette.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  });

  it("3 つの塗りは互いに別の変数(ok・wait・fail を同じ色にしていない)", () => {
    const fills = FILLED.map((t) => ruleFor(`.badges .badge.${t}`)[0]!.decls.get("background"));
    expect(new Set(fills).size).toBe(3);
  });

  it("塗り(background)を持つ `.badge` の規則は `.badges .badge` の中だけ(レース画面のタスクカードの `.badge` は変えない)", () => {
    const withBg = rules.filter((r) => r.selectors.some((s) => /\.badge(?![\w-])/.test(s)) && (r.decls.has("background") || r.decls.has("border-radius")));
    expect(withBg.length).toBeGreaterThan(0); // 前提: 検査対象がある
    for (const r of withBg) expect(r.selectors.filter((s) => !s.startsWith(".badges .badge"))).toEqual([]);
  });

  it("対照(検査が空振りでない): 旧方式の行ごと opacity 0.65 だと、ライトの ok・wait の文字は 4.5 を割る(だから opacity ではなく色で薄く見せ、バッジは薄くしない)", () => {
    const hex = (h: string, i: number): number => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
    const mix = (a: string, b: string, t: number): string => "#" + [0, 1, 2].map((i) => Math.round(hex(a, i) * t + hex(b, i) * (1 - t)).toString(16).padStart(2, "0")).join("");
    for (const tone of ["ok", "wait"] as const) {
      // 塗り=tone 色、文字=--bg を、ページ背景に 0.65 で重ねたときの比
      const dimmed = contrastRatio(mix(WEB_LIGHT.bg, WEB_LIGHT.bg, 0.65), mix(WEB_LIGHT[tone], WEB_LIGHT.bg, 0.65));
      expect(contrastRatio(WEB_LIGHT.bg, WEB_LIGHT[tone])).toBeGreaterThanOrEqual(MIN_CONTRAST); // 通常は基準を満たす
      expect(dimmed).toBeLessThan(MIN_CONTRAST);
    }
  });
});

describe("バッジの VNode(Issue #558): 色だけに頼らず文字を残す", () => {
  const DATE = "20260628";
  const NOW = new Date("2026-06-28T05:00:00Z");
  const race = (n: number): RaceRow => ({ raceId: `2026020201${String(n).padStart(2, "0")}`, venueName: "福島", raceNumber: n, raceName: `R${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: "15:00" });
  const board = (n: number, mode: "morning" | "pre_race", status: "queued" | "fetched" | "done" | "failed") => ({ raceId: race(n).raceId, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null });
  const findAll = (node: VNode | string, pred: (n: VNode) => boolean): VNode[] => (typeof node === "string" ? [] : [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))]);
  const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));

  it("5 状態(未実行・待ち・取得済み・完了・失敗)がそれぞれ `badge (tone)` のクラスと「前置き: ラベル」の文字を持つ", () => {
    const rows = [board(1, "morning", "queued"), board(1, "pre_race", "fetched"), board(2, "morning", "done"), board(2, "pre_race", "failed")];
    const model = buildListModel({ route: parseHash(`#date=${DATE}&venue=central`, DATE), list: { kind: "ready", races: [race(1), race(2), race(3)] }, board: { kind: "ready", rows }, now: NOW, choices: new Map([["福島#0", true]]) });
    const tree = renderScreen(model, noopActions);
    // 一覧のレース行(`ul.races` の下)のバッジだけを見る。先頭の「次に発走するレース」のカード(Issue #559)のバッジは数えない(カードの検査は client-view-list-next.test.ts)。
    const isBadge = (n: VNode): boolean => n.tag === "span" && String(n.attrs?.["class"] ?? "").split(" ").includes("badge");
    const badges = findAll(tree, (n) => n.tag === "ul" && String(n.attrs?.["class"] ?? "").split(" ").includes("races")).flatMap((ul) => findAll(ul, isBadge));
    expect(badges).toHaveLength(6); // 3 レース × 2
    // 対照: カードは実際に出ていて(前提)、木全体で数えると 6 + カードの 3 件になる(絞らないと 6 にならない)
    expect(findAll(tree, isBadge)).toHaveLength(9);
    // カードを出さない状態(now なし)でも、絞った数・木全体の数とも 6 のまま(絞り込みで結果が変わらない)
    const noCard = renderScreen(buildListModel({ route: parseHash(`#date=${DATE}&venue=central`, DATE), list: { kind: "ready", races: [race(1), race(2), race(3)] }, board: { kind: "ready", rows }, choices: new Map([["福島#0", true]]) }), noopActions);
    expect(findAll(noCard, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes("next-races"))).toHaveLength(0);
    expect(findAll(noCard, isBadge)).toHaveLength(6);
    expect(findAll(noCard, (n) => n.tag === "ul" && String(n.attrs?.["class"] ?? "").split(" ").includes("races")).flatMap((ul) => findAll(ul, isBadge))).toHaveLength(6);
    const got = badges.map((b) => [String(b.attrs?.["class"]), textOf(b)]);
    expect(got).toEqual([
      ["badge wait", "事前: 待ち"],
      ["badge wait", "発走前: 取得済み"],
      ["badge ok", "事前: 完了"],
      ["badge fail", "発走前: 失敗"],
      ["badge none", "事前: 未実行"],
      ["badge none", "発走前: 未実行"],
    ]);
    // tone は 4 種すべて(CSS の規則が 4 つ要る)
    expect(new Set(got.map((g) => g[0]!.split(" ")[1]))).toEqual(new Set(["wait", "ok", "fail", "none"]));
    expect(badgeOf(undefined).tone).toBe("none");
  });
});
