import { describe, expect, it } from "vitest";
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { buildDayStats, buildRaceDigest } from "../src/daily-report-digest";
import { buildReportPrompt, formatComboKey, NARRATIVE_LIMITS, parseNarrative } from "../src/daily-report-prompt";

/** Issue #235: 日報のプロンプトの組み立てと、LLM の応答(JSON)の解釈。 */

function horse(umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, ...over };
}
function view(raceId: string, raceNumber: number, horses: AnalysisViewHorse[], bets: Array<[string, string, number]> = []): AnalysisView {
  return {
    id: raceNumber, raceId, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: "20261010", evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v1", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber, raceName: `テスト${raceNumber}S`, startTime: "15:45", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result" },
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
const input = () => {
  const d = digests();
  return { kaisaiDate: "20261010", digests: d, stats: buildDayStats(d) };
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
    const p = buildReportPrompt({ kaisaiDate: "20261010", digests: [], stats: buildDayStats([]) });
    expect(p).toContain("2026年10月10日(土)");
    expect(p).toContain("分析したレース: 0 件");
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
