/**
 * 配分ベースの買い目 1 件の的中判定(Issue #398。#390 R-7)。判定の規則は**ここにしか無い**。
 *
 * 検証画面の配分ベースの回収率(`verify.ts` の `computeProposedBetReport`。人気帯・条件ごとの内訳に渡す事象 `ProposedBetEvent` も同じ場所から出る)と、
 * クラウド版の日報・月報(`cloud/src/daily-report-bets.ts` の `judgeBets`)が、この 1 つの関数 {@link createRaceBetJudge} を呼ぶ
 * (2 つの数字が食い違わないようにするため。以前は同じ規則が 2 か所に別々に実装されていた)。
 * `better-sqlite3` に依存しない(Workers に載る)。依存は `bracket-quinella-refund.ts` と `combo-odds-key.ts` だけ。
 *
 * ## 規則(買い目 1 件。`betType` と `comboKey`。順に判定する)
 *  1. **既知の券種か**: place・win・wide・trio・quinella・exacta・trifecta・bracketQuinella の 8 つ({@link PROPOSED_BET_TYPES})。これ以外は `unknownBetType`
 *     (判定しない。呼び出し側が、賭け金を落とさずに別枠で数える〈Issue #76。静かに捨てると投資額を過小計上して回収率が偽って良く見える〉)。
 *  2. **返還(Issue #72。#278)**: 取消・除外の馬(`scratched === true`。中止・失格・降着や、`scratched` が未記録の旧い行の着順なしは含めない)を構成に含む買い目は、
 *     全額返還される。払戻 = 賭け金とし、的中でもはずれでもない第 3 の状態(`refund`)にする。**払戻表の取込状態の判定より前**に行う
 *     (返還は払戻表に依らず確定するので、未取込でも判定不能にしない)。
 *     - 構成馬は `comboKey` を `parseComboOddsKey` で戻して判定する(馬単・三連単の順序付きキーも集合として見る。復元できないキーは返還にせず次へ進む)。
 *     - **枠連(bracketQuinella。Issue #269)**: `comboKey` が枠番の組なので構成馬では決まらない。枠ごとの出走馬の残りで決める
 *       (`bracket-quinella-refund.ts` の `isBracketQuinellaRefund`。枠番か `scratched` が未記録の行があるレースは判定しない)。
 *  3. **単勝・複勝(1 頭 = 1 買い目)**: そのレースに該当する払戻が 1 頭にも無ければ(取込状態ゲート。{@link raceHasWinPayout}・{@link raceHasPlacePayout})`unjudged`。
 *     あれば、馬番のキー(2 桁ゼロ埋め)で払戻を引く。引けなければ `miss`、引ければ `hit`(払戻 0 円も hit)。
 *  4. **組合せ 6 券種(ワイド・3 連複・馬連・馬単・三連単・枠連)**: 払戻表が `not_imported`、または `imported` でも払戻が 0 件なら `unjudged`。
 *     あれば、`comboKey` の**文字列の完全一致**で最初の行を引く(買い目側のキーも払戻側のキーも、保存時に券種別の順序方針で正規化済みのものをそのまま比べる。
 *     馬単の逆順は別の買い目)。無ければ `miss`、あれば `hit`。
 *
 * 払戻の単位: `hit` の {@link BetJudgment.unitPayout} は 100 円あたりの払戻。賭け金 `stake` 円の払戻は {@link payoutForStake}({@link judgmentPayout} が状態ごとにまとめて返す)。
 */

import { buildBracketFrameCensus, isBracketQuinellaRefund } from "./bracket-quinella-refund.js";
import { buildComboOddsKey, parseComboOddsKey, type ComboBetType } from "../scraper/combo-odds-key.js";

/** 配分ベースの買い目 1 件の判定結果。`unjudged` は払戻表の取込状態により判定不能(賭け金・払戻のどちらにも計上しない)。 */
export type ProposedBetOutcome = "hit" | "miss" | "refund" | "unjudged";

/** 判定の対象にする券種(8 つ)。これ以外の券種コードは未知の券種(`unknownBetType`)。 */
export const PROPOSED_BET_TYPES = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
export type ProposedBetType = (typeof PROPOSED_BET_TYPES)[number];

/** 券種コードが判定の対象(8 つ)か。 */
export function isProposedBetType(betType: string): betType is ProposedBetType {
  return (PROPOSED_BET_TYPES as readonly string[]).includes(betType);
}

/**
 * 判定が読む結果の 1 頭分。core の `RaceResultEntry` と cloud の `ResultHorse` が、構造的に満たす。
 * 払戻は 100 円あたり。**`null` と `undefined`(キー無し)は同じ「無い」扱い**。
 */
export interface JudgedHorse {
  readonly umaban: number;
  readonly winPayout?: number | null;
  readonly placePayout?: number | null;
  /** 取消・除外か。true = 取消・除外、false = 記録済みで取消・除外でない、未記録(旧い行)はキー無し。 */
  readonly scratched?: boolean;
  /** 枠番(1〜8)。枠連の返還の判定に使う。未記録(旧い行)は null かキー無し。 */
  readonly wakuban?: number | null;
}

/** 組合せ払戻表の 1 券種ぶん(取込印が無ければ `not_imported`)。core の `RaceComboPayoutsReadResult` と同じ形。 */
export type ComboPayoutTable =
  | { readonly state: "not_imported" }
  | { readonly state: "imported"; readonly payouts: readonly { readonly comboKey: string; readonly payout: number }[] };

/** 組合せ券種の払戻表を引く関数。{@link createRaceBetJudge} が、組合せ券種で返還でない買い目のときだけ、その券種で呼ぶ(呼び出し側がキャッシュしてよい)。 */
export type ComboPayoutLookup = (betType: ComboBetType) => ComboPayoutTable;

/** 買い目 1 件の判定。`hit` だけが 100 円あたりの払戻を持つ。 */
export type BetJudgment =
  | { readonly outcome: "hit"; readonly unitPayout: number }
  | { readonly outcome: "miss" | "refund" | "unjudged" }
  | { readonly outcome: "unknownBetType" };

/**
 * そのレースの実結果に複勝の確定払戻(placePayout)が1件以上あるか(規則H、Issue#70)。
 * computeRaceLedger の hasPayout(表示用)と computeHorseBetOutcome の racePayoutAvailable
 * (集計用)が同じ式を指す一本の定義(Issue#59で繰り返し問題になった二重定義を避けるため)。
 *
 * **真側の意味は#70/#71で共有するが、偽側(false)の扱いは呼び出し元ごとに異なる**(#71メタレビュー
 * 指摘)。#70(computeHorseBetOutcome)の偽側は複勝オッズ下限へ近似フォールバックし数値を出す。
 * #71(computeProposedBetReport)の偽側は判定不能として扱い数値を出さない(unjudgedCountに計上)。
 * この関数自体は「複勝払戻が取込済みか」という事実だけを返し、偽側で何をするかは決めていない
 * ——将来#70の残余(払戻未取込レースの過大計上)を塞ぐ際、片方の呼び出し元を直しても
 * もう片方が静かに壊れないよう、この違いを見落とさないこと。
 */
export function raceHasPlacePayout(results: readonly Pick<JudgedHorse, "placePayout">[]): boolean {
  return results.some((r) => r.placePayout !== null && r.placePayout !== undefined);
}

/**
 * そのレースの実結果に単勝の確定払戻(winPayout)が1件以上あるか(Issue #100・#23-C)。
 * raceHasPlacePayout の鏡写し(winPayoutはplacePayoutと同型の後付け列のため、同じ
 * 「取込状態ゲート」を単勝側にも用意する。汎用化はしない)。
 */
export function raceHasWinPayout(results: readonly Pick<JudgedHorse, "winPayout">[]): boolean {
  return results.some((r) => r.winPayout !== null && r.winPayout !== undefined);
}

/**
 * 100円あたりの払戻から、賭け金 `stake` 円の払戻を出す(配分ベースと一律の比較、日報で**同じ式を通す**ための唯一の定義)。
 * 配分ベースは実際の賭け金、一律は `FLAT_COMPARISON_STAKE`(verify.ts)を与える。
 */
export function payoutForStake(unitPayout: number, stake: number): number {
  return unitPayout * (stake / 100);
}

/** 判定から、賭け金 `stake` 円の払戻(円。賭け金を含む)を出す。hit = {@link payoutForStake}、refund = 賭け金そのもの、miss・unjudged・unknownBetType = 0。 */
export function judgmentPayout(judgment: BetJudgment, stake: number): number {
  switch (judgment.outcome) {
    case "hit":
      return payoutForStake(judgment.unitPayout, stake);
    case "refund":
      return stake;
    default:
      return 0;
  }
}

/**
 * 1 レースの結果から、買い目 1 件を判定する関数を作る。規則はファイル先頭。
 * 取消・除外の馬番の集合・枠ごとの集計・単勝/複勝の払戻の逆引きマップは、ここで 1 回だけ作る。組合せの払戻表は `lookupCombo` で遅延して引く。
 */
export function createRaceBetJudge(horses: readonly JudgedHorse[], lookupCombo: ComboPayoutLookup): (betType: string, comboKey: string) => BetJudgment {
  // 取消・除外の馬番。`scratched === true` だけが対象(未記録・false の着順なしは含めない)。
  const scratchedUmabans = new Set<number>();
  for (const h of horses) {
    if (h.scratched === true) {
      scratchedUmabans.add(h.umaban);
    }
  }
  // 枠連の返還の判定に使う枠ごとの出走馬の集計(Issue #269)。取消・除外の馬がいないレースは返還が起きないので作らない。枠番か scratched が未記録の行があれば null。
  const bracketCensus = scratchedUmabans.size > 0 ? buildBracketFrameCensus(horses) : null;

  const winAvailable = raceHasWinPayout(horses);
  const placeAvailable = raceHasPlacePayout(horses);
  const winByKey = new Map<string, number>();
  const placeByKey = new Map<string, number>();
  for (const h of horses) {
    if (h.winPayout !== null && h.winPayout !== undefined) {
      winByKey.set(buildComboOddsKey([h.umaban]), h.winPayout);
    }
    if (h.placePayout !== null && h.placePayout !== undefined) {
      placeByKey.set(buildComboOddsKey([h.umaban]), h.placePayout);
    }
  }

  return (betType, comboKey): BetJudgment => {
    if (!isProposedBetType(betType)) {
      return { outcome: "unknownBetType" };
    }

    // 返還(Issue #72): 払戻の取込状態の判定より前。
    if (betType === "bracketQuinella") {
      if (isBracketQuinellaRefund(comboKey, bracketCensus)) {
        return { outcome: "refund" };
      }
    } else if (scratchedUmabans.size > 0) {
      const umabans = parseComboOddsKey(comboKey);
      if (umabans !== null && umabans.some((u) => scratchedUmabans.has(u))) {
        return { outcome: "refund" };
      }
    }

    if (betType === "win" || betType === "place") {
      if (!(betType === "win" ? winAvailable : placeAvailable)) {
        return { outcome: "unjudged" };
      }
      const unitPayout = (betType === "win" ? winByKey : placeByKey).get(comboKey);
      return unitPayout === undefined ? { outcome: "miss" } : { outcome: "hit", unitPayout };
    }

    // 組合せ 6 券種: comboKey の文字列完全一致のみ(券種別の順序方針〈昇順化するか否か〉はここでは扱わない。
    // 買い目側・払戻側とも保存時に正規化済みのものをそのまま比べるので、逆順の買い目〈例: 馬単 0813〉が正順の払戻〈1308〉と誤って一致することはない)。
    const table = lookupCombo(betType);
    if (table.state === "not_imported" || table.payouts.length === 0) {
      return { outcome: "unjudged" };
    }
    const row = table.payouts.find((p) => p.comboKey === comboKey);
    return row === undefined ? { outcome: "miss" } : { outcome: "hit", unitPayout: row.payout };
  };
}
