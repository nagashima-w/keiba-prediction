/**
 * 日報のテスト用の部品(Issue #235)。**本物の `DailyReportCore`** に偽の D1/R2/LLM/時計を通して、保存される `ReportRecord` を作る。
 * クライアントの契約テスト(`client-api-report-contract.test.ts`)と、プロンプトの確認用スクリプト(`print-report-prompt.ts`)が使う。
 * 偽のデータだけを使う(実 API・netkeiba には出ない)。
 */
import type { AnalysisView, AnalysisViewHorse } from "../src/analysis-view";
import type { RaceResultData } from "../src/daily-report-bets";
import { DailyReportCore, type DailyReportDeps, type RaceInput, type ReportRecord } from "../src/daily-report-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import type { MessageSender } from "@keiba/core/llm";

export const FIXTURE_DATE = "20261010";

function horse(umaban: number, name: string, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse {
  return { umaban, name, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, ...over };
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
    race: { venueName: "東京", raceNumber: n, raceName, startTime: `${10 + n}:00`, courseType: n === 2 ? "ダ" : "芝", distance: n === 2 ? 1400 : 1600, weather: "晴", trackCondition: "良", oddsStatus: "result" },
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
export async function buildSavedRecord(options: { readonly llmText?: string; readonly promptOut?: string[]; readonly inputs?: RaceInput[] } = {}): Promise<ReportRecord> {
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
    },
    store: { hasReport: async () => false, saveReport: async (r) => (saved.push(r), "saved") },
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
