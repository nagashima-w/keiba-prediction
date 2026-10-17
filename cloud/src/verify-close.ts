/**
 * 検証画面の「締切直前の再計算との比較」(Issue #352〈#335-C〉)。**`cloudflare:workers` を import しない**(Node でテストできる)。
 *
 * ## 何を比べるか
 * 再計算(Issue #338・#344。中央のみ)は、発走の 5 分前(回 1)と直前(回 2)に、オッズだけを取り直して配分を作り直す。その買い目が分析時の提案より回収率を良くしているかを、
 * **同じ分析の集合**で、**同じ定義**(core の `computeVerifyReport`・`PRODUCTION_VERIFY_CONFIG`。確定払戻と賭け金)で比べる。新しい回収率の式は作らない。
 *
 * ## 計算の仕方(読み取り口の `getAllocationForVerify` だけを差し替える)
 * 回ごとに、次の 3 つの読み取り口を作って `computeVerifyReport(…, "central")`(`proposedBet`)を計算する。**`listAnalyses`・`getResult`・`getComboPayouts` は本体の検証と同じ(全分析)**なので、
 * 最新の選択(レースごとに最新 1 件)・結果の有無・先読みの遮断・推定 EV の除外は本体と完全に同じ規則で行われる。**差し替えるのは配分だけ**:
 *  - 再計算側: その回が `status = 'ok'` の分析にだけ、再計算の配分(`analysis_close` のメタと `analysis_close_bets`)を返す。それ以外は undefined(core は「記録なし」に数える)。
 *  - 分析時側: **再計算側と同じ ok の分析**にだけ、分析時の配分を返す。
 *  - 対象の数え方: `analysis_close` に行がある分析(failed・skipped を含む)にだけ見本の配分を返し、集計に入った分析の数(母集団 4 分類の合計)を得る。
 * 「先に ok の分析に絞ってから最新を選ぶ」のではない点が重要: 絞ってから選ぶと、同じレースで「最新の分析は ok でなく、古い分析が ok」のときに古い分析が最新に化けて、本体の検証と違うレースが入る。
 * ここでは最新の選択が先なので、そのレースはどちらの側にも入らない。
 *
 * ## 区分
 * 再計算は中央だけ(地方は `nar-unsupported` の skipped の行が残る)なので、比較は `central` に固定する(画面の区分タブに依らない。版別比較と同じ)。
 *
 * ## 表が無い・行が無い
 * 行が 1 つも無ければ null(比較なし)。表が無い(migration 前)ときの読み出しの失敗は `D1VerifyStore.readAll` が握って `close: null` にするので、ここには届かない。
 */
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { StoredAllocationSummary, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";
import { CLOSE_ROUNDS } from "./analysis-close";

/** 比較が読む D1 の文(束縛値なし)。どちらも主キーの順(並べ替えの一時領域を使わない)。`analysis_close_bets` は ok の回の行だけがある(migration 0019)。 */
export const VERIFY_CLOSE_READ_SQL = {
  meta: "SELECT analysis_id AS analysisId, round, status, route, skip_reason_code AS skipReasonCode FROM analysis_close ORDER BY analysis_id, round",
  bets: "SELECT analysis_id AS analysisId, round, bet_type AS betType, combo_key AS comboKey, stake FROM analysis_close_bets ORDER BY analysis_id, round, bet_type, combo_key",
} as const;

export interface VerifyCloseMetaRow {
  readonly analysisId: number;
  readonly round: number;
  /** ok / failed / skipped。 */
  readonly status: string;
  /** 配分の経路。ok のときだけ値(それ以外は NULL)。 */
  readonly route: string | null;
  readonly skipReasonCode: string | null;
}
export interface VerifyCloseBetRow {
  readonly analysisId: number;
  readonly round: number;
  readonly betType: string;
  readonly comboKey: string;
  readonly stake: number;
}
/** {@link VERIFY_CLOSE_READ_SQL} の結果の行。 */
export interface VerifyCloseRows {
  readonly meta: readonly VerifyCloseMetaRow[];
  readonly bets: readonly VerifyCloseBetRow[];
}

/** 配分ベースの回収率の 4 値(core の `ProposedBetTypeSummary` のうち、画面が使う項目だけ)。 */
export interface CloseSummary {
  readonly betCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
}

/** 回ごとの比較。 */
export interface CloseRoundComparison {
  /** 回の番号(1 = 5 分前、2 = 直前)。 */
  readonly round: number;
  /** 発走の何分前に再計算したか(サーバの定数 `CLOSE_ROUNDS` から作る。直前は暫定値で、変わりうる。画面はこの値で文言を作る)。 */
  readonly leadMinutes: number;
  /** 集計に入った分析のうち、この回が ok(再計算できた)の数。回収率はこの分析だけで比べる。 */
  readonly okCount: number;
  /** 集計に入った分析のうち、この回の行がある(failed・skipped を含む)数。 */
  readonly targetCount: number;
  /** 分析時の配分(ok の分析だけ)。 */
  readonly base: CloseSummary;
  /** 再計算の配分(ok の分析だけ)。 */
  readonly recalc: CloseSummary;
}

export interface CloseComparison {
  readonly rounds: readonly CloseRoundComparison[];
}

/** 母集団の分類の見本(`route: "unset"` は「配分の計算に未到達」に数えられ、賭け金は 0)。対象の数を得るためだけに使う。 */
const PRESENCE_STUB: StoredAllocationSummary = { route: "unset", skipReasonCode: null, bets: [] };

function summarize(source: VerifyDataSource, allocationOf: (analysisId: number) => StoredAllocationSummary | undefined): { summary: CloseSummary; count: number } {
  const derived: VerifyDataSource = { ...source, getAllocationForVerify: allocationOf };
  const { overall, population } = computeVerifyReport(derived, PRODUCTION_VERIFY_CONFIG, "central").proposedBet;
  return {
    summary: { betCount: overall.betCount, totalStake: overall.totalStake, totalReturn: overall.totalReturn, recoveryRate: overall.recoveryRate },
    count: population.allocated + population.skipped + population.unreached,
  };
}

/**
 * 回ごとの、分析時と再計算の回収率の比較を作る(クラス冒頭の説明)。再計算の行が 1 つも無ければ null。
 * 定義にない回(`CLOSE_ROUNDS` にない番号)の行は無視する。
 */
export function computeCloseComparison(source: VerifyDataSource, close: VerifyCloseRows): CloseComparison | null {
  if (close.meta.length === 0) {
    return null;
  }
  const betsByKey = new Map<string, StoredAllocationSummary["bets"][number][]>();
  for (const b of close.bets) {
    const key = `${b.analysisId}:${b.round}`;
    const bets = betsByKey.get(key);
    const bet = { betType: b.betType, comboKey: b.comboKey, stake: b.stake };
    if (bets === undefined) {
      betsByKey.set(key, [bet]);
    } else {
      bets.push(bet);
    }
  }
  const rounds = CLOSE_ROUNDS.map(({ round, leadMs }): CloseRoundComparison => {
    const rowsOfRound = close.meta.filter((m) => m.round === round);
    const present = new Set(rowsOfRound.map((m) => m.analysisId));
    // 再計算の配分(ok で、経路がある行だけ。経路が無い ok は配分なし扱い)。
    const recalcAllocations = new Map<number, StoredAllocationSummary>();
    for (const m of rowsOfRound) {
      if (m.status === "ok" && m.route !== null) {
        recalcAllocations.set(m.analysisId, { route: m.route, skipReasonCode: m.skipReasonCode, bets: betsByKey.get(`${m.analysisId}:${round}`) ?? [] });
      }
    }
    const recalc = summarize(source, (id) => recalcAllocations.get(id));
    const base = summarize(source, (id) => (recalcAllocations.has(id) ? source.getAllocationForVerify(id) : undefined));
    const target = summarize(source, (id) => (present.has(id) ? PRESENCE_STUB : undefined));
    return { round, leadMinutes: leadMs / 60_000, okCount: recalc.count, targetCount: target.count, base: base.summary, recalc: recalc.summary };
  });
  return { rounds };
}
