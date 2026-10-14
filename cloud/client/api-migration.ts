/**
 * 移行(exe から移したファイルの取り込み)の API 呼び出しと応答の分類(Issue #222〈#167-B2〉)。進捗 `GET /api/migration` と、アップロード `POST /api/migration/upload`。
 * DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 進捗は、読む項目の型・範囲(件数は 0 以上の整数・state は 7 種のどれか)を満たすときだけ成功。一部だけを採用しない。余計なキーは無視する
 * (サーバが `verified`・`lastTick` のような診断項目を足しても画面は壊れない。読む項目のキー名のドリフトは `test/client-api-migration-contract.test.ts` が検出する)。
 * **サーバの文面は読まない**(アップロードの失敗は、ステータスと `error.type`〈サーバが決めた固定の識別子〉だけで分類し、固定の文言にする)。
 * **唯一の例外は進捗の `failure.message` と `conflictSamples`**(サーバが検証・取り込みの失敗の理由・衝突の例として状態に残す、固定の文言+位置+列名。例外の本文は含まれない)。画面にはテキストとして出し、`migration-model.ts` で長さを切り詰める。
 * Origin(サーバは完全一致で CSRF を拒否する): `referrerPolicy: "same-origin"` を付け、fetch の `mode` は指定しない(`api-run.ts` と同じ)。`Content-Length` は、本文が Blob(File)なのでブラウザが付ける。
 */
import { classify, isNum, isRecord, isStr, strOrNull, type ApiFailure, type FetchLike } from "./api";

export type MigrationState = "idle" | "verifying" | "importing" | "waiting-budget" | "waiting-r2" | "completed" | "failed";

const STATES: ReadonlySet<string> = new Set<MigrationState>(["idle", "verifying", "importing", "waiting-budget", "waiting-r2", "completed", "failed"]);

/** 進捗(`GET /api/migration` の応答のうち、画面が読む項目)。 */
export interface MigrationProgress {
  readonly state: MigrationState;
  readonly upload: { readonly size: number; readonly uploadedAt: string; readonly exportedAt: string | null; readonly appVersion: string | null } | null;
  readonly analyses: { readonly total: number | null; readonly processed: number; readonly imported: number; readonly alreadyImported: number; readonly conflicts: number };
  readonly results: { readonly total: number | null; readonly processed: number };
  /** 予算待ち・R2 待ち・失敗後の再試行の再開時刻(ISO)。 */
  readonly resumeAt: string | null;
  readonly failure: { readonly phase: "verify" | "import"; readonly message: string } | null;
  readonly conflictSamples: readonly string[];
  readonly attempts: number;
  readonly budget: { readonly day: string; readonly usedRows: number; readonly limitRows: number };
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const countOrNull = (v: unknown): v is number | null => v === null || isCount(v);

/** 応答の本文を検査して進捗を作る。満たさなければ null。 */
export function parseMigrationStatus(body: unknown): MigrationProgress | null {
  if (!isRecord(body) || body["ok"] !== true) return null;
  const state = body["state"];
  if (!isStr(state) || !STATES.has(state)) return null;

  const upload = body["upload"];
  let uploadView: MigrationProgress["upload"] = null;
  if (upload !== null) {
    if (!isRecord(upload) || !isCount(upload["size"]) || !isStr(upload["uploadedAt"]) || !strOrNull(upload["exportedAt"]) || !strOrNull(upload["appVersion"])) return null;
    uploadView = { size: upload["size"], uploadedAt: upload["uploadedAt"], exportedAt: upload["exportedAt"], appVersion: upload["appVersion"] };
  }

  const analyses = body["analyses"];
  if (!isRecord(analyses) || !countOrNull(analyses["total"]) || !isCount(analyses["processed"]) || !isCount(analyses["imported"]) || !isCount(analyses["alreadyImported"]) || !isCount(analyses["conflicts"])) return null;
  const results = body["results"];
  if (!isRecord(results) || !countOrNull(results["total"]) || !isCount(results["processed"])) return null;

  const resumeAt = body["resumeAt"];
  if (!strOrNull(resumeAt)) return null;

  const failure = body["failure"];
  let failureView: MigrationProgress["failure"] = null;
  if (failure !== null) {
    if (!isRecord(failure) || (failure["phase"] !== "verify" && failure["phase"] !== "import") || !isStr(failure["message"])) return null;
    failureView = { phase: failure["phase"], message: failure["message"] };
  }

  const samples = body["conflictSamples"];
  if (!Array.isArray(samples) || !samples.every(isStr)) return null;
  if (!isCount(body["attempts"])) return null;
  const budget = body["budget"];
  if (!isRecord(budget) || !isStr(budget["day"]) || !isCount(budget["usedRows"]) || !isCount(budget["limitRows"])) return null;

  return {
    state: state as MigrationState,
    upload: uploadView,
    analyses: { total: analyses["total"], processed: analyses["processed"], imported: analyses["imported"], alreadyImported: analyses["alreadyImported"], conflicts: analyses["conflicts"] },
    results: { total: results["total"], processed: results["processed"] },
    resumeAt,
    failure: failureView,
    conflictSamples: samples as string[],
    attempts: body["attempts"],
    budget: { day: budget["day"], usedRows: budget["usedRows"], limitRows: budget["limitRows"] },
  };
}

export type BackfillState = "disabled" | "waiting-migration" | "ready" | "running" | "paused" | "waiting-window" | "done";

const BACKFILL_STATES: ReadonlySet<string> = new Set<BackfillState>(["disabled", "waiting-migration", "ready", "running", "paused", "waiting-window", "done"]);

/** 結果の補完の進捗(`GET /api/results/backfill` の応答のうち、画面が読む項目。Issue #217〈#167-C〉)。 */
export interface BackfillProgress {
  readonly state: BackfillState;
  /** 残り: 開催日があり、昨日以前で、結果が無く、永久に除外していないレース。 */
  readonly remaining: number;
  /** 開催日が分からず、補完の対象外のレース。 */
  readonly undated: number;
  /** 補完で取り込めたレースの累計。 */
  readonly imported: number;
  /** 取得できず、永久に除外したレース。 */
  readonly abandoned: number;
}

/** 補完の進捗の応答を検査する。読む項目の型・範囲を満たさなければ null(一部だけを採用しない)。余計なキーは無視する。 */
export function parseBackfillStatus(body: unknown): BackfillProgress | null {
  if (!isRecord(body) || body["ok"] !== true) return null;
  const state = body["state"];
  if (!isStr(state) || !BACKFILL_STATES.has(state)) return null;
  const abandoned = body["abandoned"];
  if (!isCount(body["remaining"]) || !isCount(body["undated"]) || !isCount(body["imported"]) || !isRecord(abandoned) || !isCount(abandoned["total"])) return null;
  return { state: state as BackfillState, remaining: body["remaining"], undated: body["undated"], imported: body["imported"], abandoned: abandoned["total"] };
}

export type BackfillFetchResult = { readonly ok: true; readonly progress: BackfillProgress } | { readonly ok: false };

/**
 * `GET /api/results/backfill`。補完の進捗は移行画面の付随の情報なので、失敗の種類は分けず(`ok: false`)、画面には何も出さない。
 * 例外(同期・非同期とも)・200 以外・本文の形が違うものは、すべて `ok: false`(例外の文面を持ち込まない)。
 */
export async function fetchBackfill(fetchLike: FetchLike): Promise<BackfillFetchResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/results/backfill", { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false };
  }
  if (response.status !== 200) return { ok: false };
  const progress = parseBackfillStatus(await readBody(response));
  return progress === null ? { ok: false } : { ok: true, progress };
}

async function readBody(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export type MigrationFetchResult = { readonly ok: true; readonly progress: MigrationProgress } | { readonly ok: false; readonly error: ApiFailure };

/** `GET /api/migration`。例外(同期・非同期とも)は network にする(例外の文面は持ち込まない)。 */
export async function fetchMigration(fetchLike: FetchLike): Promise<MigrationFetchResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/migration", { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status !== 200) {
    const failure = classify(response.status, body);
    return { ok: false, error: failure.kind === "netkeiba-unavailable" ? { kind: "server-error" } : failure };
  }
  const progress = parseMigrationStatus(body);
  return progress === null ? { ok: false, error: { kind: "unexpected", httpStatus: 200 } } : { ok: true, progress };
}

/** 進捗の取得の失敗の固定の文言(サーバの文面は含めない)。 */
export function migrationFetchFailureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "forbidden":
    case "origin-mismatch":
      return "進捗を取得できませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "network":
      return "進捗の取得の通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みするか、「再読込」でもう一度取得してください。";
    case "server-error":
    case "netkeiba-unavailable":
      return "進捗を取得できませんでした。サーバでエラーが起きました。少し待ってから「再読込」を押してください。取り込みは、サーバ側で続いている場合があります。";
    case "bad-request":
    case "not-found":
    case "unexpected":
      return `進捗の応答が想定外でした${failure.kind === "unexpected" ? `(HTTP ${failure.httpStatus})` : ""}。少し待ってから「再読込」を押してください。`;
  }
}

/** アップロードの失敗の分類。 */
export type UploadFailure =
  | { readonly kind: "busy" }
  | { readonly kind: "too-large" }
  | { readonly kind: "r2-fence" }
  | { readonly kind: "bad-request" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "origin-mismatch" }
  | { readonly kind: "server-error" }
  | { readonly kind: "network" }
  | { readonly kind: "unexpected"; readonly httpStatus: number };

/** 受け付け(202)。`progress` はサーバが返した進捗(本文が想定外なら null。画面は取り直す)。 */
export type UploadResult = { readonly ok: true; readonly progress: MigrationProgress | null } | { readonly ok: false; readonly error: UploadFailure };

function classifyUpload(status: number, body: unknown): UploadFailure {
  switch (status) {
    case 409:
      return { kind: "busy" };
    case 413:
      return { kind: "too-large" };
    case 400:
    case 411:
    case 415:
      return { kind: "bad-request" };
    case 403: {
      const failure = classify(403, body);
      return failure.kind === "origin-mismatch" ? { kind: "origin-mismatch" } : { kind: "forbidden" };
    }
    case 503: {
      const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
      return error !== undefined && error["type"] === "r2-fence" ? { kind: "r2-fence" } : { kind: "server-error" };
    }
    default:
      return { kind: "unexpected", httpStatus: status };
  }
}

/** `POST /api/migration/upload`。本文は File(Blob)そのもの(全体をメモリに読まない)。 */
export async function postMigrationUpload(fetchLike: FetchLike, file: Blob): Promise<UploadResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/migration/upload", {
      method: "POST",
      credentials: "same-origin",
      // 参照元ポリシー(no-referrer)があっても Origin が付くようにする保険。fetch の mode は指定しない(`api-run.ts` の説明)。
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/gzip" },
      body: file,
    });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status === 202) {
    return { ok: true, progress: parseMigrationStatus(body) };
  }
  return { ok: false, error: classifyUpload(response.status, body) };
}

/** アップロードの失敗の固定の文言(サーバの文面は含めない)。 */
export function uploadFailureMessage(failure: UploadFailure): string {
  switch (failure.kind) {
    case "busy":
      return "取り込み中のため、アップロードできませんでした。取り込みが完了(または失敗)してから、もう一度アップロードしてください。";
    case "too-large":
      return "ファイルが大きすぎます。アップロードできるのは 50MB までです。";
    case "r2-fence":
      return "クラウドの保存先(R2)の書き込み回数の上限に達しているため、アップロードできませんでした。翌月になってから、もう一度お試しください。";
    case "bad-request":
      return "サーバがアップロードを受け付けませんでした(ファイルの形式が違う可能性があります)。exe の「クラウド移行用に書き出す」で作ったファイルを選び直してください。";
    case "origin-mismatch":
      return "アップロードできませんでした。リクエストの送信元の確認に失敗しました(Origin の不一致)。ページを再読み込みしてやり直してください。直らないときは、別のブラウザで開いてください。";
    case "forbidden":
      return "アップロードできませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてやり直してください。";
    case "network":
      return "アップロードの通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みして、もう一度お試しください。取り込みが始まっていないかは、進捗の「再読込」で確かめられます。";
    case "server-error":
      return "アップロードできませんでした。サーバでエラーが起きました。少し待ってから、もう一度お試しください。";
    case "unexpected":
      return `アップロードの応答が想定外でした(HTTP ${failure.httpStatus})。取り込みが始まったかどうかは、進捗の「再読込」で確かめられます。`;
  }
}
