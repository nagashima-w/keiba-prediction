/**
 * 移行画面(`#migration`)の表示用データ(Issue #222〈#167-B2〉。純関数)。`view.ts` がこれを VNode にする。状態(進捗の取得・選んだファイル・検証・アップロード)を受け取り、
 * 文言・ボタンの有効/無効・進捗バーを導く(DOM・fetch・時計に触れない)。
 *
 * **サーバ由来の文(進捗の `failure.message`・`conflictSamples`)は、長さを切り詰めてテキストとして出す**(`clip`)。サーバが決めた固定の文言+位置+列名で、例外の本文は含まれないが、
 * 値の全文が入りうる経路でも画面を壊さないための歯止め。アップロードの応答の文面は読まない(固定の文言。`api-migration.ts`)。
 * 取り込み中の 4 状態(verifying・importing・waiting-budget・waiting-r2)では、ファイルを選ばせず始めさせない(サーバも 409 で断る。画面で先に防ぐ)。
 * 説明文は、サーバでの検証(取り込みの変換)で止まりうること(クライアントの検証は形式まで)にも触れる。
 */
import { formatJstDateTime } from "./date";
import type { MigrationProgress } from "./api-migration";
import type { ValidatedSummary } from "./migration-file";

/** 進捗の取得の状態。 */
export type MigrationLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly progress: MigrationProgress };

/** 選んだファイルの検証の状態。`percent` は読んだ割合(0〜99。終わるまで 100 にしない)。 */
export type MigrationCheckState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly percent: number; readonly lines: number }
  | { readonly kind: "ok"; readonly summary: ValidatedSummary }
  | { readonly kind: "invalid"; readonly message: string };

/** アップロードの状態。`sent`: 受け付けられた(進捗が取り込みに移る)。 */
export type MigrationUploadState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "error"; readonly message: string };

export interface MigrationModelInput {
  readonly load: MigrationLoadState;
  readonly file: { readonly name: string; readonly size: number } | null;
  readonly check: MigrationCheckState;
  readonly upload: MigrationUploadState;
  /** 進捗の自動更新を止めている(通信の失敗が続いた)。 */
  readonly pollStopped: boolean;
}

export type Tone = "info" | "ok" | "error" | "wait";

export interface ProgressView {
  readonly tone: Tone;
  /** 状態の見出し(1 文)。 */
  readonly headline: string;
  /** 件数・日時などの行。 */
  readonly lines: readonly string[];
  /** 進捗バー(分析+結果の処理済み / 全体)。全体が分からない間は null。 */
  readonly bar: { readonly value: number; readonly max: number } | null;
  /** 衝突の注記(完了時に衝突があるときだけ)。 */
  readonly conflicts: { readonly text: string; readonly samples: readonly string[] } | null;
  /** 失敗の理由(failed のときだけ)。 */
  readonly failure: { readonly heading: string; readonly reason: string; readonly hint: string } | null;
}

export interface CheckView {
  readonly tone: Tone;
  readonly lines: readonly string[];
  readonly bar: { readonly value: number; readonly max: number } | null;
}

export interface MigrationModel {
  readonly kind: "migration";
  readonly backHref: "#settings";
  readonly intro: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly pollNotice: string | null;
  readonly progress: ProgressView | null;
  readonly reloadDisabled: boolean;
  /** ファイル選択を出す(押せる)か。 */
  readonly canPick: boolean;
  /** 選べない・始められない理由(取り込み中のとき)。 */
  readonly pickNote: string | null;
  readonly file: { readonly name: string; readonly sizeText: string } | null;
  readonly check: CheckView | null;
  readonly canCancelCheck: boolean;
  readonly start: { readonly visible: boolean; readonly enabled: boolean; readonly label: string };
  readonly uploadNotice: { readonly tone: "ok" | "error"; readonly text: string } | null;
}

/** 設定画面の「exe から移行」の節(要点と、移行の画面へのリンク)。 */
export const MIGRATION_SETTINGS_SECTION = {
  heading: "exe から移行",
  lines: [
    "exe に溜まった分析と結果を、このクラウド版に移せます(exe の「クラウド移行用に書き出す」で作ったファイルを使います)。",
    "無料枠の書き込み上限のため、数日に分けて自動で取り込まれます。同じファイルをもう一度上げても重複しません。",
  ],
  linkLabel: "移行の画面を開く",
  href: "#migration",
} as const;

const INTRO: readonly string[] = [
  "exe の「クラウド移行用に書き出す」で作ったファイル(.ndjson.gz)から、これまでの分析(馬ごとの評価・買い目・配分の記録)と、レースの結果(着順・払戻)をクラウド版に移します。netkeiba から集めた取得キャッシュは移しません。",
  "ファイルはこのブラウザで先に全行を検証し、壊れている・途中で切れている・形式の版が違う場合はアップロードしません。",
  "クラウドの無料枠の書き込み上限のため、取り込みは数日に分けて自動で進みます。この画面を閉じても続きます(開き直すと今の進捗が見えます)。",
  "同じファイルをもう一度アップロードしても重複しません(取り込み済みの分析は飛ばします)。",
  "検証が通っても、取り込みの途中で内容が原因で止まることがあります(サーバでも検証します)。その場合は何も書き込まれず、下の進捗に理由が表示されます。",
];

const BUSY: ReadonlySet<string> = new Set(["verifying", "importing", "waiting-budget", "waiting-r2"]);
const REASON_MAX = 300;
const SAMPLE_MAX = 120;

/** 長さの歯止め。上限を超える分は「…」にする(結果は上限+1 文字まで)。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 3 桁区切り。 */
function n(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function sizeText(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function jst(iso: string): string {
  return formatJstDateTime(iso);
}

function resumeText(resumeAt: string | null): string {
  return resumeAt === null ? "自動で再開します" : `${jst(resumeAt)}(JST)ごろに自動で再開します`;
}

function buildProgress(p: MigrationProgress): ProgressView {
  const lines: string[] = [];
  const totals = p.analyses.total !== null && p.results.total !== null;
  // 全体が 0(分析も結果も無いファイル)のときは、割合が定義できないので出さない(`progress` の max は 1 以上)。
  const bar = totals && p.analyses.total! + p.results.total! > 0 ? { value: Math.min(p.analyses.processed + p.results.processed, p.analyses.total! + p.results.total!), max: p.analyses.total! + p.results.total! } : null;
  let tone: Tone = "info";
  let headline: string;
  switch (p.state) {
    case "idle":
      headline = "取り込みはまだ行われていません(ファイルをアップロードすると始まります)。";
      break;
    case "verifying":
      headline = "サーバでファイルを検証しています(検証が終わると取り込みが始まります)。";
      break;
    case "importing":
      headline = "取り込み中です。";
      break;
    case "waiting-budget":
      tone = "wait";
      headline = `1 日の書き込み上限に達したため一時停止中です。${resumeText(p.resumeAt)}。`;
      break;
    case "waiting-r2":
      tone = "wait";
      headline = `R2(分析の詳細の保存先)の書き込み回数の上限に達したため一時停止中です。${resumeText(p.resumeAt)}(翌月)。`;
      break;
    case "completed":
      tone = "ok";
      headline = "取り込みが完了しました。";
      break;
    case "failed":
      tone = "error";
      headline = "取り込みに失敗しました。";
      break;
  }
  if (p.state !== "idle" && p.state !== "verifying") {
    const a = p.analyses;
    const total = (v: number | null): string => (v === null ? "?" : n(v));
    lines.push(`分析: ${n(a.processed)} / ${total(a.total)} 件(新規 ${n(a.imported)}・取り込み済み ${n(a.alreadyImported)}・衝突 ${n(a.conflicts)})`);
    lines.push(`結果: ${n(p.results.processed)} / ${total(p.results.total)} レース`);
  }
  if ((p.state === "importing" || p.state === "waiting-budget") && p.attempts > 0) {
    lines.push(`エラーが続いています(連続 ${n(p.attempts)} 回。自動で再試行します)。`);
  }
  if (p.state === "importing" || p.state === "waiting-budget") {
    lines.push(`今日の書き込み: ${n(p.budget.usedRows)} / ${n(p.budget.limitRows)} 行(UTC の日付で数えます)`);
  }
  if (p.upload !== null) {
    lines.push(`アップロード: ${jst(p.upload.uploadedAt)}(JST)・${sizeText(p.upload.size)}`);
    if (p.upload.exportedAt !== null) {
      lines.push(`書き出し: ${jst(p.upload.exportedAt)}(JST)${p.upload.appVersion === null ? "" : `・exe ${p.upload.appVersion}`}`);
    }
  }
  const conflicts =
    p.state === "completed" && p.analyses.conflicts > 0
      ? {
          text: `衝突 ${n(p.analyses.conflicts)} 件: exe の分析 id が同じで、レースまたは分析日時が違う分析は、上書きせず取り込まずに飛ばしました(exe の DB を作り直した場合などに起こります)。`,
          samples: p.conflictSamples.slice(0, 5).map((s) => clip(s, SAMPLE_MAX)),
        }
      : null;
  const failure =
    p.state === "failed" && p.failure !== null
      ? {
          heading: p.failure.phase === "verify" ? "サーバでの検証で失敗しました。何も取り込まれていません。" : "取り込みの途中で失敗しました。途中までは取り込まれています。",
          reason: clip(p.failure.message, REASON_MAX),
          hint:
            p.failure.phase === "verify"
              ? "ファイルを作り直して、もう一度アップロードしてください。"
              : "もう一度アップロードすると、取り込み済みの分は飛ばして続きから取り込みます。",
        }
      : null;
  return { tone, headline, lines, bar, conflicts, failure };
}

function buildCheck(check: MigrationCheckState): CheckView | null {
  switch (check.kind) {
    case "idle":
      return null;
    case "checking":
      return { tone: "info", lines: [`検証中… ${check.percent}%(読んだ行 ${n(check.lines)})`, "ファイルはこのブラウザで確認しています。まだ送信していません。"], bar: { value: check.percent, max: 100 } };
    case "ok": {
      const s = check.summary;
      return {
        tone: "ok",
        lines: [
          `検証に成功しました。分析 ${n(s.analyses)} 件・結果 ${n(s.results)} レース。`,
          `書き出し: ${jst(s.exportedAt)}(JST)・exe ${s.appVersion}`,
          "「取り込みを始める」を押すとアップロードします。",
        ],
        bar: null,
      };
    }
    case "invalid":
      return { tone: "error", lines: ["このファイルは取り込めません。アップロードしません。", `理由: ${clip(check.message, REASON_MAX)}`], bar: null };
  }
}

export function buildMigrationModel(input: MigrationModelInput): MigrationModel {
  const { load, file, check, upload } = input;
  const progress = load.kind === "ready" ? load.progress : null;
  const busyOnServer = progress !== null && BUSY.has(progress.state);
  const checking = check.kind === "checking";
  const sending = upload.kind === "sending";
  const ready = load.kind === "ready";
  const canPick = ready && !busyOnServer && !checking && !sending;
  const startVisible = file !== null && check.kind === "ok";
  const canStart = ready && !busyOnServer && !sending;
  return {
    kind: "migration",
    backHref: "#settings",
    intro: INTRO,
    loading: load.kind === "loading",
    error: load.kind === "error" ? load.message : null,
    pollNotice: input.pollStopped ? "進捗の自動更新を止めました(通信の失敗が続きました)。「再読込」で最新の状態を取得できます。取り込みは、サーバ側で続いている場合があります。" : null,
    progress: progress === null ? null : buildProgress(progress),
    reloadDisabled: load.kind === "loading",
    canPick,
    pickNote: busyOnServer ? "取り込み中のため、ファイルは選べません。完了(または失敗)してから、もう一度アップロードしてください。" : null,
    file: file === null ? null : { name: file.name, sizeText: sizeText(file.size) },
    check: buildCheck(check),
    canCancelCheck: checking,
    start: { visible: startVisible, enabled: startVisible && canStart, label: sending ? "アップロード中…" : "取り込みを始める" },
    uploadNotice:
      upload.kind === "error"
        ? { tone: "error", text: upload.message }
        : upload.kind === "sent"
          ? { tone: "ok", text: "アップロードしました。サーバで検証したあと、取り込みが始まります。進捗は下に表示されます。" }
          : null,
  };
}
