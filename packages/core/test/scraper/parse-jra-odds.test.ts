/**
 * parse-jra-odds(JRA 公式サイトのオッズの頁のパーサ。Issue #672・#668-B)のテスト。
 * フィクスチャは `fixtures/jra_odds_*.html`(東京 8R `202605050208`。Shift_JIS のバイト列をデコードして読む)。
 * 実サイトへのリクエストは含まない。
 */
import { describe, expect, it } from "vitest";
import { parseJraWinPlaceOdds } from "../../src/scraper/parse-jra-odds.js";
import type { OddsSnapshot } from "../../src/scraper/types.js";
import { loadShiftJisFixture } from "../support/fixtures.js";

const RACE_DATE = "2026-11-08";

/** available を前提として先に固定し、スナップショットを取り出す(空振り防止)。 */
function snapshotOf(file: string): OddsSnapshot {
  const result = parseJraWinPlaceOdds(loadShiftJisFixture(file), RACE_DATE);
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error("unreachable");
  return result.snapshot;
}

describe("parseJraWinPlaceOdds(発売状態と時刻)", () => {
  it.each([
    ["jra_odds_tanpuku_202605050208.html", "middle", "2026-11-08 10:37:00"],
    ["jra_odds_tanpuku_1342_202605050208.html", "middle", "2026-11-08 13:42:00"],
    ["jra_odds_tanpuku_1348_202605050208.html", "middle", "2026-11-08 13:48:00"],
    ["jra_odds_tanpuku_final_202605050208.html", "result", null],
    ["jra_odds_tanpuku_saishu_202605050201.html", "result", null],
  ] as const)("%s は %s・時刻 %s", (file, status, datetime) => {
    const s = snapshotOf(file);
    expect(s.oddsStatus).toBe(status);
    expect(s.officialDatetime).toBe(datetime);
  });
});

describe("parseJraWinPlaceOdds(単勝・複勝の値)", () => {
  it("発売中(10:37): 14頭・代表値(赤字の強調に包まれた値も読める)", () => {
    const s = snapshotOf("jra_odds_tanpuku_202605050208.html");
    expect(Object.keys(s.win)).toHaveLength(14);
    expect(Object.keys(s.place)).toHaveLength(14);
    expect(s.win[1]?.odds).toBe(40.0);
    expect(s.win[2]?.odds).toBe(4.6); // <strong class="red"> に包まれている
    expect(s.place[1]).toMatchObject({ oddsMin: 8.5, oddsMax: 13.6 });
    expect(s.place[2]).toMatchObject({ oddsMin: 1.9, oddsMax: 2.9 });
  });

  it("発売中(13:42)と確定後で単勝が変わる(別の頁を読み分けている)", () => {
    const a = snapshotOf("jra_odds_tanpuku_1342_202605050208.html");
    const b = snapshotOf("jra_odds_tanpuku_final_202605050208.html");
    expect(a.win[1]?.odds).toBe(66.2);
    expect(a.place[1]).toMatchObject({ oddsMin: 9.0, oddsMax: 13.7 });
    expect(b.win[1]?.odds).toBe(116.9);
    expect(b.place[1]).toMatchObject({ oddsMin: 16.4, oddsMax: 24.2 });
    expect(b.win[3]?.odds).toBe(334.9);
  });

  it("1R(11頭立て・確定): 頭数が頁ごとに違っても読める", () => {
    const s = snapshotOf("jra_odds_tanpuku_saishu_202605050201.html");
    expect(Object.keys(s.win)).toHaveLength(11);
    expect(s.win[2]?.odds).toBe(1.8);
    expect(s.place[2]).toMatchObject({ oddsMin: 1.1, oddsMax: 1.1 });
  });

  it("確定後の頁(発売票数の表・馬体重を含む)でも頭数が増えない", () => {
    const s = snapshotOf("jra_odds_tanpuku_final_202605050208.html");
    expect(Object.keys(s.win)).toHaveLength(14);
  });
});

describe("parseJraWinPlaceOdds(人気)", () => {
  it("人気順の頁(op)では td.pop の値を読む(同オッズ 4.6 の馬は公式も同順位 2、次は 4)", () => {
    const s = snapshotOf("jra_odds_tanpuku_ninki_202605050208.html");
    expect(s.win[5]?.ninki).toBe(1); // 4.3
    expect(s.win[2]?.ninki).toBe(2); // 4.6
    expect(s.win[7]?.ninki).toBe(2); // 4.6(公式も同オッズは同順位)
    expect(s.win[14]?.ninki).toBe(4); // 7.0(同順位の次は 4)
    expect(s.win[2]?.odds).toBe(s.win[7]?.odds); // 前提: 同オッズ
    expect(s.place[7]?.ninki).toBe(2);
  });

  it("馬番順の頁(ou)では単勝オッズの昇順で順位を作る(同オッズは小さい方の順位)", () => {
    const s = snapshotOf("jra_odds_tanpuku_202605050208.html");
    expect(s.win[5]?.odds).toBe(4.3);
    expect(s.win[5]?.ninki).toBe(1);
    expect(s.win[2]?.odds).toBe(4.6);
    expect(s.win[7]?.odds).toBe(4.6);
    expect(s.win[2]?.ninki).toBe(2);
    expect(s.win[7]?.ninki).toBe(2);
    expect(s.win[14]?.ninki).toBe(4);
    expect(s.win[1]?.ninki).toBeGreaterThan(5); // 40.0 倍は下位
    expect(s.place[2]?.ninki).toBe(2);
    // 全馬に順位が付く
    expect(Object.values(s.win).every((w) => w.ninki !== null)).toBe(true);
  });
});

describe("parseJraWinPlaceOdds(読めなかった頁)", () => {
  it.each([
    ["空文字", ""],
    ["オッズの頁でない(開催選択)", loadShiftJisFixture("jra_odds_oli_20261108.html")],
    ["オッズの頁でない(場のレース選択)", loadShiftJisFixture("jra_odds_orl_tokyo_20261108.html")],
    ["組合せの頁(単勝・複勝の表が無い)", loadShiftJisFixture("jra_odds_umaren_202605050208.html")],
  ])("%s は unavailable(throw しない)", (_name, html) => {
    const result = parseJraWinPlaceOdds(html, RACE_DATE);
    expect(result.state).toBe("unavailable");
  });

  it("日付の形が不正なら throw(呼び出し側のバグ)", () => {
    expect(() =>
      parseJraWinPlaceOdds(loadShiftJisFixture("jra_odds_tanpuku_202605050208.html"), "11/8"),
    ).toThrow();
  });
});
