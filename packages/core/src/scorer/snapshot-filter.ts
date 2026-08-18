/**
 * snapshot-filter — 先読みリーク防止のための基準日切り出し(#40「#35-1a: 確率の質を測る
 * 計測基盤の健全化と指標の実装」)。
 *
 * ## 背景(このモジュールが存在する理由)
 * `packages/app/src/main/analysis-pipeline.ts` は `raceResults: horseData.results ?? []` と
 * 戦績を日付でフィルタせず `buildPriorInput` に渡している。そのレース自身の着順(=このレースの
 * 結果を知った上での「予測」)がpriorの材料に混入しうる(実測: 中央フィクスチャで出走16頭全頭が
 * 該当)。**本番側(analysis-pipeline.ts)の是正は #39 の担当であり、本モジュールはそこには
 * 一切手を入れない。** 本モジュールは「確率の質を測る計測」のために、計測の入力データだけを
 * 独立に基準日で絞り込む純関数を提供する(#40のスコープ)。
 *
 * ## AC9: 値インポート境界
 * `RaceData`/`RaceHorseData` は重い実行時依存(cheerio・undici等)を持つ
 * `scraper/scrape-race.ts` の型だが、本ファイルは **型としてのみ**(`import type`)取り込む。
 * `scrape-race.ts` からの値インポートは0件(TypeScriptの`import type`はコンパイル時に完全に
 * 消去されるため、`scrape-race.ts`の実行時コードはバンドルに一切混入しない)。
 * 一方で `daysBetweenDates`(`./derive-features.js`)は値として import する。同モジュールは
 * import文0件の純関数の葉であり(cheerio・undici等の重い依存を持たない)、`prior.ts` が既に
 * 同じ関数を値として利用している(=core内で既に安全性が実証済みの再利用)。
 *
 * ## 除外の境界(受け入れ条件10)
 * 文字列の辞書順比較(`r.date < cutoffDate`)は使わない。`HorseRaceResult.date` は
 * `scraper/parse-horse-results.ts` がHTMLテキストを正規化せずそのまま格納するため、
 * ゼロ埋めされない形式("2026/6/28")もあり得る(`prior.ts`の`monthOf`が
 * `/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/`と非ゼロ埋めを明示的に許容しているのと同じ前提)。
 * 辞書順比較だと1桁月日を含む日付で誤判定する。そこで `daysBetweenDates(r.date, cutoffDate)`
 * (= cutoffDate − r.date の日数差)を使い、次のセマンティクスに固定する:
 * - `null`(日付欠損 or パース不能)→ **除外**。判定不能を「残す」に倒すとリークを見逃すため、
 *   安全側(除外)に倒す。除去件数は `removedByInvalidDateCount` に計上する。
 * - `<= 0`(基準日と同日を含む。同日 = 当該レース自身の可能性が高い)→ **除外**。
 *   `removedByCutoffCount` に計上する。
 * - `> 0`(基準日より前の走)→ **残す**。
 *
 * ## 非破壊性
 * 入力の `raceData` 自体・その `horses` 配列・各 `results` 配列は一切書き換えない。
 * 新しいオブジェクト・配列を組み立てて返す(スプレッド構文のみ使用)。
 */

import type { HorseRaceResult } from "../scraper/types.js";
import type { RaceData, RaceHorseData } from "../scraper/scrape-race.js";
import { daysBetweenDates } from "./derive-features.js";

/** 1頭分の除去内訳(診断値)。 */
export interface SnapshotFilterHorseDiagnostics {
  /** 馬番。 */
  readonly umaban: number;
  /** フィルタ前の戦績数(`results` が null の場合は0)。 */
  readonly originalCount: number;
  /** 基準日以降(同日含む)として除去した数。 */
  readonly removedByCutoffCount: number;
  /** 日付欠損・パース不能として除去した数。 */
  readonly removedByInvalidDateCount: number;
}

/** filterRaceDataBefore の診断値(全馬合計 + 内訳)。 */
export interface SnapshotFilterDiagnostics {
  /** フィルタに使った基準日(呼び出し引数をそのまま記録)。 */
  readonly cutoffDate: string;
  /** 全馬合計のフィルタ前戦績数。 */
  readonly totalResultCount: number;
  /** 全馬合計の除去数(= removedByCutoffCount + removedByInvalidDateCount)。0ならリーク無し。 */
  readonly removedCount: number;
  /** 全馬合計の「基準日以降(同日含む)」除去数。 */
  readonly removedByCutoffCount: number;
  /** 全馬合計の「日付欠損・パース不能」除去数。 */
  readonly removedByInvalidDateCount: number;
  /** 馬ごとの内訳(馬番昇順は保証しない。入力 `raceData.horses` の並び順)。 */
  readonly perHorse: readonly SnapshotFilterHorseDiagnostics[];
}

/** filterRaceDataBefore の戻り値。 */
export interface FilterRaceDataBeforeResult {
  /** 戦績をフィルタ済みの新しい RaceData(元オブジェクトは変更しない)。 */
  readonly raceData: RaceData;
  /** 除去件数などの診断値。 */
  readonly diagnostics: SnapshotFilterDiagnostics;
}

/** 1頭分の戦績配列を基準日でフィルタする(null入力はnullのまま素通しする)。 */
function filterHorseResults(
  results: readonly HorseRaceResult[] | null,
  cutoffDate: string,
): {
  readonly results: HorseRaceResult[] | null;
  readonly removedByCutoffCount: number;
  readonly removedByInvalidDateCount: number;
} {
  if (results === null) {
    return { results: null, removedByCutoffCount: 0, removedByInvalidDateCount: 0 };
  }
  const kept: HorseRaceResult[] = [];
  let removedByCutoffCount = 0;
  let removedByInvalidDateCount = 0;
  for (const result of results) {
    const days = daysBetweenDates(result.date, cutoffDate);
    if (days === null) {
      removedByInvalidDateCount++;
      continue;
    }
    if (days <= 0) {
      removedByCutoffCount++;
      continue;
    }
    kept.push(result);
  }
  return { results: kept, removedByCutoffCount, removedByInvalidDateCount };
}

/**
 * `raceData.horses[].results` を `cutoffDate` で絞り込む(基準日と同日を含めて除外)。
 * 確率の質の計測(`ev/probability-quality.ts`)がリーク混入の有無を切り替えて比較するための
 * 純関数。仕様・挙動の詳細は本ファイル冒頭のJSDoc参照。
 *
 * @param raceData フィルタ対象の RaceData(破壊的変更はしない)。
 * @param cutoffDate 基準日(`HorseRaceResult.date` と同じ `YYYY/MM/DD` 形式。通常は分析対象
 *   レースの開催日を渡す。同日の走=当該レース自身として除外されるのはこの前提による)。
 */
export function filterRaceDataBefore(
  raceData: RaceData,
  cutoffDate: string,
): FilterRaceDataBeforeResult {
  let totalResultCount = 0;
  let removedByCutoffCount = 0;
  let removedByInvalidDateCount = 0;
  const perHorse: SnapshotFilterHorseDiagnostics[] = [];

  const horses: RaceHorseData[] = raceData.horses.map((horse) => {
    const originalCount = horse.results?.length ?? 0;
    totalResultCount += originalCount;
    const filtered = filterHorseResults(horse.results, cutoffDate);
    removedByCutoffCount += filtered.removedByCutoffCount;
    removedByInvalidDateCount += filtered.removedByInvalidDateCount;
    perHorse.push({
      umaban: horse.shutuba.umaban,
      originalCount,
      removedByCutoffCount: filtered.removedByCutoffCount,
      removedByInvalidDateCount: filtered.removedByInvalidDateCount,
    });
    return { ...horse, results: filtered.results };
  });

  return {
    raceData: { ...raceData, horses },
    diagnostics: {
      cutoffDate,
      totalResultCount,
      removedCount: removedByCutoffCount + removedByInvalidDateCount,
      removedByCutoffCount,
      removedByInvalidDateCount,
      perHorse,
    },
  };
}
