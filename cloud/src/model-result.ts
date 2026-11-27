/**
 * 別の Worker が計算した確率の読み取り(Issue #796。`GET /v1/races/{race_id}`)と、分析の応答に足す列の組み立て。
 *
 *  - 応答の検証: 形が違うもの・範囲外の値(`p_win` が 0〜1 の外・有限でない、`umaban` が整数でない・重複、`odds_minutes_before` が 5 でない、`race_id` の不一致)は、
 *    **全体を「計算なし(unavailable)」にする**(一部だけ出さない)。値を作って埋めない。
 *  - 理由の表示は固定の語彙だけ({@link MODEL_NONE_LABELS})。外から来た理由の文字列は、語彙に無ければ「理由不明」にし、HTML に入れない。
 *  - 「確率 × 5 分前の単勝」は、本番の `odds_snapshots`(`lead_min = 5`)の単勝と掛ける。5 分前の単勝が無い馬は掛け算だけ null。
 *  - 暫定(Issue #800。`status: "none"` に `stage`・`horses` が付く応答)は「暫定」と区別して出し、応答の `odds_win` で掛ける。`stage`・`odds_source` は固定の表に無ければ暫定の列を出さない(計算なし)。
 *  - 馬ごとの補助の値(`u_mat`)は、別の Worker が返す値で、小数 2 桁に丸めた値と、そのレースの応答の中での順位・頭数を送る(Issue #805)。
 *  - バインディングが無い・地方のレースのときは null(何も読まない。応答に足さない)。
 *  - コースの参考情報(Issue #802。`course`・各馬の `course_fit`)は、確率の検査とは独立に読む(`./model-course`)。応答そのものが不正(HTTP が 200 でない・race_id の不一致・JSON でない)ときだけ出さない。
 * 純ロジック。`Fetcher`・D1 の読み出し・警告の出口は注入する。
 */
import type { AnalysisView } from "./analysis-view";
import { MODEL_BASE_URL } from "./model-hook";
import { readCourse, readCourseFit, type CourseFit, type CourseView } from "./model-course";

/** 画面の GET の時間切れ(ミリ秒)。画面の表示を遅らせない長さ。 */
export const MODEL_READ_TIMEOUT_MS = 2000;

/** 表示する理由の語彙(1 か所の表)。`unavailable` は本番の側で起きる(取得できない: 時間切れ・HTTP の誤り・形が違う)。`unknown` は語彙に無い理由。 */
export const MODEL_NONE_LABELS = {
  not_ready: "まだ計算していません",
  no_odds: "オッズの記録がありません",
  no_card: "出馬表がありません",
  failed: "計算に失敗しました",
  unavailable: "取得できませんでした",
  unknown: "理由不明",
} as const;

export type ModelNoneReason = keyof typeof MODEL_NONE_LABELS;

/** 相手から受け付ける理由(`unavailable`・`unknown` は本番の側の語。相手からは受け付けない)。 */
const ACCEPTED_REASONS: ReadonlySet<string> = new Set(["not_ready", "no_odds", "no_card", "failed"]);

/** 段階。`final` は確定(5 分前の単勝で掛ける)。`preday`・`provisional` は暫定(応答の単勝で掛ける)。 */
export type ModelStage = "final" | "preday" | "provisional";

/** 暫定の段階の表示(固定の語彙。外から来た文字列は、この表に無ければ受けない)。 */
export const MODEL_STAGE_LABELS = { preday: "前日の計算", provisional: "確定前" } as const;
type ProvisionalStage = keyof typeof MODEL_STAGE_LABELS;

/** 暫定の計算に使ったオッズの出どころ(固定の語彙)。`lead-1`・`lead-2` は odds_snapshots の lead_min の -1(前日の夜)・-2(当日の朝)。 */
export const MODEL_ODDS_SOURCE_LABELS = {
  "lead-1": "前日の夜の単勝",
  "lead-2": "当日の朝の単勝",
  lead10: "発走10分前の単勝",
  analysis: "分析時の単勝",
} as const;
type ModelOddsSource = keyof typeof MODEL_ODDS_SOURCE_LABELS;

/** 別の Worker が返す、馬ごとの補助の値(Issue #805)。`value` は小数 2 桁に丸めた値、`rank` は応答の中で値の大きい順の順位(同じ値は同じ順位。1,2,2,4)、`of` は値を持つ馬の数。 */
export interface ModelAux {
  readonly value: number;
  readonly rank: number;
  readonly of: number;
}

/** 暫定のときだけ持つ材料。`winOdds` は、その計算に使った単勝(正の有限の馬だけ)。 */
export interface ModelProvisional {
  readonly stage: ProvisionalStage;
  readonly oddsSource: ModelOddsSource;
  readonly takenAtMs: number | null;
  readonly winOdds: ReadonlyMap<number, number>;
}

export type ModelParsed =
  | { readonly kind: "ok"; readonly stage: ModelStage; readonly probs: ReadonlyMap<number, number>; readonly aux: ReadonlyMap<number, ModelAux>; readonly provisional: ModelProvisional | null }
  | { readonly kind: "none"; readonly reason: ModelNoneReason };

const UNAVAILABLE: ModelParsed = { kind: "none", reason: "unavailable" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 有限の数だけ受ける(範囲の制限はかけない)。 */
function auxValueOf(u: unknown): number | null {
  return typeof u === "number" && Number.isFinite(u) ? u : null;
}

/** 小数 2 桁に丸める(0.5 の位は絶対値が大きいほうへ)。負の 0 は 0 にする。 */
function round2(u: number): number {
  const r = Math.sign(u) * Math.round(Math.abs(u) * 100) / 100;
  return r === 0 ? 0 : r;
}

/** 馬番 → 値(丸める前)から、丸めた値・順位(丸める前の値の大きい順。同じ値は同じ順位)・頭数を作る。 */
function buildAux(raw: ReadonlyMap<number, number>): Map<number, ModelAux> {
  const out = new Map<number, ModelAux>();
  const of = raw.size;
  for (const [umaban, u] of raw) {
    let greater = 0;
    for (const v of raw.values()) if (v > u) greater++;
    out.set(umaban, { value: round2(u), rank: greater + 1, of });
  }
  return out;
}

/** 馬の並びを検証する。1 頭でも外れたら null(全体を捨てる)。`withOdds` のときは単勝の表も作る。 */
function readHorses(horses: unknown[]): { probs: Map<number, number>; aux: Map<number, ModelAux>; winOdds: Map<number, number> } | null {
  const probs = new Map<number, number>();
  const rawAux = new Map<number, number>();
  const winOdds = new Map<number, number>();
  for (const h of horses) {
    if (!isRecord(h)) return null;
    const umaban = h["umaban"];
    const p = h["p_win"];
    if (typeof umaban !== "number" || !Number.isInteger(umaban) || umaban < 1 || probs.has(umaban)) return null;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
    probs.set(umaban, p);
    const u = auxValueOf(h["u_mat"]);
    if (u !== null) rawAux.set(umaban, u);
    const o = h["odds_win"];
    if (typeof o === "number" && Number.isFinite(o) && o > 0) winOdds.set(umaban, o);
  }
  return { probs, aux: buildAux(rawAux), winOdds };
}

/** HTTP の状態と JSON の本文を検証する。`raceId` は求めたレース(応答の `race_id` と一致しなければ unavailable)。 */
export function parseModelResponse(httpStatus: number, body: unknown, raceId: string): ModelParsed {
  if (httpStatus !== 200 || !isRecord(body) || body["race_id"] !== raceId) {
    return UNAVAILABLE;
  }
  if (body["status"] === "none") {
    const reason = body["reason"];
    const none: ModelParsed = { kind: "none", reason: typeof reason === "string" && ACCEPTED_REASONS.has(reason) ? (reason as ModelNoneReason) : "unknown" };
    const stage = body["stage"];
    const source = body["odds_source"];
    // 暫定でない(stage 無し)・表に無い stage / odds_source・馬が無い/空は、従来どおり「計算なし(理由)」。
    if (typeof stage !== "string" || !Object.hasOwn(MODEL_STAGE_LABELS, stage) || typeof source !== "string" || !Object.hasOwn(MODEL_ODDS_SOURCE_LABELS, source)) return none;
    const horses = body["horses"];
    if (horses === undefined || (Array.isArray(horses) && horses.length === 0)) return none;
    if (!Array.isArray(horses)) return UNAVAILABLE;
    const taken = body["odds_taken_at_ms"];
    if (taken !== undefined && taken !== null && (typeof taken !== "number" || !Number.isFinite(taken))) return UNAVAILABLE;
    const read = readHorses(horses);
    if (read === null) return UNAVAILABLE;
    return {
      kind: "ok",
      stage: stage as ProvisionalStage,
      probs: read.probs,
      aux: read.aux,
      provisional: { stage: stage as ProvisionalStage, oddsSource: source as ModelOddsSource, takenAtMs: typeof taken === "number" ? taken : null, winOdds: read.winOdds },
    };
  }
  const stage = body["stage"];
  if (body["status"] !== "ok" || body["odds_minutes_before"] !== 5 || (stage !== undefined && stage !== "final") || !Array.isArray(body["horses"]) || body["horses"].length === 0) {
    return UNAVAILABLE;
  }
  const read = readHorses(body["horses"]);
  if (read === null) return UNAVAILABLE;
  return { kind: "ok", stage: "final", probs: read.probs, aux: read.aux, provisional: null };
}

/** 馬ごとのセル。`ev` は 確率 × 単勝(確定は 5 分前の単勝、暫定は応答の単勝。単勝が無ければ null)。`aux` は補助の値(Issue #805。無ければ null)。 */
export interface ModelCell {
  readonly prob: number;
  readonly ev: number | null;
  readonly aux: ModelAux | null;
}

export interface ModelColumn {
  readonly status: "ok" | "none";
  /** 段階。`none` のときは null。`final` 以外は暫定(画面は見出しに「暫定」を付ける)。 */
  readonly stage: ModelStage | null;
  /** 表の下に出す注記(サーバが組み立てた固定の語彙の文)。 */
  readonly note: string;
  /** 馬番 → セル。`none` のときは空。応答に無い馬は載せない(画面は —)。 */
  readonly byUmaban: ReadonlyMap<number, ModelCell>;
}

/** epoch ミリ秒 → JST の `M/D HH:MM`。 */
function jstShort(ms: number): string {
  const d = new Date(ms + 9 * 3600_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** 確率と 5 分前の単勝(馬番 → 単勝。記録が無ければ null)から列を作る。暫定のときは、応答の単勝で掛ける(`win5` は使わない)。 */
export function buildModelColumn(parsed: ModelParsed, win5: ReadonlyMap<number, number> | null): ModelColumn {
  if (parsed.kind === "none") {
    return { status: "none", stage: null, note: `新モデルの確率: 計算なし(${MODEL_NONE_LABELS[parsed.reason]})`, byUmaban: new Map() };
  }
  const prov = parsed.provisional;
  const oddsOf = prov === null ? win5 : prov.winOdds;
  const byUmaban = new Map<number, ModelCell>();
  for (const [umaban, prob] of parsed.probs) {
    const odds = oddsOf?.get(umaban);
    byUmaban.set(umaban, { prob, ev: odds === undefined ? null : prob * odds, aux: parsed.aux.get(umaban) ?? null });
  }
  if (prov !== null) {
    const at = prov.takenAtMs === null ? "" : `(${jstShort(prov.takenAtMs)} 時点)`;
    return {
      status: "ok",
      stage: parsed.stage,
      note: `新モデルの暫定の確率(${MODEL_STAGE_LABELS[prov.stage]})。計算に使ったオッズ: ${MODEL_ODDS_SOURCE_LABELS[prov.oddsSource]}${at}。確率 × 単勝は、そのオッズで掛けた値`,
      byUmaban,
    };
  }
  const note =
    win5 === null
      ? "新モデルが計算した勝つ確率。発走5分前の単勝の記録が無いため、確率 × 単勝は —"
      : "新モデルが計算した勝つ確率と、確率 × 発走5分前の単勝(記録の無い馬は —)";
  return { status: "ok", stage: "final", note, byUmaban };
}

/** 分析の応答に列の材料を足す(元の view は変えない)。列が無い(null)ときは何も足さない(キーも増やさない)。 */
export function attachModel<V extends Pick<AnalysisView, "horses">>(view: V, column: ModelColumn | null): V {
  if (column === null) {
    return view;
  }
  return {
    ...view,
    horses: view.horses.map((h) => {
      const cell = column.byUmaban.get(h.umaban);
      return { ...h, modelProb: cell?.prob ?? null, modelEv: cell?.ev ?? null, modelAux: cell?.aux ?? null };
    }),
    modelStatus: column.status,
    modelStage: column.stage,
    modelNote: column.note,
  };
}

/** コースの参考情報(Issue #802)。`course` は崩れていれば null。`fits` は馬番 → その馬の欄(崩れた馬・欄の無い馬は載せない)。 */
export interface ModelCourseInfo {
  readonly course: CourseView | null;
  readonly fits: ReadonlyMap<number, CourseFit>;
}

/** 応答からコースの参考情報を読む。応答そのものが不正・足せるものが何も無い(今の版)ときは null。確率の検査(`parseModelResponse`)には影響しない。 */
export function parseModelCourse(httpStatus: number, body: unknown, raceId: string): ModelCourseInfo | null {
  if (httpStatus !== 200 || !isRecord(body) || body["race_id"] !== raceId) return null;
  const course = readCourse(body["course"]);
  const fits = new Map<number, CourseFit>();
  const horses = body["horses"];
  if (Array.isArray(horses)) {
    for (const h of horses) {
      if (!isRecord(h)) continue;
      const umaban = h["umaban"];
      if (typeof umaban !== "number" || !Number.isInteger(umaban) || umaban < 1 || fits.has(umaban)) continue;
      const fit = readCourseFit(h["course_fit"]);
      if (fit !== null) fits.set(umaban, fit);
    }
  }
  return course === null && fits.size === 0 ? null : { course, fits };
}

/** 分析の応答にコースの参考情報を足す(元の view は変えない)。足すものが無い(null)ときは同じ view を返す(キーを増やさない)。 */
export function attachCourse<V extends { horses: readonly object[] }>(view: V, info: ModelCourseInfo | null): V {
  if (info === null) return view;
  return {
    ...view,
    ...(info.course === null ? {} : { course: info.course }),
    horses: view.horses.map((h) => {
      const fit = info.fits.get((h as { umaban: number }).umaban);
      return fit === undefined ? h : { ...h, courseFit: fit };
    }),
  };
}

export interface LoadModelDeps {
  /** バインディング(無ければ何もしない)。 */
  readonly model: Fetcher | undefined;
  /** 5 分前の単勝(馬番 → 単勝)。記録が無ければ null。失敗は投げてよい(確率だけ出す)。 */
  readonly readWinOdds: (raceId: string) => Promise<ReadonlyMap<number, number> | null>;
  readonly timeoutMs?: number;
}

export interface ModelResult {
  readonly column: ModelColumn;
  /** コースの参考情報(Issue #802)。応答が不正・欄が無いときは null。 */
  readonly course: ModelCourseInfo | null;
}

/** 中央のレースだけ。MODEL が無い・地方なら null(MODEL も D1 も呼ばない)。投げない。GET は 1 回で、確率の列とコースの両方を返す(Issue #802)。 */
export async function loadModelResult(deps: LoadModelDeps, raceId: string, warn: (message: string) => void): Promise<ModelResult | null> {
  if (deps.model === undefined || !/^\d{12}$/.test(raceId) || Number(raceId.slice(4, 6)) > 10) {
    return null;
  }
  const model = deps.model;
  const timeoutMs = deps.timeoutMs ?? MODEL_READ_TIMEOUT_MS;
  const readParsed = async (): Promise<{ parsed: ModelParsed; course: ModelCourseInfo | null }> => {
    try {
      const res = await model.fetch(`${MODEL_BASE_URL}/v1/races/${raceId}`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { parsed: parseModelResponse(res.status, body, raceId), course: parseModelCourse(res.status, body, raceId) };
    } catch {
      warn(`別の Worker の確率を読めませんでした(${raceId}。例外または時間切れ)`);
      return { parsed: UNAVAILABLE, course: null };
    }
  };
  const readOdds = async (): Promise<ReadonlyMap<number, number> | null> => {
    try {
      return await deps.readWinOdds(raceId);
    } catch {
      warn(`5 分前の単勝の記録を読めませんでした(${raceId})`);
      return null;
    }
  };
  const [{ parsed, course }, win5] = await Promise.all([readParsed(), readOdds()]);
  return { column: buildModelColumn(parsed, win5), course };
}

/**
 * レースの画面の状態の応答(`GET /api/analyses/status?race_id=`。Issue #806)に足す、検査済みの塊。馬ごとの確率・確率×単勝・補助・コース成績と、コース・段階・注記。
 * 計算なし(`status: "none"`)は注記だけ(馬の配列は空)。`loadModelResult` が null(地方・バインディングなし)なら null(応答にキーを足さない)。
 */
export interface ModelBlock {
  readonly status: "ok" | "none";
  readonly stage: ModelStage | null;
  readonly note: string;
  readonly horses: readonly { readonly umaban: number; readonly prob: number; readonly ev: number | null; readonly aux: ModelAux | null; readonly courseFit?: CourseFit }[];
  readonly course?: CourseView;
}

export function modelBlockOf(result: ModelResult | null): ModelBlock | null {
  if (result === null) return null;
  const { column, course } = result;
  if (column.status === "none") {
    return { status: "none", stage: null, note: column.note, horses: [] };
  }
  const horses = [...column.byUmaban].map(([umaban, cell]) => {
    const fit = course?.fits.get(umaban);
    return { umaban, prob: cell.prob, ev: cell.ev, aux: cell.aux, ...(fit === undefined ? {} : { courseFit: fit }) };
  });
  return { status: "ok", stage: column.stage, note: column.note, horses, ...(course?.course == null ? {} : { course: course.course }) };
}

/** 確率の列だけ(従来の入口。{@link loadModelResult} の薄い包み)。 */
export async function loadModelColumn(deps: LoadModelDeps, raceId: string, warn: (message: string) => void): Promise<ModelColumn | null> {
  return (await loadModelResult(deps, raceId, warn))?.column ?? null;
}
