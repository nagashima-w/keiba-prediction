import { describe, expect, it } from "vitest";
import { toNinki, toNinkiFromJson } from "../../src/scraper/ninki.js";

/**
 * 共有ヘルパ `toNinki`(Issue #34)の直接テスト。
 * 単勝・複勝(中央)・ワイド/3連複(中央)・地方(NAR)の3パーサすべてが本ヘルパに委譲するため、
 * ここで契約を1箇所に固定する。
 */
describe("toNinki(人気文字列の数値化。Issue #34)", () => {
  // 条件A0: すべて `toBe`/`toBeNull` で値として比較する(述語検査は使わない)。
  // 条件A': 期待値列に null と非null の両方が含まれる。
  // 条件B: 入力列と期待値列のベクトルが全行を通じて一致しない(入力を変えずに期待値だけ
  //         書き換えるような空振りテーブルになっていないことを目視でも保証する)。
  it.each<[unknown, number | null, string]>([
    ["0", null, '"0"は人気の値域外(1始まり)のため欠損表現としてnull'],
    ["00", null, '"00"も数値化すると0になるためnull'],
    ["", null, "空文字は非数値のためnull"],
    ["---.-", null, "オッズ的な非数値表記もnullのため合わせて確認"],
    [5, null, "数値型そのもの(文字列でない)はnull"],
    [null, null, "nullはnull"],
    [undefined, null, "undefinedはnull"],
    [[], null, "配列(非文字列)はnull"],
    ["1", 1, '"1"は1'],
    ["12", 12, '"12"は12'],
    [" 7 ", 7, "前後空白はtrimしてから数値化する"],
    ["103", 103, "3連複の人気は組合せ数まで達するため上限は課さない(例: 103)"],
  ])("入力 %j は %j になること(%s)", (raw, expected) => {
    expect(toNinki(raw)).toBe(expected);
  });
});

/**
 * `toNinkiFromJson`(Issue #75)の直接テスト。
 * 重賞の過去10年結果API(`parse-grade-winner.ts`)の JSON は、人気が number のファイルと
 * 数字文字列のファイルの両方がある(コミット済みフィクスチャで確認)ため、number / string の
 * 両方を受けて `toNinki` と同じ契約(1以上の整数のみ、それ以外は null)に揃える。
 */
describe("toNinkiFromJson(JSON の人気の数値化。Issue #75)", () => {
  it.each<[unknown, number | null, string]>([
    [0, null, "数値の0は人気の値域外(1始まり)のためnull"],
    [-1, null, "負の数値は値域外のためnull"],
    [5.5, null, "非整数は人気として値域外のためnull"],
    [Number.NaN, null, "NaNはnull"],
    [Number.POSITIVE_INFINITY, null, "Infinityはnull"],
    ["0", null, '文字列の"0"は toNinki と同じくnull'],
    ["-3", null, "符号付きの文字列はnull"],
    ["5.5", null, "小数の文字列はnull"],
    ["", null, "空文字はnull"],
    [null, null, "nullはnull"],
    [undefined, null, "undefinedはnull"],
    [true, null, "真偽値はnull"],
    [[], null, "配列はnull"],
    [{}, null, "オブジェクトはnull"],
    [1, 1, "数値の1は1(人気の最小)"],
    [12, 12, "数値の12は12"],
    [103, 103, "上限は課さない(toNinki と同じ契約)"],
    ["7", 7, '数字文字列の"7"は7'],
    [" 7 ", 7, "前後空白は trim してから数値化する"],
  ])("入力 %j は %j になること(%s)", (raw, expected) => {
    expect(toNinkiFromJson(raw)).toBe(expected);
  });
});
