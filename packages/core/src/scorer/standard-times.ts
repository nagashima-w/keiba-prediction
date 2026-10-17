/**
 * 基準タイム表(Issue #353〈#274-B〉)。**生成物。手で書き換えない。**
 * 生成: `pnpm tsx scripts/build-standard-times.ts <戦績の JSON のディレクトリ...>`(規則は scripts/standard-times-build.ts の先頭)。
 * 使い方: scorer/time-index.ts(1走の指数)。D1 は読まない(定数なので rows_read が増えない)。
 *
 * 出典: netkeiba の全戦績(馬ごとの ajax_horse_results)。#342・#348・#274 の取得物 raw342・raw348・raw274 の中央の芝・ダの走
 * 生成日: 2026-10-17。使った走: 33209(重複除去後。中央・芝ダのみ)。期間: 2018/08/05 〜 2026/10/12。区分の走数の下限: 20。
 * 元データ(netkeiba の戦績)はリポジトリに入れない。
 * 区分は 競馬場|芝ダ|距離(median = 基準タイム〈秒〉)。補正は 芝ダ|馬場3区分(median = 秒/km。(タイム − 基準) ÷ 距離km の中央値)。n は走数。
 */

export interface StandardTimeEntry {
  /** 中央値(基準タイムは秒、補正は秒/km)。 */
  readonly median: number;
  /** 集計に使った走数。 */
  readonly n: number;
}

export interface StandardTimeTable {
  /** 競馬場|芝ダ|距離 → 基準タイム。 */
  readonly standards: Readonly<Record<string, StandardTimeEntry>>;
  /** 芝ダ|馬場3区分(良/稍重/重・不良) → 補正(秒/km)。 */
  readonly offsets: Readonly<Record<string, StandardTimeEntry>>;
}

export interface StandardTimeMeta {
  readonly generatedAt: string;
  readonly source: string;
  readonly runs: number;
  readonly dateRange: readonly [string, string];
  readonly minRuns: number;
}

export const STANDARD_TIME_META: StandardTimeMeta = {
  generatedAt: "2026-10-17",
  source: "netkeiba の全戦績(馬ごとの ajax_horse_results)。#342・#348・#274 の取得物 raw342・raw348・raw274 の中央の芝・ダの走",
  runs: 33209,
  dateRange: ["2018/08/05", "2026/10/12"],
  minRuns: 20,
};

export const STANDARD_TIME_TABLE: StandardTimeTable = {
  standards: {
  "中京|ダ|1200": { median: 73.1, n: 331 },
  "中京|ダ|1400": { median: 85.6, n: 498 },
  "中京|ダ|1800": { median: 115.1, n: 663 },
  "中京|ダ|1900": { median: 122, n: 176 },
  "中京|芝|1200": { median: 68.8, n: 235 },
  "中京|芝|1400": { median: 81.4, n: 441 },
  "中京|芝|1600": { median: 94.7, n: 489 },
  "中京|芝|2000": { median: 121.2, n: 483 },
  "中京|芝|2200": { median: 133.4, n: 223 },
  "中山|ダ|1200": { median: 72.3, n: 1169 },
  "中山|ダ|1800": { median: 115.6, n: 1054 },
  "中山|ダ|2400": { median: 156.7, n: 62 },
  "中山|芝|1200": { median: 69.1, n: 420 },
  "中山|芝|1600": { median: 95, n: 806 },
  "中山|芝|1800": { median: 109.3, n: 403 },
  "中山|芝|2000": { median: 122, n: 613 },
  "中山|芝|2200": { median: 134.5, n: 176 },
  "中山|芝|2500": { median: 153.9, n: 87 },
  "京都|ダ|1200": { median: 72.7, n: 531 },
  "京都|ダ|1400": { median: 85.7, n: 749 },
  "京都|ダ|1800": { median: 114.3, n: 1037 },
  "京都|ダ|1900": { median: 121.1, n: 247 },
  "京都|芝|1200": { median: 68.6, n: 289 },
  "京都|芝|1400": { median: 81.5, n: 437 },
  "京都|芝|1600": { median: 94.6, n: 647 },
  "京都|芝|1800": { median: 107.4, n: 404 },
  "京都|芝|2000": { median: 121.4, n: 459 },
  "京都|芝|2200": { median: 133.7, n: 126 },
  "京都|芝|2400": { median: 146.5, n: 120 },
  "函館|ダ|1000": { median: 59.6, n: 120 },
  "函館|ダ|1700": { median: 106.2, n: 281 },
  "函館|ダ|2400": { median: 156.3, n: 22 },
  "函館|芝|1200": { median: 69.4, n: 392 },
  "函館|芝|1800": { median: 108.7, n: 212 },
  "函館|芝|2000": { median: 121, n: 139 },
  "函館|芝|2600": { median: 162.1, n: 56 },
  "小倉|ダ|1000": { median: 59.2, n: 152 },
  "小倉|ダ|1700": { median: 106.9, n: 501 },
  "小倉|芝|1200": { median: 69.2, n: 689 },
  "小倉|芝|1800": { median: 109.1, n: 355 },
  "小倉|芝|2000": { median: 121.8, n: 355 },
  "小倉|芝|2600": { median: 161.5, n: 73 },
  "新潟|ダ|1200": { median: 72.6, n: 544 },
  "新潟|ダ|1800": { median: 115.3, n: 612 },
  "新潟|芝|1000": { median: 56, n: 304 },
  "新潟|芝|1200": { median: 70.2, n: 171 },
  "新潟|芝|1400": { median: 82.6, n: 351 },
  "新潟|芝|1600": { median: 95, n: 377 },
  "新潟|芝|1800": { median: 108.2, n: 385 },
  "新潟|芝|2000": { median: 121.6, n: 306 },
  "新潟|芝|2200": { median: 135, n: 115 },
  "新潟|芝|2400": { median: 148.2, n: 43 },
  "札幌|ダ|1000": { median: 59.9, n: 149 },
  "札幌|ダ|1700": { median: 107.2, n: 506 },
  "札幌|芝|1200": { median: 69.9, n: 345 },
  "札幌|芝|1500": { median: 90.4, n: 235 },
  "札幌|芝|1800": { median: 110.1, n: 270 },
  "札幌|芝|2000": { median: 122.4, n: 301 },
  "札幌|芝|2600": { median: 163.5, n: 128 },
  "東京|ダ|1300": { median: 79.7, n: 241 },
  "東京|ダ|1400": { median: 85.7, n: 784 },
  "東京|ダ|1600": { median: 98.7, n: 902 },
  "東京|ダ|2100": { median: 133.4, n: 218 },
  "東京|芝|1400": { median: 82, n: 557 },
  "東京|芝|1600": { median: 94.5, n: 733 },
  "東京|芝|1800": { median: 107.5, n: 637 },
  "東京|芝|2000": { median: 120.5, n: 352 },
  "東京|芝|2400": { median: 146.2, n: 306 },
  "東京|芝|2500": { median: 150.5, n: 21 },
  "福島|ダ|1150": { median: 69.5, n: 264 },
  "福島|ダ|1700": { median: 107.4, n: 454 },
  "福島|芝|1200": { median: 69.7, n: 537 },
  "福島|芝|1800": { median: 109, n: 372 },
  "福島|芝|2000": { median: 120.9, n: 288 },
  "福島|芝|2600": { median: 161.3, n: 97 },
  "阪神|ダ|1200": { median: 73, n: 504 },
  "阪神|ダ|1400": { median: 85.8, n: 626 },
  "阪神|ダ|1800": { median: 115.2, n: 1032 },
  "阪神|ダ|2000": { median: 128, n: 99 },
  "阪神|芝|1200": { median: 69, n: 248 },
  "阪神|芝|1400": { median: 81.6, n: 300 },
  "阪神|芝|1600": { median: 94.5, n: 625 },
  "阪神|芝|1800": { median: 107.2, n: 389 },
  "阪神|芝|2000": { median: 121.4, n: 365 },
  "阪神|芝|2200": { median: 133.5, n: 126 },
  "阪神|芝|2400": { median: 147.3, n: 135 },
  },
  offsets: {
  "ダ|稍重": { median: 0, n: 2774 },
  "ダ|良": { median: 0.1428571428571449, n: 9805 },
  "ダ|重・不良": { median: -0.7692307692307692, n: 1949 },
  "芝|稍重": { median: 0.5000000000000071, n: 2591 },
  "芝|良": { median: -0.15000000000000568, n: 14863 },
  "芝|重・不良": { median: 1.25, n: 1094 },
  },
};
