/**
 * `GET /api/analyses/{id}` の応答の整形(Issue #183〈#165-a〉)。純関数だけで、D1・R2 には触れない。
 *
 * **画面に必要なものだけ**を、許可したキーで明示的に組み立てる(`...analysis` のような展開は使わない)。返さないもの:
 * `rawResponse`〈の本文〉・馬の `contributions`・raceSnapshot の全体(騎手・調教師・オッズ・組合せオッズなど)・追加指示・戦績の基準日。
 * (`rawResponse` から取り出した LLM の展開予想と想定ペースだけは `development` として返す〈Issue #315。core の `extractDevelopment`。他の項目は返さない〉。)
 * (単勝オッズ〈馬ごとの `winOdds` だけ〉とオッズの状態〈`race.oddsStatus`〉は Issue #247 で返すようにした。馬ごとの勝率・想定単勝オッズも同じ Issue で足した〈D1 の補正後の3着内率から計算〉。
 * 複勝オッズの下限・上限〈馬ごとの `actualPlaceOddsMin`・`actualPlaceOddsMax`〉と、想定複勝オッズ〈`fairPlaceOdds`〉・想定の基準〈`race.placeBasis`〉は Issue #253 で足した。組合せオッズは返さない。)
 * (配分の `fallbackReason`・`betUnit` は Issue #185 で返すようにした。core の `buildAllocationProposalView` に渡すと、これが無いとフォールバックの注記が消え、`cap-too-small` が「単位額が記録されていません」と誤って表示されるため)。
 * 馬名・レース名・天候などは raceSnapshot(R2 の詳細。`detail` が `present` のときだけ入る)から、場名・R は raceId から導く。
 * **`detail` が present でないとき(柵に達した・R2 に無い・詳細なし)は、スナップショットを使わず**(馬名は null)、同じキーの形で返す。
 *
 * raceSnapshot は書き込み側(`buildRaceSnapshot`)の形だが、JSON から復元しただけで型は検証されていない。読み出しは `toSafeRaceSnapshot`(欠損・不正で投げない)に任せ、
 * 値は文字列・有限の数だけに絞る(それ以外は null)。書き込み側との食い違いは、`test/analysis-view.test.ts` の drift のテストが検出する。
 */
import { dayBabaLines, normalizeDayBaba } from "../../packages/core/src/analyzer/day-baba";
import { buildRaceDevelopment, type LegStyle, type PaceEstimate } from "../../packages/core/src/analyzer/leg-style";
import { extractDevelopment, type LlmPace } from "../../packages/core/src/analyzer/parse-response";
import { toSafeRaceSnapshot } from "../../packages/core/src/analysis/analysis-export";
import { venueNameFromRaceId } from "../../packages/core/src/analysis/venue-codes";
import { isUsableOdds } from "../../packages/core/src/ev/allocation-primitives";
import type { StoredAllocation } from "../../packages/core/src/ev/analysis-store-types";
import { estimateFairWinOdds } from "../../packages/core/src/ev/win-odds-estimate";
import type { PlaceOddsBasis } from "../../packages/core/src/ev/place-odds-estimate";
import type { AnalysisDetailResult, DetailStatus } from "./analysis-repository";
import type { LlmCallRecord } from "./llm-calls";
import { buildComboCountLines } from "./combo-counts-view";
import { courseTurnOf, type CourseTurn } from "./course-turn";
import { estimatePlaceOddsForRace } from "./place-odds-view";

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
  /**
   * 想定複勝オッズ(Issue #253。払戻率 0.8 ÷ 複勝の的中率。地方も 0.8 と仮定した概算)。的中率は `race.placeBasis` が top3 なら補正後の3着内率、top2(出走5〜7頭)なら2着内率。
   * 的中率が 0・判定不能・複勝が発売されない頭数(4頭以下)は null。1.0 倍未満の値もそのまま返す(丸めない。「1.0倍未満」の表示は画面側)。D1 の値だけから計算するので、詳細〈R2〉の状態に依らない。
   */
  readonly fairPlaceOdds: number | null;
  /**
   * 分析時点の実際の複勝オッズの下限(Issue #253。raceSnapshot〈R2〉の `placeOddsMin`)。詳細が present でない・未確定・発売前〈複勝が未発売〉・不正(有限でない・1.0 未満)は null。
   * D1 の `placeOddsMin`(EV の計算に使った値。発売前は単勝からの推定)とは別の値で、スナップショットの生の値。
   */
  readonly actualPlaceOddsMin: number | null;
  /** 分析時点の実際の複勝オッズの上限(Issue #253。raceSnapshot の `placeOddsMax`)。**上限を保存する前の過去の分析は null**(下限だけ出る)。仕様は下限と同じ。 */
  readonly actualPlaceOddsMax: number | null;
  /**
   * スタート直後の位置(Issue #311。レース再生の演出用。0〜1 で小さいほど前)。近走の第1コーナーの通過順位 ÷ 出走頭数の平均(分析の時点で計算してスナップショットに保存した値)。
   * 戦績が取れない馬・**Issue #311 より前の分析**・詳細が present でない・範囲外の値は null。確率・配分には使わない。`buildAnalysisView` は常にキーを持つ。型で省略可なのは、この項目を使わない呼び出し側の固定データ(日報の材料など)を壊さないため。
   */
  readonly earlyPos?: number | null;
  /**
   * 脚質(Issue #314。レース再生の隊列を脚質で決める演出用)。プロンプトの展開想定と同じ分類・同じ参照走数(分析の時点で計算してスナップショットに保存した値)。
   * 戦績が取れない馬・**Issue #314 より前の分析**・詳細が present でない・4 値以外の値は null。確率・配分には使わない。`buildAnalysisView` は常にキーを持つ(型で省略可な理由は `earlyPos` と同じ)。
   */
  readonly legStyle?: LegStyle | null;
}

export interface AnalysisViewRace {
  /** 場名(raceId の場コードから)。導けなければ null。 */
  readonly venueName: string | null;
  /** レース番号(raceId の末尾2桁から)。導けなければ null。 */
  readonly raceNumber: number | null;
  readonly raceName: string | null;
  /** グレード(Issue #250。raceSnapshot の `race.grade`。"G1"〜"G3"・"J・G1"〜"J・G3"・地方の "Jpn1" や "重賞" など生の値。何を表示するかは画面側〈client/grade.ts〉が決める)。過去の分析・詳細なし・文字列でないときは null。 */
  readonly grade: string | null;
  readonly startTime: string | null;
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly weather: string | null;
  readonly trackCondition: string | null;
  /** 分析時点のオッズの状態(Issue #247。result=確定・middle=発売中〈暫定〉・yoso=発売前〈予想〉。raceSnapshot から。詳細が無いときは null)。 */
  readonly oddsStatus: string | null;
  /**
   * 想定複勝オッズの基準(Issue #253)。出走8頭以上は "top3"(3着内率)・5〜7頭は "top2"(複勝が2着まで。2着内率)・4頭以下(複勝が発売されない)と馬が0頭は null(想定は出さない)。
   * 画面が「2着まで」を添える・複勝の行を「-」にするのに使う。分析した馬の数から決まり、詳細〈R2〉の状態に依らない。
   */
  readonly placeBasis: PlaceOddsBasis | null;
  /** コースの回り(Issue #311。レース再生のコース図の向き。raceId の場コードと距離から `courseTurnOf` で決める。不明は "right")。詳細〈R2〉の状態に依らないが、大井の 1650m の特例は距離が要るので詳細が無いと右になる。`buildAnalysisView` は常にキーを持つ(型で省略可なのは `earlyPos` と同じ理由)。 */
  readonly turn?: CourseTurn;
  /**
   * 想定ペース(Issue #314。レース再生の隊列の長さ・動き出しの演出用)。**プロンプトの展開想定と同じ判定**(core の `buildRaceDevelopment` の `pace`。逃げ馬の頭数から。脚質の判定できた馬が 1 頭もいなければ「不明」)に、
   * スナップショットの馬ごとの脚質を渡して求める。詳細が present でない・古い分析〈脚質のキーが無い〉は「不明」。確率・配分には使わない(着順の抽選も変えない)。`buildAnalysisView` は常にキーを持つ。
   * **Issue #315 以降は、LLM が展開予想して出した想定ペース〈`development.pace`〉があればそれを使う**(出どころは `paceSource`)。無いとき(LLM を使わなかった・古い分析・LLM が pace を出さなかった)は上の規則の値。
   */
  readonly pace?: PaceEstimate;
  /**
   * `pace` の出どころ(Issue #315)。"llm" = LLM が展開予想して出した想定ペース(`AnalysisView.development.pace`)、"rule" = 従来の規則の値
   * (プロンプトの展開想定と同じ判定。LLM を使わなかった・古い分析・LLM が pace を出さなかった〈全頭脚質不明など〉・詳細が present でないとき)。`buildAnalysisView` は常にキーを持つ。
   */
  readonly paceSource?: PaceSource;
}

/** `race.pace` の出どころ(Issue #315)。 */
export type PaceSource = "llm" | "rule";

/** LLM の展開予想と想定ペース(Issue #315)。保存済みの生応答〈R2〉から取り出した、画面に出してよい項目だけ。 */
export interface AnalysisViewDevelopment {
  /** 展開予想の短文(core が 500 コードポイントで切る)。無ければ null。 */
  readonly text: string | null;
  /** LLM の想定ペース。「スロー」「平均」「ハイ」以外・無しは null。 */
  readonly pace: LlmPace | null;
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

/** そのとき LLM が見た当日の馬場の値(Issue #295)。LLM のプロンプトと同じ整形(`dayBabaLines`)の行だけ。 */
export interface AnalysisViewBaba {
  readonly lines: readonly string[];
}

/** 組合せの券種ごとの行(Issue #296。「配分の提案」の下)。サーバが組み立てた文章の行だけ。 */
export interface AnalysisViewCombos {
  readonly lines: readonly string[];
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
  /**
   * そのとき LLM が見た当日の馬場の値(Issue #295。クッション値・含水率・使用コース・芝の状態の文章)。raceSnapshot〈R2〉の `baba` から、LLM のプロンプトと同じ整形の行だけを返す
   * (生の列・余計なキーは返さない)。**詳細が present でない・値が無い(地方・LLM を使わない分析・計測が無い日・Issue #295 より前の分析)・不正な値は null**。画面は null なら何も出さない。`buildAnalysisView` は常にキーを持つ(null を含む)。型で省略可なのは、日報の材料などこの項目を使わない呼び出し側の固定データ(Issue #295 より前の形)を壊さないため。
   */
  readonly baba?: AnalysisViewBaba | null;
  /**
   * 組合せの券種(ワイド・馬連・枠連・馬単・三連複・三連単)ごとの「オッズの取得点数・EV プラスの点数・配分の点数」の行(Issue #296)。raceSnapshot〈R2〉の `comboOdds`・各 `*Combo`・`comboStats` と
   * D1 の配分から作る(`combo-counts-view.ts`)。**詳細が present でない・組合せの記録が無い〈取得 OFF の分析など〉は null**。Issue #296 より前の分析は EV プラスと理由の部分だけが無い(取得と配分の点数は出る)。
   * 画面は null なら何も出さない。オッズの写像・診断の中身は返さない(行だけ)。`buildAnalysisView` は常にキーを持つ。型で省略可なのは、この項目を使わない呼び出し側の固定データを壊さないため。
   */
  readonly combos?: AnalysisViewCombos | null;
  /**
   * LLM の展開予想と想定ペース(Issue #315)。保存済みの生応答〈R2。`rawResponse`〉から core の `extractDevelopment` で取り出す。**生応答の本文は返さない**(この2項目だけ)。
   * **詳細が present でない・LLM を使わなかった・古い分析〈Issue #315 より前の版は development・pace を出さない〉・読めない応答・どちらも取り出せない場合は null。** 画面は null なら何も出さない。
   * `buildAnalysisView` は常にキーを持つ(null を含む)。型で省略可なのは、この項目を使わない呼び出し側の固定データを壊さないため。
   */
  readonly development?: AnalysisViewDevelopment | null;
  readonly horses: readonly AnalysisViewHorse[];
  /** 配分(D1 の配分の行が無ければ null)。 */
  readonly allocation: AnalysisViewAllocation | null;
  readonly detail: DetailStatus;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** スタート直後の位置(Issue #311)。0〜1 の有限の数だけ。それ以外(null・文字列・範囲外)は null。 */
function earlyPosOf(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

const LEG_STYLES: readonly LegStyle[] = ["逃げ", "先行", "差し", "追込"];

/** 脚質(Issue #314)。4 値の文字列だけ。それ以外(null・数・知らない文字列)は null。 */
function legStyleOf(value: unknown): LegStyle | null {
  return LEG_STYLES.find((s) => s === value) ?? null;
}

/**
 * 想定ペース(Issue #314)。プロンプトの展開想定と同じ `buildRaceDevelopment` に、スナップショットの全馬の脚質を渡す
 * (ペースは逃げ馬の頭数と「脚質が全頭不明か」だけで決まる。安定度・先行力・開催区分・馬場は「恵まれる脚質」の表にしか効かないので渡さない)。
 */
function paceOf(snapshot: ReturnType<typeof toSafeRaceSnapshot> | null): PaceEstimate {
  if (snapshot === null) {
    return "不明";
  }
  const horses = [...snapshot.horsesByUmaban.values()].map((h) => ({ umaban: h.umaban, style: legStyleOf(h.legStyle), stability: "不明" as const, frontRunningScore: null }));
  return buildRaceDevelopment(horses).pace;
}

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

/** スナップショットの `baba` を検証・正規化して、プロンプトと同じ整形の行にする。無い・不正は null。 */
function babaViewOf(rawSnapshot: unknown): AnalysisViewBaba | null {
  if (typeof rawSnapshot !== "object" || rawSnapshot === null) {
    return null;
  }
  const baba = normalizeDayBaba((rawSnapshot as Record<string, unknown>)["baba"]);
  return baba === null ? null : { lines: dayBabaLines(baba) };
}

/** スナップショットと配分から、組合せの券種ごとの行を作る。材料が無ければ null。 */
function combosViewOf(rawSnapshot: unknown, allocation: StoredAllocation | undefined): AnalysisViewCombos | null {
  const lines = buildComboCountLines(rawSnapshot, allocation);
  return lines === null ? null : { lines };
}

export function buildAnalysisView(result: AnalysisDetailResult, allocation: StoredAllocation | undefined): AnalysisView {
  const { analysis, detail } = result;
  // 詳細が present でないときは、スナップショットを一切使わない(馬名なしの同じ形で返す)。
  const snapshot = detail === "present" ? toSafeRaceSnapshot(analysis.raceSnapshot) : null;
  const race = snapshot?.race;
  // 想定単勝オッズ(Issue #247): 配分の単勝候補と同じ関数(`estimateFairWinOdds`)で、D1 の補正後の3着内率から。throw しない(判定不能は null)。
  const fairByUmaban = new Map(estimateFairWinOdds(analysis.horses.map((h) => ({ umaban: h.umaban, placeProb: h.adjustedProb }))).map((e) => [e.umaban, e]));
  // 想定複勝オッズ(Issue #253): 出走頭数で基準(3着内率・2着内率・出さない)を決め、D1 の補正後の3着内率から。throw しない。
  const placeOdds = estimatePlaceOddsForRace(analysis.horses);
  // LLM の展開予想と想定ペース(Issue #315): 詳細が present のときだけ(スナップショットと同じく、present でないときは生応答を使わない)。
  const extracted = detail === "present" && analysis.rawResponse !== null ? extractDevelopment(analysis.rawResponse) : { development: null, pace: null };
  const development: AnalysisViewDevelopment | null = extracted.development === null && extracted.pace === null ? null : { text: extracted.development, pace: extracted.pace };
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
      grade: str(race?.grade),
      startTime: str(race?.startTime),
      courseType: str(race?.courseType),
      distance: num(race?.distance),
      weather: str(race?.weather),
      trackCondition: str(race?.trackCondition),
      oddsStatus: str(race?.oddsStatus),
      placeBasis: placeOdds.basis,
      turn: courseTurnOf(analysis.raceId, num(race?.distance)),
      // 想定ペース: LLM の値があればそれ(Issue #315)、無ければ従来の規則の値(Issue #314)。
      pace: extracted.pace ?? paceOf(snapshot),
      paceSource: extracted.pace === null ? "rule" : "llm",
    },
    // 詳細が present でないときは、スナップショットを一切使わない(null)。
    baba: detail === "present" ? babaViewOf(analysis.raceSnapshot) : null,
    combos: detail === "present" ? combosViewOf(analysis.raceSnapshot, allocation) : null,
    development,
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
      fairPlaceOdds: placeOdds.byUmaban.get(h.umaban) ?? null,
      actualPlaceOddsMin: usableOdds(snapshot?.horsesByUmaban.get(h.umaban)?.placeOddsMin),
      actualPlaceOddsMax: usableOdds(snapshot?.horsesByUmaban.get(h.umaban)?.placeOddsMax),
      earlyPos: earlyPosOf(snapshot?.horsesByUmaban.get(h.umaban)?.earlyPos),
      legStyle: legStyleOf(snapshot?.horsesByUmaban.get(h.umaban)?.legStyle),
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
