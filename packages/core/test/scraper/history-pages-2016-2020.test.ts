import { describe, expect, it } from "vitest";
import { parseCalendarKaisaiDates, parseListRaceIds, validateHistoryPage } from "../../src/scraper/history-pages.js";
import { buildRaceRecord } from "../../src/scraper/race-record.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #745: 中央の過去の結果の取得を 2016-01 まで広げるにあたり、2016・2018・2020 年のページが今のパーサで読めることを実物のフィクスチャで固定する。
 * フィクスチャは 2026-11-15 に netkeiba から 1 本ずつ取った(2016-12 のカレンダー・2016-12-25 の一覧・結果 3 本。計 5 ファイル)。
 * 2016 年前半・2017 年・2019 年のページは取っていない(未確認)。
 */

describe("2016-12 のカレンダー・一覧", () => {
  it("カレンダーは検証を通り、その月の開催日 9 日を昇順で返す(ページに混じる今日の日付のリンクは月の接頭辞で除かれる)", () => {
    const html = loadFixture("history_central_calendar_2016_12.html");
    expect(validateHistoryPage("central", "calendar", html)).toBeNull();
    expect(validateHistoryPage("central", "calendar", html.slice(0, 1000))).not.toBeNull(); // 検証が空振りでない(途切れたページは通らない)
    expect(parseCalendarKaisaiDates(html, "2016-12")).toEqual([
      "20161203", "20161204", "20161210", "20161211", "20161217", "20161218", "20161223", "20161224", "20161225",
    ]);
  });
  it("2016-12-25 の一覧は検証を通り、中央の 23 レース(中山 11・阪神 12)の race_id を返す", () => {
    const html = loadFixture("history_central_list_20161225.html");
    expect(validateHistoryPage("central", "list", html)).toBeNull();
    const ids = parseListRaceIds(html, "central");
    expect(ids).toHaveLength(23);
    expect(ids.filter((id) => id.startsWith("20160605"))).toHaveLength(11);
    expect(ids.filter((id) => id.startsWith("20160905"))).toHaveLength(12);
    expect(ids).toContain("201606050910");
  });
});

const CASES = [
  { id: "201606050910", date: "2016-12-25", winner: { umaban: 11, name: "サトノダイヤモンド", odds: 2.6, payout: 260 }, second: 1 },
  { id: "201806050810", date: "2018-12-23", winner: { umaban: 8, name: "シャインヴィットゥ", odds: 20.5, payout: 2050 }, second: 1 },
  { id: "202006050810", date: "2020-12-27", winner: { umaban: 5, name: "ノンライセンス", odds: 6.2, payout: 620 }, second: 7 },
] as const;

describe.each(CASES)("結果ページ $id($date)", ({ id, date, winner, second }) => {
  const html = loadFixture(`history_central_result_${id}.html`);
  it("検証を通り、拒否されずに読める(読めなかった列なし)", () => {
    expect(validateHistoryPage("central", "result", html)).toBeNull();
    const built = buildRaceRecord(html, id, "central");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.date).toBe(date);
    expect(built.record.missingColumns).toEqual([]);
  });
  it("16 頭の出走・着順・単勝オッズ(全頭)・単勝の払戻が取れる", () => {
    const built = buildRaceRecord(html, id, "central");
    if (!built.ok) throw new Error("読めない");
    const { horses, payouts } = built.record;
    expect(horses).toHaveLength(16);
    expect(horses[0]!.finish).toBe(1);
    expect(horses[0]!.umaban).toBe(winner.umaban);
    expect(horses[0]!.horseName).toBe(winner.name);
    expect(horses[0]!.winOdds).toBe(winner.odds);
    expect(horses[1]!.finish).toBe(2);
    expect(horses[1]!.umaban).toBe(second);
    expect(horses.every((h) => typeof h.winOdds === "number" && h.winOdds > 0)).toBe(true);
    expect(payouts.win).toEqual([{ umaban: winner.umaban, payout: winner.payout }]);
    // 単勝の払戻(100 円あたり)は確定の単勝オッズ × 100(同着なし)
    expect(payouts.win[0]!.payout).toBe(Math.round(winner.odds * 100));
  });
});
