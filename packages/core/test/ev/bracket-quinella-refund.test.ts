import { describe, expect, it } from "vitest";
import {
  buildBracketFrameCensus,
  isBracketQuinellaRefund,
  type BracketFrameHorse,
} from "../../src/ev/bracket-quinella-refund.js";

/**
 * Issue #269: 枠連(bracketQuinella)の買い目の返還判定(取消・除外)。
 *
 * 規定(JRA「勝馬投票券の返還について」。出典 URL と原文は bracket-quinella-refund.ts のヘッダ):
 *   例1 出走しない馬の同枠に他馬がいない場合、その枠との組合せは返還。
 *   例2 同枠に他馬が1頭いる場合、同枠のゾロ目のみ返還。
 *   例3 同枠に他馬が2頭いる場合、ゾロ目を含むすべての組合せで返還なし。
 * 枠は詰めない(出馬表確定時の枠番のまま数える)。
 *
 * 枠の構成は「枠番 → 文字列」で書く。文字列の1文字が1頭で、"o" = 出走、"x" = 取消・除外。
 * 例: { 7: "ox" } は、枠7に2頭いて、うち1頭が取消・除外。
 */

/** 枠の構成から馬の配列を作る(馬番は枠の順に 1 から振る)。 */
function race(frames: Readonly<Record<number, string>>): BracketFrameHorse[] {
  const horses: BracketFrameHorse[] = [];
  for (const [waku, marks] of Object.entries(frames).sort(([a], [b]) => Number(a) - Number(b))) {
    for (const mark of marks) {
      horses.push({ wakuban: Number(waku), scratched: mark === "x" });
    }
  }
  return horses;
}

/** 8頭立て(各枠1頭)。overrides で枠ごとに差し替える。 */
function eight(overrides: Readonly<Record<number, string>> = {}): BracketFrameHorse[] {
  return race({ 1: "o", 2: "o", 3: "o", 4: "o", 5: "o", 6: "o", 7: "o", 8: "o", ...overrides });
}

/** 12頭立て(枠1〜4が1頭、枠5〜8が2頭)。 */
function twelve(overrides: Readonly<Record<number, string>> = {}): BracketFrameHorse[] {
  return race({ 1: "o", 2: "o", 3: "o", 4: "o", 5: "oo", 6: "oo", 7: "oo", 8: "oo", ...overrides });
}

/** 枠8だけ3頭いる構成(1枠3頭の境界を試すための単純化。実際の18頭立ての配分ではない)。枠1〜7は各1頭。 */
function threeInFrame8(frame8: string): BracketFrameHorse[] {
  return race({ 1: "o", 2: "o", 3: "o", 4: "o", 5: "o", 6: "o", 7: "o", 8: frame8 });
}

function refund(horses: readonly BracketFrameHorse[], comboKey: string): boolean {
  return isBracketQuinellaRefund(comboKey, buildBracketFrameCensus(horses));
}

describe("枠連の返還判定: 異なる2枠(例1。片方の枠の出走馬が尽きたら返還)", () => {
  // 8頭立て。枠3の1頭が取消(枠3の出走馬が尽きる)。
  const horses = eight({ 3: "x" });
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["枠3(尽きた枠)を含む組は返還", "0305", true],
    ["枠3を含む組は、もう一方の枠が何でも返還(枠8)", "0308", true],
    ["枠3を含む組は、順序が逆のキーでも返還", "0703", true],
    ["枠3を含まない組は返還しない", "0506", false],
    ["取消の無い枠どうしの組は返還しない(最小と最大の枠)", "0108", false],
  ];
  it.each(cases)("%s (%s)", (_name, key, expected) => {
    expect(refund(horses, key)).toBe(expected);
  });

  it("両方の枠が尽きた組も返還", () => {
    expect(refund(eight({ 3: "x", 5: "x" }), "0305")).toBe(true);
  });

  it("前提の固定: 枠3は1頭で、その1頭が取消。ほかの枠は全員出走", () => {
    expect(horses.filter((h) => h.wakuban === 3).map((h) => h.scratched)).toEqual([true]);
    expect(horses.filter((h) => h.wakuban !== 3).every((h) => h.scratched === false)).toBe(true);
  });
});

describe("枠連の返還判定: 同枠(ゾロ目)と枠の残り頭数(例2・例3)", () => {
  // 12頭立て。枠7に2頭。取消の数で残りが 2 → 1 → 0 と変わる。
  const cases: ReadonlyArray<{ readonly name: string; readonly frame7: string; readonly remaining: number; readonly key: string; readonly expected: boolean }> = [
    { name: "例3: 枠7が2頭とも出走(残り2) → ゾロ目は返還しない", frame7: "oo", remaining: 2, key: "0707", expected: false },
    { name: "例2: 枠7の1頭が取消(残り1) → ゾロ目のみ返還", frame7: "ox", remaining: 1, key: "0707", expected: true },
    { name: "例2: 枠7の1頭が取消(残り1) → 枠7と別の枠の組は返還しない", frame7: "ox", remaining: 1, key: "0307", expected: false },
    { name: "例2: 枠7の1頭が取消(残り1) → 別の枠のゾロ目も返還しない", frame7: "ox", remaining: 1, key: "0808", expected: false },
    { name: "例1: 枠7が2頭とも取消(残り0) → ゾロ目も返還", frame7: "xx", remaining: 0, key: "0707", expected: true },
    { name: "例1: 枠7が2頭とも取消(残り0) → 別の枠との組も返還", frame7: "xx", remaining: 0, key: "0307", expected: true },
    { name: "例1: 枠7が2頭とも取消(残り0) → 隣の枠との組も返還", frame7: "xx", remaining: 0, key: "0708", expected: true },
  ];
  it.each(cases)("$name", ({ frame7, remaining, key, expected }) => {
    const horses = twelve({ 7: frame7 });
    // 前提を無条件に固定する(名前が主張する残り頭数が、本体の構成で成り立っている)。
    expect(horses.filter((h) => h.wakuban === 7 && h.scratched !== true)).toHaveLength(remaining);
    expect(horses.filter((h) => h.wakuban === 7)).toHaveLength(2);
    expect(refund(horses, key)).toBe(expected);
  });
});

describe("枠連の返還判定: 1枠3頭", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly frame8: string; readonly remaining: number; readonly key: string; readonly expected: boolean }> = [
    { name: "1頭取消(残り2) → ゾロ目も返還しない", frame8: "oox", remaining: 2, key: "0808", expected: false },
    { name: "1頭取消(残り2) → 別の枠との組も返還しない", frame8: "oox", remaining: 2, key: "0108", expected: false },
    { name: "2頭取消(残り1) → ゾロ目のみ返還", frame8: "oxx", remaining: 1, key: "0808", expected: true },
    { name: "2頭取消(残り1) → 別の枠との組は返還しない", frame8: "oxx", remaining: 1, key: "0108", expected: false },
    { name: "3頭とも取消(残り0) → 別の枠との組も返還", frame8: "xxx", remaining: 0, key: "0108", expected: true },
  ];
  it.each(cases)("$name", ({ frame8, remaining, key, expected }) => {
    const horses = threeInFrame8(frame8);
    expect(horses.filter((h) => h.wakuban === 8)).toHaveLength(3);
    expect(horses.filter((h) => h.wakuban === 8 && h.scratched !== true)).toHaveLength(remaining);
    expect(refund(horses, key)).toBe(expected);
  });
});

describe("枠連の返還判定: 取消が無ければ返還しない", () => {
  it.each(["0101", "0108", "0505", "0808"])("全頭出走のレースで %s は返還しない", (key) => {
    const horses = twelve();
    expect(horses.some((h) => h.scratched === true)).toBe(false);
    expect(refund(horses, key)).toBe(false);
  });
});

describe("枠連の返還判定: 判定しない(保守的に返還にしない)ケース", () => {
  // 返還になるはずの構成(枠3が尽きている)から、1要素だけ崩す。崩す前は返還になることを先に固定する。
  const base = (): BracketFrameHorse[] => eight({ 3: "x" });

  it("前提の固定: 崩す前の構成では枠3を含む組は返還", () => {
    expect(refund(base(), "0305")).toBe(true);
  });

  const broken: ReadonlyArray<readonly [string, (h: BracketFrameHorse[]) => BracketFrameHorse[]]> = [
    ["1頭でも wakuban が null ならレース全体を判定しない", (h) => h.map((x, i) => (i === 0 ? { ...x, wakuban: null } : x))],
    ["1頭でも wakuban が未記録(キー無し)ならレース全体を判定しない", (h) => h.map((x, i) => (i === 0 ? { scratched: x.scratched } : x))],
    ["wakuban が 0(範囲外)の行があれば判定しない", (h) => h.map((x, i) => (i === 0 ? { ...x, wakuban: 0 } : x))],
    ["wakuban が 9(範囲外)の行があれば判定しない", (h) => h.map((x, i) => (i === 0 ? { ...x, wakuban: 9 } : x))],
    ["wakuban が整数でない行があれば判定しない", (h) => h.map((x, i) => (i === 0 ? { ...x, wakuban: 1.5 } : x))],
    ["1頭でも scratched が未記録(旧い行)なら判定しない", (h) => h.map((x, i) => (i === 0 ? { wakuban: x.wakuban } : x))],
  ];
  it.each(broken)("%s", (_name, mutate) => {
    const horses = mutate(base());
    expect(horses).toHaveLength(8);
    expect(buildBracketFrameCensus(horses)).toBeNull();
    expect(refund(horses, "0305")).toBe(false);
  });

  it("結果の行が1頭も無いなら判定しない", () => {
    expect(buildBracketFrameCensus([])).toBeNull();
    expect(isBracketQuinellaRefund("0305", buildBracketFrameCensus([]))).toBe(false);
  });

  const badKeys: ReadonlyArray<readonly [string, string]> = [
    ["空のキー", ""],
    ["要素が1つ", "03"],
    ["要素が3つ", "030507"],
    ["数字でない", "abcd"],
    ["奇数桁", "0305x"],
    ["枠番が 0", "0005"],
    ["枠番が 9(枠は1〜8)", "0309"],
  ];
  it.each(badKeys)("買い目のキーが壊れている(%s)なら返還にしない", (_name, key) => {
    const horses = base();
    expect(refund(horses, "0305")).toBe(true); // 同じレースで、正しいキーなら返還(空振り防止の前提)
    expect(refund(horses, key)).toBe(false);
  });

  it("買い目の枠に結果の行が1つも無いなら返還にしない(6頭立てで枠7を含む組)", () => {
    const six = race({ 1: "o", 2: "o", 3: "x", 4: "o", 5: "o", 6: "o" });
    expect(six.some((h) => h.wakuban === 7)).toBe(false);
    expect(refund(six, "0306")).toBe(true); // 枠3は尽きていて、枠6には行がある
    expect(refund(six, "0307")).toBe(false); // 枠7に行が無い
    expect(refund(six, "0707")).toBe(false);
  });
});

describe("buildBracketFrameCensus: 集計の中身", () => {
  it("枠ごとに、行の数・取消の数を数える", () => {
    const census = buildBracketFrameCensus(twelve({ 7: "ox", 8: "xx" }));
    expect(census).not.toBeNull();
    expect(census!.frames.get(7)).toEqual({ total: 2, scratched: 1 });
    expect(census!.frames.get(8)).toEqual({ total: 2, scratched: 2 });
    expect(census!.frames.get(1)).toEqual({ total: 1, scratched: 0 });
    expect(census!.frames.size).toBe(8);
  });
});
