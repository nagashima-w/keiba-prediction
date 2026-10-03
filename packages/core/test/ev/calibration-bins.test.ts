import { describe, expect, it } from "vitest";
import {
  binIndexFor,
  calibrationBinBounds,
  DEFAULT_CALIBRATION_BIN_COUNT,
} from "../../src/ev/calibration-bins.js";
import { DEFAULT_VERIFY_CONFIG } from "../../src/ev/verify.js";

/**
 * calibration-bins — 検証画面のキャリブレーションと確率の質の Murphy 分解が**共有する帯の定義**
 * (#41「#35-1b」)。`verify.ts` の private 関数だった `binIndexFor` を切り出したもので、
 * 挙動は不変(既存の verify テストが無改変で緑であることが、その保証)。
 */

describe("DEFAULT_CALIBRATION_BIN_COUNT", () => {
  it("検証画面の既定帯数(DEFAULT_VERIFY_CONFIG.calibrationBins)と同じ10である", () => {
    expect(DEFAULT_CALIBRATION_BIN_COUNT).toBe(10);
    expect(DEFAULT_VERIFY_CONFIG.calibrationBins).toBe(DEFAULT_CALIBRATION_BIN_COUNT);
  });
});

describe("binIndexFor: 帯は下限を含み上限を含まない", () => {
  const table: ReadonlyArray<{ readonly name: string; readonly prob: number; readonly expected: number }> = [
    { name: "0.0 は先頭帯", prob: 0, expected: 0 },
    { name: "0.05 は先頭帯", prob: 0.05, expected: 0 },
    { name: "0.1 ちょうどは第2帯(下限を含む)", prob: 0.1, expected: 1 },
    { name: "0.2 ちょうどは第3帯", prob: 0.2, expected: 2 },
    { name: "0.3 ちょうどは第4帯", prob: 0.3, expected: 3 },
    { name: "0.5 ちょうどは第6帯", prob: 0.5, expected: 5 },
    { name: "0.7 ちょうどは第8帯", prob: 0.7, expected: 7 },
    { name: "0.9 ちょうどは最終帯(下限を含む)", prob: 0.9, expected: 9 },
    { name: "0.9999 は最終帯", prob: 0.9999, expected: 9 },
    { name: "1.0 は最終帯に丸める(上限を含むのは最終帯のみ)", prob: 1, expected: 9 },
    { name: "1 を超えたはみ出しは最終帯に丸める", prob: 1.3, expected: 9 },
    { name: "負値は先頭帯に丸める", prob: -0.2, expected: 0 },
  ];
  it.each(table)("$name", ({ prob, expected }) => {
    expect(binIndexFor(prob, 10)).toBe(expected);
  });

  it("k/10(k=0..9)は必ず第k帯に入る(浮動小数の誤差で帯の境界が1つずれない)", () => {
    for (let k = 0; k <= 9; k++) {
      expect(binIndexFor(k / 10, 10)).toBe(k);
    }
  });

  it("帯数を変えると同じ式で追従する(5帯なら 0.2 は第2帯、1.0 は最終帯)", () => {
    expect(binIndexFor(0.2, 5)).toBe(1);
    expect(binIndexFor(0.19, 5)).toBe(0);
    expect(binIndexFor(1, 5)).toBe(4);
  });
});

describe("calibrationBinBounds", () => {
  it("10帯の境界は index/10 と (index+1)/10", () => {
    expect(calibrationBinBounds(0, 10)).toEqual({ lowerBound: 0, upperBound: 0.1 });
    expect(calibrationBinBounds(3, 10)).toEqual({ lowerBound: 0.3, upperBound: 0.4 });
    expect(calibrationBinBounds(9, 10)).toEqual({ lowerBound: 0.9, upperBound: 1 });
  });

  it("各帯の下限は、その下限ちょうどの確率が入る帯と一致する(binIndexFor と同じ境界である)", () => {
    for (let i = 0; i < 10; i++) {
      expect(binIndexFor(calibrationBinBounds(i, 10).lowerBound, 10)).toBe(i);
    }
  });
});
