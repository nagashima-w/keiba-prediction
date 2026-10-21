import { describe, expect, it } from "vitest";
import { formatSignedPt } from "../../packages/core/src/view/verify-format";
import {
  renderConditionSections,
  renderPopularitySections,
  WIN_PLACE_GAP_MIN,
  type BandStat,
  type ConditionRow,
  type ConditionStats,
  type PopularityStats,
} from "../src/verify-breakdown";

/**
 * Issue #445(#358-G 前半): 検証画面の「差」の符号と、内訳の説明文。
 * 丸めて 0 になる値(−0.04 など)が `-0.0pt` と出ていた(#384 の記録 4)。符号は**丸めた後の文字列**で決める。
 */

describe("formatSignedPt: 差(pt)の符号は丸めた後の値で決める", () => {
  // [入力(pt), 期待する表示]。境界: 丸めて 0.0 になる範囲(|x| < 0.05)は符号なし、0.05 以上は丸めて 0.1 になり符号が付く。
  const cases: readonly (readonly [number, string])[] = [
    [-0.04, "0.0pt"],
    [-0.049999, "0.0pt"],
    [-0, "0.0pt"],
    [0, "0.0pt"],
    [0.04, "0.0pt"],
    [0.0499, "0.0pt"],
    [-0.05, "-0.1pt"],
    [0.05, "+0.1pt"],
    [-0.06, "-0.1pt"],
    [0.06, "+0.1pt"],
    [47.5, "+47.5pt"],
    [-12.34, "-12.3pt"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(formatSignedPt(input)).toBe(expected);
  });
});

/** 差が出る BandStat(回収率 − 期待値 = gap の割合。差(pt)は gap × 100)。 */
function bandWithGap(gap: number): BandStat {
  const meanEv = 1.2;
  return {
    bets: 2, races: 1, stake: 200, payout: 240, hits: 1, evBets: 2, evMissing: 0, meanEv, expectedHits: 1, recovery: meanEv + gap, hitRatio: 1,
    recoveryInterval: null, hitRatioInterval: null,
  };
}
const diffCell = (stat: BandStat): string => {
  const stats: PopularityStats = { groups: [], gap: [{ key: "small", stat }] };
  const row = renderPopularitySections(stats)[0]!.rows[0]!;
  return row.cells.find((c) => c.name === "差(実績−予想)")!.value;
};

describe("差(実績−予想)の表示(人気帯の内訳)", () => {
  // 前提: 値が 0 でない(差の式が 0 に張り付いていないこと)を、−0.0004(= −0.04pt)と +0.0004 の両方で確かめる。
  it.each([
    [-0.0004, "0.0pt"],
    [0.0004, "0.0pt"],
    [-0.0006, "-0.1pt"], // 期待値 1.2 との引き算で浮動小数点の誤差が乗るので、境界(±0.0005)ちょうどは避ける。境界は formatSignedPt の表で見る
    [0.0006, "+0.1pt"],
    [0.475, "+47.5pt"],
  ])("回収率 − 期待値 = %s → %s", (gap, expected) => {
    expect(gap).not.toBe(0);
    expect(diffCell(bandWithGap(gap))).toBe(expected);
  });
});

function conditionRow(diffFromAll: number | null): ConditionRow {
  return { label: "東京", races: 6, bets: 6, hitRaces: 2, hitRate: 1 / 3, hitInterval: null, stake: 600, payout: 300, recovery: 0.5, recoveryInterval: null, diffFromAll };
}
const conditionDiffCell = (diffFromAll: number | null): string => {
  const stats: ConditionStats = {
    overall: { races: 6, bets: 6, hitRaces: 2, stake: 600, payout: 300, recovery: 0.5, hitRate: 1 / 3, hitInterval: null, recoveryInterval: null },
    dimensions: [{ key: "venue", rows: [conditionRow(diffFromAll)] }],
  };
  const row = renderConditionSections(stats, "all")[0]!.rows[1]!;
  return row.cells.find((c) => c.name === "全体との差")!.value;
};

describe("全体との差の表示(条件ごとの的中率と回収率)", () => {
  it.each([
    [-0.0004, "0.0pt"],
    [0.0004, "0.0pt"],
    [-0.0005, "-0.1pt"],
    [0.0005, "+0.1pt"],
    [0.1667, "+16.7pt"],
    [-0.1667, "-16.7pt"],
  ])("回収率 − 全体の回収率 = %s → %s", (diff, expected) => {
    expect(diff).not.toBe(0);
    expect(conditionDiffCell(diff)).toBe(expected);
  });
  it("差が無い(null)ときは『-』", () => {
    expect(conditionDiffCell(null)).toBe("-");
  });
});

describe("内訳の説明文(Issue #445 G-1)", () => {
  const gapSection = () => renderPopularitySections({ groups: [], gap: [{ key: "small", stat: bandWithGap(0.1) }] })[0]!;
  it("ずれの節: 逆向きの馬は『差が −4 以下』と書く(『4 以下の負の馬』という読み違えやすい書き方をしない)", () => {
    expect(WIN_PLACE_GAP_MIN).toBe(4);
    const d = gapSection().description;
    expect(d).toContain("差が −4 以下");
    expect(d).not.toContain("以下の負の馬");
  });
  it("注記: 期待値は ev のある買い目・回収率は全買い目が母集団であることと、返還は期待値に入るが予想した的中数に入らないことを述べる", () => {
    const n = gapSection().note;
    expect(n).toContain("予想した期待値は ev のある買い目、実際の回収率は全買い目が対象");
    expect(n).toContain("返還は期待値には入りますが、予想した的中数には入りません");
  });
  it("注記は人気帯の節(複勝)にも付く", () => {
    const place = renderPopularitySections({
      groups: [{ key: "place", basis: "analysis", bands: [bandWithGap(0.1), bandWithGap(0.1), bandWithGap(0.1), bandWithGap(0.1)], unknown: bandWithGap(0.1), excluded: null }],
      gap: [],
    })[0]!;
    expect(place.note).toContain("返還は期待値には入りますが、予想した的中数には入りません");
  });
});
