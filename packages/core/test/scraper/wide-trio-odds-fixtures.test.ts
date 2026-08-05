/**
 * ワイド・3連複オッズの実測フィクスチャに対する構造不変条件テスト(機能D-1)。
 *
 * 目的は「保存したフィクスチャが、ドキュメント(docs/wide-trio-odds-investigation.md)に
 * 記録した構造の実物であること」の固定であり、汎用パースではない。そのため:
 * - 新しい本番モジュール(packages/core/src/scraper/parse-*.ts)は作らない
 * - 新しいpublic API(index.tsのexport)は増やさない
 * - 判定ロジックは本ファイル内に閉じ、JSON.parse / cheerio を直接使う
 *
 * 頭数(n)は各フィクスチャ自身から導出せず、既存の race_list_sub フィクスチャ
 * (parseRaceListで抽出したentryCount。2026-08-04実測)という独立した情報源から
 * 固定する。組合せ数が C(n,2)/C(n,3) と一致するかどうかを、そのnに対して検証する
 * (循環参照を避けるため)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む(既存テストと同じ解決方法)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 1〜nの馬番を2桁ゼロ埋めした文字列。 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 1〜n から選ぶ2頭の組合せ(馬番昇順)を「AABB」形式の文字列集合として返す。 */
function expectedPairKeys(n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 1; i <= n; i += 1) {
    for (let j = i + 1; j <= n; j += 1) {
      set.add(pad2(i) + pad2(j));
    }
  }
  return set;
}

/** 1〜n から選ぶ3頭の組合せ(馬番昇順)を「AABBCC」形式の文字列集合として返す。 */
function expectedTripleKeys(n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 1; i <= n; i += 1) {
    for (let j = i + 1; j <= n; j += 1) {
      for (let k = j + 1; k <= n; k += 1) {
        set.add(pad2(i) + pad2(j) + pad2(k));
      }
    }
  }
  return set;
}

/** 2つの文字列集合が完全一致するか(要素の過不足なし)。 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/** 中央オッズJSON API応答の型(このテストで使う範囲のみ)。 */
interface CentralOddsResponse {
  readonly status: string;
  readonly data: {
    readonly odds: Record<string, Record<string, [string, string, string]>>;
  };
}

function loadCentralOdds(filename: string, type: string): CentralOddsResponse {
  const json = JSON.parse(loadFixture(filename)) as CentralOddsResponse;
  // 前提を無条件で先に固定(空振り防止): 期待するtypeキーの束が存在すること。
  expect(json.data.odds[type]).toBeDefined();
  expect(Object.keys(json.data.odds[type]!).length).toBeGreaterThan(0);
  return json;
}

/** NAR静的HTMLの `chk_..._{type}_c0_{a}_{b}` id から馬番ペアのキー集合を取り出す。 */
function narPairCombos(html: string, type: string): Set<string> {
  const $ = cheerio.load(html);
  const set = new Set<string>();
  $(`td.Odds[id^="chk_"]`).each((_, el) => {
    const id = $(el).attr("id") ?? "";
    const m = new RegExp(`_${type}_c0_(\\d+)_(\\d+)$`).exec(id);
    if (m) {
      set.add(pad2(Number(m[1])) + pad2(Number(m[2])));
    }
  });
  return set;
}

/** NAR静的HTMLの `chk_..._{type}_c0_{a}_{b}_{c}` id から馬番トリオのキー集合を取り出す。 */
function narTripleCombos(html: string, type: string): Set<string> {
  const $ = cheerio.load(html);
  const set = new Set<string>();
  $(`td.Odds[id^="chk_"]`).each((_, el) => {
    const id = $(el).attr("id") ?? "";
    const m = new RegExp(`_${type}_c0_(\\d+)_(\\d+)_(\\d+)$`).exec(id);
    if (m) {
      set.add(pad2(Number(m[1])) + pad2(Number(m[2])) + pad2(Number(m[3])));
    }
  });
  return set;
}

describe("中央 JSON API(wideOddsApiUrl/trioOddsApiUrl)の実データ構造(機能D-1実測 2026-08-04)", () => {
  // 頭数(n=16)の根拠: fixtures/shutuba_202603020211.html を本番の parseShutuba に通すと
  // horses.length===16(実行して確認済み。単純な class="HorseList" の出現数カウントは
  // 読み込み用ダミー行2件を含むため18になり誤る。parseShutubaはtd.HorseInfoを持たない
  // 行を実データ行から除外している)。
  describe("16頭・確定オッズ(race_id=202603020211。頭数はparseShutuba(fixtures/shutuba_202603020211.html).horses.lengthから独立に確認済み)", () => {
    const n = 16;

    it("ワイド: 応答が空でなく、組合せ集合がC(16,2)=120通りと完全一致すること", () => {
      const json = loadCentralOdds("odds_wide_202603020211.json", "5");
      const actual = new Set(Object.keys(json.data.odds["5"]!));
      expect(actual.size).toBe(120);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("ワイド: 全組で下限<=上限であり、かつ差が0でない組が存在すること(退化した「幅」でないことの確認)", () => {
      const json = loadCentralOdds("odds_wide_202603020211.json", "5");
      const rows = Object.values(json.data.odds["5"]!);
      expect(rows.length).toBeGreaterThan(0);
      let hasNonZeroDiff = false;
      for (const [lowStr, highStr] of rows) {
        const low = Number(lowStr.replace(/,/g, ""));
        const high = Number(highStr.replace(/,/g, ""));
        expect(low).toBeLessThanOrEqual(high);
        if (high - low > 0) hasNonZeroDiff = true;
      }
      expect(hasNonZeroDiff).toBe(true);
    });

    it("3連複: 応答が空でなく、組合せ集合がC(16,3)=560通りと完全一致すること", () => {
      const json = loadCentralOdds("odds_trio_202603020211.json", "7");
      const actual = new Set(Object.keys(json.data.odds["7"]!));
      expect(actual.size).toBe(560);
      expect(setsEqual(actual, expectedTripleKeys(n))).toBe(true);
    });

    it("3連複: 全件で2要素目が\"0.0\"であること(下限・上限を持たない単一値であることの証跡)", () => {
      const json = loadCentralOdds("odds_trio_202603020211.json", "7");
      const rows = Object.values(json.data.odds["7"]!);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row[1]).toBe("0.0");
      }
    });
  });

  describe("6頭・確定オッズ(race_id=202602010605。頭数はfixtures/race_list_sub_20260628.htmlのentryCountから独立に確認済み)", () => {
    const n = 6;

    it("ワイド: 組合せ集合がC(6,2)=15通りと完全一致すること(発売されていたことの二次証拠)", () => {
      const json = loadCentralOdds("odds_wide_202602010605.json", "5");
      const actual = new Set(Object.keys(json.data.odds["5"]!));
      expect(actual.size).toBe(15);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("3連複: 組合せ集合がC(6,3)=20通りと完全一致すること(発売されていたことの二次証拠)", () => {
      const json = loadCentralOdds("odds_trio_202602010605.json", "7");
      const actual = new Set(Object.keys(json.data.odds["7"]!));
      expect(actual.size).toBe(20);
      expect(setsEqual(actual, expectedTripleKeys(n))).toBe(true);
    });
  });

  describe("5頭・確定オッズ(race_id=202603020203。頭数はfixtures/race_list_sub_20260628.htmlのentryCountから独立に確認済み)", () => {
    const n = 5;

    it("ワイド: 組合せ集合がC(5,2)=10通りと完全一致すること(発売されていたことの二次証拠)", () => {
      const json = loadCentralOdds("odds_wide_202603020203.json", "5");
      const actual = new Set(Object.keys(json.data.odds["5"]!));
      expect(actual.size).toBe(10);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("3連複: 組合せ集合がC(5,3)=10通りと完全一致すること(発売されていたことの二次証拠)", () => {
      const json = loadCentralOdds("odds_trio_202603020203.json", "7");
      const actual = new Set(Object.keys(json.data.odds["7"]!));
      expect(actual.size).toBe(10);
      expect(setsEqual(actual, expectedTripleKeys(n))).toBe(true);
    });
  });
});

describe("地方 静的HTML(narWideOddsPageUrl/narTrioOddsPageUrl)の実データ構造(機能D-1実測 2026-08-04)", () => {
  describe("12頭・確定オッズ(race_id=202654071210。頭数はfixtures/nar_race_list_sub_20260712.htmlのentryCountから独立に確認済み)", () => {
    const n = 12;

    it("ワイド: 組合せ集合がC(12,2)=66通りと完全一致すること(軸馬別の制限を受けないことの確認)", () => {
      const html = loadFixture("nar_odds_b5_202654071210.html");
      expect(html.length).toBeGreaterThan(0);
      const actual = narPairCombos(html, "b5");
      expect(actual.size).toBe(66);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("ワイド: 全組でテキストが「下限 - 上限」の昇順であり、かつ差が0でない組が存在すること", () => {
      const html = loadFixture("nar_odds_b5_202654071210.html");
      const $ = cheerio.load(html);
      const rows: string[] = [];
      $(`td.Odds[id^="chk_"][id*="_b5_c0_"]`).each((_, el) => {
        rows.push($(el).text().trim());
      });
      expect(rows.length).toBe(66);
      let hasNonZeroDiff = false;
      for (const text of rows) {
        const m = /^([\d,.]+)\s*-\s*([\d,.]+)$/.exec(text);
        expect(m).not.toBeNull();
        const low = Number(m![1]!.replace(/,/g, ""));
        const high = Number(m![2]!.replace(/,/g, ""));
        expect(low).toBeLessThanOrEqual(high);
        if (high - low > 0) hasNonZeroDiff = true;
      }
      expect(hasNonZeroDiff).toBe(true);
    });

    it("3連複(軸馬クエリ未指定): 組合せ集合はC(12,3)=220通りの一部(軸馬1固定のC(11,2)=55通り)にとどまり、全件が馬01を含むこと(軸馬別取得の証跡)", () => {
      const html = loadFixture("nar_odds_b7_202654071210.html");
      expect(html.length).toBeGreaterThan(0);
      const actual = narTripleCombos(html, "b7");
      expect(actual.size).toBe(55);
      const expectedAxis1 = new Set(
        [...expectedTripleKeys(n)].filter((k) => k.startsWith("01")),
      );
      expect(setsEqual(actual, expectedAxis1)).toBe(true);
      expect(actual.size).toBeLessThan(expectedTripleKeys(n).size);
    });

    it("3連複(jiku=2): 組合せ集合が「馬02を含む全トリオ」C(11,2)=55通りと完全一致すること(仮説「kを最小とするトリオのみ」の棄却。boss差し戻し対応)", () => {
      // 「jiku=k は k を含む全トリオを返す」(仮説X)か「k を最小とするトリオのみ返す」(仮説Y)かは
      // 軸1のフィクスチャだけでは区別できない(軸1では両者が一致するため)。軸2のフィクスチャで
      // 判別する: 仮説Xなら馬02を含む全トリオ(C(11,2)=55件、馬01を含む組も許容)、
      // 仮説Yなら馬02を最小とするトリオのみ(C(10,2)=45件、馬01を含む組は無い)。
      const html = loadFixture("nar_odds_b7_jiku2_202654071210.html");
      expect(html.length).toBeGreaterThan(0);
      const actual = narTripleCombos(html, "b7");
      expect(actual.size).toBe(55);

      const others = Array.from({ length: n }, (_, i) => i + 1).filter((h) => h !== 2);
      const hypothesisXContainsHorse2 = new Set<string>();
      for (let i = 0; i < others.length; i += 1) {
        for (let j = i + 1; j < others.length; j += 1) {
          const trio = [others[i]!, others[j]!, 2].sort((a, b) => a - b).map(pad2).join("");
          hypothesisXContainsHorse2.add(trio);
        }
      }
      expect(hypothesisXContainsHorse2.size).toBe(55);
      expect(setsEqual(actual, hypothesisXContainsHorse2)).toBe(true);

      // 仮説Y(kを最小とするトリオのみ)なら馬01を含む組は存在しないはずだが、実際には存在する。
      const containsHorse01 = [...actual].some((k) => k.startsWith("01"));
      expect(containsHorse01).toBe(true);
    });

    it("3連複: 軸1(202654071210)と軸2(jiku=2)の積集合がちょうど10件(馬01・馬02をともに含むトリオ)であること", () => {
      const axis1 = narTripleCombos(loadFixture("nar_odds_b7_202654071210.html"), "b7");
      const axis2 = narTripleCombos(loadFixture("nar_odds_b7_jiku2_202654071210.html"), "b7");
      const overlap = [...axis1].filter((k) => axis2.has(k));
      expect(overlap.length).toBe(10);
      // 積集合の全件が馬01・馬02の両方を含むこと(空振り防止の正のassert)。
      expect(overlap.every((k) => k.startsWith("01") && k.includes("02"))).toBe(true);
    });

    it("3連複の軸馬選択プルダウン(list_select_horse)が1〜n(全頭)を選択肢として提示すること(観測値。全組合せに必要な最小リクエスト数n-2とは異なる概念であることの区別)", () => {
      // 先頭に「現在選択中(軸1)」を表示するための重複option(selected属性付き)が1件あり、
      // 生のoption数は13(重複1+全選択肢12)になる。選択肢の「種類」を見るため値を重複除去する。
      const html = loadFixture("nar_odds_b7_202654071210.html");
      const $ = cheerio.load(html);
      const rawOptionCount = $("#list_select_horse option").length;
      expect(rawOptionCount).toBe(n + 1);
      const options = [
        ...new Set(
          $("#list_select_horse option")
            .map((_, el) => Number($(el).attr("value")))
            .get(),
        ),
      ].sort((a, b) => a - b);
      expect(options.length).toBe(n);
      expect(options).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    });

    it("3連複: td.Odds内に幅を表す「-」区切りテキストが無く単一値であること(ワイドとの構造差の確認)", () => {
      const html = loadFixture("nar_odds_b7_202654071210.html");
      const $ = cheerio.load(html);
      const rows: string[] = [];
      $(`td.Odds[id^="chk_"][id*="_b7_c0_"]`).each((_, el) => {
        rows.push($(el).text().trim());
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const text of rows) {
        expect(text).not.toContain("-");
        expect(Number.isNaN(Number(text.replace(/,/g, "")))).toBe(false);
      }
    });
  });

  describe("6頭・確定オッズ(race_id=202646071203。頭数はfixtures/nar_race_list_sub_20260712.htmlのentryCountから独立に確認済み)", () => {
    const n = 6;

    it("ワイド: 組合せ集合がC(6,2)=15通りと完全一致すること(発売されていたことの二次証拠)", () => {
      const html = loadFixture("nar_odds_b5_202646071203.html");
      const actual = narPairCombos(html, "b5");
      expect(actual.size).toBe(15);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("3連複(軸馬1固定): 組合せ集合がC(5,2)=10通りと完全一致すること(発売されていたことの二次証拠。軸馬別取得のため全体C(6,3)=20通りの一部)", () => {
      const html = loadFixture("nar_odds_b7_202646071203.html");
      const actual = narTripleCombos(html, "b7");
      expect(actual.size).toBe(10);
      const expectedAxis1 = new Set(
        [...expectedTripleKeys(n)].filter((k) => k.startsWith("01")),
      );
      expect(setsEqual(actual, expectedAxis1)).toBe(true);
    });
  });

  describe("7頭・確定オッズ(race_id=202630062407。頭数はfixtures/nar_race_list_sub_20260624.htmlのentryCountから独立に確認済み)", () => {
    const n = 7;

    it("ワイド: 組合せ集合がC(7,2)=21通りと完全一致すること(発売されていたことの二次証拠)", () => {
      const html = loadFixture("nar_odds_b5_202630062407.html");
      const actual = narPairCombos(html, "b5");
      expect(actual.size).toBe(21);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("3連複(軸馬1固定): 組合せ集合がC(6,2)=15通りと完全一致すること(発売されていたことの二次証拠。軸馬別取得のため全体C(7,3)=35通りの一部)", () => {
      const html = loadFixture("nar_odds_b7_202630062407.html");
      const actual = narTripleCombos(html, "b7");
      expect(actual.size).toBe(15);
      const expectedAxis1 = new Set(
        [...expectedTripleKeys(n)].filter((k) => k.startsWith("01")),
      );
      expect(setsEqual(actual, expectedAxis1)).toBe(true);
    });
  });
});

describe("result.html払戻テーブルとの突合(一次証拠。機能D-1実測 2026-08-04)", () => {
  /**
   * result.html の tr.Wide / tr.Fuku3 行から「馬番」と「払戻円」を取り出す
   * (テストファイル内に閉じた最小限のcheerio抽出。本番パーサではない)。
   */
  function payoutRow(html: string, className: string): { horses: string[]; yen: string[] } {
    const $ = cheerio.load(html);
    const $row = $(`tr.${className}`);
    const horses = $row
      .find("td.Result ul li span")
      .map((_, el) => $(el).text().trim())
      .get();
    const yen = $row
      .find("td.Payout span")
      .map((_, el) => $(el).text().trim())
      .get();
    return { horses, yen };
  }

  it("中央6頭(202602010605): result.htmlにtr.Wide・tr.Fuku3が存在し、払戻円が空でないこと(一次証拠)", () => {
    const html = loadFixture("result_202602010605.html");
    expect(html.length).toBeGreaterThan(0);
    // 正のassert併置(空振り防止): 単勝行(tr.Tansho)も同じフィクスチャに存在すること。
    const $ = cheerio.load(html);
    expect($("tr.Tansho").length).toBe(1);

    const wide = payoutRow(html, "Wide");
    expect(wide.horses.length).toBeGreaterThan(0);
    expect(wide.yen.length).toBeGreaterThan(0);
    expect(wide.yen.every((y) => /\d/.test(y))).toBe(true);

    const fuku3 = payoutRow(html, "Fuku3");
    expect(fuku3.horses.length).toBeGreaterThan(0);
    expect(fuku3.yen.length).toBeGreaterThan(0);
    expect(fuku3.yen.every((y) => /\d/.test(y))).toBe(true);
  });

  it("中央5頭(202603020203): result.htmlにtr.Wide・tr.Fuku3が存在し、払戻円が空でないこと(一次証拠)", () => {
    const html = loadFixture("result_202603020203.html");
    const $ = cheerio.load(html);
    expect($("tr.Tansho").length).toBe(1);

    const wide = payoutRow(html, "Wide");
    expect(wide.yen.length).toBeGreaterThan(0);
    expect(wide.yen.every((y) => /\d/.test(y))).toBe(true);

    const fuku3 = payoutRow(html, "Fuku3");
    expect(fuku3.yen.length).toBeGreaterThan(0);
    expect(fuku3.yen.every((y) => /\d/.test(y))).toBe(true);
  });

  it("地方6頭(202646071203): result.htmlにtr.Wide・tr.Fuku3が存在し、払戻円が空でないこと(一次証拠)", () => {
    const html = loadFixture("nar_result_202646071203.html");
    const $ = cheerio.load(html);
    expect($("tr.Tansho").length).toBe(1);

    const wide = payoutRow(html, "Wide");
    expect(wide.yen.length).toBeGreaterThan(0);
    expect(wide.yen.every((y) => /\d/.test(y))).toBe(true);

    const fuku3 = payoutRow(html, "Fuku3");
    expect(fuku3.yen.length).toBeGreaterThan(0);
    expect(fuku3.yen.every((y) => /\d/.test(y))).toBe(true);
  });

  it("地方7頭(202630062407): result.htmlにtr.Wide・tr.Fuku3が存在し、払戻円が空でないこと(一次証拠)", () => {
    const html = loadFixture("nar_result_202630062407.html");
    const $ = cheerio.load(html);
    expect($("tr.Tansho").length).toBe(1);

    const wide = payoutRow(html, "Wide");
    expect(wide.yen.length).toBeGreaterThan(0);
    expect(wide.yen.every((y) => /\d/.test(y))).toBe(true);

    const fuku3 = payoutRow(html, "Fuku3");
    expect(fuku3.yen.length).toBeGreaterThan(0);
    expect(fuku3.yen.every((y) => /\d/.test(y))).toBe(true);
  });
});
