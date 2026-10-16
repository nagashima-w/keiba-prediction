/**
 * Discord の embed に載せる「外から来た文字列」の無害化(Issue #301)のテスト。
 *
 * 守りたいこと:
 *  - マスクドリンク `[文字](URL)` が描画されない(`[` `]` の escape で成立しなくなる)
 *  - マークダウンの書式記号・行頭の見出し/リスト/引用が効かない
 *  - 普通の文字列(日本語・数字・全角の記号・ASCII の括弧など)は変わらない
 */

import { describe, expect, it } from "vitest";

import { dropDanglingBackslash, escapeDiscordMarkdown } from "../../src/notify/discord-escape.js";

describe("escapeDiscordMarkdown(記号の escape)", () => {
  it.each([
    ["バックスラッシュ", "a\\b", "a\\\\b"],
    ["アスタリスク(太字・斜体)", "a*b*", "a\\*b\\*"],
    ["アンダースコア(下線・斜体)", "a_b_", "a\\_b\\_"],
    ["チルダ(取り消し線)", "a~~b~~", "a\\~\\~b\\~\\~"],
    ["縦棒(スポイラー)", "a||b||", "a\\|\\|b\\|\\|"],
    ["バッククォート(コード)", "a`b`", "a\\`b\\`"],
    ["大なり(引用)", "a>b", "a\\>b"],
    ["角括弧(マスクドリンク)", "[a]", "\\[a\\]"],
    ["小なり(メンション・絵文字・自動リンクの囲み)", "<@123>", "\\<@123\\>"],
  ] as const)("%s", (_name, input, expected) => {
    expect(escapeDiscordMarkdown(input)).toBe(expected);
  });

  it("マスクドリンク `[文字](URL)` は、`[` と `]` が escape されて成立しない(丸括弧は escape しない)", () => {
    const out = escapeDiscordMarkdown("[ここを押す](https://evil.example/login)");
    expect(out).toBe("\\[ここを押す\\](https://evil.example/login)");
    // escape の対(バックスラッシュ + 記号)を取り除くと、素の `[` `]` が 1 つも残らない(= リンクの文法が成立しない)
    expect(out.replace(/\\[[\]]/g, "")).not.toMatch(/[[\]]/);
  });

  it("丸括弧は escape しない(レース名の『(G1)』などが `\\(` と見えないように)", () => {
    expect(escapeDiscordMarkdown("ジャパンC(G1) (a)")).toBe("ジャパンC(G1) (a)");
  });
});

describe("escapeDiscordMarkdown(行頭の規則)", () => {
  it.each([
    ["見出し # ", "# 見出し", "\\# 見出し"],
    ["見出し ## ", "## 見出し", "\\## 見出し"],
    ["見出し ### ", "### 見出し", "\\### 見出し"],
    ["リスト - ", "- 項目", "\\- 項目"],
    ["小さな文字 -# ", "-# 小さい", "\\-# 小さい"],
    ["番号付きリスト 1. ", "1. 項目", "1\\. 項目"],
    ["番号付きリスト 12. ", "12. 項目", "12\\. 項目"],
    ["先頭に空白があっても効く見出し", "  # 見出し", "  \\# 見出し"],
    ["先頭に空白があっても効く番号付きリスト(インデントを保つ)", "  1. a", "  1\\. a"],
    ["引用 > は行頭に限らず escape する", "> 引用", "\\> 引用"],
  ] as const)("%s", (_name, input, expected) => {
    expect(escapeDiscordMarkdown(input)).toBe(expected);
  });

  it("2 行目以降の行頭にも効く(改行をまたぐ)", () => {
    expect(escapeDiscordMarkdown("本文\n# 見出し\n- 項目\n1. 番号")).toBe("本文\n\\# 見出し\n\\- 項目\n1\\. 番号");
  });

  it("行頭でなければ変えない(行の途中の # - 数字. は書式にならない)", () => {
    expect(escapeDiscordMarkdown("3番 #5 - 1.5倍 ABC-1")).toBe("3番 #5 - 1.5倍 ABC-1");
  });

  it("後ろが空白でない行頭の # - 数字. も変えない(書式にならない: #1番人気 -5% 1.5倍)", () => {
    expect(escapeDiscordMarkdown("#1番人気\n-5%\n1.5倍")).toBe("#1番人気\n-5%\n1.5倍");
  });

  it("# が 4 個以上は見出しにならないので変えない", () => {
    expect(escapeDiscordMarkdown("#### x")).toBe("#### x");
  });
});

describe("escapeDiscordMarkdown(普通の文字列は変えない)", () => {
  it.each([
    ["空文字", ""],
    ["日本語の文", "本日の回収率は80%でした。次回は見送りを増やします。"],
    ["数字", "1234567890"],
    ["全角の括弧・記号", "(黒字)・「見送り」…〜※"],
    ["馬名の例", "ディープインパクト"],
    ["ASCII の括弧とスラッシュ・コロン・ピリオド", "A.P. Indy (USA) 1/2 10:30"],
    ["平文の URL(リンク先は見えるので偽装にならない。そのまま)", "https://example.com/a?b=c&d=e"],
    ["@ はメンション制御(allowed_mentions)に任せる", "@everyone"],
  ] as const)("%s", (_name, input) => {
    expect(escapeDiscordMarkdown(input)).toBe(input);
  });
});

describe("dropDanglingBackslash(切り詰めで escape の対を割らない)", () => {
  it.each([
    ["バックスラッシュが無い", "abc", "abc"],
    ["末尾が通常文字", "a\\*b", "a\\*b"],
    ["末尾が単独の \\(escape の前半だけが残った)", "abc\\", "abc"],
    ["末尾が \\\\(escape 済みのバックスラッシュ)は対が完結しているので残す", "abc\\\\", "abc\\\\"],
    ["末尾が \\\\\\(3 個: 対 + 孤立)は孤立の 1 個だけ落とす", "abc\\\\\\", "abc\\\\"],
    ["空文字", "", ""],
    ["\\ だけ", "\\", ""],
  ] as const)("%s", (_name, input, expected) => {
    expect(dropDanglingBackslash(input)).toBe(expected);
  });
});
