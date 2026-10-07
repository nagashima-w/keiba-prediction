import { describe, expect, it } from "vitest";
import { renderCheckPage, renderPage } from "../src/page";

/**
 * Issue #191: web 画面の名前は「Uma Driller」(exe の名前は変えない。#190)。
 * スマホ画面(`GET /`)の `<title>`・`<h1>` と、確認ページ(`GET /check`)の見出し。見出しはトップ(一覧の画面)へのリンク(`<a href="#">`)。
 */
const EMAIL = "owner@example.com";

const titleOf = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
const h1Of = (html: string): string => /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";

describe("スマホ画面(renderPage)の名前と見出しのリンク", () => {
  const html = renderPage(EMAIL);

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
