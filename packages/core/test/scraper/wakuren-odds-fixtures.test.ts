/**
 * 枠連オッズの実測フィクスチャに対する構造不変条件テスト(Issue #141・#26-A)。
 *
 * `trifecta-odds-fixtures.test.ts`(#127)・`quinella-exacta-odds-fixtures.test.ts`(#103)・
 * `wide-trio-odds-fixtures.test.ts`(#13)と同じ目的・同じ流儀:
 * - 目的は「保存したフィクスチャが、調査記録(docs/wakuren-odds-investigation.md)に
 *   記録した構造の実物であること」の固定であり、汎用パースではない
 * - 新しい本番モジュール(packages/core/src/scraper/parse-*.ts)は作らない
 * - 新しいpublic API(index.tsのexport)は増やさない
 * - 頭数・枠の構成は、本番の `parseShutuba` / `parseRaceResult` を独立の情報源として使う
 *   (オッズ側のキー集合から頭数を逆算しない。集合一致テストが自己参照になるのを避ける)
 *
 * **別ファイルにした理由**: 既存3ファイルの冒頭JSDocはそれぞれ別の券種の実測フィクスチャと
 * 自己定義しており、同居させるとその散文が偽になる。ヘルパ(pad2/setsEqual等)は
 * **意図的に複製**している(既存ファイルからexportして共有する形は「無改変で緑」という
 * 検出点を破るため禁止。#103のQ0裁定を踏襲)。
 *
 * `wakuren`(枠連)という命名は本ファイル・フィクスチャファイル名限定であり、
 * `ComboBetType`/`AllocationBetType`のメンバー名を決めるものではない
 * (docs/wakuren-odds-investigation.md §0参照。型の設計は後続の子Issueのスコープ)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む(既存テストと同じ解決方法)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 1〜nの数を2桁ゼロ埋めした文字列。 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 2つの文字列集合が完全一致するか(要素の過不足なし)。 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/** 枠番 → その枠の頭数。 */
type FrameCounts = ReadonlyMap<number, number>;

/** 馬の一覧(枠番)から枠ごとの頭数を数える。 */
function countFrames(wakubans: readonly (number | null)[]): FrameCounts {
  const map = new Map<number, number>();
  for (const w of wakubans) {
    // 前提を無条件expectで固定(空振り防止): 枠番が取れていること。
    expect(w).not.toBeNull();
    map.set(w!, (map.get(w!) ?? 0) + 1);
  }
  return map;
}

/**
 * 枠の構成から計算した枠連の期待キー集合(「AABB」形式。A<=B の昇順)。
 * 異なる2枠の組み合わせ C(枠数,2) に加え、**2頭以上が入る枠に限り**同枠(AA-AA)を含める。
 */
function expectedWakurenKeys(frames: FrameCounts): Set<string> {
  const ids = [...frames.keys()].sort((a, b) => a - b);
  const set = new Set<string>();
  for (let i = 0; i < ids.length; i += 1) {
    if (frames.get(ids[i]!)! >= 2) set.add(pad2(ids[i]!) + pad2(ids[i]!));
    for (let j = i + 1; j < ids.length; j += 1) {
      set.add(pad2(ids[i]!) + pad2(ids[j]!));
    }
  }
  return set;
}

/** 同枠(AA-AA)のキー数を数える。 */
function sameFrameKeyCount(keys: Iterable<string>): number {
  let count = 0;
  for (const k of keys) {
    if (k.slice(0, 2) === k.slice(2, 4)) count += 1;
  }
  return count;
}

/** 中央オッズJSON API応答の型(このテストで使う範囲のみ)。 */
interface CentralOddsResponse {
  readonly status: string;
  readonly data: {
    readonly odds: Record<string, Record<string, [string, string, string]>>;
  };
}

function loadCentralOdds(filename: string): Record<string, [string, string, string]> {
  const json = JSON.parse(loadFixture(filename)) as CentralOddsResponse;
  // 前提を無条件で先に固定(空振り防止): 枠連はtype="3"の束に入っていること。
  expect(json.status).toBe("result");
  expect(Object.keys(json.data.odds)).toEqual(["3"]);
  expect(Object.keys(json.data.odds["3"]!).length).toBeGreaterThan(0);
  return json.data.odds["3"]!;
}

/**
 * NAR静的HTML(枠連ページ)の `chk_..._b3_c0_{a}_{b}` id から、枠番ペアのキー集合を
 * 「AABB」形式で抽出する(値も同時に取得できるよう Map で返す。id→オッズ文字列)。
 * 同じセルがinput(checkbox)側にも同一idを持つため、初出の値(テキストを持つtd側)のみ採用する。
 */
function narWakurenOddsMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /id="chk_[^"]*_b3_c0_(\d+)_(\d+)"[^>]*>\s*([0-9,.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const key = pad2(Number(m[1])) + pad2(Number(m[2]));
    if (!map.has(key)) map.set(key, m[3]!);
  }
  return map;
}

/** 確定払戻ページの `tr.Wakuren`(枠連の払戻行)。行が無ければ null。 */
function wakurenPayout(html: string): { frames: [number, number]; yen: number; ninki: number } | null {
  const $ = cheerio.load(html);
  const row = $("tr.Wakuren");
  if (row.length === 0) return null;
  const nums = row
    .find("td.Result li span")
    .map((_, el) => Number($(el).text().trim()))
    .get();
  const yen = Number(row.find("td.Payout span").first().text().replace(/[,円]/g, ""));
  const ninki = Number(row.find("td.Ninki span").first().text().replace(/人気/, ""));
  expect(nums.length).toBe(2);
  return { frames: [nums[0]!, nums[1]!], yen, ninki };
}

/** `tr.Wakuren` の行数(枠連の払戻行が無い=枠連の発売なし)。 */
function wakurenRowCount(html: string): number {
  return cheerio.load(html)("tr.Wakuren").length;
}

/** オッズ文字列(カンマ区切り)を数値化する。 */
function toNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}

describe("中央 JSON API(oddsApiUrl type=3)の実データ構造(Issue #141実測 2026-09-29)", () => {
  it("枠連フラグメントの埋め込みJSが oddsType:'3' であること(type値の独立観測。番号を推測していない)", () => {
    const html = loadFixture("odds_get_form_b3_202603020211.html");
    const matches = html.match(/oddsType:'[0-9]*'/g);
    expect(matches).toEqual(["oddsType:'3'"]);
  });

  describe("16頭(全8枠が2頭ずつ。race_id=202603020211。期待36キー=C(8,2)28+同枠8)", () => {
    const shutuba = parseShutuba(loadFixture("shutuba_202603020211.html"));
    const framesOf = () => countFrames(shutuba.horses.map((h) => h.wakuban));

    it("出馬表の枠構成が16頭・8枠・全枠2頭であること(頭数の独立確認)", () => {
      expect(shutuba.horses.length).toBe(16);
      expect(framesOf().size).toBe(8);
      expect([...framesOf().values()]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    });

    it("枠連: キー集合が枠構成から計算した期待集合(36件。同枠8件を含む)と完全一致すること", () => {
      const odds = loadCentralOdds("odds_wakuren_202603020211.json");
      const actual = new Set(Object.keys(odds));
      const expected = expectedWakurenKeys(framesOf());
      expect(expected.size).toBe(36);
      expect(actual.size).toBe(36);
      expect(setsEqual(actual, expected)).toBe(true);
      // 同枠の買い目(0101〜0808)が実在すること。
      expect(sameFrameKeyCount(actual)).toBe(8);
    });

    it("枠連: 全件で2要素目が\"0.0\"であること(下限・上限を持たない単一値であることの証跡)", () => {
      const rows = Object.values(loadCentralOdds("odds_wakuren_202603020211.json"));
      expect(rows.length).toBe(36);
      for (const row of rows) {
        expect(row[1]).toBe("0.0");
      }
    });

    it("枠連: 確定払戻(4-7=3,150円・15人気)とキー\"0407\"のオッズ・人気が一致し、逆順キー\"0704\"は存在しないこと(昇順正規化の確認)", () => {
      const odds = loadCentralOdds("odds_wakuren_202603020211.json");
      const payout = wakurenPayout(loadFixture("result_202603020211.html"));
      // 前提を無条件expectで先に固定: 払戻行が存在し、4-7の3,150円であること。
      expect(payout).not.toBeNull();
      expect(payout!.frames).toEqual([4, 7]);
      expect(payout!.yen).toBe(3150);
      const entry = odds["0407"];
      expect(entry).toBeDefined();
      expect(toNumber(entry![0])).toBeCloseTo(payout!.yen / 100, 5);
      expect(Number(entry![2])).toBe(payout!.ninki);
      expect(odds["0704"]).toBeUndefined();
    });
  });

  describe("10頭(7・8枠のみ2頭。race_id=202602010607。期待30キー=C(8,2)28+同枠2)", () => {
    const shutuba = parseShutuba(loadFixture("shutuba_202602010607.html"));
    const framesOf = () => countFrames(shutuba.horses.map((h) => h.wakuban));

    it("枠連: キー集合が枠構成から計算した期待集合(30件。同枠は0707・0808の2件だけ)と完全一致すること", () => {
      expect(shutuba.horses.length).toBe(10);
      expect(framesOf().size).toBe(8);
      const odds = loadCentralOdds("odds_wakuren_202602010607.json");
      const actual = new Set(Object.keys(odds));
      const expected = expectedWakurenKeys(framesOf());
      expect(expected.size).toBe(30);
      expect(actual.size).toBe(30);
      expect(setsEqual(actual, expected)).toBe(true);
      // 1頭だけの枠には同枠の買い目が無い(0101が無い)ことを、実在する同枠キーを名指しして固定。
      expect([...actual].filter((k) => k.slice(0, 2) === k.slice(2, 4)).sort()).toEqual(["0707", "0808"]);
      expect(odds["0101"]).toBeUndefined();
    });

    it("枠連: 確定払戻(2-4=1,920円・10人気)とキー\"0204\"のオッズ・人気が一致すること", () => {
      const odds = loadCentralOdds("odds_wakuren_202602010607.json");
      const payout = wakurenPayout(loadFixture("result_202602010607.html"));
      expect(payout).not.toBeNull();
      expect(payout!.frames).toEqual([2, 4]);
      expect(payout!.yen).toBe(1920);
      const entry = odds["0204"];
      expect(entry).toBeDefined();
      expect(toNumber(entry![0])).toBeCloseTo(payout!.yen / 100, 5);
      expect(Number(entry![2])).toBe(payout!.ninki);
      expect(odds["0402"]).toBeUndefined();
    });
  });

  describe("9頭(8枠のみ2頭。race_id=202607020501。枠番は確定払戻ページの結果テーブルから取得〈AC-A8の代替〉。期待29キー=C(8,2)28+同枠1)", () => {
    const result = parseRaceResult(loadFixture("result_202607020501.html"));
    const framesOf = () => countFrames(result.horses.map((h) => h.wakuban));

    it("枠連: キー集合が枠構成から計算した期待集合(29件。同枠は0808の1件だけ)と完全一致すること", () => {
      expect(result.horses.length).toBe(9);
      expect(framesOf().size).toBe(8);
      expect(framesOf().get(8)).toBe(2);
      const odds = loadCentralOdds("odds_wakuren_202607020501.json");
      const actual = new Set(Object.keys(odds));
      const expected = expectedWakurenKeys(framesOf());
      expect(expected.size).toBe(29);
      expect(actual.size).toBe(29);
      expect(setsEqual(actual, expected)).toBe(true);
      expect([...actual].filter((k) => k.slice(0, 2) === k.slice(2, 4))).toEqual(["0808"]);
    });

    it("枠連: 確定払戻(1-8=550円・2人気)とキー\"0108\"のオッズ・人気が一致すること", () => {
      const odds = loadCentralOdds("odds_wakuren_202607020501.json");
      const payout = wakurenPayout(loadFixture("result_202607020501.html"));
      expect(payout).not.toBeNull();
      expect(payout!.frames).toEqual([1, 8]);
      expect(payout!.yen).toBe(550);
      const entry = odds["0108"];
      expect(entry).toBeDefined();
      expect(toNumber(entry![0])).toBeCloseTo(5.5, 5);
      expect(Number(entry![2])).toBe(payout!.ninki);
    });
  });
});

describe("地方 静的HTML(type=b3)の実データ構造(Issue #141実測 2026-09-29)", () => {
  describe("12頭(5〜8枠が2頭ずつ。race_id=202654071210。期待32キー=C(8,2)28+同枠4)", () => {
    const shutuba = parseShutuba(loadFixture("nar_shutuba_202654071210.html"));
    const framesOf = () => countFrames(shutuba.horses.map((h) => h.wakuban));

    it("枠連: 1リクエストのHTMLに全組合せが載り、キー集合が期待集合(32件。同枠4件)と完全一致すること", () => {
      expect(shutuba.horses.length).toBe(12);
      const html = loadFixture("nar_odds_b3_202654071210.html");
      const map = narWakurenOddsMap(html);
      const actual = new Set(map.keys());
      const expected = expectedWakurenKeys(framesOf());
      expect(expected.size).toBe(32);
      expect(actual.size).toBe(32);
      expect(setsEqual(actual, expected)).toBe(true);
      expect([...actual].filter((k) => k.slice(0, 2) === k.slice(2, 4)).sort()).toEqual([
        "0505",
        "0606",
        "0707",
        "0808",
      ]);
    });

    it("枠連: 軸馬選択のプルダウン要素(<select>・list_select_horse)が存在しないこと(軸馬別取得が不要であることの証跡。JSのコメントに名前が残るのみ)", () => {
      const html = loadFixture("nar_odds_b3_202654071210.html");
      expect(cheerio.load(html)("select#list_select_horse").length).toBe(0);
      expect(cheerio.load(html)("select").length).toBe(0);
    });

    it("枠連: 確定払戻(5-6=1,070円・2人気)とid\"..._b3_c0_5_6\"のオッズが一致し、逆順\"0605\"は存在しないこと", () => {
      const map = narWakurenOddsMap(loadFixture("nar_odds_b3_202654071210.html"));
      const payout = wakurenPayout(loadFixture("nar_result_202654071210.html"));
      expect(payout).not.toBeNull();
      expect(payout!.frames).toEqual([5, 6]);
      expect(payout!.yen).toBe(1070);
      const entry = map.get("0506");
      expect(entry).toBeDefined();
      expect(toNumber(entry!)).toBeCloseTo(payout!.yen / 100, 5);
      expect(map.has("0605")).toBe(false);
    });
  });

  describe("9頭(8枠のみ2頭。race_id=202654092706。枠番は確定払戻ページの結果テーブルから取得〈AC-A8の代替〉。期待29キー)", () => {
    const result = parseRaceResult(loadFixture("nar_result_202654092706.html"));
    const framesOf = () => countFrames(result.horses.map((h) => h.wakuban));

    it("枠連: キー集合が枠構成から計算した期待集合(29件。同枠は0808の1件だけ)と完全一致すること", () => {
      expect(result.horses.length).toBe(9);
      expect(framesOf().get(8)).toBe(2);
      const map = narWakurenOddsMap(loadFixture("nar_odds_b3_202654092706.html"));
      const actual = new Set(map.keys());
      const expected = expectedWakurenKeys(framesOf());
      expect(expected.size).toBe(29);
      expect(actual.size).toBe(29);
      expect(setsEqual(actual, expected)).toBe(true);
      expect([...actual].filter((k) => k.slice(0, 2) === k.slice(2, 4))).toEqual(["0808"]);
    });

    it("枠連: 確定払戻(3-8=760円・2人気)とid\"..._b3_c0_3_8\"のオッズが一致すること", () => {
      const map = narWakurenOddsMap(loadFixture("nar_odds_b3_202654092706.html"));
      const payout = wakurenPayout(loadFixture("nar_result_202654092706.html"));
      expect(payout).not.toBeNull();
      expect(payout!.frames).toEqual([3, 8]);
      expect(payout!.yen).toBe(760);
      const entry = map.get("0308");
      expect(entry).toBeDefined();
      expect(toNumber(entry!)).toBeCloseTo(7.6, 5);
    });
  });
});

describe("発売の頭数境界(枠連の払戻行 tr.Wakuren の有無。Issue #141実測 2026-09-29)", () => {
  /** [確定払戻フィクスチャ, 頭数(結果テーブルの行数), 枠連の払戻行があるか] */
  const central: [string, number, boolean][] = [
    ["result_202603020203.html", 5, false],
    ["result_202602010605.html", 6, false],
    ["result_202607020502.html", 7, false],
    ["result_202607020505.html", 8, false],
    ["result_202607020501.html", 9, true],
    ["result_202602010607.html", 10, true],
    ["result_202603020211.html", 16, true],
  ];
  const nar: [string, number, boolean][] = [
    ["nar_result_202646071203.html", 6, false],
    ["nar_result_202630062407.html", 7, false],
    ["nar_result_202654092711.html", 8, false],
    ["nar_result_202654092706.html", 9, true],
    ["nar_result_202654071210.html", 12, true],
  ];

  it.each(central)("中央 %s: 頭数%i・枠連の払戻行は %s", (file, headCount, sold) => {
    const html = loadFixture(file);
    expect(parseRaceResult(html).horses.length).toBe(headCount);
    expect(wakurenRowCount(html)).toBe(sold ? 1 : 0);
  });

  it.each(nar)("地方 %s: 頭数%i・枠連の払戻行は %s", (file, headCount, sold) => {
    const html = loadFixture(file);
    expect(parseRaceResult(html).horses.length).toBe(headCount);
    expect(wakurenRowCount(html)).toBe(sold ? 1 : 0);
  });

  it("境界: 中央・地方とも「8頭以下は枠連の払戻行なし・9頭以上は払戻行あり」に整合し、8頭と9頭が両側に実在すること", () => {
    for (const rows of [central, nar]) {
      const unsold = rows.filter(([, , sold]) => !sold).map(([, n]) => n);
      const sold = rows.filter(([, , sold]) => sold).map(([, n]) => n);
      // 前提を無条件expectで固定(空振り防止): 両側の標本が存在し、境界をまたぐ8頭・9頭を含むこと。
      expect(unsold).toContain(8);
      expect(sold).toContain(9);
      expect(Math.max(...unsold)).toBeLessThan(Math.min(...sold));
    }
  });
});

describe("頭数不足で枠連が売られないレースのオッズ応答形状(②発売なし。Issue #141実測 2026-09-29)", () => {
  it("中央: 7頭・8頭とも type=3 は status:\"NG\"・data:\"\"・reason:\"empty free odds schedule\"(#103の中央presaleと同一の封筒)であること", () => {
    for (const name of ["odds_wakuren_unsold_202607020502.json", "odds_wakuren_unsold_202607020505.json"]) {
      const json = JSON.parse(loadFixture(name)) as Record<string, unknown>;
      expect(json.status).toBe("NG");
      expect(json.data).toBe("");
      expect(json.reason).toBe("empty free odds schedule");
    }
  });

  it.each([
    ["nar_odds_b3_unsold_202630062407.html", 7],
    ["nar_odds_b3_unsold_202654092711.html", 8],
  ] as const)(
    "地方 %s(%i頭): 通常の発売ページ構造(#odds_select)のまま、枠連セルが8枠ぶんの28件(同枠なし)すべて\"0.0\"であること(presaleのフォールバックとは別の形状)",
    (file, headCount) => {
      // 頭数の根拠: 確定払戻フィクスチャの結果テーブルの行数(境界テストと同じ情報源)。
      const resultFile = file === "nar_odds_b3_unsold_202630062407.html" ? "nar_result_202630062407.html" : "nar_result_202654092711.html";
      expect(parseRaceResult(loadFixture(resultFile)).horses.length).toBe(headCount);
      const html = loadFixture(file);
      expect(html).toContain('id="odds_select"');
      const map = narWakurenOddsMap(html);
      // 頭数(7・8)によらず 8枠ぶんの C(8,2)=28 件。7頭でも8枠目のセルがある。
      expect(map.size).toBe(28);
      expect(sameFrameKeyCount(map.keys())).toBe(0);
      for (const v of map.values()) {
        expect(v).toBe("0.0");
      }
      // 8枠目のセルは、実在しない枠(7頭立てなら8枠)のものも含む。
      expect(map.has("0708")).toBe(true);
    },
  );
});
