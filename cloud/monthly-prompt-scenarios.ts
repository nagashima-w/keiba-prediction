/**
 * 月報のプロンプトの近似確認用シナリオ(Issue #280)。`print-monthly-prompt.ts --scenario M1..M3` が使う。**偽のデータだけ**(実 API・netkeiba・D1・R2 には触れない)。
 *
 * 目的: 月報のプロンプトを、実 API の代わりにサブエージェントに読ませて、3 つの場面で何が書かれるか(規則が効くか)を確かめる。
 * 月の行は `test/monthly-fixtures.ts` の生成器(シード付きの乱数。決定的)で作り、本番と同じ `buildMonthStats` に通す。
 *
 * | 名前 | 場面 | 月の形 | 見たいこと |
 * |---|---|---|---|
 * | M1 | 黒字の月 | 開催 9 日・216 レース。単勝が見込みより多く当たる。版が 2 つ(前半 5 日と後半 4 日) | 見込みの的中数との比較で書くか。最大の 1 点を除いた回収率に触れるか。版の優劣を決めないか。来月に向けてを命令にしないか |
 * | M2 | 赤字の月 | 開催 9 日・216 レース。単勝が見込みより少なく当たる。版は 1 つ | 赤字を見込みとの比較で説明するか(定型の「偶然」にしないか)。改善点を命令にしないか。前の月との比較を捏造しないか |
 * | M3 | 標本の少ない月 | 開催 2 日・20 レース。最終日の結果が未取込(lastDayPending)。版は 1 つ | 少なさを一度だけ述べ、傾向を断定しないか。最終日の成績を断定しないか |
 */
import { DIRECTION_KEYS, POPULARITY_KEYS, type AdjustmentFit, type DirectionKey, type FitBucket, type FitGroup, type PopularityKey } from "./src/adjustment-fit";
import type { MonthStats } from "./src/monthly-stats";
import { OCT_2026_DAYS, syntheticMonthStats, type SyntheticMonthSpec } from "./test/monthly-fixtures";

export const MONTHLY_SCENARIO_IDS = ["M1", "M2", "M3"] as const;
export type MonthlyScenarioId = (typeof MONTHLY_SCENARIO_IDS)[number];

export const MONTHLY_SCENARIO_MONTH = "202610";

export interface MonthlyScenario {
  readonly id: MonthlyScenarioId;
  readonly title: string;
  readonly month: string;
  readonly lastDayPending: boolean;
  readonly spec: SyntheticMonthSpec;
  readonly stats: MonthStats;
}

const SPECS: Readonly<Record<MonthlyScenarioId, { readonly title: string; readonly lastDayPending: boolean; readonly spec: SyntheticMonthSpec }>> = {
  M1: {
    title: "黒字の月",
    lastDayPending: false,
    spec: {
      month: MONTHLY_SCENARIO_MONTH,
      days: OCT_2026_DAYS,
      racesPerDay: 24,
      seed: 20261031,
      winHitRate: 0.3,
      winOdds: 6,
      winProb: 0.18,
      versions: OCT_2026_DAYS.map((_, i) => (i < 5 ? "2026-10-12.1" : "2026-10-13.1")),
    },
  },
  M2: {
    title: "赤字の月",
    lastDayPending: false,
    spec: {
      month: MONTHLY_SCENARIO_MONTH,
      days: OCT_2026_DAYS,
      racesPerDay: 24,
      seed: 20261001,
      winHitRate: 0,
      winOdds: 9,
      winProb: 0.12,
      versions: OCT_2026_DAYS.map(() => "2026-10-13.1"),
    },
  },
  M3: {
    title: "標本の少ない月",
    lastDayPending: true,
    spec: {
      month: MONTHLY_SCENARIO_MONTH,
      days: ["20261017", "20261031"],
      racesPerDay: 10,
      seed: 7,
      winHitRate: 0.05,
      winOdds: 12,
      winProb: 0.1,
      versions: ["2026-10-13.1", "2026-10-13.1"],
      lastDayWithoutResults: true,
    },
  },
};

export function buildMonthlyScenario(id: MonthlyScenarioId): MonthlyScenario {
  const { title, lastDayPending, spec } = SPECS[id];
  return { id, title, month: MONTHLY_SCENARIO_MONTH, lastDayPending, spec, stats: syntheticMonthStats(spec) };
}

/**
 * 「補正の当たり具合」(Issue #509)の固定のサンプル。`print-monthly-prompt.ts --with-fit` が、各シナリオの `stats.adjustmentFit` に載せる(プロンプトの長さの測り直し用)。
 * **偽の数字**(実際の月の値ではない)。形は、月全体 + 版 2 つ(M1 の版と同じ名前)で、本番の月の形に近い。区分の頭数には、数の少ない印が付く 30 頭未満の区分を含めている。
 * 本番のプロンプトの長さは、版の数や印の数で変わる。
 */
export function sampleAdjustmentFit(): AdjustmentFit {
  const dir = (counts: readonly number[], placed: readonly number[]): FitBucket<DirectionKey>[] =>
    DIRECTION_KEYS.map((key, i) => ({ key, count: counts[i]!, placedCount: placed[i]!, meanPrior: 0.28 + i * 0.02, meanAdjusted: 0.3 + i * 0.015 }));
  const pop = (counts: readonly number[], placed: readonly number[]): FitBucket<PopularityKey>[] =>
    POPULARITY_KEYS.map((key, i) => ({ key, count: counts[i]!, placedCount: placed[i]!, meanPrior: 0.5 - i * 0.12, meanAdjusted: 0.5 - i * 0.115 }));
  const group = (raceCount: number, horseCount: number, scale: number): FitGroup => ({
    raceCount,
    horseCount,
    byDirection: dir([Math.round(60 * scale), Math.round(220 * scale), Math.round(900 * scale), Math.round(240 * scale), Math.round(28 * scale)], [Math.round(30 * scale), Math.round(90 * scale), Math.round(270 * scale), Math.round(70 * scale), Math.round(9 * scale)]),
    byPopularity: pop([Math.round(200 * scale), Math.round(400 * scale), Math.round(600 * scale), Math.round(250 * scale)], [Math.round(120 * scale), Math.round(180 * scale), Math.round(170 * scale), Math.round(40 * scale)]),
    brier: { prior: 0.1632, adjusted: 0.1621 },
    optimalK: 1.2,
  });
  return {
    all: group(216, 1448, 1),
    byVersion: [
      { promptVersion: "2026-10-12.1", ...group(120, 800, 0.55) },
      { promptVersion: "2026-10-13.1", ...group(96, 648, 0.45) },
    ],
    hiddenVersionCount: 0,
    excluded: { suspect: 3, unknown: 1, uncheckedRaces: 2, estimated: 4, notLlm: 5 },
  };
}
