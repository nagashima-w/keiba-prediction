import { describe, expect, it } from "vitest";
import { parseSmokeSelection } from "../smoke-select";

/**
 * Issue #762: スモーク(cloud/smoke.ts)の「流す設定の組を選ぶ」引数 `--only=A,B,...` の解釈。
 * 引数なしは全部(今までと同じ。手元の verify-all --full と ci.yml の cloud-verify はこれ)。
 * 不明な設定・空の指定・知らない引数は、何も流さずに通ってしまわないよう、例外にする。
 */
const KNOWN = ["A", "B", "C"] as const;

describe("parseSmokeSelection(Issue #762)", () => {
  it("引数なしは、知っている設定を全部選ぶ(今までと同じ)", () => {
    expect([...parseSmokeSelection([], KNOWN)].sort()).toEqual(["A", "B", "C"]);
  });

  it("--only=A,C は、その 2 つだけを選ぶ", () => {
    expect([...parseSmokeSelection(["--only=A,C"], KNOWN)].sort()).toEqual(["A", "C"]);
  });

  it("重複は 1 つにまとめ、前後の空白は無視する", () => {
    expect([...parseSmokeSelection(["--only=B, B ,A"], KNOWN)].sort()).toEqual(["A", "B"]);
  });

  it("pnpm が渡しうる `--` は読み飛ばす", () => {
    expect([...parseSmokeSelection(["--", "--only=B"], KNOWN)]).toEqual(["B"]);
  });

  it.each([
    ["不明な設定", ["--only=A,Z"]],
    ["空の指定", ["--only="]],
    ["区切りだけの指定", ["--only=,"]],
    ["--only が 2 回", ["--only=A", "--only=B"]],
    ["知らない引数", ["--skip=A"]],
    ["値のない --only", ["--only"]],
  ])("%s は例外にする(何も流さずに成功しない)", (_name, argv) => {
    expect(() => parseSmokeSelection(argv, KNOWN)).toThrow();
  });
});
