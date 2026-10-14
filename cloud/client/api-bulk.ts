/**
 * 一括起動 `POST /api/analyses/run/bulk` の呼び出しと応答の分類(Issue #251)。DOM に触れない純ロジックで、`fetch` は注入する。管理者だけが使う(閲覧者には画面にボタンが無く、サーバも 403)。
 *
 * **Origin まわりは単独の起動(`postRun`。`api-run.ts` の冒頭コメントが根拠)と同じ形**: `referrerPolicy: "same-origin"` を付け、fetch の `mode` は指定しない。
 * **応答を信用しない**: 202 は本文が整っている(開催日・mode が送ったものと同じ・結果が入力と同じ件数と順序・語が固定の値)ときだけ成功。整っていなければ `accepted-malformed`
 * (サーバは受理したので、呼び出し側は失敗の文言を出したうえで追跡は始める)。409 は `day-cap`(整数の limit・used・needed つき)のときだけ採用する。サーバの `error.message` は読まない・出さない。
 */
import { isNum, isRecord, isStr, type ApiFailure, type FetchLike, type TaskMode } from "./api";
import { classifyRunFailure, runFailureMessage } from "./api-run";

export interface BulkRequest {
  /** 開催日(YYYYMMDD)。 */
  readonly date: string;
  readonly mode: TaskMode;
  /** 1 つの競馬場のレース ID(入力の順が、結果の順になる)。 */
  readonly raceIds: readonly string[];
}

/** レースごとの結果。実行中のレースはサーバが積まず、いまの状態を返す。 */
export type BulkEntry =
  | { readonly raceId: string; readonly result: "accepted" }
  | { readonly raceId: string; readonly result: "already-running"; readonly status: "queued" | "fetched" };

export type BulkOutcome =
  | { readonly kind: "accepted"; readonly results: readonly BulkEntry[] }
  /** 202 だが本文が想定外(契約のずれ)。サーバは予約を受け付けている。 */
  | { readonly kind: "accepted-malformed" }
  /** 1 日の上限を超えるので、サーバは**何も積んでいない**(全か無か)。 */
  | { readonly kind: "day-cap"; readonly limit: number; readonly used: number; readonly needed: number }
  | { readonly kind: "failed"; readonly failure: ApiFailure };

function parseEntries(body: unknown, request: BulkRequest): BulkEntry[] | null {
  if (!isRecord(body) || body["ok"] !== true || body["accepted"] !== true || body["kaisai_date"] !== request.date || body["mode"] !== request.mode) return null;
  const raw = body["results"];
  if (!Array.isArray(raw) || raw.length !== request.raceIds.length) return null;
  const entries: BulkEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (!isRecord(entry) || entry["race_id"] !== request.raceIds[i] || !isStr(entry["race_id"])) return null;
    if (entry["result"] === "accepted") {
      entries.push({ raceId: entry["race_id"], result: "accepted" });
    } else if (entry["result"] === "already-running" && (entry["status"] === "queued" || entry["status"] === "fetched")) {
      entries.push({ raceId: entry["race_id"], result: "already-running", status: entry["status"] });
    } else {
      return null;
    }
  }
  return entries;
}

function parseDayCap(body: unknown): { limit: number; used: number; needed: number } | null {
  const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
  if (error === undefined || error["type"] !== "day-cap") return null;
  const { limit, used, needed } = error;
  if (!isNum(limit) || !isNum(used) || !isNum(needed) || !Number.isInteger(limit) || !Number.isInteger(used) || !Number.isInteger(needed)) return null;
  return { limit, used, needed };
}

/** `POST /api/analyses/run/bulk`。例外(同期・非同期とも)は network にする(例外の文面は持ち込まない)。 */
export async function postBulk(fetchLike: FetchLike, request: BulkRequest): Promise<BulkOutcome> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/analyses/run/bulk", {
      method: "POST",
      credentials: "same-origin",
      // 参照元ポリシー(no-referrer)があっても Origin が付くようにする保険。fetch の mode は指定しない(`postRun` と同じ。api-run.ts の冒頭コメント)。
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ kaisai_date: request.date, mode: request.mode, race_ids: request.raceIds }),
    });
  } catch {
    return { kind: "failed", failure: { kind: "network" } };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.status === 202) {
    const results = parseEntries(body, request);
    return results !== null ? { kind: "accepted", results } : { kind: "accepted-malformed" };
  }
  if (response.status === 409) {
    const cap = parseDayCap(body);
    return cap !== null ? { kind: "day-cap", ...cap } : { kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } };
  }
  // 400・413・415 は bad-request、503 は(netkeiba の形でも)server-error。単独の起動と同じ分類。
  return { kind: "failed", failure: classifyRunFailure(response.status, body) };
}

/** 失敗の固定の文言(サーバの文面は含めない)。単独の起動と同じ。サーバは全か無かで受けるので、一時的な失敗は、もう一度押して再試行できる(実行中のレースは積まれない)。 */
export function bulkFailureMessage(failure: ApiFailure): string {
  return runFailureMessage(failure);
}
