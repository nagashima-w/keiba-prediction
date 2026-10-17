/**
 * タイム指数(Issue #353〈#274-B〉。#274 の調査で効果を確かめた「簡単な版」)。
 *
 * ## 何を測るか
 * 過去走のタイムを、**競馬場×芝ダ×距離ごとの基準タイム**と**芝ダ×馬場(良/稍重/重・不良)の補正**で比べ、
 * 「基準より 1000m あたり何秒速いか」を 1 走の指数とする。競馬場・距離・馬場の違いを基準タイムで吸収するのが、
 * 持ち時計(#348)との違い。
 *
 * - **1走の指数** = (基準 + 馬場の補正[秒/km] × 距離km − タイム) ÷ 距離km。
 *   中央の走・着順が数値・タイムが `m:ss.f` で読める・馬場が良/稍/稍重/重/不/不良・芝かダート・基準のある区分、のすべてを満たす走だけ。
 *   障害(障)の走・区分は使わない(Issue #353 のユーザー決定。タイムがコースごとの障害の配置に左右され、区分の走数も薄い)。
 * - **馬の代表値** = 指数が出せた走のうち新しい順に 5 つの最高(`TIME_INDEX_RECENT_RUNS`)。
 * - **特徴量** = 代表値 − レース内の中央値を ±5 で打ち切る(`TIME_INDEX_CLIP`)。中央値は値のある馬の昇順の floor(n/2) 番目
 *   (偶数のときは大きいほう。試算〈#274〉の定義をそのまま写した)。値のある馬が 2 頭未満なら全頭 0、値のない馬は 0。
 * - **prior への入れ方**: raw = 中立確率 + Σ(基礎6 + バイアス7 の補正) + w × 特徴量 を、既存のロジットシフトで正規化する(prior.ts)。
 *   w は `config.baseScore.weights.timeIndex`(既定 0.12。探索の 200 レースで Brier 最小だった約 0.118 を丸めた値)。
 *
 * ## 対象外
 * 今回のレースが地方(NAR)のときは全頭 0(検証したのは中央のレースだけで、地方のレースに中央からの転入馬が数頭いると、
 * その馬たちだけで中央値が作られ、未検証の効き方をするため)。今回が障害のレースでも全頭 0。
 *
 * 基準タイム表は `standard-times.ts`(`scripts/build-standard-times.ts` で生成した定数。D1 を読まない)。
 */

import type { RaceIdVenueKind } from "../scraper/ids.js";
import type { CourseType, HorseRaceResult } from "../scraper/types.js";
import { STANDARD_TIME_TABLE, type StandardTimeTable } from "./standard-times.js";
import type { ScoreContribution } from "./prior.js";

/** 馬の代表値に使う直近走の数(指数が出せた走のうち、新しい順に数える)。 */
export const TIME_INDEX_RECENT_RUNS = 5;

/** 特徴量(代表値 − レース内の中央値)の打ち切り幅(±)。単位は秒/km。 */
export const TIME_INDEX_CLIP = 5;

/** 寄与度ログの項目名。 */
export const TIME_INDEX_NAME = "タイム指数";

/** 馬場の 3 区分(補正の鍵)。 */
export type TimeIndexCondition = "良" | "稍重" | "重・不良";

/** 指数を出す対象のコース種別(障は対象外)。 */
export type TimeIndexCourseType = "芝" | "ダ";

/**
 * `m:ss.f`(例 1:45.9)のタイムを秒にする。読めない形は null。
 * 表の作成(scripts)と指数の計算で同じ規則を使う。
 */
export function parseRaceTimeSec(time: string | null): number | null {
  if (time === null || time === undefined) {
    return null;
  }
  const m = /^(\d+):(\d{2})\.(\d)$/.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10 : null;
}

/**
 * 馬場状態を 3 区分にする: 良 → 良、稍・稍重 → 稍重、重・不・不良 → 重・不良。想定外の値・欠損は null(対象外)。
 * 実データ(中央 33,799 走)の値は 良・稍・重・不 の 4 種類だけ。
 */
export function classifyTimeIndexCondition(trackCondition: string | null): TimeIndexCondition | null {
  if (trackCondition === null || trackCondition === undefined) {
    return null;
  }
  switch (trackCondition.trim()) {
    case "良":
      return "良";
    case "稍":
    case "稍重":
      return "稍重";
    case "重":
    case "不":
    case "不良":
      return "重・不良";
    default:
      return null;
  }
}

/** 1走が指数の対象になるときの、基準の引き方と測定値(表の参照より前の条件だけを見た結果)。 */
export interface TimeIndexRunBasis {
  /** 基準タイム表の鍵: 競馬場|芝ダ|距離。 */
  readonly standardKey: string;
  /** 馬場の補正の鍵: 芝ダ|馬場3区分。 */
  readonly offsetKey: string;
  readonly courseType: TimeIndexCourseType;
  readonly distance: number;
  readonly condition: TimeIndexCondition;
  /** タイム(秒)。 */
  readonly timeSec: number;
}

/**
 * 1走が指数の対象かを、表を引く前の条件だけで判定する(表の作成〈scripts〉と指数の計算で共有する)。
 * 中央・着順が数値・会場名あり・芝かダート・距離が正・タイムが読める・馬場が 3 区分に入る、のすべてを満たすとき非 null。
 */
export function timeIndexRunBasis(r: HorseRaceResult): TimeIndexRunBasis | null {
  if (r.venueKind !== "中央" || r.finishPosition?.kind !== "順位") {
    return null;
  }
  const venueName = r.venue?.name;
  if (!venueName) {
    return null;
  }
  if (r.courseType !== "芝" && r.courseType !== "ダ") {
    return null;
  }
  if (r.distance === null || !(r.distance > 0)) {
    return null;
  }
  const timeSec = parseRaceTimeSec(r.time);
  const condition = classifyTimeIndexCondition(r.trackCondition);
  if (timeSec === null || condition === null) {
    return null;
  }
  return {
    standardKey: `${venueName}|${r.courseType}|${r.distance}`,
    offsetKey: `${r.courseType}|${condition}`,
    courseType: r.courseType,
    distance: r.distance,
    condition,
    timeSec,
  };
}

/** 1走の指数(基準より 1000m あたり何秒速いか)。出せない走は null。 */
export function runTimeIndex(
  r: HorseRaceResult,
  table: StandardTimeTable = STANDARD_TIME_TABLE,
): number | null {
  const basis = timeIndexRunBasis(r);
  if (basis === null) {
    return null;
  }
  const standard = table.standards[basis.standardKey];
  const offset = table.offsets[basis.offsetKey];
  if (standard === undefined || offset === undefined) {
    return null;
  }
  const km = basis.distance / 1000;
  return (standard.median + offset.median * km - basis.timeSec) / km;
}

/** 馬の代表値。`runs` は代表値の対象にした走の数(最大 {@link TIME_INDEX_RECENT_RUNS})。 */
export interface HorseTimeIndex {
  readonly value: number;
  readonly runs: number;
}

/**
 * 馬の代表値 = 指数が出せた走のうち新しい順に 5 つの最高。出せる走が無ければ null。
 * @param results 戦績(新しい順)。
 */
export function horseTimeIndex(
  results: readonly HorseRaceResult[],
  table: StandardTimeTable = STANDARD_TIME_TABLE,
): HorseTimeIndex | null {
  const values: number[] = [];
  for (const r of results) {
    const v = runTimeIndex(r, table);
    if (v !== null) {
      values.push(v);
      if (values.length >= TIME_INDEX_RECENT_RUNS) {
        break;
      }
    }
  }
  if (values.length === 0) {
    return null;
  }
  return { value: Math.max(...values), runs: values.length };
}

/** {@link computeFieldTimeIndexContributions} の今回レースの条件と重み。 */
export interface FieldTimeIndexContext {
  /** 今回のレースの開催区分。"nar" は全頭対象外。 */
  readonly venueKind: RaceIdVenueKind;
  /** 今回のコース種別。"障" は全頭対象外。 */
  readonly courseType: CourseType;
  /** タイム指数の重み w。 */
  readonly weight: number;
}

/** min ≤ x ≤ max にクランプする。 */
function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * レース全頭ぶんのタイム指数の寄与度を返す(入力と同じ並び)。
 *
 * 補正 = w × clamp(代表値 − レース内の中央値, ±5)。`targetRate` に代表値、`overallRate` に中央値を入れる
 * (他の項目の「対象 − 基準」の形に合わせる。違いは ±5 の打ち切りだけ)。
 *
 * @param resultsByHorse 馬ごとの戦績(新しい順)。
 */
export function computeFieldTimeIndexContributions(
  resultsByHorse: readonly (readonly HorseRaceResult[])[],
  ctx: FieldTimeIndexContext,
  table: StandardTimeTable = STANDARD_TIME_TABLE,
): ScoreContribution[] {
  const { weight } = ctx;
  const off = (reason: string): ScoreContribution[] =>
    resultsByHorse.map(() => ({
      biasName: TIME_INDEX_NAME,
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

  const reps = resultsByHorse.map((rs) => horseTimeIndex(rs, table));
  const known = reps.filter((v): v is HorseTimeIndex => v !== null).map((v) => v.value);

  if (known.length < 2) {
    return reps.map((rep) => ({
      biasName: TIME_INDEX_NAME,
      applied: false,
      reason:
        rep === null
          ? "近走に指数を出せる走がなく、レース内で比べられる馬も2頭未満のため補正なし"
          : "指数のある馬がレース内で2頭未満のため補正なし",
      weight,
      correction: 0,
      sampleCount: rep?.runs ?? 0,
      targetRate: rep?.value ?? null,
      overallRate: null,
    }));
  }

  const sorted = known.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return reps.map((rep) => {
    if (rep === null) {
      return {
        biasName: TIME_INDEX_NAME,
        applied: false,
        reason: "近走に指数を出せる走がないため補正なし",
        weight,
        correction: 0,
        sampleCount: 0,
        targetRate: null,
        overallRate: median,
      };
    }
    const x = clamp(rep.value - median, -TIME_INDEX_CLIP, TIME_INDEX_CLIP);
    return {
      biasName: TIME_INDEX_NAME,
      applied: true,
      reason: `近${rep.runs}走の最高指数 ${rep.value.toFixed(2)}秒/km とレース内の中央値 ${median.toFixed(2)} の差(±${TIME_INDEX_CLIP}で打ち切り)で補正`,
      weight,
      correction: weight * x,
      sampleCount: rep.runs,
      targetRate: rep.value,
      overallRate: median,
    };
  });
}
