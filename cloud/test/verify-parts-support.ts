import type { VerifyAnalysisRow, VerifyReadRows } from "../src/verify-read";

/**
 * Issue #628: 差分の集計の試験用に、複数の開催日・レース・版・買い目・結果を持つ行を作る(固定の乱数。再現できる)。
 * `days` 日 × 1 日 `racesPerDay` レース(中央と地方が交互)× 1〜2 分析。開催日が NULL の分析のレースも 1 つ入れる。
 */
export function manyDayRows(days: number, racesPerDay: number, seed = 7): VerifyReadRows {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const analyses: VerifyAnalysisRow[] = [];
  const horses: VerifyReadRows["horses"][number][] = [];
  const allocationMeta: VerifyReadRows["allocationMeta"][number][] = [];
  const bets: VerifyReadRows["bets"][number][] = [];
  const results: VerifyReadRows["results"][number][] = [];
  const marks = ["◎", "〇", "▲", "△", null] as const;
  let id = 0;
  for (let d = 0; d < days + 1; d++) {
    const nullDay = d === days;
    const date = nullDay ? null : `2026${String(1 + Math.floor(d / 28)).padStart(2, "0")}${String(1 + (d % 28)).padStart(2, "0")}`;
    for (let r = 0; r < (nullDay ? 1 : racesPerDay); r++) {
      const central = r % 2 === 0;
      const raceId = central ? `2026060${(d % 8) + 1}${String(r + 1).padStart(2, "0")}${String(d % 10).padStart(2, "0")}` : `2026440${(d % 8) + 1}${String(r + 1).padStart(2, "0")}${String(d % 10).padStart(2, "0")}`;
      const n = 1 + Math.floor(rnd() * 2);
      for (let k = 0; k < n; k++) {
        id += 1;
        analyses.push({
          id, raceId, analyzedAt: `2026-07-05T0${5 + k}:00:00.000Z`, evEstimated: 0, promptVersion: k === 0 ? "v1" : "v2", additionalInstruction: k === 0 ? null : "指示",
          kaisaiDate: date, model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260101", promptLookaheadGuarded: 1, startTime: "15:45",
        });
        for (let u = 1; u <= 6; u++) {
          horses.push({ analysisId: id, umaban: u, prior: 0.1 + rnd() * 0.3, adjusted_prob: 0.1 + rnd() * 0.3, place_odds_min: 1.5 + rnd() * 5, ev: 0.5 + rnd(), is_positive: rnd() < 0.5 ? 1 : 0, contributions_json: null, mark: marks[Math.floor(rnd() * marks.length)] ?? null, reason: null, highlights_json: null, concerns_json: null });
        }
        allocationMeta.push({ analysisId: id, route: "mixed", skipReasonCode: null, includeComboOdds: 0 });
        bets.push({ analysisId: id, betType: "place", comboKey: String(1 + Math.floor(rnd() * 6)), stake: 100 * (1 + Math.floor(rnd() * 3)), odds: 2 + rnd() * 4, ev: 0.8 + rnd() });
      }
      for (let u = 1; u <= 6; u++) {
        results.push({ raceId, umaban: u, finishPosition: u, placePayout: u <= 3 ? 120 + 40 * u : null, winPayout: u === 1 ? 450 : null });
      }
    }
  }
  return { analyses, horses, allocationMeta, bets, results, comboPayouts: [], comboImports: [] };
}

/** 開催日(null は {@link NO_DATE_DAY} の日)でレースを区切った行(全件の読みの一部)。 */
export function rowsOfDay(rows: VerifyReadRows, day: string | null): VerifyReadRows {
  const analyses = rows.analyses.filter((a) => (a.kaisaiDate ?? null) === day);
  const ids = new Set(analyses.map((a) => a.id));
  const races = new Set(analyses.map((a) => a.raceId));
  return {
    analyses,
    horses: rows.horses.filter((h) => ids.has(h.analysisId)),
    allocationMeta: rows.allocationMeta.filter((m) => ids.has(m.analysisId)),
    bets: rows.bets.filter((b) => ids.has(b.analysisId)),
    results: rows.results.filter((r) => races.has(r.raceId)),
    comboPayouts: rows.comboPayouts.filter((p) => races.has(p.raceId)),
    comboImports: rows.comboImports.filter((i) => races.has(i.raceId)),
  };
}
