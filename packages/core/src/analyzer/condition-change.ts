/**
 * 条件替わり(妙味材料) — 現レース条件と各馬の過去走から、サーフェス替わり・距離延長/短縮・
 * 中央⇄地方替わりを決定論的に判定する純関数群。
 *
 * 2026-07-19 boss着手前ゲート合意事項:
 * - サーフェス替わり: 前走(有効な直近の芝/ダ走。障はスキップして遡る)のサーフェスと
 *   現サーフェスが異なれば「◯替わり(前走△)」。有効な芝/ダ走が過去に1つも無ければタグなし。
 *   現レースが障ならサーフェスタグ自体を出さない。
 *   enrichment: 替わり かつ 過去にそのサーフェス経験が0のときだけ「初ダート/初芝」と強い語にする
 *   (経験の有無は pastRuns 全体を対象に判定する。直近走の遡りとは独立した分岐)。
 * - 距離延長/短縮: 現距離 −(国内平地〈海外・障を除外〉の直近有効 distance の平均、
 *   窓=DISTANCE_CHANGE_LOOKBACK_RUNS=3。脚質の recentRuns とは独立の名前付き定数)の
 *   絶対値が DISTANCE_CHANGE_THRESHOLD_METERS=400 以上(400ちょうど含む)で延長/短縮と判定する。
 *   窓は「無効走(distance欠損・海外・障)をスキップして遡り、有効走を最大3件集めて平均する」方式
 *   (サーフェス/開催の遡りと同じ skip-and-collect。位置的な3走窓ではない)。1件以上あれば平均する。
 *   閾値比較は生の平均値で行い、表示の実差は Math.round による整数mへの丸め。
 * - 中央⇄地方替わり: 前走(有効な直近国内走。海外はスキップして遡る)の venueKind と
 *   現 venueKind が異なれば 中央→地方/地方→中央。国内走ゼロならタグなし。
 *   過去走の venueKind(scraper VenueKind: "中央"|"地方"|"海外")と現レースの venueKind
 *   (RaceIdVenueKind: "central"|"nar")は語彙が異なるため、本モジュール内部で
 *   中央↔central・地方↔nar のマッピングを行う("海外"は比較不能としてスキップする)。
 * - 新馬(過去走0)・全条件欠損は全タグなしで落とさない。
 * - 複数タグの並び順はサーフェス→距離→開催の固定順。
 *
 * ネットワーク・DB には一切依存しない決定論的な純関数群。
 */

import type { CourseType, VenueKind } from "../scraper/types.js";
import type { RaceIdVenueKind } from "../scraper/ids.js";

/** 距離替わり判定専用の遡り窓(有効走を最大何件集めて平均するか)。脚質の recentRuns とは独立。 */
export const DISTANCE_CHANGE_LOOKBACK_RUNS = 3;

/** 距離延長/短縮と判定する絶対差の閾値(m)。生平均との差がこの値以上(以上を含む)で判定。 */
export const DISTANCE_CHANGE_THRESHOLD_METERS = 400;

/** 条件替わりタグの種別。表示順(サーフェス→距離→開催)の並びと対応する。 */
export type ConditionChangeTagKind = "surface" | "distance" | "venue";

/** 条件替わりタグ1件(表示用ラベル込み)。 */
export interface ConditionChangeTag {
  /** タグ種別。 */
  readonly kind: ConditionChangeTagKind;
  /** 表示テキスト(例: 「ダ替わり(前走芝)」「距離延長(平均比+450m)」「中央→地方」)。 */
  readonly label: string;
}

/**
 * 条件替わり判定に使う1走分の条件(HorseRaceResult のサブセット)。
 * 新しい順(既存の results/runs 配列と同じ並び)で渡す前提。
 */
export interface ConditionChangeRun {
  /** コース種別(芝/ダ/障)。取得できない場合は null。 */
  readonly courseType: CourseType | null;
  /** 距離(m)。取得できない場合は null。 */
  readonly distance: number | null;
  /** 開催区分(中央/地方/海外)。取得できない場合は null。 */
  readonly venueKind: VenueKind | null;
}

/** computeConditionChangeTags の入力。 */
export interface ConditionChangeInput {
  /** 現レースのコース種別。 */
  readonly currentCourseType: CourseType;
  /** 現レースの距離(m)。 */
  readonly currentDistance: number;
  /**
   * 現レースの開催区分(中央/地方)。省略時は開催替わりタグの判定自体をスキップする
   * (サーフェス・距離の判定には影響しない独立ロジック)。
   */
  readonly currentVenueKind?: RaceIdVenueKind;
  /** 過去走(新しい順)。0件(新馬)でもよい。 */
  readonly pastRuns: readonly ConditionChangeRun[];
}

/** scraper VenueKind(中央/地方/海外)→ RaceIdVenueKind(central/nar) のマッピング。海外は比較不能。 */
function toRaceIdVenueKind(venueKind: VenueKind | null): RaceIdVenueKind | null {
  if (venueKind === "中央") return "central";
  if (venueKind === "地方") return "nar";
  return null; // "海外" または null は比較不能。
}

/** RaceIdVenueKind → 表示用の日本語(中央/地方)。 */
function venueKindLabel(venueKind: RaceIdVenueKind): "中央" | "地方" {
  return venueKind === "central" ? "中央" : "地方";
}

/**
 * サーフェス替わりタグを判定する。
 * 前走(有効な直近の芝/ダ走。障はスキップして遡る)のサーフェスと現サーフェスを比較する。
 * 現レースが障、または有効な芝/ダ走が過去に1つも無ければ null(タグなし)。
 */
function computeSurfaceTag(
  currentCourseType: CourseType,
  pastRuns: readonly ConditionChangeRun[],
): ConditionChangeTag | null {
  if (currentCourseType === "障") {
    return null;
  }
  const prevSurface = pastRuns.find(
    (r) => r.courseType === "芝" || r.courseType === "ダ",
  )?.courseType as CourseType | undefined;
  if (prevSurface === undefined || prevSurface === currentCourseType) {
    return null;
  }
  // enrichment: 過去走全体(pastRuns全体)で現サーフェスの経験が0なら「初◯◯」と強い語にする。
  // 基本の替わり判定(上記)とは独立した分岐(専用テストで固定)。
  const hasExperience = pastRuns.some((r) => r.courseType === currentCourseType);
  if (!hasExperience) {
    const label = currentCourseType === "ダ" ? "初ダート" : "初芝";
    return { kind: "surface", label };
  }
  return {
    kind: "surface",
    label: `${currentCourseType}替わり(前走${prevSurface})`,
  };
}

/**
 * 距離延長/短縮タグを判定する。
 * 国内平地(海外・障を除外)の直近有効 distance を、無効走をスキップして遡りながら
 * 最大 DISTANCE_CHANGE_LOOKBACK_RUNS 件集めて平均し、現距離との差(生の値)が
 * DISTANCE_CHANGE_THRESHOLD_METERS 以上(絶対値)なら延長/短縮と判定する。
 * 対象走が1件も無ければ null(タグなし)。
 */
function computeDistanceTag(
  currentDistance: number,
  pastRuns: readonly ConditionChangeRun[],
): ConditionChangeTag | null {
  const validDistances: number[] = [];
  for (const r of pastRuns) {
    if (validDistances.length >= DISTANCE_CHANGE_LOOKBACK_RUNS) break;
    if (r.courseType === "障") continue; // 障は除外。
    if (r.venueKind === "海外") continue; // 海外は除外。
    if (r.distance === null) continue; // 距離欠損はスキップ。
    validDistances.push(r.distance);
  }
  if (validDistances.length === 0) {
    return null;
  }
  const rawAverage =
    validDistances.reduce((sum, d) => sum + d, 0) / validDistances.length;
  const rawDiff = currentDistance - rawAverage;
  if (Math.abs(rawDiff) < DISTANCE_CHANGE_THRESHOLD_METERS) {
    return null;
  }
  const roundedDiff = Math.round(rawDiff);
  const sign = roundedDiff >= 0 ? "+" : "";
  if (roundedDiff > 0) {
    return { kind: "distance", label: `距離延長(平均比${sign}${roundedDiff}m)` };
  }
  return { kind: "distance", label: `距離短縮(平均比${roundedDiff}m)` };
}

/**
 * 中央⇄地方替わりタグを判定する。
 * 前走(有効な直近国内走。海外はスキップして遡る)の venueKind と現 venueKind を比較する。
 * currentVenueKind 未指定、または国内走が過去に1つも無ければ null(タグなし)。
 */
function computeVenueTag(
  currentVenueKind: RaceIdVenueKind | undefined,
  pastRuns: readonly ConditionChangeRun[],
): ConditionChangeTag | null {
  if (currentVenueKind === undefined) {
    return null;
  }
  let prevVenueKind: RaceIdVenueKind | null = null;
  for (const r of pastRuns) {
    const mapped = toRaceIdVenueKind(r.venueKind);
    if (mapped !== null) {
      prevVenueKind = mapped;
      break;
    }
  }
  if (prevVenueKind === null || prevVenueKind === currentVenueKind) {
    return null;
  }
  return {
    kind: "venue",
    label: `${venueKindLabel(prevVenueKind)}→${venueKindLabel(currentVenueKind)}`,
  };
}

/**
 * 条件替わりタグをまとめて算出する(サーフェス→距離→開催の固定順)。
 * 該当なしなら空配列(タグなし)。新馬(pastRuns=[])・全条件欠損でも例外にせず空配列を返す。
 */
export function computeConditionChangeTags(
  input: ConditionChangeInput,
): readonly ConditionChangeTag[] {
  const tags: ConditionChangeTag[] = [];
  const surface = computeSurfaceTag(input.currentCourseType, input.pastRuns);
  if (surface !== null) tags.push(surface);
  const distance = computeDistanceTag(input.currentDistance, input.pastRuns);
  if (distance !== null) tags.push(distance);
  const venue = computeVenueTag(input.currentVenueKind, input.pastRuns);
  if (venue !== null) tags.push(venue);
  return tags;
}
