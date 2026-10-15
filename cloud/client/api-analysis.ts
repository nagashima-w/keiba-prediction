/**
 * 分析の一覧・詳細の API 呼び出しと応答のパーサ(Issue #185)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**(`api.ts` と同じ): 型違い・キーの欠落は「想定外の応答」(`unexpected`)にし、一部だけを黙って落として返さない。
 * 配分は core の表示関数(`view/allocation-proposal-view.ts` の `buildAllocationProposalView`。旧 exe と共有していた)の入力型 `StoredAllocationView` に写す。**キーが 1 つでも欠けたら想定外**にする
 * (欠けたまま `undefined` を渡すと、フォールバックの注記が消える・「単位額が記録されていません」と誤って表示される、など利用者に見える誤りになる)。
 * 未知の `route` 文字列は通す(表示関数が「判定不能」の注記にする)。
 * サーバ側のキー名・形のドリフトは `test/client-api-analysis-contract.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */
import type { StoredAllocationBetView, StoredAllocationView } from "../../packages/core/src/analysis/analysis-types";
import { classify, getJson, isNum, isRecord, isStr, strOrNull, type ApiFailure, type FetchLike } from "./api";

/** 過去の分析の一覧の 1 件(`GET /api/analyses` の要約から、画面に使う項目だけ)。 */
export interface PastAnalysis {
  readonly id: number;
  readonly analyzedAt: string;
  readonly evEstimated: boolean;
  readonly model: string | null;
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
  /** スタート直後の位置(Issue #311。レース再生の演出用。0〜1 で小さいほど前)。戦績が取れない馬・過去の分析・詳細なし・キー無し(古いサーバの応答)は null。パーサは常にキーを持つ。型で省略可なのは、この項目を使わない固定データ(テスト・画面の材料)を壊さないため(`baba`・`combos` と同じ流儀)。 */
  readonly earlyPos?: number | null;
  /** 脚質(Issue #314。レース再生の隊列を脚質で決める演出用)。戦績が取れない馬・過去の分析・詳細なし・キー無し(古いサーバの応答)・4 値以外の値は null。パーサは常にキーを持つ(型で省略可な理由は `earlyPos` と同じ)。 */
  readonly legStyle?: LegStyle | null;
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

/** 組合せの券種ごとの行(Issue #296)。サーバが組み立てた文章(取得の点数・EV プラスの点数・配分の点数)。 */
export interface AnalysisCombos {
  readonly lines: readonly string[];
}

/** `combos.lines` の上限(Issue #296)。券種は 6 つ・1 行は 100 字前後。想定外に大きい応答は読まない(null にする)。 */
const COMBOS_MAX_LINES = 6;
const COMBOS_MAX_LINE_LENGTH = 300;

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
    /** 想定複勝オッズの基準(Issue #253。top3=3着内率〈8頭以上〉・top2=2着内率〈5〜7頭。複勝は2着まで〉・null=出さない〈4頭以下〉)。 */
    readonly placeBasis: "top3" | "top2" | null;
    /** 距離(m。Issue #311。レース再生のコース図に使う)。詳細なし・キー無し(古いサーバの応答)は null。パーサは常にキーを持つ(型で省略可なのは `turn` と同じ理由)。 */
    readonly distance?: number | null;
    /** コースの回り(Issue #311。レース再生のコース図の向き)。キー無し(古いサーバの応答)は right。 */
    readonly turn?: "right" | "left";
    /** 想定ペース(Issue #314。レース再生の隊列の長さ・動き出しの演出用。サーバがプロンプトの展開想定と同じ判定で求める)。キー無し(古いサーバの応答)・形が不正な値は「不明」(補助の演出なので、分析全体の解析は失敗させない)。 */
    readonly pace?: PaceEstimate;
  };
  /**
   * そのとき LLM が見た当日の馬場の値(Issue #295)。地方・LLM を使わない分析・計測が無い日・詳細なし・古い分析は null。キー無し(古いサーバの応答)・形が不正な値も null にする
   * (補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。
   */
  readonly baba?: AnalysisBaba | null;
  /**
   * 組合せの券種ごとの行(Issue #296。オッズの取得点数・EV プラスの点数・配分の点数)。組合せの記録が無い・詳細なし・キー無し(古いサーバの応答)・形が不正な値は null にする
   * (補助の表示なので、分析全体の解析は失敗させない)。省略可なのは、キーの無い応答を表すため。
   */
  readonly combos?: AnalysisCombos | null;
  readonly horses: readonly AnalysisHorse[];
  readonly allocation: StoredAllocationView | null;
  readonly detail: DetailState;
}

export type PastAnalysesResult = { readonly ok: true; readonly analyses: PastAnalysis[] } | { readonly ok: false; readonly error: ApiFailure };
export type AnalysisResult = { readonly ok: true; readonly analysis: AnalysisDetail } | { readonly ok: false; readonly error: ApiFailure };

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const boolOrNull = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);

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

/** 文字列だけの配列(キーの欠落・配列でない・文字列でない要素が1つでもあれば false。黙って落として空にしない)。 */
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function parseHorse(row: unknown): AnalysisHorse | null {
  if (!isRecord(row)) return null;
  const { umaban, name, prior, adjustedProb, placeOddsMin, ev, isPositive, mark, reason, highlights, concerns, winProb, fairWinOdds, winOdds, fairPlaceOdds, actualPlaceOddsMin, actualPlaceOddsMax } = row;
  if (!isNum(umaban) || !strOrNull(name) || !isNum(prior) || !isNum(adjustedProb) || !numOrNull(placeOddsMin) || !numOrNull(ev) || !isBool(isPositive) || !strOrNull(mark) || !strOrNull(reason)) {
    return null;
  }
  if (!isStrArray(highlights) || !isStrArray(concerns)) return null;
  // Issue #247: 勝率・想定・実際は、キーが欠けたら(undefined)想定外。有限の数か null だけ(黙って null にしない)。
  if (!numOrNull(winProb) || !numOrNull(fairWinOdds) || !numOrNull(winOdds)) return null;
  // Issue #253: 想定複勝・実際の複勝の下限と上限も同じ(キーが欠けたら想定外)。
  if (!numOrNull(fairPlaceOdds) || !numOrNull(actualPlaceOddsMin) || !numOrNull(actualPlaceOddsMax)) return null;
  // Issue #311: スタート直後の位置は、キー無し(古いサーバの応答)は null。数・null 以外の型は想定外。
  const earlyPos = row["earlyPos"] ?? null;
  if (!numOrNull(earlyPos)) return null;
  // Issue #314: 脚質は、キー無し・4 値以外は null(補助の演出なので、応答ごと不正にはしない)。
  const legStyle = LEG_STYLES.find((s) => s === row["legStyle"]) ?? null;
  // 配列は複製して持つ(応答の本体と配列を共有しない)。
  return { umaban, name, prior, adjustedProb, placeOddsMin, ev, isPositive, mark, reason, highlights: [...highlights], concerns: [...concerns], winProb, fairWinOdds, winOdds, fairPlaceOdds, actualPlaceOddsMin, actualPlaceOddsMax, earlyPos, legStyle };
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
  // コースの回り(Issue #311): キー無し(古いサーバの応答)は right。right・left 以外の値は想定外。
  const distance = race["distance"] ?? null;
  if (!numOrNull(distance)) return null;
  const turn = race["turn"] === undefined ? "right" : race["turn"];
  if (turn !== "right" && turn !== "left") return null;
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
  return {
    id,
    raceId,
    analyzedAt,
    kaisaiDate,
    evEstimated,
    model,
    llmNote,
    llmCalls: parsedCalls,
    race: { venueName: race["venueName"], raceNumber: race["raceNumber"], raceName: race["raceName"], grade, oddsStatus: race["oddsStatus"], placeBasis, distance, turn, pace },
    baba: parseLines(value["baba"], BABA_MAX_LINES, BABA_MAX_LINE_LENGTH),
    combos: parseLines(value["combos"], COMBOS_MAX_LINES, COMBOS_MAX_LINE_LENGTH),
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
 * 呼び出し側(app.ts)がメモリにキャッシュする。ポーリングに含めない。
 */
export async function fetchAnalysis(fetchLike: FetchLike, id: number): Promise<AnalysisResult> {
  const got = await getJson(fetchLike, `/api/analyses/${id}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseAnalysisResponse(got.status, got.body);
}
