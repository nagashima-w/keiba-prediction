/**
 * 検証画面の「条件ごとの的中率と回収率」の 3 軸(距離帯・馬場・芝ダ。Issue #389〈#385-B の b〉)の分類。**`cloudflare:workers` を import しない**(Node でテストできる)。
 *
 * 入力は分析の行にある**生の値**(`race-facts.ts` が R2 のスナップショットから写したもの。migration 0023)。区切り・推定の規則はここに集め、生の値は変えない
 * (規則を後から変えても R2 を読み直さずに済む)。関数は**行の見出し**を返す(並びは各 `*_LABELS` の順で、『不明』が最後)。
 *
 * ## 規則(いずれも置き値。根拠のある境界ではない)
 *  - 距離帯: 〜1400m / 1401〜1800m / 1801〜2200m / 2201m〜。境界は数値で定義する(地方には 1230m・1870m など 100m 刻みでない距離がある)。障害は距離帯でなく『障害』の行。
 *  - 馬場: 良 / 稍重(『稍』も)/ 重 / 不良(『不』も)/ 未発表・不明(null・『−』・読めなかったレースを含む)。分析時点の値で、その後の変化は反映しない。
 *  - 芝ダ: 芝 / ダ / 障害 / 不明。
 * **クラスは含めない**(レース名からの推定は不正確なため。出馬表・結果ページの `RaceData02` から正確な値を保存する #426 のあとに、#389-c で足す)。
 * 条件の行が無い(`cond_read` が 0 = 詳細を読めなかった・未確認)レースは、各軸の『不明』の行に入る。
 */

import type { VerifyAnalysisRow } from "./verify-read";

/** 分析の行の条件(生の値)。null = 無い・読めなかった。 */
export interface RaceConditionFacts {
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly trackCondition: string | null;
}

// ---------------------------------------------------------------------------
// 見出し(並びの順)
// ---------------------------------------------------------------------------

export const DISTANCE_LABELS = ["〜1400m", "1401〜1800m", "1801〜2200m", "2201m〜", "障害", "不明"] as const;
export const TRACK_LABELS = ["良", "稍重", "重", "不良", "未発表・不明"] as const;
export const SURFACE_LABELS = ["芝", "ダ", "障害", "不明"] as const;

export type DistanceLabel = (typeof DISTANCE_LABELS)[number];
export type TrackLabel = (typeof TRACK_LABELS)[number];
export type SurfaceLabel = (typeof SURFACE_LABELS)[number];

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

/** 1 レースの 3 軸の見出し。 */
export interface RaceAxisLabels {
  readonly distance: DistanceLabel;
  readonly track: TrackLabel;
  readonly surface: SurfaceLabel;
}

export function axisLabelsOf(facts: RaceConditionFacts | null): RaceAxisLabels {
  return { distance: distanceLabelOf(facts), track: trackLabelOf(facts), surface: surfaceLabelOf(facts) };
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

/**
 * 分析の行から、分析 id → 条件の索引を作る。**`cond_read` が 1 でない行(0 = 読めなかった、NULL = 未確認)は、列に値があっても条件なし(null)**。
 * `cond_read` を持たない行(既存のテストの固定データ)は確認済みとして扱い、列が無ければ全項目 null の事実になる(全軸が不明になる)。
 */
export function buildConditionFactsIndex(rows: readonly VerifyAnalysisRow[]): ReadonlyMap<number, RaceConditionFacts | null> {
  const index = new Map<number, RaceConditionFacts | null>();
  for (const row of rows) {
    index.set(
      row.id,
      row.condRead === 0 || row.condRead === null
        ? null
        : {
            courseType: row.courseType ?? null,
            distance: row.distance ?? null,
            trackCondition: row.trackCondition ?? null,
          },
    );
  }
  return index;
}
