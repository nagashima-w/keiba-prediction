import { describe, expect, it } from "vitest";
import { parseExperiments } from "../cloudflare-spike/experiments.js";

/**
 * #160 実験の選択(`SPIKE_EXPERIMENTS`)の解釈。フェイルクローズ: 未設定・空・未知のトークンはエラーにし、
 * 誤って全実験を走らせない。netkeiba へ出る実験(`reachability`〈#159 の10本〉・`origin`〈#160 の6本〉・
 * `socket-matrix`〈#162 の9本〉)は、1回の実行の netkeiba への合計 10 本以内の守りのため、どの2つも同時に選べない。
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
    ["socket-matrix", ["socket-matrix"]],
    ["socket-matrix,cpu", ["socket-matrix", "cpu"]],
    ["cpu,socket-matrix", ["socket-matrix", "cpu"]],
    [" socket-matrix , cpu ", ["socket-matrix", "cpu"]],
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
    ["socket-matrix の綴り違い", "socket_matrix", /socket_matrix/],
    ["socket-matrix の大文字", "Socket-Matrix", /Socket-Matrix/],
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

describe("parseExperiments: netkeiba へ出る実験の同時指定(#162)", () => {
  it.each([
    ["socket-matrix,origin"],
    ["origin,socket-matrix"],
    ["socket-matrix,reachability"],
    ["reachability,socket-matrix"],
    ["socket-matrix,origin,cpu"],
    ["reachability,origin,socket-matrix"],
  ])("%s は拒否する(合計が 10 本を超える。3つの組はどの2つも選べない)", (value) => {
    const r = parseExperiments(value);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/10/);
      expect(r.error).toMatch(/socket-matrix/);
    }
  });

  it("選んだ名前だけをエラーに挙げる(選んでいない実験を、衝突の相手として挙げない)", () => {
    const r = parseExperiments("socket-matrix,origin");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/origin/);
      expect(r.error).not.toMatch(/reachability/);
    }
  });

  it("socket-matrix は cpu とは同時に選べる(cpu は netkeiba へ出ない)", () => {
    expect(parseExperiments("socket-matrix,cpu")).toEqual({ ok: true, experiments: ["socket-matrix", "cpu"] });
  });

  it("実行の順は、netkeiba に出る実験が先で、cpu が最後", () => {
    const r = parseExperiments("cpu,socket-matrix");
    expect(r.ok && r.experiments[r.experiments.length - 1]).toBe("cpu");
  });
});
