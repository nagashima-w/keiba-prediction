/**
 * placeSkipReasonText / comboSkipReasonText(Issue #55: 過去分析の再表示で見送り理由の
 * 日本語文言を組み立て直すために、これまで各券種ファイルにprivateだった `skipReasonText`
 * をexportした)のテスト。
 *
 * 判定ロジック(どのコードになるか)自体は allocateBets/allocateGeneralBets のテストで
 * 既に固定済み。本ファイルは「コード→文言」の変換のみを対象にし、次を固定する:
 * - 複勝・組合せで文言が1箇所だけ食い違うこと(no-candidates)。#55のview層が
 *   この差を使ってroute取り違えを検出するための土台。
 * - cap-too-smallはbetUnitの値を文言に埋め込むこと。
 * - 3つ目の複製を作らず、2ファイルからそれぞれ1つずつexportされていること
 *   (importパスの違いそのものが「複製していない」ことの証拠になる)。
 */
import { describe, expect, it } from "vitest";

import { placeSkipReasonText } from "../../src/ev/bet-allocation.js";
import { comboSkipReasonText, type SkipReasonCode } from "../../src/ev/combo-bet-allocation.js";

describe("placeSkipReasonText(複勝の見送り理由文言)", () => {
  it("6分類すべてに対応する文言を返すこと", () => {
    const cases: Array<[SkipReasonCode, string]> = [
      ["bankroll-unset", "総資金が未設定のため配分を提案していません"],
      ["cap-unset", "1レースの上限が未設定のため配分を提案していません"],
      ["kelly-zero", "ケリー係数が0のため配分しません"],
      ["no-candidates", "EVプラスの馬がいないため見送りです"],
      ["no-edge", "妙味が小さく、賭ける価値のある配分が見つかりませんでした"],
    ];
    for (const [code, expected] of cases) {
      expect(placeSkipReasonText(code, 100)).toBe(expected);
    }
  });

  it("cap-too-smallはbetUnitの値を文言に埋め込むこと(数値を捏造しない=引数をそのまま反映)", () => {
    expect(placeSkipReasonText("cap-too-small", 100)).toBe(
      "1レースの上限が100円未満のため配分できません",
    );
    expect(placeSkipReasonText("cap-too-small", 500)).toBe(
      "1レースの上限が500円未満のため配分できません",
    );
  });
});

describe("comboSkipReasonText(ワイド・3連複の見送り理由文言)", () => {
  it("no-candidatesの文言が複勝側と異なること(『馬』ではなく『買い目』)", () => {
    expect(comboSkipReasonText("no-candidates", 100)).toBe(
      "EVプラスの買い目がないため見送りです",
    );
    expect(comboSkipReasonText("no-candidates", 100)).not.toBe(
      placeSkipReasonText("no-candidates", 100),
    );
  });

  it("no-candidates以外の5分類は複勝側と文言が一致すること(文言定数自体は同一値)", () => {
    const codes: SkipReasonCode[] = [
      "bankroll-unset",
      "cap-unset",
      "cap-too-small",
      "kelly-zero",
      "no-edge",
    ];
    for (const code of codes) {
      expect(comboSkipReasonText(code, 250)).toBe(placeSkipReasonText(code, 250));
    }
  });
});
