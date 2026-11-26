/**
 * 別の Worker が計算した確率の読み取り(Issue #796。`GET /v1/races/{race_id}`)と、分析の応答に足す列の組み立て。
 *
 *  - 応答の検証: 形が違うもの・範囲外の値(`p_win` が 0〜1 の外・有限でない、`umaban` が整数でない・重複、`odds_minutes_before` が 5 でない、`race_id` の不一致)は、
 *    **全体を「計算なし(unavailable)」にする**(一部だけ出さない)。値を作って埋めない。
 *  - 理由の表示は固定の語彙だけ({@link MODEL_NONE_LABELS})。外から来た理由の文字列は、語彙に無ければ「理由不明」にし、HTML に入れない。
 *  - 「確率 × 5 分前の単勝」は、本番の `odds_snapshots`(`lead_min = 5`)の単勝と掛ける。5 分前の単勝が無い馬は掛け算だけ null。
 *  - バインディングが無い・地方のレースのときは null(何も読まない。応答に足さない)。
 * 純ロジック。`Fetcher`・D1 の読み出し・警告の出口は注入する。
 */
import type { AnalysisView } from "./analysis-view";
import { MODEL_BASE_URL } from "./model-hook";

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

export type ModelParsed =
  | { readonly kind: "ok"; readonly probs: ReadonlyMap<number, number> }
  | { readonly kind: "none"; readonly reason: ModelNoneReason };

const UNAVAILABLE: ModelParsed = { kind: "none", reason: "unavailable" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** HTTP の状態と JSON の本文を検証する。`raceId` は求めたレース(応答の `race_id` と一致しなければ unavailable)。 */
export function parseModelResponse(httpStatus: number, body: unknown, raceId: string): ModelParsed {
  if (httpStatus !== 200 || !isRecord(body) || body["race_id"] !== raceId) {
    return UNAVAILABLE;
  }
  if (body["status"] === "none") {
    const reason = body["reason"];
    return { kind: "none", reason: typeof reason === "string" && ACCEPTED_REASONS.has(reason) ? (reason as ModelNoneReason) : "unknown" };
  }
  if (body["status"] !== "ok" || body["odds_minutes_before"] !== 5 || !Array.isArray(body["horses"]) || body["horses"].length === 0) {
    return UNAVAILABLE;
  }
  const probs = new Map<number, number>();
  for (const h of body["horses"] as unknown[]) {
    if (!isRecord(h)) return UNAVAILABLE;
    const umaban = h["umaban"];
    const p = h["p_win"];
    if (typeof umaban !== "number" || !Number.isInteger(umaban) || umaban < 1 || probs.has(umaban)) return UNAVAILABLE;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return UNAVAILABLE;
    probs.set(umaban, p);
  }
  return { kind: "ok", probs };
}

/** 馬ごとのセル。`ev` は 確率 × 5 分前の単勝(単勝が無ければ null)。 */
export interface ModelCell {
  readonly prob: number;
  readonly ev: number | null;
}

export interface ModelColumn {
  readonly status: "ok" | "none";
  /** 表の下に出す注記(サーバが組み立てた固定の語彙の文)。 */
  readonly note: string;
  /** 馬番 → セル。`none` のときは空。応答に無い馬は載せない(画面は —)。 */
  readonly byUmaban: ReadonlyMap<number, ModelCell>;
}

/** 確率と 5 分前の単勝(馬番 → 単勝。記録が無ければ null)から列を作る。 */
export function buildModelColumn(parsed: ModelParsed, win5: ReadonlyMap<number, number> | null): ModelColumn {
  if (parsed.kind === "none") {
    return { status: "none", note: `別の Worker の確率: 計算なし(${MODEL_NONE_LABELS[parsed.reason]})`, byUmaban: new Map() };
  }
  const byUmaban = new Map<number, ModelCell>();
  for (const [umaban, prob] of parsed.probs) {
    const odds = win5?.get(umaban);
    byUmaban.set(umaban, { prob, ev: odds === undefined ? null : prob * odds });
  }
  const note =
    win5 === null
      ? "別の Worker が計算した勝つ確率。発走5分前の単勝の記録が無いため、確率 × 単勝は —"
      : "別の Worker が計算した勝つ確率と、確率 × 発走5分前の単勝(記録の無い馬は —)";
  return { status: "ok", note, byUmaban };
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
      return { ...h, modelProb: cell?.prob ?? null, modelEv: cell?.ev ?? null };
    }),
    modelStatus: column.status,
    modelNote: column.note,
  };
}

export interface LoadModelDeps {
  /** バインディング(無ければ何もしない)。 */
  readonly model: Fetcher | undefined;
  /** 5 分前の単勝(馬番 → 単勝)。記録が無ければ null。失敗は投げてよい(確率だけ出す)。 */
  readonly readWinOdds: (raceId: string) => Promise<ReadonlyMap<number, number> | null>;
  readonly timeoutMs?: number;
}

/** 中央のレースだけ。MODEL が無い・地方なら null(MODEL も D1 も呼ばない)。投げない。 */
export async function loadModelColumn(deps: LoadModelDeps, raceId: string, warn: (message: string) => void): Promise<ModelColumn | null> {
  if (deps.model === undefined || !/^\d{12}$/.test(raceId) || Number(raceId.slice(4, 6)) > 10) {
    return null;
  }
  const model = deps.model;
  const timeoutMs = deps.timeoutMs ?? MODEL_READ_TIMEOUT_MS;
  const readParsed = async (): Promise<ModelParsed> => {
    try {
      const res = await model.fetch(`${MODEL_BASE_URL}/v1/races/${raceId}`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return parseModelResponse(res.status, body, raceId);
    } catch {
      warn(`別の Worker の確率を読めませんでした(${raceId}。例外または時間切れ)`);
      return UNAVAILABLE;
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
  const [parsed, win5] = await Promise.all([readParsed(), readOdds()]);
  return buildModelColumn(parsed, win5);
}
