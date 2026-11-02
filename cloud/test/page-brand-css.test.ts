import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page";
import { WEB_DARK, WEB_LIGHT } from "../src/palette";
import { contrastRatio } from "./color-science";

/**
 * Issue #570: 画面の見た目を整える(CSS の静的な検査)。
 *  1. 主要なボタン(`.run`・`.bulk-go`・`.settings-save`・`.report-run`)は、有効のときだけ brand(ロゴのオレンジ)の塗りに --bg の文字。
 *     無効のときは塗りをやめ、ほかのボタンと同じ card の背景・muted の文字・line の枠(opacity 1)に戻す(有効か無効かが色で見分けられ、無効でも文字が 4.5 以上)。
 *  2. 選んでいる状態(タブ・検証画面の切替)と EV プラスの強調は brand。リンクの色(--accent)は変えない。
 *  3. opacity で文字を薄くしない(WCAG の対象になる文字のコントラストを割るため)。薄くする規則は押せないボタン(`button[disabled]`)だけ。
 *  4. 「ログイン中」は見出しと同じ行の右端に小さく出す(`.head` の中に h1 と p.who。セレクタ `.who .email` は変えない)。
 * 色の組のコントラスト比は palette.test.ts。ここでは「その組を使う規則が書いてあること」を固定する。
 */

const html = renderPage("owner@example.com", "admin");
const css = ((): string => (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, ""))();
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

/** セレクタが完全に一致する規則(グループの一部でもよい)を、書かれた順に集めて、宣言を後ろの勝ちで重ねたもの。 */
function declsOf(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) if (r.selectors.includes(selector)) for (const [k, v] of r.decls) out.set(k, v);
  return out;
}
const countRules = (selector: string): number => rules.filter((r) => r.selectors.includes(selector)).length;

const PRIMARY = [".run", ".bulk-go", ".settings-save", ".report-run"] as const;

describe("Issue #570: 主要なボタンは有効のとき brand の塗り", () => {
  it("前提: CSS を読めている", () => {
    expect(rules.length).toBeGreaterThan(50);
  });

  it.each(PRIMARY)("%s: 背景と枠が --brand、文字が --bg(palette.test が bg の文字 on brand を 4.5 以上に固定)、太字", (selector) => {
    expect(countRules(selector), `${selector} の規則がある`).toBeGreaterThan(0);
    const d = declsOf(selector);
    expect(d.get("background")).toBe("var(--brand)");
    expect(d.get("border-color")).toBe("var(--brand)");
    expect(d.get("color")).toBe("var(--bg)");
    expect(d.get("font-weight")).toBe("bold");
  });

  it.each(PRIMARY)("%s[disabled]: 塗りをやめ、card の背景・muted の文字・line の枠、opacity 1(押せるかが色で分かる。無効でも文字は 4.5 以上)", (selector) => {
    expect(countRules(`${selector}[disabled]`), `${selector}[disabled] の規則がある`).toBeGreaterThan(0);
    const d = declsOf(`${selector}[disabled]`);
    expect(d.get("background")).toBe("var(--card)");
    expect(d.get("border-color")).toBe("var(--line)");
    expect(d.get("color")).toBe("var(--muted)");
    expect(d.get("opacity")).toBe("1");
  });

  it("無効のときの文字(muted)と背景(card)は、ライトでもダークでも 4.5 以上(上の規則が使う組)", () => {
    for (const p of [WEB_LIGHT, WEB_DARK]) expect(contrastRatio(p.muted, p.card)).toBeGreaterThanOrEqual(4.5);
  });

  it("主要でないボタン(更新・戻る・開閉・一括実行の開始・再生成の確定)の規則は塗りにしない(brand を使う規則は主要な 4 つとその無効だけ)", () => {
    const allowed = new Set<string>([...PRIMARY]);
    const users = rules.filter((r) => [...r.decls.values()].some((v) => v.includes("var(--brand)") && v !== "var(--bg)"));
    const buttonSelectors = users.flatMap((r) => r.selectors).filter((s) => /button|\.run|\.bulk|\.settings-save|\.report-(run|regen)/.test(s));
    expect(buttonSelectors.length).toBeGreaterThan(0); // 前提: 主要なボタンの規則が見つかっている
    for (const s of buttonSelectors) expect(allowed.has(s), s).toBe(true);
  });

  it("押せないボタン全般(button[disabled])の薄さは、そのまま残る(opacity 0.6)", () => {
    expect(declsOf("button[disabled]").get("opacity")).toBe("0.6");
  });
});

describe("Issue #570: 選んでいる状態と EV プラスは brand。リンクの色(accent)は変えない", () => {
  const SELECTED = [".tab[aria-current=\"page\"]", ".report-tab[aria-current=\"page\"]", ".verify-venue[aria-pressed=\"true\"]", ".verify-target[aria-pressed=\"true\"]"] as const;

  it.each(SELECTED)("%s: 枠と文字が --brand、太字(色だけに頼らない=太字)", (selector) => {
    expect(countRules(selector), `${selector} の規則がある`).toBeGreaterThan(0);
    const d = declsOf(selector);
    expect(d.get("border-color")).toBe("var(--brand)");
    expect(d.get("color")).toBe("var(--brand)");
    expect(d.get("font-weight")).toBe("bold");
  });

  it("EV プラス: 馬カードの「EVプラス」(.ev-plus)・馬ごとの評価の表の「EVプラス」(.ev-table-plus)の文字と、EV プラスの馬カードの枠(.horse.positive)が --brand", () => {
    expect(declsOf(".ev-plus").get("color")).toBe("var(--brand)");
    expect(declsOf(".horse-table .ev-table-plus").get("color")).toBe("var(--brand)");
    expect(declsOf(".horse.positive").get("border-color")).toBe("var(--brand)");
  });

  it("brand の文字は card・bg の上で読める(ライト・ダーク)", () => {
    for (const p of [WEB_LIGHT, WEB_DARK]) for (const surface of [p.bg, p.card]) expect(contrastRatio(p.brand, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("リンクの色は accent のまま(戻る・過去の分析・日報の日付・版別比較へのリンク)。版別比較のリンクは既定のリンク色をやめて accent にした", () => {
    for (const selector of [".back", ".past-link", ".report-day-link", ".verify-versions-link"]) {
      expect(declsOf(selector).get("color"), selector).toBe("var(--accent)");
    }
  });

  it("accent の枠が残るのは、回収率のタイル(.verify-tile.strong)と◎のチップ(.formation-chip.formation-main)だけ(選んでいる状態は brand に移した)", () => {
    const withAccentBorder = rules.filter((r) => [...r.decls].some(([k, v]) => k.startsWith("border") && v.includes("var(--accent)"))).flatMap((r) => r.selectors);
    expect(withAccentBorder.sort()).toEqual([".formation-chip.formation-main", ".verify-tile.strong"]);
  });
});

describe("Issue #570: opacity で文字を薄くしない", () => {
  it("opacity が 1 未満の規則は、押せないボタン全般(button[disabled])だけ", () => {
    const dimming = rules.filter((r) => Number(r.decls.get("opacity") ?? "1") < 1).flatMap((r) => r.selectors);
    expect(rules.some((r) => r.decls.has("opacity"))).toBe(true); // 前提: opacity の規則が実際にある(検査が空振りでない)
    expect(dimming).toEqual(["button[disabled]"]);
  });

  it("opacity を持つ規則は、button[disabled] と主要なボタンの無効(opacity 1)だけ", () => {
    const all = rules.filter((r) => r.decls.has("opacity")).flatMap((r) => r.selectors).sort();
    expect(all).toEqual(["button[disabled]", ...PRIMARY.map((s) => `${s}[disabled]`)].sort());
  });
});

describe("Issue #570: 「ログイン中」を見出しと同じ行の右端に小さく出す", () => {
  it("HTML: <div class=\"head\"> の中に、h1 と p.who がこの順で入る(p.who の中身と .who .email のセレクタは変えない)", () => {
    expect(html).toMatch(/<div class="head">\s*<h1>[\s\S]*?<\/h1>\s*<p class="who">ログイン中: <span class="email">owner@example\.com<\/span><\/p>\s*<\/div>/);
    expect(html.match(/class="head"/g)).toHaveLength(1);
    expect(html.match(/class="who"/g)).toHaveLength(1);
  });

  it(".head: 横に並べ、狭い幅では折り返す。右端寄せ・小さな文字・muted は .who", () => {
    const head = declsOf(".head");
    expect(head.get("display")).toBe("flex");
    expect(head.get("flex-wrap")).toBe("wrap");
    expect(head.get("align-items")).toBe("center");
    const who = declsOf(".who");
    expect(who.get("margin")).toBe("0 0 0 auto"); // 折り返した行でも右端に寄る
    expect(who.get("font-size")).toBe("0.75rem");
    expect(who.get("color")).toBe("var(--muted)");
    expect(who.get("min-width")).toBe("0");
  });

  it(".head の中の h1 は下の余白を持たない(見出しとログイン中の高さがそろう)。.home の高さ 44px は残る", () => {
    expect(declsOf(".head h1").get("margin")).toBe("0");
    expect(declsOf(".home").get("min-height")).toBe("44px");
  });
});
