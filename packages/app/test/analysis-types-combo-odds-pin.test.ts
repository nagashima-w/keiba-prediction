import type { ComboOddsFetchOutcome, ComboOddsScrapeOutcome } from "@keiba/core";
import { describe, expect, it } from "vitest";

import type {
  ComboOddsFetchOutcomeView,
  ComboOddsScrapeOutcomeView,
} from "../src/shared/analysis-types.js";

/**
 * shared/analysis-types.ts の組合せオッズView型群(core型の手動コピー)が、core型と
 * 構造的に完全一致していることを型レベルで固定する(code-reviewer指摘・提案1採用)。
 *
 * 背景: `shared/analysis-types.ts` 自体は core から一切importしない既存の流儀(narrow import
 * 規約・main/preload/rendererの三者が参照するIPC境界を core のnative依存から独立させるため)を
 * 守っているため、View型は core型の**手動コピー**であり、コンパイラが構造一致を強制する仕組みが
 * 無かった。そのため core側にフィールドが追加・変更されても、shared側は静かにドリフトしうる
 * (boss着手前ゲート・code-reviewerが指摘)。このファイルは shared側の流儀を壊さずに
 * (importするのはこのテストファイル自身であり、shared/analysis-types.tsではない)、
 * ズレを型検査(`pnpm -r typecheck`)で機械的に検知するためのピンを立てる。
 *
 * `ComboOddsFetchOutcome`は`ComboOddsFetchDiagnostics`(betType/requestCount/.../attempts/
 * conflictSamples)を内包し、そこから`ComboOddsFetchAttempt`・`ComboOddsCellConflict`・
 * `ComboOddsCellConflictEntry`・`ComboOddsCell`・`ComboOddsUnavailableReason`・
 * `NarComboOddsUnavailableReason`まで再帰的に参照するため、`ComboOddsFetchOutcome`1本の
 * ピンだけでView型9つのうち7つ(Outcome自身を含む)のネスト構造まで一致検査される
 * (`@keiba/core`バレルから直接exportされているのは`ComboOddsFetchOutcome`/
 * `ComboOddsScrapeOutcome`の2つのみで、内部の入れ子型は個別にexportされていないため、
 * この2本を経由してのみ検査できる)。
 */

/**
 * 型が完全一致(optionalかどうかの違い等、単純な相互代入可能性チェックでは見逃す差分も含めて)
 * するかを判定する、TypeScriptコミュニティで広く使われる型トリック。
 */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/**
 * T が literal true でなければ、この型エイリアス自体の宣言がコンパイルエラーになる
 * (「Type 'false' does not satisfy the constraint 'true'.」)。
 * すなわち下記の `_Pin*` 型エイリアスの存在自体がコンパイル時アサーションであり、
 * ズレていれば `pnpm -r typecheck` がこのファイルで失敗する。
 */
type ExpectTrue<T extends true> = T;

// core `ComboOddsFetchOutcome` と shared `ComboOddsFetchOutcomeView` が構造的に完全一致すること。
export type _PinComboOddsFetchOutcome = ExpectTrue<
  Equal<ComboOddsFetchOutcome, ComboOddsFetchOutcomeView>
>;

// core `ComboOddsScrapeOutcome` と shared `ComboOddsScrapeOutcomeView` が構造的に完全一致すること。
export type _PinComboOddsScrapeOutcome = ExpectTrue<
  Equal<ComboOddsScrapeOutcome, ComboOddsScrapeOutcomeView>
>;

describe("組合せオッズView型のcore型ピン留め(機能D-2c第1段・Issue #28、code-reviewer指摘・提案1採用)", () => {
  it("型検査(tsc --noEmit)がこのファイルを通ることが、core型とView型の構造一致の証拠になる", () => {
    // 上記の `_Pin*` 型エイリアス自体がコンパイル時アサーションであり、ズレていれば
    // `pnpm -r typecheck` がこのファイルで失敗する(vitestのesbuild変換は型チェックを
    // 行わないため、実行時には検査できない。「型検査で落ちる」ことが本ピンの効き目)。
    // 実行時にはダミーの1件だけ置き、このファイルがテストとして認識され続けていること
    // (空のdescribeだと将来誤って削除されても気づきにくい)を示す。
    expect(true).toBe(true);
  });
});
