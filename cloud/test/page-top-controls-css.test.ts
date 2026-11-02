import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page";

/**
 * Issue #544(トップの上の並びに「月報」を足し、広い画面で 1 段に収める)。
 * 並び(開催日・中央/地方・更新・狙い目・検証・日報・月報・設定)の必要幅は、Chromium の実測で約 740px(46.25rem)。
 * `main` の幅が 40rem(640px)だと「設定」が 2 段目に落ちたので、50rem(800px。端末のフォント差の余裕 60px)に広げた。
 * ここでは「その規則が書いてあること」を固定する。実際に 1 段に収まる・横スクロールが無いことは、Chromium の 1,515px・1,280px・375px の幅のスクリーンショットと寸法で確かめた(Issue #544 のコメント)。
 */
const css = (/<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", "admin"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

/** セレクタ完全一致の規則の本体(`{ … }` の中)を全部返す。 */
function bodiesOf(selector: string, source: string = css): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]!);
}

describe("トップの上の並びの CSS(Issue #544)", () => {
  it("main の最大幅は 50rem(旧 40rem)。中央寄せ・min-width: 0 は今のまま", () => {
    const main = bodiesOf("main");
    expect(main).toHaveLength(1); // 前提: スマホ画面の main の規則がちょうど 1 つ(確認ページの 32rem は別の <style>)
    expect(main[0]).toMatch(/max-width:\s*50rem/);
    expect(main[0]).toMatch(/margin:\s*0 auto/);
    expect(main[0]).toMatch(/min-width:\s*0/);
    expect(css).not.toMatch(/max-width:\s*40rem/);
  });

  it("「月報」のリンク(monthly-link)は「日報」(report-link)と同じ 1 つの規則で、同じ見た目(高さ 44px・枠・角丸)になる", () => {
    const shared = bodiesOf(".report-link, .monthly-link");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatch(/min-height:\s*44px/);
    expect(shared[0]).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(shared[0]).toMatch(/border-radius:\s*8px/);
    // 右寄せ(margin-left: auto)は画面の移動の塊(.list-nav)が担う(Issue #560)。この規則自体は寄せない
    expect(shared[0]).not.toMatch(/margin-left/);
  });
});

/** `@media (max-width: …)` の中の規則の本体。ブロックは `{` の対応で切り出す(中に規則が複数ある)。 */
function mediaBlock(query: string): string | null {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}
const bodiesIn = (block: string, selector: string): string[] => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...block.matchAll(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]!);
};

const NARROW = "(max-width: 48.25rem)";
/** `@media` のブロックを除いた CSS(広い画面にも効く規則だけ)。 */
const outerCss = ((): string => {
  const block = mediaBlock(NARROW);
  return block === null ? css : css.replace(block, "");
})();

describe("トップの上の並びを 2 つの塊に分ける CSS(Issue #560)", () => {
  it("絞り込み(.list-filters)と画面の移動(.list-nav)は、どちらも flex・折り返し(1 つの規則)。画面の移動だけが右へ寄せる(margin-left: auto)", () => {
    const shared = bodiesOf(".list-filters, .list-nav", outerCss);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatch(/display:\s*flex/);
    expect(shared[0]).toMatch(/flex-wrap:\s*wrap/);
    expect(shared[0]).not.toMatch(/margin-left/); // 絞り込みは寄せない(共通の規則に margin-left を置かない)
    const nav = bodiesOf(".list-nav", outerCss);
    expect(nav).toHaveLength(1);
    expect(nav[0]).toMatch(/margin-left:\s*auto/);
  });

  it("5 つのリンクのどれも margin-left: auto を持たない(右寄せは塊が受け持つ。旧: 月報の直後の設定だけが右へ離れないよう戻す規則が 3 本あった)", () => {
    for (const cls of ["targets-link", "verify-link", "report-link", "monthly-link", "settings-link"]) {
      const rules = css.split("}").filter((r) => (r.split("{")[0] ?? "").split(",").some((s) => s.trim() === `.${cls}` || s.trim().endsWith(`+ .${cls}`)));
      expect(rules.length, `前提: .${cls} の規則がある`).toBeGreaterThan(0);
      expect(rules.join("}"), cls).not.toMatch(/margin-left/);
    }
    expect(css).not.toMatch(/\.(verify|targets|monthly)-link\s*\+\s*\.(verify|settings)-link/);
  });

  it("5 つのリンクの共通の見た目(高さ 44px・枠・角丸)は残る", () => {
    const rule = css.split("}").find((r) => (r.split("{")[0] ?? "").includes(".settings-link"));
    expect(rule).toBeDefined();
    expect(rule).toMatch(/min-height:\s*44px/);
    expect(rule).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(rule).toMatch(/border-radius:\s*8px/);
  });

  it("狭い画面(max-width: 48.25rem)では、画面の移動が幅いっぱいの専用の段になり、上に区切り線が入る。リンクは幅いっぱいに並び、文字の中では折り返さない", () => {
    const block = mediaBlock(NARROW);
    expect(block, "前提: @media がある").not.toBeNull();
    const nav = bodiesIn(block!, ".list-nav");
    expect(nav).toHaveLength(1);
    expect(nav[0]).toMatch(/flex:\s*1 1 100%|flex-basis:\s*100%/);
    expect(nav[0]).toMatch(/margin-left:\s*0/);
    expect(nav[0]).toMatch(/border-top:\s*1px solid var\(--line\)/);
    const links = bodiesIn(block!, ".list-nav a");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/flex:\s*1 1 auto/); // 内容の幅を基準に余りを均等に分ける(基準 0 だと折り返さず、極端に狭い幅で文字がはみ出す)
    expect(links[0]).toMatch(/white-space:\s*nowrap/);
    // 高さ(タップしやすさ)を狭い画面で下げない
    expect(block).not.toMatch(/min-height:\s*(?!44px)/);
  });

  it("広い画面の規則(@media の外)に区切り線・全幅の指定は無い(広い画面の見た目は従来どおり)", () => {
    const nav = bodiesOf(".list-nav", outerCss);
    expect(nav).toHaveLength(1); // 前提(空だと下の否定が自明に通る)
    expect(nav[0]).not.toMatch(/border-top|100%/);
    expect(bodiesOf(".list-nav a", outerCss)).toHaveLength(0);
  });
});
