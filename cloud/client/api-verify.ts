/**
 * 検証の API 呼び出しと応答の分類(Issue #219〈web の検証画面(1)〉)。`GET /api/verify?venue=all|central|nar[&refresh=1]`。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 読む項目の型・範囲(件数は 0 以上の整数、金額・率は有限の数、率は null もある)を満たすときだけ成功。一部だけを採用しない。余計なキー
 * (診断の細目・帯ごとの代表予測値など、この画面が読まないもの)は無視する。Issue #220 で、補正方向×結果・キャリブレーション・印別的中率を読む項目に加えた(群の数・重複・順序は core の契約どおりに検査する)。読む項目のキー名のドリフトは `test/client-api-verify-contract.test.ts` が検出する。
 * Issue #254 で、帯ごとの予測の平均(`meanPredictedProb`)と、補正前〈prior〉で分けたキャリブレーション(`priorCalibration`。補正後と同じ帯数)も読む項目に加えた。
 * Issue #271 で、版別比較の各版に、補正前で分けたキャリブレーション(`priorCalibration`。補正後と同じ帯数)と Brier(`quality`。評価頭数が 0 なら Brier は両方 null)も読む項目に加えた。
 * **サーバの文面は読まない**(失敗は、ステータスと `error.type`〈サーバが決めた固定の識別子〉だけで分類し、固定の文言にする)。
 * 応答の `status`: `ready`(集計。`stale` なら古い)・`preparing`(発走時刻の補完中)・`throttled`(再計算の柵〈最短間隔 5 分・1 日の上限〉に当たっていて、出せる集計が無い。`reason` で区別する〈Issue #254〉)・
 * `not-computed`(**閲覧者にだけ**返る。使える集計がまだ無い。閲覧者の要求は集計のやり直しを起こさないので、管理者が集計するまでこの状態になる。Issue #263)。
 * 閲覧者の `ready` は管理者の `ready` と同じ形で読む(診断は発走時刻の欠落だけ・`stale` は偽・追加指示の全文は `"(非公開)"` に置き換わっている。サーバが落とす)。
 */
import { PREDICTION_MARKS } from "../../packages/core/src/common/prediction-marks";
import { classify, isNum, isRecord, isStr, numOrNull, strOrNull, type ApiFailure, type FetchLike } from "./api";

export type VerifyVenue = "all" | "central" | "nar";

/** 集計が出せないときの柵の種類。 */
export type ThrottleReason = "min-interval" | "daily-limit";

/** 券種別(または合算)の配分ベースの回収率の 1 行。 */
export interface ProposedSummaryView {
  readonly betCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
  readonly unjudgedCount: number;
  /** 取消・除外のため返還として数えた点数と賭け金(Issue #72。`betCount`・`totalStake` に含まれる)。 */
  readonly refundedCount: number;
  readonly refundedStake: number;
  /** 同じ買い目に一律 100 円を賭けた場合の賭け金・払戻・回収率(Issue #16。判定した買い目〈`betCount`〉と同じ集合。賭け金 0 なら回収率は null)。 */
  readonly flatStake: number;
  readonly flatReturn: number;
  readonly flatRecoveryRate: number | null;
}

/** 配分ベースの 8 券種の名前(サーバの `ProposedBetReport` のキー)。 */
export const PROPOSED_BET_TYPES = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
export type ProposedBetType = (typeof PROPOSED_BET_TYPES)[number];

/** キャリブレーションの 1 帯(サーバの `CalibrationBin`)。 */
export interface CalibrationBinView {
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly predictedCount: number;
  readonly placedCount: number;
  readonly actualPlaceRate: number | null;
  /** 帯に入った馬の予測確率の平均(Issue #254。件数 0 は null)。実複勝率の信頼区間に入るかを見る比較対象。 */
  readonly meanPredictedProb: number | null;
}

/** 補正方向の 3 値。 */
export const ADJUSTMENT_DIRECTIONS = ["raised", "lowered", "unchanged"] as const;
export type AdjustmentDirectionView = (typeof ADJUSTMENT_DIRECTIONS)[number];

/** 補正方向×結果の 1 群(サーバの `DirectionGroupStat`)。 */
export interface DirectionGroupView {
  readonly direction: AdjustmentDirectionView;
  readonly count: number;
  readonly actualPlaceRate: number | null;
  readonly averageAdjustment: number | null;
}

/** 予想印(core の `PREDICTION_MARKS` そのもの。Issue #397・R-5 で、ここに持っていた配列を共通部品に寄せた。値は契約テストが固定する)。 */
export const MARKS = PREDICTION_MARKS;
export type MarkView = (typeof MARKS)[number];

/** 印別的中率の 1 群(サーバの `MarkStat`)。`mark` が null は印なし。 */
export interface MarkStatView {
  readonly mark: MarkView | null;
  readonly count: number;
  readonly placeRate: number | null;
  readonly winRate: number | null;
}

/** 画面が読む検証の集計(サーバの `VerifyReport` のうち、画面に出す項目)。 */
export interface VerifyReportView {
  readonly includedAnalysisCount: number;
  readonly excludedAnalysisCount: number;
  readonly supersededAnalysisCount: number;
  readonly excludedEstimatedCount: number;
  readonly excludedLookaheadSuspectCount: number;
  readonly excludedLookaheadUnknownCount: number;
  readonly bet: {
    readonly betCount: number;
    readonly totalStake: number;
    readonly totalReturn: number;
    readonly recoveryRate: number | null;
    readonly actualPayoutCount: number;
    readonly approximatePayoutCount: number;
  };
  /** 推定確率帯ごとのキャリブレーション(補正後〈AI〉の確率で分けたもの。core の帯と同じ順)。 */
  readonly calibration: readonly CalibrationBinView[];
  /** 補正前(統計モデルの事前確率 prior)で分けたキャリブレーション(Issue #254。`calibration` と同じ帯数・同じ順)。 */
  readonly priorCalibration: readonly CalibrationBinView[];
  readonly trend: {
    /** 上げ・下げ・据え置きの 3 群(この順)。 */
    readonly directionGroups: readonly DirectionGroupView[];
    /** 帯ごとの過信バイアス(`calibration` と同じ添字。帯の中央値ベース)。Issue #254 以降、画面は使わない(予測−実績は平均予測ベースでクライアントが出す)。応答の検査だけ残してある。 */
    readonly calibrationBias: readonly { readonly overconfidenceGap: number | null }[];
    /** 印別 6 群+印なし(null)の 7 群。 */
    readonly markStats: readonly MarkStatView[];
  };
  readonly proposedBet: {
    readonly population: { readonly allocated: number; readonly skipped: number; readonly unreached: number; readonly noRecord: number };
    readonly overall: ProposedSummaryView;
    readonly byType: Readonly<Record<ProposedBetType, ProposedSummaryView>>;
    readonly unknownBetType: { readonly count: number; readonly totalStake: number; readonly betTypes: readonly string[] };
  };
}

/** 補正前・補正後の Brier と、求めた馬の数(サーバの `VerifyQuality`。Issue #271)。 */
export interface QualityView {
  readonly evaluatedCount: number;
  readonly priorBrier: number | null;
  readonly adjustedBrier: number | null;
}

/** プロンプト版別の比較の 1 版(サーバの `PromptVersionSummary`。画面が使う項目だけ)。 */
export interface PromptVersionView {
  /** 版。版不明は null。 */
  readonly promptVersion: string | null;
  /** その版で使われた追加指示(全文。なしは null)。 */
  readonly additionalInstructions: readonly (string | null)[];
  readonly includedAnalysisCount: number;
  readonly bet: { readonly betCount: number; readonly totalStake: number; readonly totalReturn: number; readonly recoveryRate: number | null };
  readonly calibration: readonly CalibrationBinView[];
  /** 補正前(統計モデルの確率)で分けた帯(`calibration` と同じ帯数。Issue #271)。 */
  readonly priorCalibration: readonly CalibrationBinView[];
  /** 補正前・補正後の Brier(Issue #271)。 */
  readonly quality: QualityView;
  /** 帯ごとの過信バイアス(`calibration` と同じ長さ・同じ添字。帯の中央値ベース)。Issue #254 以降、画面は使わない。応答の検査だけ残してある。 */
  readonly overconfidenceGaps: readonly (number | null)[];
}

/** 締切直前の再計算との比較の 1 側(サーバの `CloseSummary`。Issue #352)。 */
export interface CloseSummaryView {
  readonly betCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
}

/** 締切直前の再計算との比較の 1 回ぶん(サーバの `CloseRoundComparison`。Issue #352)。 */
export interface CloseRoundView {
  /** 回の番号(1 = 5 分前、2 = 直前)。 */
  readonly round: number;
  /** 行の見出しに添える語(Issue #379。サーバが渡す。「組合せは分析時のオッズ」など。基準が通常の行は null)。同じ回に、基準の違う行が並びうる。 */
  readonly basisLabel: string | null;
  /** 発走の何分前に再計算したか(サーバの定数。直前は暫定値で変わりうる)。 */
  readonly leadMinutes: number;
  /** 集計に入った分析のうち、その回で再計算できた(ok)数。 */
  readonly okCount: number;
  /** 集計に入った分析のうち、その回の行がある(failed・skipped を含む)数。 */
  readonly targetCount: number;
  /** 分析時の配分(再計算できた分析だけ)。 */
  readonly base: CloseSummaryView;
  /** 再計算の配分(同じ分析だけ)。 */
  readonly recalc: CloseSummaryView;
}

/** 締切直前の再計算との比較(サーバの `CloseComparison`。リクエストの区分のもの。Issue #379)。 */
export interface CloseComparisonView {
  /** 節の説明文(サーバが組み立てる。クライアントの束に日本語を置かない)。 */
  readonly description: string;
  readonly rounds: readonly CloseRoundView[];
}

/** 人気帯ごとの期待値と回収率の節の 1 行(サーバが文字列に組み立てて渡す。Issue #384)。項目は名前と値の文字列。 */
export interface BreakdownRowView {
  readonly label: string;
  readonly cells: readonly { readonly name: string; readonly value: string }[];
}
export interface BreakdownSectionView {
  readonly heading: string;
  readonly description: string;
  readonly note: string;
  readonly rows: readonly BreakdownRowView[];
}

export type StaleReason = "backfilling" | "min-interval" | "daily-limit";

export type VerifyOutcome =
  | {
      readonly kind: "ready";
      readonly venue: VerifyVenue;
      readonly report: VerifyReportView;
      /** プロンプト版別の比較(区分に依らず全体。Issue #220)。 */
      readonly promptVersions: readonly PromptVersionView[];
      /** 締切直前の再計算との比較(Issue #352。リクエストの区分のもの〈Issue #379〉)。無い・読めないときは null。 */
      readonly closeComparison: CloseComparisonView | null;
      /** 人気帯ごとの期待値と回収率の節(Issue #384。リクエストの区分のもの)。無い・読めないときは null。 */
      readonly breakdown: readonly BreakdownSectionView[] | null;
      /** 集計した時刻(ISO)。 */
      readonly computedAt: string;
      readonly stale: boolean;
      readonly staleReason: StaleReason | null;
      readonly nextRecomputeAt: string | null;
      /** 発走時刻を確認できなかった分析(`affecting`: そのうち先読み判定が時刻に依るもの)。 */
      readonly startTimeGaps: { readonly lost: number; readonly affecting: number };
    }
  | { readonly kind: "preparing"; readonly remaining: number; readonly blocked: "r2-fence" | "error" | null; readonly resumeAt: string | null }
  /** 再計算の柵に当たって出せる集計が無い。`reason`(Issue #254): `min-interval`=最短間隔〈5 分〉の内側、`daily-limit`=1 日の上限。 */
  | { readonly kind: "throttled"; readonly nextAt: string; readonly reason: ThrottleReason }
  /** 閲覧者に、使える集計がまだ無い(Issue #263)。閲覧者の要求は集計のやり直しを起こさないので、管理者が集計するまで続く。 */
  | { readonly kind: "not-computed" };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isMoney = (v: unknown): v is number => isNum(v) && v >= 0;
const rateOrNull = (v: unknown): v is number | null => v === null || (isNum(v) && v >= 0);

const rate01OrNull = (v: unknown): v is number | null => v === null || (isNum(v) && v >= 0 && v <= 1);

function parseBin(v: unknown): CalibrationBinView | null {
  if (!isRecord(v) || !isNum(v["lowerBound"]) || !isNum(v["upperBound"]) || !isCount(v["predictedCount"]) || !isCount(v["placedCount"]) || !rate01OrNull(v["actualPlaceRate"]) || !rate01OrNull(v["meanPredictedProb"])) return null;
  if (v["lowerBound"] < 0 || v["upperBound"] > 1 || v["upperBound"] <= v["lowerBound"] || v["placedCount"] > v["predictedCount"]) return null;
  // 平均予測値は、予測件数が 0 のときだけ null(core の契約)。
  if ((v["meanPredictedProb"] === null) !== (v["predictedCount"] === 0)) return null;
  return { lowerBound: v["lowerBound"], upperBound: v["upperBound"], predictedCount: v["predictedCount"], placedCount: v["placedCount"], actualPlaceRate: v["actualPlaceRate"], meanPredictedProb: v["meanPredictedProb"] };
}

function parseDirectionGroup(v: unknown): DirectionGroupView | null {
  if (!isRecord(v) || !isStr(v["direction"]) || !(ADJUSTMENT_DIRECTIONS as readonly string[]).includes(v["direction"]) || !isCount(v["count"]) || !rate01OrNull(v["actualPlaceRate"]) || !numOrNull(v["averageAdjustment"])) return null;
  return { direction: v["direction"] as AdjustmentDirectionView, count: v["count"], actualPlaceRate: v["actualPlaceRate"], averageAdjustment: v["averageAdjustment"] };
}

function parseMarkStat(v: unknown): MarkStatView | null {
  if (!isRecord(v) || !isCount(v["count"]) || !rate01OrNull(v["placeRate"]) || !rate01OrNull(v["winRate"])) return null;
  const mark = v["mark"];
  if (mark !== null && !(isStr(mark) && (MARKS as readonly string[]).includes(mark))) return null;
  return { mark: mark as MarkView | null, count: v["count"], placeRate: v["placeRate"], winRate: v["winRate"] };
}

/** 配列の各要素を `parse` に通す。1 つでも通らなければ null。 */
function parseList<T>(v: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** 補正傾向(群の数・重複・順序を core の契約どおりに検査する)。 */
function parseTrend(v: unknown): VerifyReportView["trend"] | null {
  if (!isRecord(v)) return null;
  const directionGroups = parseList(v["directionGroups"], parseDirectionGroup);
  const calibrationBias = parseList(v["calibrationBias"], (item) => (isRecord(item) && numOrNull(item["overconfidenceGap"]) ? { overconfidenceGap: item["overconfidenceGap"] } : null));
  const markStats = parseList(v["markStats"], parseMarkStat);
  if (directionGroups === null || calibrationBias === null || markStats === null) return null;
  // 3 群が 1 つずつ(core は raised・lowered・unchanged の順で必ず 3 件)
  if (directionGroups.map((g) => g.direction).join() !== ADJUSTMENT_DIRECTIONS.join()) return null;
  // 7 群 = 6 つの印+印なし(各 1 つ)
  const marks = markStats.map((m) => m.mark);
  if (markStats.length !== MARKS.length + 1 || new Set(marks).size !== marks.length || !marks.includes(null)) return null;
  return { directionGroups, calibrationBias, markStats };
}

function parseSummary(v: unknown): ProposedSummaryView | null {
  if (!isRecord(v) || !isCount(v["betCount"]) || !isMoney(v["totalStake"]) || !isMoney(v["totalReturn"]) || !rateOrNull(v["recoveryRate"]) || !isCount(v["unjudgedCount"]) || !isCount(v["refundedCount"]) || !isMoney(v["refundedStake"]) || !isMoney(v["flatStake"]) || !isMoney(v["flatReturn"]) || !rateOrNull(v["flatRecoveryRate"])) return null;
  return { betCount: v["betCount"], totalStake: v["totalStake"], totalReturn: v["totalReturn"], recoveryRate: v["recoveryRate"], unjudgedCount: v["unjudgedCount"], refundedCount: v["refundedCount"], refundedStake: v["refundedStake"], flatStake: v["flatStake"], flatReturn: v["flatReturn"], flatRecoveryRate: v["flatRecoveryRate"] };
}

function parseReport(v: unknown): VerifyReportView | null {
  if (!isRecord(v)) return null;
  const counts = ["includedAnalysisCount", "excludedAnalysisCount", "supersededAnalysisCount", "excludedEstimatedCount", "excludedLookaheadSuspectCount", "excludedLookaheadUnknownCount"] as const;
  if (!counts.every((k) => isCount(v[k]))) return null;
  const bet = v["bet"];
  if (!isRecord(bet) || !isCount(bet["betCount"]) || !isMoney(bet["totalStake"]) || !isMoney(bet["totalReturn"]) || !rateOrNull(bet["recoveryRate"]) || !isCount(bet["actualPayoutCount"]) || !isCount(bet["approximatePayoutCount"])) return null;
  const calibration = parseList(v["calibration"], parseBin);
  const priorCalibration = parseList(v["priorCalibration"], parseBin);
  const trend = parseTrend(v["trend"]);
  if (calibration === null || priorCalibration === null || trend === null) return null;
  // 補正前の対応表は補正後と同じ帯構成(Issue #254。画面が同じ表として並べる)
  if (priorCalibration.length !== calibration.length) return null;
  const proposed = v["proposedBet"];
  if (!isRecord(proposed)) return null;
  const population = proposed["population"];
  if (!isRecord(population) || !isCount(population["allocated"]) || !isCount(population["skipped"]) || !isCount(population["unreached"]) || !isCount(population["noRecord"])) return null;
  const overall = parseSummary(proposed["overall"]);
  if (overall === null) return null;
  const byType: Partial<Record<ProposedBetType, ProposedSummaryView>> = {};
  for (const type of PROPOSED_BET_TYPES) {
    const summary = parseSummary(proposed[type]);
    if (summary === null) return null;
    byType[type] = summary;
  }
  const unknown = proposed["unknownBetType"];
  if (!isRecord(unknown) || !isCount(unknown["count"]) || !isMoney(unknown["totalStake"]) || !Array.isArray(unknown["betTypes"]) || !unknown["betTypes"].every(isStr)) return null;
  return {
    includedAnalysisCount: v["includedAnalysisCount"] as number,
    excludedAnalysisCount: v["excludedAnalysisCount"] as number,
    supersededAnalysisCount: v["supersededAnalysisCount"] as number,
    excludedEstimatedCount: v["excludedEstimatedCount"] as number,
    excludedLookaheadSuspectCount: v["excludedLookaheadSuspectCount"] as number,
    excludedLookaheadUnknownCount: v["excludedLookaheadUnknownCount"] as number,
    bet: { betCount: bet["betCount"], totalStake: bet["totalStake"], totalReturn: bet["totalReturn"], recoveryRate: bet["recoveryRate"], actualPayoutCount: bet["actualPayoutCount"], approximatePayoutCount: bet["approximatePayoutCount"] },
    calibration,
    priorCalibration,
    trend,
    proposedBet: {
      population: { allocated: population["allocated"], skipped: population["skipped"], unreached: population["unreached"], noRecord: population["noRecord"] },
      overall,
      byType: byType as Record<ProposedBetType, ProposedSummaryView>,
      unknownBetType: { count: unknown["count"], totalStake: unknown["totalStake"], betTypes: unknown["betTypes"] as string[] },
    },
  };
}

/** Brier は 0〜1。評価した馬が 0 頭なら、どちらも null(求められないものを 0 と読ませない)。 */
function parseQuality(v: unknown): QualityView | null {
  if (!isRecord(v) || !isCount(v["evaluatedCount"]) || !rate01OrNull(v["priorBrier"]) || !rate01OrNull(v["adjustedBrier"])) return null;
  if (v["evaluatedCount"] === 0 && (v["priorBrier"] !== null || v["adjustedBrier"] !== null)) return null;
  return { evaluatedCount: v["evaluatedCount"], priorBrier: v["priorBrier"], adjustedBrier: v["adjustedBrier"] };
}

function parsePromptVersion(v: unknown): PromptVersionView | null {
  if (!isRecord(v) || !strOrNull(v["promptVersion"]) || !isCount(v["includedAnalysisCount"])) return null;
  const instructions = v["additionalInstructions"];
  if (!Array.isArray(instructions) || !instructions.every(strOrNull)) return null;
  const bet = v["bet"];
  if (!isRecord(bet) || !isCount(bet["betCount"]) || !isMoney(bet["totalStake"]) || !isMoney(bet["totalReturn"]) || !rateOrNull(bet["recoveryRate"])) return null;
  const calibration = parseList(v["calibration"], parseBin);
  const priorCalibration = parseList(v["priorCalibration"], parseBin);
  const quality = parseQuality(v["quality"]);
  const gaps = parseList(v["overconfidenceGaps"], (g) => (numOrNull(g) ? { gap: g } : null));
  if (calibration === null || priorCalibration === null || quality === null || gaps === null || gaps.length !== calibration.length || priorCalibration.length !== calibration.length) return null;
  return {
    promptVersion: v["promptVersion"],
    additionalInstructions: instructions as (string | null)[],
    includedAnalysisCount: v["includedAnalysisCount"],
    bet: { betCount: bet["betCount"], totalStake: bet["totalStake"], totalReturn: bet["totalReturn"], recoveryRate: bet["recoveryRate"] },
    calibration,
    priorCalibration,
    quality,
    overconfidenceGaps: gaps.map((g) => g.gap),
  };
}

/** 版別比較(版は重複しない。並びはサーバのまま)。 */
function parsePromptVersions(v: unknown): PromptVersionView[] | null {
  const list = parseList(v, parsePromptVersion);
  if (list === null || new Set(list.map((x) => x.promptVersion)).size !== list.length) return null;
  return list;
}

function parseCloseSummary(v: unknown): CloseSummaryView | null {
  if (!isRecord(v) || !isCount(v["betCount"]) || !isMoney(v["totalStake"]) || !isMoney(v["totalReturn"]) || !rateOrNull(v["recoveryRate"])) return null;
  return { betCount: v["betCount"], totalStake: v["totalStake"], totalReturn: v["totalReturn"], recoveryRate: v["recoveryRate"] };
}

function parseCloseRound(v: unknown): CloseRoundView | null {
  if (!isRecord(v) || !isCount(v["round"]) || v["round"] < 1 || !isNum(v["leadMinutes"]) || v["leadMinutes"] <= 0 || !isCount(v["okCount"]) || !isCount(v["targetCount"]) || v["okCount"] > v["targetCount"]) return null;
  const base = parseCloseSummary(v["base"]);
  const recalc = parseCloseSummary(v["recalc"]);
  if (base === null || recalc === null) return null;
  if (!strOrNull(v["basisLabel"])) return null;
  return { round: v["round"], basisLabel: v["basisLabel"], leadMinutes: v["leadMinutes"], okCount: v["okCount"], targetCount: v["targetCount"], base, recalc };
}

/**
 * 締切直前の再計算との比較(Issue #352)。**無い(旧い集計・旧い Worker)・null・壊れている値は、いずれも null(比較なし)**:
 * 補助の節なので、この節の不整合で応答全体(本体の検証)を捨てない(`promptVersions` と違い、応答全体を unexpected にしない)。
 * 行は 1 つ以上で、(回, 見出しの語)が重複しない(同じ回に基準の違う行が並びうる。Issue #379)。説明文は 1000 字以内。
 */
function parseCloseComparison(v: unknown): CloseComparisonView | null {
  if (!isRecord(v) || !isStr(v["description"]) || v["description"].length > 1000) return null;
  const rounds = parseList(v["rounds"], parseCloseRound);
  if (rounds === null || rounds.length === 0 || new Set(rounds.map((r) => `${r.round}:${r.basisLabel}`)).size !== rounds.length) return null;
  return { description: v["description"], rounds };
}

const isText = (v: unknown, max: number): v is string => isStr(v) && v.length <= max;

function parseBreakdownRow(v: unknown): BreakdownRowView | null {
  if (!isRecord(v) || !isText(v["label"], 100) || !Array.isArray(v["cells"]) || v["cells"].length > 12) return null;
  const cells = parseList(v["cells"], (c) => (isRecord(c) && isText(c["name"], 100) && isText(c["value"], 100) ? { name: c["name"], value: c["value"] } : null));
  return cells === null ? null : { label: v["label"], cells };
}

function parseBreakdownSection(v: unknown): BreakdownSectionView | null {
  if (!isRecord(v) || !isText(v["heading"], 100) || !isText(v["description"], 1000) || !isText(v["note"], 1000) || !Array.isArray(v["rows"]) || v["rows"].length > 50) return null;
  const rows = parseList(v["rows"], parseBreakdownRow);
  return rows === null ? null : { heading: v["heading"], description: v["description"], note: v["note"], rows };
}

/**
 * 人気帯ごとの期待値と回収率(Issue #384)。**無い(旧い集計・旧い Worker)・null・壊れている値は、いずれも null(内訳なし)**: 補助の節なので、この節の不整合で応答全体を捨てない。
 * 節は 1〜8 個。文字列の長さの上限は、サーバが組み立てる文の長さに余裕を持たせたもの(契約テストが、本物のサーバの出力が収まることを固定している)。
 */
function parseBreakdown(v: unknown): BreakdownSectionView[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 8) return null;
  return parseList(v, parseBreakdownSection);
}

const VENUES: ReadonlySet<string> = new Set<VerifyVenue>(["all", "central", "nar"]);
const STALE_REASONS: ReadonlySet<string> = new Set<StaleReason>(["backfilling", "min-interval", "daily-limit"]);

/** 応答の本文を検査して結果を作る。満たさなければ null。 */
export function parseVerifyResponse(body: unknown): VerifyOutcome | null {
  if (!isRecord(body) || body["ok"] !== true) return null;
  const status = body["status"];
  if (status === "not-computed") {
    return { kind: "not-computed" };
  }
  if (status === "throttled") {
    const reason = body["reason"];
    return isStr(body["nextAt"]) && (reason === "min-interval" || reason === "daily-limit") ? { kind: "throttled", nextAt: body["nextAt"], reason } : null;
  }
  if (status === "preparing") {
    const blocked = body["blocked"];
    if (!isCount(body["remaining"]) || (blocked !== null && blocked !== "r2-fence" && blocked !== "error") || !strOrNull(body["resumeAt"])) return null;
    return { kind: "preparing", remaining: body["remaining"], blocked, resumeAt: body["resumeAt"] };
  }
  if (status !== "ready") return null;
  const venue = body["venue"];
  const reason = body["staleReason"];
  const diag = body["diag"];
  if (!isStr(venue) || !VENUES.has(venue) || !isStr(body["computedAt"]) || typeof body["stale"] !== "boolean" || !strOrNull(body["nextRecomputeAt"])) return null;
  if (reason !== null && (!isStr(reason) || !STALE_REASONS.has(reason))) return null;
  if (!isRecord(diag) || !isRecord(diag["startTimeGaps"]) || !isCount(diag["startTimeGaps"]["lost"]) || !isCount(diag["startTimeGaps"]["affecting"])) return null;
  const report = parseReport(body["report"]);
  const promptVersions = parsePromptVersions(body["promptVersions"]);
  if (report === null || promptVersions === null) return null;
  return {
    kind: "ready",
    venue: venue as VerifyVenue,
    report,
    promptVersions,
    closeComparison: parseCloseComparison(body["closeComparison"]),
    breakdown: parseBreakdown(body["breakdown"]),
    computedAt: body["computedAt"],
    stale: body["stale"],
    staleReason: reason as StaleReason | null,
    nextRecomputeAt: body["nextRecomputeAt"],
    startTimeGaps: { lost: diag["startTimeGaps"]["lost"], affecting: diag["startTimeGaps"]["affecting"] },
  };
}

export type VerifyFetchResult = { readonly ok: true; readonly outcome: VerifyOutcome } | { readonly ok: false; readonly error: ApiFailure };

/** `GET /api/verify`。例外(同期・非同期とも)は network にする(例外の文面は持ち込まない)。`refresh` は再計算の要求(サーバの最短間隔・1 日の上限は守られる)。 */
export async function fetchVerify(fetchLike: FetchLike, venue: VerifyVenue, refresh: boolean): Promise<VerifyFetchResult> {
  const query = `venue=${venue}${refresh ? "&refresh=1" : ""}`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike(`/api/verify?${query}`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.status !== 200) {
    const failure = classify(response.status, body);
    return { ok: false, error: failure.kind === "netkeiba-unavailable" ? { kind: "server-error" } : failure };
  }
  const outcome = parseVerifyResponse(body);
  return outcome === null ? { ok: false, error: { kind: "unexpected", httpStatus: 200 } } : { ok: true, outcome };
}

/**
 * 取得の失敗の固定の文言(サーバの文面は含めない)。`canRefresh`(Issue #263): 「更新」ボタンがあるか。閲覧者には無いので、存在しないボタンを案内せず、再読み込みを案内する。
 */
export function verifyFetchFailureMessage(failure: ApiFailure, canRefresh = true): string {
  if (!canRefresh) {
    switch (failure.kind) {
      case "forbidden":
      case "origin-mismatch":
        return "検証を取得できませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
      case "network":
        return "検証の取得の通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みしてください。";
      case "server-error":
      case "netkeiba-unavailable":
        return "検証を取得できませんでした。サーバでエラーが起きました。少し待ってから、ページを再読み込みしてください。";
      case "bad-request":
      case "not-found":
      case "unexpected":
        return `検証の応答が想定外でした${failure.kind === "unexpected" ? `(HTTP ${failure.httpStatus})` : ""}。少し待ってから、ページを再読み込みしてください。`;
    }
  }
  switch (failure.kind) {
    case "forbidden":
    case "origin-mismatch":
      return "検証を取得できませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "network":
      return "検証の取得の通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みするか、「更新」でもう一度取得してください。";
    case "server-error":
    case "netkeiba-unavailable":
      return "検証を取得できませんでした。サーバでエラーが起きました。少し待ってから「更新」を押してください。";
    case "bad-request":
    case "not-found":
    case "unexpected":
      return `検証の応答が想定外でした${failure.kind === "unexpected" ? `(HTTP ${failure.httpStatus})` : ""}。少し待ってから「更新」を押してください。`;
  }
}
