/**
 * 今日の狙い目(`#targets`。Issue #336)の表示用データ(純関数)。`view.ts` がこれを VNode にする。
 * 未発走(発走の近い順。時刻不明は末尾)と発走済み(下。新しいものが先)に分け、残り時間の文言を作る。「今」は引数(端末の時計をサーバの時刻で補正した値。`targets-screen.ts`)。
 * 文言(要約・場と R・◎・2 行目)はサーバが組み立てたものをそのまま使う。ここで作る日本語は残り時間だけ(束を太らせない)。
 */
import type { TargetRace, TargetsData } from "./api-targets";
import { ymdToInput } from "./date";
import { buildHash } from "./route";

const MIN = 60_000;
/** 発走までこの時間以内なら「間近」(行を強調する)。 */
const SOON_MS = 10 * MIN;
/** 地方の場コードの下限(中央は 01〜10)。race_id の 5〜6 桁目。 */
const NAR_TRACK_CODE_MIN = 30;

/** 発走までの残りの文言(「あと12分」)。1 分未満は「まもなく」、発走の瞬間以降は「発走済み」、時刻なしは「時刻不明」。 */
export function remainingText(startMs: number | null, nowMs: number): { readonly text: string; readonly soon: boolean } {
  if (startMs === null) return { text: "時刻不明", soon: false };
  const diff = startMs - nowMs;
  if (diff <= 0) return { text: "発走済み", soon: false };
  const m = Math.floor(diff / MIN);
  const text = diff < MIN ? "まもなく" : m < 60 ? `あと${m}分` : `あと${Math.floor(m / 60)}時間${m % 60 === 0 ? "" : `${m % 60}分`}`;
  return { text, soon: diff <= SOON_MS };
}

export interface TargetRow {
  readonly key: string;
  /** 結果画面へのリンク。 */
  readonly href: string;
  /** 「15:40」。時刻不明は「--:--」。 */
  readonly time: string;
  readonly place: string;
  /** 「◎7」。◎が無ければ空。 */
  readonly pick: string;
  readonly detail: string;
  /** 残り時間の文言。 */
  readonly left: string;
  readonly soon: boolean;
  readonly skipped: boolean;
}

export interface TargetsModel {
  readonly kind: "targets";
  /** 一覧(その日・中央)へ戻るリンク先。 */
  readonly backHref: string;
  /** 「2026-10-17」。 */
  readonly dateLabel: string;
  /** 取得中(「更新」を無効にする)。 */
  readonly loading: boolean;
  readonly error: string | null;
  /** サーバの要約(件数の内訳。0 件の理由を区別する)。取れていなければ null。 */
  readonly summary: string | null;
  readonly upcoming: readonly TargetRow[];
  readonly past: readonly TargetRow[];
}

export interface TargetsModelInput {
  readonly date: string;
  readonly data: TargetsData | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** 補正後の現在時刻(UTC のエポックミリ秒)。 */
  readonly nowMs: number;
}

function rowOf(date: string, r: TargetRace, nowMs: number): TargetRow {
  const left = remainingText(r.startMs, nowMs);
  const venue = Number(r.raceId.slice(4, 6)) >= NAR_TRACK_CODE_MIN ? "nar" : "central";
  return { key: r.raceId, href: buildHash({ date, venue, analysis: r.analysisId }), time: r.startTime ?? "--:--", place: r.place, pick: r.pick ?? "", detail: r.detail, left: left.text, soon: left.soon, skipped: r.skipped };
}

export function buildTargetsModel(input: TargetsModelInput): TargetsModel {
  const { date, nowMs } = input;
  const races = input.data?.races ?? [];
  const started = (r: TargetRace): boolean => r.startMs !== null && r.startMs <= nowMs;
  return {
    kind: "targets",
    backHref: buildHash({ date, venue: "central" }),
    dateLabel: ymdToInput(date),
    loading: input.loading,
    error: input.error,
    summary: input.data === null ? null : input.data.summary,
    upcoming: races.filter((r) => !started(r)).map((r) => rowOf(date, r, nowMs)),
    past: races.filter(started).map((r) => rowOf(date, r, nowMs)).reverse(),
  };
}
