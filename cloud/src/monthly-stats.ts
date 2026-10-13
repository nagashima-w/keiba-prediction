/**
 * 月の統計(Issue #265・#279)。D1 の行(期間の再集計 `READ_PERIOD_SQL` と同じ行)から、月全体の統計に、開催日ごとの行とプロンプト版ごとの行を足したものを作る**純関数**。
 *
 * ## 月全体は期間の統計と同じ数字
 * 月全体は {@link buildPeriodStats} をそのまま通す(日報の 28 日累計の「直前 27 日」と同じ集計)。日ごと・版ごとの行は**同じ行を分割して**同じ関数に通すので、
 * 足し合わせると月全体になる(テストが固定)。日報の合計と月の数字は、日報が確定したあとに入った結果や補完〈#270〉で一致しないことがある(日報は 1 日 1 回で確定して上書きしないため。月は読んだ時点の D1 から数え直す)。
 *
 * ## 追加の D1 読み取りは無い
 * 日ごと・版ごとの行はメモリ上の分割だけ(同じ 6 文の 1 回の batch で足りる)。版は `analyses.prompt_version`(既存の列)を期間の SQL の `latest` に 1 列足して読む。
 */
import { buildPeriodStats, type PeriodRows, type PeriodStats } from "./period-stats";

/** 開催日 1 日分の行(月の日別の表)。 */
export interface MonthDayRow {
  readonly date: string;
  readonly raceCount: number;
  readonly resultRaceCount: number;
  readonly noResultRaceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  /** 賭け金が 0 なら null。 */
  readonly recoveryRate: number | null;
  readonly judgedBetCount: number;
  readonly hitBetCount: number;
  /** 判定できた買い目のうち返還(取消・除外の馬への買い目)の点数。`judgedBetCount`・`totalStake`・`totalReturn` に含まれる内訳で、`hitBetCount` には入らない。 */
  readonly refundedBetCount: number;
  /** 判定不能の買い目(結果・払戻が未取得のレースの買い目)の点数と賭け金。成績(`judgedBetCount`・`totalStake`)には含まれない(Issue #280。月全体の `unjudgedBetCount`・`unjudgedStake` の日ごとの内訳)。 */
  readonly unjudgedBetCount: number;
  readonly unjudgedStake: number;
}

/** プロンプトの版 1 つ分の行(月の版別の表)。 */
export interface MonthVersionRow {
  /** 版。分からない分析は null。 */
  readonly promptVersion: string | null;
  readonly raceCount: number;
  readonly resultRaceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
  readonly judgedBetCount: number;
  readonly hitBetCount: number;
}

/** 月の統計: 期間の統計(月全体)に、開催日ごとの行(昇順)と版ごとの行(版の昇順・版不明が末尾)を足したもの。 */
export interface MonthStats extends PeriodStats {
  readonly days: readonly MonthDayRow[];
  readonly byVersion: readonly MonthVersionRow[];
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list === undefined) {
      out.set(k, [item]);
    } else {
      list.push(item);
    }
  }
  return out;
}

/** 行を、与えたレースの分だけに絞る(分析・レースの ID で引く)。入力の索引は呼び出し側が 1 度だけ作る。 */
function rowsOf(
  races: PeriodRows["races"],
  index: {
    readonly bets: ReadonlyMap<number, PeriodRows["bets"][number][]>;
    readonly marks: ReadonlyMap<number, PeriodRows["marks"][number][]>;
    readonly results: ReadonlyMap<string, PeriodRows["results"][number][]>;
    readonly combos: ReadonlyMap<string, PeriodRows["combos"][number][]>;
    readonly imports: ReadonlyMap<string, PeriodRows["imports"][number][]>;
  },
): PeriodRows {
  return {
    races,
    bets: races.flatMap((r) => index.bets.get(r.analysisId) ?? []),
    marks: races.flatMap((r) => index.marks.get(r.analysisId) ?? []),
    results: races.flatMap((r) => index.results.get(r.raceId) ?? []),
    combos: races.flatMap((r) => index.combos.get(r.raceId) ?? []),
    imports: races.flatMap((r) => index.imports.get(r.raceId) ?? []),
  };
}

export function buildMonthStats(rows: PeriodRows, range: { readonly fromDate: string; readonly toDate: string }): MonthStats {
  const whole = buildPeriodStats(rows, range);
  const index = {
    bets: groupBy(rows.bets, (b) => b.analysisId),
    marks: groupBy(rows.marks, (m) => m.analysisId),
    results: groupBy(rows.results, (r) => r.raceId),
    combos: groupBy(rows.combos, (c) => c.raceId),
    imports: groupBy(rows.imports, (i) => i.raceId),
  };

  const days: MonthDayRow[] = [...groupBy(rows.races, (r) => r.kaisaiDate)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, races]) => {
      const s = buildPeriodStats(rowsOf(races, index), range);
      return {
        date,
        raceCount: s.raceCount,
        resultRaceCount: s.resultRaceCount,
        noResultRaceCount: s.noResultRaceCount,
        totalStake: s.totalStake,
        totalReturn: s.totalReturn,
        recoveryRate: s.recoveryRate,
        judgedBetCount: s.judgedBetCount,
        hitBetCount: s.hitBetCount,
        refundedBetCount: s.refundedBetCount,
        unjudgedBetCount: s.unjudgedBetCount,
        unjudgedStake: s.unjudgedStake,
      };
    });

  // 版の昇順(core の版別比較と同じ並び)。版不明(null・キー無し)は末尾。
  const byVersionMap = groupBy(rows.races, (r) => r.promptVersion ?? null);
  const versions = [...byVersionMap.keys()].filter((v): v is string => v !== null).sort((a, b) => a.localeCompare(b));
  const ordered: Array<string | null> = byVersionMap.has(null) ? [...versions, null] : versions;
  const byVersion: MonthVersionRow[] = ordered.map((promptVersion) => {
    const s = buildPeriodStats(rowsOf(byVersionMap.get(promptVersion)!, index), range);
    return {
      promptVersion,
      raceCount: s.raceCount,
      resultRaceCount: s.resultRaceCount,
      totalStake: s.totalStake,
      totalReturn: s.totalReturn,
      recoveryRate: s.recoveryRate,
      judgedBetCount: s.judgedBetCount,
      hitBetCount: s.hitBetCount,
    };
  });

  return { ...whole, days, byVersion };
}
