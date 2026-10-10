import { describe, expect, it } from "vitest";
import { formatRecoveryPercent } from "../src/recovery-format";

/**
 * Issue #245(#242 #239 R4): 回収率の丸め。小数第 1 位に丸めると 100.0% になる値は、実際には 1 ちょうどではない(赤字・黒字)のに「100.0%」と出ていた。
 * **「100.0%」と出るのは rate === 1 のときだけ**にする(1 未満は 99.99% を上限、1 超は 100.01% を下限に、小数 2 桁で出す)。
 * 期待値は、実装を書く前に `(rate * 100).toFixed(1)`・`Math.round(rate * 10000)` を実行して測り直した値(0.9995 の `toFixed(1)` は "100.0" で、0.99949 は "99.9")。
 */

// [回収率, 表示]。丸めの境界(0.99949 / 0.9995)・1 未満で 100.0% に丸まる範囲(0.9995〜)・小数 2 桁でも 100.00 になる範囲(0.99995〜)・1・1 超で 100.0% に丸まる範囲(1.0005 未満)を含める。
const TABLE: readonly (readonly [number, string])[] = [
  [0, "0.0%"],
  [0.5, "50.0%"],
  [0.99, "99.0%"],
  [0.99949, "99.9%"], // 丸めても 100.0% にならない: 従来どおり
  [0.9995, "99.95%"], // 最初に 100.0% に丸まる値
  [0.99951, "99.95%"],
  [0.9999, "99.99%"],
  [0.99994, "99.99%"],
  [0.99995, "99.99%"], // 小数 2 桁に丸めても 100.00 になる値は、99.99% に収める(1 未満の側)
  [0.999999, "99.99%"],
  [1, "100.0%"], // ちょうど 1 だけが 100.0%
  [1.00001, "100.01%"], // 小数 2 桁に丸めても 100.00 になる値は、100.01% に収める(1 超の側)
  [1.00004, "100.01%"],
  [1.00005, "100.01%"],
  [1.0004999, "100.05%"],
  [1.0005, "100.05%"], // toFixed(1) は "100.0"
  [1.00051, "100.1%"], // 丸めると 100.0% でなくなる: 従来どおり
  [1.3, "130.0%"],
];

describe("formatRecoveryPercent(回収率の表示)", () => {
  it.each(TABLE)("回収率 %f は %s", (rate, expected) => {
    expect(formatRecoveryPercent(rate)).toBe(expected);
  });

  it("前提: 表は『1 未満で従来は 100.0% と出た値』と『1 超で従来は 100.0% と出た値』の両方を含む(旧表示では矛盾した値が表にある)", () => {
    const oldShown = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
    const below = TABLE.filter(([rate]) => rate < 1 && oldShown(rate) === "100.0%");
    const above = TABLE.filter(([rate]) => rate > 1 && oldShown(rate) === "100.0%");
    expect(below.length).toBeGreaterThanOrEqual(5);
    expect(above.length).toBeGreaterThanOrEqual(4);
  });

  it("0.999 〜 1.001 を 1e-6 刻みで走査: 1 未満は 100 未満、1 超は 100 超と出て、回収率が大きいほど表示は小さくならない。『100.0%』は rate === 1 のときだけ", () => {
    let previous = -Infinity;
    let below = 0;
    let above = 0;
    let shownHundred = 0;
    for (let i = 0; i <= 2000; i++) {
      const rate = 0.999 + i * 1e-6;
      const shown = formatRecoveryPercent(rate);
      const value = Number.parseFloat(shown);
      if (rate < 1) {
        expect(value, `rate=${rate} shown=${shown}`).toBeLessThan(100);
        below += 1;
      }
      if (rate > 1) {
        expect(value, `rate=${rate} shown=${shown}`).toBeGreaterThan(100);
        above += 1;
      }
      if (shown === "100.0%") shownHundred += 1;
      expect(value, `rate=${rate} shown=${shown}`).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    // 前提(空振り防止): 走査が 1 未満・1 超の両側に十分な点を持つ。1e-6 刻みの格子が 1 ちょうどに当たるかは浮動小数次第なので、当たった数は 0 か 1 のどちらかに限る。
    expect(below).toBeGreaterThan(900);
    expect(above).toBeGreaterThan(900);
    expect(shownHundred).toBeLessThanOrEqual(1);
    expect(formatRecoveryPercent(1)).toBe("100.0%");
  });

  it("有限でない値は従来どおりの書き方に落ちる(例外にしない)", () => {
    expect(formatRecoveryPercent(Number.NaN)).toBe("NaN%");
    expect(formatRecoveryPercent(Number.POSITIVE_INFINITY)).toBe("Infinity%");
  });
});
