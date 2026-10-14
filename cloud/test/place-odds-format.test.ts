import { describe, expect, it } from "vitest";

import {
  buildPlaceOddsLine,
  formatActualPlaceOdds,
  formatFairPlaceOdds,
  PLACE_HEADING,
  PLACE_HEADING_TOP2,
  PLACE_ODDS_NOTE,
  PLACE_UNDER_ONE_TEXT,
} from "../src/place-odds-format";
import { ACTUAL_HIGHER_MARK } from "../src/win-odds-format";

/**
 * Issue #253: 想定複勝オッズと実際の複勝オッズ(下限〜上限の幅)の表示(web のカードと Discord が共有する純関数)。
 *  - 想定: 小数第1位に丸める。生の値が 1.0 未満のときは「1.0倍未満」(0.96 のように丸めると 1.0 になる値も)。1000 を超える値は「1000倍超」。欠損は「-」
 *  - 実際: 「1.5〜2.3倍」。丸めると同じ値なら「1.5倍」。上限が無い(過去の分析・取れなかった)ときは「1.5倍〜」。下限が無いときは「-」
 *  - 強調「↑想定より高い」: 実際の**下限**と想定を、丸めた後の値どうしで比べる。想定が 1.0倍未満のときは比べない(強調なし)
 */

describe("formatFairPlaceOdds(想定複勝オッズ: 小数第1位・1.0倍未満・1000倍超・欠損)", () => {
  it.each([
    [2, "2.0倍"],
    [1.58, "1.6倍"],
    [2.44, "2.4倍"],
    [2.46, "2.5倍"],
    [1.0, "1.0倍"],
    [1.04, "1.0倍"],
    [999.94, "999.9倍"],
    [1000, "1000.0倍"],
    [1000.06, "1000倍超"],
  ] as const)("%f → %s", (odds, expected) => {
    expect(formatFairPlaceOdds(odds)).toBe(expected);
  });

  it("生の値が 1.0 未満は「1.0倍未満」(0.8 → 払戻率ちょうどの 100%、0.9999 のように丸めると 1.0 になる値も、0.96 も)", () => {
    for (const odds of [0.8, 0.8 / 0.85, 0.96, 0.9999, 0.05]) {
      expect(formatFairPlaceOdds(odds), String(odds)).toBe("1.0倍未満");
    }
    expect(PLACE_UNDER_ONE_TEXT).toBe("1.0倍未満");
  });

  it("欠損(null)と非有限は「-」", () => {
    expect(formatFairPlaceOdds(null)).toBe("-");
    expect(formatFairPlaceOdds(Number.NaN)).toBe("-");
    expect(formatFairPlaceOdds(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("formatActualPlaceOdds(実際の複勝オッズ: 下限〜上限)", () => {
  it.each([
    [1.5, 2.3, "1.5〜2.3倍"],
    [1.04, 2.26, "1.0〜2.3倍"],
    [10, 35.5, "10.0〜35.5倍"],
  ] as const)("下限 %f・上限 %f → %s", (min, max, expected) => {
    expect(formatActualPlaceOdds(min, max)).toBe(expected);
  });

  it("丸めると下限と上限が同じ値: 「1.5倍」(「1.5〜1.5倍」を作らない)", () => {
    expect(formatActualPlaceOdds(1.46, 1.54)).toBe("1.5倍");
    expect(formatActualPlaceOdds(1.5, 1.5)).toBe("1.5倍");
  });

  it("上限が無い(null・非有限。過去の分析は上限を保存していない)は「1.5倍〜」(下限だけを出す)", () => {
    expect(formatActualPlaceOdds(1.5, null)).toBe("1.5倍〜");
    expect(formatActualPlaceOdds(1.5, Number.NaN)).toBe("1.5倍〜");
    expect(formatActualPlaceOdds(1.5, Number.POSITIVE_INFINITY)).toBe("1.5倍〜");
  });

  it("上限が下限より小さい(不正なデータ)は上限を使わず「1.5倍〜」", () => {
    expect(formatActualPlaceOdds(2.3, 1.5)).toBe("2.3倍〜");
  });

  it("下限が無い(null・非有限)は「-」。上限だけあっても「-」(下限が基準)", () => {
    expect(formatActualPlaceOdds(null, 2.3)).toBe("-");
    expect(formatActualPlaceOdds(null, null)).toBe("-");
    expect(formatActualPlaceOdds(Number.NaN, 2.3)).toBe("-");
  });

  it("1000 を超える値は「1000倍超」(上限だけ超えるときは「1.5〜1000倍超」、下限も超えるときは「1000倍超」)", () => {
    expect(formatActualPlaceOdds(1.5, 1200)).toBe("1.5〜1000倍超");
    expect(formatActualPlaceOdds(1200, 1500)).toBe("1000倍超");
    expect(formatActualPlaceOdds(1200, null)).toBe("1000倍超〜");
  });
});

describe("buildPlaceOddsLine(強調は実際の下限と想定を、丸めた後の値どうしで比べる)", () => {
  it("実際の下限が想定より高い: 強調(higher=true)。幅の上限は比較に使わない", () => {
    expect(buildPlaceOddsLine(1.6, 2.0, 2.3, "result", "top3")).toEqual({
      heading: PLACE_HEADING,
      fair: "1.6倍",
      actual: "2.0〜2.3倍",
      actualLabel: "実際",
      higher: true,
    });
  });

  it("下限は想定より低いが上限は高い(想定が幅の中): 強調なし(下限で比べる)", () => {
    const line = buildPlaceOddsLine(2.0, 1.5, 2.3, "result", "top3");
    expect(line.actual).toBe("1.5〜2.3倍");
    expect(line.higher).toBe(false);
  });

  it("丸めると同じ値(想定 1.54・下限 1.46 → どちらも 1.5): 強調なし(「1.5倍 / 1.5〜… ↑」を作らない)", () => {
    const line = buildPlaceOddsLine(1.46, 1.54, 2.0, "result", "top3");
    expect(line.fair).toBe("1.5倍");
    expect(line.actual).toBe("1.5〜2.0倍");
    expect(line.higher).toBe(false);
  });

  it("丸めた後に差が出る境界(想定 1.44 → 1.4、下限 1.56 → 1.6): 強調あり。境界の1つ手前(想定 1.46→1.5 と下限 1.54→1.5)は強調なし", () => {
    expect(buildPlaceOddsLine(1.44, 1.56, 2, "result", "top3").higher).toBe(true);
    expect(buildPlaceOddsLine(1.46, 1.54, 2, "result", "top3").higher).toBe(false);
  });

  it("想定が 1.0倍未満: 「1.0倍未満」と表示し、比べない(強調なし)。実際の下限が 1.0 でも、想定が 0.8 倍でも", () => {
    const line = buildPlaceOddsLine(0.8, 1.0, 1.3, "result", "top3");
    expect(line.fair).toBe("1.0倍未満");
    expect(line.actual).toBe("1.0〜1.3倍");
    expect(line.higher).toBe(false);
    // 丸めると 1.0 になる想定(0.96)でも、生の値が 1.0 未満なら強調しない
    expect(buildPlaceOddsLine(0.96, 1.1, 1.3, "result", "top3").higher).toBe(false);
    // 想定が 1.0 ちょうど(1.0倍未満ではない)は比べる: 下限 1.1 > 1.0 で強調あり
    expect(buildPlaceOddsLine(1.0, 1.1, 1.3, "result", "top3")).toMatchObject({ fair: "1.0倍", higher: true });
  });

  it("上限が無くても、下限があれば強調の判定ができる(「1.5倍〜」の形)", () => {
    const line = buildPlaceOddsLine(1.2, 1.5, null, "result", "top3");
    expect(line.actual).toBe("1.5倍〜");
    expect(line.higher).toBe(true);
  });

  it("下限が欠損: 「-」で強調なし。想定が欠損: 想定「-」で強調なし。両方欠損: 両方「-」", () => {
    expect(buildPlaceOddsLine(1.6, null, 2.3, "result", "top3")).toMatchObject({ fair: "1.6倍", actual: "-", higher: false });
    expect(buildPlaceOddsLine(null, 1.5, 2.3, "result", "top3")).toMatchObject({ fair: "-", actual: "1.5〜2.3倍", higher: false });
    expect(buildPlaceOddsLine(null, null, null, "yoso", "top3")).toMatchObject({ fair: "-", actual: "-", actualLabel: "実際(予想)", higher: false });
  });

  it("オッズの状態がラベルに出る(暫定・予想)。強調の判定は状態に依らない", () => {
    expect(buildPlaceOddsLine(1.6, 2.0, 2.3, "middle", "top3")).toMatchObject({ actualLabel: "実際(暫定)", higher: true });
    expect(buildPlaceOddsLine(1.6, 2.0, 2.3, "yoso", "top3")).toMatchObject({ actualLabel: "実際(予想)", higher: true });
    expect(buildPlaceOddsLine(1.6, 2.0, 2.3, null, "top3").actualLabel).toBe("実際");
  });

  it("5〜7頭(basis=top2): 見出しに「2着まで」が付く。top3 には付かない。出さない(basis=null)ときは通常の見出しで、想定・実際が「-」", () => {
    expect(buildPlaceOddsLine(2.4, 1.5, 2.3, "result", "top2").heading).toBe(PLACE_HEADING_TOP2);
    expect(PLACE_HEADING_TOP2).toBe("複勝(2着まで)");
    expect(PLACE_HEADING).toBe("複勝");
    expect(buildPlaceOddsLine(1.6, 1.5, 2.3, "result", "top3").heading).toBe(PLACE_HEADING);
    expect(buildPlaceOddsLine(null, null, null, "result", null)).toEqual({ heading: PLACE_HEADING, fair: "-", actual: "-", actualLabel: "実際", higher: false });
  });

  it("basis=null(4頭以下・判定不能)は、想定と実際が渡されても「-」にする(複勝が発売されないレースで実際の値を出さない)", () => {
    expect(buildPlaceOddsLine(1.6, 1.5, 2.3, "result", null)).toMatchObject({ fair: "-", actual: "-", higher: false });
  });
});

describe("固定の文言", () => {
  it("強調の文言は単勝と同じ「↑想定より高い」(価値判断の語を含まない)", () => {
    expect(ACTUAL_HIGHER_MARK).toBe("↑想定より高い");
  });

  it("説明文: 3着内率(5〜7頭は2着内率)・払戻率80%・地方も80%と仮定・目安・AI が直接判断した値ではない・下限と比べる・EV>1 とは限らない、を含む。価値判断の語・URL を含まない", () => {
    for (const word of ["3着内率", "2着内率", "5〜7頭", "目安", "80%", "地方", "仮定", "AIが直接判断した値ではありません", "下限", "EV"]) {
      expect(PLACE_ODDS_NOTE, word).toContain(word);
    }
    expect(PLACE_ODDS_NOTE).not.toMatch(/妙味|お得/);
    expect(PLACE_ODDS_NOTE).not.toMatch(/https?:|@/);
  });
});
