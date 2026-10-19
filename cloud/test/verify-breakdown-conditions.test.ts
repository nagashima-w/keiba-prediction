import { describe, expect, it } from "vitest";
import { collectProposedBetEvents, computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import {
  BREAKDOWN_REFERENCE_MIN_RACES,
  buildConditionStats,
  buildRaceLedger,
  CONDITION_MERGE_MIN_RACES,
  computeVerifyBreakdowns,
  fieldSizeBandIndex,
  renderConditionSections,
  type ConditionRow,
  type ConditionStats,
} from "../src/verify-breakdown";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyBetRow, type VerifyReadRows, type VerifyResultRow } from "../src/verify-read";

/**
 * Issue #385: 検証画面の「条件ごとの的中率と回収率」(#385-A: 競馬場・頭数帯・開催区分)。見送りの判断材料(後の #386 が同じ集計を使う)。
 * 単位は**レース**: 配分ベースの買い目のあったレースごとに {賭け金, 払戻, 1 点でも的中したか} を作り、条件で分ける。
 * 買い目の判定(的中・外れ・返還・判定不能)は core の `collectProposedBetEvents` に任せ、ここでは作り直さない。
 */

// ---------------------------------------------------------------------------
// 見本: レースを 1 つずつ作る(複勝 01 を 100 円。的中なら 1 着で払戻 150)
// ---------------------------------------------------------------------------

interface RaceSpec {
  readonly raceId: string;
  /** 分析時の出走頭数(analysis_horses の行数)。 */
  readonly horses: number;
  readonly hit: boolean;
}

function analysisRow(id: number, raceId: string): VerifyAnalysisRow {
  return {
    id, raceId, analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
    model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
  };
}

/** 複勝 01 に 100 円(odds 2・ev 1.2)を 1 点ずつ買ったレースを並べた読み取り行。的中するレースは 01 が 1 着(複勝払戻 150)、外れるレースは 5 着。 */
function rowsOf(specs: readonly RaceSpec[], extraBets: readonly VerifyBetRow[] = []): VerifyReadRows {
  const analyses = specs.map((s, i) => analysisRow(i + 1, s.raceId));
  const horses = specs.flatMap((s, i) =>
    Array.from({ length: s.horses }, (_, k) => ({
      analysisId: i + 1, umaban: k + 1, prior: 0.3, adjusted_prob: 0.3, place_odds_min: 1.5 + 0.5 * k, ev: 1, is_positive: 1,
      contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null,
    })),
  );
  const results: VerifyResultRow[] = specs.flatMap((s) => [
    { raceId: s.raceId, umaban: 1, finishPosition: s.hit ? 1 : 5, placePayout: s.hit ? 150 : null, winPayout: null },
    { raceId: s.raceId, umaban: 2, finishPosition: 2, placePayout: 180, winPayout: null },
  ]);
  return {
    analyses,
    horses,
    allocationMeta: specs.map((_, i) => ({ analysisId: i + 1, route: "place-only", skipReasonCode: null })),
    bets: [...specs.map((_, i): VerifyBetRow => ({ analysisId: i + 1, betType: "place", comboKey: "01", stake: 100, odds: 2, ev: 1.2 })), ...extraBets],
    results,
    comboPayouts: [],
    comboImports: [],
  };
}

/** raceId: 年 + 場コード(2) + 回次日次(4。地方は月日) + レース番号(2)。`round` で同じ場の別の開催を作る。 */
const raceId = (venueCode: string, n: number, round = 1): string => `2026${venueCode}${String(round).padStart(2, "0")}05${String(n).padStart(2, "0")}`;
const TOKYO = "05";
const NAKAYAMA = "06";
const HANSHIN = "09";
const KOKURA = "10";
const OOI = "44";
const SONODA = "50";

function statsOf(rows: VerifyReadRows) {
  const source = buildVerifySource(rows);
  const events = collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG);
  return { source, events, stats: buildConditionStats(source, events) };
}

const dimension = (stats: ConditionStats, key: "kind" | "venue" | "field") => stats.dimensions.find((d) => d.key === key)!;
const labels = (rows: readonly ConditionRow[]): string[] => rows.map((r) => r.label);

// ---------------------------------------------------------------------------
// レース台帳
// ---------------------------------------------------------------------------

describe("buildRaceLedger(買い目のあったレースごとの集計)", () => {
  it("1 レースの複数の買い目は 1 行にまとめる: 賭け金と払戻は足し、1 点でも的中すれば的中レース", () => {
    const rows = rowsOf([{ raceId: raceId(TOKYO, 1), horses: 10, hit: true }], [
      { analysisId: 1, betType: "place", comboKey: "03", stake: 200, odds: 3, ev: 1.5 }, // 外れ
      { analysisId: 1, betType: "place", comboKey: "02", stake: 100, odds: 3, ev: 1.5 }, // 的中(2 着 180)
    ]);
    const { events } = statsOf(rows);
    const ledger = buildRaceLedger(events);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ raceId: raceId(TOKYO, 1), analysisId: 1, bets: 3, stake: 400, payout: 150 + 180, hit: true });
  });

  it("1 点も的中しなかったレースは的中レースでない。返還(取消馬への買い目)だけのレースも的中レースでない", () => {
    const rows = rowsOf([{ raceId: raceId(TOKYO, 1), horses: 10, hit: false }, { raceId: raceId(TOKYO, 2), horses: 10, hit: false }]);
    const scratched: VerifyReadRows = { ...rows, results: rows.results.map((r) => (r.raceId === raceId(TOKYO, 2) && r.umaban === 1 ? { ...r, finishPosition: null, scratched: 1 } : r)) };
    const ledger = buildRaceLedger(statsOf(scratched).events);
    expect(ledger.map((l) => [l.raceId, l.hit, l.payout])).toEqual([[raceId(TOKYO, 1), false, 0], [raceId(TOKYO, 2), false, 100]]);
  });

  it("判定不能の買い目だけのレースは台帳に入らない(買い目のあったレースに数えない)", () => {
    const rows = rowsOf([{ raceId: raceId(TOKYO, 1), horses: 10, hit: true }, { raceId: raceId(TOKYO, 2), horses: 10, hit: true }]);
    // 2 つ目のレースの複勝払戻を未取込にする(払戻が 1 件も無い → 判定不能)
    const noPayout: VerifyReadRows = { ...rows, results: rows.results.map((r) => (r.raceId === raceId(TOKYO, 2) ? { ...r, placePayout: null } : r)) };
    const { events } = statsOf(noPayout);
    expect(events.filter((e) => e.outcome === "unjudged")).toHaveLength(1); // 前提
    expect(buildRaceLedger(events).map((l) => l.raceId)).toEqual([raceId(TOKYO, 1)]);
  });
});

// ---------------------------------------------------------------------------
// 頭数帯
// ---------------------------------------------------------------------------

describe("fieldSizeBandIndex(頭数帯: 〜8 / 9〜12 / 13〜15 / 16〜)", () => {
  const cases: ReadonlyArray<readonly [number, number]> = [[1, 0], [8, 0], [9, 1], [12, 1], [13, 2], [15, 2], [16, 3], [18, 3]];
  it.each(cases)("%i 頭は帯 %i", (n, band) => {
    expect(fieldSizeBandIndex(n)).toBe(band);
  });
});

// ---------------------------------------------------------------------------
// 条件ごとの集計
// ---------------------------------------------------------------------------

describe("buildConditionStats(競馬場・頭数帯・開催区分)", () => {
  /** 東京 6 レース(的中 2)、中山 5 レース(的中 1)、阪神 4 レース(的中 1)、小倉 1 レース(的中 0)、大井 2 レース(的中 1)。 */
  function sample(): RaceSpec[] {
    const mk = (code: string, n: number, hits: number, horses: number): RaceSpec[] => Array.from({ length: n }, (_, i) => ({ raceId: raceId(code, i + 1), horses, hit: i < hits }));
    return [...mk(TOKYO, 6, 2, 16), ...mk(NAKAYAMA, 5, 1, 12), ...mk(HANSHIN, 4, 1, 9), ...mk(KOKURA, 1, 0, 8), ...mk(OOI, 2, 1, 13)];
  }

  it("見本が退化していない: 18 レース・賭け金 1,800 円で、的中は 5 レース(払戻 750 円。東京 2・中山 1・阪神 1・大井 1)", () => {
    const { stats } = statsOf(rowsOf(sample()));
    expect(stats.overall).toMatchObject({ races: 18, bets: 18, stake: 1800, payout: 750 });
    expect(stats.overall.recovery).toBeCloseTo(750 / 1800, 12);
  });

  it("競馬場: コード順(中央 01〜10、地方 30〜)に並べ、5 レース未満の場は『その他の場』にまとめる(境界: 5 レースは別の行、4 レースは『その他』)", () => {
    const venue = dimension(statsOf(rowsOf(sample())).stats, "venue");
    expect(labels(venue.rows)).toEqual(["東京", "中山", "その他の場(5レース未満)"]);
    expect(CONDITION_MERGE_MIN_RACES).toBe(5);
    // 阪神 4 + 小倉 1 + 大井 2 = 7 レース
    expect(venue.rows.map((r) => r.races)).toEqual([6, 5, 7]);
    expect(venue.rows[0]).toMatchObject({ races: 6, bets: 6, hitRaces: 2, stake: 600, payout: 300 });
    expect(venue.rows[1]).toMatchObject({ races: 5, hitRaces: 1, stake: 500, payout: 150 });
    expect(venue.rows[2]).toMatchObject({ races: 7, hitRaces: 2, stake: 700, payout: 300 });
  });

  it("競馬場の行のレース数・賭け金・払戻の合計は、全体と一致する(まとめた行も含む)", () => {
    const { stats } = statsOf(rowsOf(sample()));
    for (const key of ["kind", "venue", "field"] as const) {
      const rows = dimension(stats, key).rows;
      expect(rows.reduce((s, r) => s + r.races, 0), key).toBe(stats.overall.races);
      expect(rows.reduce((s, r) => s + r.stake, 0), key).toBe(stats.overall.stake);
      expect(rows.reduce((s, r) => s + r.payout, 0), key).toBe(stats.overall.payout);
    }
  });

  it("全体は本体の proposedBet の overall と一致する(賭け金・払戻・点数)", () => {
    const { source, stats } = statsOf(rowsOf(sample()));
    const overall = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG).proposedBet.overall;
    expect(stats.overall).toMatchObject({ bets: overall.betCount, stake: overall.totalStake, payout: overall.totalReturn });
  });

  it("的中レース率は Wilson 区間(95%)つき。東京 2/6 は 33.3%(9.7〜70.0%)", () => {
    const tokyo = dimension(statsOf(rowsOf(sample())).stats, "venue").rows[0]!;
    expect(tokyo.hitRate).toBeCloseTo(2 / 6, 12);
    expect(tokyo.hitInterval!.lower).toBeCloseTo(0.0968, 3);
    expect(tokyo.hitInterval!.upper).toBeCloseTo(0.7, 3);
  });

  it("回収率は全体との差(回収率 − 全体の回収率)を持つ。区間はレース単位の再標本(2 レース以上)", () => {
    const { stats } = statsOf(rowsOf(sample()));
    const tokyo = dimension(stats, "venue").rows[0]!;
    expect(tokyo.recovery).toBeCloseTo(0.5, 12);
    expect(tokyo.diffFromAll).toBeCloseTo(0.5 - 750 / 1800, 12);
    const other = dimension(stats, "venue").rows[2]!;
    expect(other.recovery).toBeCloseTo(300 / 700, 12);
    expect(other.diffFromAll).toBeCloseTo(300 / 700 - 750 / 1800, 12);
    expect(other.diffFromAll).not.toBe(0); // 差が 0 でない(差の式の取り違えを検出できる)
    expect(tokyo.recoveryInterval).not.toBeNull();
    expect(tokyo.recoveryInterval!.lower).toBeLessThanOrEqual(tokyo.recovery!);
    expect(tokyo.recovery!).toBeLessThanOrEqual(tokyo.recoveryInterval!.upper);
  });

  it("頭数帯: 小倉 8 頭は〜8、阪神 9 頭・中山 12 頭は 9〜12、大井 13 頭は 13〜15、東京 16 頭は 16〜(分析時の出走頭数)", () => {
    const field = dimension(statsOf(rowsOf(sample())).stats, "field");
    expect(labels(field.rows)).toEqual(["〜8頭", "9〜12頭", "13〜15頭", "16頭〜"]);
    expect(field.rows.map((r) => r.races)).toEqual([1, 9, 2, 6]);
  });

  it("頭数が分からない(分析の馬の行が無い)レースは『頭数不明』の行に入る。無ければ行を出さない", () => {
    const rows = rowsOf(sample());
    const noHorses: VerifyReadRows = { ...rows, horses: rows.horses.filter((h) => h.analysisId !== 1) };
    const field = dimension(statsOf(noHorses).stats, "field");
    expect(labels(field.rows)).toEqual(["〜8頭", "9〜12頭", "13〜15頭", "16頭〜", "頭数不明"]);
    expect(field.rows[4]).toMatchObject({ races: 1 });
    expect(labels(dimension(statsOf(rows).stats, "field").rows)).not.toContain("頭数不明");
  });

  it("開催区分: 中央と地方に分ける(中央 16 レース、地方 2 レース)", () => {
    const kind = dimension(statsOf(rowsOf(sample())).stats, "kind");
    expect(labels(kind.rows)).toEqual(["中央", "地方"]);
    expect(kind.rows.map((r) => r.races)).toEqual([16, 2]);
  });

  it("地方の場コードは名前に直す(大井・園田)。実測にないコードは『地方(コードNN)』になる", () => {
    const specs = [...Array.from({ length: 5 }, (_, i) => ({ raceId: raceId(OOI, i + 1), horses: 10, hit: true })), ...Array.from({ length: 5 }, (_, i) => ({ raceId: raceId(SONODA, i + 1), horses: 10, hit: false })), ...Array.from({ length: 5 }, (_, i) => ({ raceId: raceId("62", i + 1), horses: 10, hit: false }))];
    const venue = dimension(statsOf(rowsOf(specs)).stats, "venue");
    expect(labels(venue.rows)).toEqual(["大井", "園田", "地方(コード62)"]);
  });

  it("買い目のあったレースが無ければ、行は空(全体も 0 レース)", () => {
    const { stats } = statsOf({ ...rowsOf([]), analyses: [] });
    expect(stats.overall.races).toBe(0);
    expect(stats.dimensions.every((d) => d.rows.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 表示用の節
// ---------------------------------------------------------------------------

describe("renderConditionSections(サーバが組み立てる表示用の節)", () => {
  const specs = (): RaceSpec[] => [
    ...Array.from({ length: 6 }, (_, i) => ({ raceId: raceId(TOKYO, i + 1), horses: 16, hit: i < 2 })),
    ...Array.from({ length: 5 }, (_, i) => ({ raceId: raceId(OOI, i + 1), horses: 12, hit: i < 1 })),
  ];
  const sections = (venue: "all" | "central" | "nar" = "all") => renderConditionSections(statsOf(rowsOf(specs())).stats, venue);

  it("全体の区分では、開催区分・競馬場・頭数帯の 3 つの節。中央のみ・地方のみでは開催区分の節を出さない", () => {
    expect(sections("all").map((s) => s.heading)).toEqual(["条件ごとの的中率と回収率(開催区分)", "条件ごとの的中率と回収率(競馬場)", "条件ごとの的中率と回収率(頭数)"]);
    expect(sections("central").map((s) => s.heading)).toEqual(["条件ごとの的中率と回収率(競馬場)", "条件ごとの的中率と回収率(頭数)"]);
    expect(sections("nar").map((s) => s.heading)).toEqual(["条件ごとの的中率と回収率(競馬場)", "条件ごとの的中率と回収率(頭数)"]);
  });

  it("説明: 単位はレース、的中レースは 1 点でも的中したレース。注記: 区間の限界と、悪い条件を探して見送る選び方が過大に見えること", () => {
    const s = sections()[1]!;
    expect(s.description).toContain("買い目のあったレース");
    expect(s.description).toContain("1点でも的中した");
    expect(s.note).toContain("Wilson");
    expect(s.note).toContain("同じ記録で選ぶ");
    expect(s.note).toContain("参考");
  });

  it("行の先頭に『全体』(区分のタブの合計)を出し、続けて条件の行。全体の行には『全体との差』が無い", () => {
    const venue = sections()[1]!;
    expect(venue.rows.map((r) => r.label)).toEqual(["全体", "東京", "大井"]);
    expect(venue.rows[0]!.cells.map((c) => c.name)).toEqual(["レース数(点)", "的中レース率", "回収率"]);
    expect(venue.rows[1]!.cells.map((c) => c.name)).toEqual(["レース数(点)", "的中レース率", "回収率", "全体との差", "注意"]);
  });

  it("項目の値: 東京 6 レース(的中 2・賭け金 600・払戻 300)は『6R(6点)』『33.3%(9.7〜70.0%)』、回収率 50.0%、全体との差は文字列", () => {
    const tokyo = sections()[1]!.rows[1]!;
    const value = (name: string) => tokyo.cells.find((c) => c.name === name)!.value;
    expect(value("レース数(点)")).toBe("6R(6点)");
    expect(value("的中レース率")).toBe("33.3%(9.7〜70.0%)");
    expect(value("回収率")).toMatch(/^50\.0%\(\d+\.\d〜\d+\.\d%\)$/);
    expect(value("全体との差")).toMatch(/^[+-]\d+\.\dpt$/);
    expect(value("注意")).toBe("参考(30レース未満)");
  });

  it("「参考」の印は 30 レース未満の行だけ(境界: 29 レースは付き、30 レースは付かない)", () => {
    expect(BREAKDOWN_REFERENCE_MIN_RACES).toBe(30);
    const make = (n: number) => rowsOf(Array.from({ length: n }, (_, i) => ({ raceId: raceId(TOKYO, (i % 12) + 1, Math.floor(i / 12) + 1), horses: 10, hit: i % 3 === 0 })));
    const cell = (n: number) => renderConditionSections(statsOf(make(n)).stats, "central")[0]!.rows[1]!.cells.some((c) => c.name === "注意");
    expect(cell(29)).toBe(true);
    expect(cell(30)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 区分ごとの集計(computeVerifyBreakdowns)
// ---------------------------------------------------------------------------

describe("computeVerifyBreakdowns に条件別の節が載る", () => {
  const specs = (): RaceSpec[] => [
    ...Array.from({ length: 6 }, (_, i) => ({ raceId: raceId(TOKYO, i + 1), horses: 16, hit: i < 2 })),
    ...Array.from({ length: 5 }, (_, i) => ({ raceId: raceId(OOI, i + 1), horses: 12, hit: i < 1 })),
  ];

  it("人気帯の 5 つの節に続けて条件別の節が付く(全体: 3 つ = 計 8、中央のみ・地方のみ: 2 つ = 計 7)", () => {
    const rows = rowsOf(specs());
    const out = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    expect(out.all!.sections).toHaveLength(8);
    expect(out.central!.sections).toHaveLength(7);
    expect(out.nar!.sections).toHaveLength(7);
    expect(out.all!.sections[4]!.heading).toBe("単勝人気と複勝順位のずれ");
    expect(out.all!.sections[5]!.heading).toBe("条件ごとの的中率と回収率(開催区分)");
  });

  it("区分ごとに別の値: 中央のみの競馬場の行は東京だけ、地方のみは大井だけ、全体は両方", () => {
    const rows = rowsOf(specs());
    const out = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    const venueLabels = (v: "all" | "central" | "nar") => out[v]!.sections.find((s) => s.heading.endsWith("(競馬場)"))!.rows.map((r) => r.label);
    expect(venueLabels("central")).toEqual(["全体", "東京"]);
    expect(venueLabels("nar")).toEqual(["全体", "大井"]);
    expect(venueLabels("all")).toEqual(["全体", "東京", "大井"]);
  });

  it("同じ入力なら同じ結果(固定シード)", () => {
    const rows = rowsOf(specs());
    const a = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    const b = computeVerifyBreakdowns(buildVerifySource(rows), rows.bets);
    expect(JSON.stringify(a.all!.sections)).toBe(JSON.stringify(b.all!.sections));
  });
});
