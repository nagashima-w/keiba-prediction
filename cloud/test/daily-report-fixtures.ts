/**
 * 日報のテスト用の部品(Issue #235)。**本物の `DailyReportCore`** に偽の D1/R2/LLM/時計を通して、保存される `ReportRecord` を作る。
 * クライアントの契約テスト(`client-api-report-contract.test.ts`)と、プロンプトの確認用スクリプト(`print-report-prompt.ts`)が使う。
 * 偽のデータだけを使う(実 API・netkeiba には出ない)。
 */
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { DailyReportCore, type DailyReportDeps, type RaceInput, type ReportRecord } from "../src/daily-report-core";
import type { PeriodStats } from "../src/period-stats";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import type { MessageSender } from "@keiba/core/llm";

export const FIXTURE_DATE = "20261010";

function horse(umaban: number, name: string, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}

/** 偽の 3 レース(結果あり 2・結果なし 1)。買い目は単勝・複勝・ワイド・馬連(未取込)。 */
export function fixtureRaceInputs(): RaceInput[] {
  const allocation = (bets: Array<[string, string, number, number]>): NonNullable<AnalysisView["allocation"]> => ({
    route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 20000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1,
    includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok",
    bets: bets.map(([betType, comboKey, stake, odds]) => ({ betType, comboKey, stake, odds, ev: 1.15 })),
  });
  const view = (n: number, id: number, raceName: string, horses: AnalysisViewHorse[], bets: Array<[string, string, number, number]>): AnalysisView => ({
    id, raceId: `2026050308${String(n).padStart(2, "0")}`, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: FIXTURE_DATE, evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v-fixture", llmNote: null, llmCalls: null,
    race: { venueName: "東京", raceNumber: n, raceName, grade: null, startTime: `${10 + n}:00`, courseType: n === 2 ? "ダ" : "芝", distance: n === 2 ? 1400 : 1600, weather: "晴", trackCondition: "良", oddsStatus: "result", placeBasis: "top3" },
    horses, allocation: allocation(bets), detail: "present",
  });
  const result = (rows: Array<[number, number | null, number | null, number | null]>, combos: RaceResultData["combos"] = {}): RaceResultData => ({
    horses: rows.map(([umaban, finishPosition, winPayout, placePayout]) => ({ umaban, finishPosition, winPayout, placePayout })),
    combos,
  });
  return [
    {
      view: view(1, 101, "3歳未勝利", [
        horse(1, "アルファ", { mark: "◎", adjustedProb: 0.52, ev: 1.18, isPositive: true, reason: "前走の上がりが最速で、距離延長にも対応できる", highlights: ["前走上がり最速"], concerns: ["外枠"] }),
        horse(2, "ブラボー", { mark: "〇", adjustedProb: 0.41, ev: 0.95, reason: "安定した先行力" }),
        horse(3, "チャーリー", { mark: "▲", adjustedProb: 0.33, ev: 1.3, isPositive: true, concerns: ["久々の実戦"] }),
        horse(4, "デルタ"),
      ], [["win", "01", 300, 4.2], ["place", "03", 200, 2.4], ["wide", "0103", 200, 6.5], ["quinella", "0103", 100, 14]]),
      result: result([[1, 1, 420, 140], [2, 4, null, null], [3, 2, null, 230], [4, 3, null, 160]], { wide: { imported: true, payouts: [{ comboKey: "0104", payout: 520 }, { comboKey: "0103", payout: 780 }] }, quinella: { imported: false, payouts: [] } }),
    },
    {
      view: view(2, 102, "4歳以上1勝クラス", [
        horse(5, "エコー", { mark: "◎", adjustedProb: 0.45, ev: 1.05, isPositive: true, reason: "ダートへの替わりで上昇" }),
        horse(6, "フォックス", { mark: "〇", adjustedProb: 0.4, ev: 0.9 }),
        horse(7, "ゴルフ", { mark: "☆", adjustedProb: 0.2, ev: 1.6, isPositive: true, reason: "展開が向けば", concerns: ["休み明け"] }),
      ], [["win", "05", 400, 3.1], ["place", "07", 200, 3.0]]),
      result: result([[6, 1, 550, 190], [5, 2, null, 120], [8, 3, null, 380], [7, 7, null, null]]),
    },
    {
      view: view(3, 103, "オープン", [
        horse(1, "ホテル", { mark: "◎", adjustedProb: 0.5, ev: 1.0, isPositive: true }),
        horse(2, "インディア", { mark: "〇", adjustedProb: 0.35 }),
      ], [["win", "01", 300, 3.5]]),
      result: undefined,
    },
  ];
}

/**
 * 偽の「直前 27 日」の統計(Issue #264)。開催 6 日・120 レース・買い目 300 点中 24 点的中(見込み 21.5 点)・回収率 85%。
 * 範囲(fromDate・toDate)は日報が渡した値で上書きされる。プロンプトの確認用スクリプト(`print-report-prompt.ts`)のシナリオも、これを土台に数字を変える。
 */
export function fixturePriorStats(over: Partial<PeriodStats> = {}): PeriodStats {
  return {
    fromDate: "20260913", toDate: "20261009", dayCount: 6,
    raceCount: 120, resultRaceCount: 118, noResultRaceCount: 2, betRaceCount: 110, llmUsedRaceCount: 100,
    totalStake: 40000, totalReturn: 34000, recoveryRate: 0.85, judgedBetCount: 300, hitBetCount: 24, unjudgedBetCount: 3, unjudgedStake: 900,
    expectedBetCount: 300, expectedHits: 21.5, expectedBaseHits: 24, maxPayout: 9000, maxPayoutStake: 300,
    byBetType: {
      win: { betCount: 100, hitCount: 6, stake: 15000, payout: 12000, expectedBetCount: 100, expectedHits: 5.25, expectedBaseHits: 6 },
      place: { betCount: 120, hitCount: 14, stake: 17000, payout: 15000, expectedBetCount: 120, expectedHits: 12.5, expectedBaseHits: 14 },
      wide: { betCount: 80, hitCount: 4, stake: 8000, payout: 7000, expectedBetCount: 80, expectedHits: 3.75, expectedBaseHits: 4 },
    },
    byMark: [{ mark: "◎", count: 118, win: 30, top3: 70 }, { mark: "〇", count: 110, win: 18, top3: 62 }],
    // 印の定型(Issue #272)。どの型も 120 レースの内訳(判定できた + 判定不能 3 + 対象外)。対象外は、◎が無い 2 件(全型)、〇が無い 10 件を足してワイド・馬連が 12 件、▲が無い 15 件を足して 3 連複が 27 件。
    whatIf: {
      win: { betCount: 115, hitCount: 30, stake: 11500, payout: 10100, unjudgedCount: 3, inapplicableCount: 2 },
      place: { betCount: 115, hitCount: 70, stake: 11500, payout: 11900, unjudgedCount: 3, inapplicableCount: 2 },
      wide: { betCount: 105, hitCount: 22, stake: 10500, payout: 9800, unjudgedCount: 3, inapplicableCount: 12 },
      quinella: { betCount: 105, hitCount: 12, stake: 10500, payout: 9300, unjudgedCount: 3, inapplicableCount: 12 },
      trio: { betCount: 90, hitCount: 4, stake: 9000, payout: 7200, unjudgedCount: 3, inapplicableCount: 27 },
    },
    ...over,
  };
}

/** 偽の LLM の応答(日報の JSON)。 */
export function fixtureNarrativeText(): string {
  return JSON.stringify({
    summary: "3 レースを分析し、結果のある 2 レースで◎は 1 勝。単勝 1 点・複勝 1 点・ワイド 1 点が的中し、回収率はプラスでした。",
    good: ["◎が勝った 1R は単勝・ワイドともに的中", "穴の☆は圏外でも買い目の損失は小さい"],
    improve: ["〇が 4 着・2 着に終わり、対抗の評価が高すぎる傾向"],
    races: [{ raceId: "202605030801", comment: "◎→▲の組み合わせが有効だった" }],
  });
}

/** 本物のコアに偽のポートを通して、保存される日報を作る。`promptOut` を渡すと、LLM に送ったプロンプトを入れる。 */
export async function buildSavedRecord(options: { readonly llmText?: string; readonly promptOut?: string[]; readonly inputs?: RaceInput[]; readonly prior?: PeriodStats } = {}): Promise<ReportRecord> {
  const inputs = options.inputs ?? fixtureRaceInputs();
  const saved: ReportRecord[] = [];
  const kv = new Map<string, unknown>();
  const clock = { t: Date.parse("2026-10-10T11:00:00.000Z") };
  const sender: MessageSender = async (params) => {
    options.promptOut?.push(params.messages[0]!.content);
    return { content: [{ type: "text", text: options.llmText ?? fixtureNarrativeText() }], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 4000, output_tokens: 800 } };
  };
  const deps: DailyReportDeps = {
    kv: {
      get: <T>(key: string) => (kv.has(key) ? (JSON.parse(JSON.stringify(kv.get(key))) as T) : undefined),
      put: (key, value) => void kv.set(key, JSON.parse(JSON.stringify(value))),
      delete: (key) => void kv.delete(key),
    },
    now: () => clock.t,
    setAlarm: () => {},
    onWarn: () => {},
    source: {
      listDayAnalyses: async () => inputs.map((i) => ({ raceId: i.view.raceId, analysisId: i.view.id })),
      readRaces: async (items) => items.map((i) => inputs.find((x) => x.view.id === i.analysisId) ?? null),
      readPeriodStats: async (fromDate, toDate) => ({ ...(options.prior ?? fixturePriorStats()), fromDate, toDate }),
    },
    store: { hasReport: async () => false, saveReport: async (r) => (saved.push(r), "saved"), replaceReport: async () => "replaced" },
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    llm: { sender },
  };
  const core = new DailyReportCore(deps);
  await core.requestReport({ kaisaiDate: FIXTURE_DATE, mode: "manual" });
  for (let i = 0; i < 20 && saved.length === 0; i += 1) {
    await core.runNextStep();
    clock.t += 1000;
  }
  if (saved.length === 0) {
    throw new Error("日報が保存されませんでした");
  }
  return saved[0]!;
}
