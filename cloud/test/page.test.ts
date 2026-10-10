import { describe, expect, it } from "vitest";
import { renderCheckPage, renderPage } from "../src/page";
import { CLIENT_JS } from "../src/client-bundle.generated";

/**
 * Issue #191: web 画面の名前は「Uma Driller」(exe の名前は変えない。#190)。
 * スマホ画面(`GET /`)の `<title>`・`<h1>` と、確認ページ(`GET /check`)の見出し。見出しはトップ(一覧の画面)へのリンク(`<a href="#">`)。
 */
const EMAIL = "owner@example.com";

const titleOf = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
const h1Of = (html: string): string => /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";

describe("スマホ画面(renderPage)の名前と見出しのリンク", () => {
  const html = renderPage(EMAIL, "admin");

  it("<title> は「Uma Driller」", () => {
    expect(titleOf(html)).toBe("Uma Driller");
  });

  it("<h1> は1つだけで、中身は href が # だけのリンク(押すとトップ=一覧の画面に戻る)。リンクの文字は「Uma Driller」", () => {
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(h1Of(html)).toBe('<a class="home" href="#">Uma Driller</a>');
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
  const roleOf = (html: string): string | undefined => /<div id="app"[^>]*\sdata-role="([^"]*)"/.exec(html)?.[1];

  it("管理者: #app に data-role=\"admin\"。「閲覧専用」の文言も .role の要素・CSS も出ない", () => {
    const html = renderPage(EMAIL, "admin");
    expect(roleOf(html)).toBe("admin");
    expect(html).not.toContain("閲覧専用");
    expect(html).not.toContain('class="role"');
    expect(html).not.toContain(".role");
  });

  it("閲覧者: #app に data-role=\"viewer\"。Issue #243 以降は「閲覧専用」の文言も .role の要素・CSS も出ず、「ログイン中」の行はメールだけ", () => {
    const html = renderPage(EMAIL, "viewer");
    expect(roleOf(html)).toBe("viewer");
    expect(html).not.toContain("閲覧専用");
    expect(html).not.toContain('class="role"');
    expect(html).not.toContain(".role");
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

  it("記号を足す対象のクラスは、クライアントが実際に使っているクラス(CSS だけ足して、使われない状態を防ぐ)", () => {
    for (const name of ["card-error", "llm-usage-warn", "notice error"]) {
      expect(CLIENT_JS, name).toContain(name);
    }
  });
});
