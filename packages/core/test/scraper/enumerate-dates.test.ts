import { describe, expect, it } from "vitest";
import { InvalidIdError, parseKaisaiDate } from "../../src/scraper/ids.js";
import { enumerateDates } from "../../src/scraper/enumerate-dates.js";

describe("enumerateDates(期間内の開催日を列挙する純関数)", () => {
  it("from と to が同一日なら単日1件を返すこと", () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260710");
    expect(enumerateDates(from, to)).toEqual([from]);
  });

  it("from が to より後ろの日付ならエラーを投げること", () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260709");
    expect(() => enumerateDates(from, to)).toThrow(InvalidIdError);
  });

  it("月をまたぐ連続日を正しく列挙すること(20260131→20260201)", () => {
    const from = parseKaisaiDate("20260131");
    const to = parseKaisaiDate("20260201");
    expect(enumerateDates(from, to)).toEqual(["20260131", "20260201"]);
  });

  it("閏年の2月末(20240228→20240301)は0229を含む3件になること", () => {
    const from = parseKaisaiDate("20240228");
    const to = parseKaisaiDate("20240301");
    expect(enumerateDates(from, to)).toEqual([
      "20240228",
      "20240229",
      "20240301",
    ]);
  });

  it("非閏年の2月末(20260228→20260301)は0229を生成せず2件になること", () => {
    const from = parseKaisaiDate("20260228");
    const to = parseKaisaiDate("20260301");
    expect(enumerateDates(from, to)).toEqual(["20260228", "20260301"]);
  });

  it("年をまたぐ連続日を正しく列挙すること(20251231→20260101)", () => {
    const from = parseKaisaiDate("20251231");
    const to = parseKaisaiDate("20260101");
    expect(enumerateDates(from, to)).toEqual(["20251231", "20260101"]);
  });

  it("包含日数がちょうど181日ならエラーにならず181件返すこと", () => {
    // 2026-01-01から181日目(包含)は2026-06-30。
    const from = parseKaisaiDate("20260101");
    const to = parseKaisaiDate("20260630");
    const result = enumerateDates(from, to);
    expect(result).toHaveLength(181);
    expect(result[0]).toBe("20260101");
    expect(result[result.length - 1]).toBe("20260630");
  });

  it("包含日数が182日になるとエラーを投げること", () => {
    // 2026-01-01から182日目(包含)は2026-07-01。
    const from = parseKaisaiDate("20260101");
    const to = parseKaisaiDate("20260701");
    expect(() => enumerateDates(from, to)).toThrow(InvalidIdError);
  });

  it("不正フォーマットの入力は呼び出し側で parseKaisaiDate がエラーを投げること", () => {
    // enumerateDates 自体は KaisaiDate 型(検証済み)を受け取る前提のため、
    // 不正フォーマットの検証は parseKaisaiDate 側の責務であることを確認する。
    expect(() => parseKaisaiDate("2026013a")).toThrow(InvalidIdError);
  });
});
