import { describe, expect, it } from "vitest";

import { mixedBetTypeLabel } from "../src/renderer/mixed-allocation-view.js";

/**
 * Issue #286(#285 の段階A): `allocation-proposal-view.test.ts` を core のテストへ移すとき、同じ `it` の後半にあった
 * `mixedBetTypeLabel`(exe の mixed-allocation-view.ts。exe 専用)の8ラベルの固定を、ここへ分離した。
 * core のテストから exe 専用の関数を import しないため。**assert は弱めていない**(元の8行と同じリテラル・同じ関数)。
 * 前半(betTypeLabel〈allocation-proposal-view.ts〉の8ラベル)は packages/core/test/view/allocation-proposal-view.test.ts に残っている。
 *
 * 元のテスト: 「betTypeLabel(allocation-proposal-view.ts)とmixedBetTypeLabel(mixed-allocation-view.ts)の8ラベルが同一文字列であること
 * (Issue #76・D-5〈#90〉: 統合はしないが値は一致させる)」。両関数が一緒にずれても検知できるよう、比較ではなく日本語リテラルで固定する。
 */
describe("mixedBetTypeLabel(mixed-allocation-view.ts)の8ラベルが日本語リテラルと一致すること(Issue #76・D-5〈#90〉。betTypeLabel 側は core の allocation-proposal-view.test.ts)", () => {
  it("place/win/wide/quinella/exacta/trio/trifecta/bracketQuinellaそれぞれで日本語ラベルを返すこと", () => {
    expect(mixedBetTypeLabel("place")).toBe("複勝");
    expect(mixedBetTypeLabel("win")).toBe("単勝");
    expect(mixedBetTypeLabel("wide")).toBe("ワイド");
    expect(mixedBetTypeLabel("quinella")).toBe("馬連");
    expect(mixedBetTypeLabel("exacta")).toBe("馬単");
    expect(mixedBetTypeLabel("trio")).toBe("三連複");
    expect(mixedBetTypeLabel("trifecta")).toBe("三連単");
    expect(mixedBetTypeLabel("bracketQuinella")).toBe("枠連");
  });
});
