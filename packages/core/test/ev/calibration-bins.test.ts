import { describe, expect, it } from "vitest";
import {
  binIndexFor,
  calibrationBinBounds,
  DEFAULT_QUALITY_BIN_COUNT,
  DEFAULT_VERIFY_BIN_COUNT,
} from "../../src/ev/calibration-bins.js";
import { DEFAULT_VERIFY_CONFIG } from "../../src/ev/verify.js";

/**
 * calibration-bins — 検証画面のキャリブレーションと確率の質の Murphy 分解が**共有する帯の切り方**
 * (#41「#35-1b」)。`verify.ts` の private 関数だった `binIndexFor` を切り出したもので、
 * 同じ帯数を渡せば同じ帯になる。**既定の帯数は用途ごとに分かれている**(#37):
 * 検証画面は20(5% 刻み。表示の解像度)、確率の質の測定は10(過去の測定記録との比較のため)。
 */

describe("既定の帯数(用途ごとに分かれている。#37)", () => {
  it("検証画面の既定帯数(DEFAULT_VERIFY_CONFIG.calibrationBins)は DEFAULT_VERIFY_BIN_COUNT で、20(5% 刻み)である", () => {
    expect(DEFAULT_VERIFY_BIN_COUNT).toBe(20);
    expect(DEFAULT_VERIFY_CONFIG.calibrationBins).toBe(DEFAULT_VERIFY_BIN_COUNT);
  });

  it("確率の質の測定の既定帯数 DEFAULT_QUALITY_BIN_COUNT は10のまま(コミット済みの #41・#156 の測定記録を既定で再現するため)", () => {
    expect(DEFAULT_QUALITY_BIN_COUNT).toBe(10);
  });

  it("2つの既定は別の値である(片方を変えても他方が連動して動かない。前提の固定)", () => {
    expect(DEFAULT_VERIFY_BIN_COUNT).not.toBe(DEFAULT_QUALITY_BIN_COUNT);
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

describe("binIndexFor: 5% 刻み(20帯。#37)でも下限を含み上限を含まない", () => {
  const table: ReadonlyArray<{ readonly name: string; readonly prob: number; readonly expected: number }> = [
    { name: "0.0 は先頭帯", prob: 0, expected: 0 },
    { name: "0.0499 は先頭帯(0〜5%)", prob: 0.0499, expected: 0 },
    { name: "0.05 ちょうどは第2帯(5〜10%。下限を含む)", prob: 0.05, expected: 1 },
    { name: "0.0999 は第2帯", prob: 0.0999, expected: 1 },
    { name: "0.10 ちょうどは第3帯(10〜15%)", prob: 0.1, expected: 2 },
    { name: "0.15 ちょうどは第4帯", prob: 0.15, expected: 3 },
    { name: "0.25 ちょうどは第6帯", prob: 0.25, expected: 5 },
    { name: "0.95 ちょうどは最終帯(下限を含む)", prob: 0.95, expected: 19 },
    { name: "0.9499 は第19帯(90〜95%)", prob: 0.9499, expected: 18 },
    { name: "0.9999 は最終帯", prob: 0.9999, expected: 19 },
    { name: "1.0 は最終帯に丸める(上限を含むのは最終帯のみ)", prob: 1, expected: 19 },
    { name: "1 を超えたはみ出しは最終帯に丸める", prob: 1.3, expected: 19 },
    { name: "負値は先頭帯に丸める", prob: -0.2, expected: 0 },
  ];
  it.each(table)("$name", ({ prob, expected }) => {
    expect(binIndexFor(prob, 20)).toBe(expected);
  });

  it("k/20(k=0..19)は必ず第k帯に入る(浮動小数の誤差で帯の境界が1つずれない)", () => {
    for (let k = 0; k <= 19; k++) {
      expect(binIndexFor(k / 20, 20)).toBe(k);
    }
  });

  it("20帯の各帯の中央値((k+0.5)/20)は第k帯に入る(全20帯がすべて到達可能で、潰れた帯がない)", () => {
    const reached = new Set<number>();
    for (let k = 0; k < 20; k++) {
      const index = binIndexFor((k + 0.5) / 20, 20);
      expect(index).toBe(k);
      reached.add(index);
    }
    expect(reached.size).toBe(20);
  });
});

describe("calibrationBinBounds", () => {
  it("10帯の境界は index/10 と (index+1)/10", () => {
    expect(calibrationBinBounds(0, 10)).toEqual({ lowerBound: 0, upperBound: 0.1 });
    expect(calibrationBinBounds(3, 10)).toEqual({ lowerBound: 0.3, upperBound: 0.4 });
    expect(calibrationBinBounds(9, 10)).toEqual({ lowerBound: 0.9, upperBound: 1 });
  });

  it("20帯の境界は index/20 と (index+1)/20(5% 刻みで隣接帯の境界が連続する)", () => {
    expect(calibrationBinBounds(0, 20)).toEqual({ lowerBound: 0, upperBound: 0.05 });
    expect(calibrationBinBounds(1, 20)).toEqual({ lowerBound: 0.05, upperBound: 0.1 });
    expect(calibrationBinBounds(19, 20)).toEqual({ lowerBound: 0.95, upperBound: 1 });
    for (let i = 0; i < 19; i++) {
      expect(calibrationBinBounds(i, 20).upperBound).toBe(calibrationBinBounds(i + 1, 20).lowerBound);
    }
  });

  it.each([10, 20])("各帯の下限は、その下限ちょうどの確率が入る帯と一致する(binIndexFor と同じ境界である。%i帯)", (binCount) => {
    for (let i = 0; i < binCount; i++) {
      expect(binIndexFor(calibrationBinBounds(i, binCount).lowerBound, binCount)).toBe(i);
    }
  });
});
