import type { StoredAllocation } from "@keiba/core";
import { describe, expect, it } from "vitest";

import type { StoredAllocationView } from "../src/shared/analysis-types.js";

/**
 * shared/analysis-types.ts の配分提案View型(core型の手動コピー。Issue #55)が、core型と
 * 構造的に完全一致していることを型レベルで固定する(boss メタレビュー指摘: 構造的部分型のため
 * `RaceLedgerView.allocation = e.allocation` の代入は shared側がフィールドを「落とす」方向の
 * ドリフトが起きてもコンパイルを通してしまい、静かに壊れる)。
 *
 * `analysis-types-combo-odds-pin.test.ts` と同じ手法(`Equal`/`ExpectTrue`)を用いる
 * (再定義になるが、boss指示どおり「同一実装であることを明記」する形で対応した。
 * shared/analysis-types.ts 自体は core から一切importしない既存の流儀を守るため、
 * 型検査はこのテストファイル側だけで行う)。
 *
 * `StoredAllocation` は `bets: readonly StoredAllocationBetDetail[]` を内包するため、
 * この1本のピンだけで `StoredAllocationBetView`(shared)と `StoredAllocationBetDetail`(core)
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

// core `StoredAllocation` と shared `StoredAllocationView` が構造的に完全一致すること
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
