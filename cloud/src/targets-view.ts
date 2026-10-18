/**
 * 「今日の狙い目」(Issue #336)の一覧の整形。**純関数だけ**で、D1・DO・時計には触れない(`now` は引数)。`handleTargets`(handler.ts)が、D1 の集計と計画の行を渡して使う。
 *
 * ## 何を載せるか
 * レースごとに**最新の分析**(`TargetsAnalysisRow`)を 1 つ選び、その提案を次の順で決める:
 *  1. 締切の直前の再計算(Issue #338)の回のうち、**`status` が `ok` で番号が最大のもの**(2 分前 > 5 分前)。失敗・行わなかった回は採らない。
 *  2. 無ければ分析時の提案。
 * 採った提案の買い目が **1 点以上なら「狙い目」**。EV のしきい値をここで重ねない(配分はすでに設定の `evThreshold` を通っている)。
 * 分析時には 1 点以上あったのに、採った再計算の回が 0 点なら「見送り」として行を残す(黙って消えない)。もともと 0 点のレースは載せない(分析済みの件数にだけ数える)。
 *
 * ## 文言はサーバで組み立てる
 * クライアントの束は日本語を `\uXXXX`(1 文字 6 バイト)で出すので、文言は置かない(前例: `close-view.ts`・`combo-counts-view.ts`)。残り時間だけがクライアントで変わる文言。
 * 回の名前は `closeLabelOf`(`close-view.ts`)、金額は core の `formatYen` を使う。
 *
 * ## 収支の途中経過(Issue #361)
 * 数字は `targets-ledger.ts`(core の検証と同じ関数)が作る。ここは文言にするだけ。行の結果(`result_state`・`result`)と、上部の合計(`ledger`)。
 * **損益は常に分析時の提案(検証画面・日報と同じ基準)で出す**。一覧の行が再計算の買い目を採っているとき(`source: "close"`)は、行の 2 行目の買い目と基準が違うので、
 * 結果の文言に「分析時の提案:」と分析時の投資額を添える。マイナスは U+2212(−)。未発走の行にも文言は付ける(クライアントが自分の時計で発走済みの行にだけ出す)。
 */
import { venueNameFromRaceId } from "../../packages/core/src/analysis/venue-codes";
import { formatRate, formatYen } from "../../packages/core/src/view/verify-format";
import { CLOSE_ROUNDS } from "./analysis-close";
import { closeLabelOf } from "./close-view";
import { startMsOf, type LedgerRaceResult, type LedgerState, type TargetsLedger } from "./targets-ledger";

/** 最新の分析 1 件の集計(D1 の `analyses`・`analysis_bets`・`analysis_horses` から。`targets-repository.ts`)。買い目は `stake > 0` の行だけを数える。 */
export interface TargetsAnalysisRow {
  readonly analysisId: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly betCount: number;
  readonly totalStake: number;
  readonly maxEv: number | null;
  /** ◎の馬の馬番。◎が無ければ null。 */
  readonly markUmaban: number | null;
}

/** 締切の直前の再計算の 1 回ぶんの集計(D1 の `analysis_close`・`analysis_close_bets` から)。 */
export interface TargetsCloseRoundRow {
  readonly analysisId: number;
  readonly round: number;
  readonly status: string;
  readonly betCount: number;
  readonly totalStake: number;
  readonly maxEv: number | null;
}

/** 事前分析の計画の行(日単位の DO の `getPlanProgress().rows` から使う項目だけ)。 */
export interface TargetsPlanRow {
  readonly raceId: string;
  readonly venueName: string | null;
  readonly raceNumber: number | null;
  readonly startTime: string | null;
}

export interface TargetsViewInput {
  /** 開催日(YYYYMMDD)。発走時刻(JST の HH:MM)を発走の瞬間に直すのに使う。 */
  readonly kaisaiDate: string;
  readonly nowMs: number;
  readonly analyses: readonly TargetsAnalysisRow[];
  /** 再計算の回の集計。取れなかった(表が無い間など)ときは null(分析時の提案で出す)。 */
  readonly closeRounds: readonly TargetsCloseRoundRow[] | null;
  /** 計画の行。取れなかった・計画が無いときは null または空(発走時刻なしで出す)。 */
  readonly plan: readonly TargetsPlanRow[] | null;
  /** 収支の途中経過(`buildTargetsLedger`)。取れなかった・読まなかったときは省略または null(収支なしで一覧だけ出す)。 */
  readonly ledger?: TargetsLedger | null;
}

/** 応答の 1 レース。キーは明示のホワイトリスト(内部の列を展開して漏らさない)。 */
export interface TargetsRace {
  readonly race_id: string;
  readonly analysis_id: number;
  /** 発走の瞬間(UTC のエポックミリ秒)。時刻が分からないとき null。 */
  readonly start_ms: number | null;
  /** 発走予定時刻(JST の HH:MM)。分からないとき null。 */
  readonly start_time: string | null;
  /** 「東京11R」。 */
  readonly place: string;
  /** 「◎7」。◎が無ければ null。 */
  readonly pick: string | null;
  readonly source: "analysis" | "close";
  /** 再計算の回の番号。分析時の提案なら null。 */
  readonly round: number | null;
  readonly bet_count: number;
  readonly total_stake: number;
  readonly max_ev: number | null;
  /** 分析時には 1 点以上あったのに、採った再計算の回が 0 点(見送り)。 */
  readonly skipped: boolean;
  /** 2 行目の文言(「5点 1,200円 EV 1.42・分析時」「見送り・発走2分前の再計算で0点」)。 */
  readonly detail: string;
  /** 結果の状態(収支の途中経過。`targets-ledger.ts`)。収支を出していない・このレースが無いとき null。 */
  readonly result_state: LedgerState | null;
  /** 結果の文言(「的中 +1,200円」「結果待ち」など)。`result_state` が null のとき null。 */
  readonly result: string | null;
}

export interface TargetsView {
  readonly kaisai_date: string;
  /** サーバの現在時刻(UTC のエポックミリ秒)。端末の時計のずれの補正用。 */
  readonly now_ms: number;
  /** 一覧が空のときの理由を区別する要約(「分析済み 12 レース中、狙い目 3」など)。 */
  readonly summary: string;
  /** 上部の合計の文言(「確定 12R: 投資 3,000円 / 回収 4,200円 / 回収率 140.0%」)。出すものが無いとき null。 */
  readonly ledger: string | null;
  /** 発走時刻の昇順(時刻なしは末尾・同じなら race_id の昇順)。 */
  readonly races: readonly TargetsRace[];
}

const UNKNOWN_VENUE = "会場不明";

function leadMinutesOf(round: number): number | null {
  const found = CLOSE_ROUNDS.find((r) => r.round === round);
  return found === undefined ? null : found.leadMs / 60_000;
}

/** race_id の場コードから場名。未知の場コードは core が投げるので、例外にせず null(`analysis-view.ts` と同じく、一覧全体を落とさない)。 */
function venueOf(raceId: string): string | null {
  try {
    return venueNameFromRaceId(raceId);
  } catch {
    return null;
  }
}

function placeOf(raceId: string, plan: TargetsPlanRow | undefined): string {
  const twelve = /^[0-9]{12}$/.test(raceId);
  const venue = plan?.venueName ?? (twelve ? venueOf(raceId) : null) ?? UNKNOWN_VENUE;
  const number = plan?.raceNumber ?? (twelve ? Number(raceId.slice(10, 12)) : null);
  return `${venue}${number === null ? "" : `${number}R`}`;
}

function detailOf(count: number, total: number, maxEv: number | null, sourceText: string): string {
  return `${count}点 ${formatYen(total)}${maxEv === null ? "" : ` EV ${maxEv.toFixed(2)}`}・${sourceText}`;
}

/** 円に丸めた金額。払戻が小数になりうる(賭け金が 100 円単位でないとき)ので、差額と表示の円が食い違わないよう、丸めてから引く。 */
const yen = (amount: number): string => formatYen(Math.round(amount));

/** 差額の文言(「+1,200円」「−300円」「±0円」。マイナスは U+2212)。 */
function netText(net: number): string {
  const rounded = Math.round(net);
  return rounded > 0 ? `+${formatYen(rounded)}` : rounded < 0 ? `\u2212${formatYen(-rounded)}` : "±0円";
}

const EXCLUDED_TEXT = { "lookahead-suspect": "集計対象外(発走後の分析)", "lookahead-unknown": "集計対象外(発走前の分析か判定できません)", estimated: "集計対象外(発売前の推定)" } as const;

/** 行の結果の文言。`viaClose`: 一覧の行が再計算の買い目を採っている(損益の基準が行の買い目と違う)。 */
function resultTextOf(l: LedgerRaceResult, viaClose: boolean): string {
  switch (l.state) {
    case "settled": {
      const head = l.hit ? "的中" : l.refundedStake === l.stake ? "返還" : "不的中";
      const body = `${head} ${netText(l.payout - l.stake)}`;
      return viaClose ? `分析時の提案: ${body}(投資 ${yen(l.stake)})` : body;
    }
    case "pending":
      return "結果待ち";
    case "pending_payout":
      return "結果待ち(払戻)";
    case "none":
      return "結果なし";
    case "excluded":
      return l.reason === null ? "集計対象外" : EXCLUDED_TEXT[l.reason];
    case "no_proposal":
      return "分析時の提案なし";
  }
}

/** 上部の合計の文言。確定が無く、待ちも結果なしも無ければ null(何も出さない)。 */
function ledgerTextOf(ledger: TargetsLedger): string | null {
  const notes = [ledger.waitingCount > 0 ? `結果待ち ${ledger.waitingCount}R` : null, ledger.noneCount > 0 ? `結果なし ${ledger.noneCount}R` : null].filter((n): n is string => n !== null);
  const suffix = notes.length === 0 ? "" : `(${notes.join("・")})`;
  const { raceCount, stake, payout, recoveryRate } = ledger.total;
  if (raceCount > 0) return `確定 ${raceCount}R: 投資 ${yen(stake)} / 回収 ${yen(payout)} / 回収率 ${formatRate(recoveryRate)}${suffix}`;
  return notes.length === 0 ? null : `確定したレースはまだありません${suffix}`;
}

export function buildTargetsView(input: TargetsViewInput): TargetsView {
  const planByRace = new Map((input.plan ?? []).map((p) => [p.raceId, p] as const));
  const closeByAnalysis = new Map<number, TargetsCloseRoundRow[]>();
  for (const row of input.closeRounds ?? []) {
    if (row.status !== "ok") continue; // 失敗・行わなかった・未知の状態の回は採らない
    const list = closeByAnalysis.get(row.analysisId);
    if (list === undefined) closeByAnalysis.set(row.analysisId, [row]);
    else list.push(row);
  }

  const races: TargetsRace[] = [];
  let targets = 0;
  let skippedCount = 0;
  for (const a of input.analyses) {
    const chosen = (closeByAnalysis.get(a.analysisId) ?? []).reduce<TargetsCloseRoundRow | null>((best, r) => (best === null || r.round > best.round ? r : best), null);
    const betCount = chosen === null ? a.betCount : chosen.betCount;
    const totalStake = chosen === null ? a.totalStake : chosen.totalStake;
    const maxEv = chosen === null ? a.maxEv : chosen.maxEv;
    const isSkipped = chosen !== null && betCount === 0 && a.betCount >= 1;
    if (betCount === 0 && !isSkipped) continue; // もともと提案が無い(分析済みの件数にだけ数える)
    const plan = planByRace.get(a.raceId);
    const startTime = plan?.startTime ?? null;
    const startMs = startMsOf(input.kaisaiDate, startTime);
    const label = chosen === null ? null : closeLabelOf(chosen.round, leadMinutesOf(chosen.round));
    if (isSkipped) skippedCount += 1;
    else targets += 1;
    const ledgerRace = input.ledger?.races.get(a.raceId);
    races.push({
      race_id: a.raceId,
      analysis_id: a.analysisId,
      start_ms: startMs,
      start_time: startMs === null ? null : startTime,
      place: placeOf(a.raceId, plan),
      pick: a.markUmaban === null ? null : `◎${a.markUmaban}`,
      source: chosen === null ? "analysis" : "close",
      round: chosen === null ? null : chosen.round,
      bet_count: betCount,
      total_stake: totalStake,
      max_ev: maxEv,
      skipped: isSkipped,
      detail: isSkipped ? `見送り・${label}の再計算で0点` : detailOf(betCount, totalStake, maxEv, label === null ? "分析時" : `${label}の再計算`),
      result_state: ledgerRace === undefined ? null : ledgerRace.state,
      result: ledgerRace === undefined ? null : resultTextOf(ledgerRace, chosen !== null),
    });
  }

  races.sort((x, y) => {
    if (x.start_ms !== y.start_ms) {
      if (x.start_ms === null) return 1;
      if (y.start_ms === null) return -1;
      return x.start_ms - y.start_ms;
    }
    return x.race_id < y.race_id ? -1 : x.race_id > y.race_id ? 1 : 0;
  });

  const analyzed = input.analyses.length;
  const skippedNote = skippedCount > 0 ? `(見送り ${skippedCount})` : "";
  const summary =
    analyzed === 0
      ? "まだ分析されたレースがありません"
      : targets === 0
        ? `分析済み ${analyzed} レースのうち、狙い目はありません${skippedNote}`
        : `分析済み ${analyzed} レース中、狙い目 ${targets}${skippedNote}`;
  return { kaisai_date: input.kaisaiDate, now_ms: input.nowMs, summary, ledger: input.ledger === undefined || input.ledger === null ? null : ledgerTextOf(input.ledger), races };
}
