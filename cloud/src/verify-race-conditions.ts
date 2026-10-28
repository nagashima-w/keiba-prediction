/**
 * 検証画面の「条件ごとの的中率と回収率」の 4 軸(距離帯・馬場・芝ダ〈Issue #389 の b〉・クラス〈同 c〉)の分類。**`cloudflare:workers` を import しない**(Node でテストできる)。
 *
 * 入力は分析の行にある**生の値**(`race-facts.ts` が R2 のスナップショットから写したもの。migration 0023)。区切り・推定の規則はここに集め、生の値は変えない
 * (規則を後から変えても R2 を読み直さずに済む)。関数は**行の見出し**を返す(並びは各 `*_LABELS` の順で、『不明』が最後)。
 *
 * ## 規則(いずれも置き値。根拠のある境界ではない)
 *  - 距離帯: 〜1400m / 1401〜1800m / 1801〜2200m / 2201m〜。境界は数値で定義する(地方には 1230m・1870m など 100m 刻みでない距離がある)。障害は距離帯でなく『障害』の行。
 *  - 馬場: 良 / 稍重(『稍』も)/ 重 / 不良(『不』も)/ 未発表・不明(null・『−』・読めなかったレースを含む)。分析時点の値で、その後の変化は反映しない。
 *  - 芝ダ: 芝 / ダ / 障害 / 不明。
 *  - クラス(#389-c): 新馬 / 未勝利 / 1勝クラス / 2勝クラス / 3勝クラス / オープン / 地方(対象外)/ 不明。値は出馬表・結果ページの `RaceData02` から読んで保存した正確な `race_class`(#426)だけを使い、
 *    **レース名やグレードからの推定はしない**(NULL・語彙に無い値は『不明』)。中央は正準ラベルとの完全一致(全角数字・空白は NFKC で正規化)。地方は区分の表記がばらばらなので 1 行にまとめる
 *    (『オープン』は重賞・リステッド・OP を区別しない。区別は保存側が持たない)。開催区分が判定できない race_id は『不明』。
 * 条件の行が無い(`cond_read` が 0 = 詳細を読めなかった・未確認)レースは、芝ダ・距離・馬場の軸の『不明』の行に入る。**クラスは `cond_read` と独立**(結果の取り込みと補完が、スナップショットを読めなかった分析にも `race_class` を書く)。
 */

import type { VerifyAnalysisRow } from "./verify-read";

/** 分析の行の条件(生の値)。null = 無い・読めなかった。 */
export interface RaceConditionFacts {
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly trackCondition: string | null;
  /** レースのクラスの生の値(`race_class`。中央は正準ラベル、地方は区分のトークン)。`cond_read` と独立(条件を読めなかった分析でも残る)。 */
  readonly raceClass: string | null;
}

/** 開催区分(race_id から。判定不能は null)。 */
export type RaceKind = "central" | "nar" | null;

// ---------------------------------------------------------------------------
// 見出し(並びの順)
// ---------------------------------------------------------------------------

export const DISTANCE_LABELS = ["〜1400m", "1401〜1800m", "1801〜2200m", "2201m〜", "障害", "不明"] as const;
export const TRACK_LABELS = ["良", "稍重", "重", "不良", "未発表・不明"] as const;
export const SURFACE_LABELS = ["芝", "ダ", "障害", "不明"] as const;
/** クラスの見出し。中央の正準ラベル(`CENTRAL_RACE_CLASSES` と同じ順)、地方(対象外)、不明が最後。 */
export const CLASS_LABELS = ["新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン", "地方(対象外)", "不明"] as const;

export type DistanceLabel = (typeof DISTANCE_LABELS)[number];
export type TrackLabel = (typeof TRACK_LABELS)[number];
export type SurfaceLabel = (typeof SURFACE_LABELS)[number];
export type ClassLabel = (typeof CLASS_LABELS)[number];

/** 距離帯の上限(この値以下がその帯)。**根拠のない置き値**。 */
export const DISTANCE_BAND_UPPER_BOUNDS = [1400, 1800, 2200] as const;

// ---------------------------------------------------------------------------
// 分類
// ---------------------------------------------------------------------------

/** 全角・半角の揺れをそろえ、前後の空白を除く。 */
const normalize = (text: string): string => text.normalize("NFKC").trim();

export function distanceLabelOf(facts: RaceConditionFacts | null): DistanceLabel {
  if (facts === null) return "不明";
  if (facts.courseType === "障") return "障害";
  const d = facts.distance;
  if (d === null || !Number.isInteger(d) || d <= 0) return "不明";
  const [short, mile, middle] = DISTANCE_BAND_UPPER_BOUNDS;
  return d <= short ? "〜1400m" : d <= mile ? "1401〜1800m" : d <= middle ? "1801〜2200m" : "2201m〜";
}

export function trackLabelOf(facts: RaceConditionFacts | null): TrackLabel {
  if (facts === null || facts.trackCondition === null) return "未発表・不明";
  switch (normalize(facts.trackCondition)) {
    case "良":
      return "良";
    case "稍重":
    case "稍":
      return "稍重";
    case "重":
      return "重";
    case "不良":
    case "不":
      return "不良";
    default:
      return "未発表・不明";
  }
}

export function surfaceLabelOf(facts: RaceConditionFacts | null): SurfaceLabel {
  if (facts === null) return "不明";
  return facts.courseType === "芝" ? "芝" : facts.courseType === "ダ" ? "ダ" : facts.courseType === "障" ? "障害" : "不明";
}

/** 中央の正準ラベル(CLASS_LABELS の先頭 6 つ)。 */
const CENTRAL_CLASS_LABELS: readonly ClassLabel[] = CLASS_LABELS.slice(0, 6);

/** クラスの見出し。地方は区分の値に依らず 1 行、中央は語彙との完全一致(NFKC 正規化後)だけ。それ以外(NULL・語彙に無い値・開催区分が判定不能)は『不明』。 */
export function classLabelOf(facts: RaceConditionFacts | null, kind: RaceKind): ClassLabel {
  if (kind === "nar") return "地方(対象外)";
  if (kind !== "central" || facts === null || facts.raceClass === null) return "不明";
  const normalized = normalize(facts.raceClass);
  return CENTRAL_CLASS_LABELS.find((label) => label === normalized) ?? "不明";
}

/** 1 レースの 4 軸の見出し。 */
export interface RaceAxisLabels {
  readonly distance: DistanceLabel;
  readonly track: TrackLabel;
  readonly surface: SurfaceLabel;
  readonly class: ClassLabel;
}

export function axisLabelsOf(facts: RaceConditionFacts | null, kind: RaceKind): RaceAxisLabels {
  return { distance: distanceLabelOf(facts), track: trackLabelOf(facts), surface: surfaceLabelOf(facts), class: classLabelOf(facts, kind) };
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

/**
 * 分析の行から、分析 id → 条件の索引を作る。**`cond_read` が 1 でない行(0 = 読めなかった、NULL = 未確認)は、芝ダ・距離・馬場は列に値があっても null**。
 * **クラス(`race_class`)は `cond_read` と独立に、行の値をそのまま持つ**(結果の取り込みと補完は、スナップショットを読めなかった分析にもクラスを書く)。
 * `cond_read` を持たない行(既存のテストの固定データ)は確認済みとして扱い、列が無ければ全項目 null の事実になる(全軸が不明になる)。
 */
export function buildConditionFactsIndex(rows: readonly VerifyAnalysisRow[]): ReadonlyMap<number, RaceConditionFacts> {
  const index = new Map<number, RaceConditionFacts>();
  for (const row of rows) {
    const read = !(row.condRead === 0 || row.condRead === null);
    index.set(row.id, {
      courseType: read ? (row.courseType ?? null) : null,
      distance: read ? (row.distance ?? null) : null,
      trackCondition: read ? (row.trackCondition ?? null) : null,
      raceClass: row.raceClass ?? null,
    });
  }
  return index;
}
