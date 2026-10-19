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
 * ## 区分と基準(Issue #379。地方も対象になった)
 * 比較は**区分(all・central・nar)ごとに**作り、画面の区分のタブに従う(`verify-core` が 3 区分を同時に計算してキャッシュする)。回ごとに、**取り直しの基準**(`closeComboBasis`)で行を分ける:
 *  - `refetched`: 組合せも取り直した/組合せなしの配分(中央の全部、地方の組合せ OFF)
 *  - `analysis`: 単勝・複勝だけ取り直し、組合せは分析時のオッズの混成の配分(地方の組合せ ON)。別の実験なので、他の行と混ぜない
 * 基準は**分析ごと**に、場(race_id)と、分析時の組合せ設定(`comboOnIds`=分析時の配分メタの `include_combo_odds` が 1 の分析 id)から導く。再計算の行の `include_combo_odds` は ok の回にしか無いので、
 * 失敗・行わなかった回の分析の基準には使えない。
 * 旧い `nar-unsupported` の行(Issue #338 の時点の、地方の skipped)は、仕組みが無かった時点のものなので、比較から除く(分母に数えない)。
 *
 * ## 表が無い・行が無い
 * 行が 1 つも無ければ null(比較なし)。表が無い(migration 前)ときの読み出しの失敗は `D1VerifyStore.readAll` が握って `close: null` にするので、ここには届かない。
 */
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG, type VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";
import type { StoredAllocationSummary, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";
import { closeComboBasis, CLOSE_ROUNDS, venueKindOfRaceIdSafe, type CloseComboBasis } from "./analysis-close";

/** 比較が読む D1 の文(束縛値なし)。どちらも主キーの順(並べ替えの一時領域を使わない)。`analysis_close_bets` は ok の回の行だけがある(migration 0019)。 */
export const VERIFY_CLOSE_READ_SQL = {
  meta: "SELECT analysis_id AS analysisId, round, status, route, skip_reason_code AS skipReasonCode, reason FROM analysis_close ORDER BY analysis_id, round",
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
  /** 理由(`analysis_close.reason`。ok のときは NULL)。旧い `nar-unsupported` の行を除くために読む。省略可能なのは、この列を持たない固定データ(旧いテスト)を壊さないため。 */
  readonly reason?: string | null;
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
  /** 取り直しの基準(`closeComboBasis`)。回ごとに基準で行を分ける。 */
  readonly basis: CloseComboBasis;
  /** 行の見出しに添える短い語(`analysis` のとき「組合せは分析時のオッズ」。`refetched` は null)。サーバが渡し、クライアントは足すだけ(日本語は束に置かない)。 */
  readonly basisLabel: string | null;
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
  /** 節の説明文(サーバが組み立てる。クライアントの束に日本語を置かない。{@link CLOSE_COMPARISON_DESCRIPTION})。 */
  readonly description: string;
  readonly rounds: readonly CloseRoundComparison[];
}

/** 基準ごとの行の見出しに添える語。 */
export const CLOSE_BASIS_LABELS: Readonly<Record<CloseComboBasis, string | null>> = { refetched: null, analysis: "組合せは分析時のオッズ" };

/** 節の説明文。区分のタブに従うこと、混成の行は別の比較であること、この機能より前の地方の分析は入らないことを述べる。 */
export const CLOSE_COMPARISON_DESCRIPTION =
  "発走の前にオッズだけを取り直して配分を作り直した結果を、分析時の配分と比べます。回ごとに、再計算できた分析だけを集め、同じレースどうしで回収率を計算しています(失敗・行わなかった分析は除く。件数の「/」の右は、その回の行がある分析の数)。区分のタブに合わせて集計します。" +
  "「組合せは分析時のオッズ」の行は、地方で組合せを使う分析です。単勝・複勝だけを取り直し、組合せは分析時のオッズのまま配分を作り直しているので、ほかの行とは別の比較として分けています。この機能より前の地方の分析は入りません。";

/** 比較の区分と、基準の判定に使う入力。 */
export interface CloseComparisonOptions {
  /** 集計する区分(画面のタブ)。core の `computeVerifyReport` の区分と同じ。 */
  readonly venue: VerifyVenueFilter;
  /** 分析時の組合せ設定が ON だった分析の id(分析時の配分メタの `include_combo_odds` = 1)。 */
  readonly comboOnIds: ReadonlySet<number>;
}

const BASES: readonly CloseComboBasis[] = ["refetched", "analysis"];

/** 母集団の分類の見本(`route: "unset"` は「配分の計算に未到達」に数えられ、賭け金は 0)。対象の数を得るためだけに使う。 */
const PRESENCE_STUB: StoredAllocationSummary = { route: "unset", skipReasonCode: null, bets: [] };

function summarize(
  source: VerifyDataSource,
  venue: VerifyVenueFilter,
  allocationOf: (analysisId: number) => StoredAllocationSummary | undefined,
): { summary: CloseSummary; count: number } {
  const derived: VerifyDataSource = { ...source, getAllocationForVerify: allocationOf };
  const { overall, population } = computeVerifyReport(derived, PRODUCTION_VERIFY_CONFIG, venue).proposedBet;
  return {
    summary: { betCount: overall.betCount, totalStake: overall.totalStake, totalReturn: overall.totalReturn, recoveryRate: overall.recoveryRate },
    count: population.allocated + population.skipped + population.unreached,
  };
}

/** 旧い仕組み(Issue #338)が地方に書いた理由。比較から除く。 */
const LEGACY_NAR_REASON = "nar-unsupported";

/**
 * 区分・回・基準ごとの、分析時と再計算の回収率の比較を作る(クラス冒頭の説明)。対象が 1 つも無ければ null。
 * 行は回ごとに、`refetched` → `analysis` の順。**どの回も少なくとも 1 行は出す**(対象の無い回は `refetched` の 0 件の行)。`analysis` の行は対象があるときだけ。
 * `refetched` の行は、対象が無く、同じ回の `analysis` の行に対象があるときだけ省く(0 件の行を並べない)。
 * 定義にない回(`CLOSE_ROUNDS` にない番号)の行は無視する。
 */
export function computeCloseComparison(source: VerifyDataSource, close: VerifyCloseRows, options: CloseComparisonOptions): CloseComparison | null {
  const { venue, comboOnIds } = options;
  const metaRows = close.meta.filter((m) => m.reason !== LEGACY_NAR_REASON);
  if (metaRows.length === 0) {
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
  // 分析ごとの基準(場 × 分析時の組合せ設定)。場が判らない分析は持たない=どの行にも入らない。
  const basisOf = new Map<number, CloseComboBasis>();
  for (const a of source.listAnalyses()) {
    basisOf.set(a.id, closeComboBasis(venueKindOfRaceIdSafe(a.raceId), comboOnIds.has(a.id)));
  }
  const rounds: CloseRoundComparison[] = [];
  for (const { round, leadMs } of CLOSE_ROUNDS) {
    const rowsOfRound = metaRows.filter((m) => m.round === round);
    const perBasis = BASES.map((basis) => {
      const inBasis = (analysisId: number): boolean => basisOf.get(analysisId) === basis;
      const present = new Set(rowsOfRound.filter((m) => inBasis(m.analysisId)).map((m) => m.analysisId));
      // 再計算の配分(ok で、経路がある行だけ。経路が無い ok は配分なし扱い)。
      const recalcAllocations = new Map<number, StoredAllocationSummary>();
      for (const m of rowsOfRound) {
        if (inBasis(m.analysisId) && m.status === "ok" && m.route !== null) {
          recalcAllocations.set(m.analysisId, { route: m.route, skipReasonCode: m.skipReasonCode, bets: betsByKey.get(`${m.analysisId}:${round}`) ?? [] });
        }
      }
      const recalc = summarize(source, venue, (id) => recalcAllocations.get(id));
      const base = summarize(source, venue, (id) => (recalcAllocations.has(id) ? source.getAllocationForVerify(id) : undefined));
      const target = summarize(source, venue, (id) => (present.has(id) ? PRESENCE_STUB : undefined));
      const row: CloseRoundComparison = {
        round,
        basis,
        basisLabel: CLOSE_BASIS_LABELS[basis],
        leadMinutes: leadMs / 60_000,
        okCount: recalc.count,
        targetCount: target.count,
        base: base.summary,
        recalc: recalc.summary,
      };
      return row;
    });
    const analysisRow = perBasis.find((r) => r.basis === "analysis")!;
    const refetchedRow = perBasis.find((r) => r.basis === "refetched")!;
    if (refetchedRow.targetCount > 0 || analysisRow.targetCount === 0) {
      rounds.push(refetchedRow);
    }
    if (analysisRow.targetCount > 0) {
      rounds.push(analysisRow);
    }
  }
  return rounds.some((r) => r.targetCount > 0) ? { description: CLOSE_COMPARISON_DESCRIPTION, rounds } : null;
}
