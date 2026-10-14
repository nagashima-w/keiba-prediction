/**
 * 確認用のチェック処理(Issue #162 段階2b)。本番(Cloudflare 上)で、**ゲート経由のソケット取得 → core の `HttpClient` → 既存パーサ**が
 * 通ることを、出馬表1本で確かめる(`GET /api/netkeiba/check?race_id=...`)。
 *
 * **`fetchRaw` を受け取る関数にしてある**(ゲートの RPC を直接は握らない)。Worker での decode + parse の CPU が足りなかった場合
 * (本番で 1102)に、同じ関数を DO の中へ移せるようにするため。偽の `fetchRaw` でテストできる。
 *
 * race_id は core の `parseRaceId`(中央 場コード01〜10・地方 30〜64・帯広 65 は対象外・地方は月日の実在を検証)で検証し、
 * 取得先の URL は core の `shutubaUrl`(中央 race.netkeiba.com・地方 nar.netkeiba.com を場コードで選ぶ)で組み立てる。
 * 検証を通らなければ、ゲートを呼ばない(呼び出し側の責務。ここでは `validateRaceId` を先に使う)。
 *
 * Issue #181: 同じ確認ページで、**重賞の過去10年傾向の API への POST を1本**試せる({@link runGradeWinnerCheck}。`?type=grade-winner`)。
 * 本番で最初に「Cloudflare の出口からの POST が通るか」を確かめるためのもの。**キャッシュを通さない**(ゲートを直接使う。キャッシュに当たると何も測れない)。
 */

import { InvalidIdError, parseRaceId, venueKindOfRaceId, type RaceId } from "../../packages/core/src/scraper/ids.js";
import { HttpError } from "../../packages/core/src/scraper/http-client.js";
import { fetchGradeWinnerEntries } from "../../packages/core/src/scraper/fetch-grade-winner.js";
import { parseShutuba } from "../../packages/core/src/scraper/parse-shutuba.js";
import { shutubaUrl } from "../../packages/core/src/scraper/urls.js";
import type { GatePostRequest, GateResult, GateStatus } from "./gate-core";
import { createGateHttpClient, GateRefusedError } from "./gate-fetch";

export type RaceKind = "central" | "nar";

export type RaceIdCheck =
  | { readonly ok: true; readonly raceId: RaceId; readonly kind: RaceKind }
  | { readonly ok: false; readonly message: string };

/** メッセージに入れる入力の最大長(長い入力をそのまま返さない)。 */
const ECHO_LIMIT = 32;

/** race_id を検証する(中央・地方とも)。無効なら理由つきで返す(例外を投げない)。 */
export function validateRaceId(input: string | null): RaceIdCheck {
  if (input === null) {
    return { ok: false, message: "race_id が指定されていません" };
  }
  try {
    // 12 桁を超える入力は、先頭 32 文字に切っても必ず無効のままなので、検証の結果は変わらない。
    const raceId = parseRaceId(input.slice(0, ECHO_LIMIT));
    return { ok: true, raceId, kind: venueKindOfRaceId(raceId) };
  } catch (error) {
    if (error instanceof InvalidIdError) {
      return { ok: false, message: error.message };
    }
    return { ok: false, message: "race_id を検証できませんでした" };
  }
}

/** ゲートの `fetchRaw`(RPC)の形。 */
export type FetchRaw = (url: string) => Promise<GateResult>;

/** ゲートの `postRaw`(RPC。Issue #181)の形。 */
export type PostRaw = (request: GatePostRequest) => Promise<GateResult>;

/** 確認の種類(`?type=`)。`shutuba` が既定(GET。出馬表)、`grade-winner` は POST(重賞の過去10年傾向の API)。 */
export type CheckTarget = "shutuba" | "grade-winner";

export type CheckErrorType =
  /** ゲートが取得を拒否した(ブレーカー・待ち行列・通信失敗など。`reason` を持つ)。 */
  | "gate-refused"
  /** HTTP の応答が 2xx ではなかった(`status` を持つ)。 */
  | "http-error"
  /** 取得の呼び出し自体の失敗(RPC の失敗など)。 */
  | "fetch-failed"
  /** 取得できたが、出馬表として読めなかった。 */
  | "parse-error";

export type CheckBody =
  | {
      readonly ok: true;
      readonly kind: RaceKind;
      readonly raceId: string;
      readonly status: number;
      /** 出馬表から読めた頭数。 */
      readonly horses: number;
      /** 呼び出しから取得の開始まで(待ち行列と 2 秒間隔の待ち)。 */
      readonly queuedMs: number;
      /** 取得の開始から終了まで(ソケットの接続・送受信)。 */
      readonly elapsedMs: number;
      /** ゲートの状態(ブレーカー・最後の開始時刻・待ち)。ハンドラが添える。 */
      readonly gate?: GateStatus;
    }
  | {
      /** POST の確認(Issue #181)の成功: 通信とパースが通った。 */
      readonly ok: true;
      readonly kind: RaceKind;
      readonly raceId: string;
      readonly target: "grade-winner";
      readonly status: number;
      /** 読めた過去回の数(中央は 10 のことが多い)。対象データなし(`status:NG`。非重賞)は null。 */
      readonly entries: number | null;
      readonly queuedMs: number;
      readonly elapsedMs: number;
      readonly gate?: GateStatus;
    }
  | {
      readonly ok: false;
      readonly kind: RaceKind;
      readonly raceId: string;
      /** POST の確認の失敗のときだけ付く(出馬表の確認の本文には付けない)。 */
      readonly target?: "grade-winner";
      readonly error: { readonly type: CheckErrorType; readonly message: string; readonly reason?: string };
      /** 受信したステータス(応答を得ていれば)。 */
      readonly status?: number;
      readonly queuedMs?: number;
      readonly elapsedMs?: number;
      readonly gate?: GateStatus;
    };

export interface CheckResult {
  /** この確認ページ自身の HTTP ステータス(成功 200、ブレーカー・待ち行列は 503、そのほかの取得の失敗は 502)。 */
  readonly httpStatus: number;
  readonly body: CheckBody;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Received = Extract<GateResult, { kind: "response" }>;
type FailureBase = { readonly kind: RaceKind; readonly raceId: string; readonly target?: "grade-winner" };

/** 取得の失敗(例外)を、確認の結果にする(出馬表・POST の確認で共通)。 */
function failureOf(error: unknown, base: FailureBase, got: Received | null): CheckResult {
  const refused = error instanceof HttpError && error.cause instanceof GateRefusedError ? error.cause : null;
  if (refused !== null) {
    return {
      httpStatus: refused.reason === "blocked" || refused.reason === "post-blocked" || refused.reason === "queue-full" ? 503 : 502,
      body: { ok: false, ...base, error: { type: "gate-refused", message: refused.message, reason: refused.reason } },
    };
  }
  if (error instanceof HttpError && error.status !== undefined) {
    return {
      httpStatus: 502,
      body: {
        ok: false,
        ...base,
        error: { type: "http-error", message: error.message },
        status: error.status,
        ...(got !== null ? { queuedMs: got.queuedMs, elapsedMs: got.elapsedMs } : {}),
      },
    };
  }
  return { httpStatus: 502, body: { ok: false, ...base, error: { type: "fetch-failed", message: messageOf(error) } } };
}

/** 出馬表を1本取得して読む。例外は投げず、失敗も値で返す。 */
export async function runShutubaCheck(raceId: RaceId, fetchRaw: FetchRaw): Promise<CheckResult> {
  const kind = venueKindOfRaceId(raceId);
  const base = { kind, raceId: String(raceId) } as const;

  // 最後に受け取った応答(ステータス・時間)を控える(HttpClient は非 2xx で応答を捨てて例外にするため)。
  let received: Received | null = null;
  const client = createGateHttpClient({
    fetchRaw: async (url) => {
      const result = await fetchRaw(url);
      if (result.kind === "response") {
        received = result;
      }
      return result;
    },
  });

  let html: string;
  try {
    html = await client.fetchText(shutubaUrl(raceId), { encoding: "utf-8" });
  } catch (error) {
    return failureOf(error, base, received as Received | null);
  }

  const got = received as Received | null;
  try {
    const shutuba = parseShutuba(html);
    return {
      httpStatus: 200,
      body: {
        ok: true,
        ...base,
        status: got?.status ?? 200,
        horses: shutuba.horses.length,
        queuedMs: got?.queuedMs ?? 0,
        elapsedMs: got?.elapsedMs ?? 0,
      },
    };
  } catch (error) {
    return {
      httpStatus: 502,
      body: {
        ok: false,
        ...base,
        error: { type: "parse-error", message: messageOf(error) },
        ...(got !== null ? { status: got.status, queuedMs: got.queuedMs, elapsedMs: got.elapsedMs } : {}),
      },
    };
  }
}

/**
 * 重賞の過去10年傾向の API へ POST を1本送って読む(Issue #181)。core の `fetchGradeWinnerEntries` をそのまま使い(本番の分析と同じ組み立て・同じパース)、
 * 取得器は**キャッシュなし**のゲート経由の `HttpClient`(間隔 0・再試行 0)。例外は投げず、失敗も値で返す。
 * 成功の `entries` は読めた過去回の数(対象データなし〈`status:NG`〉は null)。
 */
export async function runGradeWinnerCheck(raceId: RaceId, postRaw: PostRaw): Promise<CheckResult> {
  const kind = venueKindOfRaceId(raceId);
  const base = { kind, raceId: String(raceId), target: "grade-winner" } as const;

  let received: Received | null = null;
  const client = createGateHttpClient({
    // この確認では GET は使わない(呼ばれたら、組み立ての誤り)。
    fetchRaw: async () => {
      throw new Error("POST の確認で GET が呼ばれました");
    },
    postRaw: async (request) => {
      const result = await postRaw(request);
      if (result.kind === "response") {
        received = result;
      }
      return result;
    },
  });

  let entries: Awaited<ReturnType<typeof fetchGradeWinnerEntries>>;
  try {
    entries = await fetchGradeWinnerEntries(raceId, { fetcher: client });
  } catch (error) {
    // 通信の失敗(HttpError・ゲートの拒否)と、200 で受け取ったあとのパースの失敗(GradeWinnerParseError)を分ける。
    const got = received as Received | null;
    if (got !== null && got.status >= 200 && got.status <= 299 && !(error instanceof HttpError)) {
      return {
        httpStatus: 502,
        body: { ok: false, ...base, error: { type: "parse-error", message: messageOf(error) }, status: got.status, queuedMs: got.queuedMs, elapsedMs: got.elapsedMs },
      };
    }
    return failureOf(error, base, got);
  }

  const got = received as Received | null;
  return {
    httpStatus: 200,
    body: {
      ok: true,
      ...base,
      status: got?.status ?? 200,
      entries: entries === null ? null : entries.length,
      queuedMs: got?.queuedMs ?? 0,
      elapsedMs: got?.elapsedMs ?? 0,
    },
  };
}
