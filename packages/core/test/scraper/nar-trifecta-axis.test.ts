/**
 * nar-trifecta-axis(地方三連単の軸馬集合導出の葉モジュール)のテスト(Issue #283)。
 *
 * 対象: `deriveNarTrifectaAxisUmabans`。
 *
 * ## 契約
 * 地方三連単の軸は「1着を固定する」意味(`docs/trifecta-odds-investigation.md` §3.2)で、
 * どの馬番も1着になりうるため、**出走馬番の全数**(n本)を叩く必要がある(§3.3。3連複の n-2 とは違う)。
 * 軸は「出走している馬番」でなければならず、取消等で馬番が飛ぶ(非連番の)場合でも
 * 実在する馬番だけを返す。
 */
import { describe, expect, it } from "vitest";
import { deriveNarTrifectaAxisUmabans } from "../../src/scraper/nar-trifecta-axis.js";
import { narTrifectaOddsAxisUrl } from "../../src/scraper/urls.js";
import { parseRaceId } from "../../src/scraper/ids.js";

describe("deriveNarTrifectaAxisUmabans(境界値: 頭数nと軸数nの対応)", () => {
  it("n=0(出走馬番なし)は軸0件を返すこと", () => {
    expect(deriveNarTrifectaAxisUmabans([])).toEqual([]);
  });

  it("n=1・n=2は軸0件を返すこと(3頭未満では三連単の組合せ自体が成立しない)", () => {
    expect(deriveNarTrifectaAxisUmabans([7])).toEqual([]);
    expect(deriveNarTrifectaAxisUmabans([7, 3])).toEqual([]);
  });

  it("n=3は3軸すべてを返すこと(3連複の n-2=1 とは違い、全数が要る)", () => {
    expect(deriveNarTrifectaAxisUmabans([3, 1, 2])).toEqual([1, 2, 3]);
  });

  it("n=12は12軸すべて(1〜12)を昇順で返すこと", () => {
    const umabans = [12, 3, 5, 1, 2, 4, 6, 7, 8, 9, 10, 11];
    expect(deriveNarTrifectaAxisUmabans(umabans)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("n=18(馬番の契約上限)は18軸すべてを返すこと", () => {
    const umabans = Array.from({ length: 18 }, (_, i) => i + 1);
    expect(deriveNarTrifectaAxisUmabans(umabans)).toHaveLength(18);
    expect(deriveNarTrifectaAxisUmabans(umabans)).toEqual(umabans);
  });
});

describe("deriveNarTrifectaAxisUmabans(非連番・重複・順不同)", () => {
  it("取消で馬番が飛ぶ集合 {2,3,5,7,9} は、その5つだけを昇順で返すこと(存在しない馬番1を軸にしない)", () => {
    expect(deriveNarTrifectaAxisUmabans([9, 2, 7, 3, 5])).toEqual([2, 3, 5, 7, 9]);
  });

  it("重複は排除し、重複排除後の頭数で数えること", () => {
    expect(deriveNarTrifectaAxisUmabans([4, 4, 2, 2, 6])).toEqual([2, 4, 6]);
    // 重複を除くと2頭 → 3頭未満なので0件
    expect(deriveNarTrifectaAxisUmabans([4, 4, 2, 2])).toEqual([]);
  });

  it("入力配列を破壊しないこと", () => {
    const input = [3, 1, 2];
    deriveNarTrifectaAxisUmabans(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("deriveNarTrifectaAxisUmabans と narTrifectaOddsAxisUrl の整合", () => {
  it("導出した全軸が、URLビルダの契約(1〜18の整数)を満たしてURLを作れること", () => {
    const raceId = parseRaceId("202654071210");
    const axes = deriveNarTrifectaAxisUmabans(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(axes).toHaveLength(18);
    for (const axis of axes) {
      expect(narTrifectaOddsAxisUrl(raceId, axis)).toContain(`jiku=${axis}`);
    }
  });
});
