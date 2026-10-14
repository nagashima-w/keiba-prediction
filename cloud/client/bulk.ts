/**
 * 一覧の「競馬場ごとの一括実行」(Issue #251。管理者だけ)の、表示用データ(純関数)。`list.ts` が場のまとまりごとに {@link buildBulkModel} を呼び、`view.ts` が VNode にする。
 *
 * 決めたこと(ユーザー決定・2026-10-10):
 *  - ボタンは、競馬場を開いたときだけ、中の上部に 2 つ(事前分析・発走前の分析)出す。
 *  - 対象から除く: 実行中(queued・fetched)・完了済み(done)。発走前の分析では、さらに**発走済み**と**発走時刻が不明**(今日の開催日のとき。課金を増やす側に倒さない)。除いた件数は確認画面に出す。失敗(failed)は含める(再試行)。
 *  - 押すと**確認画面**(画面内の 2 段階。`window.confirm` は使わない)を挟む。出すのは対象の件数と LLM の呼び出し回数だけ(円換算はしない)。発走前の分析では、2 つの注意書きを必ず出す
 *    (自動の分析〈発走の N 分前〉は別に走り、二重に課金されうる/一括で積むと直列の処理のため、自動の分析の開始が遅れうる)。
 *  - 過去の開催日・実行状態(板)が取れていないときは、ボタンを無効にして理由を出す。
 *  - 発走済みの判定はこの画面だけ(サーバは強制しない。単独の起動と同じ)。
 */
import type { BoardRow, RaceRow, TaskMode } from "./api";
import type { BulkEntry } from "./api-bulk";
import { todayJst } from "./date";

export const MODE_LABELS: Readonly<Record<TaskMode, string>> = { morning: "事前分析", pre_race: "発走前の分析" };

/** 対象から除いた件数(区分は排他。実行中・完了済みが先で、発走済み・時刻不明は、それ以外のレースだけを数える)。 */
export interface BulkExclusions {
  readonly running: number;
  readonly done: number;
  readonly started: number;
  readonly timeUnknown: number;
}

export interface BulkSelection {
  /** 対象のレース ID(入力のレースの順)。 */
  readonly raceIds: readonly string[];
  readonly excluded: BulkExclusions;
}

/** 現在の JST の `HH:MM`(発走予定時刻と文字列で比べる)。UTC に 9 時間を足した時刻。 */
export function jstHm(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

export interface SelectInput {
  readonly mode: TaskMode;
  readonly races: readonly RaceRow[];
  readonly board: readonly BoardRow[];
  /** 開催日(YYYYMMDD)。 */
  readonly date: string;
  readonly now: Date;
}

/**
 * 一括の対象を選ぶ。(レース, mode) の板の行が queued・fetched なら実行中、done なら完了済みとして除く。
 * 発走前(`pre_race`)で開催日が今日(JST)のときだけ、発走予定時刻が現在以前なら発走済み(ちょうども含む)、時刻が無ければ不明として除く(未来の開催日は時刻を見ない)。
 */
export function selectBulkTargets(input: SelectInput): BulkSelection {
  const today = todayJst(input.now) === input.date;
  const hm = jstHm(input.now);
  const raceIds: string[] = [];
  let running = 0;
  let done = 0;
  let started = 0;
  let timeUnknown = 0;
  for (const race of input.races) {
    const status = input.board.find((r) => r.raceId === race.raceId && r.mode === input.mode)?.status;
    if (status === "queued" || status === "fetched") {
      running += 1;
    } else if (status === "done") {
      done += 1;
    } else if (input.mode === "pre_race" && today && race.startTime === null) {
      timeUnknown += 1;
    } else if (input.mode === "pre_race" && today && race.startTime !== null && race.startTime <= hm) {
      started += 1;
    } else {
      raceIds.push(race.raceId);
    }
  }
  return { raceIds, excluded: { running, done, started, timeUnknown } };
}

/** 場ごとの一括実行の操作の状態(`app.ts` が持つ。キーは場のまとまりのキー)。 */
export type BulkUi =
  /** 確認画面。押した時点の対象(raceIds)と除外の件数を覚える(画面の件数と、実行で送る対象を一致させる)。 */
  | { readonly kind: "confirm"; readonly mode: TaskMode; readonly raceIds: readonly string[]; readonly excluded: BulkExclusions }
  | { readonly kind: "sending"; readonly mode: TaskMode }
  /** 結果の表示(成功・失敗)。閉じるまで残す。 */
  | { readonly kind: "result"; readonly tone: "ok" | "error"; readonly text: string };

export interface BulkButton {
  readonly mode: TaskMode;
  /** 「事前分析を一括実行(6)」。括弧の中は対象の件数。 */
  readonly label: string;
  readonly count: number;
  readonly disabled: boolean;
}

export type BulkPanel =
  | {
      readonly kind: "confirm";
      readonly mode: TaskMode;
      readonly title: string;
      readonly count: number;
      readonly lines: readonly string[];
      readonly notes: readonly string[];
      readonly goLabel: string;
      readonly cancelLabel: string;
    }
  | { readonly kind: "sending"; readonly mode: TaskMode; readonly text: string }
  | { readonly kind: "result"; readonly tone: "ok" | "error"; readonly text: string };

export interface BulkModel {
  readonly date: string;
  /** 事前分析・発走前の分析の順。 */
  readonly buttons: readonly BulkButton[];
  /** ボタンが無効な理由(無いときは null)。 */
  readonly note: string | null;
  readonly panel: BulkPanel | null;
}

export const PAST_DATE_NOTE = "過去の開催日には一括実行できません。";
export const NO_BOARD_NOTE = "実行状態を取得できていないため、一括実行できません。「更新」を押してください。";

const MODES: readonly TaskMode[] = ["morning", "pre_race"];

function excludedLine(excluded: BulkExclusions): string | null {
  const parts: string[] = [];
  if (excluded.running > 0) parts.push(`実行中 ${excluded.running}`);
  if (excluded.done > 0) parts.push(`完了済み ${excluded.done}`);
  if (excluded.started > 0) parts.push(`発走済み ${excluded.started}`);
  if (excluded.timeUnknown > 0) parts.push(`発走時刻が不明 ${excluded.timeUnknown}`);
  return parts.length === 0 ? null : `除外: ${parts.join("・")}`;
}

function confirmPanel(groupName: string, ui: Extract<BulkUi, { kind: "confirm" }>): BulkPanel {
  const n = ui.raceIds.length;
  const lines: string[] = [`対象: ${n} レース`];
  const notes: string[] = [];
  if (ui.mode === "morning") {
    lines.push("LLM は使いません(netkeiba から出馬表・オッズ・戦績・調教を取得するだけです)。");
    lines.push("取得は 1 レースずつ順に進みます(1 レースあたり 1 分弱が目安です。頭数によります)。");
  } else {
    lines.push(`LLM の呼び出し: 通常 ${n} 回(失敗したときは 1 回だけ再試行するため、最大 ${n * 2} 回)。API キーが登録されているときだけ LLM を呼び、未登録なら統計のみで保存します。`);
    notes.push("自動の分析(発走の N 分前)は別に走ります。ここで分析したレースも、自動の分析が走ると二重に課金されることがあります。");
    notes.push("一括で積むと、レースは 1 つずつ順に処理されます。その間、自動の分析の開始が遅れることがあります。");
  }
  const excluded = excludedLine(ui.excluded);
  if (excluded !== null) lines.push(excluded);
  return { kind: "confirm", mode: ui.mode, title: `${groupName}の${MODE_LABELS[ui.mode]}を一括実行しますか`, count: n, lines, notes, goLabel: "実行する", cancelLabel: "やめる" };
}

export interface BuildBulkInput {
  readonly date: string;
  /** 場の名前(確認画面の見出し)。 */
  readonly groupName: string;
  /** この場のレース。 */
  readonly races: readonly RaceRow[];
  /** 板の行。取れていなければ null(ボタンを無効にする)。 */
  readonly board: readonly BoardRow[] | null;
  readonly now: Date;
  readonly ui: BulkUi | undefined;
}

export function buildBulkModel(input: BuildBulkInput): BulkModel {
  const past = input.date < todayJst(input.now);
  const noBoard = input.board === null;
  const sending = input.ui?.kind === "sending";
  const buttons = MODES.map((mode): BulkButton => {
    const count = selectBulkTargets({ mode, races: input.races, board: input.board ?? [], date: input.date, now: input.now }).raceIds.length;
    return { mode, label: `${MODE_LABELS[mode]}を一括実行(${count})`, count, disabled: past || noBoard || sending || count === 0 };
  });
  let panel: BulkPanel | null = null;
  const ui = input.ui;
  if (ui !== undefined) {
    if (ui.kind === "confirm") panel = confirmPanel(input.groupName, ui);
    else if (ui.kind === "sending") panel = { kind: "sending", mode: ui.mode, text: `${MODE_LABELS[ui.mode]}を予約しています…` };
    else panel = { kind: "result", tone: ui.tone, text: ui.text };
  }
  return { date: input.date, buttons, note: past ? PAST_DATE_NOTE : noBoard ? NO_BOARD_NOTE : null, panel };
}

/** 受理された結果の文言(受け付けた件数と、実行中で見送った件数)。 */
export function bulkAcceptedText(results: readonly BulkEntry[]): string {
  const accepted = results.filter((r) => r.result === "accepted").length;
  const running = results.length - accepted;
  const tail = "進み具合は各レースのバッジで確認できます。";
  if (accepted === 0) return `予約したレースはありません(すべて実行中でした)。${tail}`;
  return `${accepted} レースを予約しました${running > 0 ? `(実行中のため見送り: ${running} レース)` : ""}。${tail}`;
}

/** 1 日の上限を超えて、何も予約しなかったときの文言。 */
export function bulkDayCapText(cap: { readonly limit: number; readonly used: number; readonly needed: number }): string {
  return `この開催日に受け付けられる上限(${cap.limit})を超えるため、何も予約していません(現在 ${cap.used}・追加で必要 ${cap.needed})。`;
}
