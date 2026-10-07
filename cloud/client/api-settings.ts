/**
 * 設定の取得 `GET /api/settings` と保存 `POST /api/settings` の呼び出しと応答の分類(Issue #189)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 成功は、`settings` が全 14 項目を持ち(余計なキーなし)、各値が**読む側**の範囲(`isReadable`。サーバが返すのは読む側の値なので、
 * 書く側より広い: kelly の 0・2,000 文字超の追加指示も含む)を満たすときだけ。型違い・欠損・余計なキーは「想定外」(`unexpected`)で、一部の項目だけを採用しない。
 * サーバの文面(`error.message`・例外の文面・`fields`)は読まない・出さない。種類ごとの固定の文言(`settingsFailureMessage`)にする。
 * Origin(サーバは完全一致で CSRF を拒否する): `referrerPolicy: "same-origin"` を付け、fetch の `mode` は指定しない(`api-run.ts` と同じ。理由はそちらの説明)。
 * サーバ側のキー名・形のドリフトは `test/client-api-settings-contract.test.ts`(実際の `handle()` の応答を通す)が検出する。
 * 述語(範囲)は `cloud/src/settings.ts`(依存を持たない純モジュール)をそのまま使う(クライアントとサーバで述語を2つ持たない)。
 */
import { CLOUD_SETTINGS_KEYS, CLOUD_SETTINGS_RULES, type CloudSettings } from "../src/settings";
import { classify, isRecord, type ApiFailure, type FetchLike } from "./api";

export type SettingsSource = "default" | "d1" | "invalid";

export type SettingsLoadResult =
  | { readonly ok: true; readonly settings: CloudSettings; readonly source: SettingsSource }
  | { readonly ok: false; readonly error: ApiFailure };
export type SettingsSaveResult = { readonly ok: true; readonly settings: CloudSettings } | { readonly ok: false; readonly error: ApiFailure };

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

/** 応答の settings を検査して作る(全項目あり・余計なキーなし・各値が読む側の範囲)。満たさなければ null。 */
function parseSettings(raw: unknown): CloudSettings | null {
  if (!isRecord(raw)) return null;
  const known = new Set<string>(CLOUD_SETTINGS_KEYS);
  if (Object.keys(raw).some((k) => !known.has(k))) return null;
  const out: Record<string, unknown> = {};
  for (const key of CLOUD_SETTINGS_KEYS) {
    const value = raw[key];
    // 値が範囲内でも、キー自体が無い(undefined)なら不可(isReadable は undefined を通さない項目だけだが、念のため own プロパティを確かめる)。
    if (!Object.prototype.hasOwnProperty.call(raw, key) || !(CLOUD_SETTINGS_RULES[key] as { isReadable(v: unknown): boolean }).isReadable(value)) return null;
    out[key] = value;
  }
  return out as unknown as CloudSettings;
}

async function readBody(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** 失敗(200 以外)の分類。400・413・415 は bad-request、503 は(netkeiba の形でも)server-error。 */
function classifyFailure(status: number, body: unknown): ApiFailure {
  if (status === 413 || status === 415) return { kind: "bad-request" };
  const failure = classify(status, body);
  return failure.kind === "netkeiba-unavailable" ? { kind: "server-error" } : failure;
}

/** `GET /api/settings`。例外(同期・非同期とも)は network にする(例外の文面は持ち込まない)。 */
export async function fetchSettings(fetchLike: FetchLike): Promise<SettingsLoadResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/settings", { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status !== 200) {
    return { ok: false, error: classifyFailure(response.status, body) };
  }
  const source = isRecord(body) ? body["source"] : undefined;
  const settings = isRecord(body) && body["ok"] === true ? parseSettings(body["settings"]) : null;
  if (settings === null || (source !== "default" && source !== "d1" && source !== "invalid")) {
    return { ok: false, error: { kind: "unexpected", httpStatus: 200 } };
  }
  return { ok: true, settings, source };
}

/** `POST /api/settings`(全項目の置き換え)。成功は、サーバが返した(保存した)設定。 */
export async function postSettings(fetchLike: FetchLike, settings: CloudSettings): Promise<SettingsSaveResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/settings", {
      method: "POST",
      credentials: "same-origin",
      // 参照元ポリシー(no-referrer)があっても Origin が付くようにする保険。fetch の mode は指定しない(`api-run.ts` の説明)。
      referrerPolicy: "same-origin",
      headers: JSON_HEADERS,
      body: JSON.stringify(settings),
    });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status !== 200) {
    return { ok: false, error: classifyFailure(response.status, body) };
  }
  const saved = isRecord(body) && body["ok"] === true ? parseSettings(body["settings"]) : null;
  if (saved === null) {
    return { ok: false, error: { kind: "unexpected", httpStatus: 200 } };
  }
  return { ok: true, settings: saved };
}

/** 失敗の固定の文言(サーバの文面は含めない)。`op`: 取得(load)か保存(save)か。 */
export function settingsFailureMessage(failure: ApiFailure, op: "load" | "save"): string {
  if (op === "load") {
    switch (failure.kind) {
      case "forbidden":
      case "origin-mismatch":
        return "設定を取得できませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
      case "network":
        return "設定の取得の通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みしてください。「再読込」でもう一度取得できます。";
      case "server-error":
      case "netkeiba-unavailable":
        return "設定を取得できませんでした。サーバでエラーが起きました。少し待ってから「再読込」を押してください。";
      case "bad-request":
      case "not-found":
      case "unexpected":
        return `設定の取得の応答が想定外でした${failure.kind === "unexpected" ? `(HTTP ${failure.httpStatus})` : ""}。少し待ってから「再読込」を押してください。`;
    }
  }
  switch (failure.kind) {
    case "origin-mismatch":
      return "設定を保存できませんでした。リクエストの送信元の確認に失敗しました(Origin の不一致)。入力した内容は残っています。ページを再読み込みすると失われるので、控えてから再読み込みしてください。直らないときは、別のブラウザで開いてください。";
    case "forbidden":
      return "設定を保存できませんでした。アクセスできません。ログインの期限切れかもしれません。入力した内容は残っています。ページを再読み込みすると失われるので、控えてから再読み込みしてください。";
    case "network":
      return "設定の保存の通信に失敗しました。入力した内容は残っています。ログインの期限切れかもしれません。もう一度「保存」を押して再試行できます。";
    case "bad-request":
      return "設定を保存できませんでした。サーバが入力を受け付けませんでした(範囲外の値かもしれません)。入力した内容は残っています。内容を確認してください。";
    case "server-error":
    case "netkeiba-unavailable":
      return "設定を保存できませんでした。サーバでエラーが起きました。入力した内容は残っています。少し待ってから、もう一度「保存」を押してください。";
    case "not-found":
    case "unexpected":
      return `設定の保存の応答が想定外でした${failure.kind === "unexpected" ? `(HTTP ${failure.httpStatus})` : ""}。保存できたかどうかは「再読込」で確かめられます(入力した内容は残っています)。`;
  }
}
