import { describe, expect, it } from "vitest";
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { buildDayStats, buildRaceDigest } from "../src/daily-report-digest";
import { buildReportPrompt, REPORT_PROMPT_VERSION } from "../src/daily-report-prompt";
import { buildRollingSummary, type PeriodStats } from "../src/period-stats";

/** Issue #278: LLM のプロンプトでの返還(取消・除外の馬への買い目)の書き方。 */

function horse(umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}
function view(raceId: string, horses: AnalysisViewHorse[], bets: Array<[string, string, number]>): AnalysisView {
  return {
    id: 1, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: "20261010", evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber: 1, raceName: "テスト1S", grade: null, startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result", placeBasis: "top3" },
    horses, detail: "present",
    allocation: { route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok", bets: bets.map(([betType, comboKey, stake]) => ({ betType, comboKey, stake, odds: 3, ev: 1.1 })) },
  };
}
// 5 番が取消・除外。
const RES: RaceResultData = {
  horses: [
    { umaban: 1, finishPosition: 1, winPayout: 350, placePayout: 130, scratched: false },
    { umaban: 3, finishPosition: 2, winPayout: null, placePayout: 150, scratched: false },
    { umaban: 4, finishPosition: 3, winPayout: null, placePayout: 110, scratched: false },
    { umaban: 5, finishPosition: null, winPayout: null, placePayout: null, scratched: true },
  ],
  combos: {},
};

const PRIOR = (over: Partial<PeriodStats> = {}): PeriodStats => ({ ...buildDayStats([]), fromDate: "20260913", toDate: "20261009", dayCount: 0, ...over });

function promptFor(bets: Array<[string, string, number]>, over: Partial<PeriodStats> = {}): string {
  const d = [buildRaceDigest(view("202605030801", [horse(1, { mark: "◎" }), horse(5, { mark: "〇" })], bets), RES)];
  const stats = buildDayStats(d);
  return buildReportPrompt({ kaisaiDate: "20261010", digests: d, stats, rolling: buildRollingSummary("20261010", stats, PRIOR(over)) });
}

const section = (p: string, heading: string): string => p.split(/^## /m).find((x) => x.startsWith(heading))!;

describe("プロンプトの返還(Issue #278)", () => {
  const BETS: Array<[string, string, number]> = [["win", "01", 200], ["win", "05", 300], ["wide", "0105", 100]];

  it("買い目の行: 返還は『→ 返還 N円』と書く(『はずれ』にしない)。的中は従来どおり", () => {
    const p = promptFor(BETS);
    expect(p).toMatch(/単勝 5番 300円 → 返還 300円/);
    expect(p).toMatch(/ワイド 1-5番 100円 → 返還 100円/);
    expect(p).toMatch(/単勝 1番 200円 → 的中 700円/);
    expect(p).not.toMatch(/5番 300円 → はずれ/);
  });

  it("成績の行: 返還があるときだけ『うち返還 N 点・賭け金 X円』を添える。的中数には含めない。返還が無ければ添えない", () => {
    const p = promptFor(BETS);
    expect(p).toContain("3 点中 1 点的中(うち返還 2 点・賭け金 400円)");
    // 返還のない買い目だけの日は、成績の節に『返還』を出さない(◎-〇の定型は 5 番が取消なので、「もしも」の節には出る。下のテスト)
    const none = promptFor([["win", "01", 200]]);
    expect(section(none, "2026年10月10日(土) の成績")).not.toContain("返還");
    expect(section(none, "直近 28 日の累計")).not.toContain("返還");
  });

  it("「もしも」の節: 型に返還があるときだけ、返還の扱いを書く(賭け金と払戻に含め、的中に数えない)。行に『うち返還 N レース』が出る", () => {
    const p = promptFor([["win", "01", 200]]);
    const whatIf = section(p, "印の定型の買い方");
    expect(whatIf).toContain("返還として、賭け金と払戻に含め、的中には数えません");
    expect(whatIf).toMatch(/◎-〇ワイド: 判定できた 1 レース中 0 的中\(うち返還 1 レース\)/);
  });

  it("予想の馬: 取消・除外の馬は『着順 不明』ではなく『取消・除外』と書く。通常の馬は着順のまま", () => {
    const p = promptFor(BETS);
    const line = p.split("\n").find((l) => l.includes("〇") && l.includes("5番 馬5"))!;
    expect(line).toContain("取消・除外");
    expect(line).not.toContain("着順 不明");
    expect(p.split("\n").find((l) => l.includes("◎") && l.includes("1番 馬1"))).toContain("1着");
  });

  it("規則: 返還の意味(的中でもはずれでもない・賭け金と払戻に含む・見込みに含めない)を、返還があるときだけ書く", () => {
    const rules = section(promptFor(BETS), "規則");
    expect(rules).toContain("返還");
    expect(rules).toContain("取消・除外");
    expect(rules).toContain("的中でもはずれでもない");
    expect(rules).toContain("見込みの的中数には含めません");
    expect(section(promptFor([["win", "01", 200]]), "規則")).not.toContain("返還");
  });

  it("見込みの対象外の注記: 返還と確率が無い買い目を分けて書く(返還を『確率が無い』に混ぜない)", () => {
    // 直前 27 日: 判定できた 300 点 = 返還 20 + 確率なし 30 + 確率あり 250。その日(判定できた 3 点・返還 2・確率あり 1)を足した累計は 303 = 22 + 30 + 251
    const p = promptFor(BETS, {
      raceCount: 100, judgedBetCount: 300, hitBetCount: 20, refundedBetCount: 20, refundedStake: 2000, expectedBetCount: 250, expectedHits: 18, expectedBaseHits: 19,
      totalStake: 30000, totalReturn: 28000, recoveryRate: 28000 / 30000,
    });
    const total = section(p, "直近 28 日の累計");
    expect(total).toContain("見込みの的中数:");
    expect(total).toContain("判定できた 303 点のうち 22 点は返還(取消・除外)、30 点は確率が無く、見込みに含めない");
    // 返還だけで確率なしが 0 点のとき(その日)は、確率なしを書かない
    const day = section(p, "2026年10月10日(土) の成績");
    expect(day).toContain("判定できた 3 点のうち 2 点は返還(取消・除外)のため、見込みに含めない");
    expect(day).not.toContain("確率が無く");
  });

  it("版: 文面を変えたので REPORT_PROMPT_VERSION を更新した", () => {
    expect(REPORT_PROMPT_VERSION).toBe("report-2026-10-12.2");
  });
});
