/**
 * combo-odds-key(組合せオッズキー生成・Map化の葉モジュール)のテスト(機能D-2b-A・Issue #32、
 * 軸間マージは機能D-2b-B・Issue #33第3段AC-1)。
 *
 * 対象: `buildComboOddsKey`(#14からの移設。仕様は不変)・`validateComboUmabans`・
 * `buildComboOddsCellMap`(受け入れ条件18: 重複組の値一致/不一致)・
 * `toComboOddsScalarMap`(受け入れ条件19: ワイド下限採用ルールの一箇所集約)・
 * `mergeAxisComboOddsMaps`(#33 Q1裁定: 軸間の同一キー衝突は保守側〈oddsMin最小・nullは任意の数値より
 * 保守的〉を採用してマージする。throwしない)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildComboOddsCellMap,
  buildComboOddsKey,
  ComboOddsKeyError,
  mergeAxisComboOddsMaps,
  parseComboOddsKey,
  toComboOddsScalarMap,
  validateComboUmabans,
  type AxisComboOddsMap,
  type ComboOddsCell,
  type ComboOddsEntry,
} from "../../src/scraper/combo-odds-key.js";
import { parseNarComboOdds } from "../../src/scraper/parse-nar-combo-odds.js";

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む(既存テストと同じ解決方法)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("buildComboOddsKey(#14からの移設。既存の挙動を変えない)", () => {
  it("馬番を昇順ソートしてゼロ埋め連結すること", () => {
    expect(buildComboOddsKey([1, 2])).toBe("0102");
    expect(buildComboOddsKey([2, 1])).toBe("0102"); // 入力順に依らない
    expect(buildComboOddsKey([1, 2, 3])).toBe("010203");
    expect(buildComboOddsKey([12, 3])).toBe("0312");
  });
});

describe("parseComboOddsKey(buildComboOddsKeyの逆操作。Issue #55: 過去分析の配分提案を馬番表示に戻すためのデコーダ)", () => {
  it("2桁ごとに区切って馬番配列(昇順)へ復元すること(複勝1頭・ワイド2頭・3連複3頭)", () => {
    expect(parseComboOddsKey("04")).toEqual([4]);
    expect(parseComboOddsKey("0407")).toEqual([4, 7]);
    expect(parseComboOddsKey("040709")).toEqual([4, 7, 9]);
  });

  it("buildComboOddsKeyが生成したキーを完全に往復復元できること(合成のラウンドトリップ)", () => {
    expect(parseComboOddsKey(buildComboOddsKey([7, 4]))).toEqual([4, 7]);
    expect(parseComboOddsKey(buildComboOddsKey([12, 3, 8]))).toEqual([3, 8, 12]);
  });

  it.each([
    ["空文字列", ""],
    ["奇数桁(2桁区切りにならない)", "040"],
    ["数字以外の文字を含む", "0X"],
    ["馬番が1未満(00)", "00"],
    ["馬番が19以上(上限18を超える)", "19"],
    ["空白を含む", "04 7"],
  ])("%s(%s)はnullを返すこと(throwしない)", (_label, rawKey) => {
    expect(parseComboOddsKey(rawKey)).toBeNull();
  });
});

describe("validateComboUmabans(構造の最低条件。throw側)", () => {
  it("要素数がcomboSizeと一致しない場合はComboOddsKeyErrorを投げること", () => {
    expect(() => validateComboUmabans([1, 2, 3], 2)).toThrow(ComboOddsKeyError);
    expect(() => validateComboUmabans([1], 2)).toThrow(ComboOddsKeyError);
  });

  it("馬番が1〜18の範囲外(0・19)の場合は投げること", () => {
    expect(() => validateComboUmabans([0, 5], 2)).toThrow(ComboOddsKeyError);
    expect(() => validateComboUmabans([5, 19], 2)).toThrow(ComboOddsKeyError);
  });

  it("厳密な昇順でない(同値・降順)場合は投げること(buildComboOddsKeyが黙ってソートしてしまうため、この検証を別に持つ必要がある)", () => {
    expect(() => validateComboUmabans([2, 1], 2)).toThrow(ComboOddsKeyError);
    expect(() => validateComboUmabans([1, 1], 2)).toThrow(ComboOddsKeyError);
    expect(() => validateComboUmabans([3, 2, 1], 3)).toThrow(ComboOddsKeyError);
  });

  it("正常な昇順・範囲内の組は例外を投げないこと", () => {
    expect(() => validateComboUmabans([1, 2], 2)).not.toThrow();
    expect(() => validateComboUmabans([1, 2, 18], 3)).not.toThrow();
  });
});

describe("buildComboOddsCellMap(重複組の扱い。受け入れ条件18)", () => {
  const cellA: ComboOddsCell = { oddsMin: 5.0, oddsMax: 6.0, ninki: 3 };
  const cellB: ComboOddsCell = { oddsMin: 9.0, oddsMax: null, ninki: null };

  it("重複の無い正常なエントリ列をキー付きMapに変換すること", () => {
    const entries: ComboOddsEntry[] = [
      { umabans: [1, 2], cell: cellA },
      { umabans: [1, 3], cell: cellB },
    ];
    const map = buildComboOddsCellMap(entries);
    expect(map.size).toBe(2);
    expect(map.get("0102")).toEqual(cellA);
    expect(map.get("0103")).toEqual(cellB);
  });

  it("同じ組が複数回現れても値が完全一致すれば1件として受理すること(合成データ。自分たちの不変条件の検証)", () => {
    const entries: ComboOddsEntry[] = [
      { umabans: [1, 2], cell: cellA },
      { umabans: [2, 1], cell: cellA }, // 順序違いでも同じ組
    ];
    const map = buildComboOddsCellMap(entries);
    expect(map.size).toBe(1);
    expect(map.get("0102")).toEqual(cellA);
  });

  it("同じ組で値が食い違う場合は黙って後勝ちにせず例外を投げること(合成データ。自分たちの不変条件の検証)", () => {
    const entries: ComboOddsEntry[] = [
      { umabans: [1, 2], cell: cellA },
      { umabans: [1, 2], cell: cellB },
    ];
    expect(() => buildComboOddsCellMap(entries)).toThrow(ComboOddsKeyError);
  });
});

describe("buildComboOddsCellMapの自己防御(構造検証と数値検証の非対称の再発防止。code-reviewer指摘4)", () => {
  const cellA: ComboOddsCell = { oddsMin: 5.0, oddsMax: null, ninki: null };

  it("呼び出し元が事前検証していなくても、NaNを含む馬番の組は投げること(修正前は buildComboOddsKey([NaN,5]) が \"NaN05\" として黙って混入していた。カナリア)", () => {
    const entries: ComboOddsEntry[] = [
      { umabans: [Number.NaN, 5], cell: cellA },
      { umabans: [1, 2], cell: cellA },
    ];
    expect(() => buildComboOddsCellMap(entries)).toThrow(ComboOddsKeyError);
  });

  it("Infinityを含む馬番の組は投げること(カナリア)", () => {
    const entries: ComboOddsEntry[] = [{ umabans: [Number.POSITIVE_INFINITY, 5], cell: cellA }];
    expect(() => buildComboOddsCellMap(entries)).toThrow(ComboOddsKeyError);
  });

  it("小数(非整数)の馬番を含む組は投げること(カナリア)", () => {
    const entries: ComboOddsEntry[] = [{ umabans: [1.5, 2], cell: cellA }];
    expect(() => buildComboOddsCellMap(entries)).toThrow(ComboOddsKeyError);
  });

  it("範囲外(0・19)の馬番を含む組は投げること(カナリア)", () => {
    expect(() => buildComboOddsCellMap([{ umabans: [0, 5], cell: cellA }])).toThrow(ComboOddsKeyError);
    expect(() => buildComboOddsCellMap([{ umabans: [5, 19], cell: cellA }])).toThrow(ComboOddsKeyError);
  });

  it("昇順・重複はbuildComboOddsCellMap自身では検証しないこと(順序違いの組を1件に集約する既存の望ましい性質と両立させるため、要素数・昇順を含めた構造検証は呼び出し元がvalidateComboUmabansで行う設計。空振り防止の対照)", () => {
    // このテストの前提: [2,1]はbuildComboOddsKeyにより正しく"0102"へ正規化される
    // (buildComboOddsKeyの単体テストで別途固定済み)。ここではbuildComboOddsCellMapが
    // 順序違反を理由に例外を投げないことだけを確認する。
    expect(() => buildComboOddsCellMap([{ umabans: [2, 1], cell: cellA }])).not.toThrow();
  });

  it("正常な組は従来どおり例外を投げず、健全な候補が異常値に巻き添えで失われないこと(空振り防止の対照)", () => {
    const entries: ComboOddsEntry[] = [
      { umabans: [1, 2], cell: cellA },
      { umabans: [3, 4], cell: cellA },
    ];
    const map = buildComboOddsCellMap(entries);
    expect(map.size).toBe(2);
  });
});

describe("toComboOddsScalarMap(ワイド下限採用ルールの一箇所集約。受け入れ条件19)", () => {
  it("各セルのoddsMinをスカラー値として取り出すこと(ワイド=下限、3連複=単一値そのもの)", () => {
    const cells = new Map<string, ComboOddsCell>([
      ["0102", { oddsMin: 5.0, oddsMax: 6.0, ninki: 3 }], // ワイド想定
      ["010203", { oddsMin: 260.2, oddsMax: null, ninki: 103 }], // 3連複想定
    ]);
    const scalarMap = toComboOddsScalarMap(cells);
    expect(scalarMap.size).toBe(2);
    expect(scalarMap.get("0102")).toBe(5.0);
    expect(scalarMap.get("010203")).toBe(260.2);
  });

  it("oddsMinがnull(欠損)のセルはnullのまま引き継ぐこと(黙って0等に丸めない)", () => {
    const cells = new Map<string, ComboOddsCell>([
      ["0102", { oddsMin: null, oddsMax: null, ninki: null }],
    ]);
    const scalarMap = toComboOddsScalarMap(cells);
    expect(scalarMap.get("0102")).toBeNull();
  });
});

describe("mergeAxisComboOddsMaps(実フィクスチャ: jiku1/jiku2の重なりで衝突が0件であることの反証固定。#33第3段 boss裁定0)", () => {
  /**
   * boss が先に引いた反証(2026-08-07、追加リクエスト0): jiku1(cb881a8取得)とjiku2(57f6fcc取得、
   * 約2.2日前)を突き合わせた結果、重なり(馬01・馬02をともに含むトリオ)10件のうち値が食い違った
   * ものは0件だった。ただし対象レースは終了済みで確定オッズが凍結されているため、この一致は
   * 「軸間で値は動かない」ことの証拠にはならない(衝突は合成データでしか再現できない。後続の
   * describeで検証する)。本テストは「重なりが必ず存在し、マージ経路が実際に通ること」と
   * 「その重なりで衝突0件」という観測事実を固定する。
   */
  it("jiku1・jiku2(いずれも12頭)をマージすると、55+55-10=100件になり、重なり10件が1件も落ちず、衝突が0件であること", () => {
    const jiku1 = parseNarComboOdds(loadFixture("nar_odds_b7_jiku1_202654071210.html"), "trio");
    const jiku2 = parseNarComboOdds(loadFixture("nar_odds_b7_jiku2_202654071210.html"), "trio");
    expect(jiku1.state).toBe("available");
    expect(jiku2.state).toBe("available");
    if (jiku1.state !== "available" || jiku2.state !== "available") throw new Error("unreachable");
    // 前提固定(空振り防止): 両軸とも55件、重なりは10件であること。
    expect(jiku1.odds.size).toBe(55);
    expect(jiku2.odds.size).toBe(55);
    const overlapKeys = [...jiku1.odds.keys()].filter((k) => jiku2.odds.has(k));
    expect(overlapKeys.length).toBe(10);

    const maps: AxisComboOddsMap[] = [
      { axis: 1, odds: jiku1.odds },
      { axis: 2, odds: jiku2.odds },
    ];
    const { odds, conflicts } = mergeAxisComboOddsMaps(maps);

    expect(odds.size).toBe(100);
    expect(conflicts.length).toBe(0); // 反証: この実フィクスチャの重なりでは衝突が発生しない
    for (const key of overlapKeys) {
      expect(odds.has(key)).toBe(true); // 重なり10件が1件も落ちないこと
    }
  });
});

describe("mergeAxisComboOddsMaps(衝突の解決規則。合成データ。#33第3段 Q1裁定〈実フィクスチャでは衝突を再現できないため〉)", () => {
  it("数値同士が食い違う場合は小さい方(保守側)のセルが丸ごと採られること", () => {
    const key = buildComboOddsKey([1, 2, 3]);
    const maps: AxisComboOddsMap[] = [
      { axis: 1, odds: new Map([[key, { oddsMin: 5.0, oddsMax: null, ninki: null }]]) },
      { axis: 2, odds: new Map([[key, { oddsMin: 3.0, oddsMax: null, ninki: null }]]) },
    ];
    const { odds, conflicts } = mergeAxisComboOddsMaps(maps);
    expect(odds.get(key)).toEqual({ oddsMin: 3.0, oddsMax: null, ninki: null });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.kind).toBe("numeric");
  });

  it("片方がnull・片方が数値の場合はnull側のセルが採られること(nullは任意の数値より保守的)", () => {
    const key = buildComboOddsKey([1, 2, 3]);
    const maps: AxisComboOddsMap[] = [
      { axis: 1, odds: new Map([[key, { oddsMin: null, oddsMax: null, ninki: null }]]) },
      { axis: 2, odds: new Map([[key, { oddsMin: 3.0, oddsMax: null, ninki: null }]]) },
    ];
    const { odds, conflicts } = mergeAxisComboOddsMaps(maps);
    expect(odds.get(key)).toEqual({ oddsMin: null, oddsMax: null, ninki: null });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.kind).toBe("nullWin");
  });

  it("軸の投入順序を入れ替えても結果が同一であること(順序非依存)", () => {
    const key = buildComboOddsKey([1, 2, 3]);
    const mapA: AxisComboOddsMap = {
      axis: 1,
      odds: new Map([[key, { oddsMin: 5.0, oddsMax: null, ninki: null }]]),
    };
    const mapB: AxisComboOddsMap = {
      axis: 2,
      odds: new Map([[key, { oddsMin: 3.0, oddsMax: null, ninki: null }]]),
    };
    const forward = mergeAxisComboOddsMaps([mapA, mapB]);
    const backward = mergeAxisComboOddsMaps([mapB, mapA]);
    expect(forward.odds).toEqual(backward.odds);
    expect(forward.conflicts).toEqual(backward.conflicts);
  });

  it("勝った側のセルがoddsMax/ninkiを含めて丸ごと採られ、フィールドが混ざらないこと(どのスナップショットにも無かった合成セルを作らない)", () => {
    const key = buildComboOddsKey([1, 2]); // ワイド想定(oddsMax/ninkiが意味を持つ形)
    const maps: AxisComboOddsMap[] = [
      { axis: 1, odds: new Map([[key, { oddsMin: 5.0, oddsMax: 8.0, ninki: 3 }]]) },
      { axis: 2, odds: new Map([[key, { oddsMin: 3.0, oddsMax: 9.0, ninki: 1 }]]) },
    ];
    const { odds } = mergeAxisComboOddsMaps(maps);
    // oddsMinが小さい軸2が勝つ。oddsMax/ninkiも軸2のものがそのまま採られる(軸1のoddsMax=8.0と
    // 混ざって{oddsMin:3.0, oddsMax:8.0,...}のような合成セルにならないこと)。
    expect(odds.get(key)).toEqual({ oddsMin: 3.0, oddsMax: 9.0, ninki: 1 });
  });

  it("完全同値(全フィールド一致)は衝突に計上しないこと(冪等)", () => {
    const conflictKey = buildComboOddsKey([1, 2, 3]);
    const equalKey = buildComboOddsKey([1, 2, 4]);
    const maps: AxisComboOddsMap[] = [
      {
        axis: 1,
        odds: new Map([
          [conflictKey, { oddsMin: 5.0, oddsMax: null, ninki: null }],
          [equalKey, { oddsMin: 7.0, oddsMax: null, ninki: null }],
        ]),
      },
      {
        axis: 2,
        odds: new Map([
          [conflictKey, { oddsMin: 3.0, oddsMax: null, ninki: null }],
          [equalKey, { oddsMin: 7.0, oddsMax: null, ninki: null }], // conflictKeyとは異なりequalKeyは完全同値
        ]),
      },
    ];
    const { odds, conflicts } = mergeAxisComboOddsMaps(maps);
    expect(odds.get(equalKey)).toEqual({ oddsMin: 7.0, oddsMax: null, ninki: null });
    // 衝突として計上されるのはconflictKeyのみ(equalKeyは完全同値のため計上されない)。
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.key).toBe(conflictKey);
  });

  it("衝突エントリは軸昇順で保持されること(入力順ではなく軸番号でソートされる)", () => {
    const key = buildComboOddsKey([1, 2, 3]);
    const maps: AxisComboOddsMap[] = [
      { axis: 5, odds: new Map([[key, { oddsMin: 3.0, oddsMax: null, ninki: null }]]) },
      { axis: 2, odds: new Map([[key, { oddsMin: 5.0, oddsMax: null, ninki: null }]]) },
    ];
    const { conflicts } = mergeAxisComboOddsMaps(maps);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.entries.map((e) => e.axis)).toEqual([2, 5]);
  });

  it("3軸以上にまたがる衝突でも保守側(最小値)が採られること", () => {
    const key = buildComboOddsKey([1, 2, 3]);
    const maps: AxisComboOddsMap[] = [
      { axis: 1, odds: new Map([[key, { oddsMin: 5.0, oddsMax: null, ninki: null }]]) },
      { axis: 2, odds: new Map([[key, { oddsMin: 3.0, oddsMax: null, ninki: null }]]) },
      { axis: 3, odds: new Map([[key, { oddsMin: 4.0, oddsMax: null, ninki: null }]]) },
    ];
    const { odds, conflicts } = mergeAxisComboOddsMaps(maps);
    expect(odds.get(key)).toEqual({ oddsMin: 3.0, oddsMax: null, ninki: null });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.entries.length).toBe(3);
  });

  it("軸をまたがない組(1つの軸にしか現れない組)は無条件にそのまま採用されること(衝突なし)", () => {
    const keyOnlyAxis1 = buildComboOddsKey([1, 9, 10]);
    const maps: AxisComboOddsMap[] = [
      { axis: 1, odds: new Map([[keyOnlyAxis1, { oddsMin: 12.0, oddsMax: null, ninki: null }]]) },
      { axis: 2, odds: new Map() },
    ];
    const { odds, conflicts } = mergeAxisComboOddsMaps(maps);
    expect(odds.size).toBe(1);
    expect(odds.get(keyOnlyAxis1)).toEqual({ oddsMin: 12.0, oddsMax: null, ninki: null });
    expect(conflicts.length).toBe(0);
  });
});
