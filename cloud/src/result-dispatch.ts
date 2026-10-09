/**
 * 結果の取り込みの依頼(Issue #208〈#182-B〉)。cron の `scheduled`(JST 9:00。過去 7 日)・手動の `POST /api/results/import`(窓より古いぶんの取り込み)・結果の補完(Issue #217〈#167-C〉。`result-backfill-core.ts`。
 * 移行の完了後、夜間に古いレースを少しずつ)の**3 箇所が同じ関数**を呼ぶ(`dispatchResultImports(` の呼び出し箇所は `scheduled.ts`・`handler.ts`・`result-backfill-core.ts` の 1 つずつ。`scripts/test/cloud-config-guard.test.ts` が固定する)。補完は列挙(`DispatchStore`)だけを自分のもの
 * (最も新しい未取込の日を 1 日・除外つき)に差し替え、依頼の仕方は同じ。
 * `cloudflare:workers` を import しない(Node でそのままテストできる)。ここは「どの日の・どのレースを、その日の DO に依頼するか」だけで、netkeiba にも LLM にも直接は出ない
 * (取得・保存は、依頼を受けた日単位の DO がアラームの中で行う)。**`requestResultImport` の呼び出し箇所はこのファイルの 1 つだけ**(`scripts/test/cloud-config-guard.test.ts` が固定する)。
 *
 *  - 列挙は **1 クエリ**({@link DispatchStore.listUnimportedRacesByDay}。窓の全日にわたって、1 日 {@link RESULT_PER_DAY_LIMIT} 件・未取込のある日を新しい順に `maxDays` 日・合計 {@link RESULT_TOTAL_LIMIT} 件)。
 *    日ごとに引かないのは D1 の「1 回の呼び出しで 50 クエリ」の制約(手動は最大 31 日)のため。1 日の件数の上限があるので、古い日の永久に取り込めないレース(中止など)が、新しい日を押しのけない。
 *  - 依頼する日数は {@link CRON_RESULT_MAX_DAYS}(cron)・{@link MANUAL_RESULT_MAX_DAYS}(手動)に絞る: 過去日の DO が多数同時に gate に並ぶと、gate の待ち行列の上限(8)が埋まり、
 *    画面で開いた一覧まで拒否されるため。普段の未取込は前日の 1 日だけ。溜まった分は、翌朝以降の cron か手動の再実行で、続きから消化される(取り込み済みは列挙から外れる)。
 *  - **失敗は例外にしない**(D1 の列挙の失敗も、ある日の DO への依頼の失敗も)。結果は件数で返し、ログは固定の分類名・日付・件数だけ(例外の文面・値は出さない)。
 *    朝の計画(`requestPlan`)を失敗させないため。
 */
import type { RequestResultImportResult } from "./race-day-core";
import type { ListUnimportedByDayOptions, UnimportedRace } from "./result-repository";

/** cron が見る窓の日数(今日は含めない。前日までの 7 日)。 */
export const RESULT_WINDOW_DAYS = 7;
/** cron が 1 回で依頼する日数の上限(新しい日から)。 */
export const CRON_RESULT_MAX_DAYS = 2;
/** 手動の取り込みが 1 回で依頼する日数の上限(新しい日から)。 */
export const MANUAL_RESULT_MAX_DAYS = 3;
/** 1 日あたりに依頼するレースの数の上限(中央は 1 日最大 36 レース)。 */
export const RESULT_PER_DAY_LIMIT = 60;
/** 1 回で依頼するレースの合計の上限。 */
export const RESULT_TOTAL_LIMIT = 120;

/** 列挙の依存(`D1ResultStore` のうち、ここで使う部分だけ)。 */
export interface DispatchStore {
  listUnimportedRacesByDay(options: ListUnimportedByDayOptions): Promise<UnimportedRace[]>;
}

/** 日単位の DO のスタブのうち、ここで使う部分だけ(RPC なので Promise)。 */
export interface ResultDayStub {
  requestResultImport(input: { readonly kaisaiDate: string; readonly raceIds: readonly string[] }): Promise<RequestResultImportResult>;
}

export interface DispatchResultImportsInput {
  /** 開催日の下限（YYYYMMDD。含む）。 */
  readonly from: string;
  /** 開催日の上限(YYYYMMDD。含む。今日を含めない = 呼び出し側が前日以前にする)。 */
  readonly to: string;
  /** 依頼する日数の上限（{@link CRON_RESULT_MAX_DAYS}・{@link MANUAL_RESULT_MAX_DAYS}）。 */
  readonly maxDays: number;
  readonly store: DispatchStore;
  /** 開催日の DO のスタブを引く（呼び出し側の 1 行。`idFromName(開催日)`）。 */
  readonly stubFor: (kaisaiDate: string) => ResultDayStub;
  readonly log: (line: string, level: "info" | "error") => void;
}

export interface DispatchResultImportsResult {
  /** 列挙したレースの数。 */
  readonly listed: number;
  /** 依頼を試みた日数。 */
  readonly days: number;
  /** DO が積んだレースの数（進行中・取り込み済み・同日に諦めたものは数えない）。 */
  readonly accepted: number;
  /** 依頼（RPC）が失敗した日数。 */
  readonly failedDays: number;
  /** 列挙（D1）が失敗した。 */
  readonly listFailed: boolean;
}

/** ログに出してよいエラーの種類名: 英数字と `_` の 1〜40 文字だけ（それ以外・Error でない値は固定の語）。 */
export function errorKind(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(error.name)) {
    return error.name;
  }
  return error instanceof Error ? "UnknownError" : "non-error";
}

/** 開催日（YYYYMMDD）に日数を足す（暦日の足し引き。JST は夏時間が無いので UTC の暦日と同じ）。 */
export function addDaysToKaisaiDate(kaisaiDate: string, delta: number): string {
  const ms = Date.UTC(Number(kaisaiDate.slice(0, 4)), Number(kaisaiDate.slice(4, 6)) - 1, Number(kaisaiDate.slice(6, 8))) + delta * 86_400_000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** cron が見る窓: 今日（JST の暦日）の前日までの {@link RESULT_WINDOW_DAYS} 日。**今日は含めない**（当日中の取り込みは対象外）。 */
export function resultWindowFor(todayKaisaiDate: string): { readonly from: string; readonly to: string } {
  return { from: addDaysToKaisaiDate(todayKaisaiDate, -RESULT_WINDOW_DAYS), to: addDaysToKaisaiDate(todayKaisaiDate, -1) };
}

/**
 * 窓の未取込を列挙し、日ごとに、その日の DO に結果の取り込みを依頼する（依頼だけをして戻る）。例外を投げない。
 */
export async function dispatchResultImports(input: DispatchResultImportsInput): Promise<DispatchResultImportsResult> {
  const { from, to, maxDays, store, stubFor, log } = input;
  let races: UnimportedRace[];
  try {
    races = await store.listUnimportedRacesByDay({ from, to, perDay: RESULT_PER_DAY_LIMIT, maxDays, total: RESULT_TOTAL_LIMIT });
  } catch (error) {
    log(`result-import: failed class=result-list-failed error=${errorKind(error)}`, "error");
    return { listed: 0, days: 0, accepted: 0, failedDays: 0, listFailed: true };
  }
  // 日ごとにまとめる（列挙は新しい日が先。その並びを保つ）。
  const byDay = new Map<string, string[]>();
  for (const race of races) {
    const ids = byDay.get(race.kaisaiDate) ?? [];
    ids.push(race.raceId);
    byDay.set(race.kaisaiDate, ids);
  }
  let accepted = 0;
  let failedDays = 0;
  for (const [kaisaiDate, raceIds] of byDay) {
    try {
      const result = await stubFor(kaisaiDate).requestResultImport({ kaisaiDate, raceIds });
      accepted += result.accepted;
    } catch (error) {
      failedDays += 1;
      log(`result-import: failed class=result-request-failed date=${kaisaiDate} error=${errorKind(error)}`, "error");
    }
  }
  log(`result-import: dispatched from=${from} to=${to} listed=${races.length} days=${byDay.size} accepted=${accepted} failed-days=${failedDays}`, "info");
  return { listed: races.length, days: byDay.size, accepted, failedDays, listFailed: false };
}
