/**
 * 馬連・馬単オッズの実測フィクスチャに対する構造不変条件テスト(Issue #103・#24-A)。
 *
 * `wide-trio-odds-fixtures.test.ts`(#13)と同じ目的・同じ流儀:
 * - 目的は「保存したフィクスチャが、調査記録(docs/quinella-exacta-odds-investigation.md)に
 *   記録した構造の実物であること」の固定であり、汎用パースではない
 * - 新しい本番モジュール(packages/core/src/scraper/parse-*.ts)は作らない
 * - 新しいpublic API(index.tsのexport)は増やさない
 * - 判定ロジックは本ファイル内に閉じ、JSON.parse / cheerio を直接使う
 *
 * **別ファイルにした理由(boss裁定・2026-09-23)**: `wide-trio-odds-fixtures.test.ts`の冒頭JSDocは
 * 「ワイド・3連複オッズの実測フィクスチャ」と自己定義しており、同居させるとこの散文が
 * 着手初日に偽になる。ヘルパ(pad2/setsEqual/expectedPairKeys)は**意図的に複製**している
 * (既存ファイルからexportして共有する形は「無改変で緑」という検出点を破るため禁止されている)。
 *
 * 馬単(exacta)は**着順が意味を持つ券種**であり、馬連(quinella)とは異なり
 * `expectedPairKeys`(組合せ C(n,2))を流用できない。`buildComboOddsKey`
 * (`packages/core/src/scraper/combo-odds-key.ts`)は昇順ソートして連結する実装のため、
 * これをそのまま使うと着順情報が失われる。本ファイルは`expectedOrderedPairKeys`(順列 P(n,2))を
 * 独立した関数として持ち、`expectedPairKeys`と同じヘルパに引数で分岐させる形にしていない。
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

/** 1〜n から選ぶ2頭の組合せ(馬番昇順、順不同)を「AABB」形式の文字列集合として返す(馬連用)。 */
function expectedPairKeys(n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 1; i <= n; i += 1) {
    for (let j = i + 1; j <= n; j += 1) {
      set.add(pad2(i) + pad2(j));
    }
  }
  return set;
}

/**
 * 1〜n から選ぶ2頭の順列(1着・2着の順序を持つ)を「AABB」形式の文字列集合として返す(馬単用)。
 * `expectedPairKeys`(組合せ)とは別関数(同一ヘルパに引数で分岐させない。boss裁定Q7)。
 */
function expectedOrderedPairKeys(n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (i === j) continue;
      set.add(pad2(i) + pad2(j));
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

/** NAR静的HTMLの `chk_..._{type}_c0_{a}_{b}` id から、馬番ペアのキー集合を「順序を保ったまま」取り出す。 */
function narOrderedPairCombos(html: string, type: string): Set<string> {
  const $ = cheerio.load(html);
  const set = new Set<string>();
  $(`td.Odds[id^="chk_"]`).each((_, el) => {
    const id = $(el).attr("id") ?? "";
    const m = new RegExp(`_${type}_c0_(\\d+)_(\\d+)$`).exec(id);
    if (m) {
      // 抽出順(1着相当・2着相当)をそのまま連結する。昇順ソートしない(馬単の着順を保存するため)。
      set.add(pad2(Number(m[1])) + pad2(Number(m[2])));
    }
  });
  return set;
}

describe("中央 JSON API(oddsApiUrl type=4/6)の実データ構造(Issue #103実測 2026-09-23)", () => {
  // 頭数(n=16)の根拠: fixtures/shutuba_202603020211.html を本番の parseShutuba に通すと
  // horses.length===16(#13で確認済みの既存フィクスチャを流用。同一race_idの馬連・馬単を
  // 新規取得したため、頭数の情報源も#13と同じものを独立に再利用できる)。
  describe("16頭・確定オッズ(race_id=202603020211。頭数はparseShutuba(fixtures/shutuba_202603020211.html).horses.lengthから独立に確認済み。#13で既に検証済みの事実を流用)", () => {
    const n = 16;

    it("馬連: 応答が空でなく、組合せ集合がC(16,2)=120通りと完全一致すること", () => {
      const json = loadCentralOdds("odds_quinella_202603020211.json", "4");
      const actual = new Set(Object.keys(json.data.odds["4"]!));
      expect(actual.size).toBe(120);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("馬連: 逆順キー(例\"0201\")が存在しないこと(順不同であることの確認)", () => {
      const json = loadCentralOdds("odds_quinella_202603020211.json", "4");
      const actual = new Set(Object.keys(json.data.odds["4"]!));
      expect(actual.has("0102")).toBe(true);
      expect(actual.has("0201")).toBe(false);
    });

    it("馬単: 応答が空でなく、組合せ集合がP(16,2)=240通りと完全一致すること(組合せC(16,2)=120の2倍)", () => {
      const json = loadCentralOdds("odds_exacta_202603020211.json", "6");
      const actual = new Set(Object.keys(json.data.odds["6"]!));
      expect(actual.size).toBe(240);
      expect(setsEqual(actual, expectedOrderedPairKeys(n))).toBe(true);
    });

    it("馬単: 全件で2要素目が\"0.0\"であること(下限・上限を持たない単一値であることの証跡)", () => {
      const json = loadCentralOdds("odds_exacta_202603020211.json", "6");
      const rows = Object.values(json.data.odds["6"]!);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row[1]).toBe("0.0");
      }
    });

    it("馬単: 同じ2頭の逆順(例\"0102\"と\"0201\")が別エントリとして異なる値を持つこと(無条件expect。着順が意味を持つ券種であることの直接証拠)", () => {
      const json = loadCentralOdds("odds_exacta_202603020211.json", "6");
      const odds = json.data.odds["6"]!;
      // 前提を無条件expectで先に固定(空振り防止): 両方のキーが実在すること。
      expect(odds["0102"]).toBeDefined();
      expect(odds["0201"]).toBeDefined();
      const forward = odds["0102"]![0];
      const backward = odds["0201"]![0];
      // 退化防止: 単純な文字列比較ではなく数値化して比較する(桁区切りカンマ等の表記差を吸収)。
      const forwardValue = Number(forward.replace(/,/g, ""));
      const backwardValue = Number(backward.replace(/,/g, ""));
      expect(forwardValue).not.toBe(backwardValue);

      // 1件だけでなく、逆順ペアの値が異なる組が複数存在することを全件走査で固定する
      // (退化した入力〈たまたま1組だけ違う〉ではないことの確認)。
      let differingCount = 0;
      const keys = Object.keys(odds);
      for (const key of keys) {
        const a = key.slice(0, 2);
        const b = key.slice(2, 4);
        const reversed = b + a;
        if (a === b) continue;
        if (!odds[reversed]) continue;
        const v1 = Number(odds[key]![0].replace(/,/g, ""));
        const v2 = Number(odds[reversed]![0].replace(/,/g, ""));
        if (v1 !== v2) differingCount += 1;
      }
      // P(16,2)=240件は120組の逆順ペアからなるため、走査対象は240件(重複カウント込み)。
      // 全件が異なる値を持つはずなので240件すべてが計上される。
      expect(differingCount).toBe(240);
    });
  });
});

describe("地方 静的HTML(narWideOddsPageUrl相当。type=b4/b6)の実データ構造(Issue #103実測 2026-09-23)", () => {
  // 頭数(n=12)の根拠: fixtures/nar_race_list_sub_20260712.htmlのentryCountから独立に確認済み
  // (#13で既に検証済みの事実を流用。同一race_idの馬連・馬単を新規取得したため頭数情報源も流用できる)。
  describe("12頭・確定オッズ(race_id=202654071210。頭数はfixtures/nar_race_list_sub_20260712.htmlのentryCountから独立に確認済み)", () => {
    const n = 12;

    it("馬連: 組合せ集合がC(12,2)=66通りと完全一致すること(軸馬別の制限を受けないことの確認)", () => {
      const html = loadFixture("nar_odds_b4_202654071210.html");
      expect(html.length).toBeGreaterThan(0);
      const actual = narOrderedPairCombos(html, "b4");
      expect(actual.size).toBe(66);
      expect(setsEqual(actual, expectedPairKeys(n))).toBe(true);
    });

    it("馬連: 全件がハイフン区切りの「幅」表記でなく単一値であること(ワイドとの構造差の確認)", () => {
      const html = loadFixture("nar_odds_b4_202654071210.html");
      const $ = cheerio.load(html);
      const rows: string[] = [];
      $(`td.Odds[id^="chk_"][id*="_b4_c0_"]`).each((_, el) => {
        rows.push($(el).text().trim());
      });
      expect(rows.length).toBe(66);
      for (const text of rows) {
        expect(text).not.toContain("-");
        expect(Number.isNaN(Number(text.replace(/,/g, "")))).toBe(false);
      }
    });

    it("馬単: 組合せ集合がP(12,2)=132通りと完全一致すること(軸馬別取得が不要で1リクエストで全件返ることの確認。3連複〈n-2回の軸馬別取得〉とは異なる)", () => {
      const html = loadFixture("nar_odds_b6_202654071210.html");
      expect(html.length).toBeGreaterThan(0);
      const actual = narOrderedPairCombos(html, "b6");
      expect(actual.size).toBe(132);
      expect(setsEqual(actual, expectedOrderedPairKeys(n))).toBe(true);
    });

    it("馬単: 全件がハイフン区切りの「幅」表記でなく単一値であること", () => {
      const html = loadFixture("nar_odds_b6_202654071210.html");
      const $ = cheerio.load(html);
      const rows: string[] = [];
      $(`td.Odds[id^="chk_"][id*="_b6_c0_"]`).each((_, el) => {
        rows.push($(el).text().trim());
      });
      expect(rows.length).toBe(132);
      for (const text of rows) {
        expect(text).not.toContain("-");
        expect(Number.isNaN(Number(text.replace(/,/g, "")))).toBe(false);
      }
    });

    it("馬単: 同じ2頭の逆順が別エントリとして異なる値を持つこと(無条件expect。地方側でも着順が意味を持つことの直接証拠)", () => {
      const html = loadFixture("nar_odds_b6_202654071210.html");
      const $ = cheerio.load(html);

      function cellText(a: number, b: number): string | undefined {
        const el = $(`td.Odds[id$="_b6_c0_${a}_${b}"]`);
        return el.length > 0 ? el.text().trim() : undefined;
      }

      // 前提を無条件expectで先に固定(空振り防止): 両方向のセルが実在すること。
      const forward = cellText(1, 2);
      const backward = cellText(2, 1);
      expect(forward).toBeDefined();
      expect(backward).toBeDefined();
      const forwardValue = Number(forward!.replace(/,/g, ""));
      const backwardValue = Number(backward!.replace(/,/g, ""));
      expect(forwardValue).not.toBe(backwardValue);

      // 全件走査: n=12全頭の順列112通り(P(12,2)=132)のうち、逆順ペアが存在し
      // かつ値が異なる組の件数を数える(退化防止。1組だけの偶然ではないことの確認)。
      let differingCount = 0;
      let comparedCount = 0;
      for (let a = 1; a <= n; a += 1) {
        for (let b = 1; b <= n; b += 1) {
          if (a === b) continue;
          const fwd = cellText(a, b);
          const bwd = cellText(b, a);
          if (fwd === undefined || bwd === undefined) continue;
          comparedCount += 1;
          const v1 = Number(fwd.replace(/,/g, ""));
          const v2 = Number(bwd.replace(/,/g, ""));
          if (v1 !== v2) differingCount += 1;
        }
      }
      // P(12,2)=132件全件が比較対象になり、全件で値が異なるはず。
      expect(comparedCount).toBe(132);
      expect(differingCount).toBe(132);
    });
  });
});
