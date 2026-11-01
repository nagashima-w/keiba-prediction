/**
 * 結果画面の表示用データ(Issue #185。純関数)。`view.ts` がこれを VNode にする。
 *
 * 見出し・分析時刻・分析モデル・馬ごとのカード(馬番・馬名・3着内率・複勝オッズの下限・EV)・配分。
 * 表示の決定(Issue #184 のゲート・#185):
 *  - **印は `mark` が non-null のときだけ**。印が1頭でもあれば(Issue #211: 印の付いた馬の一覧が空でなければ)、core の凡例(`view/format.ts` の `MARK_LEGEND`)を1行出す(「印の付いた馬」の見出しの下)。
 *    **印の付いた馬の一覧**(Issue #211): 印・馬番・馬名だけ。印の順(◎〇▲△☆注)→ 馬番の昇順。印の無い馬は含めず、未知の印は既知の印の後ろ
 *  - **補正後の3着内率・根拠は、LLM が効いたとき(モデル ID があるとき)だけ**出す(Issue #195。旧 exe は LLM なしでも「3着内率」「AI補正後」を常に両方出していたが、cloud はスマホの縦カードで、
 *    LLM なしでは補正後が 3着内率〈prior〉と同じ値になり同じ値が重なるだけなので省く。LLM を使うと EV は補正後の確率から計算されるので、効いたときは両方出して EV と噛み合わせる)。
 *    根拠が null・空の馬は、その行を出さない
 *  - **強調材料・懸念事項は、根拠と同じく LLM が効いたとき(モデル ID があるとき)だけ**出す(Issue #198)。空(項目なし・空文字だけ)なら、その塊ごと出さない
 *  - **LLM の所要時間・usage は、記録(`llmCalls`)があれば、モデルの有無に関係なく**出す(Issue #198。全回が失敗してフォールバックした分析でも、時間と失敗の回数を確かめたい)。集計は `llm-usage.ts`
 *  - 分析モデルが null(または空)なら「LLM 未使用(統計のみ)」。**理由(`llmNote`)は、モデルの有無に関係なく null でなければ出す**(キー未登録・フォールバック・印の制約違反。固定文言)
 *  - EV プラスの強調はサーバの `isPositive` に従う(クライアントで EV から再計算しない)。推定 EV(`evEstimated`)は接尾辞「(推定)」で区別する
 *  - 配分は core の `buildAllocationProposalView`(`view/allocation-proposal-view.ts`。旧 exe と共有していた)を流用する(文言・券種ラベル・実効設定を旧 exe と揃える)。**配分の行が無い(null)ときは、その関数を呼ばず cloud 専用の文言**
 *    (その関数の「記録なし」は「Issue #59より前の分析です」と言い、cloud では事実と違うため)
 *  - 配分が `unset` で**両方(総資金・1レース上限)が未設定**のときも、注記だけ cloud 専用にする(core の `BET_ALLOCATION_UNSET_NOTE`〈`view/bet-allocation-view.ts`〉は「設定画面で入力」と言うが、cloud に設定画面は無い)。
 *    片方だけ・判定不能の注記(設定画面に触れていない)は core の文言のまま。差し替えは、core から import した定数との一致で行う(文言を変えても追従する。core の判定の二重持ちを避ける)
 *  - **3着内率の上位5頭**(Issue #240。「印の付いた馬」の直後。印が無くても出す): 馬番・馬名・率・印。**LLM が効いたとき(モデル ID があるとき)は補正後の3着内率(`adjustedProb`)で並べ、見出しは「AI補正後の3着内率 上位5頭」、
 *    効いていないときは3着内率(`prior`)で並べ、見出しは「3着内率 上位5頭」**(率がどちらの値かを見出しで取り違えない)。並びは率(生の数値)の降順 → 同率は馬番の昇順。5頭未満なら全頭。率が非有限の馬は除き、全頭が欠けていれば出さない
 *  - **組合せの券種ごとの行**(Issue #296。`combos`): 「配分の提案」の節の最後(設定の行の後)。オッズの取得点数・EV プラスの点数・配分の点数。サーバが文章にしたものをそのまま出す(クライアントに文言を置かない)。無ければ何も出さない
 *  - **AI の展開予想**(Issue #315。`development`): 「3着内率の上位5頭」の後・想定隊列図(Issue #362)の前の節。LLM が材料から予想した展開の短文と想定ペース。どちらか一方だけのこともある。LLM を使わない・旧い分析・詳細なしは節ごと出さない。
 *  - **そのとき LLM が見た当日の馬場の値**(Issue #295。`baba`): 「3着内率の上位5頭」の後・「馬ごとの評価」の前の節。行はサーバがプロンプトと同じ整形にしたもの。地方・LLM を使わない分析・計測が無い日・詳細なし・古い分析は null(節ごと出さない)
 *  - **統計モデルからの変化量**(Issue #312。`HorseCard.adjustedShift`・`TopProbHorse.shift`): 補正後の3着内率の横に「(統計比 +2.0pt)」。補正後 − prior を百分率の差(pt)で、小数第1位。符号は検証画面の補正幅(`formatAdjustment`)と同じ ASCII の「+」「-」で、
 *    丸めて 0.0 になる差(絶対値 0.05pt 未満)は「±0.0pt」。補正後を出さない(LLM が効いていない)分析・prior か補正後が非有限の馬は null(出さない)。上位5頭の行も同じ値(並べる値は補正後)
 *  - **タイム指数の行**(Issue #359。`HorseCard.timeIndexLine`・`timeIndexNote`): 馬のカードの複勝の行の下(根拠の上)に「タイム指数 +1.2(レース内 2位)」、説明の 1 行は「馬ごとの評価」の見出しの下に 1 回。文言は**サーバが組み立てたものをそのまま**出す(クライアントに日本語を置かない)。出さない分析は null
 * ⚠️ core の `view/` の純関数(`format.ts`・`allocation-proposal-view.ts`・`bet-allocation-view.ts`。旧 exe の画面と共有していた)を import する層。許可リストは `test/client-bundle.test.ts`。
 */
import { buildAllocationProposalView, type AllocationBetRowView, type AllocationProposalViewKind } from "../../packages/core/src/view/allocation-proposal-view";
import { BET_ALLOCATION_UNSET_NOTE } from "../../packages/core/src/view/bet-allocation-view";
import { formatEstimatedEvSuffix, formatEv, formatMarkRepair, formatOdds, formatPercent, LABEL_ADJUSTED_PROB, LABEL_CONCERNS, LABEL_HIGHLIGHTS, LABEL_PRIOR, MARK_LEGEND } from "../../packages/core/src/view/format";
import { markRank, PREDICTION_MARKS } from "../../packages/core/src/common/prediction-marks";
import type { AnalysisDetail } from "./api-analysis";
import { formatJstDateTime, isRealYmd } from "./date";
import { nameWithGrade } from "./grade";
import { formatAdjustment, formatYen } from "../../packages/core/src/view/verify-format";
import { actualWinOddsLabel, ACTUAL_HIGHER_MARK, buildWinOddsLine, FAIR_WIN_ODDS_LABEL, WIN_ODDS_NOTE, type WinOddsLine } from "../src/win-odds-format";
import { buildPlaceOddsLine, PLACE_ODDS_NOTE, type PlaceOddsLine } from "../src/place-odds-format";
import { buildLlmUsage, type LlmUsageView } from "./llm-usage";
import { buildFormation, type FormationSection } from "./formation-model";
import { buildHash, type Route } from "./route";

/** 画面のラベル(core の共有定数〈旧 exe と共有していた〉。`view.ts` は core を直接 import しない=ここを通す)。 */
export { LABEL_ADJUSTED_PROB, LABEL_CONCERNS, LABEL_HIGHLIGHTS, LABEL_PRIOR };
/** 単勝の想定・実際の表示の固定文言(Issue #247。Worker の Discord の通知と共有する `src/win-odds-format.ts`)。 */
export { ACTUAL_HIGHER_MARK, FAIR_WIN_ODDS_LABEL };

export type ResultSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly analysis: AnalysisDetail };

export const NO_ALLOCATION_NOTE = "この分析には配分の記録がありません。";
/**
 * core の `BET_ALLOCATION_UNSET_NOTE`(両方が未設定のときの注記。「設定画面で…入力してください」)の cloud 専用の代わり。旧 exe の「設定画面」は cloud には無い(cloud の設定は、トップの「設定」〈`#settings`。Issue #189〉)うえ、
 * 既定値は 0 なので cloud の分析はほぼ全件がこの状態になり、cloud の画面と違う場所・呼び名へ誘導してしまう。**両方が未設定のときの文**なので、片方だけ・判定不能には使わない。
 */
export const UNSET_ALLOCATION_NOTE =
  "配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です(トップの「設定」から入れられます)。";
/**
 * 閲覧者(Issue #238)向けの同じ注記。**設定への案内(括弧書き)を外した**固定文言。閲覧者は設定に入れない(設定は管理者だけ)ので、入れない場所へ誘導しない。
 * 総資金・1レース上限の値そのものは閲覧者にも見せてよい(利用者の判断)ので、直下の実効設定の行は役割で変えない。
 */
export const UNSET_ALLOCATION_NOTE_VIEWER =
  "配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です。";
/** 変化量の基準の呼び名(Issue #312。「(統計比 +2.0pt)」)。基準は統計モデルの3着内率(prior)。 */
export const LABEL_SHIFT_BASE = "統計比";
/** 変化量を画面に添える形(Issue #312。例「(統計比 +2.0pt)」)。カードの「AI補正後」の行と上位5頭の行で共通。 */
export const shiftNote = (shift: string): string => `(${LABEL_SHIFT_BASE} ${shift})`;
export const MODEL_NONE_TEXT = "LLM 未使用(統計のみ)";
export const DETAIL_MISSING_NOTE = "馬名などの詳細を取得できませんでした(取得の上限に達したか、保存された詳細が見つかりません)。";
export const DETAIL_NONE_NOTE = "この分析には詳細が保存されていません(馬名は表示されません)。";

export interface HorseCard {
  readonly umaban: number;
  readonly name: string | null;
  /** 印。`mark` が non-null のときだけ。 */
  readonly mark: string | null;
  /** 印を補修した馬の「元の印→今の印」(Issue #317。例「◎→〇」「☆→印なし」)。補修していない馬は null。画面は「直」の目印と一緒に印の横に出す。 */
  readonly markRepair: string | null;
  /** 3着内率(prior。「52.3%」)。 */
  readonly prior: string;
  /** 補正後の3着内率(「25.0%」)。**LLM が効いたとき(モデル ID があるとき)だけ**。LLM なしでは prior と同じ値になるので null(重複して出さない)。 */
  readonly adjusted: string | null;
  /** 補正後の統計モデル(prior)からの変化量(「+2.0pt」「-3.5pt」「±0.0pt」。Issue #312)。補正後を出すときだけ(`adjusted` が null なら null)。prior か補正後が非有限なら null。 */
  readonly adjustedShift: string | null;
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
  /**
   * 単勝の想定(目安)と実際(Issue #247)。LLM の有無に依らず出す(想定は補正後の3着内率から。LLM なしでは prior と同じ値)。勝率そのものは画面に出さない。
   * 実際のラベルは分析時点のオッズの状態(確定・暫定・予想)で変わる。強調(`higher`)は丸めた値どうしの比較。
   */
  readonly winOdds: WinOddsLine;
  /**
   * 複勝の想定(目安)と実際(下限〜上限。Issue #253)。LLM の有無に依らず出す(想定は補正後の3着内率から。5〜7頭は2着内率から)。見出しは出走5〜7頭のとき「複勝(2着まで)」。
   * 出走4頭以下(`race.placeBasis` が null)は想定も実際も「-」。強調(`higher`)は実際の**下限**と想定を丸めた値どうしで比べる(想定が 1.0倍未満のときは比べない)。
   */
  readonly placeOdds: PlaceOddsLine;
  /** タイム指数の行(Issue #359。サーバが組み立てた「タイム指数 +1.2(レース内 2位)」〈値のない馬は「タイム指数 —」〉をそのまま)。出さない分析・古いサーバの応答は null。LLM の有無・閲覧者かどうかに依らない。 */
  readonly timeIndexLine: string | null;
  /**
   * 馬ごとの評価の表の並べ替え用の数値(Issue #546-2)。**整形済みの文字列〈`prior`・`ev` など〉から読み戻さず**、`AnalysisHorse` の生の値から作る(「1.40(推定)」「1000倍超」を数に戻す処理を持たない)。
   * 値が無い(null)・非有限(NaN・Infinity)は null(並べ替えでは向きによらず末尾)。推定 EV(`evEstimated`)も実数が入る(値がある扱い)。`adjusted` は LLM が効いたときだけ(`adjusted` の文字列と同じ条件)。
   */
  readonly sortValues: HorseSortValues;
}

/** 並べ替え用の数値(`HorseCard.sortValues`)。馬番は `HorseCard.umaban`。 */
export interface HorseSortValues {
  readonly prior: number | null;
  readonly adjusted: number | null;
  readonly ev: number | null;
  readonly winOdds: number | null;
  readonly placeOddsMin: number | null;
}

/** 馬ごとの評価の表で並べ替えられる列(Issue #546-2。印・馬名は対象外)。 */
export type HorseSortKey = "umaban" | "prior" | "adjusted" | "ev" | "winOdds" | "placeOddsMin";
export type SortDir = "asc" | "desc";
/** 表の並べ替えの状態(`app.ts` が分析 id ごとにメモリに持つ。保存しない)。 */
export interface HorseSort {
  readonly key: HorseSortKey;
  readonly dir: SortDir;
}

/** 既定の並べ替え(馬番の昇順)。 */
export const DEFAULT_HORSE_SORT: HorseSort = { key: "umaban", dir: "asc" };

/** 列を初めて押したときの向き: 確率・EV は大きい順、馬番・オッズは小さい順。 */
export function firstSortDir(key: HorseSortKey): SortDir {
  return key === "prior" || key === "adjusted" || key === "ev" ? "desc" : "asc";
}

/** 列を押したあとの並べ替え。同じ列ならもう一度で向きが逆、別の列なら初めての向き。 */
export function nextHorseSort(current: HorseSort, key: HorseSortKey): HorseSort {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: firstSortDir(key) };
}

/** 馬ごとの評価の表の列(Issue #546-2)。`sort` が null の列(印・馬名)は並べ替えられない(ボタンにしない)。 */
export interface HorseTableColumn {
  readonly key: "mark" | "name" | HorseSortKey;
  readonly label: string;
  readonly sort: {
    readonly ariaSort: "ascending" | "descending" | "none";
    /** 今の並べ替えの列だけ「▲」(小さい順)・「▼」(大きい順)。色に頼らず文字で示す。ほかは空。 */
    readonly arrow: "▲" | "▼" | "";
    /** この列を押したあとの向き(`data-sort-dir`。ボタンの処理に渡す値を木に出す)。 */
    readonly nextDir: SortDir;
  } | null;
}

/** 馬ごとの評価の表(Issue #546-2。馬が 0 頭なら null)。`rows` は並べ替え済み(カードの `ResultContent.horses` は入力の順のまま)。 */
export interface HorseTable {
  /** 実際に使った並べ替え(要求された列が表に無い〈補正後の列が無い分析で補正後の並べ替え〉ときは既定に戻した値)。 */
  readonly sort: HorseSort;
  readonly columns: readonly HorseTableColumn[];
  readonly rows: readonly HorseCard[];
}

/** 印の付いた馬の一覧の1行(Issue #211)。印・馬番・馬名だけ(数値は出さない)。 */
export interface MarkedHorse {
  readonly umaban: number;
  /** 馬名。null・空文字は null(印と馬番だけを出す)。 */
  readonly name: string | null;
  readonly mark: string;
  /** 印を補修した馬の「元の印→今の印」(Issue #317)。補修していない馬は null。 */
  readonly markRepair: string | null;
}

/**
 * 印の並び順(Issue #211)。**core の `PREDICTION_MARKS`**(◎〇▲△☆注。「〇」は U+3007)そのもの。クライアントの束に core の parse-response を引き込まないため、
 * import のない共通部品 `common/prediction-marks.ts` から取る(Issue #397・R-5 で、ここに持っていた配列を寄せた)。`test/client-result.test.ts` が値を固定する。
 */
export const KNOWN_MARK_ORDER: readonly string[] = PREDICTION_MARKS;

/** 3着内率の上位5頭の1行(Issue #240)。 */
export interface TopProbHorse {
  readonly umaban: number;
  /** 馬名。null・空文字は null(馬番と率と印だけを出す)。 */
  readonly name: string | null;
  /** 率(`formatPercent`。カードと同じ書式)。見出しが言う値(LLM が効いたときは補正後、効いていないときは 3着内率)。 */
  readonly rate: string;
  /** 印。`markedHorses` と同じ基準(null・空白だけは null、他は未知の印もそのまま)。 */
  readonly mark: string | null;
  /** 印を補修した馬か(Issue #317)。画面は「直」だけを出す(元の印は出さない。印が消えた馬も true になりうる)。 */
  readonly repaired: boolean;
  /** 統計モデル(prior)からの変化量(`HorseCard.adjustedShift` と同じ値。Issue #312)。LLM が効いたときだけ(率が補正後のとき)。無ければ null。 */
  readonly shift: string | null;
}

/** 「そのとき LLM が見た当日の馬場の値」の節の見出し(Issue #295)。 */
export const BABA_HEADING = "AI に渡した当日の馬場(朝の計測値)";

/** 「AI の展開予想」の節の見出し(Issue #315)。 */
export const DEVELOPMENT_HEADING = "AI の展開予想";

/** 展開予想の節(Issue #315)。LLM が材料から予想した展開の短文と、決めた想定ペース。どちらか一方が無いこともある。 */
export interface DevelopmentSection {
  readonly heading: string;
  /** 展開予想の短文。無ければ null。 */
  readonly text: string | null;
  /** 想定ペースの行(「想定ペース(AI): ハイ」)。LLM が pace を出さなかった(全頭の脚質が不明など)ときは null。 */
  readonly paceLine: string | null;
}

/** 当日の馬場の節(Issue #295)。行はサーバがプロンプトと同じ整形にしたもの。 */
export interface BabaSection {
  readonly heading: string;
  readonly lines: readonly string[];
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
  /** 組合せの券種ごとの行(Issue #296。サーバが組み立てた文章。設定の行の後ろに出す)。無ければ空配列。 */
  readonly comboLines: readonly string[];
}

/** 締切直前の再計算の節の見出し(Issue #344)。 */
export const CLOSE_HEADING = "締切直前の再計算";

/** 締切直前の再計算の 1 回ぶん(Issue #344)。 */
export interface CloseRoundSection {
  readonly heading: string;
  /** 状態と理由・動いた時刻と遅れ(表の前)。 */
  readonly summaryLines: readonly string[];
  /** 配分の注記(再計算できた回だけ。見送りの理由など)。 */
  readonly notices: readonly string[];
  /** 買い目の表(再計算できた回で、買い目があるときだけ)。 */
  readonly bets: readonly AllocationBetRowView[];
  /** 分析時の提案との差分の行(表の後)。 */
  readonly diffLines: readonly string[];
}

export interface CloseSection {
  readonly heading: string;
  readonly note: string;
  readonly rounds: readonly CloseRoundSection[];
}

/**
 * 結果の先頭の要約(Issue #546)。材料はクライアントのモデルにすでにある値だけ(サーバの応答は変えない)。文はクライアントで組み立てる。
 * 印の付いた馬は `ResultContent.markedHorses` を、画面(`view.ts`)が同じ部品で出す(ここには重ねて持たない)。買い目は**最新の配分**を持つ(`bets`)。
 */
export interface SummarySection {
  /** 「発走時刻: 15:45」。値の無い(null・空・空白だけの)分析は null(行ごと出さない)。 */
  readonly startLine: string | null;
  /** 「分析時刻: 2026-06-28 14:00」(従来の結果の見出しの下の行と同じ文字)。 */
  readonly analyzedLine: string;
  /**
   * 買い目の行。**最新の配分**の点数と合計で、見出しの語で出どころを区別する(利用者が、分析時点の額と再計算後の額を取り違えないため)。
   *  - 締切直前の再計算で再計算できた回(`allocation` が non-null)があれば、一番新しいその回の配分: 「買い目(発走2分前の再計算) 3点・合計 1,700円」(買い目が 0 点でも「0点・合計 0円」)。
   *  - 無ければ分析時点の配分: 「買い目(分析時点) 3点・合計 1,300円」。
   *  - どちらにも買い目が無い(配分の記録なし・未設定・見送り)ときは「配分なし」の 1 語(注記・設定への案内は入れない=閲覧者・管理者で差が出ない)。
   */
  readonly betLine: string;
  /** 買い目の一覧(`betLine` と同じ配分の行。配分の表と同じ並び・同じ整形)。「配分なし」のときは空。 */
  readonly bets: readonly AllocationBetRowView[];
  /** 締切直前の再計算の最新の結果 1 行(「締切直前の再計算(発走2分前): 分析時から変わりませんでした」)。再計算できた回が無い・節が無いときは null。 */
  readonly closeLine: string | null;
}

/** 買い目が無いときの要約の 1 語(Issue #546)。 */
export const NO_BETS_LINE = "配分なし";

export interface ResultContent {
  /** 分析 id(Issue #546。説明文の開閉の状態の鍵。結果画面とカードで同じ分析なら同じ状態になる)。 */
  readonly id: number;
  /** 先頭の要約(Issue #546)。 */
  readonly summary: SummarySection;
  /** 説明文(単勝・複勝・タイム指数・隊列図の注記)を開いているか(Issue #546。既定は閉じる)。文の中身は開閉に関わらず持つ(出すかどうかは画面が決める)。 */
  readonly notesOpen: boolean;
  /** 馬ごとの評価の表(Issue #546-2。「馬ごとの評価」の節の説明文の下・カードの一覧より前)。馬が 0 頭なら null。 */
  readonly horseTable: HorseTable | null;
  /** 想定隊列図の節(Issue #362。AI の展開予想の後・「当日の馬場」の前)。脚質の分かる馬が 2 頭未満の分析は null(節ごと出さない)。 */
  readonly formation: FormationSection | null;
  readonly title: string;
  readonly analyzedAt: string;
  readonly model: string;
  /** LLM が使われなかった・一部しか使われなかった理由(サーバの固定文言)。モデルの有無に関係なく、null でなければ出す。 */
  readonly llmNote: string | null;
  /** LLM の所要時間・usage(要約の1行と警告。記録が無い〈呼ばなかった・旧い分析・空配列〉ときは null)。モデルの有無に関係なく、記録があれば出す。 */
  readonly llmUsage: LlmUsageView | null;
  /** 印の付いた馬の一覧(Issue #211)。印の順 → 馬番の昇順。印の無い馬(null・空白だけ)は含めない。未知の印は既知の印の後ろに馬番の昇順。 */
  readonly markedHorses: readonly MarkedHorse[];
  /** 印の凡例(core の `MARK_LEGEND`)。**一覧が空でないときだけ**(「印の付いた馬」の見出しの下に出す)。 */
  readonly markLegend: string | null;
  /** 3着内率の上位5頭(Issue #240。印の付いた馬の直後)。率が有限な馬が1頭も無ければ null(節ごと出さない)。 */
  readonly topProbs: TopProbs | null;
  /** そのとき LLM が見た当日の馬場の値(Issue #295。「3着内率の上位5頭」の後・「馬ごとの評価」の前)。地方・値が無い・古い分析は null(節ごと出さない)。 */
  readonly baba: BabaSection | null;
  /** AI の展開予想の節(Issue #315)。LLM を使わない・旧い分析・詳細なし・キー無しは null。 */
  readonly development: DevelopmentSection | null;
  readonly detailNote: string | null;
  /** 単勝の想定の説明文(Issue #247。「馬ごとの評価」の見出しの下に1回)。想定か実際が1頭でもあるときだけ(全頭が「-」なら null)。 */
  readonly winOddsNote: string | null;
  /** 複勝の想定の説明文(Issue #253。単勝の説明とは別の段落。「馬ごとの評価」の見出しの下に1回)。複勝の基準があり、想定か実際の下限が1頭でもあるときだけ(全頭が「-」なら null)。 */
  readonly placeOddsNote: string | null;
  /** タイム指数の説明の 1 行(Issue #359。「複勝の説明」の次の段落。サーバの文をそのまま)。出さない分析・古いサーバの応答は null。 */
  readonly timeIndexNote: string | null;
  readonly horses: readonly HorseCard[];
  readonly allocation: AllocationSection;
  /** 締切直前の再計算(Issue #344。「配分の提案」の下)。結果が無い・旧い分析・古いサーバの応答は null(節ごと出さない)。 */
  readonly close: CloseSection | null;
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
  const { venueName, raceNumber, raceName, grade } = a.race;
  const head = `${venueName ?? ""}${raceNumber === null ? "" : `${raceNumber}R`}`;
  // 重賞は、レース名の直後に「(G3)」を付ける(Issue #250。レース名が無いときはグレードだけを付けない)。
  const parts = [head, nameWithGrade(raceName, grade)].filter((p) => p !== "");
  return parts.length === 0 ? `レース ${a.raceId}` : parts.join(" ");
}

function detailNoteOf(detail: AnalysisDetail["detail"]): string | null {
  return detail === "missing" ? DETAIL_MISSING_NOTE : detail === "none" ? DETAIL_NONE_NOTE : null;
}

function allocationOf(a: AnalysisDetail, readOnly: boolean): AllocationSection {
  const comboLines = a.combos?.lines ?? [];
  if (a.allocation === null) {
    return { kind: "none", notices: [NO_ALLOCATION_NOTE], bets: [], settingsRows: [], comboLines };
  }
  const view = buildAllocationProposalView(a.allocation);
  return { kind: view.kind, notices: noticesOf(view.notices, readOnly), bets: view.bets, settingsRows: view.settingsRows, comboLines };
}

/**
 * core の「両方未設定」の注記(import した定数と一致するもの)だけを差し替える。片方だけ・判定不能・フォールバックなどの他の注記と、注記の並び・件数は変えない。
 * 配分の提案と、締切直前の再計算(Issue #344)の表が共有する(閲覧者の扱いを同じにする)。
 */
function noticesOf(notices: readonly string[], readOnly: boolean): readonly string[] {
  return notices.map((n) => (n === BET_ALLOCATION_UNSET_NOTE ? (readOnly ? UNSET_ALLOCATION_NOTE_VIEWER : UNSET_ALLOCATION_NOTE) : n));
}

/** 締切直前の再計算の節(Issue #344)。文言はサーバが組み立てたもの。表は分析時の配分と同じ部品(core の `buildAllocationProposalView`)で、実効設定の行は分析時の節と重複するので出さない。 */
function closeOf(a: AnalysisDetail, readOnly: boolean): CloseSection | null {
  if (a.close == null) return null;
  return {
    heading: CLOSE_HEADING,
    note: a.close.note,
    rounds: a.close.rounds.map((r) => {
      const view = r.allocation === null ? null : buildAllocationProposalView(r.allocation);
      return { heading: r.label, summaryLines: r.summaryLines, notices: view === null ? [] : noticesOf(view.notices, readOnly), bets: view === null ? [] : view.bets, diffLines: r.diffLines };
    }),
  };
}

/**
 * 補正後の3着内率の、統計モデル(prior)からの変化量(Issue #312)。「+2.0pt」「-3.5pt」。丸めて 0.0 になる差は「±0.0pt」(符号を付けない)。非有限の入力は null。
 * 符号と小数1桁は検証画面の補正幅(`formatAdjustment`)に任せる。`formatAdjustment` は丸めて 0.0 になる差を符号なしの「0.0pt」にする(Issue #445)ので、それだけを「±0.0pt」へ置き換える。
 */
function probShiftOf(prior: number, adjusted: number): string | null {
  if (!Number.isFinite(prior) || !Number.isFinite(adjusted)) return null;
  const text = formatAdjustment(adjusted - prior);
  return text === "0.0pt" ? "±0.0pt" : text;
}

/** 強調材料・懸念事項の項目(空文字・空白だけは捨てる。文字列は加工しない)。 */
const pointsOf = (items: readonly string[]): readonly string[] => items.filter((item) => item.trim() !== "");

/** 印を補修した馬の「元の印→今の印」(Issue #317)。補修していない馬(`markFrom` が null・キー無し)は null。 */
function markRepairOf(h: AnalysisDetail["horses"][number]): string | null {
  return h.markFrom === null || h.markFrom === undefined ? null : formatMarkRepair(h.markFrom, h.mark === null || h.mark.trim() === "" ? null : h.mark);
}

/** 印の付いた馬の一覧(Issue #211)。印の順 → 馬番の昇順(同じ印・同じ馬番は入力順。`Array.prototype.sort` は安定)。 */
function markedHorsesOf(horses: AnalysisDetail["horses"]): MarkedHorse[] {
  return horses
    .flatMap((h) => (h.mark === null || h.mark.trim() === "" ? [] : [{ umaban: h.umaban, name: h.name === null || h.name === "" ? null : h.name, mark: h.mark, markRepair: markRepairOf(h) }]))
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
      repaired: markRepairOf(h) !== null,
      shift: llmEffective ? probShiftOf(h.prior, h.adjustedProb) : null,
    }));
  if (rows.length === 0) return null;
  return { heading: llmEffective ? `${LABEL_ADJUSTED_PROB}の3着内率 上位${TOP_PROB_COUNT}頭` : `${LABEL_PRIOR} 上位${TOP_PROB_COUNT}頭`, rows };
}

/** 締切直前の再計算で**再計算できた回(`allocation` が non-null)のうち一番新しいもの**(回は昇順)。無ければ undefined。要約の買い目の行と締切の行が共有する(Issue #546)。 */
function latestCloseRound(close: AnalysisDetail["close"]): { readonly label: string; readonly summaryLines: readonly string[]; readonly diffLines: readonly string[]; readonly allocation: NonNullable<AnalysisDetail["allocation"]> } | undefined {
  const done = (close?.rounds ?? []).flatMap((r) => (r.allocation === null ? [] : [{ ...r, allocation: r.allocation }]));
  return done[done.length - 1];
}

/** 「買い目(出どころ) N点・合計 X円」。合計は表示用の文字列(「300円」)ではなく、保存された賭け金の数値(`StoredAllocationBetView.stake`)の和。 */
function betLineText(source: string, shown: readonly AllocationBetRowView[], stored: NonNullable<AnalysisDetail["allocation"]>): string {
  return `買い目(${source}) ${shown.length}点・合計 ${formatYen(shown.length === 0 ? 0 : stored.bets.reduce((sum, b) => sum + b.stake, 0))}`;
}

/**
 * 要約の買い目(Issue #546)。**最新の配分**: 再計算できた回があれば一番新しいその回の配分(表と同じ部品〈`buildAllocationProposalView`〉の行)、無ければ分析時点の配分(`analysisBets`)。
 * どちらにも買い目が無い(分析時点の記録なし・未設定・見送り・判定不能)ときは「配分なし」。再計算の結果が 0 点のときは、分析時点の額を残さず「0点・合計 0円」と出す。
 */
function summaryBetsOf(a: AnalysisDetail, analysisBets: readonly AllocationBetRowView[]): { readonly betLine: string; readonly bets: readonly AllocationBetRowView[] } {
  const round = latestCloseRound(a.close);
  if (round !== undefined) {
    const bets = buildAllocationProposalView(round.allocation).bets;
    return { betLine: betLineText(`${round.label}の再計算`, bets, round.allocation), bets };
  }
  if (a.allocation === null || analysisBets.length === 0) return { betLine: NO_BETS_LINE, bets: [] };
  return { betLine: betLineText("分析時点", analysisBets, a.allocation), bets: analysisBets };
}

/**
 * 要約の締切直前の再計算の行(Issue #546)。{@link latestCloseRound} の見出しと、差分の 1 行目(差分の行が無い回は状態の行の 1 行目〈「再計算した」〉)。無ければ null。
 */
function closeLineOf(close: AnalysisDetail["close"]): string | null {
  const round = latestCloseRound(close);
  return round === undefined ? null : `${CLOSE_HEADING}(${round.label}): ${round.diffLines[0] ?? round.summaryLines[0]}`;
}

/** 有限の数だけを返す(null・NaN・Infinity は null)。並べ替え用の数値に使う。 */
function finiteOrNull(v: number | null): number | null {
  return v !== null && Number.isFinite(v) ? v : null;
}

/**
 * 馬ごとの評価の表(Issue #546-2)。列は 馬番・印・馬名・3着内率・(AI補正後)・EV・単勝(実際のラベル付き)・複勝下限。補正後の列は**全頭の補正後が null でないときだけ**(LLM が効いた分析だけ。全頭 null なら列ごと出さない)。
 * 行の並べ替えは、値の無い馬(null)を向きによらず末尾に置き、同点・値の無い馬どうしは馬番の昇順。数値は `HorseCard.sortValues`(整形済みの文字列から読み戻さない)。
 */
function horseTableOf(horses: readonly HorseCard[], llmEffective: boolean, oddsStatus: string | null, requested: HorseSort | undefined): HorseTable | null {
  if (horses.length === 0) {
    return null;
  }
  const showAdjusted = llmEffective && horses.some((x) => x.adjusted !== null);
  // 補正後の列が無いのに補正後の並べ替えが残っているときは、既定に戻す。
  const sort = requested === undefined || (requested.key === "adjusted" && !showAdjusted) ? DEFAULT_HORSE_SORT : requested;
  const sortable = (key: HorseSortKey, label: string): HorseTableColumn => ({
    key,
    label,
    sort:
      sort.key === key
        ? { ariaSort: sort.dir === "asc" ? "ascending" : "descending", arrow: sort.dir === "asc" ? "▲" : "▼", nextDir: nextHorseSort(sort, key).dir }
        : { ariaSort: "none", arrow: "", nextDir: firstSortDir(key) },
  });
  const columns: HorseTableColumn[] = [
    sortable("umaban", "馬番"),
    { key: "mark", label: "印", sort: null },
    { key: "name", label: "馬名", sort: null },
    sortable("prior", LABEL_PRIOR),
    ...(showAdjusted ? [sortable("adjusted", LABEL_ADJUSTED_PROB)] : []),
    sortable("ev", "EV"),
    sortable("winOdds", `単勝 ${actualWinOddsLabel(oddsStatus)}`),
    sortable("placeOddsMin", "複勝下限"),
  ];
  const valueOf = (x: HorseCard): number | null => (sort.key === "umaban" ? x.umaban : x.sortValues[sort.key]);
  const rows = [...horses].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === null || vb === null) {
      return va === vb ? a.umaban - b.umaban : va === null ? 1 : -1; // 値の無い馬は向きによらず末尾
    }
    if (va !== vb) {
      return sort.dir === "asc" ? va - vb : vb - va;
    }
    return a.umaban - b.umaban;
  });
  return { sort, columns, rows };
}

/** 結果の内容(結果画面と、レース画面の発走前のカード〈Issue #188〉が同じ変換を使う)。`readOnly`(閲覧者。Issue #238)は設定への案内を外す。省略は管理者。 */
export function contentOf(a: AnalysisDetail, readOnly = false, notesOpen = false, horseSort: HorseSort | undefined = undefined): ResultContent {
  // LLM が効いたか = モデル ID があるか(core の `view/format.ts` の `analysisModelText` と同じ扱い: null・空文字は「効いていない」)。サーバは、効かなかったときは model を null にして保存する。
  const llmEffective = a.model !== null && a.model !== "";
  const markedHorses = markedHorsesOf(a.horses);
  const allocation = allocationOf(a, readOnly);
  const analyzedAt = formatJstDateTime(a.analyzedAt);
  const startTime = a.race.startTime ?? null;
  const horses: HorseCard[] = a.horses.map((h) => ({
    umaban: h.umaban,
    name: h.name,
    mark: h.mark,
    markRepair: markRepairOf(h),
    prior: formatPercent(h.prior),
    adjusted: llmEffective ? formatPercent(h.adjustedProb) : null,
    adjustedShift: llmEffective ? probShiftOf(h.prior, h.adjustedProb) : null,
    reason: llmEffective && h.reason !== null && h.reason !== "" ? h.reason : null,
    highlights: llmEffective ? pointsOf(h.highlights) : [],
    concerns: llmEffective ? pointsOf(h.concerns) : [],
    odds: formatOdds(h.placeOddsMin),
    ev: h.ev === null ? formatEv(null) : `${formatEv(h.ev)}${formatEstimatedEvSuffix(a.evEstimated)}`,
    positive: h.isPositive,
    winOdds: buildWinOddsLine(h.fairWinOdds, h.winOdds, a.race.oddsStatus),
    placeOdds: buildPlaceOddsLine(h.fairPlaceOdds, h.actualPlaceOddsMin, h.actualPlaceOddsMax, a.race.oddsStatus, a.race.placeBasis),
    timeIndexLine: h.timeIndexLine ?? null,
    sortValues: {
      prior: finiteOrNull(h.prior),
      adjusted: llmEffective ? finiteOrNull(h.adjustedProb) : null,
      ev: finiteOrNull(h.ev),
      winOdds: finiteOrNull(h.winOdds),
      placeOddsMin: finiteOrNull(h.placeOddsMin),
    },
  }));
  return {
    id: a.id,
    notesOpen,
    summary: {
      startLine: startTime === null || startTime.trim() === "" ? null : `発走時刻: ${startTime}`,
      analyzedLine: `分析時刻: ${analyzedAt}`,
      ...summaryBetsOf(a, allocation.bets),
      closeLine: closeLineOf(a.close),
    },
    formation: buildFormation(a),
    title: titleOf(a),
    analyzedAt,
    model: llmEffective ? a.model! : MODEL_NONE_TEXT,
    llmNote: a.llmNote,
    llmUsage: a.llmCalls !== null && a.llmCalls.length > 0 ? buildLlmUsage(a.llmCalls) : null,
    markedHorses,
    markLegend: markedHorses.length > 0 ? MARK_LEGEND : null,
    topProbs: topProbsOf(a.horses, llmEffective),
    baba: a.baba == null ? null : { heading: BABA_HEADING, lines: a.baba.lines },
    development: a.development == null ? null : { heading: DEVELOPMENT_HEADING, text: a.development.text, paceLine: a.development.pace === null ? null : `想定ペース(AI): ${a.development.pace}` },
    detailNote: detailNoteOf(a.detail),
    winOddsNote: a.horses.some((h) => h.fairWinOdds !== null || h.winOdds !== null) ? WIN_ODDS_NOTE : null,
    placeOddsNote: a.race.placeBasis !== null && a.horses.some((h) => h.fairPlaceOdds !== null || h.actualPlaceOddsMin !== null) ? PLACE_ODDS_NOTE : null,
    timeIndexNote: a.timeIndexNote ?? null,
    horses,
    horseTable: horseTableOf(horses, llmEffective, a.race.oddsStatus, horseSort),
    allocation,
    close: closeOf(a, readOnly),
  };
}

/** そのレースの画面へ戻るハッシュ。日付は分析の開催日(`kaisaiDate`)を優先する(ハッシュの日付は、直接開いたときは既定の「今日」のことがある)。 */
function backToRace(route: Route, a: AnalysisDetail): string {
  const date = a.kaisaiDate !== null && isRealYmd(a.kaisaiDate) ? a.kaisaiDate : route.date;
  const race = /^[0-9]{12}$/.test(a.raceId) ? a.raceId : null;
  return buildHash({ date, venue: route.venue, race });
}

export function buildResultModel(input: { readonly route: Route; readonly source: ResultSource; readonly readOnly?: boolean; /** 説明文を開いているか(Issue #546。省略は閉じる)。 */ readonly notesOpen?: boolean; /** 馬ごとの評価の表の並べ替え(Issue #546-2。省略は馬番の昇順)。 */ readonly horseSort?: HorseSort }): ResultModel {
  const { route, source } = input;
  const readOnly = input.readOnly === true;
  const listHref = buildHash({ date: route.date, venue: route.venue });
  if (source.kind === "ready") {
    return { kind: "result", loading: false, error: null, content: contentOf(source.analysis, readOnly, input.notesOpen === true, input.horseSort), backHref: backToRace(route, source.analysis) };
  }
  return {
    kind: "result",
    loading: source.kind === "loading",
    error: source.kind === "error" ? source.message : null,
    content: null,
    backHref: listHref,
  };
}
