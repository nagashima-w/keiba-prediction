/**
 * 日報(Issue #235)の買い目の的中判定。**純関数**: D1・R2・時計を持たない。
 *
 * **判定の規則は core の 1 つの関数 `createRaceBetJudge`(`packages/core/src/ev/proposed-bet-judgment.ts`。Issue #398)にあり、検証画面の配分ベースの回収率(`computeProposedBetReport`)と同じものをここから呼ぶ。**
 * 規則の中身(返還・払戻表の取込ゲート・組合せキーの完全一致。#72・#269・#278)と、その根拠は、その関数のヘッダにある。ここに残るのは、日報の入力(`RaceResultData`・`DayBet`)の形から
 * その関数への写しと、結果なし・未知の券種の扱い:
 *  - 結果そのものが無いレース(`result === undefined`)は、全部判定不能にする
 *  - 未知の券種(core が判定の対象にする 8 券種の外)は判定不能にする(賭け金は返す。静かに捨てない)
 * 同じ入力を `computeVerifyReport` の `proposedBet` に通して突き合わせることは、`test/daily-report-bets.test.ts` と `test/bet-judgment-characterization.test.ts` が固定している。
 */

import {
  createRaceBetJudge,
  judgmentPayout,
  type ComboPayoutTable,
  type ProposedBetOutcome,
} from "../../packages/core/src/ev/proposed-bet-judgment.js";

/** 結果の 1 頭分(D1 の `race_results`)。払戻は 100 円あたり。 */
export interface ResultHorse {
  readonly umaban: number;
  readonly finishPosition: number | null;
  readonly winPayout: number | null;
  readonly placePayout: number | null;
  /**
   * 取消・除外か(Issue #278。D1 の `race_results.scratched`)。true = 取消・除外、false = 記録済みで取消・除外でない。
   * **未記録(旧い行。NULL)はキーを付けない**(未記録を false にしない。取消か中止か分からない着順なしは、従来どおりはずれ)。
   */
  readonly scratched?: boolean;
  /**
   * 枠番(Issue #269。D1 の `race_results.wakuban`、1〜8)。枠連の買い目の返還の判定に使う。**未記録(旧い行。NULL)はキーを付けない**。
   * 1頭でも未記録・範囲外の馬がいるレースは、枠連の返還を判定しない(検証画面と同じ関数 `isBracketQuinellaRefund` を使う)。
   */
  readonly wakuban?: number;
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
  /**
   * 分析時点の期待値(`analysis_bets.ev`)。**的中確率 × 採用したオッズ**なので、{@link betHitProb} で的中確率に戻せる(Issue #264)。
   * 省略・null は確率を導けない買い目(見込みの的中数に入れない)。
   */
  readonly ev?: number | null;
}

/**
 * 買い目の結果。`refund` は返還(Issue #278。取消・除外の馬を構成に含む。払戻 = 賭け金)。
 * 返還は「判定できた」側に入る(賭け金にも払戻にも数える)が、的中でもはずれでもない。
 */
export type BetStatus = ProposedBetOutcome;

/** 買い目 1 件の結果。`payout` は払戻の合計(円。賭け金込み。返還は賭け金そのもの。はずれ・判定不能は 0)。 */
export interface BetOutcome extends DayBet {
  readonly status: BetStatus;
  readonly payout: number;
}

/**
 * 買い目の分析時点の的中確率(Issue #264)。`ev / odds`。
 *
 * 根拠: `analysis_bets` には的中確率の列が無いが、`odds` と `ev` が保存されていて、配分が使う `ev` は券種を問わず「的中確率 × 採用したオッズ」で作られている
 * (複勝: 補正後の3着内率 × 複勝オッズ下限〈`packages/core/src/ev/expected-value.ts` の `HorseEv.ev`〉、組合せ・単勝: 同時分布から導いた的中確率 × オッズ〈`packages/core/src/ev/combo-bet-allocation.ts` の単勝候補 `ev = winProb * odds` と組合せ候補 `ev = hitProb * odds`〉)。
 * 導けない(odds・ev が無い、odds が 0 以下、ev が負、有限でない、確率が 1 を超える)ときは null を返し、**確率を捏造しない**。
 */
export function betHitProb(odds: number | null | undefined, ev: number | null | undefined): number | null {
  if (odds === null || odds === undefined || ev === null || ev === undefined) {
    return null;
  }
  if (!Number.isFinite(odds) || !Number.isFinite(ev) || odds <= 0 || ev < 0) {
    return null;
  }
  const p = ev / odds;
  return p > 1 + 1e-9 ? null : Math.min(p, 1);
}

/** 馬番 1 頭のキー(`buildComboOddsKey([umaban])` と同じ 2 桁ゼロ埋め)。 */
function singleKey(umaban: number): string {
  return String(umaban).padStart(2, "0");
}

/**
 * 順不同の組(ワイド・馬連・3 連複)のキー: 馬番を昇順にして 2 桁ゼロ埋めで連結する(core の `buildComboOddsKey` と同じ。一致はテストで固定)。
 * 馬単・三連単・枠連のキーではない(着順・枠番の並びが違う)。「もしも」(Issue #272)の定型の買い目が使う。
 */
export function unorderedComboKey(umabans: readonly number[]): string {
  return [...umabans].sort((a, b) => a - b).map(singleKey).join("");
}

function unjudged(bet: DayBet): BetOutcome {
  return { ...bet, status: "unjudged", payout: 0 };
}

export function judgeBets(bets: readonly DayBet[], result: RaceResultData | undefined): BetOutcome[] {
  if (result === undefined) {
    return bets.map(unjudged);
  }
  const judge = createRaceBetJudge(result.horses, (betType): ComboPayoutTable => {
    const combo = result.combos[betType];
    // 券種の行が無い・取込印が無い(払戻の行があっても)は、未取込と同じ扱い。
    return combo === undefined || !combo.imported ? { state: "not_imported" } : { state: "imported", payouts: combo.payouts };
  });
  return bets.map((bet): BetOutcome => {
    const judgment = judge(bet.betType, bet.comboKey);
    // 未知の券種は判定不能(賭け金は返す。静かに捨てない)。
    if (judgment.outcome === "unknownBetType") {
      return unjudged(bet);
    }
    return { ...bet, status: judgment.outcome, payout: judgmentPayout(judgment, bet.stake) };
  });
}
