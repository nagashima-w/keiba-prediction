/**
 * 結果画面の表示用データ(Issue #185。純関数)。`view.ts` がこれを VNode にする。
 *
 * 見出し・分析時刻・分析モデル・馬ごとのカード(馬番・馬名・3着内率・複勝オッズの下限・EV)・配分。
 * 表示の決定(Issue #184 のゲート・#185):
 *  - **印は `mark` が non-null のときだけ**。印が1頭でもあれば(Issue #211: 印の付いた馬の一覧が空でなければ)、exe の凡例(`MARK_LEGEND`)を1行出す(「印の付いた馬」の見出しの下)。
 *    **印の付いた馬の一覧**(Issue #211): 印・馬番・馬名だけ。印の順(◎〇▲△☆注)→ 馬番の昇順。印の無い馬は含めず、未知の印は既知の印の後ろ
 *  - **補正後の3着内率・根拠は、LLM が効いたとき(モデル ID があるとき)だけ**出す(Issue #195。exe は LLM なしでも「3着内率」「AI補正後」を常に両方出すが、cloud はスマホの縦カードで、
 *    LLM なしでは補正後が 3着内率〈prior〉と同じ値になり同じ値が重なるだけなので省く。LLM を使うと EV は補正後の確率から計算されるので、効いたときは両方出して EV と噛み合わせる)。
 *    根拠が null・空の馬は、その行を出さない
 *  - **強調材料・懸念事項は、根拠と同じく LLM が効いたとき(モデル ID があるとき)だけ**出す(Issue #198)。空(項目なし・空文字だけ)なら、その塊ごと出さない
 *  - **LLM の所要時間・usage は、記録(`llmCalls`)があれば、モデルの有無に関係なく**出す(Issue #198。全回が失敗してフォールバックした分析でも、時間と失敗の回数を確かめたい)。集計は `llm-usage.ts`
 *  - 分析モデルが null(または空)なら「LLM 未使用(統計のみ)」。**理由(`llmNote`)は、モデルの有無に関係なく null でなければ出す**(キー未登録・フォールバック・印の制約違反。固定文言)
 *  - EV プラスの強調はサーバの `isPositive` に従う(クライアントで EV から再計算しない)。推定 EV(`evEstimated`)は接尾辞「(推定)」で区別する
 *  - 配分は exe の `buildAllocationProposalView` を流用する(文言・券種ラベル・実効設定を exe と揃える)。**配分の行が無い(null)ときは、exe の関数を呼ばず cloud 専用の文言**
 *    (exe の「記録なし」は「Issue #59より前の分析です」と言い、cloud では事実と違うため)
 *  - 配分が `unset` で**両方(総資金・1レース上限)が未設定**のときも、注記だけ cloud 専用にする(exe の `BET_ALLOCATION_UNSET_NOTE` は「設定画面で入力」と言うが、cloud に設定画面は無い)。
 *    片方だけ・判定不能の注記(設定画面に触れていない)は exe のまま。差し替えは、exe から import した定数との一致で行う(文言を変えても追従する。exe の判定の二重持ちを避ける)
 *  - **3着内率の上位5頭**(Issue #240。「印の付いた馬」の直後。印が無くても出す): 馬番・馬名・率・印。**LLM が効いたとき(モデル ID があるとき)は補正後の3着内率(`adjustedProb`)で並べ、見出しは「AI補正後の3着内率 上位5頭」、
 *    効いていないときは3着内率(`prior`)で並べ、見出しは「3着内率 上位5頭」**(率がどちらの値かを見出しで取り違えない)。並びは率(生の数値)の降順 → 同率は馬番の昇順。5頭未満なら全頭。率が非有限の馬は除き、全頭が欠けていれば出さない
 * ⚠️ このファイルが exe の renderer を import する唯一の層(`format.ts`・`allocation-proposal-view.ts`)。許可リストは `test/client-bundle.test.ts`。
 */
import { buildAllocationProposalView, type AllocationBetRowView, type AllocationProposalViewKind } from "../../packages/app/src/renderer/allocation-proposal-view";
import { BET_ALLOCATION_UNSET_NOTE } from "../../packages/app/src/renderer/bet-allocation-view";
import { formatEstimatedEvSuffix, formatEv, formatOdds, formatPercent, LABEL_ADJUSTED_PROB, LABEL_CONCERNS, LABEL_HIGHLIGHTS, LABEL_PRIOR, MARK_LEGEND } from "../../packages/app/src/renderer/format";
import type { AnalysisDetail } from "./api-analysis";
import { formatJstDateTime, isRealYmd } from "./date";
import { buildLlmUsage, type LlmUsageView } from "./llm-usage";
import { buildHash, type Route } from "./route";

/** 画面のラベル(exe の共有定数。`view.ts` は renderer を import しない=ここを通す)。 */
export { LABEL_ADJUSTED_PROB, LABEL_CONCERNS, LABEL_HIGHLIGHTS, LABEL_PRIOR };

export type ResultSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly analysis: AnalysisDetail };

export const NO_ALLOCATION_NOTE = "この分析には配分の記録がありません。";
/**
 * exe の `BET_ALLOCATION_UNSET_NOTE`(両方が未設定のときの注記。「設定画面で…入力してください」)の cloud 専用の代わり。exe の「設定画面」は cloud には無い(cloud の設定は、トップの「設定」〈`#settings`。Issue #189〉)うえ、
 * 既定値は 0 なので cloud の分析はほぼ全件がこの状態になり、cloud の画面と違う場所・呼び名へ誘導してしまう。**両方が未設定のときの文**なので、片方だけ・判定不能には使わない。
 */
export const UNSET_ALLOCATION_NOTE =
  "配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です(トップの「設定」から入れられます)。";
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
  /** 補正後の3着内率(「25.0%」)。**LLM が効いたとき(モデル ID があるとき)だけ**。LLM なしでは prior と同じ値になるので null(重複して出さない)。 */
  readonly adjusted: string | null;
  /** LLM の根拠。LLM が効いていて、根拠が空でないときだけ(null・空文字は null)。 */
  readonly reason: string | null;
  /** LLM の強調材料(各最大3項目)。**LLM が効いたとき(モデル ID があるとき)だけ**。空文字・空白だけの項目は捨てる。無ければ `[]`(塊ごと出さない)。外から来た文字列(画面ではテキストとしてだけ入れる)。 */
  readonly highlights: readonly string[];
  /** LLM の懸念事項(仕様は highlights と同じ)。 */
  readonly concerns: readonly string[];
  /** 複勝オッズの下限(欠損は「-」)。 */
  readonly odds: string;
  /** EV(欠損は「-」。推定なら接尾辞「(推定)」)。 */
  readonly ev: string;
  /** EV プラスの強調(サーバの `isPositive`)。 */
  readonly positive: boolean;
}

/** 印の付いた馬の一覧の1行(Issue #211)。印・馬番・馬名だけ(数値は出さない)。 */
export interface MarkedHorse {
  readonly umaban: number;
  /** 馬名。null・空文字は null(印と馬番だけを出す)。 */
  readonly name: string | null;
  readonly mark: string;
}

/**
 * 印の並び順(Issue #211)。**正は core の `PREDICTION_MARKS`**(◎〇▲△☆注。「〇」は U+3007)。クライアントの束に core の parse-response を引き込まない(`test/client-bundle.test.ts` の許可リストを広げない)ため、
 * ここに同じ順序を持ち、`test/client-result.test.ts` が `PREDICTION_MARKS` と一致することを固定する。
 */
export const KNOWN_MARK_ORDER: readonly string[] = ["◎", "〇", "▲", "△", "☆", "注"];

/** 3着内率の上位5頭の1行(Issue #240)。 */
export interface TopProbHorse {
  readonly umaban: number;
  /** 馬名。null・空文字は null(馬番と率と印だけを出す)。 */
  readonly name: string | null;
  /** 率(`formatPercent`。カードと同じ書式)。見出しが言う値(LLM が効いたときは補正後、効いていないときは 3着内率)。 */
  readonly rate: string;
  /** 印。`markedHorses` と同じ基準(null・空白だけは null、他は未知の印もそのまま)。 */
  readonly mark: string | null;
}

/** 3着内率の上位5頭(Issue #240)。見出しと行。 */
export interface TopProbs {
  readonly heading: string;
  readonly rows: readonly TopProbHorse[];
}

/** 上位に出す頭数(Issue #240)。 */
export const TOP_PROB_COUNT = 5;

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
  /** LLM が使われなかった・一部しか使われなかった理由(サーバの固定文言)。モデルの有無に関係なく、null でなければ出す。 */
  readonly llmNote: string | null;
  /** LLM の所要時間・usage(要約の1行と警告。記録が無い〈呼ばなかった・旧い分析・空配列〉ときは null)。モデルの有無に関係なく、記録があれば出す。 */
  readonly llmUsage: LlmUsageView | null;
  /** 印の付いた馬の一覧(Issue #211)。印の順 → 馬番の昇順。印の無い馬(null・空白だけ)は含めない。未知の印は既知の印の後ろに馬番の昇順。 */
  readonly markedHorses: readonly MarkedHorse[];
  /** 印の凡例(exe の `MARK_LEGEND`)。**一覧が空でないときだけ**(「印の付いた馬」の見出しの下に出す)。 */
  readonly markLegend: string | null;
  /** 3着内率の上位5頭(Issue #240。印の付いた馬の直後)。率が有限な馬が1頭も無ければ null(節ごと出さない)。 */
  readonly topProbs: TopProbs | null;
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
  // exe の「両方未設定」の注記(import した定数と一致するもの)だけを差し替える。片方だけ・判定不能・フォールバックなどの他の注記と、注記の並び・件数は変えない。
  const notices = view.notices.map((n) => (n === BET_ALLOCATION_UNSET_NOTE ? UNSET_ALLOCATION_NOTE : n));
  return { kind: view.kind, notices, bets: view.bets, settingsRows: view.settingsRows };
}

/** 強調材料・懸念事項の項目(空文字・空白だけは捨てる。文字列は加工しない)。 */
const pointsOf = (items: readonly string[]): readonly string[] => items.filter((item) => item.trim() !== "");

/** 印の順位(既知の印は `KNOWN_MARK_ORDER` の添字、未知の印はその後ろ)。 */
const markRank = (mark: string): number => {
  const i = KNOWN_MARK_ORDER.indexOf(mark);
  return i === -1 ? KNOWN_MARK_ORDER.length : i;
};

/** 印の付いた馬の一覧(Issue #211)。印の順 → 馬番の昇順(同じ印・同じ馬番は入力順。`Array.prototype.sort` は安定)。 */
function markedHorsesOf(horses: AnalysisDetail["horses"]): MarkedHorse[] {
  return horses
    .flatMap((h) => (h.mark === null || h.mark.trim() === "" ? [] : [{ umaban: h.umaban, name: h.name === null || h.name === "" ? null : h.name, mark: h.mark }]))
    .sort((a, b) => markRank(a.mark) - markRank(b.mark) || a.umaban - b.umaban);
}

/**
 * 3着内率の上位5頭(Issue #240)。LLM が効いたとき(`llmEffective`)は `adjustedProb`、効いていないときは `prior` で並べる。率の降順 → 同率(生の数値が等しい)は馬番の昇順。
 * 非有限の率の馬は除く(API の解析が弾くので production では届かないが、純関数の契約として固定する)。
 */
function topProbsOf(horses: AnalysisDetail["horses"], llmEffective: boolean): TopProbs | null {
  const rateOf = (h: AnalysisDetail["horses"][number]): number => (llmEffective ? h.adjustedProb : h.prior);
  const rows = horses
    .filter((h) => Number.isFinite(rateOf(h)))
    .sort((a, b) => rateOf(b) - rateOf(a) || a.umaban - b.umaban)
    .slice(0, TOP_PROB_COUNT)
    .map((h) => ({
      umaban: h.umaban,
      name: h.name === null || h.name === "" ? null : h.name,
      rate: formatPercent(rateOf(h)),
      mark: h.mark === null || h.mark.trim() === "" ? null : h.mark,
    }));
  if (rows.length === 0) return null;
  return { heading: llmEffective ? `${LABEL_ADJUSTED_PROB}の3着内率 上位${TOP_PROB_COUNT}頭` : `${LABEL_PRIOR} 上位${TOP_PROB_COUNT}頭`, rows };
}

/** 結果の内容(結果画面と、レース画面の発走前のカード〈Issue #188〉が同じ変換を使う)。 */
export function contentOf(a: AnalysisDetail): ResultContent {
  // LLM が効いたか = モデル ID があるか(exe の `analysisModelText` と同じ扱い: null・空文字は「効いていない」)。サーバは、効かなかったときは model を null にして保存する。
  const llmEffective = a.model !== null && a.model !== "";
  const markedHorses = markedHorsesOf(a.horses);
  return {
    title: titleOf(a),
    analyzedAt: formatJstDateTime(a.analyzedAt),
    model: llmEffective ? a.model! : MODEL_NONE_TEXT,
    llmNote: a.llmNote,
    llmUsage: a.llmCalls !== null && a.llmCalls.length > 0 ? buildLlmUsage(a.llmCalls) : null,
    markedHorses,
    markLegend: markedHorses.length > 0 ? MARK_LEGEND : null,
    topProbs: topProbsOf(a.horses, llmEffective),
    detailNote: detailNoteOf(a.detail),
    horses: a.horses.map((h) => ({
      umaban: h.umaban,
      name: h.name,
      mark: h.mark,
      prior: formatPercent(h.prior),
      adjusted: llmEffective ? formatPercent(h.adjustedProb) : null,
      reason: llmEffective && h.reason !== null && h.reason !== "" ? h.reason : null,
      highlights: llmEffective ? pointsOf(h.highlights) : [],
      concerns: llmEffective ? pointsOf(h.concerns) : [],
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
