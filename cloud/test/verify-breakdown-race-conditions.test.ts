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
 * Issue #389(#385-B の b): 条件別の見える化に、距離帯・馬場・芝ダの 3 軸を足す。クラス(#389-c)の試験はこのファイルの後半(`race_class` を持つ見本 CLASSED)。
 * 条件は分析の行(`analyses` の条件の列。`race-facts.ts` が写したもの)から引く。単位はレース、買い目の判定は core の `collectProposedBetEvents`。
 */

// ---------------------------------------------------------------------------
// 見本: 分析を 1 つずつ作る(複勝 01 を 100 円。的中なら 1 着で払戻 150)
// ---------------------------------------------------------------------------

type Conditions = Pick<VerifyAnalysisRow, "courseType" | "distance" | "trackCondition" | "grade" | "raceName" | "condRead" | "raceClass">;

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
 * グレード・レース名の列にも値を入れるが、集計は使わない(クラスは正確な `race_class` だけを使い、推定しない)。この見本は `race_class` を持たない(補完前の状態。クラスの節は出ない)。
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

const AXES: readonly ConditionKey[] = ["distance", "track", "surface"]; // クラスは後半の別の describe で見る(分類できない中央の行が『不明』でなく『地方(対象外)』を持つため)
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

  it("★c0 race_class を持たない見本(補完前)では、クラスの節は出ない(レース名・グレードの列に値があっても推定しない)。新しい節は距離帯・馬場・芝ダの 3 つだけ", () => {
    expect(SAMPLE.filter((s) => s.conditions.raceName !== null).length).toBeGreaterThan(5); // 前提: レース名の列には値がある(推定の材料はある)
    for (const v of ["all", "central", "nar"] as const) {
      const headings = out[v]!.sections.map((x) => x.heading);
      expect(headings.filter((h) => h.includes("(クラス)"))).toEqual([]);
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


// ---------------------------------------------------------------------------
// クラス(Issue #389-c)
// ---------------------------------------------------------------------------

const CLASS_HEADING = "条件ごとの的中率と回収率(クラス)";
const CLASS_ORDER = ["新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン", "地方(対象外)", "不明"];

/** SAMPLE の各レースに race_class を足した見本(レース名の列は SAMPLE のまま = 推定の材料はあるが使わない)。 */
const CLASS_BY_RACE: Readonly<Record<string, string | null>> = {
  [raceId(TOKYO, 1)]: "1勝クラス", // 的中
  [raceId(TOKYO, 2)]: "未勝利",
  [raceId(TOKYO, 3)]: "新馬",
  [raceId(TOKYO, 4)]: "オープン", // 的中
  [raceId(TOKYO, 5)]: "未勝利", // 障害
  [raceId(TOKYO, 6)]: "2勝クラス", // cond_read=0(条件を読めなかった)のレースでもクラスは使う
  [raceId(TOKYO, 7)]: null, // 不明
  [raceId(OOI, 1)]: "C3", // 的中
  [raceId(OOI, 2)]: "B1",
  [raceId(OOI, 3)]: null,
  [raceId(OOI, 4)]: "3歳",
};
const CLASSED: readonly AnalysisSpec[] = SAMPLE.map((s) => ({ ...s, conditions: { ...s.conditions, raceClass: CLASS_BY_RACE[s.raceId] ?? null } }));

describe("buildConditionStats: クラス(#389-c)", () => {
  it("見本が退化していない: 中央 7 レースのうち 6 つに別々のクラス、地方 4 レースは全部違う区分(C3・B1・NULL・3歳)", () => {
    expect(CLASSED.filter((s) => s.raceId.startsWith("202605")).map((s) => s.conditions.raceClass).filter((c) => c !== null && c !== undefined)).toHaveLength(6);
    expect(CLASSED.filter((s) => s.raceId.startsWith("202644")).map((s) => s.conditions.raceClass)).toEqual(["C3", "B1", null, "3歳"]);
  });

  it("行の振り分け: 並びは固定の順(3勝クラスのように無い行は出ない)。cond_read=0 のレース(2勝クラス)も race_class で数える。地方 4 レースは『地方(対象外)』に 1 行でまとまる", () => {
    const rows = dimension(statsOf(rowsOf(CLASSED)).stats, "class");
    expect(labelsOf(rows)).toEqual(["新馬", "未勝利", "1勝クラス", "2勝クラス", "オープン", "地方(対象外)", "不明"]);
    expect(byLabel(rows)).toEqual({
      "新馬": { races: 1, hitRaces: 0 }, // c3
      "未勝利": { races: 2, hitRaces: 0 }, // c2・c5(障害)
      "1勝クラス": { races: 1, hitRaces: 1 }, // c1
      "2勝クラス": { races: 1, hitRaces: 0 }, // c6(cond_read=0)
      "オープン": { races: 1, hitRaces: 1 }, // c4
      "地方(対象外)": { races: 4, hitRaces: 1 }, // n1〜n4(n1 が的中)
      "不明": { races: 1, hitRaces: 0 }, // c7(NULL)
    });
  });

  it("★保存則: クラスの行のレース数・点数・賭け金・払戻・的中レースの和が全体と一致する(2 行以上で、不明の行が非空)", () => {
    const { stats } = statsOf(rowsOf(CLASSED));
    const rows = dimension(stats, "class");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.label === "不明" && r.races > 0)).toBe(true);
    const sum = (pick: (r: ConditionRow) => number): number => rows.reduce((s, r) => s + pick(r), 0);
    expect(sum((r) => r.races)).toBe(stats.overall.races);
    expect(sum((r) => r.bets)).toBe(stats.overall.bets);
    expect(sum((r) => r.stake)).toBe(stats.overall.stake);
    expect(sum((r) => r.payout)).toBe(stats.overall.payout);
    expect(sum((r) => r.hitRaces)).toBe(stats.overall.hitRaces);
  });

  it("行の値: 『未勝利』は 2 レース・的中 0・賭け金 200・払戻 0・回収率 0 で、全体との差は負、区間が付く", () => {
    const row = dimension(statsOf(rowsOf(CLASSED)).stats, "class").find((r) => r.label === "未勝利")!;
    expect(row).toMatchObject({ races: 2, bets: 2, hitRaces: 0, hitRate: 0, stake: 200, payout: 0, recovery: 0 });
    expect(row.diffFromAll).toBeCloseTo(0 - 450 / 1100, 12);
    expect(row.hitInterval).not.toBeNull();
    expect(row.recoveryInterval).not.toBeNull();
  });

  it("★c1 語彙に無い値・地方の区分が中央のレースに入っていても『不明』(中央の行に推測で入れない)", () => {
    const rows = rowsOf([
      { raceId: raceId(TOKYO, 1), hit: true, conditions: cond("芝", 1600, "良", null, null) },
      { raceId: raceId(TOKYO, 2), hit: false, conditions: { ...cond("芝", 1600, "良", null, null), raceClass: "C2" } },
      { raceId: raceId(TOKYO, 3), hit: false, conditions: { ...cond("芝", 1600, "良", null, null), raceClass: "オープン特別" } },
      { raceId: raceId(TOKYO, 4), hit: false, conditions: { ...cond("芝", 1600, "良", null, null), raceClass: "未勝利" } },
    ]);
    expect(byLabel(dimension(statsOf(rows).stats, "class"))).toEqual({ "未勝利": { races: 1, hitRaces: 0 }, "不明": { races: 3, hitRaces: 1 } });
  });

  it("★c2 複数の分析のあるレースは、集計に採用された最新の分析の行のクラスを使う", () => {
    const id = raceId(TOKYO, 1);
    const rows = rowsOf([
      { raceId: id, hit: true, analyzedAt: "2026-07-05T03:00:00.000Z", conditions: { ...cond("芝", 1600, "良", null, null), raceClass: "未勝利" } },
      { raceId: id, hit: true, analyzedAt: "2026-07-05T04:00:00.000Z", conditions: { ...cond("芝", 1600, "良", null, null), raceClass: "1勝クラス" } },
    ]);
    const { stats, source } = statsOf(rows);
    expect(collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG).map((e) => e.analysisId)).toEqual([2]); // 前提: 最新(id 2)だけが採用される
    expect(byLabel(dimension(stats, "class"))).toEqual({ "1勝クラス": { races: 1, hitRaces: 1 } });
  });

  it("条件の索引を渡さない呼び出し(従来の呼び方)は、中央が不明・地方が『地方(対象外)』に入る(クラスの節は出ない)", () => {
    const rows = rowsOf(CLASSED);
    const source = buildVerifySource(rows);
    const stats = buildConditionStats(source, collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG));
    expect(byLabel(dimension(stats, "class"))).toEqual({ "地方(対象外)": { races: 4, hitRaces: 1 }, "不明": { races: 7, hitRaces: 2 } });
  });
});

describe("computeVerifyBreakdowns: クラスの節", () => {
  const rows = rowsOf(CLASSED);
  const out = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets, buildConditionFactsIndex(rows.analyses));

  it("★c3 節の数: 全体 12(人気帯 5 + 条件別 7)、中央のみ 11、地方のみ 10(クラスの節なし = 分類できるレースが無い)", () => {
    expect(out.all!.sections).toHaveLength(12);
    expect(out.central!.sections).toHaveLength(11);
    expect(out.nar!.sections).toHaveLength(10);
  });

  it("並び: 芝ダの節のすぐ後ろ(最後)に付く", () => {
    expect(out.all!.sections.slice(5).map((s) => s.heading)).toEqual([
      "条件ごとの的中率と回収率(開催区分)",
      "条件ごとの的中率と回収率(競馬場)",
      "条件ごとの的中率と回収率(頭数)",
      ...NEW_HEADINGS,
      CLASS_HEADING,
    ]);
    expect(out.nar!.sections.map((s) => s.heading)).not.toContain(CLASS_HEADING);
  });

  it("★c4 全体のタブは『地方(対象外)』の行を含む。中央のみのタブには地方の行が出ない(中央のレース数 7 = 行の和)", () => {
    const labels = (v: "all" | "central"): string[] => sectionOf(out[v]!.sections, CLASS_HEADING).rows.map((r) => r.label);
    expect(labels("all")).toEqual(["全体", "新馬", "未勝利", "1勝クラス", "2勝クラス", "オープン", "地方(対象外)", "不明"]);
    expect(labels("central")).toEqual(["全体", "新馬", "未勝利", "1勝クラス", "2勝クラス", "オープン", "不明"]);
    const cells = (v: "all" | "central"): string[] => sectionOf(out[v]!.sections, CLASS_HEADING).rows.map((r) => r.cells[0]!.value);
    expect(cells("all")).toEqual(["11R(11点)", "1R(1点)", "2R(2点)", "1R(1点)", "1R(1点)", "1R(1点)", "4R(4点)", "1R(1点)"]);
    expect(cells("central")).toEqual(["7R(7点)", "1R(1点)", "2R(2点)", "1R(1点)", "1R(1点)", "1R(1点)", "1R(1点)"]);
  });

  it("各節の見出し順は CLASS_ORDER の部分列(行は固定の順で、不明が最後)", () => {
    const labels = sectionOf(out.all!.sections, CLASS_HEADING).rows.slice(1).map((r) => r.label);
    const positions = labels.map((l) => CLASS_ORDER.indexOf(l));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(labels[labels.length - 1]).toBe("不明");
  });

  it("★c5 『不明』と『地方(対象外)』しか無い入力(全レースの race_class が NULL)は、節ごと出さない", () => {
    const unread = rowsOf(CLASSED.map((s) => ({ ...s, conditions: { ...s.conditions, raceClass: null } })));
    const result = computeVerifyBreakdowns(buildVerifySource(unread), unread.bets, buildConditionFactsIndex(unread.analyses));
    expect(Object.values(result).every((v) => v !== null)).toBe(true); // 前提
    for (const v of ["all", "central", "nar"] as const) {
      expect(result[v]!.sections.map((x) => x.heading), v).not.toContain(CLASS_HEADING);
    }
    expect(result.all!.sections).toHaveLength(11);
  });

  it("★c6 不明が 0 件なら『不明』の行を出さない(中央のレースがすべて分類できた)", () => {
    const known = rowsOf(CLASSED.filter((s) => s.raceId.startsWith("202605") && s.conditions.raceClass !== null && s.conditions.raceClass !== undefined));
    expect(known.analyses.length).toBeGreaterThan(3); // 前提
    const result = computeVerifyBreakdowns(buildVerifySource(known), known.bets, buildConditionFactsIndex(known.analyses)).central!;
    expect(sectionOf(result.sections, CLASS_HEADING).rows.map((r) => r.label)).not.toContain("不明");
  });

  it("★c7 注記: 説明に『地方』の扱い、注記に『オープン』の内訳を含むこと・『不明』が補完中を含むことを書く。文言は短い(説明 100 字以内・注記 120 字以内)", () => {
    const section = sectionOf(out.all!.sections, CLASS_HEADING);
    expect(section.description).toContain("地方(対象外)");
    expect(section.note).toContain("オープン");
    expect(section.note).toContain("重賞");
    expect(section.note).toContain("補完中");
    expect(section.description.length).toBeLessThanOrEqual(100);
    expect(section.note.length).toBeLessThanOrEqual(120);
    const existing = sectionOf(out.all!.sections, "条件ごとの的中率と回収率(競馬場)");
    expect(section.description).not.toBe(existing.description);
    expect(section.note).not.toBe(existing.note);
  });

  it("同じ入力なら同じ結果(固定シード)", () => {
    const again = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets, buildConditionFactsIndex(rows.analyses));
    expect(JSON.stringify(again)).toBe(JSON.stringify(out));
  });
});
