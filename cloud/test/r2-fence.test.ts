import { afterEach, describe, expect, it } from "vitest";
import {
  FENCE_PERCENT,
  R2_FENCE_LIMITS,
  R2_FREE_TIER,
  fenceStatus,
  isReadAllowed,
  isWriteAllowed,
  monthKey,
} from "../src/r2-fence";

/**
 * Issue #173(#169-c): R2 の操作回数の安全柵(純関数)。判定は D1 の回数(`r2_ops`)を受け取るだけの純関数で、D1・R2・時計に触れない。
 * Free 枠(毎月): Class A(PUT など)が 100 万回、Class B(GET など)が 1,000 万回。柵は無料枠の 10%。
 */

describe("AC-c4: 閾値は定数で、Class A(書き込み)と Class B(読み出し)を取り違えない", () => {
  it("無料枠は Class A が 100 万回・Class B が 1,000 万回(月)。柵は 10%", () => {
    expect(R2_FREE_TIER).toEqual({ classA: 1_000_000, classB: 10_000_000 });
    expect(FENCE_PERCENT).toBe(10);
  });

  it("柵の上限は Class A が 10 万回・Class B が 100 万回(無料枠の 10%)", () => {
    expect(R2_FENCE_LIMITS).toEqual({ classA: 100_000, classB: 1_000_000 });
    // 無料枠からの導出と一致する(手計算: 1,000,000 × 10% = 100,000、10,000,000 × 10% = 1,000,000)
    expect(R2_FENCE_LIMITS.classA).toBe((R2_FREE_TIER.classA * FENCE_PERCENT) / 100);
    expect(R2_FENCE_LIMITS.classB).toBe((R2_FREE_TIER.classB * FENCE_PERCENT) / 100);
    // 取り違えると桁が変わる(A の上限は B の上限の 1/10)
    expect(R2_FENCE_LIMITS.classB).toBe(R2_FENCE_LIMITS.classA * 10);
  });
});

describe("AC-c3: 閾値の境界(上限 −1 はまだ書く・読む。上限ちょうどで止める)", () => {
  const A = R2_FENCE_LIMITS.classA;
  const B = R2_FENCE_LIMITS.classB;

  it.each([
    [0, true],
    [A - 1, true],
    [A, false],
    [A + 1, false],
  ])("書き込み(Class A = %i): 許可 = %s", (classA, allowed) => {
    expect(isWriteAllowed({ classA, classB: 0 })).toBe(allowed);
  });

  it.each([
    [0, true],
    [B - 1, true],
    [B, false],
    [B + 1, false],
  ])("読み出し(Class B = %i): 許可 = %s", (classB, allowed) => {
    expect(isReadAllowed({ classA: 0, classB })).toBe(allowed);
  });

  it("書き込みの判定は Class A だけを、読み出しの判定は Class B だけを見る(取り違えない)", () => {
    // Class B が上限でも、書き込みは止まらない
    expect(isWriteAllowed({ classA: 0, classB: B })).toBe(true);
    expect(isWriteAllowed({ classA: 0, classB: B * 100 })).toBe(true);
    // Class A が上限でも、読み出しは止まらない
    expect(isReadAllowed({ classA: A, classB: 0 })).toBe(true);
    expect(isReadAllowed({ classA: A * 100, classB: 0 })).toBe(true);
    // 桁の取り違え: Class B の値を Class A の上限で判定すると(A < B なので)読み出しが早すぎる位置で止まる。そうなっていない
    expect(isReadAllowed({ classA: 0, classB: A })).toBe(true);
    expect(isWriteAllowed({ classA: A, classB: 0 })).toBe(false);
  });

  it("fenceStatus は両方の判定をまとめる", () => {
    expect(fenceStatus({ classA: 0, classB: 0 })).toEqual({ writeAllowed: true, readAllowed: true });
    expect(fenceStatus({ classA: A, classB: 0 })).toEqual({ writeAllowed: false, readAllowed: true });
    expect(fenceStatus({ classA: 0, classB: B })).toEqual({ writeAllowed: true, readAllowed: false });
    expect(fenceStatus({ classA: A, classB: B })).toEqual({ writeAllowed: false, readAllowed: false });
  });
});

describe("AC-c2: monthKey(UTC の yyyymm)", () => {
  const original = process.env["TZ"];
  afterEach(() => {
    if (original === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = original;
    }
  });

  it.each([
    ["2026-10-06T12:00:00.000Z", 202610],
    ["2026-10-31T23:59:59.999Z", 202610],
    ["2026-11-01T00:00:00.000Z", 202611],
    ["2026-12-31T23:59:59.999Z", 202612],
    ["2027-01-01T00:00:00.000Z", 202701],
    ["2026-01-01T00:00:00.000Z", 202601],
    ["2024-02-29T12:00:00.000Z", 202402],
  ])("%s → %i", (iso, expected) => {
    expect(monthKey(new Date(iso))).toBe(expected);
  });

  it("端末のタイムゾーンによらず UTC で区切る(日本時間では 11/1 になる時刻でも、UTC が 10 月なら 202610。ローカル時刻を使う実装は落ちる)", () => {
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
      process.env["TZ"] = tz;
      // 2026-10-31T16:00:00Z = 日本時間の 11/1 01:00(ローカルの月は 11)。UTC は 10 月
      expect(monthKey(new Date("2026-10-31T16:00:00Z")), tz).toBe(202610);
      // 2026-11-01T04:00:00Z = ロサンゼルスの 10/31 21:00(PDT)。UTC は 11 月
      expect(monthKey(new Date("2026-11-01T04:00:00Z")), tz).toBe(202611);
    }
    // 前提: この環境で TZ の切り替えが効いている(効いていないと、上の検査は UTC 実装でもローカル実装でも通る)
    process.env["TZ"] = "Asia/Tokyo";
    expect(new Date("2026-10-31T16:00:00Z").getMonth()).toBe(10); // ローカル(東京)の月は 11 月(0 始まりで 10)
  });
});
