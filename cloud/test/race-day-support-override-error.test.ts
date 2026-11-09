import { describe, expect, it } from "vitest";

import { OVERRIDE_ERROR_LOG_MAX_CHARS, overrideErrorLogger } from "../src/race-day-support";

/** Issue #680: 差し込み(JRA のオッズ)の例外を、ログ(onWarn)にだけ残す関数。 */
describe("overrideErrorLogger", () => {
  it("レース・券種・例外の名前と文面を 1 行で onWarn に出す", () => {
    const lines: string[] = [];
    overrideErrorLogger((m) => lines.push(m), "発走前の分析(202603020211)")({ kind: "wide", error: new TypeError("壊れた") });
    expect(lines).toEqual(["JRA のオッズを使えませんでした(発走前の分析(202603020211)・wide): TypeError: 壊れた"]);
  });

  it("Error でない値も出せる(名前は typeof)", () => {
    const lines: string[] = [];
    overrideErrorLogger((m) => lines.push(m), "x")({ kind: "winPlace", error: "文字列" });
    expect(lines[0]).toContain("string: 文字列");
  });

  it("長い文面は 300 字に切り詰める(前提: 元の行は 300 字を超える)", () => {
    const lines: string[] = [];
    const error = new Error("a".repeat(1000));
    overrideErrorLogger((m) => lines.push(m), "x")({ kind: "wide", error });
    expect(OVERRIDE_ERROR_LOG_MAX_CHARS).toBe(300);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBe(301); // 300 字 + 省略記号
    expect(lines[0]!.endsWith("…")).toBe(true);
    expect(lines[0]!.startsWith("JRA のオッズを使えませんでした(x・wide): Error: aaa")).toBe(true);
  });

  it("300 字ちょうどは切らない", () => {
    const lines: string[] = [];
    const head = "JRA のオッズを使えませんでした(x・wide): Error: ";
    overrideErrorLogger((m) => lines.push(m), "x")({ kind: "wide", error: new Error("b".repeat(300 - head.length)) });
    expect(lines[0]!.length).toBe(300);
    expect(lines[0]!.endsWith("…")).toBe(false);
  });
});
