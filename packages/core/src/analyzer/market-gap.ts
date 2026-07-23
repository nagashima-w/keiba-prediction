/**
 * 過去走の人気・着順の乖離要約(タスク#7・未使用パラメータ活用②)。
 *
 * HorseRaceResult.ninki(過去走の人気)/finishPosition(着順)/entryCount(頭数)は
 * パース済みだが scorer・prompt では未活用(2026-07-23 boss着手前ゲート合意時点で実grep 0件)。
 * 本モジュールは「市場評価(人気)と結果(着順)の乖離」をLLMプロンプト用の中立な材料として
 * 要約するプロンプト専用の配線であり、scorer/prior.ts・base-score.ts・bias-*.ts には
 * 一切影響しない(当日オッズ〈PromptHorse.winOdds/popularity〉にも波及しない。②は過去走由来で別軸)。
 *
 * 決定論・ネットワーク/DB非依存の純関数。例外を投げず、材料が無ければ null を返す
 * (body-weight-trend.ts・turf-wear.ts・same-day-trend.ts と同じ設計方針)。
 *
 * 走数/順は既存の脚質判定・馬体重トレンド(recentRuns既定3)と揃え、無効走は「直近N走」の
 * 消費に数えず、さらに過去へ遡って有効値を探す(skip-and-continue方式)。
 *
 * 【正規化と乖離判定の設計(実装者裁量。①の±2kgノイズ床と同じ運用。レビューで妥当性検証)】
 * 人気(ninki)・着順(finishPosition.value)は、それぞれその走の頭数(entryCount)で
 * 0(最上位: 1番人気/1着)〜1(最下位人気/最下位着順)の相対順位に正規化する
 * (相対人気=(ninki-1)/(entryCount-1)、相対着順=(value-1)/(entryCount-1))。
 * 差(相対人気-相対着順)が正なら着順が人気より良い(人気を上回る着順)、負なら悪い
 * (人気を下回る着順)。差の絶対値が RANK_GAP_BAND(0.15)以内は「人気相応の着順」とする
 * (妥当帯)。0.15は「頭数-1のうち約15%の順位変動は、展開のあや・詰まり等の許容誤差」という
 * 目安として採用し、頭数が多いレースほど絶対的な着順差の許容幅が広がる(例: 21頭立てなら
 * 生の着順差3つ分まで妥当帯、10頭立てなら生の着順差1.35つ分まで)。これは②が要求する
 * 「頭数で正規化必須」の効果を体現する(同じ生の着順差でも頭数が違えば判定が変わる)。
 *
 * 判定語彙は中立事実のみで、評価語(妙味/過小評価/買い/期待等)は一切出さない
 * (LLMへの解釈は委任する。CLAUDE.md・#19「条件替わり」と同じ非破壊optionalの流儀)。
 *
 * 傾向ラベル(人気を上回る着順が多い/下回る着順が多い/人気相応〈差なし〉)は「有効過去走2走以上」
 * のときだけ算出する(CLAUDE.md「2走未満は傾向断定なし」準拠)。各有効走ごとの判定
 * (人気を上回る/下回る/相応の着順)自体は1走目から出す(単一走の事実比較であり、複数走に
 * またがる「傾向」の断定ではないため)。
 *
 * 降着(demoted)は finishPosition.value(確定着順)をそのまま有効着順として使用する
 * (FinishPosition型の設計どおり。demotedフラグの有無で判定を変えない)。
 */

import type { FinishPosition } from "../scraper/types.js";

/** 1走分の人気・着順の乖離判定。中立事実のみ(評価語は含まない)。 */
export type MarketGapJudgement =
  | "人気を上回る着順"
  | "人気を下回る着順"
  | "人気相応の着順";

/** 有効1走分の構造化データ。 */
export interface MarketGapRun {
  /** その走の人気。 */
  readonly 人気: number;
  /** その走の着順(降着ありは確定着順の value)。 */
  readonly 着順: number;
  /** その走の頭数。 */
  readonly 頭数: number;
  /** 人気・着順を頭数で正規化して比較した判定。 */
  readonly 判定: MarketGapJudgement;
}

/** summarizeMarketGap が返す傾向ラベル。有効過去走2走以上のときだけ算出する。 */
export type MarketGapTrendLabel =
  | "人気を上回る着順が多い"
  | "人気を下回る着順が多い"
  | "人気相応(差なし)";

/** summarizeMarketGap の出力。常に同じキー構成の構造化オブジェクトに固定する。 */
export interface MarketGapSummary {
  /** 有効走(新しい順、最大 recentRuns 件、既定3)。 */
  readonly 過去走: readonly MarketGapRun[];
  /** 傾向ラベル。過去走が2件以上のときだけ算出、それ未満はnull(断定しない)。 */
  readonly 傾向: MarketGapTrendLabel | null;
  /** プロンプトへそのまま載せる中立の材料文(評価語・評価指示は含まない)。 */
  readonly note: string;
}

/** summarizeMarketGap の任意設定。 */
export interface SummarizeMarketGapOptions {
  /** 参照する直近走数(既定3)。既存の脚質判定・馬体重トレンドと揃える。 */
  readonly recentRuns?: number;
}

/**
 * summarizeMarketGap に渡す1走分の入力(HorseRaceResult のサブセット)。
 * 新しい順(既存の results/runs 配列と同じ並び)で渡す前提(condition-change.ts の
 * ConditionChangeRun と同じ薄いサブセット方式)。
 */
export interface MarketGapPastRun {
  /** その走の人気。取得できない場合は null。 */
  readonly ninki: number | null;
  /** その走の着順(数値順位 or 非数値種別)。取得できない場合は null。 */
  readonly finishPosition: FinishPosition | null;
  /** その走の頭数。取得できない場合は null。 */
  readonly entryCount: number | null;
}

/** 妥当帯(相対順位差の許容幅)。設計根拠はファイル先頭コメント参照。 */
const RANK_GAP_BAND = 0.15;

/**
 * 浮動小数点の丸め誤差を吸収する微小値。(ninki-1)/(entryCount-1) 等の除算結果は
 * 2進浮動小数点で厳密に表現できない場合があり(例: 9/20 - 6/20 が 0.15000000000000002 になる)、
 * 境界値ちょうど(妥当帯側)の判定がentryCountの値によって不安定にならないようにする。
 */
const EPSILON = 1e-9;

/** 有限数値かどうかを判定する(null・undefined・NaN・Infinity を弾く)。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 人気・着順・頭数から乖離判定を行う(呼び出し前提: entryCount は2以上の有限数値)。
 * 相対人気・相対着順はいずれも0(最上位)〜1(最下位)。差の絶対値が RANK_GAP_BAND 以内は
 * 「人気相応の着順」(妥当帯。境界値ちょうどは妥当帯側に含める)。
 */
function judgeRun(ninki: number, value: number, entryCount: number): MarketGapJudgement {
  const relativeNinki = (ninki - 1) / (entryCount - 1);
  const relativeFinish = (value - 1) / (entryCount - 1);
  const gap = relativeNinki - relativeFinish;
  if (gap > RANK_GAP_BAND + EPSILON) {
    return "人気を上回る着順";
  }
  if (gap < -RANK_GAP_BAND - EPSILON) {
    return "人気を下回る着順";
  }
  return "人気相応の着順";
}

/**
 * 過去走(新しい順、null混在可)から有効な MarketGapRun を最大 recentRuns 件、新しい順に集める。
 * 無効走(ninki/finishPosition/entryCountいずれか欠損、finishPosition.kind==="非数値"、
 * entryCount<2、NaN・Infinity混入)はスキップし、直近N走の消費には数えない(遡って探す)。
 */
function collectValidRuns(
  pastRuns: readonly (MarketGapPastRun | null | undefined)[],
  recentRuns: number,
): MarketGapRun[] {
  const results: MarketGapRun[] = [];
  for (const run of pastRuns) {
    if (results.length >= recentRuns) break;
    if (!run) continue;
    const { ninki, finishPosition, entryCount } = run;
    if (!isFiniteNumber(ninki)) continue;
    if (!isFiniteNumber(entryCount) || entryCount < 2) continue;
    if (!finishPosition || finishPosition.kind !== "順位") continue;
    const value = finishPosition.value;
    if (!isFiniteNumber(value)) continue;
    results.push({
      人気: ninki,
      着順: value,
      頭数: entryCount,
      判定: judgeRun(ninki, value, entryCount),
    });
  }
  return results;
}

/** 有効走の判定内訳(件数)。 */
interface JudgementCounts {
  readonly overCount: number;
  readonly underCount: number;
  readonly evenCount: number;
}

/** 有効走の判定(人気を上回る/下回る/相応)ごとの件数を数える。 */
function countJudgements(validRuns: readonly MarketGapRun[]): JudgementCounts {
  let overCount = 0;
  let underCount = 0;
  for (const r of validRuns) {
    if (r.判定 === "人気を上回る着順") overCount++;
    else if (r.判定 === "人気を下回る着順") underCount++;
  }
  return { overCount, underCount, evenCount: validRuns.length - overCount - underCount };
}

/**
 * 有効走(新しい順、2件以上)から傾向ラベルを判定する。
 * 「人気を上回る着順」の回数と「人気を下回る着順」の回数を比較し、多い方の傾向を返す。
 * 同数(0対0の全妥当帯を含む)なら「人気相応(差なし)」とする。
 */
function classifyTrend(counts: JudgementCounts): MarketGapTrendLabel {
  if (counts.overCount > counts.underCount) {
    return "人気を上回る着順が多い";
  }
  if (counts.underCount > counts.overCount) {
    return "人気を下回る着順が多い";
  }
  return "人気相応(差なし)";
}

/** 有効走1件のときの事実のみの文(傾向断定なし)。 */
function singleRunText(run: MarketGapRun): string {
  return `直近1走: ${run.頭数}頭中${run.人気}番人気で${run.着順}着(${run.判定})`;
}

/** 有効走2件以上のときの集計文(各判定の回数+傾向ラベル)。 */
function multiRunText(validRuns: readonly MarketGapRun[], counts: JudgementCounts, trend: MarketGapTrendLabel): string {
  const base = `近${validRuns.length}走で人気を上回る着順${counts.overCount}回・下回る着順${counts.underCount}回・相応${counts.evenCount}回`;
  return `${base}(${trend})`;
}

/**
 * 過去走の人気・着順の乖離を要約する(直近N走・頭数で正規化した相対順位の比較)。
 * 有効過去走0件なら null(材料なし)。
 * @param pastRuns 過去走の {ninki, finishPosition, entryCount}(新しい順、null混在可。
 *   HorseRaceResult をそのまま渡せる)
 * @param options 任意設定(recentRuns省略時3)
 */
export function summarizeMarketGap(
  pastRuns: readonly (MarketGapPastRun | null | undefined)[],
  options: SummarizeMarketGapOptions = {},
): MarketGapSummary | null {
  const recentRuns = options.recentRuns ?? 3;
  const validRuns = collectValidRuns(pastRuns, recentRuns);

  if (validRuns.length === 0) {
    return null;
  }

  if (validRuns.length === 1) {
    return { 過去走: validRuns, 傾向: null, note: singleRunText(validRuns[0]!) };
  }

  const counts = countJudgements(validRuns);
  const trend = classifyTrend(counts);
  return {
    過去走: validRuns,
    傾向: trend,
    note: multiRunText(validRuns, counts, trend),
  };
}
