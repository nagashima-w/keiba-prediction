import { describe, expect, it } from "vitest";
import { renderCheckPage, renderPage } from "../src/page";
import { CLIENT_JS } from "../src/client-bundle.generated";
import { ICON_PATHS } from "../src/icons";
import { requiredRole } from "../src/route-policy";

/**
 * Issue #191: web 画面の名前は「Uma Driller」(exe の名前は変えない。#190)。
 * スマホ画面(`GET /`)の `<title>`・`<h1>` と、確認ページ(`GET /check`)の見出し。見出しはトップ(一覧の画面)へのリンク(`<a href="#">`)。
 */
const EMAIL = "owner@example.com";

const titleOf = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
const h1Of = (html: string): string => /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";

/** `<style>` の中身(CSS のコメントを除く)。 */
const cssOf = (html: string): string => (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
/** CSS の規則の頭(`{` の前のセレクタの並び)を、カンマで分けて 1 つずつ返す(`@media` の中の規則も含む。本体〈`{ … }` の中〉は含まない)。 */
const selectorsOf = (css: string): string[] => [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()).filter((x) => x !== ""));

describe("スマホ画面(renderPage)の名前と見出しのリンク", () => {
  const html = renderPage(EMAIL, "admin");

  it("<title> は「Uma Driller」", () => {
    expect(titleOf(html)).toBe("Uma Driller");
  });

  it("<h1> は1つだけで、中身は href が # だけのリンク(押すとトップ=一覧の画面に戻る)。リンクの文字は「Uma Driller」(Issue #244 以降は、文字の前に装飾の画像が1つ入る)", () => {
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    const withoutLogo = h1Of(html).replace(/<img\b[^>]*>/g, "");
    expect(withoutLogo).toBe('<a class="home" href="#">Uma Driller</a>');
  });

  it("旧い名前(競馬期待値ツール)は残っていない", () => {
    expect(html).not.toContain("競馬期待値ツール");
  });

  it("リンクはタップしやすい大きさ(44px 以上)にする。リンクの見た目(下線・色)は CSS で決める", () => {
    expect(html).toMatch(/\.home\s*\{[^}]*min-height:\s*44px/);
  });

  it("Issue #189: 設定の入口のリンク・入力欄・保存ボタンは、タップしやすい大きさ(44px 以上)。エラーの強調は色だけでなく太さ(border-width)も変える", () => {
    expect(html).toMatch(/\.settings-link\s*\{[^}]*min-height:\s*44px/);
    expect(html).toMatch(/\.field input\[type="text"\][^{]*\{[^}]*min-height:\s*44px/);
    expect(html).toMatch(/\.field-check\s*\{[^}]*min-height:\s*44px/);
    expect(html).toMatch(/\.field \[aria-invalid="true"\]\s*\{[^}]*border-width:\s*2px/);
    expect(html).toMatch(/\.settings-save\s*\{[^}]*width:\s*100%/);
  });

  it("Issue #201: プロンプトのプレビューは、開閉・反映のボタンが 44px 以上。文面は等幅・改行を保つ・折り返す。内側のスクロール(max-height・overflow)は付けない", () => {
    expect(html).toMatch(/\.preview-toggle\s*\{[^}]*min-height:\s*44px/);
    expect(html).toMatch(/\.preview-refresh\s*\{[^}]*min-height:\s*44px/);
    const rule = /\.prompt-preview\s*\{([^}]*)\}/.exec(html);
    expect(rule, "前提: .prompt-preview の規則がある").not.toBeNull();
    expect(rule![1]).toMatch(/font-family:[^;]*monospace/);
    expect(rule![1]).toMatch(/white-space:\s*pre-wrap/);
    expect(rule![1]).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule![1]).not.toMatch(/max-height|overflow:|overflow-y/);
  });

  it("CSP の対象になるものを足していない: インラインのスクリプトとイベント属性が無い。スクリプトは /app.js の1本だけ", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect((html.match(/<script\b/g) ?? []).length).toBe(1);
  });
});

describe("確認ページ(renderCheckPage)の名前", () => {
  const html = renderCheckPage(EMAIL);

  it("<title> と <h1> は「Uma Driller(確認ページ)」。旧い名前は残っていない", () => {
    expect(titleOf(html)).toBe("Uma Driller(確認ページ)");
    expect(h1Of(html)).toBe("Uma Driller(確認ページ)");
    expect(html).not.toContain("競馬期待値ツール");
  });

  it("確認フォームの中身(netkeiba の取得の確認)は変わっていない", () => {
    expect(html).toContain("netkeiba の取得の確認");
    expect(html).toContain('action="/api/netkeiba/check"');
  });
});

describe("Issue #238: 役割の印(サーバが画面に渡す。画面で隠すのは補助で、拒否はサーバ側)", () => {
  /**
   * Issue #246(#243 の【記録】): CSS に `.role` クラスのセレクタの規則が無い。旧版は HTML 全体に文字列 `.role` が無いこと(`.roles` などの無関係な CSS でも赤になる)を見ていた。
   * 新版は、コメントを除いた `<style>` の規則の頭(セレクタ)に、クラス `role`(直後が識別子の文字でない)があるかだけを見る。
   */
  const hasRoleSelector = (html: string): boolean => selectorsOf(cssOf(html)).some((sel) => /\.role(?![\w-])/.test(sel));

  it("Issue #246: hasRoleSelector は .role の規則の形だけを検出する(.roles・.role-x・コメント・規則の本体の文字列では反応しない)", () => {
    const page = (css: string): string => `<html><head><style>${css}</style></head></html>`;
    for (const css of [".role { color: red; }", ".who .role::before { content: 'x'; }", ".a, .role { margin: 0; }", ".role:hover { top: 0; }", "@media (min-width: 600px) { .role { top: 0; } }"]) {
      expect(hasRoleSelector(page(css)), css).toBe(true);
    }
    for (const css of [".roles { color: red; }", ".role-x { margin: 0; }", ".my-role { margin: 0; }", "/* .role は外した */ .a { margin: 0; }", '.a { content: ".role"; }']) {
      expect(hasRoleSelector(page(css)), css).toBe(false);
    }
    // 対照: 旧版の検査(文字列 `.role` を含むか)は、反応してほしくない例でも赤になる
    expect(page(".roles { color: red; }")).toContain(".role");
  });

  const roleOf = (html: string): string | undefined => /<div id="app"[^>]*\sdata-role="([^"]*)"/.exec(html)?.[1];

  it("管理者: #app に data-role=\"admin\"。「閲覧専用」の文言も .role の要素・CSS も出ない", () => {
    const html = renderPage(EMAIL, "admin");
    expect(roleOf(html)).toBe("admin");
    expect(html).not.toContain("閲覧専用");
    expect(html).not.toContain('class="role"');
    expect(hasRoleSelector(html)).toBe(false);
  });

  it("閲覧者: #app に data-role=\"viewer\"。Issue #243 以降は「閲覧専用」の文言も .role の要素・CSS も出ず、「ログイン中」の行はメールだけ", () => {
    const html = renderPage(EMAIL, "viewer");
    expect(roleOf(html)).toBe("viewer");
    expect(html).not.toContain("閲覧専用");
    expect(html).not.toContain('class="role"');
    expect(hasRoleSelector(html)).toBe(false);
    // 「ログイン中」の行は、管理者と同じ形(メールの span だけ)。メールの span(.who .email。表示名の書き換え先)は 1 つのまま
    expect(html).toMatch(/<p class="who">ログイン中: <span class="email">owner@example\.com<\/span><\/p>/);
    expect(html.match(/class="email"/g)).toHaveLength(1);
  });

  it("Issue #243: 管理者と閲覧者で、「ログイン中」の行(<p class=\"who\">…</p>)は同じ(役割の違いは data-role だけに出る)", () => {
    const whoOf = (html: string): string | undefined => /<p class="who">[^]*?<\/p>/.exec(html)?.[0];
    const admin = whoOf(renderPage(EMAIL, "admin"));
    const viewer = whoOf(renderPage(EMAIL, "viewer"));
    expect(admin).toBeDefined(); // 前提: 行が実際に取れている(取れなければ下の比較が undefined 同士で空振りする)
    expect(viewer).toBe(admin);
    expect(renderPage(EMAIL, "viewer")).not.toBe(renderPage(EMAIL, "admin")); // 前提: 役割で HTML 全体は変わる(data-role)
  });

  it("役割が admin でも viewer でもない値(型を破った呼び出し)は、閲覧者として描く(管理者の印を出さない)", () => {
    for (const bad of ["root", "ADMIN", "", undefined, null]) {
      const html = renderPage(EMAIL, bad as never);
      expect(roleOf(html), String(bad)).toBe("viewer");
      expect(html).not.toContain('data-role="admin"');
    }
  });

  it("役割の印は 1 つだけ(data-role を持つ要素は #app だけ)で、インラインのスクリプトは増えない", () => {
    for (const role of ["admin", "viewer"] as const) {
      const html = renderPage(EMAIL, role);
      expect(html.match(/data-role=/g)).toHaveLength(1);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    }
  });
});

/**
 * Issue #239: 色だけで状態を伝えない。文字のない所(通知の枠・カードのエラー文・警告)には、CSS の `::before` で記号を添える。
 * DOM・クライアントの束は変えない(CSS だけ)。バッジ(未実行・待ち・取得済み・完了・失敗)と「EVプラス」「印」は、もともと文字のラベルがあるので足さない。
 */
describe("Issue #239: 状態の記号(色だけに頼らない)", () => {
  const html = renderPage(EMAIL, "admin");
  /** `selector::before { content: "..." }` の content を返す(無ければ null)。 */
  const beforeContent = (selector: string): string | null => {
    const escaped = selector.replace(/[.\\[\]"=]/g, "\\$&");
    const rule = new RegExp(`${escaped}::before[^{}]*\\{([^}]*)\\}`).exec(html);
    return rule === null ? null : (/content:\s*"([^"]*)"/.exec(rule[1]!)?.[1] ?? null);
  };

  const EXPECTED: readonly (readonly [string, string])[] = [
    [".notice.error", "⚠ "],
    [".card-error", "⚠ "],
    [".notice.llm-usage-warn", "⚠ "],
    [".notice.ok", "✓ "],
    [".notice.wait", "… "],
  ];

  it.each(EXPECTED)("%s の先頭に記号「%s」を添える", (selector, symbol) => {
    expect(beforeContent(selector)).toBe(symbol);
  });

  it("記号は成功(✓)・警告/失敗(⚠)・待機(…)の3種で、成功と警告は別の記号", () => {
    expect(new Set(EXPECTED.map((e) => e[1]))).toEqual(new Set(["⚠ ", "✓ ", "… "]));
    expect(beforeContent(".notice.ok")).not.toBe(beforeContent(".notice.error"));
    expect(beforeContent(".notice.wait")).not.toBe(beforeContent(".notice.error"));
  });

  it("Issue #246 R3: ::before の規則は、意図した 5 つのセレクタ以外に無い(コメントを除いた <style> の全規則を走査する。:before の旧記法も数える)", () => {
    const beforeSelectors = (css: string): string[] =>
      selectorsOf(css)
        .filter((sel) => /::?before/.test(sel))
        .map((sel) => sel.replace(/::?before.*$/, ""))
        .sort();
    const found = beforeSelectors(cssOf(html));
    expect(found).toEqual(EXPECTED.map((e) => e[0]).sort());
    expect(found).toHaveLength(5);
    // 対照(検出が空振りでない): 余分な規則・旧記法・@media の中の規則・グループの中の規則は、見つかる
    const probe = `${cssOf(html)} .badge::before { content: "x"; } .tab:before { content: "y"; } @media (min-width: 600px) { .card::before { content: "z"; } } .a, .extra::before { content: "w"; }`;
    expect(beforeSelectors(probe)).toEqual([...found, ".badge", ".tab", ".card", ".extra"].sort());
    // コメントの中の ::before は数えない
    expect(beforeSelectors(cssOf('<style>/* .x::before { content: "q"; } */ .y { margin: 0; }</style>'))).toEqual([]);
  });

  it("記号を足す対象のクラスは、クライアントが実際に使っているクラス(CSS だけ足して、使われない状態を防ぐ)", () => {
    for (const name of ["card-error", "llm-usage-warn", "notice error"]) {
      expect(CLIENT_JS, name).toContain(name);
    }
  });
});

/**
 * Issue #244: アイコン。見出しの文字の横に画像(全体の絵 A)を置き、タブの favicon(「穴」だけの C)と apple-touch-icon を `<head>` で宣言する。
 *  - 画像は `/icons/…`(route-policy.ts の表で閲覧者にも開く)。CSP の `img-src 'self'` は handler.test.ts が固定している。
 *  - 色の直書きを足さない(palette.test.ts の R2 が `<style>` を走査する)。`<link>`・`<img>` の属性にも色は無い。
 *  - `/favicon.ico` は `<link>` に書かない(ブラウザが ICO を優先して PNG を使わなくなることがあるため)。配信だけして、`<link>` が効かない文脈の保険にする。
 */
describe("Issue #244: アイコン(favicon・見出しの画像)", () => {
  const roles = ["admin", "viewer"] as const;

  it.each(roles)("<head> の <link>(%s): rel=icon の PNG が 16×16 と 32×32 の 2 本、apple-touch-icon が 1 本。/favicon.ico は <link> に書かない", (role) => {
    const html = renderPage(EMAIL, role);
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)![1]!;
    const links = [...head.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
    expect(links).toEqual([
      '<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">',
      '<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    ]);
    expect(head).not.toContain("/favicon.ico");
  });

  it.each(roles)("見出しの <img>(%s): <h1> の中のリンクの中に 1 つ。装飾なので alt は空。幅と高さ(32)を指定。2x・3x の srcset", (role) => {
    const h1 = h1Of(renderPage(EMAIL, role));
    const imgs = [...h1.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs).toEqual(['<img class="logo" src="/icons/header-32.png" srcset="/icons/header-64.png 2x, /icons/header-96.png 3x" width="32" height="32" alt="">']);
    // リンクの中・文字の前
    expect(h1).toMatch(/^<a class="home" href="#"><img [^>]*>Uma Driller<\/a>$/);
  });

  it.each(roles)("ページが参照する画像(<link> の href・<img> の src・srcset の URL)はすべて、配る 7 本のどれかで、閲覧者(GET)に開いている(%s)", (role) => {
    const html = renderPage(EMAIL, role);
    const urls = new Set<string>();
    for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) urls.add(m[1]!);
    for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) urls.add(m[1]!);
    for (const m of html.matchAll(/\bsrcset="([^"]+)"/g)) for (const part of m[1]!.split(",")) urls.add(part.trim().split(/\s+/)[0]!);
    // 前提: 参照は 6 本(favicon 2 + apple-touch-icon 1 + 見出し 3)。/favicon.ico は参照しない
    expect(urls.size).toBe(6);
    for (const url of urls) {
      expect(ICON_PATHS, url).toContain(url);
      expect(requiredRole("GET", url), url).toBe("viewer");
    }
  });

  it("画像の大きさがレイアウトを動かさない: .logo は幅・高さ 32px で縮まない。リンクの高さ 44px は維持する", () => {
    const html = renderPage(EMAIL, "admin");
    const rule = /\.logo\s*\{([^}]*)\}/.exec(html);
    expect(rule, "前提: .logo の規則がある").not.toBeNull();
    expect(rule![1]).toMatch(/width:\s*32px/);
    expect(rule![1]).toMatch(/height:\s*32px/);
    expect(rule![1]).toMatch(/flex:\s*none|flex-shrink:\s*0/);
    expect(html).toMatch(/\.home\s*\{[^}]*min-height:\s*44px/);
  });

  it("確認ページ(/check)にはアイコンを付けない(管理者専用で、CSP も変えない)", () => {
    const html = renderCheckPage(EMAIL);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<img\b/);
  });
});
