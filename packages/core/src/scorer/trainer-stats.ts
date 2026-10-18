/**
 * 調教師の前2年の3着内率(Issue #354〈#348 の TR1〉)。統計モデル(prior)の 15 番目の項目。
 *
 * ## 何を測るか
 * 調教師の年度別成績(`db.netkeiba.com/trainer/result.html?id=…`。表の形は騎手と同じで `parseJockeyResults` が読む)から、
 * レースの年 Y の **(Y−2, Y−1) の2年分**の3着内と出走を合算し、全体の率へ縮小した「3着内率」を作る。
 * - **窓**: 騎手(`jockey-stats.ts`)と違い、ライブと過去日の区別がない。常に前2年で、当年(Y)の行は使わない
 *   (調教師の年度別成績は「いま」の値で、当年の行にはレース日より後の出走が入りうる〈先読み〉)。検証(#348)も同じ窓で行った。
 * - **縮小**: 率 = (3着内の合計 + 50 × 0.222) ÷ (出走の合計 + 50)。0.222 は {@link TRAINER_PLACE_RATE_BASE}。
 * - **特徴量**: 率 − レース内の「値のある馬」の平均。値が無い馬(取得できなかった・調教師IDが無い・窓の出走が 0)は 0。
 *   値のある馬が 2 頭未満なら全頭 0(比べる相手がいない)。**打ち切りはしない**(検証にも無い)。
 * - **補正** = w × 特徴量(w は `config.baseScore.weights.trainer`)。単位は騎手と同じ「3着内率の差 × 重み」。
 *
 * ## 対象外
 * 今回が地方(NAR)のレースと、障害のレース。検証したのは中央の平地だけで、地方の全体の率(騎手の中立値は中央 0.22・地方 0.29)も未検証のため。
 *
 * ## prior への入れ方
 * 特徴量はレース内の平均との差なので 1 頭では決まらず、レース全頭を見る `computeFieldPriors` が足す
 * (raw = 中立確率 + Σ(基礎6 + バイアス7 の補正) + w_タイム指数 × 特徴量 + w_調教師 × 特徴量 を、ロジットシフトで正規化)。
 */

import type { RaceIdVenueKind } from "../scraper/ids.js";
import type { JockeyYearRecord } from "../scraper/parse-jockey-results.js";
import type { CourseType } from "../scraper/types.js";
import type { ScoreContribution } from "./prior.js";

/**
 * 縮小の基準(中央の全調教師の合算の3着内率)。2024〜25 年の合算 19,398 ÷ 87,230 = 0.2224 を丸めた値(#348 の検証と同じ)。
 * 再現: `pnpm tsx scripts/trainer-base-rate.ts --years 2024,2025 <取得済みの調教師ページの置き場>`
 * (2026-10-17 に取得した、#342・#348・#274 の 300 レースに出走した調教師 196 人のうち、窓の行を持つ 187 人の合算。元データはリポジトリに入れない。
 * 窓の算術は `scripts/test/trainer-base-rate-calc.test.ts` が固定する)。
 * 値には鈍感: 特徴量はレース内の平均を引くので、基準の違いは出走の少ない調教師の位置にしか効かない(0.20〜0.25 に振っても、特徴量はほぼ同じ並びだった。Issue #354 のコメント)。
 */
export const TRAINER_PLACE_RATE_BASE = 0.222;

/** 縮小の強さ(出走に換算した擬似標本数)。 */
export const TRAINER_SHRINK_STARTS = 50;

/** 寄与度ログの項目名。 */
export const TRAINER_NAME = "調教師成績";

/** 窓内の合計(出走数と3着内の数)。 */
export interface TrainerStats {
  readonly starts: number;
  readonly placed: number;
}

/** 分析日(YYYY/MM/DD)から年を取り出す。形式が違えば失敗させる(黙って別の窓にしない)。 */
function yearOf(analysisDate: string): number {
  const m = /^(\d{4})\/\d{2}\/\d{2}$/.exec(analysisDate);
  if (m === null) {
    throw new Error(`分析日は YYYY/MM/DD の形式である必要があります(入力: "${analysisDate}")`);
  }
  return Number(m[1]);
}

/** 集計する年の窓 `[古い年, 新しい年]` = (Y−2, Y−1)。Y は分析日(=レース日)の年。 */
export function trainerStatsWindow(analysisDate: string): readonly [number, number] {
  const y = yearOf(analysisDate);
  return [y - 2, y - 1];
}

/**
 * 調教師の年ごとの記録から、窓の年だけを足し合わせる。
 * - 記録そのものが無い(取得できなかった・調教師IDが無い)ときは undefined(= 「データなし」)。
 * - 記録はあるが窓の年の行が無いときは出走 0。
 * @param records `parseJockeyResults` の結果(取得できなかった調教師は undefined)
 * @param analysisDate 分析日(YYYY/MM/DD)
 */
export function selectTrainerStats(
  records: readonly JockeyYearRecord[] | undefined,
  analysisDate: string,
): TrainerStats | undefined {
  if (records === undefined) {
    return undefined;
  }
  const [from, to] = trainerStatsWindow(analysisDate);
  let starts = 0;
  let placed = 0;
  for (const r of records) {
    if (r.year >= from && r.year <= to) {
      starts += r.starts;
      placed += r.placed;
    }
  }
  return { starts, placed };
}

/** 縮小した3着内率。値なし(データなし・出走 0)は null。 */
export function shrunkTrainerRate(stats: TrainerStats | undefined): number | null {
  if (stats === undefined || stats.starts <= 0) {
    return null;
  }
  return (stats.placed + TRAINER_SHRINK_STARTS * TRAINER_PLACE_RATE_BASE) / (stats.starts + TRAINER_SHRINK_STARTS);
}

/** {@link computeFieldTrainerContributions} の今回レースの条件と重み。 */
export interface FieldTrainerContext {
  /** 今回のレースの開催区分。"nar" は全頭対象外。 */
  readonly venueKind: RaceIdVenueKind;
  /** 今回のコース種別。"障" は全頭対象外。 */
  readonly courseType: CourseType;
  /** 調教師成績の重み w。 */
  readonly weight: number;
}

/**
 * レース全頭ぶんの調教師成績の寄与度を返す(入力と同じ並び)。
 * `sampleCount` に窓の出走、`targetRate` に縮小した率、`overallRate` にレース内の平均を入れる。
 * @param statsByHorse 馬ごとの窓内の合計(取得できなかった・調教師IDが無い馬は undefined)。
 */
export function computeFieldTrainerContributions(
  statsByHorse: readonly (TrainerStats | undefined)[],
  ctx: FieldTrainerContext,
): ScoreContribution[] {
  const { weight } = ctx;
  const off = (reason: string): ScoreContribution[] =>
    statsByHorse.map(() => ({
      biasName: TRAINER_NAME,
      applied: false,
      reason,
      weight,
      correction: 0,
      sampleCount: 0,
      targetRate: null,
      overallRate: null,
    }));
  if (ctx.venueKind === "nar") {
    return off("NARのため対象外");
  }
  if (ctx.courseType === "障") {
    return off("障害のため対象外");
  }

  const rates = statsByHorse.map((s) => shrunkTrainerRate(s));
  const known = rates.filter((r): r is number => r !== null);

  if (known.length < 2) {
    return statsByHorse.map((s, i) => ({
      biasName: TRAINER_NAME,
      applied: false,
      reason:
        rates[i] === null
          ? "調教師の成績がなく、レース内で比べられる馬も2頭未満のため補正なし"
          : "調教師の成績のある馬がレース内で2頭未満のため補正なし",
      weight,
      correction: 0,
      sampleCount: s?.starts ?? 0,
      targetRate: rates[i] ?? null,
      overallRate: null,
    }));
  }

  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  return statsByHorse.map((s, i) => {
    const rate = rates[i] ?? null;
    if (rate === null) {
      return {
        biasName: TRAINER_NAME,
        applied: false,
        reason: "調教師の成績がない(取得できなかった・窓の出走が0)ため補正なし",
        weight,
        correction: 0,
        sampleCount: s?.starts ?? 0,
        targetRate: null,
        overallRate: mean,
      };
    }
    return {
      biasName: TRAINER_NAME,
      applied: true,
      reason: `調教師の前2年の3着内率(縮小後)${(rate * 100).toFixed(1)}% とレース内の平均 ${(mean * 100).toFixed(1)}% の差で補正`,
      weight,
      correction: weight * (rate - mean),
      sampleCount: s!.starts,
      targetRate: rate,
      overallRate: mean,
    };
  });
}
