/**
 * 日報(Issue #235)の買い目の的中判定。**純関数**: D1・R2・時計を持たない。
 *
 * 判定の中身は、core の `computeProposedBetReport`(`packages/core/src/ev/verify.ts`。private)と同じ:
 *  - 単勝・複勝(1 頭 = 1 買い目): そのレースに該当する払戻が 1 頭にも無ければ(取込状態ゲート)判定不能。あれば、馬番のキーで払戻を引く(払戻 = 100 円あたりの払戻 × 賭け金 / 100)
 *  - ワイド・3 連複・馬連・馬単・三連単・枠連: 券種の取込印が無い、または払戻が 0 件なら判定不能。あれば、組合せのキーの文字列の完全一致で的中
 *    (買い目側のキーも払戻側のキーも、保存時に券種別の順序方針で正規化済みのものをそのまま比べる。馬単の逆順は別の買い目)
 *  - 未知の券種は判定不能にする(賭け金は返す。静かに捨てない)
 * core の関数は private で、export 化は影響範囲が広いため別 Issue とし、ここは複製する。**複製が食い違わないことは、
 * `test/daily-report-bets.test.ts` が、同じ入力を `computeVerifyReport` の `proposedBet` に通して突き合わせて固定している。**
 */

/** 結果の 1 頭分(D1 の `race_results`)。払戻は 100 円あたり。 */
export interface ResultHorse {
  readonly umaban: number;
  readonly finishPosition: number | null;
  readonly winPayout: number | null;
  readonly placePayout: number | null;
}

/** 組合せ券種 1 つぶんの払戻(D1 の `race_combo_payouts`。取込印が無ければ `imported: false`)。 */
export interface ComboPayouts {
  readonly imported: boolean;
  readonly payouts: readonly { readonly comboKey: string; readonly payout: number }[];
}

/** 1 レースの結果(着順・払戻)。結果が取り込まれていないレースは、これ自体が無い(undefined)。 */
export interface RaceResultData {
  readonly horses: readonly ResultHorse[];
  /** 券種名(`wide`・`trio`・`quinella`・`exacta`・`trifecta`・`bracketQuinella`)→ 払戻。載っていない券種は未取込と同じ扱い。 */
  readonly combos: Readonly<Record<string, ComboPayouts>>;
}

/** 分析が提案した買い目 1 件。 */
export interface DayBet {
  readonly betType: string;
  readonly comboKey: string;
  readonly stake: number;
  readonly odds: number | null;
}

export type BetStatus = "hit" | "miss" | "unjudged";

/** 買い目 1 件の結果。`payout` は払戻の合計(円。賭け金込み。はずれ・判定不能は 0)。 */
export interface BetOutcome extends DayBet {
  readonly status: BetStatus;
  readonly payout: number;
}

const COMBO_BET_TYPES: ReadonlySet<string> = new Set(["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"]);

/** 馬番 1 頭のキー(`buildComboOddsKey([umaban])` と同じ 2 桁ゼロ埋め)。 */
function singleKey(umaban: number): string {
  return String(umaban).padStart(2, "0");
}

function unjudged(bet: DayBet): BetOutcome {
  return { ...bet, status: "unjudged", payout: 0 };
}

export function judgeBets(bets: readonly DayBet[], result: RaceResultData | undefined): BetOutcome[] {
  if (result === undefined) {
    return bets.map(unjudged);
  }
  const hasWin = result.horses.some((h) => h.winPayout !== null);
  const hasPlace = result.horses.some((h) => h.placePayout !== null);
  const winByKey = new Map<string, number>();
  const placeByKey = new Map<string, number>();
  for (const h of result.horses) {
    if (h.winPayout !== null) {
      winByKey.set(singleKey(h.umaban), h.winPayout);
    }
    if (h.placePayout !== null) {
      placeByKey.set(singleKey(h.umaban), h.placePayout);
    }
  }
  return bets.map((bet): BetOutcome => {
    if (bet.betType === "win" || bet.betType === "place") {
      if (bet.betType === "win" ? !hasWin : !hasPlace) {
        return unjudged(bet);
      }
      const payout = (bet.betType === "win" ? winByKey : placeByKey).get(bet.comboKey);
      return payout === undefined ? { ...bet, status: "miss", payout: 0 } : { ...bet, status: "hit", payout: payout * (bet.stake / 100) };
    }
    if (!COMBO_BET_TYPES.has(bet.betType)) {
      return unjudged(bet);
    }
    const combo = result.combos[bet.betType];
    if (combo === undefined || !combo.imported || combo.payouts.length === 0) {
      return unjudged(bet);
    }
    const hit = combo.payouts.find((p) => p.comboKey === bet.comboKey);
    return hit === undefined ? { ...bet, status: "miss", payout: 0 } : { ...bet, status: "hit", payout: hit.payout * (bet.stake / 100) };
  });
}
