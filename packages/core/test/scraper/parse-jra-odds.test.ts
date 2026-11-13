/**
 * parse-jra-odds(JRA 公式サイトのオッズの頁のパーサ。Issue #672・#668-B)のテスト。
 * フィクスチャは `fixtures/jra_odds_*.html`(東京 8R `202605050208`。Shift_JIS のバイト列をデコードして読む)。
 * 実サイトへのリクエストは含まない。
 */
import { describe, expect, it } from "vitest";
import {
  buildComboOddsKey,
  buildOrderedComboOddsKey,
  parseComboOddsKey,
  toComboOddsScalarMap,
  type ComboBetType,
} from "../../src/scraper/combo-odds-key.js";
import { parseJraComboOdds, parseJraComboOddsWithHeader, parseJraWinPlaceOdds } from "../../src/scraper/parse-jra-odds.js";
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

  it("td.pop が計算した順位より優先される(合成: 馬番 14 の人気 4 を 9 に書き換えると 9 になる)", () => {
    const html = loadShiftJisFixture("jra_odds_tanpuku_ninki_202605050208.html");
    const edited = html.replace(/<td class="pop">4<\/td>/, '<td class="pop">9</td>');
    expect(edited).not.toBe(html); // 前提: 書き換えが当たった
    const r = parseJraWinPlaceOdds(edited, RACE_DATE);
    if (r.state !== "available") throw new Error("unreachable");
    expect(r.snapshot.win[14]?.ninki).toBe(9);
    expect(r.snapshot.place[14]?.ninki).toBe(9);
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

/** available を前提として先に固定し、組のMapを取り出す(空振り防止)。 */
function comboOf(file: string, betType: ComboBetType) {
  const result = parseJraComboOdds(loadShiftJisFixture(file), betType);
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error("unreachable");
  return result.odds;
}

describe("parseJraComboOdds(2要素の券種: 組の数・代表値。発売中と確定後)", () => {
  // 組の数は fixtures の HTML から別手段(python の正規表現)で数えた値。枠連は 8 枠の 36 組から、同枠が空の 2 組を引いた 34。
  it.each([
    ["bracketQuinella", "wakuren", 34],
    ["quinella", "umaren", 91],
    ["wide", "wide", 91],
    ["exacta", "umatan", 182],
  ] as const)("%s: 発売中・確定後とも %i 組", (betType, name, count) => {
    for (const file of [`jra_odds_${name}_202605050208.html`, `jra_odds_${name}_final_202605050208.html`]) {
      expect(comboOf(file, betType).size, file).toBe(count);
    }
  });

  it("馬連: 1-2 は発売中 137.5・確定 237.0、13-14 は 344.4・299.3。人気は null", () => {
    const a = comboOf("jra_odds_umaren_202605050208.html", "quinella");
    const b = comboOf("jra_odds_umaren_final_202605050208.html", "quinella");
    expect(a.get(buildComboOddsKey([1, 2]))).toEqual({ oddsMin: 137.5, oddsMax: null, ninki: null });
    expect(b.get(buildComboOddsKey([1, 2]))?.oddsMin).toBe(237.0);
    expect(a.get(buildComboOddsKey([13, 14]))?.oddsMin).toBe(344.4);
    expect(b.get(buildComboOddsKey([13, 14]))?.oddsMin).toBe(299.3);
  });

  it("ワイド: 幅を oddsMin / oddsMax に分ける(1-2 は 32.6-35.2、確定 51.9-56.6)", () => {
    const a = comboOf("jra_odds_wide_202605050208.html", "wide");
    const b = comboOf("jra_odds_wide_final_202605050208.html", "wide");
    expect(a.get(buildComboOddsKey([1, 2]))).toEqual({ oddsMin: 32.6, oddsMax: 35.2, ninki: null });
    expect(b.get(buildComboOddsKey([1, 2]))).toEqual({ oddsMin: 51.9, oddsMax: 56.6, ninki: null });
    expect(a.get(buildComboOddsKey([13, 14]))).toMatchObject({ oddsMin: 51.2, oddsMax: 53.4 });
  });

  it("馬連・ワイドは oddsMax が単一値の券種では null(馬連)、幅の券種では下限以上(ワイド)", () => {
    const wide = comboOf("jra_odds_wide_202605050208.html", "wide");
    expect(wide.size).toBe(91);
    for (const [key, cell] of wide) {
      expect(cell.oddsMin, key).not.toBeNull();
      expect(cell.oddsMax as number, key).toBeGreaterThanOrEqual(cell.oddsMin as number);
    }
    const q = comboOf("jra_odds_umaren_202605050208.html", "quinella");
    for (const cell of q.values()) expect(cell.oddsMax).toBeNull();
  });

  it("馬単: 順序付きキーで 1 桁目が 1 着(1→2 は 485.1、2→1 は 246.2 で別の値)。自分自身との組は作らない", () => {
    const a = comboOf("jra_odds_umatan_202605050208.html", "exacta");
    expect(a.get(buildOrderedComboOddsKey([1, 2]))?.oddsMin).toBe(485.1);
    expect(a.get(buildOrderedComboOddsKey([2, 1]))?.oddsMin).toBe(246.2);
    expect(a.get(buildOrderedComboOddsKey([14, 13]))?.oddsMin).toBe(970.3);
    expect(a.has(buildOrderedComboOddsKey([1, 1]))).toBe(false);
    expect(a.has("0101")).toBe(false);
    // 逆順の組が潰れていない(1→2 と 2→1 の両方が存在する)ことを組の数でも固定する
    expect(a.size).toBe(14 * 13);
  });

  it("枠連: 枠番のキー。同枠(1-1、2-2)は空きなのでキーを作らず、同枠でも値のある組(3-3 など)は残る", () => {
    const a = comboOf("jra_odds_wakuren_202605050208.html", "bracketQuinella");
    expect(a.get(buildComboOddsKey([1, 2]))?.oddsMin).toBe(73.4);
    expect(a.get(buildComboOddsKey([2, 3]))?.oddsMin).toBe(56.3);
    expect(a.has("0101")).toBe(false);
    expect(a.has("0202")).toBe(false);
    expect(a.has("0303")).toBe(true); // 枠 3 は 2 頭: 同枠の組が実在する
    expect(a.has("0102")).toBe(true);
  });

  it("確定後の頁の発売票数の表(div#votes)が組に混ざらない: 組の数が発売中と同じ", () => {
    const html = loadShiftJisFixture("jra_odds_umaren_final_202605050208.html");
    expect(html).toContain('id="votes"'); // 前提: 確定後の頁には発売票数の表がある
    expect(comboOf("jra_odds_umaren_final_202605050208.html", "quinella").size).toBe(91);
  });

  it("消費者への通し: toComboOddsScalarMap の値が下限、全キーが parseComboOddsKey で戻せる", () => {
    const wide = comboOf("jra_odds_wide_202605050208.html", "wide");
    const scalar = toComboOddsScalarMap(wide);
    expect(scalar.get("0102")).toBe(32.6);
    for (const key of wide.keys()) {
      const back = parseComboOddsKey(key);
      expect(back, key).not.toBeNull();
      expect(back).toHaveLength(2);
    }
  });
});

describe("parseJraComboOdds(読めなかった頁)", () => {
  it.each([
    ["空文字", ""],
    ["開催選択", loadShiftJisFixture("jra_odds_oli_20261108.html")],
    ["単勝・複勝の頁(組合せの表が無い)", loadShiftJisFixture("jra_odds_tanpuku_202605050208.html")],
  ])("%s は unavailable(throw しない)", (_n, html) => {
    expect(parseJraComboOdds(html, "quinella").state).toBe("unavailable");
  });

  it("券種と頁が食い違う(馬連の頁を馬単として読む)と unavailable", () => {
    const html = loadShiftJisFixture("jra_odds_umaren_202605050208.html");
    expect(parseJraComboOdds(html, "exacta").state).toBe("unavailable");
  });
});

describe("parseJraComboOdds(3連複・3連単)", () => {
  // 組の数は fixtures の HTML から別手段(python の正規表現)で数えた値(14頭: 14C3=364、14P3=2184)。
  it("3連複: 発売中・確定後とも 364 組。キーは昇順の3桁組、値は単一(oddsMax は null)", () => {
    for (const file of ["jra_odds_sanrenpuku_202605050208.html", "jra_odds_sanrenpuku_final_202605050208.html"]) {
      const m = comboOf(file, "trio");
      expect(m.size, file).toBe(364);
      for (const [key, cell] of m) {
        expect(parseComboOddsKey(key), key).toHaveLength(3);
        expect(cell.oddsMax).toBeNull();
      }
    }
    // 仮の値と同じ 99999.9 のセルは netkeiba のパーサと同じく null になる(`toComboOddsNumber`。偽陽性は保守側)。
    // 確定後の頁に 1 組だけある(1-3-11。python で数えた値)。発売中の頁には無い。
    const nulls = (m: ReadonlyMap<string, { oddsMin: number | null }>) => [...m.values()].filter((c) => c.oddsMin === null).length;
    expect(nulls(comboOf("jra_odds_sanrenpuku_202605050208.html", "trio"))).toBe(0);
    expect(nulls(comboOf("jra_odds_sanrenpuku_final_202605050208.html", "trio"))).toBe(1);
    expect(comboOf("jra_odds_sanrenpuku_final_202605050208.html", "trio").get("010311")?.oddsMin).toBeNull();
    const a = comboOf("jra_odds_sanrenpuku_202605050208.html", "trio");
    expect(a.get(buildComboOddsKey([1, 2, 3]))?.oddsMin).toBe(1058.5);
    expect(a.get(buildComboOddsKey([1, 2, 14]))?.oddsMin).toBe(285.5);
    expect(a.get(buildComboOddsKey([12, 13, 14]))?.oddsMin).toBe(1042.5);
  });

  it("3連複(軸馬1の頁): 1 を含む 78 組(= 13C2)だけを返す", () => {
    const m = comboOf("jra_odds_sanrenpuku_jiku01_202605050208.html", "trio");
    expect(m.size).toBe(78);
    for (const key of m.keys()) expect(parseComboOddsKey(key)![0]).toBe(1);
  });

  it("3連単: 確定後は 2184 組(票数なし 0。999999.9 の 1 組だけ仮の値として null)、発売中は票数なし 83 組を null で残して 2184 組", () => {
    const fin = comboOf("jra_odds_sanrentan_final_202605050208.html", "trifecta");
    expect(fin.size).toBe(2184);
    expect(loadShiftJisFixture("jra_odds_sanrentan_final_202605050208.html")).not.toContain("票数なし</td>");
    expect([...fin.values()].filter((c) => c.oddsMin === null)).toHaveLength(1);
    const mid = comboOf("jra_odds_sanrentan_202605050208.html", "trifecta");
    expect(mid.size).toBe(2184);
    expect([...mid.values()].filter((c) => c.oddsMin === null)).toHaveLength(83);
    // 前提: 確定後と発売中でキーの集合は同じ
    expect([...mid.keys()].sort()).toEqual([...fin.keys()].sort());
  });

  it("3連単: 順序付きキー(1着・2着・3着)。1→2→3 は 2949.0、2→1→3 は 8191.8 で別の値。14→13→1 は 12287.7", () => {
    const m = comboOf("jra_odds_sanrentan_202605050208.html", "trifecta");
    expect(m.get(buildOrderedComboOddsKey([1, 2, 3]))?.oddsMin).toBe(2949.0);
    expect(m.get(buildOrderedComboOddsKey([2, 1, 3]))?.oddsMin).toBe(8191.8);
    expect(m.get(buildOrderedComboOddsKey([14, 13, 1]))?.oddsMin).toBe(12287.7);
    expect(m.has(buildOrderedComboOddsKey([1, 2, 2]))).toBe(false); // 3着が2着と同じ組は空き
  });

  it("3連単(1着=1番の頁): 1 着が 1 の 13×12=156 組(うち票数なし 7)だけ", () => {
    const m = comboOf("jra_odds_sanrentan_jiku1_202605050208.html", "trifecta");
    expect(m.size).toBe(156);
    expect([...m.values()].filter((c) => c.oddsMin === null)).toHaveLength(7);
    for (const key of m.keys()) expect(parseComboOddsKey(key)![0]).toBe(1);
  });

  it("3連単: toComboOddsScalarMap に通すと票数なしは null のまま", () => {
    const scalar = toComboOddsScalarMap(comboOf("jra_odds_sanrentan_202605050208.html", "trifecta"));
    expect([...scalar.values()].filter((v) => v === null)).toHaveLength(83);
  });

  it("全組が票数なしの頁は unavailable(合成: 3連単の頁の数値セルを全部『票数なし』に置換)", () => {
    const html = loadShiftJisFixture("jra_odds_sanrentan_202605050208.html").replace(
      /<td>(<strong[^>]*>)?[0-9][0-9,.]*(<\/strong>)?<\/td>/g,
      '<td class="zero">票数なし</td>',
    );
    expect(html).toContain("票数なし");
    expect(parseJraComboOdds(html, "trifecta").state).toBe("unavailable");
  });
});

describe("parseJraComboOdds(構造の壊れ・計時)", () => {
  it("馬番が範囲外の行は throw(ComboOddsParseError)", () => {
    const html = loadShiftJisFixture("jra_odds_umaren_202605050208.html").replace(
      '<th scope="row">2</th>',
      '<th scope="row">99</th>',
    );
    expect(() => parseJraComboOdds(html, "quinella")).toThrow();
  });

  it("3連単の頁(約509KB)を1回パースした時間を標準エラーに出す(#673 の判断材料。値は環境依存で断定しない)", () => {
    const html = loadShiftJisFixture("jra_odds_sanrentan_202605050208.html");
    const t0 = performance.now();
    const r = parseJraComboOdds(html, "trifecta");
    const ms = performance.now() - t0;
    expect(r.state).toBe("available");
    console.error(`[計時] 3連単 ${html.length} 文字を parseJraComboOdds: ${ms.toFixed(0)}ms`);
  });
});

describe("parseJraComboOddsWithHeader(頁の見出しを添える。Issue #673 段階 A)", () => {
  const cases = [
    ["jra_odds_wakuren_202605050208.html", "bracketQuinella"],
    ["jra_odds_umaren_202605050208.html", "quinella"],
    ["jra_odds_wide_202605050208.html", "wide"],
    ["jra_odds_umatan_202605050208.html", "exacta"],
    ["jra_odds_sanrenpuku_202605050208.html", "trio"],
    ["jra_odds_sanrentan_202605050208.html", "trifecta"],
  ] as const;

  it.each(cases)("%s: 見出しは発売中・10:37。結果は parseJraComboOdds と同じ", (file, betType) => {
    const html = loadShiftJisFixture(file);
    const withHeader = parseJraComboOddsWithHeader(html, betType, RACE_DATE);
    expect(withHeader.header).toEqual({ oddsStatus: "middle", officialDatetime: "2026-11-08 10:37:00" });
    expect(withHeader.result.state).toBe("available");
    expect(withHeader.result).toEqual(parseJraComboOdds(html, betType));
  });

  it("確定後の頁は result・時刻 null。raceDate が null なら発売中の時刻も null(結果は変わらない)", () => {
    const fin = parseJraComboOddsWithHeader(loadShiftJisFixture("jra_odds_umaren_final_202605050208.html"), "quinella", RACE_DATE);
    expect(fin.header).toEqual({ oddsStatus: "result", officialDatetime: null });
    const noDate = parseJraComboOddsWithHeader(loadShiftJisFixture("jra_odds_umaren_202605050208.html"), "quinella", null);
    expect(noDate.header).toEqual({ oddsStatus: "middle", officialDatetime: null });
  });

  it("見出しの無い頁は header が null で unavailable", () => {
    const r = parseJraComboOddsWithHeader("<html><body></body></html>", "wide", RACE_DATE);
    expect(r.header).toBeNull();
    expect(r.result.state).toBe("unavailable");
  });
});

describe("parseJraWinPlaceOdds(馬の ID。Issue #732)", () => {
  const horseIdsOf = (file: string): Readonly<Record<number, string>> | undefined => {
    const result = parseJraWinPlaceOdds(loadShiftJisFixture(file), RACE_DATE);
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("unreachable");
    return result.horseIds;
  };
  it("馬の頁へのリンク(CNAME=pw01dud00 + 10 桁 + /検査値)から、馬番 → 馬の ID(10 桁)を読む。全 14 頭が 10 桁で、重複しない", () => {
    const ids = horseIdsOf("jra_odds_tanpuku_1342_202605050208.html")!;
    expect(ids[1]).toBe("2023101645"); // 1 番 ヒナノムサシ(リンクの CNAME=pw01dud002023101645/F6)
    expect(Object.keys(ids)).toHaveLength(14);
    expect(Object.values(ids).every((id) => /^\d{10}$/.test(id))).toBe(true);
    expect(new Set(Object.values(ids)).size).toBe(14);
  });
  it("確定後の頁・別のレースの頁でも読める(馬番の集合は単勝の馬と同じ)", () => {
    for (const file of ["jra_odds_tanpuku_final_202605050208.html", "jra_odds_tanpuku_saishu_202605050201.html"]) {
      const s = snapshotOf(file);
      const ids = horseIdsOf(file)!;
      expect(Object.keys(ids).length).toBeGreaterThan(0);
      expect(Object.keys(ids).sort()).toEqual(Object.keys(s.win).sort());
    }
  });
  it("リンクが無い・形が違う行は、その馬だけ ID を持たない(throw しない。単勝・複勝の値は読める)", () => {
    const html = loadShiftJisFixture("jra_odds_tanpuku_1342_202605050208.html").replace("pw01dud002023101645/F6", "pw01dud00XXXX/F6");
    const result = parseJraWinPlaceOdds(html, RACE_DATE);
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("unreachable");
    expect(result.horseIds![1]).toBeUndefined();
    expect(Object.keys(result.horseIds!)).toHaveLength(13);
    expect(result.snapshot.win[1]?.odds).toBe(66.2);
  });
});
