/**
 * 起動 `POST /api/analyses/run` の呼び出しと応答の分類(Issue #186)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **Origin(サーバは Origin の完全一致で CSRF を拒否する。無い・`null`・違うものは 403)**:
 * ページは全応答に `Referrer-Policy: no-referrer` を付けている。現行の Fetch 仕様(「append a request `Origin` header」)では、
 * 「mode が cors 以外」のときに限り、参照元ポリシーが no-referrer だと Origin が `null` になる。`fetch("/path", {method: "POST"})` の既定は mode が cors
 * (`new Request(string)` が mode を "cors" にする)なので、**仕様どおりなら Origin は実際のオリジンになり、`referrerPolicy` の指定は不要**。
 * それでも `referrerPolicy: "same-origin"` を付けるのは、仕様と違うブラウザがあっても Origin が付くようにするための保険(同じオリジンの Referer が付くだけで、害はない)。
 * **fetch の `mode` は指定しない**(`same-origin` などを入れると、no-referrer のとき実際に `Origin: null` になり、サーバが 403 を返す)。
 * Node の undici は古い仕様の実装(この条件が無い)なので、Node のテストでは Origin の挙動を確かめられない。**実ブラウザでの確認は、本番での実機確認項目**。
 *
 * **応答を信用しない**: 202 は本文が整っているときだけ成功(整っていなければ `accepted-malformed`=サーバは受理したので、呼び出し側は失敗の文言を出したうえで追跡は始める)。
 * 409 は本文が `already-running` で status が queued・fetched のときだけ採用する。サーバの `error.message` は読まない・出さない。
 */
import { classify, isRecord, isStr, type ApiFailure, type FetchLike, type TaskMode } from "./api";

export type RunFailure = ApiFailure;

export type RunOutcome =
  | { readonly kind: "accepted" }
  /** 202 だが本文が想定外(契約のずれ)。サーバは予約を受け付けている。 */
  | { readonly kind: "accepted-malformed" }
  | { readonly kind: "already-running"; readonly status: "queued" | "fetched" }
  | { readonly kind: "failed"; readonly failure: RunFailure };

export interface RunRequest {
  readonly raceId: string;
  /** 開催日(YYYYMMDD)。 */
  readonly date: string;
  readonly mode: TaskMode;
}

function parseAccepted(body: unknown, request: RunRequest): boolean {
  return (
    isRecord(body) &&
    body["ok"] === true &&
    body["accepted"] === true &&
    body["race_id"] === request.raceId &&
    body["kaisai_date"] === request.date &&
    body["mode"] === request.mode &&
    body["status"] === "queued"
  );
}

function parseAlreadyRunning(body: unknown): "queued" | "fetched" | null {
  const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
  if (error === undefined || error["type"] !== "already-running") return null;
  const status = error["status"];
  return isStr(status) && (status === "queued" || status === "fetched") ? status : null;
}

/** 失敗(200・202・409 以外)を、起動用の分類にする。400・413・415 は bad-request、503 は(netkeiba の形でも)server-error。 */
export function classifyRunFailure(status: number, body: unknown): RunFailure {
  if (status === 400 || status === 413 || status === 415) return { kind: "bad-request" };
  const failure = classify(status, body);
  return failure.kind === "netkeiba-unavailable" ? { kind: "server-error" } : failure;
}

/** `POST /api/analyses/run`。例外(同期・非同期とも)は network にする(例外の文面は持ち込まない)。 */
export async function postRun(fetchLike: FetchLike, request: RunRequest): Promise<RunOutcome> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/analyses/run", {
      method: "POST",
      credentials: "same-origin",
      // 参照元ポリシー(no-referrer)があっても Origin が付くようにする保険。fetch の mode は指定しない(上の説明)。
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ race_id: request.raceId, kaisai_date: request.date, mode: request.mode }),
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
    return parseAccepted(body, request) ? { kind: "accepted" } : { kind: "accepted-malformed" };
  }
  if (response.status === 409) {
    const status = parseAlreadyRunning(body);
    return status !== null ? { kind: "already-running", status } : { kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } };
  }
  return { kind: "failed", failure: classifyRunFailure(response.status, body) };
}

/** 起動の失敗の固定の文言(サーバの文面は含めない)。一時的な失敗は、もう一度押して再試行できることを示す。 */
export function runFailureMessage(failure: RunFailure): string {
  switch (failure.kind) {
    case "origin-mismatch":
      return "起動のリクエストの送信元の確認に失敗しました(Origin の不一致)。ページを再読み込みしてください。直らないときは、別のブラウザで開いてください。";
    case "forbidden":
      return "起動できませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "network":
      return "起動の通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みしてください。もう一度押して再試行することもできます。";
    case "bad-request":
      return "起動のリクエストが正しくありません(日付・レースを確認してください)。";
    case "server-error":
    case "netkeiba-unavailable":
      return "起動できませんでした。サーバでエラーが起きました。少し待ってから、もう一度押してください。";
    case "not-found":
    case "unexpected":
      return `起動の応答が想定外でした${failure.kind === "unexpected" ? `(HTTP ${failure.httpStatus})` : ""}。少し待ってから、もう一度押してください。`;
  }
}
