import type { StoredAllocation } from "../../src/index.js";
import { describe, expect, it } from "vitest";

import type { StoredAllocationView } from "../../src/analysis/analysis-types.js";

/**
 * analysis/analysis-types.ts の配分提案View型(core型の手動コピー。Issue #55)が、core型と
 * 構造的に完全一致していることを型レベルで固定する(boss メタレビュー指摘: 構造的部分型のため
 * `RaceLedgerView.allocation = e.allocation` の代入は View 型側がフィールドを「落とす」方向の
 * ドリフトが起きてもコンパイルを通してしまい、静かに壊れる)。
 *
 * `analysis-types-combo-odds-pin.test.ts` と同じ手法(`Equal`/`ExpectTrue`)を用いる
 * (再定義になるが、boss指示どおり「同一実装であることを明記」する形で対応した。
 * analysis/analysis-types.ts 自体は core の型を import しない既存の流儀〈import するのは、自身が import を持たない `common/prediction-marks.ts` の型 1 つだけ(Issue #445)。ブラウザ向けの束の閉包に
 * core のバレルやネイティブ依存を引き込まないため。`cloud/test/client-bundle.test.ts` の許可リスト参照〉を守るため、
 * 型検査はこのテストファイル側だけで行う)。
 *
 * `StoredAllocation` は `bets: readonly StoredAllocationBetDetail[]` を内包するため、
 * この1本のピンだけで `StoredAllocationBetView`(analysis-types.ts)と `StoredAllocationBetDetail`(core)
 * の構造一致まで連動して検査される(ネストした配列要素の型もEqualの比較対象に含まれるため)。
 */

/** `analysis-types-combo-odds-pin.test.ts` と同一実装(TypeScriptコミュニティで広く使われる型トリック)。 */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/**
 * T が literal true でなければ、この型エイリアス自体の宣言がコンパイルエラーになる
 * (`analysis-types-combo-odds-pin.test.ts` と同一実装)。
 */
type ExpectTrue<T extends true> = T;

// core `StoredAllocation` と analysis-types.ts の `StoredAllocationView` が構造的に完全一致すること
// (ネストする bets 要素の型 `StoredAllocationBetDetail`/`StoredAllocationBetView` も含む)。
export type _PinStoredAllocation = ExpectTrue<Equal<StoredAllocation, StoredAllocationView>>;

describe("配分提案View型のcore型ピン留め(Issue #55)", () => {
  it("型検査(tsc --noEmit)がこのファイルを通ることが、core型とView型の構造一致の証拠になる", () => {
    // 上記の `_Pin*` 型エイリアス自体がコンパイル時アサーションであり、ズレていれば
    // `pnpm -r typecheck` がこのファイルで失敗する(vitestのesbuild変換は型チェックを
    // 行わないため、実行時には検査できない。「型検査で落ちる」ことが本ピンの効き目)。
    expect(true).toBe(true);
  });
});
