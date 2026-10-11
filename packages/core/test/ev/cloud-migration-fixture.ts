import type { AnalysisAllocationMetaRecord, AnalysisHorseRecord } from "../../src/ev/analysis-store-types.js";
import type { AnalysisStore } from "../../src/ev/analysis-store.js";

/**
 * クラウド移行(Issue #215)のテスト用に、実際の AnalysisStore の保存 API だけで DB を埋める共通の材料。
 * 直接 INSERT しない(往復テストが「既存のストアで保存した分析」を書き出すことを保つため)。
 * 例外は、保存 API では作れない『race_combo_payouts にだけ行がある race_id』(和集合のテスト用)と、設定列が NULL の旧分析(UPDATE)。
 */

/** LLM の生の応答に見立てた文字列。改行・U+2028・日本語・絵文字・引用符を含む(NDJSON の 1 行に収まるかを見るため)。 */
export const TRICKY_RAW_RESPONSE = '{"a":"改行\nと\r\nと と と🐎と\\と\\"引用"}\n\n末尾';

function horse(umaban: number, overrides: Partial<AnalysisHorseRecord> = {}): AnalysisHorseRecord {
  return {
    umaban,
    prior: 0.1 * umaban,
    // prior と値を分ける(adjusted_prob を prior から読む変異を、cloud 側の取り込みのテストが検出できるように。Issue #216)。
    adjustedProb: 0.1 * umaban + 0.03,
    placeOddsMin: 1.5 + umaban,
    ev: 0.9 + umaban / 10,
    isPositive: umaban % 2 === 0,
    contributions: null,
    mark: null,
    ...overrides,
  };
}

function meta(overrides: Partial<AnalysisAllocationMetaRecord> = {}): AnalysisAllocationMetaRecord {
  return {
    route: "mixed",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    comboOddsWide: "available",
    comboOddsTrio: "未発売",
    bankroll: 100000,
    perRaceCap: 10000,
    kellyFraction: 0.5,
    evThreshold: 1.05,
    includeComboOdds: true,
    includeWide: true,
    includeTrio: false,
    includeQuinella: true,
    includeExacta: false,
    includeTrifecta: true,
    includeBracketQuinella: false,
    betUnit: 100,
    greedySteps: 1000,
    candidateCap: null,
    modelId: "conditional-bernoulli",
    modelApproximate: false,
    oddsStatus: "ok",
    ...overrides,
  };
}

/** 保存した分析の数(ページ境界のテストが「倍数でない」ことを前提にするため、定数として公開する)。 */
export const FIXTURE_ANALYSIS_COUNT = 5;
/** 結果の行になるべき race_id(昇順)。 */
export const FIXTURE_RESULT_RACE_IDS = [
  "202603020211", // 結果+メタ+組合せ払戻+取込記録(分析もある)
  "202603020212", // 結果のみ(メタなし・組合せ払戻の取込記録なし)
  "202603020213", // 取込記録だけ(結果の行なし。払戻 0 件の確定)
  "202603020214", // メタだけ
  "202603020215", // race_combo_payouts にだけ行がある(保存 API では作れない)
] as const;

/**
 * 5 件の分析と 5 レースの結果を保存する。
 * - 分析 1: LLM なし・配分なし・NULL を含む列(prompt_version など)
 * - 分析 2: LLM あり(model・raw_response・race_snapshot_json)・配分メタと買い目・馬ごとの内訳と根拠
 * - 分析 3: 配分メタはあるが買い目なし・設定列が NULL(旧分析)
 * - 分析 4・5: 馬 1 頭だけ・同じレースを再分析(同一 race_id に複数の分析)
 */
export function populateMigrationFixture(store: AnalysisStore): void {
  store.saveAnalysis({
    raceId: "202603020211",
    analyzedAt: "2026-03-02T01:00:00.000Z",
    horses: [horse(1), horse(2, { placeOddsMin: null, ev: null })],
  });
  store.saveAnalysis({
    raceId: "202603020211",
    analyzedAt: "2026-03-02T02:00:00.000Z",
    evEstimated: true,
    promptVersion: "v8",
    additionalInstruction: "芝の重馬場を重視\n二行目",
    kaisaiDate: "20260302",
    historyCutoffDate: "20260301",
    promptLookaheadGuarded: true,
    model: "claude-sonnet-4-5",
    rawResponse: TRICKY_RAW_RESPONSE,
    raceSnapshot: { raceName: "福島民報杯", horses: [{ umaban: 1, name: "ディープ🐎" }], startTime: "15:25" },
    horses: [
      horse(1, {
        contributions: { bias: [{ name: "枠", delta: -0.01 }] },
        mark: "◎",
        reason: "内枠で先行できる\n二行目",
        highlights: ["近走好調"],
        concerns: ["斤量増", "間隔が短い"],
      }),
      horse(2, { mark: "△", reason: "" }),
      horse(3),
    ],
    allocation: {
      meta: meta(),
      bets: [
        { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
        { betType: "wide", comboKey: "0102", stake: 200, odds: null, ev: null },
      ],
    },
  });
  store.saveAnalysis({
    raceId: "202603020212",
    analyzedAt: "2026-03-02T03:00:00.000Z",
    promptVersion: "v7",
    horses: [horse(1)],
    allocation: {
      meta: meta({
        route: "unavailable",
        unavailableReason: "two-place-only",
        comboOddsWide: null,
        comboOddsTrio: null,
        betUnit: null,
        greedySteps: null,
        modelId: null,
        modelApproximate: null,
      }),
      bets: [],
    },
  });
  store.saveAnalysis({
    raceId: "202603020213",
    analyzedAt: "2026-03-02T04:00:00.000Z",
    horses: [horse(7)],
  });
  store.saveAnalysis({
    raceId: "202603020213",
    analyzedAt: "2026-03-02T05:00:00.000Z",
    kaisaiDate: "20260302",
    horses: [horse(7), horse(8)],
  });

  // 設定列を記録する前に保存された旧分析(NULL=記録なし)を作る。保存 API は真偽値しか受けないため、ここだけ直接 UPDATE する。
  store.rawDatabase
    .prepare(
      "UPDATE analysis_allocation_meta SET include_quinella = NULL, include_exacta = NULL, include_trifecta = NULL, include_bracket_quinella = NULL WHERE analysis_id = 3",
    )
    .run();

  store.saveResult(
    "202603020211",
    [
      { umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 380, passing: [3, 3, 2], last3f: 34.5 },
      { umaban: 2, finishPosition: 2, placePayout: 0, winPayout: null, passing: [], last3f: null },
      { umaban: 3, finishPosition: null },
    ],
    "芝",
    {
      wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 560 }, { umabans: [1, 3], payout: 1230 }] },
      trio: { state: "parsed", payouts: [] },
      exacta: { state: "parsed", payouts: [{ umabans: [2, 1], payout: 9990 }] },
    },
  );
  store.saveResult("202603020212", [{ umaban: 4, finishPosition: 3, placePayout: 200 }]);
  store.saveResult("202603020213", [], null, { wide: { state: "parsed", payouts: [] } });
  store.saveResult("202603020214", [], "ダ");
  store.rawDatabase
    .prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, ?, ?, ?)")
    .run("202603020215", "wide", "0102", 700);
}
