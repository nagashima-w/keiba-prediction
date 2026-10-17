/**
 * 基準タイム表の生成(Issue #353〈#274-B〉)の純ロジック。ファイルには触れない(読み書きは `build-standard-times.ts`)。
 *
 * ## 規則(`packages/core/src/scorer/time-index.ts` の「1走の指数」と同じ条件を共有する)
 * - 使う走: `timeIndexRunBasis` が非 null の走(中央・着順が数値・会場名あり・芝かダート・距離が正・タイムが読める・馬場が 3 区分)で、日付がある走。
 *   障害の走は使わない。
 * - 重複除去: 鍵 `馬ID|日付|レース番号|会場名` が同じ走は 1 つだけ数える(同じ馬の戦績を複数の取得で重ねても二重に数えない。
 *   同じレースでも馬が違えば別の走)。
 * - 基準 = 区分(競馬場|芝ダ|距離)ごとのタイムの中央値。中央値は昇順の floor(n/2) 番目(偶数のときは大きいほう)。走数 `minRuns`(20)以上の区分だけ。
 * - 馬場の補正 = 芝ダ×馬場3区分ごとの、(タイム − 区分の基準) ÷ 距離km の中央値(同じ中央値の定義)。基準のある区分の走だけで集計する。走数の下限は無い。
 * - 区分・補正は鍵の昇順に並べる(出力が決定的)。
 */

import {
  timeIndexRunBasis,
  type TimeIndexRunBasis,
} from "../packages/core/src/scorer/time-index.js";
import type {
  StandardTimeEntry,
  StandardTimeMeta,
  StandardTimeTable,
} from "../packages/core/src/scorer/standard-times.js";
import type { HorseRaceResult } from "../packages/core/src/scraper/types.js";

/** 表の作成に渡す 1 走(馬ID つき。重複除去の鍵に使う)。 */
export interface StandardTimeRun {
  readonly horseId: string;
  readonly result: HorseRaceResult;
}

/** 区分ごとの走数の下限の既定。 */
export const DEFAULT_MIN_RUNS = 20;

/** 昇順の floor(n/2) 番目。 */
function medianOf(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function sortedRecord(map: Map<string, StandardTimeEntry>): Record<string, StandardTimeEntry> {
  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface BuiltStandardTimeTable {
  readonly table: StandardTimeTable;
  /** 使った走の数(重複除去後。区分の走数不足で表に入らなかった走も含む)。 */
  readonly runs: number;
  /** 使った走の日付の最小・最大(YYYY/MM/DD の辞書順)。走が無ければ ["", ""]。 */
  readonly dateRange: readonly [string, string];
}

/** 走の集まりから基準タイム表を作る。 */
export function buildStandardTimeTable(
  input: readonly StandardTimeRun[],
  minRuns: number = DEFAULT_MIN_RUNS,
): BuiltStandardTimeTable {
  const seen = new Set<string>();
  const runs: Array<{ basis: TimeIndexRunBasis; date: string }> = [];
  for (const { horseId, result } of input) {
    const basis = timeIndexRunBasis(result);
    if (basis === null || result.date === null) {
      continue;
    }
    const key = `${horseId}|${result.date}|${result.raceNumber}|${result.venue?.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    runs.push({ basis, date: result.date });
  }

  const timesByKey = new Map<string, number[]>();
  for (const { basis } of runs) {
    const list = timesByKey.get(basis.standardKey) ?? [];
    list.push(basis.timeSec);
    timesByKey.set(basis.standardKey, list);
  }
  const standards = new Map<string, StandardTimeEntry>();
  for (const [key, times] of timesByKey) {
    if (times.length >= minRuns) {
      standards.set(key, { median: medianOf(times), n: times.length });
    }
  }

  const diffsByOffsetKey = new Map<string, number[]>();
  for (const { basis } of runs) {
    const standard = standards.get(basis.standardKey);
    if (standard === undefined) {
      continue;
    }
    const list = diffsByOffsetKey.get(basis.offsetKey) ?? [];
    list.push((basis.timeSec - standard.median) / (basis.distance / 1000));
    diffsByOffsetKey.set(basis.offsetKey, list);
  }
  const offsets = new Map<string, StandardTimeEntry>();
  for (const [key, diffs] of diffsByOffsetKey) {
    offsets.set(key, { median: medianOf(diffs), n: diffs.length });
  }

  const dates = runs.map((r) => r.date).sort();
  return {
    table: { standards: sortedRecord(standards), offsets: sortedRecord(offsets) },
    runs: runs.length,
    dateRange: dates.length === 0 ? ["", ""] : [dates[0]!, dates[dates.length - 1]!],
  };
}

function renderEntries(entries: Readonly<Record<string, StandardTimeEntry>>): string {
  return Object.entries(entries)
    .map(([k, e]) => `  ${JSON.stringify(k)}: { median: ${JSON.stringify(e.median)}, n: ${e.n} },`)
    .join("\n");
}

/**
 * 定数表のソース(`packages/core/src/scorer/standard-times.ts`)を作る。
 * 手で書き換えず、`pnpm tsx scripts/build-standard-times.ts <戦績のディレクトリ...>` の出力で置き換える
 * (コミット済みのファイルが出力と一致することは scripts/test/standard-times-build.test.ts が検査する)。
 */
export function renderStandardTimesModule(table: StandardTimeTable, meta: StandardTimeMeta): string {
  return `/**
 * 基準タイム表(Issue #353〈#274-B〉)。**生成物。手で書き換えない。**
 * 生成: \`pnpm tsx scripts/build-standard-times.ts <戦績の JSON のディレクトリ...>\`(規則は scripts/standard-times-build.ts の先頭)。
 * 使い方: scorer/time-index.ts(1走の指数)。D1 は読まない(定数なので rows_read が増えない)。
 *
 * 出典: ${meta.source}
 * 生成日: ${meta.generatedAt}。使った走: ${meta.runs}(重複除去後。中央・芝ダのみ)。期間: ${meta.dateRange[0]} 〜 ${meta.dateRange[1]}。区分の走数の下限: ${meta.minRuns}。
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
  generatedAt: ${JSON.stringify(meta.generatedAt)},
  source: ${JSON.stringify(meta.source)},
  runs: ${meta.runs},
  dateRange: [${JSON.stringify(meta.dateRange[0])}, ${JSON.stringify(meta.dateRange[1])}],
  minRuns: ${meta.minRuns},
};

export const STANDARD_TIME_TABLE: StandardTimeTable = {
  standards: {
${renderEntries(table.standards)}
  },
  offsets: {
${renderEntries(table.offsets)}
  },
};
`;
}
