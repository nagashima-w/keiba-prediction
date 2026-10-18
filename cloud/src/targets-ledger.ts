/**
 * 「今日の狙い目」の収支の途中経過(Issue #361)。**純関数だけ**で、D1・DO・時計には触れない(`now` は引数)。日単位の DO(RaceDay)の RPC `getTargetsLedger`(`race-day-do.ts`)が、
 * その日の分析・配分・結果の行(`D1TargetsStore.readLedger`)と、計画の発走時刻・結果の取り込みの状態を渡して使う(`getTargetsLedgerWire`)。Worker(`handleTargets`)は計算せず、DO の結果を載せるだけ。
 * 文言は作らない(`targets-view.ts` が作る)。
 *
 * ## 数字は検証画面と同じ規則
 * 新しい回収率の式は作らない。**core の `computeVerifyReport`(`PRODUCTION_VERIFY_CONFIG`・区分は全体)の `proposedBet`** で、その日の分析だけを対象に計算する
 * (`verify-close.ts` が、読み取り口を作って同じ関数に渡す前例)。最新の選択(先読みの疑いを除いた clean の中でレースごとに最新 1 件)・結果の有無・推定 EV の除外・返還・
 * 組合せ券種の払戻の取込状態(規則 U)は、すべて core の規則そのもの。
 *  - **レースごと**: そのレースの分析だけを返す読み取り口(`listAnalyses` を差し替える)で `computeVerifyReport` を呼び、状態と金額を得る。
 *  - **合計**: 状態が `settled`(確定)のレースの分析だけを返す読み取り口で、もう一度 `computeVerifyReport` を呼んだ `proposedBet.overall`。レースごとの和を足し直さない
 *    (合計は検証画面と同じ関数の値であり、レースごとの値の和とも一致する。テストで固定)。
 *
 * ## 状態({@link LedgerState})
 *  - `settled`: 結果が取り込まれ、検証が集計に入れ、分析時の提案に判定できた買い目がある。金額を持つ。
 *  - `pending`: 結果(着順・払戻)が D1 にまだ無い。取り込みが続いている、または発走から {@link RESULT_GIVE_UP_AFTER_START_MS} 以内。
 *  - `pending_payout`: 結果はあるが、組合せ券種などの払戻が未取込で**判定できない買い目がある**(規則 U)。検証画面はこの時点で判定できた買い目だけを集計に入れるが、
 *    ここでは**そのレースを合計から外す**(取り込みが済めば検証画面と一致する)。
 *  - `none`: 結果が取れなかった(取り込みが `gave_up`、または取り込みの行が無いまま発走から {@link RESULT_GIVE_UP_AFTER_START_MS} を超えた)。
 *  - `excluded`: 結果はあるが検証が集計から除外する(先読みの疑い・発走の前後が判定できない・推定 EV)。理由は `reason`。
 *  - `no_proposal`: 分析時の提案に買い目が無い(見送り・配分に未到達・買い目 0 点・配分の記録なし)。結果の有無に依らない。
 *
 * ## 発走時刻の代替
 * 新しい分析の D1 の `start_time` は NULL(検証の DO が遅延で埋める)。先読みの疑いの判定が発走時刻を使うので、**NULL の行に限り計画の発走時刻を入れる**
 * (`''`・`'?'` は検証の補完後の印なので上書きしない。検証画面と同じ判定にするため)。遮断済みの分析は発走時刻を見ずに clean になる。
 */
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG, type ProposedBetTypeSummary } from "../../packages/core/src/ev/verify.js";
import type { StoredAnalysis, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";
import { startTimeEpochMs } from "./pre-race-time";
import { buildVerifySource, type VerifyReadRows } from "./verify-read";

/**
 * 取り込みの行が無いレースを「結果なし」にする、発走からの経過(ミリ秒)。当日の取り込みは発走 +60 分まで再試行する(`race-day-result.ts`)ので、
 * それを過ぎてもなお結果が無く、取り込みの行も無い(依頼が来ていない・DO が取れない)ものは、取り込まれる見込みがないとみなす。+10 分は、最後の試行の完了と D1 への書き込み・
 * 画面の取り直し(3 分間隔)の遅れの余裕。
 */
export const RESULT_GIVE_UP_AFTER_START_MS = 70 * 60_000;

export type LedgerState = "settled" | "pending" | "pending_payout" | "none" | "excluded" | "no_proposal";
/** 集計から除外された理由(`excluded` のとき)。 */
export type LedgerExcludedReason = "lookahead-suspect" | "lookahead-unknown" | "estimated";

export interface LedgerRaceResult {
  readonly raceId: string;
  readonly state: LedgerState;
  /** 賭け金(円)。`settled` のときだけ値、それ以外は 0。 */
  readonly stake: number;
  /** 払戻(円。返還を含む)。`settled` のときだけ値、それ以外は 0。 */
  readonly payout: number;
  /** 返還として数えた買い目の賭け金(円)。払戻にも同額が含まれる。 */
  readonly refundedStake: number;
  /** 返還ではない払戻が 1 円でもあった(的中の買い目がある)。 */
  readonly hit: boolean;
  /** `excluded` のときの理由。 */
  readonly reason: LedgerExcludedReason | null;
}

export interface LedgerTotal {
  /** 確定した(`settled` の)レースの数。 */
  readonly raceCount: number;
  readonly stake: number;
  readonly payout: number;
  /** 払戻 / 賭け金。賭け金 0 は null。 */
  readonly recoveryRate: number | null;
}

export interface TargetsLedger {
  /** 分析のあるレース(race_id)ごとの結果。 */
  readonly races: ReadonlyMap<string, LedgerRaceResult>;
  readonly total: LedgerTotal;
  /** 発走済みで、結果待ち(`pending`・`pending_payout`)のレースの数。 */
  readonly waitingCount: number;
  /** `none`(結果なし)のレースの数。 */
  readonly noneCount: number;
}

/** 日単位の DO の RPC で渡す形(structured clone を通るよう、行は Map ではなく配列)。 */
export interface TargetsLedgerWire {
  readonly races: readonly LedgerRaceResult[];
  readonly total: LedgerTotal;
  readonly waitingCount: number;
  readonly noneCount: number;
}

export function ledgerToWire(ledger: TargetsLedger): TargetsLedgerWire {
  return { races: [...ledger.races.values()], total: ledger.total, waitingCount: ledger.waitingCount, noneCount: ledger.noneCount };
}

export function ledgerFromWire(wire: TargetsLedgerWire): TargetsLedger {
  return { races: new Map(wire.races.map((r) => [r.raceId, r] as const)), total: wire.total, waitingCount: wire.waitingCount, noneCount: wire.noneCount };
}

export interface LedgerInput {
  /** 開催日(YYYYMMDD)。計画の発走時刻を発走の瞬間に直すのに使う。 */
  readonly kaisaiDate: string;
  readonly nowMs: number;
  /** その日の分析・配分・結果の行(`horses` は空でよい。判定は馬の行を使わない)。 */
  readonly rows: VerifyReadRows;
  /** 計画の行(発走時刻)。取れなかったときは null。 */
  readonly plan: readonly { readonly raceId: string; readonly startTime: string | null }[] | null;
  /** 結果の取り込みの状態(race_id → `queued`・`imported`・`gave_up`)。取れなかったときは null。 */
  readonly importStates: ReadonlyMap<string, string> | null;
}

/** 発走時刻(JST の HH:MM)を発走の瞬間に直す。時刻が無い・壊れた形は null(一覧全体を落とさない)。 */
export function startMsOf(kaisaiDate: string, startTime: string | null): number | null {
  if (startTime === null) return null;
  try {
    return startTimeEpochMs(kaisaiDate, startTime);
  } catch {
    return null;
  }
}

/**
 * 収支のための読み(分析・配分・結果と、DO の取り込み状態)を流すか。**計画のどのレースも発走していない間は流さない**(結果は発走後にしか入らないので、読んでも収支は出ない。
 * 午前中の取得で D1 の読み取り行数を増やさない)。計画が取れなかった(null)・計画の行が無い(空)・発走時刻の無い(壊れた)行がある場合は、発走済みかどうか分からないので流す
 * (呼ぶのは、その日に分析がある場合だけ)。
 */
export function shouldReadLedger(input: { readonly kaisaiDate: string; readonly nowMs: number; readonly plan: LedgerInput["plan"] }): boolean {
  if (input.plan === null || input.plan.length === 0) return true;
  return input.plan.some((p) => {
    const ms = startMsOf(input.kaisaiDate, p.startTime);
    return ms === null || ms <= input.nowMs;
  });
}

/** D1 の `verify-read.ts` の SQL と同じ形のスナップショット(`{race:{startTime}}`)。先読みの疑いの判定が `race.startTime` を読む。 */
function snapshotOf(startTime: string): string {
  return JSON.stringify({ race: { startTime } });
}

/** D1 の `start_time` が NULL(未確認)の行にだけ、計画の発走時刻を入れる。 */
function fillStartTimes(rows: VerifyReadRows, planTimes: ReadonlyMap<string, string>): VerifyReadRows {
  return {
    ...rows,
    analyses: rows.analyses.map((a) => {
      const planned = a.startTime === null ? planTimes.get(a.raceId) : undefined;
      return planned === undefined ? a : { ...a, startTime: planned, raceSnapshotJson: snapshotOf(planned) };
    }),
  };
}

/** 指定した分析だけを返す読み取り口(結果・払戻・配分は元のまま。最新の選択は渡した分析の中で行われる)。 */
function restrict(source: VerifyDataSource, analyses: StoredAnalysis[]): VerifyDataSource {
  return { ...source, listAnalyses: (filter) => (filter?.raceId === undefined ? analyses : analyses.filter((a) => a.raceId === filter.raceId)) };
}

function overallOf(source: VerifyDataSource, analyses: StoredAnalysis[]): { report: ReturnType<typeof computeVerifyReport>; overall: ProposedBetTypeSummary } {
  const report = computeVerifyReport(restrict(source, analyses), PRODUCTION_VERIFY_CONFIG, "all");
  return { report, overall: report.proposedBet.overall };
}

const NO_MONEY = { stake: 0, payout: 0, refundedStake: 0, hit: false, reason: null } as const;

export function buildTargetsLedger(input: LedgerInput): TargetsLedger {
  const planTimes = new Map<string, string>();
  const startMs = new Map<string, number | null>();
  for (const p of input.plan ?? []) {
    const ms = startMsOf(input.kaisaiDate, p.startTime);
    startMs.set(p.raceId, ms);
    if (ms !== null && p.startTime !== null) planTimes.set(p.raceId, p.startTime);
  }
  const rows = fillStartTimes(input.rows, planTimes);
  const source = buildVerifySource(rows);

  const betCountByAnalysis = new Map<number, number>();
  for (const b of rows.bets) betCountByAnalysis.set(b.analysisId, (betCountByAnalysis.get(b.analysisId) ?? 0) + 1);
  const byRace = new Map<string, StoredAnalysis[]>();
  for (const a of source.listAnalyses()) {
    const list = byRace.get(a.raceId);
    if (list === undefined) byRace.set(a.raceId, [a]);
    else list.push(a);
  }

  /** 結果が無いレースを、取り込みの状態と発走からの経過で「結果待ち」か「結果なし」にする。 */
  const noResultState = (raceId: string): "pending" | "none" => {
    const state = input.importStates?.get(raceId);
    if (state === "gave_up") return "none";
    if (state === "queued") return "pending";
    const start = startMs.get(raceId) ?? null;
    return start !== null && input.nowMs - start > RESULT_GIVE_UP_AFTER_START_MS ? "none" : "pending";
  };
  /** 発走済みか(計画の時刻が過ぎた、または結果の取り込みの依頼が来ている)。 */
  const isStarted = (raceId: string): boolean => {
    const start = startMs.get(raceId) ?? null;
    return (start !== null && start <= input.nowMs) || input.importStates?.has(raceId) === true;
  };

  const races = new Map<string, LedgerRaceResult>();
  const settledAnalyses: StoredAnalysis[] = [];
  let waitingCount = 0;
  let noneCount = 0;
  for (const [raceId, analyses] of byRace) {
    const result = ((): LedgerRaceResult => {
      if (!analyses.some((a) => (betCountByAnalysis.get(a.id) ?? 0) > 0)) return { raceId, state: "no_proposal", ...NO_MONEY };
      if (source.getResult(raceId) === undefined) return { raceId, state: noResultState(raceId), ...NO_MONEY };
      const { report, overall } = overallOf(source, analyses);
      if (report.includedAnalysisCount === 1) {
        if (overall.unjudgedCount > 0) return { raceId, state: "pending_payout", ...NO_MONEY };
        if (report.proposedBet.population.allocated === 1 && overall.betCount > 0) {
          settledAnalyses.push(...analyses);
          return { raceId, state: "settled", stake: overall.totalStake, payout: overall.totalReturn, refundedStake: overall.refundedStake, hit: overall.totalReturn - overall.refundedStake > 0, reason: null };
        }
        return { raceId, state: "no_proposal", ...NO_MONEY };
      }
      const reason: LedgerExcludedReason | null =
        report.excludedLookaheadSuspectCount > 0 ? "lookahead-suspect" : report.excludedLookaheadUnknownCount > 0 ? "lookahead-unknown" : report.excludedEstimatedCount > 0 ? "estimated" : null;
      return { raceId, state: "excluded", ...NO_MONEY, reason };
    })();
    races.set(raceId, result);
    if ((result.state === "pending" || result.state === "pending_payout") && isStarted(raceId)) waitingCount += 1;
    if (result.state === "none") noneCount += 1;
  }

  const raceCount = [...races.values()].filter((r) => r.state === "settled").length;
  const { overall } = overallOf(source, settledAnalyses);
  return { races, total: { raceCount, stake: overall.totalStake, payout: overall.totalReturn, recoveryRate: overall.recoveryRate }, waitingCount, noneCount };
}

/** {@link getTargetsLedgerWire} が使う読み取り口(日単位の DO の `RaceDayCore` と D1 から作る。`race-day-do.ts`)。 */
export interface LedgerDayDeps {
  /** その日の事前分析の計画の行(`getPlanProgress().rows` の一部)。 */
  readonly plan: () => readonly { readonly raceId: string; readonly startTime: string | null }[];
  /** 結果の取り込みの行(`getResultImportProgress().races` の一部)。 */
  readonly importProgress: () => readonly { readonly raceId: string; readonly state: string }[];
  /** その日の分析・配分・結果の行(`D1TargetsStore.readLedger` の `rows`)。 */
  readonly readRows: (kaisaiDate: string) => Promise<VerifyReadRows>;
}

/**
 * 日単位の DO の RPC `getTargetsLedger` の中身(Issue #361)。**読み取りだけ**(状態を変えない。netkeiba・R2・LLM に出ない)。
 * 収支の計算(`computeVerifyReport` をレースごとと合計で呼ぶ)は、最悪の日(72 レースが確定)で Worker Free の CPU 10ms に収まらないので、Worker ではなくここ(DO)で行う
 * (検証の集計を DO で行うのと同じ理由)。計画のどのレースも発走していなければ null(D1 も取り込み状態も読まない)。D1 の読み取りの失敗は握らず投げる(Worker が収支なしにする)。
 */
export async function getTargetsLedgerWire(deps: LedgerDayDeps, input: { readonly kaisaiDate: string; readonly nowMs: number }): Promise<TargetsLedgerWire | null> {
  const plan = deps.plan();
  if (!shouldReadLedger({ kaisaiDate: input.kaisaiDate, nowMs: input.nowMs, plan })) return null;
  const importStates = new Map(deps.importProgress().map((r) => [r.raceId, r.state] as const));
  const rows = await deps.readRows(input.kaisaiDate);
  return ledgerToWire(buildTargetsLedger({ kaisaiDate: input.kaisaiDate, nowMs: input.nowMs, rows, plan, importStates }));
}
