/**
 * 分析の一覧・詳細の API 呼び出しと応答のパーサ(Issue #185)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**(`api.ts` と同じ): 型違い・キーの欠落は「想定外の応答」(`unexpected`)にし、一部だけを黙って落として返さない。
 * 配分は core の表示関数(`view/allocation-proposal-view.ts` の `buildAllocationProposalView`。旧 exe と共有していた)の入力型 `StoredAllocationView` に写す。**キーが 1 つでも欠けたら想定外**にする
 * (欠けたまま `undefined` を渡すと、フォールバックの注記が消える・「単位額が記録されていません」と誤って表示される、など利用者に見える誤りになる)。
 * 未知の `route` 文字列は通す(表示関数が「判定不能」の注記にする)。
 * サーバ側のキー名・形のドリフトは `test/client-api-analysis-contract.integration.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */
import type { StoredAllocationBetView, StoredAllocationView } from "../../packages/core/src/analysis/analysis-types";
import { MARK_ORIGIN_VALUES } from "../../packages/core/src/view/format";
import { classify, fetchRaceStatus, getJson, isNum, isRecord, isStr, isStrArr, numOrNull, strOrNull, type ApiFailure, type FetchLike, type RaceStatusResult } from "./api";

/** 過去の分析の一覧の 1 件(`GET /api/analyses` の要約から、画面に使う項目だけ)。 */
export interface PastAnalysis {
  readonly id: number;
  readonly analyzedAt: string;
  readonly evEstimated: boolean;
  readonly model: string | null;
}

/** 騎手か調教師の 1 人分の指標(Issue #643。サーバが付ける)。値(`edge`。0.03 = 3.0 ポイント)と件数は対で、ID が無い・表に無い人は両方 null。名前は出馬表の書き方(外から来る文字列)。 */
export interface MarketEdgePerson {
  readonly name: string | null;
  readonly edge: number | null;
  readonly n: number | null;
}

/** 馬ごとの騎手・調教師の指標(参考。確かめ中)。 */
export interface HorseMarketEdge {
  readonly jockey: MarketEdgePerson;
  readonly trainer: MarketEdgePerson;
}

export interface AnalysisHorse {
  readonly umaban: number;
  readonly name: string | null;
  /** 3着内率(0〜1。統計の prior)。 */
  readonly prior: number;
  readonly adjustedProb: number;
  readonly placeOddsMin: number | null;
  readonly ev: number | null;
  readonly isPositive: boolean;
  readonly mark: string | null;
  /**
   * 補修で印が変わった馬の、補修前の印(Issue #317)。6種の印・「なし」(印が無かった)・「不明」(未知の印文字だった)のどれか。
   * 補修していない馬・キー無し(古いサーバの応答)・語彙の外の値は null/省略(補助の表示なので、応答全体は失敗させない。LLM の生の文字列を画面に持ち込まない)。
   */
  readonly markFrom?: string | null;
  readonly reason: string | null;
  /** LLM が挙げた強調材料(Issue #198。各最大3項目の短い句。項目なし・旧い分析は `[]`)。外から来た文字列なので、画面ではテキストとしてだけ入れる。 */
  readonly highlights: readonly string[];
  /** LLM が挙げた懸念事項(仕様は highlights と同じ)。 */
  readonly concerns: readonly string[];
  /**
   * 勝率の推定(Issue #247。0〜1)。補正後の3着内率から推定した目安で、LLM が直接判断した値ではない。**画面には出さない**(利用者の決定)。判定不能は null。
   */
  readonly winProb: number | null;
  /** 想定単勝オッズ(払戻率 0.8 ÷ 勝率。地方も 0.8 と仮定した概算)。勝率が 0・判定不能は null。 */
  readonly fairWinOdds: number | null;
  /** 分析時点の実際の単勝オッズ(詳細なし・未確定・不正は null)。 */
  readonly winOdds: number | null;
  /**
   * 想定複勝オッズ(Issue #253。払戻率 0.8 ÷ 複勝の的中率。的中率は `race.placeBasis` が top3 なら3着内率・top2 なら2着内率)。判定不能・4頭以下は null。
   * 1.0 倍未満の値もそのまま届く(「1.0倍未満」の表示は `place-odds-format.ts`)。
   */
  readonly fairPlaceOdds: number | null;
  /** 分析時点の実際の複勝オッズの下限(Issue #253。詳細なし・未確定・発売前は null)。 */
  readonly actualPlaceOddsMin: number | null;
  /** 分析時点の実際の複勝オッズの上限(Issue #253。上限を保存する前の過去の分析は null=下限だけ出す)。 */
  readonly actualPlaceOddsMax: number | null;
  /** スタート直後の位置(Issue #311。想定隊列図〈#362〉の道中の並びに使う。0〜1 で小さいほど前)。戦績が取れない馬・過去の分析・詳細なし・キー無し(古いサーバの応答)は null。パーサは常にキーを持つ。型で省略可なのは、この項目を使わない固定データ(テスト・画面の材料)を壊さないため(`baba`・`combos` と同じ流儀)。 */
  readonly earlyPos?: number | null;
  /** 終盤の位置(Issue #363。想定隊列図〈#362〉の4コーナーの位置に使う。0〜1 で小さいほど前)。近走の最終コーナーの通過順位 ÷ 出走頭数の平均。戦績が取れない馬・過去の分析・詳細なし・キー無し(古いサーバの応答)は null。パーサは常にキーを持つ(型で省略可な理由は `earlyPos` と同じ)。範囲(0〜1)の検査はサーバで行う。 */
  readonly latePos?: number | null;
  /** 脚質(Issue #314。想定隊列図〈#362〉の位置を決める材料)。戦績が取れない馬・過去の分析・詳細なし・キー無し(古いサーバの応答)・4 値以外の値は null。パーサは常にキーを持つ(型で省略可な理由は `earlyPos` と同じ)。 */
  readonly legStyle?: LegStyle | null;
  /** タイム指数の行(Issue #359。サーバが組み立てた「タイム指数 +1.2(レース内 2位)」。値のない馬は「タイム指数 —」)。出さない分析・キー無し(古いサーバの応答)・文字列以外は null。パーサは常にキーを持つ(型で省略可な理由は `earlyPos` と同じ)。 */
  readonly timeIndexLine?: string | null;
  /** 騎手・調教師の指標(Issue #643)。列を出さない分析(地方・記録なし・失敗)・キー無し(古いサーバの応答)・形が不正な値は null。パーサは常にキーを持つ(型で省略可な理由は `earlyPos` と同じ)。 */
  readonly marketEdge?: HorseMarketEdge | null;
  /** 別の Worker が計算した勝つ確率(Issue #796)。MODEL が無い構成・計算なし・応答に無い馬・キー無し(古いサーバの応答)・有限の数以外は null。パーサは常にキーを持たせる。省略可なのは、キーの無い応答を表すため。 */
  readonly modelProb?: number | null;
  /** 確率 × 5 分前の単勝(Issue #796。サーバが掛けた値)。5 分前の単勝が無い馬は null。仕様は `modelProb` と同じ。 */
  readonly modelEv?: number | null;
  /** 別の Worker が返す、馬ごとの補助の値(Issue #805。小数 2 桁の値・応答の中での順位・値を持つ馬の数)。形が崩れたもの・キー無しは null。 */
  readonly modelAux?: { readonly value: number; readonly rank: number; readonly of: number } | null;
  /** その馬のコース別の成績(Issue #802。参考の情報)。サーバが検査して付ける。無い・形が不正な馬は、キーごと無し(パーサは足さない)。 */
  readonly courseFit?: AnalysisCourseFit;
}

/** 補助の値(Issue #805)。value が有限の数、rank・of が正の整数で rank ≤ of のときだけ。 */
function parseModelAux(v: unknown): { value: number; rank: number; of: number } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const { value, rank, of } = r;
  if (typeof value !== "number" || !Number.isFinite(value) || typeof rank !== "number" || typeof of !== "number") return null;
  if (!Number.isInteger(rank) || !Number.isInteger(of) || rank < 1 || rank > of) return null;
  return { value, rank, of };
}

/** コースの成績の 1 つの集計(Issue #802)。`wins` ≤ `top3` ≤ `runs`。`best` は 1 以上の整数か null(`runs` が 0 なら null)。 */
export interface AnalysisCourseRecord {
  readonly runs: number;
  readonly wins: number;
  readonly top3: number;
  readonly best: number | null;
}
/** 馬のコース別の成績(Issue #802)。`unknownRing` は、回りの決まらない過去走の数。 */
export interface AnalysisCourseFit {
  readonly same: AnalysisCourseRecord;
  readonly similar: AnalysisCourseRecord;
  readonly unknownRing: number;
}
/** 今日のコースと、似たコース(Issue #802。参考の情報)。名前はサーバが key から組んだもの。配列が崩れていた場合は null(空配列は崩れではない)。 */
export interface AnalysisCourse {
  readonly name: string;
  readonly similarShape: readonly { readonly name: string; readonly s: number }[] | null;
  readonly similarResults: readonly { readonly name: string; readonly s: number; readonly n: number }[] | null;
}

/** 脚質(Issue #314。core の `LegStyle` と同じ 4 値。クライアントは core のバレルを import しないので、ここに持つ)。 */
export type LegStyle = "逃げ" | "先行" | "差し" | "追込";
/** 想定ペース(Issue #314。core の `PaceEstimate` と同じ 4 値)。 */
export type PaceEstimate = "スロー" | "平均" | "ハイ" | "不明";
const LEG_STYLES: readonly LegStyle[] = ["逃げ", "先行", "差し", "追込"];
const PACES: readonly PaceEstimate[] = ["スロー", "平均", "ハイ", "不明"];

/**
 * LLM を呼んだ1回の記録(Issue #198。サーバの `LlmCallRecord` と同じ形)。費用(トークン数)・時間・切り詰め(`stopReason` が `max_tokens`)を確かめるための値。
 * `outputTokens` は **thinking を含む**。`replayed` の件の `ms`・トークンは元の呼び出しの値(測っていない旧い記録は null)。
 */
export interface LlmCall {
  readonly ok: boolean;
  readonly ms: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly stopReason: string | null;
  readonly model: string | null;
  readonly replayed: boolean;
  readonly error: string | null;
}

export type DetailState = "present" | "missing" | "none";

/** そのとき LLM が見た当日の馬場の値(Issue #295)。サーバがプロンプトと同じ整形にした行(クッション値・含水率・使用コース・芝の状態の文章)。 */
export interface AnalysisBaba {
  readonly lines: readonly string[];
}

/** `baba.lines` の上限(Issue #295)。サーバが作る行は最大 6 行・各 400 字程度。想定外に大きい応答は読まない(null にする)。 */
const BABA_MAX_LINES = 12;
const BABA_MAX_LINE_LENGTH = 600;

/**
 * LLM の展開予想と想定ペース(Issue #315。サーバの `AnalysisViewDevelopment` と同じ形)。pace は core の `LlmPace`(「不明」を除く 3 値)と同じで、
 * クライアントは core のバレルを import しないのでここに持つ。
 */
export interface AnalysisDevelopment {
  /** 展開予想の短文。無ければ null。 */
  readonly text: string | null;
  /** LLM の想定ペース。無ければ null。 */
  readonly pace: "スロー" | "平均" | "ハイ" | null;
}

/**
 * `development.text` の上限(UTF-16 の長さ。Issue #315)。サーバ(core)が 500 コードポイントで切るので、最大でも 1,000(サロゲートペアばかりの場合)。
 * それを超える想定外に大きい応答は読まない(null にする)。
 */
const DEVELOPMENT_MAX_TEXT_LENGTH = 1000;
const DEVELOPMENT_PACES = ["スロー", "平均", "ハイ"] as const;

/** `{ text: string|null, pace: 3 値|null }`(両方 null は不可)だけを受け、それ以外(キー無し・null・不正)は null。補助の表示なので、分析全体の解析は失敗させない。 */
function parseDevelopment(value: unknown): AnalysisDevelopment | null {
  if (!isRecord(value)) return null;
  const { text, pace } = value;
  if (text !== null && (typeof text !== "string" || text.length > DEVELOPMENT_MAX_TEXT_LENGTH)) return null;
  const parsedPace = pace === null ? null : (DEVELOPMENT_PACES.find((p) => p === pace) ?? undefined);
  if (parsedPace === undefined) return null;
  if (text === null && parsedPace === null) return null;
  return { text, pace: parsedPace };
}

/** 組合せの券種ごとの行(Issue #296)。サーバが組み立てた文章(取得の点数・EV プラスの点数・配分の点数)。 */
export interface AnalysisCombos {
  readonly lines: readonly string[];
}

/** `combos.lines` の上限(Issue #296)。券種は 6 つ・1 行は 100 字前後。想定外に大きい応答は読まない(null にする)。 */
const COMBOS_MAX_LINES = 6;
const COMBOS_MAX_LINE_LENGTH = 300;

/**
 * 締切直前の再計算の 1 回ぶん(Issue #344)。文言(見出し・状態と時刻の行・差分の行)はサーバが組み立てたもの。`allocation` は再計算できた回だけ(分析時の提案と同じ形)。
 * サーバの応答には状態・理由・時刻・差分の構造なども載るが、画面が使わないものは読まない。
 */
export interface AnalysisCloseRound {
  readonly label: string;
  readonly summaryLines: readonly string[];
  readonly allocation: StoredAllocationView | null;
  readonly diffLines: readonly string[];
}

/** 締切直前の再計算(Issue #344)。回の昇順。 */
export interface AnalysisClose {
  readonly note: string;
  readonly rounds: readonly AnalysisCloseRound[];
}

/** `close` の上限(Issue #344)。回は 2 つ・1 回の文言の行は多くても 10。想定外に大きい応答は読まない(null にする)。 */
const CLOSE_MAX_ROUNDS = 4;
const CLOSE_MAX_SUMMARY_LINES = 4;
const CLOSE_MAX_DIFF_LINES = 10;
const CLOSE_MAX_LINE_LENGTH = 300;

/** 前の分析との差(Issue #583)。見出しと行はサーバが組み立てたもの(クライアントは並べるだけ)。 */
export interface AnalysisPreviousDiff {
  readonly title: string;
  readonly lines: readonly string[];
}

/** 差の行の上限(印・買い目・3 着内率・注記を合わせて多くても 20 行ほど)。想定外に大きい応答は読まない。 */
const DIFF_MAX_LINES = 40;

export interface AnalysisDetail {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly evEstimated: boolean;
  readonly model: string | null;
  /**
   * LLM が使われなかった・一部しか使われなかった理由(サーバの固定文言。Issue #194 → #195)。問題なく効いたとき・過去の分析は null。
   * `model` とは独立(印の制約違反は、モデルがあって理由もある)。
   */
  readonly llmNote: string | null;
  /**
   * LLM を呼んだ1回ごとの記録(呼び出しの順。Issue #198)。LLM を呼ばなかった(キー未登録)・旧い分析は null。`model` とは独立(全回が失敗してフォールバックした分析は、モデルが null で記録がある)。
   */
  readonly llmCalls: readonly LlmCall[] | null;
  /** `grade`(Issue #250)はスナップショットのグレードの生の値(表示するかは `grade.ts`)。過去の分析・キー無し(古いサーバの応答)は null。`oddsStatus`(Issue #247)は分析時点のオッズの状態(result / middle / yoso。詳細なしは null)。実際の単勝オッズのラベル(確定・暫定・予想)に使う。 */
  readonly race: {
    readonly venueName: string | null;
    readonly raceNumber: number | null;
    readonly raceName: string | null;
    readonly grade: string | null;
    readonly oddsStatus: string | null;
    /** 発走時刻(Issue #546。サーバが `race.startTime` で返す「15:45」の形)。詳細なし・キー無し(古いサーバの応答)は null。パーサは常にキーを持つ(型で省略可なのは `distance` と同じ理由)。 */
    readonly startTime?: string | null;
    /** 想定複勝オッズの基準(Issue #253。top3=3着内率〈8頭以上〉・top2=2着内率〈5〜7頭。複勝は2着まで〉・null=出さない〈4頭以下〉)。 */
    readonly placeBasis: "top3" | "top2" | null;
    /** 距離(m。Issue #311)。詳細なし・キー無し(古いサーバの応答)は null。パーサは常にキーを持つ(型で省略可なのは `pace` と同じ理由)。 */
    readonly distance?: number | null;
    /** 想定ペース(Issue #314。想定隊列図〈#362〉の隊列の長さ・4コーナーの動きに使う。サーバが求める: Issue #315 以降は LLM が展開予想して出した pace を優先し、無いときは逃げ馬の頭数から求める規則の値)。キー無し(古いサーバの応答)・形が不正な値は「不明」(補助の演出なので、分析全体の解析は失敗させない)。 */
    readonly pace?: PaceEstimate;
  };
  /**
   * そのとき LLM が見た当日の馬場の値(Issue #295)。地方・LLM を使わない分析・計測が無い日・詳細なし・古い分析は null。キー無し(古いサーバの応答)・形が不正な値も null にする
   * (補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。
   */
  readonly baba?: AnalysisBaba | null;
  /**
   * LLM の展開予想と想定ペース(Issue #315)。LLM を使わない分析・旧い分析(development・pace を出さない版)・読めない応答・詳細なし・キー無し(古いサーバの応答)・形が不正な値は null
   * (補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。
   */
  readonly development?: AnalysisDevelopment | null;
  /** タイム指数の説明の 1 行(Issue #359。サーバが組み立てた文。馬の一覧の上に 1 回出す)。出さない分析・キー無し(古いサーバの応答)・文字列以外は null(補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。 */
  readonly timeIndexNote?: string | null;
  /** 騎手・調教師の列の注記(Issue #643。サーバが組み立てた文。表の下に 1 回出す)。列を出さない分析・キー無し(古いサーバの応答)・空文字・文字列以外は null(補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。 */
  readonly marketEdgeNote?: string | null;
  /** 別の Worker が計算した確率の列の注記(Issue #796。サーバが組み立てた固定の語彙の文。表の下に 1 回出す)。列を出さない構成(MODEL が無い・地方)・キー無し・空文字・文字列以外は null。省略可なのは、キーの無い応答を表すため。 */
  readonly modelNote?: string | null;
  /** 別の Worker の確率の段階(Issue #800)。`final` 以外は暫定(見出しに「暫定」を付ける)。表に無い値・キー無しは null。省略可なのは、キーの無い応答を表すため。 */
  readonly modelStage?: "final" | "preday" | "provisional" | null;
  /** 今日のコースと似たコース(Issue #802。参考の情報)。無い・形が不正は、キーごと無し(パーサは足さない)。 */
  readonly course?: AnalysisCourse;
  /**
   * 組合せの券種ごとの行(Issue #296。オッズの取得点数・EV プラスの点数・配分の点数)。組合せの記録が無い・詳細なし・キー無し(古いサーバの応答)・形が不正な値は null にする
   * (補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。
   */
  readonly combos?: AnalysisCombos | null;
  /**
   * 締切直前の再計算(Issue #344。発走 5 分前・2 分前の、オッズを取り直した配分と、分析時の提案との差分)。結果が無い(旧い分析・まだ回が来ていない)・キー無し(古いサーバの応答)・
   * 形が不正な値は null にする(補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。
   */
  readonly close?: AnalysisClose | null;
  /** 前の分析との差(Issue #583)。前の分析が無い・読み出しに失敗・形が不正・キー無し(古いサーバの応答)は null(補助の表示なので、分析全体の解析は失敗させない)。 */
  readonly previousDiff?: AnalysisPreviousDiff | null;
  /** オッズの取得元と時刻の行(Issue #677。サーバの整形。最大 2 行)。記録なし・形が不正・キー無しは null。 */
  readonly oddsSources?: { readonly lines: readonly string[] } | null;
  readonly horses: readonly AnalysisHorse[];
  readonly allocation: StoredAllocationView | null;
  readonly detail: DetailState;
}

export type PastAnalysesResult = { readonly ok: true; readonly analyses: PastAnalysis[] } | { readonly ok: false; readonly error: ApiFailure };
export type AnalysisResult = { readonly ok: true; readonly analysis: AnalysisDetail } | { readonly ok: false; readonly error: ApiFailure };

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const boolOrNull = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";

const unexpected = (status: number): { ok: false; error: ApiFailure } => ({ ok: false, error: { kind: "unexpected", httpStatus: status } });

function parsePast(row: unknown): PastAnalysis | null {
  if (!isRecord(row)) return null;
  const { id, analyzedAt, evEstimated, model } = row;
  if (!isNum(id) || !Number.isInteger(id) || id < 1 || !isStr(analyzedAt) || !isBool(evEstimated) || !strOrNull(model)) return null;
  return { id, analyzedAt, evEstimated, model };
}

export function parsePastAnalysesResponse(status: number, body: unknown): PastAnalysesResult {
  if (status !== 200) {
    return { ok: false, error: classify(status, body) };
  }
  if (!isRecord(body) || body["ok"] !== true || !Array.isArray(body["analyses"])) {
    return unexpected(status);
  }
  const analyses: PastAnalysis[] = [];
  for (const raw of body["analyses"] as unknown[]) {
    const parsed = parsePast(raw);
    if (parsed === null) return unexpected(status);
    analyses.push(parsed);
  }
  return { ok: true, analyses };
}

/** 1 人分。名前は文字列か null、値と件数は「有限の数と 0 以上の整数」か「どちらも null」(片方だけは不正)。 */
function parseMarketPerson(value: unknown): MarketEdgePerson | null {
  if (!isRecord(value)) return null;
  const { name, edge, n } = value;
  if (!strOrNull(name)) return null;
  if (edge === null && n === null) return { name, edge: null, n: null };
  return isNum(edge) && isNum(n) && Number.isInteger(n) && n >= 0 ? { name, edge, n } : null;
}

/** 馬ごとの指標(Issue #643)。形が不正なら null(部分的に読み替えない)。 */
function parseMarketEdge(value: unknown): HorseMarketEdge | null {
  if (!isRecord(value)) return null;
  const jockey = parseMarketPerson(value["jockey"]);
  const trainer = parseMarketPerson(value["trainer"]);
  return jockey === null || trainer === null ? null : { jockey, trainer };
}

const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;

/** コースの成績の集計(Issue #802)。サーバと同じ不変条件(wins ≤ top3 ≤ runs、best は null か 1 以上の整数で runs 0 なら null)。崩れていれば null。 */
function parseCourseRecord(value: unknown): AnalysisCourseRecord | null {
  if (!isRecord(value)) return null;
  const { runs, wins, top3, best } = value;
  if (!isCount(runs) || !isCount(wins) || !isCount(top3) || wins > top3 || top3 > runs) return null;
  if (best === null) return { runs, wins, top3, best: null };
  return runs > 0 && isNum(best) && Number.isInteger(best) && best >= 1 ? { runs, wins, top3, best } : null;
}

function parseCourseFit(value: unknown): AnalysisCourseFit | null {
  if (!isRecord(value)) return null;
  const same = parseCourseRecord(value["same"]);
  const similar = parseCourseRecord(value["similar"]);
  const ring = value["unknownRing"];
  return same === null || similar === null || !isCount(ring) ? null : { same, similar, unknownRing: ring };
}

const COURSE_LIST_MAX = 5;

/** 似たコースの配列。1 つでも崩れていれば null(一部だけ読まない)。5 件を超えたら先頭 5 件。 */
function parseCourseList<T extends { readonly name: string; readonly s: number }>(value: unknown, withN: boolean): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const e of value) {
    if (!isRecord(e) || !isStr(e["name"]) || e["name"] === "" || !isNum(e["s"]) || e["s"] < 0 || e["s"] > 1) return null;
    if (withN) {
      if (!isCount(e["n"])) return null;
      out.push({ name: e["name"], s: e["s"], n: e["n"] } as unknown as T);
    } else {
      out.push({ name: e["name"], s: e["s"] } as unknown as T);
    }
  }
  return out.slice(0, COURSE_LIST_MAX);
}

function parseCourse(value: unknown): AnalysisCourse | null {
  if (!isRecord(value) || !isStr(value["name"]) || value["name"] === "") return null;
  return { name: value["name"], similarShape: parseCourseList(value["similarShape"], false), similarResults: parseCourseList(value["similarResults"], true) };
}

function parseHorse(row: unknown): AnalysisHorse | null {
  if (!isRecord(row)) return null;
  const { umaban, name, prior, adjustedProb, placeOddsMin, ev, isPositive, mark, reason, highlights, concerns, winProb, fairWinOdds, winOdds, fairPlaceOdds, actualPlaceOddsMin, actualPlaceOddsMax } = row;
  if (!isNum(umaban) || !strOrNull(name) || !isNum(prior) || !isNum(adjustedProb) || !numOrNull(placeOddsMin) || !numOrNull(ev) || !isBool(isPositive) || !strOrNull(mark) || !strOrNull(reason)) {
    return null;
  }
  if (!isStrArr(highlights) || !isStrArr(concerns)) return null;
  // Issue #247: 勝率・想定・実際は、キーが欠けたら(undefined)想定外。有限の数か null だけ(黙って null にしない)。
  if (!numOrNull(winProb) || !numOrNull(fairWinOdds) || !numOrNull(winOdds)) return null;
  // Issue #253: 想定複勝・実際の複勝の下限と上限も同じ(キーが欠けたら想定外)。
  if (!numOrNull(fairPlaceOdds) || !numOrNull(actualPlaceOddsMin) || !numOrNull(actualPlaceOddsMax)) return null;
  // Issue #311: スタート直後の位置は、キー無し(古いサーバの応答)は null。数・null 以外の型は想定外。
  const earlyPos = row["earlyPos"] ?? null;
  if (!numOrNull(earlyPos)) return null;
  // Issue #363: 終盤の位置も同じ(キー無しは null。数・null 以外の型は想定外)。
  const latePos = row["latePos"] ?? null;
  if (!numOrNull(latePos)) return null;
  // Issue #314: 脚質は、キー無し・4 値以外は null(補助の演出なので、応答ごと不正にはしない)。
  const legStyle = LEG_STYLES.find((s) => s === row["legStyle"]) ?? null;
  // Issue #317: 補修前の印は、キー無し・語彙(6種の印・なし・不明)の外は null(補助の表示なので、応答ごと不正にはしない)。
  const markFrom = MARK_ORIGIN_VALUES.find((v) => v === row["markFrom"]) ?? null;
  // Issue #359: タイム指数の行は、キー無し・文字列以外は null(補助の表示なので、応答ごと不正にはしない)。
  const timeIndexLine = typeof row["timeIndexLine"] === "string" ? row["timeIndexLine"] : null;
  // Issue #643: 騎手・調教師の指標は、キー無し・形が不正は null(補助の表示なので、応答ごと不正にはしない)。
  const marketEdge = parseMarketEdge(row["marketEdge"]);
  // Issue #796: 別の Worker が計算した確率とその掛け算は、有限の数以外(キー無しを含む)は null(補助の表示なので、応答ごと不正にはしない)。
  const modelProb = typeof row["modelProb"] === "number" && Number.isFinite(row["modelProb"]) ? row["modelProb"] : null;
  const modelAux = parseModelAux(row["modelAux"]);
  const modelEv = typeof row["modelEv"] === "number" && Number.isFinite(row["modelEv"]) ? row["modelEv"] : null;
  // 配列は複製して持つ(応答の本体と配列を共有しない)。
  // Issue #802: コースの成績は、形が不正ならキーごと無し(欄が無い応答と区別しない。補助の表示なので応答ごと不正にはしない)。
  const courseFit = parseCourseFit(row["courseFit"]);
  return { umaban, name, prior, adjustedProb, placeOddsMin, ev, isPositive, mark, markFrom, reason, highlights: [...highlights], concerns: [...concerns], winProb, fairWinOdds, winOdds, fairPlaceOdds, actualPlaceOddsMin, actualPlaceOddsMax, earlyPos, latePos, legStyle, timeIndexLine, marketEdge, modelProb, modelEv, modelAux, ...(courseFit === null ? {} : { courseFit }) };
}

/** LLM の呼び出し1件。許可したキーだけを写す(余計なキーは持ち込まない)。どれか1つでも型が違えば null。 */
function parseLlmCall(row: unknown): LlmCall | null {
  if (!isRecord(row)) return null;
  const { ok, ms, inputTokens, outputTokens, stopReason, model, replayed, error } = row;
  if (!isBool(ok) || !numOrNull(ms) || !numOrNull(inputTokens) || !numOrNull(outputTokens) || !strOrNull(stopReason) || !strOrNull(model) || !isBool(replayed) || !strOrNull(error)) {
    return null;
  }
  return { ok, ms, inputTokens, outputTokens, stopReason, model, replayed, error };
}

function parseBet(row: unknown): StoredAllocationBetView | null {
  if (!isRecord(row)) return null;
  const { betType, comboKey, stake, odds, ev } = row;
  if (!isStr(betType) || !isStr(comboKey) || !isNum(stake) || !numOrNull(odds) || !numOrNull(ev)) return null;
  return { betType, comboKey, stake, odds, ev };
}

/** 配分。キーが 1 つでも欠けたら(型が違っても)null(呼び出し側が想定外の応答にする)。 */
function parseAllocation(value: unknown): StoredAllocationView | null {
  if (!isRecord(value) || !Array.isArray(value["bets"])) return null;
  const v = value;
  if (
    !isStr(v["route"]) ||
    !strOrNull(v["unavailableReason"]) ||
    !strOrNull(v["fallbackReason"]) ||
    !strOrNull(v["skipReasonCode"]) ||
    !isNum(v["bankroll"]) ||
    !isNum(v["perRaceCap"]) ||
    !isNum(v["kellyFraction"]) ||
    !isNum(v["evThreshold"]) ||
    !isBool(v["includeComboOdds"]) ||
    !isBool(v["includeWide"]) ||
    !isBool(v["includeTrio"]) ||
    !boolOrNull(v["includeQuinella"]) ||
    !boolOrNull(v["includeExacta"]) ||
    !boolOrNull(v["includeTrifecta"]) ||
    !boolOrNull(v["includeBracketQuinella"]) ||
    !numOrNull(v["maxWinBets"]) ||
    !numOrNull(v["maxPlaceBets"]) ||
    !numOrNull(v["betUnit"]) ||
    !isStr(v["oddsStatus"])
  ) {
    return null;
  }
  const bets: StoredAllocationBetView[] = [];
  for (const raw of v["bets"] as unknown[]) {
    const bet = parseBet(raw);
    if (bet === null) return null;
    bets.push(bet);
  }
  return {
    route: v["route"],
    unavailableReason: v["unavailableReason"],
    fallbackReason: v["fallbackReason"],
    skipReasonCode: v["skipReasonCode"],
    bankroll: v["bankroll"],
    perRaceCap: v["perRaceCap"],
    kellyFraction: v["kellyFraction"],
    evThreshold: v["evThreshold"],
    includeComboOdds: v["includeComboOdds"],
    includeWide: v["includeWide"],
    includeTrio: v["includeTrio"],
    includeQuinella: v["includeQuinella"],
    includeExacta: v["includeExacta"],
    includeTrifecta: v["includeTrifecta"],
    includeBracketQuinella: v["includeBracketQuinella"],
    maxWinBets: v["maxWinBets"],
    maxPlaceBets: v["maxPlaceBets"],
    betUnit: v["betUnit"],
    oddsStatus: v["oddsStatus"],
    bets,
  };
}

/** `{ lines: 1〜maxLines 行の文字列(各 maxLength 字以内) }` だけを受け、それ以外(キー無し・null・不正)は null。`baba`(Issue #295)と `combos`(Issue #296)が共有する。 */
function parseLines(value: unknown, maxLines: number, maxLength: number): { readonly lines: readonly string[] } | null {
  if (!isRecord(value) || !Array.isArray(value["lines"])) return null;
  const lines = value["lines"] as unknown[];
  if (lines.length < 1 || lines.length > maxLines) return null;
  if (!lines.every((l): l is string => typeof l === "string" && l.length <= maxLength)) return null;
  return { lines: [...lines] };
}

/** 文字列の配列(要素数 min〜max・各 CLOSE_MAX_LINE_LENGTH 字以内)。それ以外は null。 */
function parseCloseLines(value: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  return value.every((l): l is string => typeof l === "string" && l.length <= CLOSE_MAX_LINE_LENGTH) ? [...value] : null;
}

/** 締切直前の再計算(Issue #344)。どこか 1 つでも形が違えば null(節ごと出さない)。 */
function parseClose(value: unknown): AnalysisClose | null {
  if (!isRecord(value) || !isStr(value["note"]) || value["note"].length > CLOSE_MAX_LINE_LENGTH || !Array.isArray(value["rounds"])) return null;
  const raw = value["rounds"] as unknown[];
  if (raw.length < 1 || raw.length > CLOSE_MAX_ROUNDS) return null;
  const rounds: AnalysisCloseRound[] = [];
  for (const r of raw) {
    if (!isRecord(r) || !isStr(r["label"]) || r["label"].length > CLOSE_MAX_LINE_LENGTH) return null;
    const summaryLines = parseCloseLines(r["summaryLines"], 1, CLOSE_MAX_SUMMARY_LINES);
    const diffLines = parseCloseLines(r["diffLines"], 0, CLOSE_MAX_DIFF_LINES);
    const allocation = r["allocation"] === null ? null : parseAllocation(r["allocation"]);
    if (summaryLines === null || diffLines === null || (r["allocation"] !== null && allocation === null)) return null;
    rounds.push({ label: r["label"], summaryLines, allocation, diffLines });
  }
  return { note: value["note"], rounds };
}

/** 前の分析との差(Issue #583)。見出しが文字列(100 字以内)で、行が 1〜{@link DIFF_MAX_LINES} 行(各 300 字以内)。それ以外は null。 */
function parsePreviousDiff(value: unknown): AnalysisPreviousDiff | null {
  const parsed = parseLines(value, DIFF_MAX_LINES, CLOSE_MAX_LINE_LENGTH);
  const title = isRecord(value) ? value["title"] : null;
  return parsed === null || !isStr(title) || title.length > 100 ? null : { title, lines: parsed.lines };
}

function parseDetail(value: unknown): AnalysisDetail | null {
  if (!isRecord(value)) return null;
  const { id, raceId, analyzedAt, kaisaiDate, evEstimated, model, llmNote, llmCalls, race, horses, allocation, detail } = value;
  if (!isNum(id) || !isStr(raceId) || !isStr(analyzedAt) || !strOrNull(kaisaiDate) || !isBool(evEstimated) || !strOrNull(model) || !strOrNull(llmNote)) return null;
  // llmCalls: キーが無い(undefined)は想定外。null(呼ばなかった・旧い分析)か、検査した配列(空配列も可)。
  let parsedCalls: LlmCall[] | null = null;
  if (llmCalls !== null) {
    if (!Array.isArray(llmCalls)) return null;
    parsedCalls = [];
    for (const raw of llmCalls as unknown[]) {
      const call = parseLlmCall(raw);
      if (call === null) return null;
      parsedCalls.push(call);
    }
  }
  if (detail !== "present" && detail !== "missing" && detail !== "none") return null;
  if (!isRecord(race) || !strOrNull(race["venueName"]) || !numOrNull(race["raceNumber"]) || !strOrNull(race["raceName"]) || !strOrNull(race["oddsStatus"])) return null;
  // グレード(Issue #250): キー無し(古いサーバの応答)は null。文字列・null 以外の型は応答ごと不正にする。
  const grade = race["grade"] ?? null;
  if (!strOrNull(grade)) return null;
  // 想定複勝オッズの基準(Issue #253): キーが欠けたら(undefined)想定外。top3・top2・null だけ。
  const placeBasis = race["placeBasis"];
  if (placeBasis !== "top3" && placeBasis !== "top2" && placeBasis !== null) return null;
  const distance = race["distance"] ?? null;
  if (!numOrNull(distance)) return null;
  // 発走時刻(Issue #546): キー無し(古いサーバの応答)は null。文字列・null 以外の型は応答ごと不正にする(グレードと同じ)。
  const startTime = race["startTime"] ?? null;
  if (!strOrNull(startTime)) return null;
  // コースの回り(`race.turn`。Issue #311)は Issue #375 で廃止した。古いサーバの応答にキーがあっても読まない(値が不正でも応答を拒否しない)。
  // Issue #314: 想定ペースは、キー無し・4 値以外は「不明」(補助の演出なので、応答ごと不正にはしない)。
  const pace = PACES.find((p) => p === race["pace"]) ?? "不明";
  if (!Array.isArray(horses)) return null;
  const parsedHorses: AnalysisHorse[] = [];
  for (const raw of horses as unknown[]) {
    const horse = parseHorse(raw);
    if (horse === null) return null;
    parsedHorses.push(horse);
  }
  let parsedAllocation: StoredAllocationView | null = null;
  if (allocation !== null) {
    parsedAllocation = parseAllocation(allocation);
    if (parsedAllocation === null) return null;
  }
  // Issue #802: コースの参考情報は、形が不正ならキーごと無し。
  const course = parseCourse(value["course"]);
  return {
    id,
    raceId,
    analyzedAt,
    kaisaiDate,
    evEstimated,
    model,
    llmNote,
    llmCalls: parsedCalls,
    race: { venueName: race["venueName"], raceNumber: race["raceNumber"], raceName: race["raceName"], grade, oddsStatus: race["oddsStatus"], placeBasis, distance, pace, startTime },
    baba: parseLines(value["baba"], BABA_MAX_LINES, BABA_MAX_LINE_LENGTH),
    development: parseDevelopment(value["development"]),
    timeIndexNote: typeof value["timeIndexNote"] === "string" ? value["timeIndexNote"] : null,
    marketEdgeNote: typeof value["marketEdgeNote"] === "string" && value["marketEdgeNote"] !== "" ? value["marketEdgeNote"] : null,
    modelStage: value["modelStage"] === "final" || value["modelStage"] === "preday" || value["modelStage"] === "provisional" ? value["modelStage"] : null,
    modelNote: typeof value["modelNote"] === "string" && value["modelNote"] !== "" ? value["modelNote"] : null,
    ...(course === null ? {} : { course }),
    combos: parseLines(value["combos"], COMBOS_MAX_LINES, COMBOS_MAX_LINE_LENGTH),
    close: parseClose(value["close"]),
    previousDiff: parsePreviousDiff(value["previousDiff"]),
    oddsSources: parseLines(value["oddsSources"], 2, CLOSE_MAX_LINE_LENGTH),
    horses: parsedHorses,
    allocation: parsedAllocation,
    detail,
  };
}

export function parseAnalysisResponse(status: number, body: unknown): AnalysisResult {
  if (status === 404) {
    return { ok: false, error: { kind: "not-found" } };
  }
  if (status !== 200) {
    return { ok: false, error: classify(status, body) };
  }
  if (!isRecord(body) || body["ok"] !== true) {
    return unexpected(status);
  }
  const analysis = parseDetail(body["analysis"]);
  return analysis === null ? unexpected(status) : { ok: true, analysis };
}

/** `GET /api/analyses?race_id=&kaisai_date=&limit=20`(新しい順)。D1 だけ。レース画面を開いたときに 1 回だけ呼ぶ。 */
export async function fetchPastAnalyses(fetchLike: FetchLike, date: string, raceId: string): Promise<PastAnalysesResult> {
  const got = await getJson(fetchLike, `/api/analyses?race_id=${raceId}&kaisai_date=${date}&limit=20`);
  return got === null ? { ok: false, error: { kind: "network" } } : parsePastAnalysesResponse(got.status, got.body);
}

/**
 * `GET /api/analyses/{id}`。⚠️ サーバは R2 の詳細を読み、操作回数(Class B)を +1 する(無害な読み取りではない)ので、**利用者が結果の画面を開いたときに 1 回だけ**呼び、
 * 呼び出し側(race-data.ts)がメモリにキャッシュする。ポーリングに含めない。
 */
export async function fetchAnalysis(fetchLike: FetchLike, id: number): Promise<AnalysisResult> {
  const got = await getJson(fetchLike, `/api/analyses/${id}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseAnalysisResponse(got.status, got.body);
}

/** レースの画面の状態の応答に足される、別の Worker の確率の塊(Issue #806)。馬ごとの値は `AnalysisHorse` の `modelProb`・`modelEv`・`modelAux`・`courseFit` と同じ意味。`none` は注記だけ(馬は空)。 */
export interface RaceModelBlock {
  readonly status: "ok" | "none";
  readonly stage: "final" | "preday" | "provisional" | null;
  readonly note: string;
  readonly horses: readonly { readonly umaban: number; readonly prob: number; readonly ev: number | null; readonly aux: { readonly value: number; readonly rank: number; readonly of: number } | null; readonly courseFit?: AnalysisCourseFit }[];
  readonly course?: AnalysisCourse;
}

/**
 * 状態の応答(本文全体)から `model` を読む。無い・形が崩れている・馬の 1 頭でも不正なら null(何も出さない。一部だけを黙って出さない)。
 * 馬の `courseFit` と `course` は任意で、崩れていればその欄だけ落とす(確率の表は残す)。
 */
export function parseRaceModelBlock(body: unknown): RaceModelBlock | null {
  if (!isRecord(body) || !isRecord(body["model"])) return null;
  const m = body["model"];
  const { status, stage, note, horses } = m;
  if (status !== "ok" && status !== "none") return null;
  if (stage !== null && stage !== "final" && stage !== "preday" && stage !== "provisional") return null;
  if (!isStr(note) || note === "" || !Array.isArray(horses)) return null;
  if ((status === "none") !== (horses.length === 0)) return null;
  const seen = new Set<number>();
  const out: RaceModelBlock["horses"][number][] = [];
  for (const raw of horses as unknown[]) {
    if (!isRecord(raw)) return null;
    const { umaban, prob, ev } = raw;
    if (!isNum(umaban) || !Number.isInteger(umaban) || umaban < 1 || seen.has(umaban)) return null;
    if (!isNum(prob) || prob < 0 || prob > 1 || (ev !== null && !isNum(ev))) return null;
    const aux = raw["aux"] === null ? null : parseModelAux(raw["aux"]);
    if (raw["aux"] !== null && aux === null) return null;
    seen.add(umaban);
    const fit = parseCourseFit(raw["courseFit"]);
    out.push({ umaban, prob, ev: ev === null ? null : (ev as number), aux, ...(fit === null ? {} : { courseFit: fit }) });
  }
  const course = parseCourse(m["course"]);
  return { status, stage, note, horses: out, ...(course === null ? {} : { course }) };
}

/** `fetchRaceStatus` と同じ GET の結果に、別の Worker の確率の塊(Issue #806)を足す。塊が無い・壊れているときは足さない(板と prior は壊さない)。本文は `fetchRaceStatus` と同じ 1 回の GET。 */
export async function fetchRaceStatusWithModel(fetchLike: FetchLike, date: string, raceId: string): Promise<RaceStatusResult & { readonly model?: RaceModelBlock }> {
  let raw: unknown;
  const tap: FetchLike = async (url, init) => {
    const res = await fetchLike(url, init);
    return {
      status: res.status,
      json: async () => {
        raw = await res.json();
        return raw;
      },
    };
  };
  const result = await fetchRaceStatus(tap, date, raceId);
  if (!result.ok) return result;
  const model = parseRaceModelBlock(raw);
  return model === null ? result : { ...result, model };
}
