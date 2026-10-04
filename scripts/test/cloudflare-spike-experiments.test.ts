import { describe, expect, it } from "vitest";
import { parseExperiments } from "../cloudflare-spike/experiments.js";

/**
 * #160 実験の選択(`SPIKE_EXPERIMENTS`)の解釈。フェイルクローズ: 未設定・空・未知のトークンはエラーにし、
 * 誤って全実験を走らせない。`reachability`(#159 の10本)と `origin`(#160 の6本)は、1回の実行の
 * netkeiba への合計 10 本以内の守りのため、同時に選べない。
 */

describe("parseExperiments: 受理する指定", () => {
  it.each([
    ["origin", ["origin"]],
    ["reachability", ["reachability"]],
    ["cpu", ["cpu"]],
    ["origin,cpu", ["origin", "cpu"]],
    ["reachability,cpu", ["reachability", "cpu"]],
    [" origin , cpu ", ["origin", "cpu"]],
    ["cpu,origin", ["origin", "cpu"]],
    ["cpu,reachability", ["reachability", "cpu"]],
    ["origin,origin", ["origin"]],
  ])("%j → %j(正規の順に並べ、重複は除く)", (value, expected) => {
    expect(parseExperiments(value)).toEqual({ ok: true, experiments: expected });
  });
});

describe("parseExperiments: 拒否する指定(フェイルクローズ)", () => {
  it.each([
    ["未設定", undefined, /未設定|空/],
    ["空文字", "", /未設定|空/],
    ["空白だけ", "   ", /未設定|空/],
    ["未知のトークン", "origins", /origins/],
    ["未知のトークンが混じる", "origin,evil", /evil/],
    ["大文字(厳密に小文字だけを受ける)", "ORIGIN", /ORIGIN/],
    ["末尾のカンマ(空の要素)", "origin,", /空の要素/],
    ["先頭のカンマ", ",origin", /空の要素/],
    ["all(全部は選べない)", "all", /all/],
  ])("%s は拒否する", (_name, value, pattern) => {
    const r = parseExperiments(value);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(pattern);
    }
  });

  it("reachability と origin の同時指定は拒否する(netkeiba への合計が 10 本を超える)", () => {
    const r = parseExperiments("reachability,origin");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/10/);
      expect(r.error).toMatch(/reachability/);
      expect(r.error).toMatch(/origin/);
    }
  });

  it("順序を入れ替えても、reachability と origin の同時指定は拒否する", () => {
    expect(parseExperiments("origin,cpu,reachability").ok).toBe(false);
  });
});
