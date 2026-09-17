import { describe, expect, it } from "vitest";
import { toNinki } from "../../src/scraper/ninki.js";

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
