import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * bracket-quinella-allocation-setting-ui-wiring.test.ts — Issue #286(#285 の段階A)。
 * `packages/core/test/analysis/bracket-quinella-allocation-setting-wiring.test.ts` を core へ移すとき、**exe の画面のソース**(`SettingsView.tsx`・`VerifyView.tsx`。packages/app/src/renderer)を走査する describe を、
 * exe 専用のテストとしてここへ分離した。core のテストから exe のソースを読まないため。**テストの本体・assert は元のまま(弱めていない)**。
 * 振る舞いの検査(混在配分の計算・配線)は、元のファイルが core 側に残っている。packages/app を削除する段階B(Issue #287)で、このファイルも削除する。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(currentDir, "../src/renderer");

describe("SettingsView.tsxが枠連の配分対象チェックボックスを持つこと(#26-E3b・Issue #150。#149時点は未表示だった)", () => {
  it("includeBracketQuinellaInAllocation・枠連配分対象切替・ALLOCATION_BET_TYPE_LABELS.bracketQuinellaを参照し、馬連の後・馬単の前(表示順の並び)に置かれていること", () => {
    const source = readFileSync(path.join(rendererDir, "SettingsView.tsx"), "utf8");
    // 前提固定(空振り防止): 既存のチェックボックスは実在すること(ファイルを正しく読めていることの確認)。
    expect(source).toContain("includeQuinellaInAllocation");
    expect(source).toContain("includeTrifectaInAllocation");
    expect(source).toContain("includeBracketQuinellaInAllocation");
    expect(source).toContain('"枠連配分対象切替"');
    expect(source).toContain("ALLOCATION_BET_TYPE_LABELS.bracketQuinella.checkbox");
    expect(source).toContain("ALLOCATION_BET_TYPE_LABELS.bracketQuinella.help");
    // 表示順(複勝→単勝→ワイド→馬連→枠連→馬単→三連複→三連単)に合わせ、馬連の後・馬単の前に置く。
    const quinella = source.indexOf("state.includeQuinellaInAllocation");
    const bracket = source.indexOf("state.includeBracketQuinellaInAllocation");
    const exacta = source.indexOf("state.includeExactaInAllocation");
    expect(quinella).toBeGreaterThan(-1);
    expect(bracket).toBeGreaterThan(quinella);
    expect(exacta).toBeGreaterThan(bracket);
  });
});

describe("VerifyView.tsxの配分ベースの内訳行・判定不能行に枠連が出ること(#26-E3b・Issue #150。#145で回収率検証の`overall`には合算済みだが内訳行には未表示だった)", () => {
  it("内訳(betCount・recoveryRate)と判定不能(unjudgedCount)の両方に枠連を、馬連の後・馬単の前の位置で表示していること", () => {
    const source = readFileSync(path.join(rendererDir, "VerifyView.tsx"), "utf8");
    for (const field of ["betCount", "recoveryRate", "unjudgedCount"] as const) {
      const q = source.indexOf(`report.proposedBet.quinella.${field}`);
      const b = source.indexOf(`report.proposedBet.bracketQuinella.${field}`);
      const e = source.indexOf(`report.proposedBet.exacta.${field}`);
      // 前提固定(空振り防止): 馬連・馬単は従来から表示されていること。
      expect(q, `quinella.${field}`).toBeGreaterThan(-1);
      expect(e, `exacta.${field}`).toBeGreaterThan(-1);
      expect(b, `bracketQuinella.${field}`).toBeGreaterThan(q);
      expect(e, `exacta.${field}が枠連の後`).toBeGreaterThan(b);
    }
    // 内訳行の枠連は「枠連」の語で表示すること(ラベルの直書き)。
    expect(source).toMatch(/枠連\{" "\}\s*\{report\.proposedBet\.bracketQuinella\.betCount/);
  });
});
