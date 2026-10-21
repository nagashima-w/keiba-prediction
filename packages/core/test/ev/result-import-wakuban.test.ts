import { describe, expect, it } from "vitest";

import { toResultEntries } from "../../src/ev/result-import.js";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { loadFixture } from "../support/fixtures.js";

/**
 * Issue #269: 枠番の記録(`RaceResultEntry.wakuban`)。
 *
 * 枠連の買い目の返還(取消・除外で枠の出走馬が尽きる等)は、馬番ではなく枠番で決まる。結果ページのパーサは各馬の枠番を
 * 読んでいるが、`toResultEntries` が落としていたので保存されていなかった。取消・除外の馬の行にも枠番がある。
 */

describe("toResultEntries: 枠番(Issue #269)", () => {
  it("実フィクスチャ(中央16頭立て・取消あり): 全馬の枠番を、パース結果のとおりに詰める(取消の6番は枠3)", () => {
    const result = parseRaceResult(loadFixture("result_202606040901.html"));
    expect(result.horses).toHaveLength(16);
    // 前提(空振り防止): パース結果の枠番が全頭で数値で、8枠に分かれている。
    expect(result.horses.every((h) => h.wakuban !== null)).toBe(true);
    expect(new Set(result.horses.map((h) => h.wakuban)).size).toBe(8);

    const entries = toResultEntries(result);
    expect(entries.map((e) => [e.umaban, e.wakuban])).toEqual(result.horses.map((h) => [h.umaban, h.wakuban]));
    const scratched = entries.find((e) => e.scratched === true);
    expect(scratched).toMatchObject({ umaban: 6, wakuban: 3, finishPosition: null });
  });

  it("実フィクスチャ(中央12頭立て・除外あり): 除外の10番は枠7。同じ枠の9番は出走している", () => {
    const entries = toResultEntries(parseRaceResult(loadFixture("result_202605040205.html")));
    expect(entries).toHaveLength(12);
    const excluded = entries.find((e) => e.scratched === true);
    expect(excluded).toMatchObject({ umaban: 10, wakuban: 7, finishPosition: null });
    expect(entries.filter((e) => e.wakuban === 7).map((e) => [e.umaban, e.scratched === true])).toEqual([
      [9, false],
      [10, true],
    ]);
  });

  it("枠番が取れない行(パース結果の wakuban が null)は null のまま詰める(推測で埋めない)", () => {
    const result = parseRaceResult(loadFixture("result_202606040901.html"));
    const patched = { ...result, horses: result.horses.map((h) => (h.umaban === 1 ? { ...h, wakuban: null } : h)) };
    const entries = toResultEntries(patched);
    expect(entries.find((e) => e.umaban === 1)!.wakuban).toBeNull();
    expect(entries.find((e) => e.umaban === 2)!.wakuban).not.toBeNull();
  });
});
