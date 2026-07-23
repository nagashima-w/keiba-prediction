/**
 * 馬体重トレンド要約(タスク#6・未使用パラメータ活用①)。
 *
 * bodyWeight.diff(前走比の増減)は scorer が既に使用済み(base-score.ts の
 * computeWeightChangeScore、bias-season.ts、bias-transport.ts)。本モジュールは
 * bodyWeight.weight(絶対値)の推移をLLMプロンプト用の中立な材料として要約する
 * プロンプト専用の配線であり、scorer/prior.ts・base-score.ts・bias-*.ts には一切影響しない
 * (2026-07-23 boss着手前ゲート合意・ユーザー確定A/B)。
 *
 * 決定論・ネットワーク/DB非依存の純関数。例外を投げず、材料が無ければ null を返す
 * (turf-wear.ts・same-day-trend.ts と同じ設計方針)。
 *
 * 走数/順は既存の脚質判定(leg-style.ts の ClassifyHorseOptions.recentRuns 既定3)と揃え、
 * 無効走(null・NaN・Infinity)は「直近N走」の消費に数えず、さらに過去へ遡って有効値を探す
 * (summarizePastPaceTendency 等と同じ skip-and-continue 方式)。
 *
 * 傾向ラベル(増加傾向/減少傾向/おおむね安定/変動大)は「有効過去走2走以上」のときだけ算出する
 * (CLAUDE.md「2走未満は傾向断定なし」準拠)。判定は隣接走間の差分に安定バンド(±2kg。
 * netkeibaの馬体重表示・日々の変動誤差として無視できる目安として採用)を適用し、
 * バンド外の符号が一方向のみなら増加/減少傾向、符号が混在(増加と減少が両方現れる)すれば
 * 変動大とする。安定バンド内の差分は「平坦」として符号なし扱いにするため、平坦+一方向の混在は
 * その方向の傾向(増加/減少)のまま、明確な符号反転がある場合のみ変動大に倒す。
 * 断定的な評価語(太め/絞れた/良化/悪化等)・評価指示は一切出力しない(中立な事実のみ)。
 *
 * 当日実測の「前走比」は ShutubaHorse.bodyWeight.diff をスクレイパー側の計算値のまま使い、
 * 本関数では再計算しない。
 */

import type { BodyWeight } from "../scraper/types.js";

/** 馬体重トレンドの傾向ラベル。有効過去走2走以上のときだけ算出する。 */
export type BodyWeightTrendLabel = "増加傾向" | "減少傾向" | "おおむね安定" | "変動大";

/** 当日実測(あれば添える)。 */
export interface BodyWeightTrendToday {
  /** 当日の馬体重(kg)。 */
  readonly 体重: number;
  /** 前走からの増減(kg。ShutubaHorse.bodyWeight.diffをそのまま使う)。 */
  readonly 前走比: number;
}

/** summarizeBodyWeightTrend の出力。常に同じキー構成の構造化オブジェクトに固定する。 */
export interface BodyWeightTrendSummary {
  /**
   * 過去走の有効馬体重(kg)。新しい順、null走・NaN・Infinityの走はスキップして遡って収集
   * (最大 recentRuns 件、既定3)。
   */
  readonly 過去実測: readonly number[];
  /** 傾向ラベル。過去実測が2件以上のときだけ算出、それ未満はnull(断定しない)。 */
  readonly 傾向: BodyWeightTrendLabel | null;
  /** 当日実測(あれば)。過去実測の有無に関わらず独立して出る。無ければnull。 */
  readonly 当日: BodyWeightTrendToday | null;
  /** プロンプトへそのまま載せる中立の材料文(評価語・評価指示は含まない)。 */
  readonly note: string;
}

/** summarizeBodyWeightTrend の任意設定。 */
export interface SummarizeBodyWeightTrendOptions {
  /** 参照する直近走数(既定3)。既存の脚質判定(ClassifyHorseOptions.recentRuns)と揃える。 */
  readonly recentRuns?: number;
}

/** 傾向ラベル判定で「平坦(符号なし)」とみなす隣接走間の差分の絶対値上限(kg)。 */
const STABLE_BAND_KG = 2;

/** 有限数値かどうかを判定する(null・undefined・NaN・Infinity を弾く)。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 過去走(新しい順、null 混在可)から有効な馬体重を最大 recentRuns 件、新しい順に集める。
 * 無効走(null・NaN・Infinity)はスキップし、直近N走の消費には数えない(遡って探す)。
 */
function collectValidPastWeights(
  pastRuns: readonly (BodyWeight | null | undefined)[],
  recentRuns: number,
): number[] {
  const values: number[] = [];
  for (const run of pastRuns) {
    if (values.length >= recentRuns) break;
    const w = run?.weight;
    if (isFiniteNumber(w)) {
      values.push(w);
    }
  }
  return values;
}

/** 当日実測(weight・diff とも有限数値のときだけ有効)を組み立てる。 */
function buildToday(today: BodyWeight | null | undefined): BodyWeightTrendToday | null {
  if (!today) {
    return null;
  }
  if (!isFiniteNumber(today.weight) || !isFiniteNumber(today.diff)) {
    return null;
  }
  return { 体重: today.weight, 前走比: today.diff };
}

/**
 * 有効過去走(新しい順、2件以上)から傾向ラベルを判定する。
 * 隣接走間の差分(古い→新しいの時系列順)を安定バンド(±STABLE_BAND_KG)で符号判定し、
 * 増加(+1)と減少(-1)が両方現れれば「変動大」、片方のみなら該当する傾向、
 * すべて安定バンド内(符号0のみ)なら「おおむね安定」とする。
 */
function classifyTrend(validNewestFirst: readonly number[]): BodyWeightTrendLabel | null {
  if (validNewestFirst.length < 2) {
    return null;
  }
  const chronological = [...validNewestFirst].reverse(); // 古い→新しい。
  let hasIncrease = false;
  let hasDecrease = false;
  for (let i = 1; i < chronological.length; i++) {
    const diff = chronological[i]! - chronological[i - 1]!;
    if (diff > STABLE_BAND_KG) {
      hasIncrease = true;
    } else if (diff < -STABLE_BAND_KG) {
      hasDecrease = true;
    }
  }
  if (hasIncrease && hasDecrease) {
    return "変動大";
  }
  if (hasIncrease) {
    return "増加傾向";
  }
  if (hasDecrease) {
    return "減少傾向";
  }
  return "おおむね安定";
}

/** 前走比(kg)を符号付きテキストにする(0は「±0kg」)。 */
function signedDiffText(diff: number): string {
  if (diff > 0) {
    return `+${diff}kg`;
  }
  if (diff < 0) {
    return `${diff}kg`;
  }
  return "±0kg";
}

/**
 * 過去実測(新しい順)を時系列順(古い→新しい)の「→」区切りテキストにする。
 * 構造化フィールド(過去実測)は「新しい順」だが、note内の表示順は意図的に古→新にしている
 * (例: 454→452→456kg(増加傾向))。左から右に読んだときにトレンドの向きが自然に読めるための
 * 表示専用の並び替えであり、構造化フィールド側の順序仕様(確定ブリーフどおり新しい順)とは
 * 独立した設計判断(code-reviewer提案2、2026-07-23 現状維持で確定)。
 */
function pastWeightsText(
  validNewestFirst: readonly number[],
  trend: BodyWeightTrendLabel | null,
): string {
  const chronological = [...validNewestFirst].reverse();
  const base = `${chronological.join("→")}kg`;
  return trend !== null ? `${base}(${trend})` : base;
}

/**
 * 馬体重トレンド(過去走の絶対値推移+当日実測)を要約する。
 * 有効過去走0件かつ当日実測もなければ null(材料なし)。
 * @param pastRuns 過去走の馬体重(新しい順、null混在可。RaceResultHorse.bodyWeight等をそのまま渡せる)
 * @param today 当日実測(ShutubaHorse.bodyWeight)。未発表・欠損は null
 * @param options 任意設定(recentRuns省略時3)
 */
export function summarizeBodyWeightTrend(
  pastRuns: readonly (BodyWeight | null | undefined)[],
  today: BodyWeight | null | undefined,
  options: SummarizeBodyWeightTrendOptions = {},
): BodyWeightTrendSummary | null {
  const recentRuns = options.recentRuns ?? 3;
  const validPastWeights = collectValidPastWeights(pastRuns, recentRuns);
  const todayInfo = buildToday(today);

  if (validPastWeights.length === 0 && todayInfo === null) {
    return null;
  }

  const trend = classifyTrend(validPastWeights);

  const parts: string[] = [];
  if (validPastWeights.length > 0) {
    parts.push(pastWeightsText(validPastWeights, trend));
  }
  if (todayInfo !== null) {
    parts.push(`当日${todayInfo.体重}kg・前走比${signedDiffText(todayInfo.前走比)}`);
  }

  return {
    過去実測: validPastWeights,
    傾向: trend,
    当日: todayInfo,
    note: parts.join("、"),
  };
}
