import { describe, expect, it } from "vitest";
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { buildDayStats, buildRaceDigest } from "../src/daily-report-digest";
import { pickNearMisses } from "../src/daily-report-whatif";
import { buildReportPrompt, formatComboKey, NARRATIVE_LIMITS, parseNarrative, REPORT_PROMPT_VERSION } from "../src/daily-report-prompt";
import { buildRollingSummary, type PeriodStats, type RollingSummary } from "../src/period-stats";

/** Issue #235: 日報のプロンプトの組み立てと、LLM の応答(JSON)の解釈。 */

function horse(umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}
function view(raceId: string, raceNumber: number, horses: AnalysisViewHorse[], bets: Array<[string, string, number]> = []): AnalysisView {
  return {
    id: raceNumber, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: "20261010", evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber, raceName: `テスト${raceNumber}S`, grade: null, startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result", placeBasis: "top3" },
    horses, detail: "present",
    allocation: bets.length === 0 ? null : { route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok", bets: bets.map(([betType, comboKey, stake]) => ({ betType, comboKey, stake, odds: 3, ev: 1.1 })) },
  };
}
const result = (rows: Array<[number, number | null, number | null, number | null]>): RaceResultData => ({ horses: rows.map(([umaban, finishPosition, winPayout, placePayout]) => ({ umaban, finishPosition, winPayout, placePayout })), combos: {} });

const R1 = "202605030801";
const R2 = "202605030802";
function digests() {
  return [
    buildRaceDigest(view(R1, 1, [horse(1, { mark: "◎", reason: "近走の内容が安定" , highlights: ["上がり最速"], concerns: ["距離延長"] }), horse(2, { mark: "〇" })], [["win", "01", 200]]), result([[1, 1, 350, 130], [2, 4, null, null], [3, 2, null, 150], [4, 3, null, 110]])),
    buildRaceDigest(view(R2, 2, [horse(5, { mark: "◎" })], [["win", "05", 300]]), undefined),
  ];
}
/** 直前 27 日の定型の成績(Issue #272)。数字は明示する。 */
const PRIOR_WHATIF = {
  win: { betCount: 40, hitCount: 8, stake: 4000, payout: 3200, refundCount: 0, unjudgedCount: 2, inapplicableCount: 3 },
  place: { betCount: 40, hitCount: 18, stake: 4000, payout: 4300, refundCount: 0, unjudgedCount: 2, inapplicableCount: 3 },
  wide: { betCount: 30, hitCount: 5, stake: 3000, payout: 3900, refundCount: 0, unjudgedCount: 2, inapplicableCount: 13 },
  quinella: { betCount: 30, hitCount: 3, stake: 3000, payout: 2100, refundCount: 0, unjudgedCount: 2, inapplicableCount: 13 },
  trio: { betCount: 20, hitCount: 1, stake: 2000, payout: 6000, refundCount: 0, unjudgedCount: 2, inapplicableCount: 23 },
};

/** 期間の統計(直前 27 日)。数字は明示する(テストが期待値を手で書けるように)。 */
function period(over: Partial<PeriodStats> = {}): PeriodStats {
  return {
    fromDate: "20260913", toDate: "20261009", dayCount: 6,
    raceCount: 120, resultRaceCount: 118, noResultRaceCount: 2, betRaceCount: 110, llmUsedRaceCount: 100,
    totalStake: 40000, totalReturn: 34000, recoveryRate: 0.85, judgedBetCount: 300, hitBetCount: 24, refundedBetCount: 0, refundedStake: 0, unjudgedBetCount: 3, unjudgedStake: 900,
    expectedBetCount: 300, expectedHits: 21.5, expectedBaseHits: 24, maxPayout: 9000, maxPayoutStake: 300,
    byBetType: { win: { betCount: 100, hitCount: 6, stake: 15000, payout: 12000, refundCount: 0, expectedBetCount: 100, expectedHits: 5.25, expectedBaseHits: 6 } },
    byMark: [{ mark: "◎", count: 118, win: 30, top3: 70 }],
    whatIf: PRIOR_WHATIF,
    ...over,
  };
}
function rolling(day = buildDayStats(digests()), prior = period()): RollingSummary {
  return buildRollingSummary("20261010", day, prior);
}
const input = () => {
  const d = digests();
  return { kaisaiDate: "20261010", digests: d, stats: buildDayStats(d), rolling: rolling(buildDayStats(d)) };
};

describe("buildReportPrompt", () => {
  it("日付(曜日つき)・全レースの raceId と見出し・確定した統計の数字を含む", () => {
    const p = buildReportPrompt(input());
    expect(p).toContain("2026年10月10日(土)");
    expect(p).toContain(R1);
    expect(p).toContain(R2);
    expect(p).toContain("東京1R");
    expect(p).toContain("テスト1S");
    expect(p).toContain("賭け金 200円");
    expect(p).toContain("払戻 700円"); // 単勝 350 円 × 200/100
    expect(p).toContain("回収率 350.0%");
  });

  it("Issue #245: 回収率は、丸めると 100.0% になる 1 以外の値を 100.0% と出さない(LLM が赤字を収支ゼロと書かない)。3 着内率の書き方は変えない", () => {
    const base = input();
    const prompt = (recoveryRate: number): string => buildReportPrompt({ ...base, stats: { ...base.stats, recoveryRate } });
    expect(`${(0.9999 * 100).toFixed(1)}%`).toBe("100.0%"); // 前提: 旧表示では 100.0% だった
    expect(prompt(0.9999)).toContain("回収率 99.99%");
    expect(prompt(1)).toContain("回収率 100.0%");
    expect(prompt(1.00001)).toContain("回収率 100.01%");
    expect(prompt(0.9999)).toContain("補正後の3着内率 25.0%"); // 前提: 3 着内率の行が出ている(percent のまま)
  });

  it("結果のあるレースは着順と各馬の着順を、結果のないレースは『結果なし』と判定不能の買い目を出す", () => {
    const p = buildReportPrompt(input());
    expect(p).toContain("1着 1番 馬1");
    expect(p).toContain("2着 3番 / 3着 4番"); // 馬3・馬4 は分析のビューに無く、馬名なし
    expect(p).toContain("結果: なし");
    expect(p).toMatch(/単勝 5番 300円 → 判定不能/);
    expect(p).toMatch(/単勝 1番 200円 → 的中 700円/);
  });

  it("予想の馬は、印・馬番・馬名・補正後の確率・EV・着順・根拠・強調・懸念を 1 行にする", () => {
    const p = buildReportPrompt(input());
    const line = p.split("\n").find((l) => l.includes("◎") && l.includes("馬1"));
    expect(line).toBeDefined();
    expect(line).toContain("1番");
    expect(line).toContain("25.0%");
    expect(line).toContain("EV 1.00");
    expect(line).toContain("1着");
    expect(line).toContain("近走の内容が安定");
    expect(line).toContain("上がり最速");
    expect(line).toContain("距離延長");
  });

  it("出力形式(JSON のみ・キー名)と、推測を禁じる規則を含む", () => {
    const p = buildReportPrompt(input());
    for (const key of ["summary", "good", "improve", "races", "raceId", "comment"]) {
      expect(p).toContain(`"${key}"`);
    }
    expect(p).toContain("JSON");
    expect(p).toContain("計算し直さず");
    expect(p).toContain("推測");
  });

  it("同じ入力なら同じ文字列(決定的)", () => {
    expect(buildReportPrompt(input())).toBe(buildReportPrompt(input()));
  });

  it("レースが 0 件でも組み立てられる", () => {
    const p = buildReportPrompt({ kaisaiDate: "20261010", digests: [], stats: buildDayStats([]), rolling: rolling(buildDayStats([])) });
    expect(p).toContain("2026年10月10日(土)");
    expect(p).toContain("分析したレース: 0 件");
  });
});

describe("Issue #264: 直近 4 週との比較・見込みの的中数", () => {
  const sections = (p: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const parts = p.split(/^## /m).slice(1);
    for (const part of parts) {
      const nl = part.indexOf("\n");
      out[part.slice(0, nl)] = part.slice(nl + 1);
    }
    return out;
  };

  it("版: REPORT_PROMPT_VERSION を持つ(日報の本文に残して、どの文面が書いた日報かを区別する)", () => {
    expect(REPORT_PROMPT_VERSION).toMatch(/^report-\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("定型の前提『数十レースの 1 日分では、偶然の影響が大きい』を LLM に渡さない(毎日『偶然の影響が強い 1 日です』と書かせていた出どころ)", () => {
    const p = buildReportPrompt(input());
    expect(p).not.toContain("偶然の影響が大きい");
    expect(p).not.toContain("数十レースの 1 日分");
  });

  it("規則: 穴馬の高配当を狙う考え方・見込みとの比較・その日と 4 週の両方・『偶然』は数字で示せるときだけ総括で多くとも 1 回", () => {
    const rules = sections(buildReportPrompt(input()))["規則"]!;
    expect(rules).toContain("穴馬");
    expect(rules).toContain("1 点の的中で回収率が大きく動くのは想定どおり");
    expect(rules).toContain("見込みの的中数");
    expect(rules).toContain("上回った");
    expect(rules).toContain("下回った");
    expect(rules).toContain("直近 28 日の累計");
    expect(rules).toContain("数字で示せるときだけ");
    expect(rules).toContain("総括で多くとも 1 回");
    expect(rules).toContain("見込みとの比較で書いて");
    // 数字を伴わない定型の断りを禁じている(例文として挙げる)
    expect(rules).toContain("偶然の影響が強い 1 日です");
  });

  it("規則が以前から持っていたもの(確定値は計算し直さない・推測しない・結果なしは成否を判断しない・改善点は命令しない)は残る", () => {
    const rules = sections(buildReportPrompt(input()))["規則"]!;
    expect(rules).toContain("計算し直さず");
    expect(rules).toContain("推測");
    expect(rules).toContain("成否を判断しない");
    expect(rules).toContain("命令する書き方はしない");
  });

  it("成績の節は、その日 → 直前 27 日 → 直近 28 日の累計 → レースごと の順に並ぶ", () => {
    const p = buildReportPrompt(input());
    const heads = ["## 2026年10月10日(土) の成績(確定値)", "## 直前 27 日(その日を除く)の成績(確定値)", "## 直近 28 日の累計(その日を含む)の成績(確定値)", "## レースごとの予想と結果"].map((h) => p.indexOf(h));
    expect(heads.every((i) => i >= 0)).toBe(true);
    expect([...heads].sort((a, b) => a - b)).toEqual(heads);
  });

  it("その日の節: 見込みの的中数と実際の的中数・差・最大払戻の 1 点を除いた回収率を確定値で出す(LLM に引き算させない)", () => {
    const d = buildDayStats(digests());
    // 前提: その日は単勝 200 円 1 点だけ判定できて的中(odds 3・ev 1.1 → 確率 1.1/3)。もう 1 点は結果なしで判定不能
    expect(d.judgedBetCount).toBe(1);
    expect(d.hitBetCount).toBe(1);
    const day = sections(buildReportPrompt(input()))["2026年10月10日(土) の成績(確定値)"]!;
    expect(day).toContain("見込みの的中数: 0.37 点");
    expect(day).toContain("確率のある 1 点が対象");
    expect(day).toContain("実際の的中: 1 点");
    expect(day).toContain("差(実際 − 見込み): +0.63 点");
    // 的中が 1 点だけ: その 1 点を除くと賭け金が残らない
    expect(day).toContain("払戻が最大の 1 点を除いた回収率: なし");
  });

  it("直前 27 日の節: 期間・開催日数・レース数・回収率・見込みと実際・最大の 1 点を除いた回収率を出す", () => {
    const prior = sections(buildReportPrompt(input()))["直前 27 日(その日を除く)の成績(確定値)"]!;
    expect(prior).toContain("2026年9月13日〜2026年10月9日");
    expect(prior).toContain("分析のあった開催日 6 日");
    expect(prior).toContain("120 件");
    expect(prior).toContain("賭け金 40,000円・払戻 34,000円・回収率 85.0%");
    expect(prior).toContain("300 点中 24 点的中");
    expect(prior).toContain("見込みの的中数: 21.50 点");
    expect(prior).toContain("実際の的中: 24 点");
    expect(prior).toContain("差(実際 − 見込み): +2.50 点");
    // (34000 - 9000) / (40000 - 300)
    expect(prior).toContain("払戻が最大の 1 点を除いた回収率: 63.0%");
    expect(prior).toContain("その 1 点: 払戻 9,000円・賭け金 300円");
  });

  it("直近 28 日の累計の節: その日 + 直前 27 日の和(賭け金・払戻・点数・見込み)を出し、券種別(見込みつき)と印別も出す", () => {
    const r = rolling();
    const total = sections(buildReportPrompt({ ...input(), rolling: r }))["直近 28 日の累計(その日を含む)の成績(確定値)"]!;
    expect(total).toContain("2026年9月13日〜2026年10月10日");
    expect(total).toContain("分析のあった開催日 7 日"); // 6 + その日
    expect(total).toContain("賭け金 40,200円・払戻 34,700円"); // 40000+200 / 34000+700
    expect(total).toContain("301 点中 25 点的中");
    expect(total).toContain(`見込みの的中数: ${r.total.expectedHits.toFixed(2)} 点`);
    expect(total).toContain("単勝 101 点中 7 点的中");
    expect(total).toContain("見込み 5.62 点"); // 5.25 + 1.1/3
    expect(total).toContain("印別");
    expect(total).toContain("◎ 119 / 31 / 71"); // 118+1 頭 / 30+1 / 70+1
  });

  it("確率を導けない買い目があるときは、見込みの対象が判定できた点数より少ないことを書き、実際の的中も同じ点数の中で数える", () => {
    const p = period({ judgedBetCount: 300, expectedBetCount: 270, expectedHits: 20, expectedBaseHits: 22, hitBetCount: 24 });
    const prior = sections(buildReportPrompt({ ...input(), rolling: rolling(buildDayStats(digests()), p) }))["直前 27 日(その日を除く)の成績(確定値)"]!;
    expect(prior).toContain("確率のある 270 点が対象");
    expect(prior).toContain("実際の的中: 22 点"); // 24 ではない(確率を導けた 270 点の中の的中)
    expect(prior).toContain("30 点は確率が無く、見込みに含めない");
    expect(prior).toContain("差(実際 − 見込み): +2.00 点");
  });

  it("見込みを出せない(確率のある買い目が 0 点)ときは『なし』と書き、数字を捏造しない", () => {
    const p = period({ expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0 });
    const prior = sections(buildReportPrompt({ ...input(), rolling: rolling(buildDayStats(digests()), p) }))["直前 27 日(その日を除く)の成績(確定値)"]!;
    expect(prior).toContain("見込みの的中数: なし");
    expect(prior).not.toContain("差(実際 − 見込み)");
  });

  it("直前 27 日に分析したレースが無いときは、比較できないと書き、累計の節は『その日と同じ』とする(0 件の統計を並べない)", () => {
    const empty = period({ raceCount: 0, dayCount: 0, resultRaceCount: 0, noResultRaceCount: 0, betRaceCount: 0, llmUsedRaceCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null, judgedBetCount: 0, hitBetCount: 0, unjudgedBetCount: 0, unjudgedStake: 0, expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0, maxPayout: 0, maxPayoutStake: 0, byBetType: {}, byMark: [] });
    const sec = sections(buildReportPrompt({ ...input(), rolling: rolling(buildDayStats(digests()), empty) }));
    expect(sec["直前 27 日(その日を除く)の成績(確定値)"]).toContain("分析したレースはありません");
    expect(sec["直前 27 日(その日を除く)の成績(確定値)"]).toContain("比較できません");
    expect(sec["直近 28 日の累計(その日を含む)の成績(確定値)"]).toContain("その日の成績と同じ");
    expect(sec["直近 28 日の累計(その日を含む)の成績(確定値)"]).not.toContain("賭け金");
  });

  it("出力形式の summary の指示に、見込みとの比較を含める", () => {
    const p = buildReportPrompt(input());
    const line = p.split("\n").find((l) => l.includes('"summary"'))!;
    expect(line).toContain("見込み");
  });
});

describe("formatComboKey", () => {
  it.each([
    ["win", "07", "7番"],
    ["place", "11", "11番"],
    ["wide", "0103", "1-3番"],
    ["quinella", "0213", "2-13番"],
    ["trio", "010709", "1-7-9番"],
    ["exacta", "1308", "13→8番"],
    ["trifecta", "010203", "1→2→3番"],
    ["bracketQuinella", "0105", "1-5(枠)"],
  ])("%s の %s は %s", (betType, key, expected) => {
    expect(formatComboKey(betType, key)).toBe(expected);
  });

  it("読めないキー(奇数桁・数字以外)・未知の券種は元の文字列のまま(例外にしない)", () => {
    expect(formatComboKey("wide", "010")).toBe("010");
    expect(formatComboKey("wide", "ab")).toBe("ab");
    expect(formatComboKey("mystery", "0102")).toBe("0102");
  });
});

describe("parseNarrative", () => {
  const ok = { summary: "総括です", good: ["良い点1", "良い点2"], improve: ["改善点1"], races: [{ raceId: R1, comment: "コメント" }] };
  const known = new Set([R1, R2]);

  it("素の JSON を読む", () => {
    expect(parseNarrative(JSON.stringify(ok), known)).toStrictEqual(ok);
  });

  it("コードフェンス・前後の説明文があっても、最初の { から最後の } までを読む", () => {
    expect(parseNarrative("```json\n" + JSON.stringify(ok) + "\n```", known)).toStrictEqual(ok);
    expect(parseNarrative("以下が日報です。\n" + JSON.stringify(ok) + "\n以上", known)).toStrictEqual(ok);
  });

  it("summary が無い・空・文字列でない、JSON でない、オブジェクトでないものは null(呼び出し側が生テキストにフォールバックする)", () => {
    expect(parseNarrative("{}", known)).toBeNull();
    expect(parseNarrative(JSON.stringify({ ...ok, summary: "  " }), known)).toBeNull();
    expect(parseNarrative(JSON.stringify({ ...ok, summary: 3 }), known)).toBeNull();
    expect(parseNarrative("日報です", known)).toBeNull();
    expect(parseNarrative("[1,2]", known)).toBeNull();
    expect(parseNarrative("", known)).toBeNull();
  });

  it("good・improve が無い・配列でないときは空配列。文字列でない要素・空の要素は捨てる", () => {
    expect(parseNarrative(JSON.stringify({ summary: "s" }), known)).toStrictEqual({ summary: "s", good: [], improve: [], races: [] });
    expect(parseNarrative(JSON.stringify({ summary: "s", good: ["a", 1, "", null, "b"], improve: "x" }), known)).toStrictEqual({ summary: "s", good: ["a", "b"], improve: [], races: [] });
  });

  it("長さの上限で切る(総括・項目・件数・レース別コメント)", () => {
    const long = "あ".repeat(NARRATIVE_LIMITS.summary + 100);
    const many = Array.from({ length: NARRATIVE_LIMITS.items + 5 }, (_, i) => `項目${i}`);
    const parsed = parseNarrative(JSON.stringify({ summary: long, good: many, improve: [long], races: [{ raceId: R1, comment: long }] }), known)!;
    expect(parsed.summary.length).toBe(NARRATIVE_LIMITS.summary);
    expect(parsed.summary.endsWith("…")).toBe(true);
    expect(parsed.good).toHaveLength(NARRATIVE_LIMITS.items);
    expect(parsed.improve[0]!.length).toBe(NARRATIVE_LIMITS.item);
    expect(parsed.races[0]!.comment.length).toBe(NARRATIVE_LIMITS.comment);
  });

  it("レース別コメントは、今日のレースの raceId のものだけを残し、件数の上限で切る", () => {
    const races = [{ raceId: "999999999999", comment: "知らないレース" }, { raceId: R2, comment: "ok" }, { raceId: R2, comment: 5 }, "x"];
    expect(parseNarrative(JSON.stringify({ summary: "s", races }), known)!.races).toStrictEqual([{ raceId: R2, comment: "ok" }]);
    const dup = Array.from({ length: NARRATIVE_LIMITS.races + 3 }, () => ({ raceId: R1, comment: "c" }));
    expect(parseNarrative(JSON.stringify({ summary: "s", races: dup }), known)!.races).toHaveLength(NARRATIVE_LIMITS.races);
  });
});

describe("Issue #272: 印の定型の買い方(もしも)の節と規則", () => {
  const sectionsOf = (p: string): Record<string, string> => Object.fromEntries(p.split(/^## /m).slice(1).map((part) => [part.slice(0, part.indexOf("\n")), part.slice(part.indexOf("\n") + 1)]));
  const WHATIF_HEADING = "印の定型の買い方(「もしも」。確定値。各 100 円)";

  /** R3: ◎1〇2▲3 が 1〜3 着で、3 連複 1-2-3(払戻 5,000 円)が出たが、実際はワイド 1-4 だけ買っていた(はずれ)。 */
  function nearMissDigest() {
    const r = result([[1, 1, 350, 130], [2, 2, null, 150], [3, 3, null, 110], [4, 4, null, null]]);
    return buildRaceDigest(
      view("202605030803", 3, [horse(1, { mark: "◎" }), horse(2, { mark: "〇" }), horse(3, { mark: "▲" })], [["wide", "0104", 200]]),
      { ...r, combos: { wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }] }, trio: { imported: true, payouts: [{ comboKey: "010203", payout: 5000 }] } } },
    );
  }
  const withNear = () => {
    const d = [...digests(), nearMissDigest()];
    return { kaisaiDate: "20261010", digests: d, stats: buildDayStats(d), rolling: rolling(buildDayStats(d)), nearMisses: pickNearMisses(d) };
  };

  it("節は『レースごとの予想と結果』の前にあり、その日と直近 28 日の累計に、5 型の成績を型の順に出す(合算は 直前 27 日 + その日)", () => {
    const p = buildReportPrompt(input());
    const s = sectionsOf(p);
    expect(Object.keys(s).indexOf(WHATIF_HEADING)).toBeGreaterThan(Object.keys(s).indexOf("直近 28 日の累計(その日を含む)の成績(確定値)"));
    expect(Object.keys(s).indexOf(WHATIF_HEADING)).toBeLessThan(Object.keys(s).indexOf("レースごとの予想と結果"));
    const sec = s[WHATIF_HEADING]!;
    const [day, total] = sec.split(/^### /m).slice(1);
    // その日: R1 の◎(1 着・単勝 350 円)。R2 は結果なしで判定不能
    expect(day).toContain("その日");
    expect(day).toContain("- ◎単勝: 判定できた 1 レース中 1 的中・賭け金 100円・払戻 350円・回収率 350.0%(判定不能 1 レース)");
    // ◎-〇ワイドは、R1 が組合せ払戻なしで判定不能、R2 は〇が無く対象外
    expect(day).toContain("- ◎-〇ワイド: 判定できたレースなし(判定不能 1 レース・対象外 1 レース)");
    // 累計: 直前 27 日(40 点・8 的中・払戻 3,200)+ その日(1 点・1 的中・払戻 350)
    expect(total).toContain("直近 28 日の累計");
    expect(total).toContain("- ◎単勝: 判定できた 41 レース中 9 的中・賭け金 4,100円・払戻 3,550円・回収率 86.6%(判定不能 3 レース・対象外 3 レース)");
    // 型の順序
    const labels = ["◎単勝", "◎複勝", "◎-〇ワイド", "◎-〇馬連", "◎〇▲の3連複"];
    const at = labels.map((l) => day!.indexOf(`- ${l}:`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("節に、母集団が実際の配分と違うこと・判定不能と対象外は成績に含めないことを書く", () => {
    const sec = sectionsOf(buildReportPrompt(input()))[WHATIF_HEADING]!;
    expect(sec).toContain("実際の配分");
    expect(sec).toContain("点数も賭け金も揃っていません");
    expect(sec).toContain("成績に含めません");
  });

  it("規則に 1 文足す: 『もしも』は後から選び直した参考値・1 日分で当たった型を追いかけない・続けてよいかは直近 28 日の点数と回収率で。『偶然の影響が大きい』は使わない", () => {
    const rules = sectionsOf(buildReportPrompt(input()))["規則"]!;
    const rule = rules.split("\n").filter((l) => l.includes("もしも"));
    expect(rule).toHaveLength(1);
    expect(rule[0]).toContain("追いかける材料にしない");
    expect(rule[0]).toContain("直近 28 日の累計の点数と回収率");
    expect(buildReportPrompt(input())).not.toContain("偶然の影響が大きい");
  });

  it("その日の定型の成績が無い(旧形のジョブ。whatIf=null)なら、節も規則の 1 文も出さない(参照先の無い規則を残さない)", () => {
    const d = digests();
    const stats = { ...buildDayStats(d), whatIf: null };
    const p = buildReportPrompt({ kaisaiDate: "20261010", digests: d, stats, rolling: rolling(stats) });
    expect(p).not.toContain("印の定型の買い方");
    expect(p).not.toContain("もしも");
    expect(p).toContain("## レースごとの予想と結果");
  });

  it("惜しかったレース: 払戻の多い順の行に、レース・型・定型の払戻・実際の買い目(賭け金・払戻)を出す。全件数を添える", () => {
    const p = buildReportPrompt(withNear());
    const near = sectionsOf(p)[WHATIF_HEADING]!.split(/^### /m).slice(1).find((x) => x.startsWith("惜しかったレース"))!;
    expect(near).toContain("全 1 件");
    expect(near).toContain("raceId=202605030803");
    expect(near).toContain("◎〇▲の3連複が的中していた(定型の払戻 5,000円)");
    expect(near).toContain("実際の買い目: 賭け金 200円・払戻 0円");
  });

  it("惜しかったレースが 0 件なら『該当なし』。nearMisses を渡さない(未計算)ときは、その小節を出さない", () => {
    const none = buildReportPrompt({ ...input(), nearMisses: { total: 0, shown: [] } });
    expect(sectionsOf(none)[WHATIF_HEADING]).toContain("- 該当なし");
    expect(sectionsOf(buildReportPrompt(input()))[WHATIF_HEADING]).not.toContain("惜しかったレース");
  });

  it("実際の買い目が無いレースは、見送りの理由か『買い目なし』を書く", () => {
    const v = view("202605030804", 4, [horse(1, { mark: "◎" }), horse(2, { mark: "〇" })]);
    const d = buildRaceDigest(v, { ...result([[1, 1, 350, 130], [2, 2, null, 150]]), combos: { wide: { imported: true, payouts: [{ comboKey: "0102", payout: 700 }] } } });
    const stats = buildDayStats([d]);
    const p = buildReportPrompt({ kaisaiDate: "20261010", digests: [d], stats, rolling: rolling(stats), nearMisses: pickNearMisses([d]) });
    expect(sectionsOf(p)[WHATIF_HEADING]).toContain("◎-〇ワイドが的中していた(定型の払戻 700円)・実際の買い目: 買い目なし");
  });
});
