/**
 * nar-trio-axis(地方3連複の軸馬集合導出の葉モジュール)のテスト(機能D-2b-B・Issue #33)。
 *
 * 対象: `deriveNarTrioAxisUmabans`。
 *
 * ## 契約(Issue #33本文の⚠️「重要な境界値」)
 * 軸集合は「出走馬番のうち値が頭数-2以下のもの」ではない。正しい命題は
 * 「出走馬番を昇順に並べた先頭 頭数-2 頭」であり、取消等で馬番が飛ぶ(非連番の)
 * ケースでも成立する必要がある。本テストは非連番集合 `{2,3,5,7,9}` を明示的なケースとして持つ。
 */
import { describe, expect, it } from "vitest";
import { buildComboOddsKey } from "../../src/scraper/combo-odds-key.js";
import { deriveNarTrioAxisUmabans } from "../../src/scraper/nar-trio-axis.js";
import { narTrioOddsAxisUrl } from "../../src/scraper/urls.js";
import { parseRaceId } from "../../src/scraper/ids.js";

/** 出走馬番の集合(pool)からC(n,3)の全トリオを列挙する(テスト専用のダム総当たり)。 */
function combinations3(pool: readonly number[]): number[][] {
  const result: number[][] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        result.push([pool[i]!, pool[j]!, pool[k]!]);
      }
    }
  }
  return result;
}

describe("deriveNarTrioAxisUmabans(境界値: 頭数nと軸数n-2の対応)", () => {
  it("n=0(出走馬番なし)は軸0件を返すこと", () => {
    expect(deriveNarTrioAxisUmabans([])).toEqual([]);
  });

  it("n=1は軸0件を返すこと", () => {
    expect(deriveNarTrioAxisUmabans([7])).toEqual([]);
  });

  it("n=2は軸0件を返すこと", () => {
    expect(deriveNarTrioAxisUmabans([7, 3])).toEqual([]);
  });

  it("n=3は軸1件(先頭1頭)を返すこと", () => {
    expect(deriveNarTrioAxisUmabans([5, 1, 3])).toEqual([1]);
  });

  it("n=16は軸14件(先頭14頭)を返すこと", () => {
    const pool = Array.from({ length: 16 }, (_, i) => i + 1);
    const axes = deriveNarTrioAxisUmabans(pool);
    expect(axes).toEqual(pool.slice(0, 14));
    expect(axes.length).toBe(14); // 件数そのものを無条件に固定(空振り防止)
  });

  it("n=18は軸16件(先頭16頭)を返すこと", () => {
    const pool = Array.from({ length: 18 }, (_, i) => i + 1);
    const axes = deriveNarTrioAxisUmabans(pool);
    expect(axes).toEqual(pool.slice(0, 16));
    expect(axes.length).toBe(16); // 件数そのものを無条件に固定(空振り防止)
  });
});

describe("deriveNarTrioAxisUmabans(重複・順序への頑健性)", () => {
  it("重複馬番は1頭として扱い、重複除去後の頭数でn-2を数えること", () => {
    // 集合としては{1,2,3,4,5}の5頭(1と3が重複入力されている)
    expect(deriveNarTrioAxisUmabans([1, 1, 2, 3, 3, 4, 5])).toEqual([1, 2, 3]);
  });

  it("入力順を変えても同じ軸集合を返すこと(シャッフル耐性)", () => {
    const baseline = deriveNarTrioAxisUmabans([5, 3, 9, 2, 7]);
    expect(baseline).toEqual([2, 3, 5]); // 前提を固定(空振り防止)
    expect(deriveNarTrioAxisUmabans([9, 7, 5, 3, 2])).toEqual(baseline);
    expect(deriveNarTrioAxisUmabans([2, 9, 3, 7, 5])).toEqual(baseline);
    expect(deriveNarTrioAxisUmabans([7, 2, 5, 9, 3])).toEqual(baseline);
  });

  it("非連番(取消で馬番が飛ぶ)の出走馬番でも『昇順先頭n-2頭』を軸にすること", () => {
    // 出走馬番{2,3,5,7,9}(n=5): 軸は「値が3以下」の{2,3}ではなく、
    // 「昇順先頭n-2=3頭」の{2,3,5}である。
    expect(deriveNarTrioAxisUmabans([2, 3, 5, 7, 9])).toEqual([2, 3, 5]);
  });
});

describe("deriveNarTrioAxisUmabans(網羅性: 軸が返す『軸を含む全トリオ』の和集合がC(n,3)と完全一致すること)", () => {
  it("n=5で全トリオを漏れなく網羅すること", () => {
    const pool = [1, 2, 3, 4, 5];
    const axes = deriveNarTrioAxisUmabans(pool);
    expect(axes).toEqual([1, 2, 3]); // 前提を固定(空振り防止)

    const fullTrios = combinations3(pool);
    expect(fullTrios.length).toBe(10); // C(5,3)=10 を無条件に固定(空振り防止)

    const unionKeys = new Set<string>();
    for (const axis of axes) {
      for (const trio of fullTrios) {
        if (trio.includes(axis)) {
          unionKeys.add(buildComboOddsKey(trio));
        }
      }
    }
    const fullKeys = new Set(fullTrios.map((t) => buildComboOddsKey(t)));
    expect(unionKeys.size).toBe(10); // 和集合の件数そのものを無条件に固定(空振り防止)
    expect(unionKeys).toEqual(fullKeys);
  });

  it("n=6(偶数)でも全トリオを漏れなく網羅すること", () => {
    const pool = [1, 2, 3, 4, 5, 6];
    const axes = deriveNarTrioAxisUmabans(pool);
    expect(axes).toEqual([1, 2, 3, 4]); // 前提を固定(空振り防止)

    const fullTrios = combinations3(pool);
    expect(fullTrios.length).toBe(20); // C(6,3)=20 を無条件に固定(空振り防止)

    const unionKeys = new Set<string>();
    for (const axis of axes) {
      for (const trio of fullTrios) {
        if (trio.includes(axis)) {
          unionKeys.add(buildComboOddsKey(trio));
        }
      }
    }
    const fullKeys = new Set(fullTrios.map((t) => buildComboOddsKey(t)));
    expect(unionKeys.size).toBe(20); // 和集合の件数そのものを無条件に固定(空振り防止)
    expect(unionKeys).toEqual(fullKeys);
  });

  it("非連番の出走馬番(取消あり)でも網羅性が成立すること(n=5、値{2,3,5,7,9})", () => {
    const pool = [2, 3, 5, 7, 9];
    const axes = deriveNarTrioAxisUmabans(pool);
    expect(axes).toEqual([2, 3, 5]); // 前提を固定(空振り防止)

    const fullTrios = combinations3(pool);
    expect(fullTrios.length).toBe(10); // C(5,3)=10 を無条件に固定(空振り防止)

    const unionKeys = new Set<string>();
    for (const axis of axes) {
      for (const trio of fullTrios) {
        if (trio.includes(axis)) {
          unionKeys.add(buildComboOddsKey(trio));
        }
      }
    }
    const fullKeys = new Set(fullTrios.map((t) => buildComboOddsKey(t)));
    expect(unionKeys.size).toBe(10); // 和集合の件数そのものを無条件に固定(空振り防止)
    expect(unionKeys).toEqual(fullKeys);
  });
});

describe("deriveNarTrioAxisUmabans → narTrioOddsAxisUrl(導出した軸集合を実際に叩くURLで固定する)", () => {
  it("非連番の軸集合をnarTrioOddsAxisUrlに通し、生成されたURL文字列のjiku値が軸集合と一致すること", () => {
    const raceId = parseRaceId("202654071210");
    const axes = deriveNarTrioAxisUmabans([2, 3, 5, 7, 9]);
    expect(axes).toEqual([2, 3, 5]); // 前提を固定(空振り防止)

    const urls = axes.map((jiku) => narTrioOddsAxisUrl(raceId, jiku));
    expect(urls).toEqual([
      "https://nar.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=202654071210&jiku=2",
      "https://nar.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=202654071210&jiku=3",
      "https://nar.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=202654071210&jiku=5",
    ]);
  });
});
