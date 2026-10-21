import { describe, expect, it } from "vitest";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #259(前半): 結果ページの「人気」「単勝オッズ」列を、馬ごとに `ninki`・`winOdds` として読む。
 * 列はヘッダの文言で解決し(後3F・コーナー通過順と同じ流儀)、行の td 数がヘッダの th 数と一致する行だけ読む。
 *
 * 期待値の出所: 保存済みの結果ページ(`fixtures/`)の該当セルを、パーサとは独立に(Python の HTMLParser で)読み出した値。
 * 2026-10-11 に netkeiba から取得した 2 本(`result_202605040205.html`〈除外 1 頭〉・`result_202608040204.html`〈3 着同着〉)を足した。
 * 地方の除外・取消は実物のフィクスチャが無いので、合成 HTML(「合成」と明記したもの)で補う。
 */

/** 馬番 → [人気, 単勝オッズ] の対応で比べる。 */
function oddsByUmaban(html: string): Record<number, [number | null, number | null]> {
  const out: Record<number, [number | null, number | null]> = {};
  for (const h of parseRaceResult(html).horses) {
    out[h.umaban] = [h.ninki ?? null, h.winOdds ?? null];
  }
  return out;
}

describe("実フィクスチャの人気・単勝オッズ", () => {
  it("中央 result_202602010605: 6 頭すべて人気とオッズが読める(独立に読み出した値と一致)", () => {
    expect(oddsByUmaban(loadFixture("result_202602010605.html"))).toEqual({
      2: [1, 1.3],
      1: [2, 4.0],
      3: [4, 12.0],
      5: [6, 50.7],
      6: [5, 28.3],
      4: [3, 9.7],
    });
  });

  it("地方 nar_result_202646071203: 6 頭すべて読める(地方も同じ位置の列)", () => {
    expect(oddsByUmaban(loadFixture("nar_result_202646071203.html"))).toEqual({
      4: [3, 5.8],
      1: [5, 13.1],
      3: [1, 2.2],
      5: [4, 7.3],
      2: [2, 2.7],
      6: [6, 13.1],
    });
  });

  it("3 着同着 result_202608040204: 同着の 2 頭ともそれぞれの人気・オッズを持つ(同着で値が潰れない)", () => {
    const horses = parseRaceResult(loadFixture("result_202608040204.html")).horses;
    const third = horses.filter((h) => h.finishPosition?.kind === "順位" && h.finishPosition.value === 3);
    expect(third.map((h) => [h.umaban, h.ninki, h.winOdds])).toEqual([
      [3, 9, 37.8],
      [9, 5, 21.3],
    ]);
    expect(horses).toHaveLength(16);
    expect(horses.every((h) => h.ninki !== null && h.winOdds !== null)).toBe(true);
  });

  it("除外 result_202605040205: 除外の馬(馬番 10)だけ人気・オッズが null で、他の 11 頭は読める", () => {
    const horses = parseRaceResult(loadFixture("result_202605040205.html")).horses;
    expect(horses).toHaveLength(12);
    const excluded = horses.filter((h) => h.finishPosition?.kind === "非数値");
    expect(excluded.map((h) => [h.umaban, h.finishPosition, h.ninki, h.winOdds])).toEqual([[10, { kind: "非数値", text: "除外" }, null, null]]);
    const others = horses.filter((h) => h.finishPosition?.kind === "順位");
    expect(others).toHaveLength(11);
    expect(others.every((h) => h.ninki !== null && h.winOdds !== null)).toBe(true);
    // 勝ち馬(馬番 7)と最下位(馬番 9)。除外の行が隣の列を拾ってずれていないこと。
    expect(oddsByUmaban(loadFixture("result_202605040205.html"))).toMatchObject({ 7: [2, 3.1], 9: [11, 199.9], 2: [1, 2.0] });
  });
});

describe("確定オッズの裏取り: 勝ち馬のオッズ × 100 = 単勝の確定払戻", () => {
  const FIXTURES = [
    "result_202602010605.html",
    "result_202602010607.html",
    "result_202603020203.html",
    "result_202603020211.html",
    "result_202606040810.html",
    "result_202607020501.html",
    "result_202607020502.html",
    "result_202607020505.html",
    "result_202605040205.html",
    "result_202608040204.html",
    "nar_result_202630062407.html",
    "nar_result_202644100810.html",
    "nar_result_202646071203.html",
    "nar_result_202654071201.html",
    "nar_result_202654071210.html",
    "nar_result_202654092706.html",
    "nar_result_202654092711.html",
  ];

  it("前提: 16 本以上(中央・地方の両方)で、勝ち馬ごとの検査が実際に走る", () => {
    let checked = 0;
    for (const name of FIXTURES) {
      const parsed = parseRaceResult(loadFixture(name));
      expect(parsed.winPayouts.length, `${name} に単勝の払戻がある`).toBeGreaterThan(0);
      for (const win of parsed.winPayouts) {
        const horse = parsed.horses.find((h) => h.umaban === win.umaban);
        expect(horse, `${name} 馬番 ${win.umaban}`).toBeDefined();
        expect(horse!.winOdds, `${name} 馬番 ${win.umaban} のオッズ`).not.toBeNull();
        expect(Math.round(horse!.winOdds! * 100), `${name} 馬番 ${win.umaban}`).toBe(win.payout);
        checked += 1;
      }
    }
    expect(FIXTURES.filter((f) => f.startsWith("nar_"))).toHaveLength(7);
    expect(FIXTURES.filter((f) => !f.startsWith("nar_"))).toHaveLength(10);
    expect(checked).toBeGreaterThanOrEqual(16);
  });
});

// ---- 合成 HTML(実物のフィクスチャが無いケース。以下は合成であり、実測由来ではない) ----

function headerRow(opts: { odds?: boolean; ninki?: boolean } = {}): string {
  return `<tr class="Header">
    <th class="Result_Num">着<br>順</th><th class="Waku">枠</th><th class="Num">馬<br>番</th><th class="Horse_Info">馬名</th>
    <th>性齢</th><th>斤量</th><th>騎手</th><th class="Time">タイム</th><th>着差</th>
    ${opts.ninki === false ? "" : "<th>人<br>気</th>"}
    ${opts.odds === false ? "" : '<th class="Odds">単勝<br>オッズ</th>'}
    <th>後3F</th><th>厩舎</th><th class="Weight">馬体重</th></tr>`;
}

function row(opts: { rank?: string; umaban: string; ninkiText?: string | null; oddsText?: string | null; dropCell?: boolean }): string {
  // ninkiText / oddsText が null のときは、そのセル自体を省略する(セル欠損の再現)。
  const ninkiCell = opts.ninkiText === null ? "" : `<td class="Odds Txt_C"><span class="OddsPeople">${opts.ninkiText ?? "1"}</span></td>`;
  const oddsCell = opts.oddsText === null ? "" : `<td class="Odds Txt_R"><span>${opts.oddsText ?? "2.5"}</span></td>`;
  return `<tr class="HorseList">
    <td class="Result_Num"><div class="Rank">${opts.rank ?? "1"}</div></td>
    <td class="Num Waku1"><div>1</div></td><td class="Num Txt_C"><div>${opts.umaban}</div></td>
    <td class="Horse_Info"><span class="Horse_Name"><a title="テスト馬${opts.umaban}">x</a></span></td>
    <td>牡4</td><td>55.0</td><td>騎手</td><td>1:30.0</td><td></td>
    ${ninkiCell}${oddsCell}
    ${opts.dropCell === true ? "" : "<td>36.0</td>"}
    <td>栗東</td><td>480(0)</td></tr>`;
}

function table(header: string, rows: string[]): string {
  return `<html><body><table id="All_Result_Table"><thead>${header}</thead><tbody>${rows.join("")}</tbody></table></body></html>`;
}

describe("合成 HTML: 欠損・異常の扱い(非 throw で null にフォールバック)", () => {
  it("合成の地方の除外: 人気・オッズのセルが空 → どちらも null(他の馬は読める)", () => {
    const html = table(headerRow(), [
      row({ rank: "1", umaban: "3", ninkiText: "2", oddsText: "4.5" }),
      row({ rank: "除外", umaban: "5", ninkiText: "", oddsText: "" }),
    ]);
    expect(oddsByUmaban(html)).toEqual({ 3: [2, 4.5], 5: [null, null] });
  });

  it.each([
    ["オッズが ---.-", "---.-"],
    ["オッズが **", "**"],
    ["オッズが 0.0(値域外)", "0.0"],
    ["オッズが 0.9(下限 1.0 未満)", "0.9"],
    ["オッズが負", "-1.5"],
    ["オッズが非数値", "不明"],
  ])("合成: %s → winOdds は null(人気は読む)", (_name, oddsText) => {
    const html = table(headerRow(), [row({ umaban: "1", ninkiText: "3", oddsText })]);
    expect(oddsByUmaban(html)).toEqual({ 1: [3, null] });
  });

  it.each([
    ["人気が 0", "0"],
    ["人気が **", "**"],
    ["人気が空", ""],
    ["人気が小数", "1.5"],
  ])("合成: %s → ninki は null(オッズは読む)", (_name, ninkiText) => {
    const html = table(headerRow(), [row({ umaban: "1", ninkiText, oddsText: "7.7" })]);
    expect(oddsByUmaban(html)).toEqual({ 1: [null, 7.7] });
  });

  it("合成: オッズ 1.0 は有効(下限ちょうど)", () => {
    const html = table(headerRow(), [row({ umaban: "1", ninkiText: "1", oddsText: "1.0" })]);
    expect(oddsByUmaban(html)).toEqual({ 1: [1, 1.0] });
  });

  it("合成: 行の td がヘッダより 1 つ少ない(セル欠損)行は、ずれた隣の列を拾わず null。同じ表の正常な行は読む", () => {
    const html = table(headerRow(), [
      row({ umaban: "1", ninkiText: "2", oddsText: "3.3" }),
      row({ umaban: "2", ninkiText: "4", oddsText: "9.9", dropCell: true }),
    ]);
    // 前提(空振り防止): 欠損行は td が 1 つ少ない。
    expect(html.match(/<tr class="HorseList">/g)).toHaveLength(2);
    expect(oddsByUmaban(html)).toEqual({ 1: [2, 3.3], 2: [null, null] });
  });

  it("合成: ヘッダに「人気」「単勝オッズ」の見出しが無い表では、位置を決め打ちせず両方 null", () => {
    const html = table(headerRow({ odds: false, ninki: false }), [row({ umaban: "1", ninkiText: null, oddsText: null })]);
    expect(oddsByUmaban(html)).toEqual({ 1: [null, null] });
  });

  it("合成: 片方の見出しだけ無い表では、ある方だけ読む", () => {
    const html = table(headerRow({ ninki: false }), [row({ umaban: "1", ninkiText: null, oddsText: "6.6" })]);
    expect(oddsByUmaban(html)).toEqual({ 1: [null, 6.6] });
  });
});
