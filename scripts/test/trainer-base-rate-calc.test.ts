/**
 * 調教師の縮小の基準の再現(Issue #354)。`scripts/trainer-base-rate-calc.ts` の純ロジックを、合成入力で固定する。
 * 元データ(取得済みの調教師ページ 196 人)はリポジトリに入れないので、窓の選び方と合算はここが唯一の検査になる。
 */

import { describe, expect, it } from "vitest";
import { trainerBaseRate } from "../trainer-base-rate-calc.js";

describe("trainerBaseRate", () => {
  const A = [{ year: 2026, starts: 90, placed: 80 }, { year: 2025, starts: 100, placed: 30 }, { year: 2024, starts: 200, placed: 40 }, { year: 2023, starts: 500, placed: 400 }];
  const B = [{ year: 2025, starts: 300, placed: 60 }];
  const C = [{ year: 2026, starts: 50, placed: 10 }]; // 窓の行なし

  it("指定した年の行だけを全員分合算する(窓の外の年は入らない)。率 = 3着内 ÷ 出走", () => {
    const r = trainerBaseRate([A, B, C], [2024, 2025]);
    expect(r.starts).toBe(100 + 200 + 300);
    expect(r.placed).toBe(30 + 40 + 60);
    expect(r.rate).toBeCloseTo(130 / 600, 12);
    // 窓の外を含めていたら別の値になる(比較が自明に成り立たない)。
    expect(trainerBaseRate([A, B, C], [2023, 2024, 2025, 2026]).rate).not.toBeCloseTo(r.rate, 3);
  });

  it("窓の行を持つ調教師の数を数える(行の無い調教師は数えない)", () => {
    expect(trainerBaseRate([A, B, C], [2024, 2025]).trainers).toBe(2);
  });

  it("出走が 0 なら率は NaN(0 除算を 0 と偽らない)", () => {
    const r = trainerBaseRate([C], [2024, 2025]);
    expect(r.starts).toBe(0);
    expect(Number.isNaN(r.rate)).toBe(true);
  });
});
