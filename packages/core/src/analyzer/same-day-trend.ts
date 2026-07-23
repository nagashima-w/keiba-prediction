/**
 * 当日レース結果の傾向を要約する集計純関数(タスク#27-B)。
 *
 * 呼び出し側(C)が「同一場・同一面(芝/ダ)・確定済み」に絞り込んだレース結果配列
 * (readonly RaceResult[])を1回の呼び出しで1面分として受け取り、脚質傾向・内外傾向・
 * 上がり傾向を構造化オブジェクトとして返す決定論的な純関数。ネットワークアクセスは行わない。
 * 文字列化(プロンプトへの反映、芝/ダ各1〜2行への整形)は行わない(Cの責務)。
 *
 * 絞り込み(同一場・同一面・確定済み)自体はCの責務であり本関数では行わない。なお
 * RaceResult/RaceResultHorse には面(芝/ダ/障害)を示すフィールドが無く、本関数からは
 * 障害レースの混入を検出できない。仮に混入しても、通過順・上がり3Fなどの欠損耐性により
 * 例外を投げず null/データ不足側に倒れる(2026-07-22 boss着手前ゲート合意)。
 *
 * 決定論ルール(boss合意の確認項目1・2):
 *   1. 面集計方式: 複勝圏内馬を全レース横断でプール(単純平均)する。「判定割れ」概念は
 *      持ち込まず、プール平均が中立バンドに入れば内外傾向は null に一本化する。
 *   2. 上がり傾向(案A): 各レース内で自己参照的に判定する。「相対的に速い(上位)」は
 *      そのレースの全馬(複勝圏内に限らない)の上がり3F平均より速いかで判定し、
 *      「後方脚質(相対位置後ろめ)」は脚質傾向と同じ閾値(0.6)を個々の馬の相対位置に
 *      適用して判定する。両方を満たす複勝圏内馬の比率が過半数なら
 *      「差し・上がり優勢の示唆」、そうでなければ「顕著な傾向なし」。絶対タイム閾値は使わない。
 *
 * タスク#27-C(当日傾向をプロンプトに反映する配線。2026-07-23 boss着手前ゲート合意・案b' widening):
 * summarizeSameDayTrend の引数型は、実際に読む4フィールド(umaban/finishPosition/passing/last3f)
 * だけの構造的最小インターフェース SameDayTrendRace へ広げてある(RaceResult[] はこの上位型に
 * 構造的に代入可能なため、#27-Bの既存テストは本widening後も無改変で緑になる)。
 * さらに、当日・同一場・同一面の確定済みレース結果からこの入力を組み立てる収集ヘルパー
 * collectSameDayTrend をこのファイルに併設する(兄弟レースID列挙は scraper/ids.ts の
 * siblingRaceIdsSameDay に委譲)。呼び出し側(app/analysis-pipeline.ts)は、注入した
 * getRaceResultDetail をそのまま collectSameDayTrend の lookup として渡すだけでよい。
 */

import { isPlaced } from "../scorer/derive-features.js";
import { siblingRaceIdsSameDay, type RaceId } from "../scraper/ids.js";
import type { CourseType, FinishPosition } from "../scraper/types.js";
import { classifyRunLegStyleFull } from "./leg-style.js";

/**
 * 脚質傾向(前残り優勢/差し優勢/顕著な傾向なし/データ不足)。
 * 他の2指標と異なり null を持たず、必ずこの4値のいずれかを返す。
 */
export type PaceLeaningTrend = "前残り優勢" | "差し優勢" | "顕著な傾向なし" | "データ不足";

/** 内外傾向。中立バンド・母数不足は null(非表示)。 */
export type InOutTrend = "内有利" | "外有利";

/**
 * 上がり傾向(補助的・過剰断定しない語彙)。判定不可は null。
 * last3f・passing の欠損が多いレース群では判定に使える実効サンプル数(closingHitsの母数)が
 * 脚質傾向・内外傾向より小さくなりやすく、あくまで参考程度の指標である点に留意する
 * (UI/プロンプトでの明示的な信頼度表示等はCの責務・別タスク)。
 */
export type ClosingTrend = "差し・上がり優勢の示唆" | "顕著な傾向なし";

/** 集計対象のサンプル数。閾値の成否や各指標のnull有無に関わらず実数を返す。 */
export interface SameDayTrendSampleSize {
  /** 入力配列に含まれるレース数(呼び出し側が既に「同一場・同一面・確定済み」に絞り込み済み)。 */
  readonly レース数: number;
  /** 集計対象になった複勝圏内(3着以内、降着は確定着順)馬の延べ頭数。 */
  readonly 複勝圏内馬数: number;
}

/** summarizeSameDayTrend の出力。常に同じキー構成の構造化オブジェクトに固定する。 */
export interface SameDayTrendSummary {
  readonly 脚質傾向: PaceLeaningTrend;
  readonly 内外傾向: InOutTrend | null;
  readonly 上がり傾向: ClosingTrend | null;
  readonly サンプル数: SameDayTrendSampleSize;
}

/**
 * summarizeSameDayTrend が受け取る1レース分の構造的最小インターフェース(タスク#27-C・案b' widening)。
 * 実際に読む4フィールド(umaban/finishPosition/passing/last3f)だけに絞ってあり、
 * scraper/types.ts の RaceResult はこの上位型に構造的に代入可能(RaceResult[] をそのまま渡せる)。
 * finishPosition は isPlaced が直接読む FinishPosition|null のまま維持し、horseName・wakuban 等の
 * 偽値(プレースホルダ)は一切導入しない。
 */
export interface SameDayTrendRace {
  readonly horses: readonly SameDayTrendRaceHorse[];
}

/** SameDayTrendRace の1頭分(集計に使う4フィールドのみ)。 */
export interface SameDayTrendRaceHorse {
  readonly umaban: number;
  readonly finishPosition: FinishPosition | null;
  readonly passing: readonly number[];
  readonly last3f: number | null;
}

/** 集計に必要な最小レース数(面ごと独立の閾値2)。これ未満は全体を「データ不足」とする。 */
const MIN_RACE_COUNT = 2;

/** 脚質傾向: プール平均の相対位置(r)がこれ以下なら前残り優勢。 */
const LEG_STYLE_FRONT_MAX = 0.4;
/** 脚質傾向: プール平均の相対位置(r)がこれ以上なら差し優勢。 */
const LEG_STYLE_BACK_MIN = 0.6;

/** 内外傾向: プール平均の馬番相対(umaban/頭数)がこれ以下なら内有利。 */
const IN_OUT_INNER_MAX = 0.4;
/** 内外傾向: プール平均の馬番相対(umaban/頭数)がこれ以上なら外有利。 */
const IN_OUT_OUTER_MIN = 0.6;

/**
 * 上がり傾向(案A)の「後方脚質」判定に使う相対位置の閾値。脚質傾向の差し優勢と同じ 0.6 を
 * 再利用し、モジュール内の「後ろめ」の基準を一貫させる。ただし脚質傾向はプール平均に対して
 * 適用するのに対し、こちらは個々の馬の相対位置に対して適用する点が異なる。
 */
const CLOSING_BACK_LEANING_MIN = LEG_STYLE_BACK_MIN;

/** 上がり傾向: 「差し・上がり優勢の示唆」と判定するための該当馬比率の下限(過半数)。 */
const CLOSING_MAJORITY_RATIO = 0.5;

/** 数値配列の単純平均(空なら null)。 */
function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 1レース分の複勝圏内(3着以内、降着は確定着順)馬を抽出する(derive-features の isPlaced 基準)。 */
function placedHorsesOf(race: SameDayTrendRace): SameDayTrendRaceHorse[] {
  return race.horses.filter((h) => {
    const p = isPlaced(h.finishPosition);
    return p.kind === "判定" && p.placed;
  });
}

/** 脚質傾向のプール平均から enum を決める。 */
function classifyPaceLeaning(pooledAverage: number | null): PaceLeaningTrend {
  if (pooledAverage === null) {
    return "データ不足";
  }
  if (pooledAverage <= LEG_STYLE_FRONT_MAX) {
    return "前残り優勢";
  }
  if (pooledAverage >= LEG_STYLE_BACK_MIN) {
    return "差し優勢";
  }
  return "顕著な傾向なし";
}

/** 内外傾向のプール平均から enum を決める(中立バンド・母数不足は null)。 */
function classifyInOut(pooledAverage: number | null): InOutTrend | null {
  if (pooledAverage === null) {
    return null;
  }
  if (pooledAverage <= IN_OUT_INNER_MAX) {
    return "内有利";
  }
  if (pooledAverage >= IN_OUT_OUTER_MIN) {
    return "外有利";
  }
  return null;
}

/** 上がり傾向の該当馬フラグ(hit)配列から enum を決める(0件は判定不可でnull)。 */
function classifyClosing(hits: readonly boolean[]): ClosingTrend | null {
  if (hits.length === 0) {
    return null;
  }
  const hitRatio = hits.filter(Boolean).length / hits.length;
  return hitRatio > CLOSING_MAJORITY_RATIO ? "差し・上がり優勢の示唆" : "顕著な傾向なし";
}

/**
 * 当日レース結果の傾向(脚質傾向・内外傾向・上がり傾向)を要約する。
 * @param results 「同一場・同一面・確定済み」に絞り込み済みのレース結果配列(1面分。SameDayTrendRace
 *   構造的最小型に適合していれば、実引数として RaceResult[] をそのまま渡せる)。
 */
export function summarizeSameDayTrend(
  results: readonly SameDayTrendRace[],
): SameDayTrendSummary {
  const raceCount = results.length;

  // 複勝圏内馬(プール、全レース横断)を先に集める。サンプル数は閾値の成否に関わらず実数を返す。
  const placedByRace = results.map((race) => ({ race, placed: placedHorsesOf(race) }));
  const totalPlacedCount = placedByRace.reduce((n, r) => n + r.placed.length, 0);

  const サンプル数: SameDayTrendSampleSize = {
    レース数: raceCount,
    複勝圏内馬数: totalPlacedCount,
  };

  if (raceCount < MIN_RACE_COUNT) {
    return { 脚質傾向: "データ不足", 内外傾向: null, 上がり傾向: null, サンプル数 };
  }

  // --- 脚質傾向: 複勝圏内馬の相対位置(全コーナー平均÷頭数)をプールして平均する。
  const positionRatios: number[] = [];
  // --- 内外傾向: 複勝圏内馬の馬番相対(umaban/頭数)をプールして平均する。
  const umabanRatios: number[] = [];
  // --- 上がり傾向: レースごとに「同レース平均より上がりが速い かつ 後方脚質」該当馬かをプールする。
  const closingHits: boolean[] = [];

  for (const { race, placed } of placedByRace) {
    const fieldSize = race.horses.length;
    if (fieldSize <= 0) {
      continue;
    }

    // このレース内の上がり3F平均(全馬、判定できた値のみ)。上がり傾向の自己参照比較に使う。
    const allLast3f = race.horses
      .map((h) => h.last3f)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const raceAvgLast3f = average(allLast3f);

    for (const horse of placed) {
      const detail = classifyRunLegStyleFull(horse.passing, fieldSize);
      if (detail.averagePosition !== null) {
        positionRatios.push(detail.averagePosition);
      }

      // umaban は型上は非null必須(number)だが、パーサ由来データの想定外の値(0・NaN等)に
      // 備えて防御的に有効性を検査する(観点5「馬番欠損の馬は当該指標のみ除外」)。
      if (Number.isFinite(horse.umaban) && horse.umaban > 0) {
        umabanRatios.push(horse.umaban / fieldSize);
      }

      if (
        raceAvgLast3f !== null &&
        typeof horse.last3f === "number" &&
        Number.isFinite(horse.last3f) &&
        detail.averagePosition !== null
      ) {
        const fastAgainstField = horse.last3f < raceAvgLast3f;
        const backLeaning = detail.averagePosition >= CLOSING_BACK_LEANING_MIN;
        closingHits.push(fastAgainstField && backLeaning);
      }
    }
  }

  const 脚質傾向 = classifyPaceLeaning(average(positionRatios));
  const 内外傾向 = classifyInOut(average(umabanRatios));
  const 上がり傾向 = classifyClosing(closingHits);

  return { 脚質傾向, 内外傾向, 上がり傾向, サンプル数 };
}

// ---------------------------------------------------------------------------
// collectSameDayTrend(タスク#27-C: 当日・同一場・同一面の確定済み結果を集める収集ヘルパー)
// ---------------------------------------------------------------------------

/**
 * collectSameDayTrend の lookup が返す、当日傾向の集計に必要な最小限のレース結果詳細
 * (構造的最小型)。ev/analysis-store.ts の RaceResultDetail はこの形を満たすため、
 * 呼び出し側(app/pipeline-deps.ts)は実際の getRaceResultDetail をそのまま lookup として
 * 注入できる(analyzer層からev層への実importはせず、循環依存を避ける設計)。
 */
export interface SameDayTrendRaceDetailLike {
  /** レース単位の面(芝/ダ/障)。未取得・未保存(面テーブルに行が無い)は null。 */
  readonly courseType: CourseType | null;
  /** 各馬の着順・通過順・上がり3F。 */
  readonly horses: readonly SameDayTrendRaceDetailHorseLike[];
}

/** SameDayTrendRaceDetailLike の1頭分。 */
export interface SameDayTrendRaceDetailHorseLike {
  readonly umaban: number;
  /** 実着順。中止・除外・着順不明・非数値着順は null(DB保存済みの数値のみ、FinishPosition化前)。 */
  readonly finishPosition: number | null;
  readonly passing: readonly number[];
  readonly last3f: number | null;
}

/**
 * 当日・同一場・同一面の確定済みレース結果から当日傾向を集計する(タスク#27-C)。
 *
 * targetRaceId の先頭10桁+レース番号01〜12(自番号を除く)を兄弟レースIDとして列挙し
 * (scraper/ids.ts の siblingRaceIdsSameDay)、lookup で取得できた(=取込済み・確定済みの)
 * ものだけを対象にする。さらに courseType が targetCourseType と一致する(かつ非null)
 * レースのみを集計に使う(面不一致・面不明〈null〉は除外)。
 *
 * finishPosition は DB由来の number|null を正直に FinishPosition|null へ再構築する
 * (number→{kind:"順位",value:n}、null→null)。降着は確定着順の value をそのまま
 * 順位として扱うため isPlaced の判定・#27-Bの既存挙動と整合し、中止・除外は元々DB側で
 * null として保存されているため isPlaced が「対象外」として自然に除外する
 * (horseName・wakuban 等の偽値は一切導入しない)。
 *
 * summarizeSameDayTrend が「データ不足」(集計対象0〜1レース)を返した場合は null に丸める。
 * これにより呼び出し側(build-prompt.ts)は 脚質傾向 の値を見なくても「材料なし」を
 * 判別できる(ただし build-prompt.ts 側もこの丸めに依存せず自前で同じ判定を行う。
 * defense in depth)。
 *
 * @param targetRaceId 分析対象のレースID(検証済み)
 * @param targetCourseType 分析対象の面(芝/ダ/障。出馬表由来の非null値)
 * @param lookup レースID→確定済み結果詳細(未取込・未確定は undefined)を返す注入関数
 */
export function collectSameDayTrend(
  targetRaceId: RaceId,
  targetCourseType: CourseType,
  lookup: (raceId: RaceId) => SameDayTrendRaceDetailLike | undefined,
): SameDayTrendSummary | null {
  const races: SameDayTrendRace[] = [];

  for (const siblingId of siblingRaceIdsSameDay(targetRaceId)) {
    const detail = lookup(siblingId);
    if (detail === undefined) {
      continue; // 未取込・未確定はスキップ(新規取得・DB書き込みは行わない)。
    }
    if (detail.courseType === null || detail.courseType !== targetCourseType) {
      continue; // 面不一致・面不明(null)は除外。
    }
    races.push({
      horses: detail.horses.map((h) => ({
        umaban: h.umaban,
        finishPosition:
          h.finishPosition === null ? null : { kind: "順位", value: h.finishPosition },
        passing: h.passing,
        last3f: h.last3f,
      })),
    });
  }

  const summary = summarizeSameDayTrend(races);
  return summary.脚質傾向 === "データ不足" ? null : summary;
}
