/**
 * 検証のプロンプト版別比較の射影(Issue #220〈web の検証画面(2)〉)。**`cloudflare:workers` を import しない**(Node でテストできる)。
 *
 * core の `computeVerifyReportByPromptVersion`(exe と同じ関数・同じ `PRODUCTION_VERIFY_CONFIG`)は版ごとに**完全な `VerifyReport`**(約 7KB。配分ベースの 8 券種・除外の内訳・印別などを含む)を返すが、
 * 画面(exe の版別の表と版別キャリブレーション)が使うのは次の項目だけ: 版・追加指示・集計件数・累積回収率の 4 値・キャリブレーションの帯と帯ごとの過信バイアス。
 * 版の数に比例する kv の値と API の応答を小さく保つため、**この項目だけを残して保存・配信する**(`summarizePromptVersions`)。完全な版別レポートは持たない。
 *
 * 版別は**区分(全体/中央のみ/地方のみ)に依らず全体**(exe の版別比較と同じ。core の関数に区分の引数が無い)。
 */
import type { CalibrationBin, PromptVersionVerifyReport } from "../../packages/core/src/ev/verify.js";
import { computeVerifyReportByPromptVersion, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";

/** 版別比較の 1 版(画面が使う項目だけ)。 */
export interface PromptVersionSummary {
  /** プロンプト版。版不明は null。 */
  readonly promptVersion: string | null;
  /** その版で使われた追加指示(重複なし。非 null は昇順、なし〈null〉は末尾)。全文(画面で 30 文字に要約する)。 */
  readonly additionalInstructions: readonly (string | null)[];
  /** 集計対象にした分析の件数。 */
  readonly includedAnalysisCount: number;
  /** 累積回収率(賭け数・投資額・回収額・回収率)。 */
  readonly bet: {
    readonly betCount: number;
    readonly totalStake: number;
    readonly totalReturn: number;
    readonly recoveryRate: number | null;
  };
  /** キャリブレーションの帯(core の帯と同じ順)。 */
  readonly calibration: readonly CalibrationBin[];
  /** 帯ごとの過信バイアス。`calibration` と**同じ長さ・同じ添字**(core の過信バイアスが短ければ、足りない分は null。exe が添字で対応づけ、無ければ「-」にするのと同じ)。 */
  readonly overconfidenceGaps: readonly (number | null)[];
}

/** core の版別レポートから、画面が使う項目だけを残す。並び(版の昇順・版不明が末尾)は core のまま。 */
export function summarizePromptVersions(reports: readonly PromptVersionVerifyReport[]): PromptVersionSummary[] {
  return reports.map(({ promptVersion, report, additionalInstructions }) => ({
    promptVersion,
    additionalInstructions,
    includedAnalysisCount: report.includedAnalysisCount,
    bet: { betCount: report.bet.betCount, totalStake: report.bet.totalStake, totalReturn: report.bet.totalReturn, recoveryRate: report.bet.recoveryRate },
    calibration: report.calibration,
    overconfidenceGaps: report.calibration.map((_, index) => report.trend.calibrationBias[index]?.overconfidenceGap ?? null),
  }));
}

/** 版別比較を計算して射影する(設定は exe の検証画面と同じ `PRODUCTION_VERIFY_CONFIG`)。 */
export function computePromptVersionSummaries(source: VerifyDataSource): PromptVersionSummary[] {
  return summarizePromptVersions(computeVerifyReportByPromptVersion(source, PRODUCTION_VERIFY_CONFIG));
}
