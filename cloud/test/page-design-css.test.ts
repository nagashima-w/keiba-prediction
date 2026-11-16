import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page";

/**
 * Issue #740: 競馬新聞風の見た目(DESIGN.md)の、機械で確かめられる決まりを CSS で固定する(静的な検査)。
 *  1. 箱をやめる: 角丸は円形のチップと見出しの画像だけ。影なし。`background: var(--card)` を持つ規則は、入力欄・表の強調行・プレビュー・押せないボタンだけ。
 *     箱だった規則(一覧のレース行・要約・通知・日報のレース・検証のタイルなど)は、四方を囲む枠線(`border: 1px solid …`)を持たない。
 *  2. 見出しは明朝系の 1 規則(h1・h2・h3・.title)、h2 は墨の帯(背景 --fg・文字 --bg)。
 *  3. タップ対象は高さ 44px 以上のまま(密にするのは表と行の中身)。
 *  4. 数字がそろう(tabular-nums)のは、表・数値の帯・金額・検証の行の値。
 * 色の組のコントラスト比は palette.test.ts。DESIGN.md との値の一致は design-md.test.ts。
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
function declsOf(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) if (r.selectors.includes(selector)) for (const [k, v] of r.decls) out.set(k, v);
  return out;
}
const selectorsWith = (prop: string, pred: (value: string) => boolean): string[] => rules.filter((r) => r.decls.has(prop) && pred(r.decls.get(prop)!)).flatMap((r) => r.selectors);

describe("Issue #740: 箱をやめる", () => {
  it("前提: CSS を読めている", () => {
    expect(rules.length).toBeGreaterThan(50);
  });

  it("角丸(border-radius)を持つ規則は、想定隊列のチップ(50%)と見出しの画像(.logo)だけ", () => {
    expect(selectorsWith("border-radius", () => true).sort()).toEqual([".formation-chip", ".logo"]);
    expect(declsOf(".formation-chip").get("border-radius")).toBe("50%");
  });

  it("影(box-shadow)を使わない", () => {
    expect(selectorsWith("box-shadow", () => true)).toEqual([]);
  });

  it("`background: var(--card)` を持つ規則は、入力欄・表の強調行・プロンプトのプレビュー・押せないボタンだけ", () => {
    const ALLOWED = new Set([
      'input[type="date"]', '.field input[type="text"]', ".field textarea", ".field select", ".prompt-preview", ".horse-table .eval-positive td", ".formation-chip",
      ".run[disabled]", ".bulk-go[disabled]", ".settings-save[disabled]", ".report-run[disabled]",
    ]);
    const found = selectorsWith("background", (v) => v === "var(--card)");
    expect(found.length, "前提: 許可リストの規則が実際にある").toBeGreaterThan(5);
    expect(found.filter((s) => !ALLOWED.has(s))).toEqual([]);
  });

  it("箱だった規則は、四方を囲む枠線(border: 1px solid …)も背景も持たない", () => {
    const BOXES = [".race", ".next-race", ".card", ".summary", ".notice", ".report-race", ".verify-version", ".bulk-panel", ".verify-tile", ".horse-table-wrap", ".formation-track", ".horse-detail"];
    for (const sel of BOXES) {
      const d = declsOf(sel);
      expect(d.size, `${sel} の規則がある`).toBeGreaterThan(0);
      expect(d.get("border") ?? "", sel).not.toMatch(/solid/);
      expect(d.get("background") ?? "", sel).not.toBe("var(--card)");
    }
  });
});

describe("Issue #740: 見出し", () => {
  it("h1・h2・h3・.title の書体は明朝系の 1 規則で、serif で終わる(端末に無ければゴシックに落ちる)", () => {
    const withFamily = rules.filter((r) => r.decls.has("font-family") && r.selectors.some((s) => ["h1", "h2", "h3", ".title"].includes(s)));
    expect(withFamily).toHaveLength(1);
    expect([...withFamily[0]!.selectors].sort()).toEqual([".title", "h1", "h2", "h3"]);
    expect(withFamily[0]!.decls.get("font-family")).toMatch(/Mincho|Serif/);
    expect(withFamily[0]!.decls.get("font-family")).toMatch(/serif$/);
  });

  it("h2 は墨の帯: 背景 --fg・文字 --bg", () => {
    const d = declsOf("h2");
    expect(d.get("background")).toBe("var(--fg)");
    expect(d.get("color")).toBe("var(--bg)");
  });
});

describe("Issue #740: タップ 44px と数字", () => {
  it.each(["button", ".tab", ".report-tab", 'input[type="date"]', ".settings-link", ".verify-link", ".targets-link", ".report-link", ".monthly-link", ".back", ".home", ".past-link", ".horse-toggle", ".horse-table .sort-button"])("%s は高さ 44px 以上", (sel) => {
    const found = rules.filter((r) => r.selectors.includes(sel) && r.decls.has("min-height")).map((r) => r.decls.get("min-height")!);
    expect(found.length, `${sel} に min-height がある`).toBeGreaterThan(0);
    expect(found[found.length - 1]).toMatch(/^(44|4[5-9]|[5-9][0-9])px$/);
  });

  it.each([".horse-table", ".verify-tile-value", ".report-money", ".verify-row-value", ".verify-stat-cell"])("%s は tabular-nums", (sel) => {
    expect(declsOf(sel).get("font-variant-numeric")).toBe("tabular-nums");
  });
});
