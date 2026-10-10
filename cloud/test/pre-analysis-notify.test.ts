import { describe, expect, it } from "vitest";

import { DISCORD_COLORS } from "../src/palette";
import { buildPlanRequestFailedEmbed, slashDateWithWeekday } from "../src/notify-embeds";

/**
 * Issue #249: 事前分析の通知の文面(純関数)。
 *  - 日付の見出し: 「2026/10/11(日)」。夜に届くので、どの日の分か分かるよう曜日を付ける。
 *  - 23 時の再実行で翌日の事前分析を依頼できなかったときの固定文(`scheduled.ts` が送る)。色に頼らず文字で伝える。
 */

describe("slashDateWithWeekday(開催日の見出し)", () => {
  it.each([
    ["20261011", "2026/10/11(日)"],
    ["20261017", "2026/10/17(土)"],
    ["20280229", "2028/02/29(火)"],
    ["20261231", "2026/12/31(木)"],
  ])("%s → %s", (date, expected) => {
    expect(slashDateWithWeekday(date)).toBe(expected);
  });

  it.each([[""], ["2026101"], ["20261301"], [null], [undefined]])("不正な開催日 %j は「日付不明」(曜日を捏造しない)", (date) => {
    expect(slashDateWithWeekday(date as never)).toBe("日付不明");
  });
});

describe("buildPlanRequestFailedEmbed(23 時の再実行で翌日の事前分析を依頼できなかった)", () => {
  const embed = buildPlanRequestFailedEmbed("20261011");

  it("本文は固定文: 失敗・時刻(23 時の再実行)・対象の日(曜日つき)・事前分析・依頼できなかった・手動で実行、を文字で伝える", () => {
    expect(embed.description).toBe("【失敗】23 時の再実行で、翌日(2026/10/11(日)開催分)の事前分析を依頼できませんでした。画面から手動で実行してください。");
  });

  it("タイトルにも失敗と日付が入る(通知の一覧で見分けられる)", () => {
    expect(embed.title).toBe("事前分析の失敗 2026/10/11(日)");
  });

  it("帯は #239 の失敗色(色だけに頼らない: 文字にも「失敗」がある)", () => {
    expect(embed.color).toBe(DISCORD_COLORS.fail);
    expect(`${embed.title}${embed.description}`).toContain("失敗");
  });

  it("URL・secret・例外の文面を含まない(固定文と日付だけ)", () => {
    const text = JSON.stringify(embed);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toMatch(/webhook/i);
  });

  it("開催日が不正でも例外にせず、日付不明の固定文になる", () => {
    const bad = buildPlanRequestFailedEmbed("xx");
    expect(bad.title).toBe("事前分析の失敗 日付不明");
    expect(bad.description).toContain("日付不明");
  });
});
