import { describe, expect, it } from "vitest";
import { DIRECTION_KEYS, POPULARITY_KEYS, type AdjustmentFit, type FitBucket, type FitGroup, type FitVersion } from "../src/adjustment-fit";
import { adjustmentFitHasData, adjustmentFitPromptLines, adjustmentFitSections, FIT_UNAVAILABLE_NOTES } from "../src/adjustment-fit-format";

/**
 * Issue #509: 「補正の当たり具合」の文面(画面とプロンプトが同じ関数を通す)。数字の表し方・数の少ない区分の印・版別の見出し・読み出せなかった月報の扱いを固定する。
 */

const bucket = <K extends string>(key: K, count: number, placedCount: number, meanPrior: number | null, meanAdjusted: number | null): FitBucket<K> => ({ key, count, placedCount, meanPrior, meanAdjusted });

function group(over: Partial<FitGroup> = {}): FitGroup {
  return {
    raceCount: 80,
    horseCount: 1000,
    byDirection: [
      bucket("bigUp", 412, 187, 0.278, 0.347),
      bucket("up", 100, 40, 0.25, 0.27),
      bucket("same", 300, 90, 0.3, 0.3),
      bucket("down", 150, 40, 0.3, 0.28),
      bucket("bigDown", 29, 8, 0.4, 0.33),
    ],
    byPopularity: [bucket("1", 80, 50, 0.499, 0.508), bucket("2-3", 160, 70, 0.383, 0.388), bucket("4-6", 240, 60, 0.264, 0.258), bucket("7+", 0, 0, null, null)],
    brier: { prior: 0.1234, adjusted: 0.121 },
    optimalK: 1.4523,
    ...over,
  };
}

function fit(over: Partial<AdjustmentFit> = {}): AdjustmentFit {
  return { all: group(), byVersion: [], hiddenVersionCount: 0, excluded: { suspect: 2, unknown: 1, uncheckedRaces: 3, estimated: 4, notLlm: 5 }, ...over };
}

const rowsOf = (sections: ReturnType<typeof adjustmentFitSections>, heading: string) => sections.find((s) => s.heading === heading)?.rows ?? [];

describe("adjustmentFitSections", () => {
  it("月全体は 3 つの節(要約・補正の向き別・人気の帯別)。キーの数と順は区分の定義どおり", () => {
    const s = adjustmentFitSections(fit());
    expect(s.map((x) => x.heading)).toEqual(["補正の当たり具合(月全体・80 レース・1000 頭)", "補正の向き別(月全体)", "人気の帯別(月全体)"]);
    expect(rowsOf(s, "補正の向き別(月全体)")).toHaveLength(DIRECTION_KEYS.length);
    expect(rowsOf(s, "人気の帯別(月全体)")).toHaveLength(POPULARITY_KEYS.length);
  });

  it("向き別の行: 頭数・統計モデル・補正後・実際(3 着内の頭数/頭数)を出す。ラベルに境目の向きを書く", () => {
    const rows = rowsOf(adjustmentFitSections(fit()), "補正の向き別(月全体)");
    expect(rows.map((r) => r.label)).toEqual(["大きく上げた(+5pt 超)", "上げた(+1pt 超〜+5pt)", "ほぼそのまま(±1pt)", "下げた(−1pt 超〜−5pt)", "大きく下げた(−5pt 超)"]);
    expect(rows[0]!.value).toBe("412 頭・統計モデル 27.8%・補正後 34.7%・実際 45.4%(187/412)");
  });

  it("30 頭未満の区分には『※30 頭未満』を付け、30 頭以上には付けない。頭数 0 の区分は『0 頭』だけ", () => {
    const rows = rowsOf(adjustmentFitSections(fit()), "補正の向き別(月全体)");
    expect(rows[4]!.value).toContain("※30 頭未満"); // 29 頭
    expect(rows[3]!.value).not.toContain("※30 頭未満"); // 150 頭
    expect(rowsOf(adjustmentFitSections(fit()), "人気の帯別(月全体)")[3]!.value).toBe("0 頭");
    const at30 = fit({ all: group({ byDirection: [bucket("bigUp", 30, 10, 0.3, 0.3), ...group().byDirection.slice(1)] }) });
    expect(rowsOf(adjustmentFitSections(at30), "補正の向き別(月全体)")[0]!.value).not.toContain("※30 頭未満");
  });

  it("要約の行: Brier(差つき)と倍率 k。k の分母が 0(null)・Brier が無いときは『なし』", () => {
    const rows = rowsOf(adjustmentFitSections(fit()), "補正の当たり具合(月全体・80 レース・1000 頭)");
    expect(rows[0]).toEqual({ label: "3 着内の Brier", value: "統計モデル 0.1234・補正後 0.1210(差 −0.0024。負なら補正で良くなった)" });
    expect(rows[1]!.label).toBe("最適な倍率 k");
    expect(rows[1]!.value).toContain("1.45");
    const none = adjustmentFitSections(fit({ all: group({ optimalK: null }) }));
    expect(rowsOf(none, "補正の当たり具合(月全体・80 レース・1000 頭)")[1]!.value).toContain("なし");
  });

  it("母集団の説明(除いた件数の内訳)と、版別に出さなかった版の数を、月全体の節の注に書く", () => {
    const note = adjustmentFitSections(fit({ hiddenVersionCount: 2 }))[0]!.note;
    expect(note).not.toBeNull();
    expect(note).toContain("先読みの疑い 2");
    expect(note).toContain("判定不能 1");
    expect(note).toContain("発走時刻の確認待ち 3");
    expect(note).toContain("推定オッズ 4");
    expect(note).toContain("LLM 不使用 5");
    expect(note).toContain("30 レース未満の版(2 版)");
    expect(adjustmentFitSections(fit({ hiddenVersionCount: 0 }))[0]!.note).not.toContain("30 レース未満の版");
  });

  it("版ごとの節: 版の見出しにレース数を書き、版の昇順に 3 節ずつ並ぶ", () => {
    const v = (promptVersion: string): FitVersion => ({ promptVersion, ...group({ raceCount: 31, horseCount: 400 }) });
    const s = adjustmentFitSections(fit({ byVersion: [v("2026-10-18.2"), v("2026-10-25.1")] }));
    expect(s.map((x) => x.heading).slice(3)).toEqual([
      "補正の当たり具合(版 2026-10-18.2・31 レース・400 頭)",
      "補正の向き別(版 2026-10-18.2)",
      "人気の帯別(版 2026-10-18.2)",
      "補正の当たり具合(版 2026-10-25.1・31 レース・400 頭)",
      "補正の向き別(版 2026-10-25.1)",
      "人気の帯別(版 2026-10-25.1)",
    ]);
  });

  it("対象のレースが無いとき(raceCount 0)は、表を出さず説明の 1 節だけ", () => {
    const empty = fit({ all: group({ raceCount: 0, horseCount: 0, byDirection: group().byDirection.map((b) => bucket(b.key, 0, 0, null, null)) }) });
    const s = adjustmentFitSections(empty);
    expect(s).toHaveLength(1);
    expect(s[0]!.rows).toEqual([]);
    expect(s[0]!.note).toContain("対象のレースがありません");
    expect(adjustmentFitHasData(empty)).toBe(false);
    expect(adjustmentFitHasData(fit())).toBe(true);
  });

  it("読み出せなかった月報(unavailable)は、理由ごとの固定の 1 節だけ(例外の本文は出さない)", () => {
    for (const reason of ["read-failed", "too-many", "compute-failed"] as const) {
      const s = adjustmentFitSections({ unavailable: reason });
      expect(s).toHaveLength(1);
      expect(s[0]!.rows).toEqual([]);
      expect(s[0]!.note).toBe(FIT_UNAVAILABLE_NOTES[reason]);
    }
    expect(new Set(Object.values(FIT_UNAVAILABLE_NOTES)).size).toBe(3);
    expect(adjustmentFitHasData({ unavailable: "read-failed" })).toBe(false);
  });

  it("項目の無い昔の月報(undefined)は節なし", () => {
    expect(adjustmentFitSections(undefined)).toEqual([]);
    expect(adjustmentFitHasData(undefined)).toBe(false);
  });
});

describe("adjustmentFitPromptLines: プロンプトに入れる行", () => {
  it("データがあるときは、見出し・注・行を同じ文面で並べる", () => {
    const lines = adjustmentFitPromptLines(fit());
    expect(lines).toContain("### 補正の向き別(月全体)");
    expect(lines).toContain("- 大きく上げた(+5pt 超): 412 頭・統計モデル 27.8%・補正後 34.7%・実際 45.4%(187/412)");
  });

  it("データが無い・読み出せなかった・昔の月報のときは、行を出さない(プロンプトにその節を入れない)", () => {
    expect(adjustmentFitPromptLines(undefined)).toEqual([]);
    expect(adjustmentFitPromptLines({ unavailable: "too-many" })).toEqual([]);
  });
});
