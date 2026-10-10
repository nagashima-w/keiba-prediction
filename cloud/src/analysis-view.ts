/**
 * `GET /api/analyses/{id}` の応答の整形(Issue #183〈#165-a〉)。純関数だけで、D1・R2 には触れない。
 *
 * **画面に必要なものだけ**を、許可したキーで明示的に組み立てる(`...analysis` のような展開は使わない)。返さないもの:
 * `rawResponse`・馬の `contributions`・raceSnapshot の全体(騎手・調教師・オッズ・組合せオッズなど)・追加指示・戦績の基準日。
 * (単勝オッズ〈馬ごとの `winOdds` だけ〉とオッズの状態〈`race.oddsStatus`〉は Issue #247 で返すようにした。ほかのオッズ〈組合せオッズ・複勝オッズ〉は返さない。馬ごとの勝率・想定単勝オッズも同じ Issue で足した〈D1 の補正後の3着内率から計算〉。)
 * (配分の `fallbackReason`・`betUnit` は Issue #185 で返すようにした。exe の `buildAllocationProposalView` に渡すと、これが無いとフォールバックの注記が消え、`cap-too-small` が「単位額が記録されていません」と誤って表示されるため)。
 * 馬名・レース名・天候などは raceSnapshot(R2 の詳細。`detail` が `present` のときだけ入る)から、場名・R は raceId から導く。
 * **`detail` が present でないとき(柵に達した・R2 に無い・詳細なし)は、スナップショットを使わず**(馬名は null)、同じキーの形で返す。
 *
 * raceSnapshot は書き込み側(`buildRaceSnapshot`)の形だが、JSON から復元しただけで型は検証されていない。読み出しは `toSafeRaceSnapshot`(欠損・不正で投げない)に任せ、
 * 値は文字列・有限の数だけに絞る(それ以外は null)。書き込み側との食い違いは、`test/analysis-view.test.ts` の drift のテストが検出する。
 */
import { toSafeRaceSnapshot } from "../../packages/app/src/main/analysis-export";
import { venueNameFromRaceId } from "../../packages/app/src/main/venue-codes";
import { isUsableOdds } from "../../packages/core/src/ev/allocation-primitives";
import type { StoredAllocation } from "../../packages/core/src/ev/analysis-store-types";
import { estimateFairWinOdds } from "../../packages/core/src/ev/win-odds-estimate";
import type { AnalysisDetailResult, DetailStatus } from "./analysis-repository";
import type { LlmCallRecord } from "./llm-calls";

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
  /** LLM が挙げた強調材料(Issue #197。各最大3項目の短い句。項目なし・旧い分析は `[]`。D1 の馬の行にあるので、詳細〈R2〉の状態に依らない)。 */
  readonly highlights: readonly string[];
  /** LLM が挙げた懸念事項(Issue #197。仕様は highlights と同じ)。 */
  readonly concerns: readonly string[];
  /**
   * 勝率の推定(Issue #247。0〜1)。**補正後の3着内率から推定した目安**で、LLM が勝率を直接判断した値ではない。配分の単勝候補と同じ関数・同じ入力(`adjustedProb`。LLM なしでは prior と同じ値)で計算する。
   * 判定不能(固定馬が2頭以上・頭数が2〜3頭・不正な確率)は null。D1 の値だけから計算するので、詳細〈R2〉の状態に依らない。
   */
  readonly winProb: number | null;
  /** 想定単勝オッズ(Issue #247。払戻率 0.8 ÷ 勝率。地方も 0.8 と仮定した概算)。勝率が 0・判定不能は null。 */
  readonly fairWinOdds: number | null;
  /**
   * 分析時点の実際の単勝オッズ(Issue #247。raceSnapshot〈R2〉の `winOdds`)。詳細が present でない・未確定・不正(有限でない・1.0 未満)は null。
   * オッズの状態が発売前〈yoso〉のときは予想値(`race.oddsStatus` で区別する)。
   */
  readonly winOdds: number | null;
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
  /** 分析時点のオッズの状態(Issue #247。result=確定・middle=発売中〈暫定〉・yoso=発売前〈予想〉。raceSnapshot から。詳細が無いときは null)。 */
  readonly oddsStatus: string | null;
}

export interface AnalysisViewAllocation {
  readonly route: string;
  readonly skipReasonCode: string | null;
  readonly unavailableReason: string | null;
  /** D-2 フォールバックの理由コード(複勝のみの配分になった理由。無ければ null)。 */
  readonly fallbackReason: string | null;
  /** 最小賭け金単位(円。記録が無ければ null)。`cap-too-small` の見送り文言に使う。 */
  readonly betUnit: number | null;
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
  /**
   * LLM が使われなかった・一部しか使われなかった理由(**固定文言**。D1 の `llm_note`。Issue #194)。問題なく効いたとき・旧い分析は null。
   * 画面(#195)が、モデル欄(`model` が null のとき)の近くに出す。API のエラーの本文は、そもそも保存していない。
   */
  readonly llmNote: string | null;
  /**
   * LLM を呼んだ1回ごとの記録(呼び出しの順。D1 の `llm_calls_json`。Issue #197 段2)。画面は #198。LLM を呼ばなかった(キー未登録)・旧い分析は null。
   * 費用(トークン数)・所要時間・切り詰め(`stopReason` が `max_tokens`)を確かめるための値で、プロンプト・応答の本文・エラーの本文は含まない。
   * 再生した呼び出し(`replayed:true`)の所要時間・トークンは元の呼び出しの値(課金は元の1回きり。合計に足すときは二重に数えない)。詳細(R2)の状態に依らず載る。
   */
  readonly llmCalls: readonly LlmCallRecord[] | null;
  readonly race: AnalysisViewRace;
  readonly horses: readonly AnalysisViewHorse[];
  /** 配分(D1 の配分の行が無ければ null)。 */
  readonly allocation: AnalysisViewAllocation | null;
  readonly detail: DetailStatus;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** 実際の単勝オッズ。有限の数で、配分の候補ビルダーと同じ基準(`isUsableOdds`。1.0 以上)を満たすものだけ。それ以外(未確定の null・文字列・NaN・1.0 未満)は null。 */
function usableOdds(value: unknown): number | null {
  const n = num(value);
  return n !== null && isUsableOdds(n) ? n : null;
}

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
  // 想定単勝オッズ(Issue #247): 配分の単勝候補と同じ関数(`estimateFairWinOdds`)で、D1 の補正後の3着内率から。throw しない(判定不能は null)。
  const fairByUmaban = new Map(estimateFairWinOdds(analysis.horses.map((h) => ({ umaban: h.umaban, placeProb: h.adjustedProb }))).map((e) => [e.umaban, e]));
  return {
    id: analysis.id,
    raceId: analysis.raceId,
    analyzedAt: analysis.analyzedAt,
    kaisaiDate: analysis.kaisaiDate,
    evEstimated: analysis.evEstimated,
    model: analysis.model,
    promptVersion: analysis.promptVersion,
    llmNote: result.llmNote,
    // 許可したキーを明示して写す(保存した値の余計な項目は載せない)。配列も要素も複製する。
    llmCalls:
      result.llmCalls === null
        ? null
        : result.llmCalls.map((c) => ({ ok: c.ok, ms: c.ms, inputTokens: c.inputTokens, outputTokens: c.outputTokens, stopReason: c.stopReason, model: c.model, replayed: c.replayed, error: c.error })),
    race: {
      venueName: venueNameOf(analysis.raceId),
      raceNumber: raceNumberOf(analysis.raceId),
      raceName: str(race?.raceName),
      startTime: str(race?.startTime),
      courseType: str(race?.courseType),
      distance: num(race?.distance),
      weather: str(race?.weather),
      trackCondition: str(race?.trackCondition),
      oddsStatus: str(race?.oddsStatus),
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
      highlights: [...h.highlights],
      concerns: [...h.concerns],
      winProb: fairByUmaban.get(h.umaban)?.winProb ?? null,
      fairWinOdds: fairByUmaban.get(h.umaban)?.fairWinOdds ?? null,
      winOdds: usableOdds(snapshot?.horsesByUmaban.get(h.umaban)?.winOdds),
    })),
    allocation:
      allocation === undefined
        ? null
        : {
            route: allocation.route,
            skipReasonCode: allocation.skipReasonCode,
            unavailableReason: allocation.unavailableReason,
            fallbackReason: allocation.fallbackReason,
            betUnit: allocation.betUnit,
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
