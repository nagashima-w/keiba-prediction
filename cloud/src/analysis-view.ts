/**
 * `GET /api/analyses/{id}` の応答の整形(Issue #183〈#165-a〉)。純関数だけで、D1・R2 には触れない。
 *
 * **画面に必要なものだけ**を、許可したキーで明示的に組み立てる(`...analysis` のような展開は使わない)。返さないもの:
 * `rawResponse`・馬の `contributions`・raceSnapshot の全体(騎手・調教師・オッズ・組合せオッズなど)・追加指示・戦績の基準日・配分の `fallbackReason`・`betUnit`。
 * 馬名・レース名・天候などは raceSnapshot(R2 の詳細。`detail` が `present` のときだけ入る)から、場名・R は raceId から導く。
 * **`detail` が present でないとき(柵に達した・R2 に無い・詳細なし)は、スナップショットを使わず**(馬名は null)、同じキーの形で返す。
 *
 * raceSnapshot は書き込み側(`buildRaceSnapshot`)の形だが、JSON から復元しただけで型は検証されていない。読み出しは `toSafeRaceSnapshot`(欠損・不正で投げない)に任せ、
 * 値は文字列・有限の数だけに絞る(それ以外は null)。書き込み側との食い違いは、`test/analysis-view.test.ts` の drift のテストが検出する。
 */
import { toSafeRaceSnapshot } from "../../packages/app/src/main/analysis-export";
import { venueNameFromRaceId } from "../../packages/app/src/main/venue-codes";
import type { StoredAllocation } from "../../packages/core/src/ev/analysis-store-types";
import type { AnalysisDetailResult, DetailStatus } from "./analysis-repository";

export interface AnalysisViewHorse {
  readonly umaban: number;
  /** 馬名(raceSnapshot から。詳細が無い・スナップショットに無い馬は null)。 */
  readonly name: string | null;
  readonly prior: number;
  readonly adjustedProb: number;
  readonly placeOddsMin: number | null;
  readonly ev: number | null;
  readonly isPositive: boolean;
  readonly mark: string | null;
  readonly reason: string | null;
}

export interface AnalysisViewRace {
  /** 場名(raceId の場コードから)。導けなければ null。 */
  readonly venueName: string | null;
  /** レース番号(raceId の末尾2桁から)。導けなければ null。 */
  readonly raceNumber: number | null;
  readonly raceName: string | null;
  readonly startTime: string | null;
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly weather: string | null;
  readonly trackCondition: string | null;
}

export interface AnalysisViewAllocation {
  readonly route: string;
  readonly skipReasonCode: string | null;
  readonly unavailableReason: string | null;
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly evThreshold: number;
  readonly includeComboOdds: boolean;
  readonly includeWide: boolean;
  readonly includeTrio: boolean;
  readonly includeQuinella: boolean | null;
  readonly includeExacta: boolean | null;
  readonly includeTrifecta: boolean | null;
  readonly includeBracketQuinella: boolean | null;
  readonly oddsStatus: string;
  readonly bets: readonly { readonly betType: string; readonly comboKey: string; readonly stake: number; readonly odds: number | null; readonly ev: number | null }[];
}

export interface AnalysisView {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly evEstimated: boolean;
  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly race: AnalysisViewRace;
  readonly horses: readonly AnalysisViewHorse[];
  /** 配分(D1 の配分の行が無ければ null)。 */
  readonly allocation: AnalysisViewAllocation | null;
  readonly detail: DetailStatus;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function venueNameOf(raceId: string): string | null {
  try {
    return venueNameFromRaceId(raceId);
  } catch {
    return null;
  }
}

function raceNumberOf(raceId: string): number | null {
  return /^[0-9]{12}$/.test(raceId) ? Number(raceId.slice(10)) : null;
}

export function buildAnalysisView(result: AnalysisDetailResult, allocation: StoredAllocation | undefined): AnalysisView {
  const { analysis, detail } = result;
  // 詳細が present でないときは、スナップショットを一切使わない(馬名なしの同じ形で返す)。
  const snapshot = detail === "present" ? toSafeRaceSnapshot(analysis.raceSnapshot) : null;
  const race = snapshot?.race;
  return {
    id: analysis.id,
    raceId: analysis.raceId,
    analyzedAt: analysis.analyzedAt,
    kaisaiDate: analysis.kaisaiDate,
    evEstimated: analysis.evEstimated,
    model: analysis.model,
    promptVersion: analysis.promptVersion,
    race: {
      venueName: venueNameOf(analysis.raceId),
      raceNumber: raceNumberOf(analysis.raceId),
      raceName: str(race?.raceName),
      startTime: str(race?.startTime),
      courseType: str(race?.courseType),
      distance: num(race?.distance),
      weather: str(race?.weather),
      trackCondition: str(race?.trackCondition),
    },
    horses: analysis.horses.map((h) => ({
      umaban: h.umaban,
      name: str(snapshot?.horsesByUmaban.get(h.umaban)?.name),
      prior: h.prior,
      adjustedProb: h.adjustedProb,
      placeOddsMin: h.placeOddsMin,
      ev: h.ev,
      isPositive: h.isPositive,
      mark: h.mark,
      reason: h.reason,
    })),
    allocation:
      allocation === undefined
        ? null
        : {
            route: allocation.route,
            skipReasonCode: allocation.skipReasonCode,
            unavailableReason: allocation.unavailableReason,
            bankroll: allocation.bankroll,
            perRaceCap: allocation.perRaceCap,
            kellyFraction: allocation.kellyFraction,
            evThreshold: allocation.evThreshold,
            includeComboOdds: allocation.includeComboOdds,
            includeWide: allocation.includeWide,
            includeTrio: allocation.includeTrio,
            includeQuinella: allocation.includeQuinella,
            includeExacta: allocation.includeExacta,
            includeTrifecta: allocation.includeTrifecta,
            includeBracketQuinella: allocation.includeBracketQuinella,
            oddsStatus: allocation.oddsStatus,
            bets: allocation.bets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })),
          },
    detail,
  };
}
