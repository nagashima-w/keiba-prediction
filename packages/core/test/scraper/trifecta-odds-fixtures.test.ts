/**
 * 三連単オッズの実測フィクスチャに対する構造不変条件テスト(Issue #127・#25-A)。
 *
 * `wide-trio-odds-fixtures.test.ts`(#13)・`quinella-exacta-odds-fixtures.test.ts`(#103)と
 * 同じ目的・同じ流儀:
 * - 目的は「保存したフィクスチャが、調査記録(docs/trifecta-odds-investigation.md)に
 *   記録した構造の実物であること」の固定であり、汎用パースではない
 * - 新しい本番モジュール(packages/core/src/scraper/parse-*.ts)は作らない
 * - 新しいpublic API(index.tsのexport)は増やさない
 * - 判定ロジックは本ファイル内に閉じ、JSON.parse / cheerio を直接使う
 *
 * **別ファイルにした理由**: 既存2ファイルの冒頭JSDocはそれぞれ「ワイド・3連複」
 * 「馬連・馬単」の実測フィクスチャと自己定義しており、同居させるとこの散文が着手初日に偽になる。
 * ヘルパ(pad2/setsEqual等)は**意図的に複製**している(既存ファイルからexportして共有する形は
 * 「無改変で緑」という検出点を破るため禁止されている。#103のQ0裁定を踏襲)。
 *
 * `trifecta`(三連単)という命名は本ファイル・フィクスチャファイル名限定であり、
 * `ComboBetType`/`AllocationBetType`のメンバー名を決めるものではない
 * (docs/trifecta-odds-investigation.md §0参照。型の設計は#128のスコープ)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * 1〜n から選ぶ3頭の順列(1着・2着・3着の順序を持つ)を「AABBCC」形式の文字列集合として返す
 * (三連単用。3連複の`expectedTripleKeys`〈組合せ〉とは異なる)。
 */
function expectedOrderedTripleKeys(n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (j === i) continue;
      for (let k = 1; k <= n; k += 1) {
        if (k === i || k === j) continue;
        set.add(pad2(i) + pad2(j) + pad2(k));
      }
    }
  }
  return set;
}

/**
 * 1着を`first`に固定した、1〜n(firstを除く)から選ぶ2頭の順列(2着・3着)を
 * 「AABBCC」形式の文字列集合として返す(地方の軸馬別取得1軸ぶんの期待集合)。
 */
function expectedOrderedTripleKeysWithFixedFirst(n: number, first: number): Set<string> {
  const set = new Set<string>();
  for (let j = 1; j <= n; j += 1) {
    if (j === first) continue;
    for (let k = 1; k <= n; k += 1) {
      if (k === first || k === j) continue;
      set.add(pad2(first) + pad2(j) + pad2(k));
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

/**
 * NAR静的HTML(三連単フラグメント)の `chk_..._b8_c0_{a}_{b}_{c}` id から、
 * 馬番トリオのキー集合を「着順を保ったまま(ソートしない)」抽出する。
 * 値も同時に取得できるよう Map で返す(id→オッズ文字列)。
 */
function narOrderedTripleOddsMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  // id="chk_...  _b8_c0_A_B_C" の直後、同じtd要素内のテキスト(カンマ区切りの数値)を取り出す。
  // 属性(cart-item・onClick等)を挟んでから値が続くため、`[^>]*>`で属性部分をまとめてスキップする。
  const re = /id="chk_[^"]*_b8_c0_(\d+)_(\d+)_(\d+)"[^>]*>\s*([0-9,.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const key = pad2(Number(m[1])) + pad2(Number(m[2])) + pad2(Number(m[3]));
    // 同じセルがinput(checkbox)側にも同一idを持つため、初出の値のみ採用する(テキストを持つtd側)。
    if (!map.has(key)) {
      map.set(key, m[4]!);
    }
  }
  return map;
}

describe("中央 JSON API(oddsApiUrl type=8)の実データ構造(Issue #127実測 2026-09-26)", () => {
  // 頭数(n=16)の根拠: fixtures/shutuba_202603020211.html を本番の parseShutuba に通すと
  // horses.length===16(#13・#103で確認済みの既存フィクスチャを流用)。
  describe("16頭・確定オッズ(race_id=202603020211。頭数は既存フィクスチャから独立に確認済みの事実を流用)", () => {
    const n = 16;

    it("三連単: 応答が空でなく、組合せ集合がP(16,3)=3360通りと完全一致すること", () => {
      const json = loadCentralOdds("odds_trifecta_202603020211.json", "8");
      const actual = new Set(Object.keys(json.data.odds["8"]!));
      expect(actual.size).toBe(3360);
      expect(setsEqual(actual, expectedOrderedTripleKeys(n))).toBe(true);
    });

    it("三連単: 全件で2要素目が\"0.0\"であること(下限・上限を持たない単一値であることの証跡)", () => {
      const json = loadCentralOdds("odds_trifecta_202603020211.json", "8");
      const rows = Object.values(json.data.odds["8"]!);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row[1]).toBe("0.0");
      }
    });

    it("三連単: 完全反転(1着↔3着入替、2着はそのまま)のペアが別エントリとして異なる値を持つ件数が3356件であること(無条件expect。着順が意味を持つ券種であることの直接証拠。4件は丸め表示の偶然一致で人気は異なる=退化ではない)", () => {
      const json = loadCentralOdds("odds_trifecta_202603020211.json", "8");
      const odds = json.data.odds["8"]!;
      // 前提を無条件expectで先に固定(空振り防止): 代表的な1組(130805↔050813)が両方実在すること。
      expect(odds["130805"]).toBeDefined();
      expect(odds["050813"]).toBeDefined();
      const forwardValue = Number(odds["130805"]![0].replace(/,/g, ""));
      const backwardValue = Number(odds["050813"]![0].replace(/,/g, ""));
      expect(forwardValue).not.toBe(backwardValue);

      // 全件走査(3360件)。完全反転(abc→cba)の値差異件数を数える。
      let comparedCount = 0;
      let differingCount = 0;
      for (const key of Object.keys(odds)) {
        const a = key.slice(0, 2);
        const b = key.slice(2, 4);
        const c = key.slice(4, 6);
        const reversed = c + b + a;
        if (!odds[reversed]) continue;
        comparedCount += 1;
        const v1 = Number(odds[key]![0].replace(/,/g, ""));
        const v2 = Number(odds[reversed]![0].replace(/,/g, ""));
        if (v1 !== v2) differingCount += 1;
      }
      // 3360件全件が比較対象になるはず(自己反転〈回文〉となる3頭の並びは存在しないため)。
      expect(comparedCount).toBe(3360);
      // 実測値: 3356件が異なる値、4件(2組)は丸め表示が偶然一致(docs §5.1参照)。
      // 差=0は「全件同じ」への退化、差=3360は「1件も一致しない」への過度な一般化を防ぐため、
      // 実測どおりの3356を無条件expectで固定する。
      expect(differingCount).toBe(3356);
    });

    it("三連単: 中央の確定払戻(13→8→5=52,690円)とキー\"130805\"のオッズが一致すること(AC-A3(b)。キーの1桁目が1着であることの決定的証拠)", () => {
      const json = loadCentralOdds("odds_trifecta_202603020211.json", "8");
      const odds = json.data.odds["8"]!;
      const entry = odds["130805"];
      expect(entry).toBeDefined();
      // fixtures/result_202603020211.html の確定払戻 52,690円 ÷ 100 = 526.9。
      expect(Number(entry![0].replace(/,/g, ""))).toBeCloseTo(526.9, 5);
    });
  });
});

describe("地方 静的HTML軸馬別取得(type=b8、jiku指定)の実データ構造(Issue #127実測 2026-09-26)", () => {
  // 頭数(n=12)の根拠: fixtures/nar_race_list_sub_20260712.htmlのentryCountから独立に確認済み
  // (#13・#103で既に検証済みの事実を流用)。
  const n = 12;

  describe("軸馬1固定(既定表示。race_id=202654071210)", () => {
    it("三連単(軸馬1固定): 組合せ集合が「1着=1固定」のP(11,2)=110通りと完全一致すること(軸馬別取得の証跡)", () => {
      const html = loadFixture("nar_odds_b8_202654071210.html");
      expect(html.length).toBeGreaterThan(0);
      const map = narOrderedTripleOddsMap(html);
      const actual = new Set(map.keys());
      expect(actual.size).toBe(110);
      expect(setsEqual(actual, expectedOrderedTripleKeysWithFixedFirst(n, 1))).toBe(true);
    });
  });

  describe("軸馬2固定(jiku=2。変数を1つだけ変える検証で「1着固定」仮説を確定した軸)", () => {
    it("三連単(軸馬2固定): 組合せ集合が「1着=2固定」のP(11,2)=110通りと完全一致すること(3連複の「含む」〈k非固定〉とは異なり、先頭が2で統一されることの確認)", () => {
      const html = loadFixture("nar_odds_b8_jiku2_202654071210.html");
      const map = narOrderedTripleOddsMap(html);
      const actual = new Set(map.keys());
      expect(actual.size).toBe(110);
      expect(setsEqual(actual, expectedOrderedTripleKeysWithFixedFirst(n, 2))).toBe(true);

      // 前提を無条件expectで先に固定(空振り防止): 全キーの先頭2桁が"02"であること
      // (3連複のjiku=2は「2を含む」だけで先頭固定にならないのに対し、三連単は先頭固定になる違い)。
      for (const key of actual) {
        expect(key.slice(0, 2)).toBe("02");
      }
    });
  });

  describe("軸馬5固定(jiku=5。地方の確定払戻突合に使用)", () => {
    it("三連単(軸馬5固定): 組合せ集合が「1着=5固定」のP(11,2)=110通りと完全一致すること", () => {
      const html = loadFixture("nar_odds_b8_jiku5_202654071210.html");
      const map = narOrderedTripleOddsMap(html);
      const actual = new Set(map.keys());
      expect(actual.size).toBe(110);
      expect(setsEqual(actual, expectedOrderedTripleKeysWithFixedFirst(n, 5))).toBe(true);
    });

    it("三連単: 地方の確定払戻(5→7→1=260,090円)とid\"..._b8_c0_5_7_1\"のオッズが一致すること(AC-A3(b))", () => {
      const html = loadFixture("nar_odds_b8_jiku5_202654071210.html");
      const map = narOrderedTripleOddsMap(html);
      const entry = map.get("050701");
      expect(entry).toBeDefined();
      // fixtures/nar_result_202654071210.html の確定払戻 260,090円 ÷ 100 = 2600.9。
      expect(Number(entry!.replace(/,/g, ""))).toBeCloseTo(2600.9, 5);
    });

    it("三連単(軸馬5固定): 2着・3着を入れ替えたペアが全110件で異なる値を持つこと(無条件expect。退化防止)", () => {
      const html = loadFixture("nar_odds_b8_jiku5_202654071210.html");
      const map = narOrderedTripleOddsMap(html);
      // 前提を無条件expectで先に固定(空振り防止): 代表例(5_7_1↔5_1_7)が両方実在すること。
      expect(map.get("050701")).toBeDefined();
      expect(map.get("050107")).toBeDefined();
      const forward = Number(map.get("050701")!.replace(/,/g, ""));
      const backward = Number(map.get("050107")!.replace(/,/g, ""));
      expect(forward).not.toBe(backward);

      let comparedCount = 0;
      let differingCount = 0;
      for (const key of map.keys()) {
        const first = key.slice(0, 2);
        const second = key.slice(2, 4);
        const third = key.slice(4, 6);
        const swapped = first + third + second;
        if (!map.has(swapped)) continue;
        comparedCount += 1;
        const v1 = Number(map.get(key)!.replace(/,/g, ""));
        const v2 = Number(map.get(swapped)!.replace(/,/g, ""));
        if (v1 !== v2) differingCount += 1;
      }
      expect(comparedCount).toBe(110);
      expect(differingCount).toBe(110);
    });
  });

  describe("軸馬1・2・5の3ファイル間で組合せが重複しないこと(先頭馬番が互いに異なることの直接証拠)", () => {
    it("3軸(1・2・5)を合計した330件がすべて相異なるキーであること", () => {
      const axis1 = new Set(narOrderedTripleOddsMap(loadFixture("nar_odds_b8_202654071210.html")).keys());
      const axis2 = new Set(narOrderedTripleOddsMap(loadFixture("nar_odds_b8_jiku2_202654071210.html")).keys());
      const axis5 = new Set(narOrderedTripleOddsMap(loadFixture("nar_odds_b8_jiku5_202654071210.html")).keys());
      // 前提を無条件expectで先に固定(空振り防止): 各軸が110件であること。
      expect(axis1.size).toBe(110);
      expect(axis2.size).toBe(110);
      expect(axis5.size).toBe(110);

      const union = new Set([...axis1, ...axis2, ...axis5]);
      expect(union.size).toBe(330);
    });
  });
});

describe("地方presale(未発売)の三連単フォールバック(Issue #127実測 2026-09-26)", () => {
  it("presale時は#odds_selectが存在せず#odds_view_formが存在し、三連単の組合せセルが0件であること(#13・#103と同型のフォールバック)", () => {
    const html = loadFixture("nar_odds_b8_presale_202654092701_20260926.html");
    expect(html).not.toContain('id="odds_select"');
    expect(html).toContain('id="odds_view_form"');
    const map = narOrderedTripleOddsMap(html);
    expect(map.size).toBe(0);
  });

  it("presale時は軸馬選択プルダウン(list_select_horse)も存在しないこと(発売中の三連単ページ固有のUIであることの確認)", () => {
    const html = loadFixture("nar_odds_b8_presale_202654092701_20260926.html");
    expect(html).not.toContain('id="list_select_horse"');
  });
});
