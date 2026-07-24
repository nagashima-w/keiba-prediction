/**
 * 過去走の着差(margin)傾向要約(タスク#9・未使用パラメータ活用④)。
 *
 * HorseRaceResult.margin(過去走の着差)はパース済みだが scorer・prompt では未活用
 * (2026-07-23 boss着手前ゲート合意時点で実grep 0件)。本モジュールは着差の大小(僅差/大差)を
 * LLMプロンプト用の中立な材料として要約するプロンプト専用の配線であり、scorer/prior.ts・
 * base-score.ts・bias-*.ts には一切影響しない(prior不変)。
 *
 * 決定論・ネットワーク/DB非依存の純関数。例外を投げず、材料が無ければ null を返す
 * (body-weight-trend.ts・market-gap.ts・jockey-change.ts と同じ設計方針)。
 *
 * 【勝敗分類(ユーザー確定・重要)】着差の符号では勝敗を判定しない。netkeibaの着差は
 * 「着順1着の勝ち(finishPosition.value===1, margin=0)」と「着順2着以下の敗け
 * (finishPosition.value>=2, margin=0)」の両方が実在するため、符号だけでは勝敗を判別できない
 * (boss実データ裏取り済み)。必ず finishPosition(kind==="順位" かつ value===1 で勝ち、
 * value>=2 で敗け)で勝敗を分類し、着差の大小材料には |margin| を使う。
 * netkeibaの着差の実データ傾向として、勝ち走(value===1)は margin が負値or0
 * (|margin|=2着馬=後続への勝ち幅)、敗け走(value>=2)は margin が正値or0
 * (=1つ上の着順の馬との差、隣接馬差)になる。文面は「前の馬と僅差/前の馬に大差」
 * (敗け走・隣接馬差)「後続に○差で勝利」(勝ち走・勝ち幅)のように、netkeibaの着差が
 * 隣接馬差・勝ち幅であるという実際の意味に忠実にし、中位の僅差を「あと少しで勝ち」等と
 * 誤読させない表現にする。
 *
 * 【走数/順・欠損スキップ(skip-and-continue)】走数/順は既存の脚質判定・馬体重トレンド・
 * 人気着順乖離(recentRuns既定3)と揃え、無効走(margin/finishPositionがnull・非数値・NaN・
 * Infinity、finishPosition.kind==="非数値")は「直近N走」の消費に数えず、さらに過去へ遡って
 * 有効値を探す(market-gap.tsと同じ方式)。
 *
 * 【僅差/大差の閾値(実装者裁量・①±2kg/②±0.15と同様の運用。ユーザー確定の目安を採用)】
 * 僅差=|着差|<=0.5、大差=|着差|>=3(0.5は「クビ差程度、僅差と呼べる目安」、3は「大差と
 * 呼べる着差」という一般的な競馬用語の目安として採用。境界値ちょうどはいずれも該当区分に含める
 * 〈僅差=0.5ちょうど、大差=3ちょうどを含む〉)。margin==0(ハナ差の勝ち・着差なしの敗け)は
 * 僅差側に含める(ユーザー確定)。
 *
 * 【傾向ラベル】各有効走を「結果(勝ち/敗け)×区分(僅差/大差/ふつう)」の6分類に振り分け、
 * 有効走2走以上のときだけ、直近recentRuns走の中で最頻の分類を傾向として採用する
 * (CLAUDE.md「2走未満は傾向断定なし」準拠)。最頻分類が複数(同数タイ)の場合は特定の傾向を
 * 断定せず「傾向一定せず」とする。個々の走の事実(勝敗+着差の大小)自体は1走目から出す
 * (単一走の事実比較であり、複数走にまたがる「傾向」の断定ではないため)。
 *
 * 判定語彙は中立事実のみで、評価語(惜敗/展開待ち等)は一切出さない(LLMへの解釈は委任する。
 * #7「人気着順乖離」・#8「乗り替わり」と同じ非破壊optionalの流儀)。
 */

import type { FinishPosition } from "../scraper/types.js";

/** 勝敗区分(finishPositionから判定。着差の符号では判定しない)。 */
export type MarginTrendResult = "勝ち" | "敗け";

/** 着差の大小区分。僅差=|着差|<=0.5、大差=|着差|>=3、それ以外はふつう。 */
export type MarginTrendLevel = "僅差" | "大差" | "ふつう";

/** 有効1走分の構造化データ。 */
export interface MarginTrendRun {
  /** 勝敗区分(finishPositionから判定)。 */
  readonly 結果: MarginTrendResult;
  /**
   * 着差(0以上)。勝ち走は |margin|(=2着馬=後続への勝ち幅)、敗け走は margin
   * (=1つ上の着順の馬との差、隣接馬差)。
   */
  readonly 着差: number;
  /** 着差の大小区分。 */
  readonly 区分: MarginTrendLevel;
}

/** summarizeMarginTrend が返す傾向ラベル。有効走2走以上のときだけ算出する。 */
export type MarginTrendLabel =
  | "僅差の勝ちが多い"
  | "大差の勝ちが多い"
  | "着差ふつうの勝ちが多い"
  | "僅差の敗戦が多い"
  | "大差負けが多い"
  | "着差ふつうの敗戦が多い"
  | "傾向一定せず";

/** summarizeMarginTrend の出力。常に同じキー構成の構造化オブジェクトに固定する。 */
export interface MarginTrendSummary {
  /** 有効走(新しい順、最大 recentRuns 件、既定3)。 */
  readonly 過去走: readonly MarginTrendRun[];
  /** 傾向ラベル。有効走が2件以上のときだけ算出、それ未満はnull(断定しない)。 */
  readonly 傾向: MarginTrendLabel | null;
  /** プロンプトへそのまま載せる中立の材料文(評価語・評価指示は含まない)。 */
  readonly note: string;
}

/** summarizeMarginTrend の任意設定。 */
export interface SummarizeMarginTrendOptions {
  /** 参照する直近走数(既定3)。既存の脚質判定・馬体重トレンド・人気着順乖離と揃える。 */
  readonly recentRuns?: number;
}

/**
 * summarizeMarginTrend に渡す1走分の入力(HorseRaceResult のサブセット)。
 * 新しい順(既存の results/runs 配列と同じ並び)で渡す前提(market-gap.ts の
 * MarketGapPastRun と同じ薄いサブセット方式)。
 */
export interface MarginTrendPastRun {
  /** その走の着順(数値順位 or 非数値種別)。取得できない場合は null。 */
  readonly finishPosition: FinishPosition | null;
  /** その走の着差。取得できない場合は null。 */
  readonly margin: number | null;
}

/** 僅差の閾値(絶対値)。設計根拠はファイル先頭コメント参照。境界値ちょうどは僅差側に含める。 */
const CLOSE_MARGIN_THRESHOLD = 0.5;

/** 大差の閾値(絶対値)。設計根拠はファイル先頭コメント参照。境界値ちょうどは大差側に含める。 */
const BIG_MARGIN_THRESHOLD = 3;

/** 有限数値かどうかを判定する(null・undefined・NaN・Infinity を弾く)。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 着差の絶対値から大小区分を判定する(境界値ちょうどは僅差/大差に含める)。 */
function classifyLevel(absMargin: number): MarginTrendLevel {
  if (absMargin <= CLOSE_MARGIN_THRESHOLD) {
    return "僅差";
  }
  if (absMargin >= BIG_MARGIN_THRESHOLD) {
    return "大差";
  }
  return "ふつう";
}

/**
 * 過去走(新しい順、null混在可)から有効な MarginTrendRun を最大 recentRuns 件、新しい順に集める。
 * 無効走(finishPosition/margin いずれか欠損、finishPosition.kind==="非数値"、NaN・Infinity混入)
 * はスキップし、直近N走の消費には数えない(遡って探す)。
 */
function collectValidRuns(
  pastRuns: readonly (MarginTrendPastRun | null | undefined)[],
  recentRuns: number,
): MarginTrendRun[] {
  const results: MarginTrendRun[] = [];
  for (const run of pastRuns) {
    if (results.length >= recentRuns) break;
    if (!run) continue;
    const { finishPosition, margin } = run;
    if (!finishPosition || finishPosition.kind !== "順位") continue;
    if (!isFiniteNumber(finishPosition.value)) continue;
    if (!isFiniteNumber(margin)) continue;
    const isWin = finishPosition.value === 1;
    const absMargin = Math.abs(margin);
    results.push({
      結果: isWin ? "勝ち" : "敗け",
      着差: absMargin,
      区分: classifyLevel(absMargin),
    });
  }
  return results;
}

/** 「区分の結果」形式の組み合わせキー(例: 「僅差の勝ち」「大差の敗け」)。傾向集計・note組み立ての両方で使う。 */
function combinedCategoryKey(run: MarginTrendRun): string {
  return `${run.区分}の${run.結果}`;
}

/** 組み合わせキーから最終的な傾向ラベル文言(「〜が多い」)への対応表。 */
const TREND_LABEL_BY_CATEGORY: Readonly<Record<string, MarginTrendLabel>> = {
  僅差の勝ち: "僅差の勝ちが多い",
  大差の勝ち: "大差の勝ちが多い",
  ふつうの勝ち: "着差ふつうの勝ちが多い",
  僅差の敗け: "僅差の敗戦が多い",
  大差の敗け: "大差負けが多い",
  ふつうの敗け: "着差ふつうの敗戦が多い",
};

/**
 * 有効走(2件以上)から傾向ラベルを判定する。「結果×区分」の組み合わせキーごとに件数を数え、
 * 最頻のキーが一意に定まればその傾向ラベルを返す。最頻件数が複数キーで並ぶ(タイ)場合は
 * 特定の傾向を断定せず「傾向一定せず」を返す。
 */
function classifyTrend(validRuns: readonly MarginTrendRun[]): MarginTrendLabel {
  const counts = new Map<string, number>();
  for (const run of validRuns) {
    const key = combinedCategoryKey(run);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let maxCount = 0;
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count;
  }
  const topKeys = [...counts.entries()].filter(([, count]) => count === maxCount);
  if (topKeys.length !== 1) {
    return "傾向一定せず";
  }
  return TREND_LABEL_BY_CATEGORY[topKeys[0]![0]]!;
}

/** 1走分の事実を中立文にする(評価語は含まない)。 */
function runFactPhrase(run: MarginTrendRun): string {
  const levelNote = run.区分 !== "ふつう" ? `(${run.区分})` : "";
  if (run.結果 === "勝ち") {
    return `後続に${run.着差}差で勝利${levelNote}`;
  }
  return `前の馬と${run.着差}差の敗戦${levelNote}`;
}

/** 有効走1件のときの事実のみの文(傾向断定なし)。 */
function singleRunText(run: MarginTrendRun): string {
  return `直近1走: ${runFactPhrase(run)}`;
}

/** 有効走2件以上のときの集計文(組み合わせキーごとの回数+傾向ラベル)。 */
function multiRunText(validRuns: readonly MarginTrendRun[], trend: MarginTrendLabel): string {
  const counts = new Map<string, number>();
  for (const run of validRuns) {
    const key = combinedCategoryKey(run);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([key, count]) => `${key}${count}回`);
  return `近${validRuns.length}走で${parts.join("・")}(${trend})`;
}

/**
 * 過去走の着差(margin)傾向を要約する(直近N走・勝敗×着差の大小)。
 * 有効過去走0件なら null(材料なし)。
 * @param pastRuns 過去走の {finishPosition, margin}(新しい順、null混在可。
 *   HorseRaceResult をそのまま渡せる)
 * @param options 任意設定(recentRuns省略時3)
 */
export function summarizeMarginTrend(
  pastRuns: readonly (MarginTrendPastRun | null | undefined)[],
  options: SummarizeMarginTrendOptions = {},
): MarginTrendSummary | null {
  const recentRuns = options.recentRuns ?? 3;
  const validRuns = collectValidRuns(pastRuns, recentRuns);

  if (validRuns.length === 0) {
    return null;
  }

  if (validRuns.length === 1) {
    return { 過去走: validRuns, 傾向: null, note: singleRunText(validRuns[0]!) };
  }

  const trend = classifyTrend(validRuns);
  return { 過去走: validRuns, 傾向: trend, note: multiRunText(validRuns, trend) };
}
