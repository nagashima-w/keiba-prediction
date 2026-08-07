/**
 * combo-odds-key(組合せオッズキー生成・Map化の葉モジュール)のテスト(機能D-2b-A・Issue #32)。
 *
 * 対象: `buildComboOddsKey`(#14からの移設。仕様は不変)・`validateComboUmabans`・
 * `buildComboOddsCellMap`(受け入れ条件18: 重複組の値一致/不一致)・
 * `toComboOddsScalarMap`(受け入れ条件19: ワイド下限採用ルールの一箇所集約)。
 */
import { describe, expect, it } from "vitest";
import {
  buildComboOddsCellMap,
  buildComboOddsKey,
  ComboOddsKeyError,
  toComboOddsScalarMap,
  validateComboUmabans,
  type ComboOddsCell,
  type ComboOddsEntry,
} from "../../src/scraper/combo-odds-key.js";

describe("buildComboOddsKey(#14からの移設。既存の挙動を変えない)", () => {
  it("馬番を昇順ソートしてゼロ埋め連結すること", () => {
    expect(buildComboOddsKey([1, 2])).toBe("0102");
    expect(buildComboOddsKey([2, 1])).toBe("0102"); // 入力順に依らない
    expect(buildComboOddsKey([1, 2, 3])).toBe("010203");
    expect(buildComboOddsKey([12, 3])).toBe("0312");
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
