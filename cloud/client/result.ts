/**
 * 結果画面の表示用データ(Issue #185。純関数)。`view.ts` がこれを VNode にする。
 *
 * 見出し・分析時刻・分析モデル・馬ごとのカード(馬番・馬名・3着内率・複勝オッズの下限・EV)・配分。
 * 表示の決定(Issue #184 のゲート・#185):
 *  - **印は `mark` が non-null のときだけ**。**「AI補正後」は出さない**(LLM なしでは 3着内率〈prior〉と同じ値になるため。`adjustedProb` は画面に出さない)
 *  - 分析モデルが null なら「LLM 未使用(統計のみ)」
 *  - EV プラスの強調はサーバの `isPositive` に従う(クライアントで EV から再計算しない)。推定 EV(`evEstimated`)は接尾辞「(推定)」で区別する
 *  - 配分は exe の `buildAllocationProposalView` を流用する(文言・券種ラベル・実効設定を exe と揃える)。**配分の行が無い(null)ときは、exe の関数を呼ばず cloud 専用の文言**
 *    (exe の「記録なし」は「Issue #59より前の分析です」と言い、cloud では事実と違うため)
 *  - 配分が `unset`(未設定)のときも注記だけ cloud 専用にする(exe は「設定画面で入力」と言うが、cloud に設定画面は無い)。判定は exe の関数が返す `kind` で行う
 * ⚠️ このファイルが exe の renderer を import する唯一の層(`format.ts`・`allocation-proposal-view.ts`)。許可リストは `test/client-bundle.test.ts`。
 */
import { buildAllocationProposalView, type AllocationBetRowView, type AllocationProposalViewKind } from "../../packages/app/src/renderer/allocation-proposal-view";
import { formatEstimatedEvSuffix, formatEv, formatOdds, formatPercent } from "../../packages/app/src/renderer/format";
import type { AnalysisDetail } from "./api-analysis";
import { formatJstDateTime, isRealYmd } from "./date";
import { buildHash, type Route } from "./route";

export type ResultSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly analysis: AnalysisDetail };

export const NO_ALLOCATION_NOTE = "この分析には配分の記録がありません。";
/**
 * 配分が `unset`(総資金・1レース上限が未設定)のときの cloud 専用の注記。exe の `BET_ALLOCATION_UNSET_NOTE` は「設定画面で…入力してください」と言うが、
 * cloud には設定画面が無い(D1 の `cloud_settings` に直接入れる)うえ、既定値は 0 なので cloud の分析はほぼ全件が `unset` になり、存在しない画面へ誘導してしまう。
 */
export const UNSET_ALLOCATION_NOTE =
  "配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です(設定画面は今後追加します。現在は D1 の cloud_settings に入れます)。";
export const MODEL_NONE_TEXT = "LLM 未使用(統計のみ)";
export const DETAIL_MISSING_NOTE = "馬名などの詳細を取得できませんでした(取得の上限に達したか、保存された詳細が見つかりません)。";
export const DETAIL_NONE_NOTE = "この分析には詳細が保存されていません(馬名は表示されません)。";

export interface HorseCard {
  readonly umaban: number;
  readonly name: string | null;
  /** 印。`mark` が non-null のときだけ。 */
  readonly mark: string | null;
  /** 3着内率(prior。「52.3%」)。 */
  readonly prior: string;
  /** 複勝オッズの下限(欠損は「-」)。 */
  readonly odds: string;
  /** EV(欠損は「-」。推定なら接尾辞「(推定)」)。 */
  readonly ev: string;
  /** EV プラスの強調(サーバの `isPositive`)。 */
  readonly positive: boolean;
}

export interface AllocationSection {
  readonly kind: AllocationProposalViewKind | "none";
  readonly notices: readonly string[];
  readonly bets: readonly AllocationBetRowView[];
  readonly settingsRows: readonly string[];
}

export interface ResultContent {
  readonly title: string;
  readonly analyzedAt: string;
  readonly model: string;
  readonly detailNote: string | null;
  readonly horses: readonly HorseCard[];
  readonly allocation: AllocationSection;
}

export interface ResultModel {
  readonly kind: "result";
  readonly loading: boolean;
  readonly error: string | null;
  /** 取得できていないときは null。 */
  readonly content: ResultContent | null;
  /** 戻り先。内容があればそのレースの画面、無ければ一覧。 */
  readonly backHref: string;
}

function titleOf(a: AnalysisDetail): string {
  const { venueName, raceNumber, raceName } = a.race;
  const head = `${venueName ?? ""}${raceNumber === null ? "" : `${raceNumber}R`}`;
  const parts = [head, raceName ?? ""].filter((p) => p !== "");
  return parts.length === 0 ? `レース ${a.raceId}` : parts.join(" ");
}

function detailNoteOf(detail: AnalysisDetail["detail"]): string | null {
  return detail === "missing" ? DETAIL_MISSING_NOTE : detail === "none" ? DETAIL_NONE_NOTE : null;
}

function allocationOf(a: AnalysisDetail): AllocationSection {
  if (a.allocation === null) {
    return { kind: "none", notices: [NO_ALLOCATION_NOTE], bets: [], settingsRows: [] };
  }
  const view = buildAllocationProposalView(a.allocation);
  // 判定は exe の関数が返す kind(構造)で行う(文言の文字列比較はしない)。unset だけを差し替え、他の種類は exe の文言のまま。
  if (view.kind === "unset") {
    return { kind: view.kind, notices: [UNSET_ALLOCATION_NOTE], bets: view.bets, settingsRows: view.settingsRows };
  }
  return { kind: view.kind, notices: view.notices, bets: view.bets, settingsRows: view.settingsRows };
}

function contentOf(a: AnalysisDetail): ResultContent {
  return {
    title: titleOf(a),
    analyzedAt: formatJstDateTime(a.analyzedAt),
    model: a.model ?? MODEL_NONE_TEXT,
    detailNote: detailNoteOf(a.detail),
    horses: a.horses.map((h) => ({
      umaban: h.umaban,
      name: h.name,
      mark: h.mark,
      prior: formatPercent(h.prior),
      odds: formatOdds(h.placeOddsMin),
      ev: h.ev === null ? formatEv(null) : `${formatEv(h.ev)}${formatEstimatedEvSuffix(a.evEstimated)}`,
      positive: h.isPositive,
    })),
    allocation: allocationOf(a),
  };
}

/** そのレースの画面へ戻るハッシュ。日付は分析の開催日(`kaisaiDate`)を優先する(ハッシュの日付は、直接開いたときは既定の「今日」のことがある)。 */
function backToRace(route: Route, a: AnalysisDetail): string {
  const date = a.kaisaiDate !== null && isRealYmd(a.kaisaiDate) ? a.kaisaiDate : route.date;
  const race = /^[0-9]{12}$/.test(a.raceId) ? a.raceId : null;
  return buildHash({ date, venue: route.venue, race });
}

export function buildResultModel(input: { readonly route: Route; readonly source: ResultSource }): ResultModel {
  const { route, source } = input;
  const listHref = buildHash({ date: route.date, venue: route.venue });
  if (source.kind === "ready") {
    return { kind: "result", loading: false, error: null, content: contentOf(source.analysis), backHref: backToRace(route, source.analysis) };
  }
  return {
    kind: "result",
    loading: source.kind === "loading",
    error: source.kind === "error" ? source.message : null,
    content: null,
    backHref: listHref,
  };
}
