import { describe, expect, it } from "vitest";

import {
  ACTUAL_HIGHER_MARK,
  actualWinOddsLabel,
  buildWinOddsLine,
  formatWinOdds,
  WIN_ODDS_DISPLAY_MAX,
  WIN_ODDS_NOTE,
} from "../src/win-odds-format";

/**
 * Issue #247: 想定単勝オッズと実際の単勝オッズの表示(web のカードと Discord が共有する純関数)。
 * 小数第1位に丸める。1000倍を超える値は「1000倍超」。欠損は「-」。強調は文字だけで、丸めた後の値どうしで比べる。
 */

describe("formatWinOdds(小数第1位・1000倍超・欠損)", () => {
  it.each([
    [8.5, "8.5倍"],
    [12.34, "12.3倍"],
    [0.8, "0.8倍"],
    [0.8000000000000005, "0.8倍"],
    [3.66, "3.7倍"],
    [99.96, "100.0倍"],
    [999.94, "999.9倍"],
    [1000, "1000.0倍"],
    [1000.04, "1000.0倍"],
    [1000.06, "1000倍超"],
    [8e8, "1000倍超"],
  ] as const)("%f → %s", (odds, expected) => {
    expect(formatWinOdds(odds)).toBe(expected);
  });

  it("欠損(null)と非有限は「-」", () => {
    expect(formatWinOdds(null)).toBe("-");
    expect(formatWinOdds(Number.NaN)).toBe("-");
    expect(formatWinOdds(Number.POSITIVE_INFINITY)).toBe("-");
  });

  it("上限の定数は 1000", () => {
    expect(WIN_ODDS_DISPLAY_MAX).toBe(1000);
  });
});

describe("actualWinOddsLabel(オッズの状態でラベルを出し分ける)", () => {
  it.each([
    ["result", "実際"],
    ["middle", "実際(暫定)"],
    ["yoso", "実際(予想)"],
    [null, "実際"],
    ["想定外の値", "実際"],
  ] as const)("%s → %s", (status, label) => {
    expect(actualWinOddsLabel(status)).toBe(label);
  });
});

describe("buildWinOddsLine(強調は丸めた後の値どうしで比べる)", () => {
  it("実際が想定より高い: 強調(higher=true)", () => {
    expect(buildWinOddsLine(8.5, 12.3, "result")).toEqual({ fair: "8.5倍", actual: "12.3倍", actualLabel: "実際", higher: true });
  });

  it("実際が想定より低い: 強調なし", () => {
    expect(buildWinOddsLine(8.5, 6.0, "result").higher).toBe(false);
  });

  it("丸めると同じ値(8.54 と 8.46 → どちらも 8.5): 強調なし(「8.5 / 8.5 ↑」を作らない)", () => {
    const line = buildWinOddsLine(8.46, 8.54, "result");
    expect(line.fair).toBe("8.5倍");
    expect(line.actual).toBe("8.5倍");
    expect(line.higher).toBe(false);
  });

  it("丸めた後に差が出る境界(8.44 → 8.4 と 8.56 → 8.6): 強調あり", () => {
    expect(buildWinOddsLine(8.44, 8.56, "result").higher).toBe(true);
  });

  it("どちらも 1000倍超: 同じ表示なので強調なし。想定が 1000倍超で実際が 999.9: 強調なし。想定が 500 で実際が 1200(1000倍超): 強調あり", () => {
    expect(buildWinOddsLine(5000, 1200, "result").higher).toBe(false);
    expect(buildWinOddsLine(5000, 999.9, "result").higher).toBe(false);
    expect(buildWinOddsLine(500, 1200, "result")).toEqual({ fair: "500.0倍", actual: "1000倍超", actualLabel: "実際", higher: true });
  });

  it("どちらかが欠損: 「-」を出し、強調なし", () => {
    expect(buildWinOddsLine(null, 12.3, "result")).toEqual({ fair: "-", actual: "12.3倍", actualLabel: "実際", higher: false });
    expect(buildWinOddsLine(8.5, null, "result")).toEqual({ fair: "8.5倍", actual: "-", actualLabel: "実際", higher: false });
    expect(buildWinOddsLine(null, null, "yoso")).toEqual({ fair: "-", actual: "-", actualLabel: "実際(予想)", higher: false });
  });

  it("オッズの状態がラベルに出る(暫定・予想)。強調の判定は状態に依らない", () => {
    expect(buildWinOddsLine(8.5, 12.3, "middle")).toMatchObject({ actualLabel: "実際(暫定)", higher: true });
    expect(buildWinOddsLine(8.5, 12.3, "yoso")).toMatchObject({ actualLabel: "実際(予想)", higher: true });
  });
});

describe("固定の文言", () => {
  it("強調の文言は「↑想定より高い」で、価値判断の語(妙味・お得)を含まない", () => {
    expect(ACTUAL_HIGHER_MARK).toBe("↑想定より高い");
    expect(ACTUAL_HIGHER_MARK).not.toMatch(/妙味|お得/);
  });

  it("説明文: 3着内率からの推定の目安・払戻率80%と地方も同じ仮定の概算・AI が勝率を直接判断していない・実際が想定を上回っても EV>1 とは限らない、を含む。価値判断の語を含まない", () => {
    expect(WIN_ODDS_NOTE).toContain("3着内率");
    expect(WIN_ODDS_NOTE).toContain("目安");
    expect(WIN_ODDS_NOTE).toContain("80%");
    expect(WIN_ODDS_NOTE).toContain("地方");
    expect(WIN_ODDS_NOTE).toContain("仮定");
    expect(WIN_ODDS_NOTE).toContain("AIが勝率を直接判断した値ではありません");
    expect(WIN_ODDS_NOTE).toContain("EV");
    expect(WIN_ODDS_NOTE).not.toMatch(/妙味|お得/);
    expect(WIN_ODDS_NOTE).not.toMatch(/https?:|@/);
  });
});
