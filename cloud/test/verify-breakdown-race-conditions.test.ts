import { describe, expect, it } from "vitest";
import { collectProposedBetEvents, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import {
  buildConditionStats,
  computeVerifyBreakdowns,
  createPopularityLookups,
  renderConditionSections,
  type BreakdownSection,
  type ConditionKey,
  type ConditionRow,
  type ConditionStats,
} from "../src/verify-breakdown";
import { buildConditionFactsIndex } from "../src/verify-race-conditions";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyBetRow, type VerifyReadRows, type VerifyResultRow } from "../src/verify-read";

/**
 * Issue #389(#385-B の b): 条件別の見える化に、距離帯・馬場・芝ダの 3 軸を足す(クラスは #426 のあとに #389-c で足すので、ここでは出さない)。
 * 条件は分析の行(`analyses` の条件の列。`race-facts.ts` が写したもの)から引く。単位はレース、買い目の判定は core の `collectProposedBetEvents`。
 */

// ---------------------------------------------------------------------------
// 見本: 分析を 1 つずつ作る(複勝 01 を 100 円。的中なら 1 着で払戻 150)
// ---------------------------------------------------------------------------

type Conditions = Pick<VerifyAnalysisRow, "courseType" | "distance" | "trackCondition" | "grade" | "raceName" | "condRead">;

interface AnalysisSpec {
  readonly raceId: string;
  readonly hit: boolean;
  readonly conditions: Conditions;
  /** 分析日時(最新の分析の選択に使う)。省略は 05:00Z(発走前)。 */
  readonly analyzedAt?: string;
  /** true なら先読みの遮断の記録が無く、発走後(17:00 JST)の分析 = suspect(集計から除かれる)。 */
  readonly suspect?: boolean;
}

const cond = (courseType: string | null, distance: number | null, trackCondition: string | null, grade: string | null, raceName: string | null, condRead: 0 | 1 = 1): Conditions => ({
  courseType, distance, trackCondition, grade, raceName, condRead,
});

function rowsOf(specs: readonly AnalysisSpec[]): VerifyReadRows {
  const analyses: VerifyAnalysisRow[] = specs.map((s, i) => ({
    id: i + 1, raceId: s.raceId, analyzedAt: s.analyzedAt ?? (s.suspect === true ? "2026-07-05T08:00:00.000Z" : "2026-07-05T05:00:00.000Z"), evEstimated: 0, promptVersion: "v1",
    additionalInstruction: null, kaisaiDate: "20260705", model: null, rawResponse: null,
    raceSnapshotJson: JSON.stringify({ race: { startTime: "15:45" } }),
    historyCutoffDate: s.suspect === true ? null : "20260705", promptLookaheadGuarded: s.suspect === true ? 0 : 1, startTime: "15:45",
    ...s.conditions,
  }));
  const horses = specs.flatMap((_, i) =>
    Array.from({ length: 10 }, (_v, k) => ({
      analysisId: i + 1, umaban: k + 1, prior: 0.3, adjusted_prob: 0.3, place_odds_min: 1.5 + 0.5 * k, ev: 1, is_positive: 1,
      contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null,
    })),
  );
  const seen = new Set<string>();
  const results: VerifyResultRow[] = [];
  for (const s of specs) {
    if (seen.has(s.raceId)) continue;
    seen.add(s.raceId);
    results.push({ raceId: s.raceId, umaban: 1, finishPosition: s.hit ? 1 : 5, placePayout: s.hit ? 150 : null, winPayout: null });
    results.push({ raceId: s.raceId, umaban: 2, finishPosition: 2, placePayout: 180, winPayout: null });
  }
  return {
    analyses,
    horses,
    allocationMeta: specs.map((_, i) => ({ analysisId: i + 1, route: "place-only", skipReasonCode: null })),
    bets: specs.map((_, i): VerifyBetRow => ({ analysisId: i + 1, betType: "place", comboKey: "01", stake: 100, odds: 2, ev: 1.2 })),
    results,
    comboPayouts: [],
    comboImports: [],
  };
}

const raceId = (venueCode: string, n: number): string => `2026${venueCode}0105${String(n).padStart(2, "0")}`;
const TOKYO = "05";
const OOI = "44";

/**
 * 中央 7 レース + 地方 4 レース(計 11)。条件は軸ごとに 2 行以上に分かれ、不明の行も非空になるように作る。
 *  中央: c1 芝1600 良(的中)/ c2 芝1200 稍 / c3 ダ1800 重 / c4 ダ2400 不良(的中)/ c5 障3000 良 / c6 条件を読めなかった(cond_read=0)/ c7 芝2000 「−」
 *  地方: n1 ダ1400 良(的中)/ n2 ダ1870 稍重 / n3 ダ1200 馬場なし / n4 ダ1300 良
 * グレード・レース名の列にも値を入れるが、集計は使わない(クラスを出さない間は索引にも持たない)。
 */
const SAMPLE: readonly AnalysisSpec[] = [
  { raceId: raceId(TOKYO, 1), hit: true, conditions: cond("芝", 1600, "良", null, "3歳以上1勝クラス") },
  { raceId: raceId(TOKYO, 2), hit: false, conditions: cond("芝", 1200, "稍", null, "3歳未勝利") },
  { raceId: raceId(TOKYO, 3), hit: false, conditions: cond("ダ", 1800, "重", null, "2歳新馬") },
  { raceId: raceId(TOKYO, 4), hit: true, conditions: cond("ダ", 2400, "不良", "G2", "毎日王冠") },
  { raceId: raceId(TOKYO, 5), hit: false, conditions: cond("障", 3000, "良", null, "障害3歳以上未勝利") },
  { raceId: raceId(TOKYO, 6), hit: false, conditions: { courseType: "芝", distance: 1600, trackCondition: "良", grade: null, raceName: "3歳以上2勝クラス", condRead: 0 } },
  { raceId: raceId(TOKYO, 7), hit: false, conditions: cond("芝", 2000, "−", null, "ひまわり賞") },
  { raceId: raceId(OOI, 1), hit: true, conditions: cond("ダ", 1400, "良", null, "ランチタイム(C3)") },
  { raceId: raceId(OOI, 2), hit: false, conditions: cond("ダ", 1870, "稍重", null, "メインレース(B1)") },
  { raceId: raceId(OOI, 3), hit: false, conditions: cond("ダ", 1200, null, "Jpn1", "帝王賞") },
  { raceId: raceId(OOI, 4), hit: false, conditions: cond("ダ", 1300, "良", null, "帝王賞予選") },
];

function statsOf(rows: VerifyReadRows): { stats: ConditionStats; source: ReturnType<typeof buildVerifySource> } {
  const source = buildVerifySource(rows);
  const events = collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG);
  return { source, stats: buildConditionStats(source, events, createPopularityLookups(source), buildConditionFactsIndex(rows.analyses)) };
}

const AXES: readonly ConditionKey[] = ["distance", "track", "surface"];
const dimension = (stats: ConditionStats, key: ConditionKey): readonly ConditionRow[] => stats.dimensions.find((d) => d.key === key)!.rows;
const byLabel = (rows: readonly ConditionRow[]): Record<string, { races: number; hitRaces: number }> =>
  Object.fromEntries(rows.map((r) => [r.label, { races: r.races, hitRaces: r.hitRaces }]));
const labelsOf = (rows: readonly ConditionRow[]): string[] => rows.map((r) => r.label);

// ---------------------------------------------------------------------------
// 見本が退化していない / 各軸の振り分け
// ---------------------------------------------------------------------------

describe("buildConditionStats: 距離帯・馬場・芝ダ", () => {
  it("見本が退化していない: 11 レース・賭け金 1,100 円・払戻 450 円(的中 3 レース)", () => {
    const { stats } = statsOf(rowsOf(SAMPLE));
    expect(stats.overall).toMatchObject({ races: 11, bets: 11, stake: 1100, payout: 450, hitRaces: 3 });
  });

  it("距離帯: 境界の振り分けと、障害・不明の行(条件を読めなかったレース = 不明)。並びは帯の順で、不明が最後", () => {
    const rows = dimension(statsOf(rowsOf(SAMPLE)).stats, "distance");
    expect(labelsOf(rows)).toEqual(["〜1400m", "1401〜1800m", "1801〜2200m", "2201m〜", "障害", "不明"]);
    expect(byLabel(rows)).toEqual({
      "〜1400m": { races: 4, hitRaces: 1 }, // c2(1200)・n1(1400)・n3(1200)・n4(1300)
      "1401〜1800m": { races: 2, hitRaces: 1 }, // c1(1600)・c3(1800)
      "1801〜2200m": { races: 2, hitRaces: 0 }, // c7(2000)・n2(1870)
      "2201m〜": { races: 1, hitRaces: 1 }, // c4(2400)
      "障害": { races: 1, hitRaces: 0 }, // c5
      "不明": { races: 1, hitRaces: 0 }, // c6(cond_read=0)
    });
  });

  it("馬場: 正規化(稍 → 稍重)。『−』・null・条件を読めなかったレースは『未発表・不明』", () => {
    const rows = dimension(statsOf(rowsOf(SAMPLE)).stats, "track");
    expect(labelsOf(rows)).toEqual(["良", "稍重", "重", "不良", "未発表・不明"]);
    expect(byLabel(rows)).toEqual({
      "良": { races: 4, hitRaces: 2 }, // c1・c5・n1・n4
      "稍重": { races: 2, hitRaces: 0 }, // c2(稍)・n2
      "重": { races: 1, hitRaces: 0 },
      "不良": { races: 1, hitRaces: 1 },
      "未発表・不明": { races: 3, hitRaces: 0 }, // c6・c7(−)・n3(null)
    });
  });

  it("芝ダ: 芝・ダ・障害・不明の 4 行", () => {
    const rows = dimension(statsOf(rowsOf(SAMPLE)).stats, "surface");
    expect(labelsOf(rows)).toEqual(["芝", "ダ", "障害", "不明"]);
    expect(byLabel(rows)).toEqual({
      "芝": { races: 3, hitRaces: 1 }, // c1・c2・c7
      "ダ": { races: 6, hitRaces: 2 }, // c3・c4・n1〜n4
      "障害": { races: 1, hitRaces: 0 },
      "不明": { races: 1, hitRaces: 0 },
    });
  });

  it("★保存則: 各軸の行のレース数・点数・賭け金・払戻・的中レースの和が全体と一致する(各軸 2 行以上で、不明の行が非空)", () => {
    const { stats } = statsOf(rowsOf(SAMPLE));
    for (const key of AXES) {
      const rows = dimension(stats, key);
      expect(rows.length, `${key} は 2 行以上`).toBeGreaterThanOrEqual(2);
      expect(rows.some((r) => ["不明", "未発表・不明"].includes(r.label) && r.races > 0), `${key} は不明の行が非空`).toBe(true);
      const sum = (pick: (r: ConditionRow) => number): number => rows.reduce((s, r) => s + pick(r), 0);
      expect(sum((r) => r.races), `${key} のレース数`).toBe(stats.overall.races);
      expect(sum((r) => r.bets), `${key} の点数`).toBe(stats.overall.bets);
      expect(sum((r) => r.stake), `${key} の賭け金`).toBe(stats.overall.stake);
      expect(sum((r) => r.payout), `${key} の払戻`).toBe(stats.overall.payout);
      expect(sum((r) => r.hitRaces), `${key} の的中レース`).toBe(stats.overall.hitRaces);
    }
  });

  it("行の値: 的中レース率・回収率・全体との差が付く(距離帯 1401〜1800m は 2 レース・的中 1・賭け金 200・払戻 150)", () => {
    const { stats } = statsOf(rowsOf(SAMPLE));
    const row = dimension(stats, "distance").find((r) => r.label === "1401〜1800m")!;
    expect(row).toMatchObject({ races: 2, bets: 2, hitRaces: 1, hitRate: 0.5, stake: 200, payout: 150, recovery: 0.75 });
    expect(row.diffFromAll).toBeCloseTo(0.75 - 450 / 1100, 12);
    expect(row.hitInterval).not.toBeNull();
    expect(row.recoveryInterval).not.toBeNull(); // 2 レース以上は区間あり
  });

  it("★b6 不明が 0 件なら『不明』の行を出さない(全レースの条件が読めた)", () => {
    const known = SAMPLE.filter((s) => s.conditions.condRead === 1 && s.conditions.trackCondition !== "−" && s.conditions.trackCondition !== null);
    expect(known.length).toBeGreaterThan(5); // 前提
    const { stats } = statsOf(rowsOf(known));
    for (const key of AXES) {
      const labels = labelsOf(dimension(stats, key));
      expect(labels.length).toBeGreaterThanOrEqual(2);
      expect(labels, key).not.toContain("不明");
      expect(labels, key).not.toContain("未発表・不明");
    }
  });

  it("★b7 複数の分析のあるレースは、集計に採用された最新の分析の条件を使う(古い分析の馬場は使わない)", () => {
    const id = raceId(TOKYO, 1);
    const rows = rowsOf([
      { raceId: id, hit: true, analyzedAt: "2026-07-05T03:00:00.000Z", conditions: cond("芝", 1600, "良", null, "3歳以上1勝クラス") },
      { raceId: id, hit: true, analyzedAt: "2026-07-05T04:00:00.000Z", conditions: cond("芝", 1600, "稍", null, "3歳以上1勝クラス") },
    ]);
    const { stats, source } = statsOf(rows);
    expect(collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG).map((e) => e.analysisId)).toEqual([2]); // 前提: 最新(id 2)だけが採用される
    expect(byLabel(dimension(stats, "track"))).toEqual({ "稍重": { races: 1, hitRaces: 1 } });
  });

  it("★b7 最新の分析が先読みの疑いで除かれたら、採用された(古い)分析の条件を使う", () => {
    const id = raceId(TOKYO, 1);
    const rows = rowsOf([
      { raceId: id, hit: true, analyzedAt: "2026-07-05T03:00:00.000Z", conditions: cond("芝", 1600, "良", null, "3歳以上1勝クラス") },
      { raceId: id, hit: true, suspect: true, conditions: cond("芝", 1600, "不良", null, "3歳以上1勝クラス") },
    ]);
    const { stats, source } = statsOf(rows);
    expect(collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG).map((e) => e.analysisId)).toEqual([1]); // 前提: 疑いの分析 2 は除かれる
    expect(byLabel(dimension(stats, "track"))).toEqual({ "良": { races: 1, hitRaces: 1 } });
  });

  it("条件の索引を渡さない呼び出し(従来の呼び方)は、全レースが各軸の不明の行に入る", () => {
    const rows = rowsOf(SAMPLE);
    const source = buildVerifySource(rows);
    const stats = buildConditionStats(source, collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG));
    for (const key of AXES) {
      expect(dimension(stats, key).map((r) => [r.races]), key).toEqual([[11]]);
    }
  });
});

// ---------------------------------------------------------------------------
// 表示用の節
// ---------------------------------------------------------------------------

const NEW_HEADINGS = [
  "条件ごとの的中率と回収率(距離帯)",
  "条件ごとの的中率と回収率(馬場)",
  "条件ごとの的中率と回収率(芝ダ)",
];
const sectionOf = (sections: readonly BreakdownSection[], heading: string): BreakdownSection => sections.find((s) => s.heading === heading)!;

describe("computeVerifyBreakdowns: 3 つの節が条件別の節の最後に付く", () => {
  const out = computeVerifyBreakdowns(buildVerifySource(rowsOf(SAMPLE)), rowsOf(SAMPLE).bets, buildConditionFactsIndex(rowsOf(SAMPLE).analyses));

  it("★b9 節の数: 全体 11(人気帯 5 + 開催区分・競馬場・頭数 3 + 新 3)、中央のみ・地方のみ 10(開催区分の節なし)", () => {
    expect(out.all!.sections).toHaveLength(11);
    expect(out.central!.sections).toHaveLength(10);
    expect(out.nar!.sections).toHaveLength(10);
  });

  it("並び: 競馬場・頭数の節に続けて 距離帯 → 馬場 → 芝ダ", () => {
    expect(out.all!.sections.slice(5).map((s) => s.heading)).toEqual([
      "条件ごとの的中率と回収率(開催区分)",
      "条件ごとの的中率と回収率(競馬場)",
      "条件ごとの的中率と回収率(頭数)",
      ...NEW_HEADINGS,
    ]);
  });

  it("各節は先頭に『全体』の行(全体との差は無い)と、条件の行。『不明』の行は最後。行の値は文字列で組み立て済み", () => {
    const section = sectionOf(out.all!.sections, NEW_HEADINGS[0]!);
    expect(section.rows.map((r) => r.label)).toEqual(["全体", "〜1400m", "1401〜1800m", "1801〜2200m", "2201m〜", "障害", "不明"]);
    expect(section.rows[0]!.cells.map((c) => c.name)).toEqual(["レース数(点)", "的中レース率", "回収率"]);
    expect(section.rows[0]!.cells[0]).toEqual({ name: "レース数(点)", value: "11R(11点)" });
    expect(section.rows[2]!.cells[0]).toEqual({ name: "レース数(点)", value: "2R(2点)" });
    expect(section.rows[2]!.cells.map((c) => c.name)).toContain("全体との差");
    expect(section.rows[2]!.cells.map((c) => c.name)).toContain("注意"); // 2 レースは参考
  });

  it("★b8 区分ごとに絞る: 中央のみには地方のレースの行が出ず、地方のみには中央のレースの行が出ない", () => {
    const track = (v: "all" | "central" | "nar") => sectionOf(out[v]!.sections, NEW_HEADINGS[1]!).rows.map((r) => [r.label, r.cells[0]!.value]);
    expect(track("all")).toEqual([["全体", "11R(11点)"], ["良", "4R(4点)"], ["稍重", "2R(2点)"], ["重", "1R(1点)"], ["不良", "1R(1点)"], ["未発表・不明", "3R(3点)"]]);
    expect(track("central")).toEqual([["全体", "7R(7点)"], ["良", "2R(2点)"], ["稍重", "1R(1点)"], ["重", "1R(1点)"], ["不良", "1R(1点)"], ["未発表・不明", "2R(2点)"]]);
    expect(track("nar")).toEqual([["全体", "4R(4点)"], ["良", "2R(2点)"], ["稍重", "1R(1点)"], ["未発表・不明", "1R(1点)"]]);
  });

  it("★D2 分類できたレースが 0 件の軸は節ごと省く(芝ダだけ分かる入力は、人気帯 5 + 既存 3 + 芝ダ 1 = 9 節)", () => {
    // 障害のレースは距離帯の軸でも『障害』の行に分類できてしまうので、除く(分類できたレースが 0 件の軸を作るため)
    const specs: AnalysisSpec[] = SAMPLE.filter((s) => s.conditions.courseType !== "障").map((s) => ({
      ...s,
      conditions: { courseType: s.conditions.courseType, distance: null, trackCondition: null, grade: null, raceName: null, condRead: 1 },
    }));
    expect(specs.length).toBeGreaterThan(5); // 前提
    const rows = rowsOf(specs);
    const result = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets, buildConditionFactsIndex(rows.analyses)).all!;
    expect(result.sections).toHaveLength(9);
    expect(result.sections.map((s) => s.heading).slice(8)).toEqual([NEW_HEADINGS[2]]);
  });

  it("★D2 条件の索引を渡さない呼び出し(従来の呼び方)は、全軸が不明だけなので新しい節は出ない(全体 8・中央 7 のまま)", () => {
    const rows = rowsOf(SAMPLE);
    const legacy = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    expect(legacy.all!.sections).toHaveLength(8);
    expect(legacy.central!.sections).toHaveLength(7);
  });

  it("クラスの節は出さない(#426 のあとに #389-c で足す)。新しい節は距離帯・馬場・芝ダの 3 つだけ", () => {
    for (const v of ["all", "central", "nar"] as const) {
      const headings = out[v]!.sections.map((x) => x.heading);
      expect(headings.filter((h) => h.includes("クラス"))).toEqual([]);
      expect(headings.filter((h) => NEW_HEADINGS.includes(h))).toEqual(NEW_HEADINGS);
    }
  });

  it("★b10 注記: 馬場は分析時点の値、距離帯は区切りが置き値であること", () => {
    const track = sectionOf(out.all!.sections, NEW_HEADINGS[1]!);
    expect(track.description + track.note).toContain("分析時点");
    expect(track.description + track.note).toContain("未発表・不明");
    const distance = sectionOf(out.all!.sections, NEW_HEADINGS[0]!);
    expect(distance.description).toContain("1400");
    expect(distance.description).toContain("置き値");
  });

  it("★b10 文言は短い: 既存の 3 節の長い説明・注記を繰り返さない(説明 100 字以内・注記 120 字以内)", () => {
    const existing = sectionOf(out.all!.sections, "条件ごとの的中率と回収率(競馬場)");
    expect(existing.description.length).toBeGreaterThan(100); // 前提: 既存は長い
    expect(existing.note.length).toBeGreaterThan(120);
    for (const heading of NEW_HEADINGS) {
      const s = sectionOf(out.all!.sections, heading);
      expect(s.description.length, `${heading} の説明`).toBeLessThanOrEqual(100);
      expect(s.note.length, `${heading} の注記`).toBeLessThanOrEqual(120);
      expect(s.description).not.toBe(existing.description);
      expect(s.note).not.toBe(existing.note);
    }
  });

  it("同じ入力なら同じ結果(固定シード)", () => {
    const rows = rowsOf(SAMPLE);
    const again = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets, buildConditionFactsIndex(rows.analyses));
    expect(JSON.stringify(again)).toBe(JSON.stringify(out));
  });
});

describe("renderConditionSections: 新しい軸の節", () => {
  it("開催区分の節は全体の区分でだけ出す(新しい 3 軸は区分に依らず出る)", () => {
    const { stats } = statsOf(rowsOf(SAMPLE));
    expect(renderConditionSections(stats, "all").map((s) => s.heading)).toContain(NEW_HEADINGS[2]);
    expect(renderConditionSections(stats, "central").map((s) => s.heading)).toContain(NEW_HEADINGS[2]);
    expect(renderConditionSections(stats, "central").map((s) => s.heading)).not.toContain("条件ごとの的中率と回収率(開催区分)");
  });
});
