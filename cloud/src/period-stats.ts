/**
 * 期間の統計(Issue #264)。D1 の行から、日報の 1 日の統計(`DayStats`)と同じ形の統計を作る**純関数**。D1・R2・時計を持たない(読む SQL は `daily-report-repository.ts`)。
 *
 * ## 何のためか
 * 日報の LLM に「その日の結果を、長い期間と比べて」書かせるため。1 日分の件数では「偶然かもしれない」以上のことが言えないので、直前の期間の統計を渡す。
 * 月報(Issue #265)も同じ部品を使う(期間を `[月初, 月末]` にして {@link buildPeriodStats} を呼ぶ)。
 *
 * ## 日報の 1 日の統計と同じ数字になる(同じ関数を通す)
 *  - 買い目の的中判定は日報と同じ `judgeBets`、集計の本体も日報と同じ `buildStatsFromRaces`。行 → 入力の組み立てだけがここ。
 *  - 対象の分析は**レースごとに最新の 1 件**(日報の `listDayAnalyses` と同じ規則。選ぶのは SQL〈`READ_PERIOD_SQL`〉で、ここへは選んだ後の行が渡る)。
 *  - 結果のあるレースは `race_results` に行がある(日報の `readResults` と同じ。1 行も無いレースは「結果なし」)。
 *
 * ## 28 日累計の作り方
 * D1 で再集計するのは**その日を除く直前 27 日**({@link rollingPriorWindow})だけ。その日の分は日報が計算済みの `DayStats` を足す(`mergeDayStats`)。
 * こうすると、その日の統計と 28 日累計がずれない(R2 の詳細が読めずその日のダイジェストから落ちたレースがあっても、累計に別の数字で入らない)。
 */
import { judgeBets, type ComboPayouts, type DayBet, type RaceResultData, type ResultHorse } from "./daily-report-bets";
import { buildStatsFromRaces, mergeDayStats, type DayStats, type StatsRace } from "./daily-report-digest";
import { evaluateTemplates } from "./daily-report-whatif";
import { addDaysToKaisaiDate } from "./result-dispatch";

/** 日報の「長い期間」の日数(その日を含む)。直近 4 週。 */
export const ROLLING_DAYS = 28;

/** その日を除く直前 27 日の範囲 `[D−27, D−1]`(両端を含む。開催日 YYYYMMDD)。 */
export function rollingPriorWindow(kaisaiDate: string): { readonly fromDate: string; readonly toDate: string } {
  return { fromDate: addDaysToKaisaiDate(kaisaiDate, -(ROLLING_DAYS - 1)), toDate: addDaysToKaisaiDate(kaisaiDate, -1) };
}

/** 期間の統計: `DayStats` に、期間の範囲と、実際に分析があった開催日の数を足したもの。 */
export interface PeriodStats extends DayStats {
  readonly fromDate: string;
  readonly toDate: string;
  /** 期間のうち、分析のあった開催日の数(開催の無い日は数えない)。 */
  readonly dayCount: number;
}

/** 読んだ行(列名は SQL の別名と同じ)。 */
export interface PeriodRows {
  /** 期間の、レースごとに最新の分析。 */
  readonly races: readonly { readonly analysisId: number; readonly raceId: string; readonly kaisaiDate: string; readonly model: string | null }[];
  readonly bets: readonly { readonly analysisId: number; readonly betType: string; readonly comboKey: string; readonly stake: number; readonly odds: number | null; readonly ev: number | null }[];
  /** 印の付いた馬(`analysis_horses.mark` が NULL でない行)。 */
  readonly marks: readonly { readonly analysisId: number; readonly umaban: number; readonly mark: string }[];
  readonly results: readonly {
    readonly raceId: string;
    readonly umaban: number;
    readonly finishPosition: number | null;
    readonly winPayout: number | null;
    readonly placePayout: number | null;
    /** 取消・除外か(Issue #278。`race_results.scratched`。未記録の旧い行はキーが無い)。 */
    readonly scratched?: boolean;
  }[];
  readonly combos: readonly { readonly raceId: string; readonly betType: string; readonly comboKey: string; readonly payout: number }[];
  readonly imports: readonly { readonly raceId: string; readonly betType: string }[];
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

/** 結果の行をレースごとにまとめる(日報の `readResults` と同じ形。馬の行が 1 つも無いレースは入れない = 結果なし)。 */
function resultsByRace(rows: PeriodRows): Map<string, RaceResultData> {
  const horsesByRace = groupBy(rows.results, (r) => r.raceId);
  const combosByRace = new Map<string, Record<string, { imported: boolean; payouts: { comboKey: string; payout: number }[] }>>();
  const slot = (raceId: string, betType: string): { imported: boolean; payouts: { comboKey: string; payout: number }[] } => {
    const byType = combosByRace.get(raceId) ?? {};
    combosByRace.set(raceId, byType);
    return (byType[betType] ??= { imported: false, payouts: [] });
  };
  for (const r of rows.imports) {
    slot(r.raceId, r.betType).imported = true;
  }
  for (const r of rows.combos) {
    slot(r.raceId, r.betType).payouts.push({ comboKey: r.comboKey, payout: r.payout });
  }
  const out = new Map<string, RaceResultData>();
  for (const [raceId, list] of horsesByRace) {
    const horses: ResultHorse[] = list.map((r) => ({
      umaban: r.umaban,
      finishPosition: r.finishPosition,
      winPayout: r.winPayout,
      placePayout: r.placePayout,
      ...(r.scratched === undefined ? {} : { scratched: r.scratched }),
    }));
    out.set(raceId, { horses, combos: (combosByRace.get(raceId) ?? {}) as Readonly<Record<string, ComboPayouts>> });
  }
  return out;
}

export function buildPeriodStats(rows: PeriodRows, range: { readonly fromDate: string; readonly toDate: string }): PeriodStats {
  const betsByAnalysis = groupBy(rows.bets, (b) => b.analysisId);
  const marksByAnalysis = groupBy(rows.marks, (m) => m.analysisId);
  const results = resultsByRace(rows);
  const races: StatsRace[] = rows.races.map((race) => {
    const result = results.get(race.raceId);
    const finishByUmaban = new Map<number, number | null>();
    for (const h of result?.horses ?? []) {
      finishByUmaban.set(h.umaban, h.finishPosition);
    }
    const bets: DayBet[] = (betsByAnalysis.get(race.analysisId) ?? []).map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev }));
    const marks = marksByAnalysis.get(race.analysisId) ?? [];
    return {
      hasResult: result !== undefined,
      llmUsed: race.model !== null,
      bets: judgeBets(bets, result),
      marks: marks.map((m) => ({ mark: m.mark, finishPosition: finishByUmaban.get(m.umaban) ?? null })),
      // 印の定型(Issue #272)。同じ行(印・結果・組合せ払戻・取込印)から、日報の 1 日分と同じ `evaluateTemplates` で判定する。
      templates: evaluateTemplates(marks, bets, result),
    };
  });
  return {
    ...buildStatsFromRaces(races),
    fromDate: range.fromDate,
    toDate: range.toDate,
    dayCount: new Set(rows.races.map((r) => r.kaisaiDate)).size,
  };
}

/**
 * 日報に付ける「長い期間」(Issue #264)。LLM に渡した数字そのものを日報の本文に残し、画面と Discord が同じ数字を出す。
 *  - `prior`: その日を除く直前 27 日(D1 の再集計)。
 *  - `total`: 直近 28 日の累計(`prior` + その日)。範囲は D−27〜D。
 */
export interface RollingSummary {
  readonly windowDays: number;
  readonly prior: PeriodStats;
  readonly total: PeriodStats;
}

export function buildRollingSummary(kaisaiDate: string, day: DayStats, prior: PeriodStats): RollingSummary {
  return {
    windowDays: ROLLING_DAYS,
    prior,
    total: { ...mergeDayStats(prior, day), fromDate: prior.fromDate, toDate: kaisaiDate, dayCount: prior.dayCount + (day.raceCount > 0 ? 1 : 0) },
  };
}
