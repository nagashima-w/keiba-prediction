import { describe, expect, it } from "vitest";

import {
  inputToYyyymmdd,
  isValidYyyymmdd,
  yyyymmddToInput,
} from "../src/renderer/date-input.js";

describe("yyyymmddToInput(YYYYMMDD → <input type=date> 値)", () => {
  it("YYYY-MM-DD 形式に変換する", () => {
    expect(yyyymmddToInput("20260709")).toBe("2026-07-09");
  });
  it("8桁でない入力は空文字を返す(input が空扱いになる)", () => {
    expect(yyyymmddToInput("2026")).toBe("");
    expect(yyyymmddToInput("")).toBe("");
  });
});

describe("inputToYyyymmdd(<input type=date> 値 → YYYYMMDD)", () => {
  it("ハイフンを除去して8桁にする", () => {
    expect(inputToYyyymmdd("2026-07-09")).toBe("20260709");
  });
  it("空入力は空文字", () => {
    expect(inputToYyyymmdd("")).toBe("");
  });
});

describe("isValidYyyymmdd(8桁日付の妥当性)", () => {
  it("8桁数字なら true、それ以外は false", () => {
    expect(isValidYyyymmdd("20260709")).toBe(true);
    expect(isValidYyyymmdd("2026-07-09")).toBe(false);
    expect(isValidYyyymmdd("2026")).toBe(false);
    expect(isValidYyyymmdd("")).toBe(false);
  });
});
