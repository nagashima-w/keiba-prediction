/**
 * 戦績の派生特徴量(前処理層)。
 *
 * 戦績配列(HorseRaceResult[]、新しい順)から、後続の全バイアス計算(馬場適性・
 * ローテーション適性・季節適性・枠順適性など)が共通で使う派生特徴量を、外部状態に
 * 依存しない決定論的な純関数群として計算する。仕様書「2. scorer」節に対応する。
 *
 * 設計方針:
 * - 入力の並び(新しい順)は保ったまま返す。間隔・走目の計算は内部で時系列(古い順)に処理する。
 * - 地方・海外走も1行として含める(仕様: ローテーションや適性分類にはキャリア全体を使う)。
 *   ただし枠番・馬場・日付などの欠損に由来する特徴は「対象外(null)」を許容する。
 * - 「複勝圏外(placed:false)」と「集計対象外(非数値着順・欠損)」を型で区別する。
 */

import type {
  CourseType,
  FinishPosition,
  HorseRaceResult,
} from "../scraper/types.js";

// ---------------------------------------------------------------------------
// (1) 複勝圏判定
// ---------------------------------------------------------------------------

/**
 * 複勝圏判定の結果。
 *
 * 「圏外(placed:false)」と「集計対象外」を型で区別する。集計対象外は複勝率の母数から
 * 除くべき走(中止・除外・取消・失格などの非数値着順や、着順そのものの欠損)を表す。
 */
export type PlacedResult =
  | { readonly kind: "判定"; readonly placed: boolean }
  | {
      readonly kind: "対象外";
      readonly reason: "非数値着順" | "着順欠損";
    };

/** 複勝圏(3着以内)とみなす上限順位。 */
const PLACE_MAX_RANK = 3;

/**
 * 複勝圏内かどうかを判定する。
 *
 * 呼び出し側は `result.finishPosition` を渡す。数値順位(降着含む)なら3着以内で placed:true、
 * 4着以下で placed:false。非数値(中止・除外・取消・失格)・null は集計対象外として区別する。
 */
export function isPlaced(finish: FinishPosition | null): PlacedResult {
  if (finish === null) {
    return { kind: "対象外", reason: "着順欠損" };
  }
  if (finish.kind === "非数値") {
    return { kind: "対象外", reason: "非数値着順" };
  }
  // 降着(demoted)でも確定着順 value で複勝圏を判定する。
  return { kind: "判定", placed: finish.value <= PLACE_MAX_RANK };
}

// ---------------------------------------------------------------------------
// (2) レース間隔の分類(ローテーション適性)
// ---------------------------------------------------------------------------

/**
 * レース間隔の3分類(仕様「ローテーション適性」)。
 * 前走がない(初出走)・日付欠損で間隔を計算できない場合は「不明」。
 */
export type RotationInterval = "連闘〜中3週" | "中4〜9週" | "休み明け" | "不明";

/**
 * 採用した「中N週」の定義(競馬慣行に準拠):
 *   中N週 ⇔ 出走間隔がおおよそ (N+1) 週 ≈ 7×(N+1) 日
 *   すなわち週数 N = floor((d - 1) / 7)   (連闘 = 中0週)
 *
 * 中央競馬は原則として土日開催のため、間隔は「週末→週末」で 7 の倍数日になるのが基本
 * (連闘≈7日、中1週≈14日、中3週≈28日、中9週≈70日、中10週≈77日)。
 * 式 N=floor((d-1)/7) はこの 7×(N+1) をアンカーとし、7 の倍数ちょうどの日数(週末→週末)を
 * 下側の週数に含める(例: d=28 → 中3週、d=70 → 中9週)。
 *
 * 暦のブレの扱い: 実際には土曜発走→翌週日曜発走のように ±1 日ずれることがある。
 * 7 の倍数 +1 日(例: 29日)は一つ上の週数(中4週)側に寄る。バイアス補正は粗い 3 分類
 * でしか使わず、境界ちょうどのケースは稀なため、この 1 日単位のブレは許容する。
 *
 * 上記より 3 分類の境界(日数)は:
 *   - 連闘〜中3週: d ≤ 28(中3週の上限 = 7×4)
 *   - 中4〜9週:   29 ≤ d ≤ 70(中9週の上限 = 7×10)
 *   - 休み明け:    d ≥ 71(中10週の下限)
 */
/** 「連闘〜中3週」に含める最大日数(中3週の上限 = 7×4)。これを超えると中4週=「中4〜9週」。 */
export const SHORT_ROTATION_MAX_DAYS = 28;
/** 「休み明け(中10週以上)」とみなす最小日数(中10週の下限 = 7×10+1)。 */
export const REST_MIN_DAYS = 71;

/**
 * 前走からの日数差をローテーション3分類に対応付ける。
 * @param daysSincePrev 前走からの日数差。前走なし・日付欠損などで不明なら null。
 *   負の日数差(契約違反: 入力が時系列でない等)は判定できないため「不明」を返す。
 */
export function classifyRotationInterval(
  daysSincePrev: number | null,
): RotationInterval {
  // null(前走なし・日付欠損)・負値(契約違反)は判定不能として不明。
  if (daysSincePrev === null || daysSincePrev < 0) {
    return "不明";
  }
  if (daysSincePrev <= SHORT_ROTATION_MAX_DAYS) {
    return "連闘〜中3週";
  }
  if (daysSincePrev < REST_MIN_DAYS) {
    return "中4〜9週";
  }
  return "休み明け";
}

/** 「YYYY/MM/DD」形式の日付文字列を年月日に分解する。解釈できない場合は null。 */
function parseYmd(
  date: string,
): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(date.trim());
  if (!m) {
    return null;
  }
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * 2つの日付文字列(YYYY/MM/DD)の日数差(cur - prev)を返す。
 * いずれかが null・解釈不能なら null。うるう年も含めUTC基準で正確に計算する。
 */
export function daysBetweenDates(
  prev: string | null,
  cur: string | null,
): number | null {
  if (prev === null || cur === null) {
    return null;
  }
  const p = parseYmd(prev);
  const c = parseYmd(cur);
  if (p === null || c === null) {
    return null;
  }
  const prevMs = Date.UTC(p.year, p.month - 1, p.day);
  const curMs = Date.UTC(c.year, c.month - 1, c.day);
  return Math.round((curMs - prevMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// (4) 季節分類(季節適性)
// ---------------------------------------------------------------------------

/** 季節分類(仕様「季節適性」)。夏(6〜9月)/ 冬(12〜2月)/ 春秋(その他)。 */
export type Season = "夏" | "冬" | "春秋";

/**
 * 開催月を季節に分類する。
 * @param month 1〜12の月。範囲外(0・13・負値など)は対象外として null を返す。
 */
export function classifySeason(month: number): Season | null {
  if (month < 1 || month > 12) {
    return null;
  }
  if (month >= 6 && month <= 9) {
    return "夏";
  }
  if (month === 12 || month === 1 || month === 2) {
    return "冬";
  }
  return "春秋";
}

// ---------------------------------------------------------------------------
// (5) 枠ゾーン分類(枠順適性)
// ---------------------------------------------------------------------------

/** 枠ゾーン分類(仕様「枠順適性」)。内(1〜3)/ 中(4〜6)/ 外(7〜8)。 */
export type FrameZone = "内" | "中" | "外";

/**
 * 枠番を内/中/外ゾーンに分類する。
 * 枠番 null(海外走など)・範囲外(1〜8以外)は対象外として null を返す。
 */
export function classifyFrameZone(wakuban: number | null): FrameZone | null {
  if (wakuban === null) {
    return null;
  }
  if (wakuban >= 1 && wakuban <= 3) {
    return "内";
  }
  if (wakuban >= 4 && wakuban <= 6) {
    return "中";
  }
  if (wakuban >= 7 && wakuban <= 8) {
    return "外";
  }
  return null;
}

// ---------------------------------------------------------------------------
// (6) 道悪判定(馬場状態適性)
// ---------------------------------------------------------------------------

/**
 * 道悪判定の結果。芝/ダートで別集計できるよう courseType を併せて返す。
 * isWet は稍重以下(稍・重・不良)なら true、良なら false。
 */
export interface TrackWetness {
  /** 稍重以下(稍・重・不良)なら true、良なら false。 */
  readonly isWet: boolean;
  /** コース種別(芝/ダ/障)。呼び出し側が芝/ダートを区別するために保持する。 */
  readonly courseType: CourseType | null;
}

/**
 * 馬場状態を道悪かどうかに判定する。
 *
 * 戦績の実表記は先頭1文字(良/稍/重/不)。「稍重」「不良」のような表記も先頭文字で判定する。
 * 判定できない(null・未知表記)場合は対象外として null を返す。
 * @param trackCondition 馬場状態(例: 「稍」「良」「不良」)。
 * @param courseType コース種別(芝/ダ/障)。芝/ダートの区別のため併せて返す。
 */
export function classifyTrackWetness(
  trackCondition: string | null,
  courseType: CourseType | null,
): TrackWetness | null {
  if (trackCondition === null) {
    return null;
  }
  const head = trackCondition.trim().charAt(0);
  if (head === "良") {
    return { isWet: false, courseType };
  }
  // 稍(稍重)・重・不(不良)は道悪。
  if (head === "稍" || head === "重" || head === "不") {
    return { isWet: true, courseType };
  }
  return null;
}

// ---------------------------------------------------------------------------
// (7) 統合: deriveRaceFeatures
// ---------------------------------------------------------------------------

/** 1走分の派生特徴量(元の戦績への参照を含む)。 */
export interface DerivedRaceFeature {
  /** 元の戦績(1走分)。 */
  readonly result: HorseRaceResult;
  /** 複勝圏判定(圏内/圏外/対象外を型で区別)。 */
  readonly placed: PlacedResult;
  /** 前走からの日数差。前走なし・日付欠損なら null。 */
  readonly daysSincePrev: number | null;
  /** レース間隔の3分類(不明を含む)。 */
  readonly interval: RotationInterval;
  /**
   * 休み明けを起点とした走目(休み明け=1、以降の連続出走で2,3,...)。
   * 途中の日付欠損などで連番を確定できない場合は算出不能として null。
   */
  readonly restRunNumber: number | null;
  /** 季節分類。日付(月)が取れない場合は null。 */
  readonly season: Season | null;
  /** 枠ゾーン分類。枠番 null・範囲外なら null。 */
  readonly frameZone: FrameZone | null;
  /** 道悪判定(コース種別付き)。馬場状態が取れない場合は null。 */
  readonly trackWetness: TrackWetness | null;
}

/**
 * 戦績配列(新しい順)に派生特徴量を付与して返す。
 *
 * - 返り値は入力と同じ並び(新しい順)。
 * - 間隔・走目の計算は内部で時系列(古い順)に走査する。前走 = 入力の次要素(index+1)。
 * - 地方・海外走も1行として含める。欠損由来の特徴は個別に「対象外(null)」を許容する。
 */
export function deriveRaceFeatures(
  results: HorseRaceResult[],
): DerivedRaceFeature[] {
  const n = results.length;
  // 古い順(時系列)に走査するためのインデックス列: 末尾(最古)→先頭(最新)。
  const chronoIndices: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    chronoIndices.push(i);
  }

  // 派生特徴量を入力インデックスに対応付けて格納する。
  const features = new Array<DerivedRaceFeature>(n);

  let prevRestRunNumber: number | null = null;
  let prevResult: HorseRaceResult | null = null;

  for (let j = 0; j < chronoIndices.length; j++) {
    const idx = chronoIndices[j]!;
    const cur = results[idx]!;
    const isCareerFirst = prevResult === null;

    const daysSincePrev = isCareerFirst
      ? null
      : daysBetweenDates(prevResult!.date, cur.date);
    const interval = classifyRotationInterval(daysSincePrev);

    // 休み明け何走目か。
    // - キャリア初戦: 1走目
    // - 休み明け(中10週以上): 1走目にリセット
    // - 連闘〜中4〜9週: 直前の走目 + 1(直前が算出不能なら不能を伝播)
    // - 不明(日付欠損で間隔不明。ただし初戦ではない): 算出不能(null)
    let restRunNumber: number | null;
    if (isCareerFirst || interval === "休み明け") {
      restRunNumber = 1;
    } else if (interval === "不明") {
      restRunNumber = null;
    } else {
      restRunNumber = prevRestRunNumber === null ? null : prevRestRunNumber + 1;
    }

    const ymd = cur.date === null ? null : parseYmd(cur.date);

    features[idx] = {
      result: cur,
      placed: isPlaced(cur.finishPosition),
      daysSincePrev,
      interval,
      restRunNumber,
      season: ymd === null ? null : classifySeason(ymd.month),
      frameZone: classifyFrameZone(cur.wakuban),
      trackWetness: classifyTrackWetness(cur.trackCondition, cur.courseType),
    };

    prevRestRunNumber = restRunNumber;
    prevResult = cur;
  }

  return features;
}
