/**
 * 過去の結果の取得(fetch)の本体。Issue #532 段階 1。開発用。ネットワークは `fetchText` を差し込む(テストは偽物)。
 *
 * 流れ(1 プロセスで直列): 月ごとにカレンダー → 開催日ごとにレース一覧 → 結果ページ。
 * - 中央: 一覧にある場コード 01〜10 の race_id を全部取る。
 * - 地方: 一覧を `parseRaceList` → `filterJpnOnlyEntries` で交流重賞(Jpn1/2/3)に絞った race_id だけ取る。
 *   一覧の解析から漏れた項目(距離が読めない等)は Jpn かどうか判定できないので取らず、errors.ndjson に `list-unparsed` で残す。
 * - 取った HTML は UTF-8 のテキストを gzip で `layout.ts` の場所へ保存する(一時ファイルに書いて rename。途中で止めても半端なファイルが残らない)。
 * - すでにある raw は取らない(再実行で続きから)。0 バイト・文字化け・HTTP エラー・必要な構造が無いページは**保存せず**、
 *   errors.ndjson に段階・ID・理由を追記する(再実行でもう一度試す)。
 * - 今日より後の開催日は取らない(errors にもしない。件数だけ数える)。
 * - errors.ndjson は追記のログで、再実行のたびに同じ失敗が重ねて載ることがある(`list-unparsed` は取得済みの一覧を読み直すたびに載る)。
 *   取れたものは raw に入るので、「まだ取れていないもの」は raw との差で分かる。
 * - `limit` は新しく出したリクエストの数の上限(スキップは数えない)。
 */

import * as cheerio from "cheerio";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseKaisaiDate, parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import { filterJpnOnlyEntries } from "../../packages/core/src/scraper/jpn-grade.js";
import { parseRaceList } from "../../packages/core/src/scraper/parse-race-list.js";
import { PATTERNS, RACE_LIST_SELECTORS } from "../../packages/core/src/scraper/selectors.js";
import { narRaceListSubUrl, raceListSubUrl, raceResultUrl } from "../../packages/core/src/scraper/urls.js";
import { errorsFilePath, rawFilePath, type Kind, type Stage } from "./layout.js";

export interface FetchOptions {
  /** `YYYY-MM` */
  readonly from: string;
  /** `YYYY-MM`(この月を含む) */
  readonly to: string;
  readonly outDir: string;
  readonly kinds: readonly Kind[];
  /** 新しく出すリクエストの数の上限。 */
  readonly limit?: number;
  /** 今日(JST)の `YYYYMMDD`。これより後の開催日は取らない。 */
  readonly today: string;
  /** URL を取って UTF-8 のテキストを返す(HttpClient の fetchText を包む。失敗は例外)。 */
  readonly fetchText: (url: string) => Promise<string>;
  readonly log: (message: string) => void;
}

export interface FetchStats {
  requests: number;
  saved: Record<Stage, number>;
  skippedExisting: Record<Stage, number>;
  skippedFuture: number;
  errors: number;
  /** 一覧のコンテナはあるがレースが 0 件だった日の数(保存はする。errors にはしない)。 */
  emptyLists: number;
  limitReached: boolean;
}

/** limit に達して取得を打ち切るための内部の合図。 */
class LimitSignal extends Error {}

const zeroByStage = (): Record<Stage, number> => ({ calendar: 0, list: 0, result: 0 });

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 一時ファイルに書いて rename する。 */
function atomicWrite(file: string, data: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 一時ファイルが無いなら何もしない
    }
    throw e;
  }
}

/** `YYYY-MM` の列(両端を含む)。 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** 中央・地方のホスト(urls.ts のビルダから導く。ホストの定数を二重に持たない)。 */
function originOf(kind: Kind): string {
  const probe = parseKaisaiDate("20200101");
  return new URL(kind === "nar" ? narRaceListSubUrl(probe) : raceListSubUrl(probe)).origin;
}

const calendarUrl = (kind: Kind, month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${originOf(kind)}/top/calendar.html?year=${y}&month=${m}`;
};

const listUrl = (kind: Kind, date: string): string => {
  const d = parseKaisaiDate(date);
  return kind === "nar" ? narRaceListSubUrl(d) : raceListSubUrl(d);
};

/** race_id が、その種別(中央 = 場コード 01〜10、地方 = 30〜64。ばんえい 65 は含まない)のものか。 */
function isIdOfKind(kind: Kind, raceId: string): boolean {
  try {
    return venueKindOfRaceId(parseRaceId(raceId)) === kind;
  } catch {
    return false;
  }
}

/** 保存前の検査。問題があれば理由、無ければ null。 */
function validate(stage: Stage, text: string): string | null {
  if (text.trim() === "") {
    return "0 バイト(または空白のみ)の応答";
  }
  if (text.includes("�")) {
    return "文字化け(U+FFFD を含む)";
  }
  if (stage === "calendar" && !text.includes("Calendar_Table")) {
    return "カレンダーの表(Calendar_Table)がありません";
  }
  if (stage === "list" && !text.includes("RaceList_Body")) {
    return "レース一覧のコンテナ(RaceList_Body)がありません";
  }
  if (stage === "result" && cheerio.load(text)("#All_Result_Table tbody > tr").length === 0) {
    return "結果の表(#All_Result_Table)に行がありません";
  }
  return null;
}

export async function runFetch(opts: FetchOptions): Promise<FetchStats> {
  const stats: FetchStats = {
    requests: 0,
    saved: zeroByStage(),
    skippedExisting: zeroByStage(),
    skippedFuture: 0,
    errors: 0,
    emptyLists: 0,
    limitReached: false,
  };

  const recordError = (kind: Kind, stage: string, id: string, url: string, reason: string): void => {
    stats.errors += 1;
    mkdirSync(opts.outDir, { recursive: true });
    appendFileSync(
      errorsFilePath(opts.outDir),
      `${JSON.stringify({ at: new Date().toISOString(), kind, stage, id, url, reason })}\n`,
    );
  };

  /**
   * 1 ページを手に入れる。raw にあれば読み(`needBody` が false なら中身は読まず存在だけ確かめる)、無ければ取って保存する。
   * 取れなかった・保存してはいけないページは null(errors に記録済み)。
   */
  async function acquire(kind: Kind, stage: Stage, id: string, url: string, needBody: boolean): Promise<string | null> {
    const file = rawFilePath(opts.outDir, kind, stage, id);
    if (existsSync(file)) {
      if (!needBody) {
        stats.skippedExisting[stage] += 1;
        return "";
      }
      try {
        const body = gunzipSync(readFileSync(file)).toString("utf8");
        stats.skippedExisting[stage] += 1;
        return body;
      } catch (e) {
        opts.log(`[${kind}] 既存の raw が読めないので取り直します: ${file} (${errMessage(e)})`);
      }
    }
    if (opts.limit !== undefined && stats.requests >= opts.limit) {
      throw new LimitSignal();
    }
    stats.requests += 1;
    let text: string;
    try {
      text = await opts.fetchText(url);
    } catch (e) {
      recordError(kind, stage, id, url, errMessage(e));
      return null;
    }
    const problem = validate(stage, text);
    if (problem !== null) {
      recordError(kind, stage, id, url, problem);
      return null;
    }
    atomicWrite(file, gzipSync(Buffer.from(text, "utf8")));
    stats.saved[stage] += 1;
    return text;
  }

  const statusLine = (): string =>
    `累計 リクエスト ${stats.requests}・保存 ${stats.saved.calendar + stats.saved.list + stats.saved.result}・取得済みでスキップ ${
      stats.skippedExisting.calendar + stats.skippedExisting.list + stats.skippedExisting.result
    }・エラー ${stats.errors}`;

  try {
    for (const kind of opts.kinds) {
      for (const month of monthsBetween(opts.from, opts.to)) {
        const calUrl = calendarUrl(kind, month);
        const calHtml = await acquire(kind, "calendar", month, calUrl, true);
        if (calHtml === null) {
          continue;
        }
        const prefix = month.replace("-", "");
        const $cal = cheerio.load(calHtml);
        const dates = [
          ...new Set(
            $cal(".Calendar_Table a[href*='kaisai_date=']")
              .map((_, a) => /kaisai_date=(\d{8})/.exec($cal(a).attr("href") ?? "")?.[1])
              .get()
              .filter((d): d is string => d !== undefined && d.startsWith(prefix)),
          ),
        ].sort();
        opts.log(`[${kind} ${month}] 開催日 ${dates.length} 日`);

        for (const date of dates) {
          if (date > opts.today) {
            stats.skippedFuture += 1;
            continue;
          }
          const lUrl = listUrl(kind, date);
          const listHtml = await acquire(kind, "list", date, lUrl, true);
          if (listHtml === null) {
            continue;
          }

          // 一覧の解析。parseRaceList が距離の読めない項目を黙って捨てるので、項目のリンクからも race_id を数えて突き合わせる。
          let wanted: string[];
          let unparsed: string[];
          try {
            const $ = cheerio.load(listHtml);
            const rawIds = [
              ...new Set(
                $(RACE_LIST_SELECTORS.item)
                  .map((_, li) => PATTERNS.raceIdFromHref.exec($(li).find(RACE_LIST_SELECTORS.itemLink).first().attr("href") ?? "")?.[1])
                  .get()
                  .filter((id): id is string => id !== undefined && /^\d{12}$/.test(id) && isIdOfKind(kind, id)),
              ),
            ];
            if (rawIds.length === 0) {
              stats.emptyLists += 1;
            }
            const entries = parseRaceList(listHtml);
            const parsedIds = new Set(entries.map((e) => e.raceId as string));
            unparsed = rawIds.filter((id) => !parsedIds.has(id));
            if (kind === "central") {
              // 中央は和集合(一覧の解析から漏れた項目も結果を取る)
              wanted = rawIds;
            } else {
              const jpn = new Set(filterJpnOnlyEntries(entries).map((e) => e.raceId as string));
              wanted = rawIds.filter((id) => jpn.has(id));
            }
          } catch (e) {
            recordError(kind, "list", date, lUrl, `一覧の解析に失敗: ${errMessage(e)}`);
            continue;
          }
          if (kind === "nar") {
            for (const id of unparsed) {
              recordError(kind, "list-unparsed", id, lUrl, "一覧の解析から漏れた項目(距離が読めない等)。Jpn かどうか判定できないので結果を取りません");
            }
          } else if (unparsed.length > 0) {
            opts.log(`[${kind} ${date}] 一覧の解析から漏れた ${unparsed.length} 件も結果を取ります`);
          }

          const skippedBefore = stats.skippedExisting.result;
          const savedBefore = stats.saved.result;
          const errorsBefore = stats.errors;
          let done = 0;
          for (const id of wanted) {
            await acquire(kind, "result", id, raceResultUrl(parseRaceId(id)), false);
            done += 1;
            if (stats.requests % 25 === 0) {
              opts.log(`[${kind} ${date}] 結果 ${done}/${wanted.length}(この日の残り ${wanted.length - done}) ${statusLine()}`);
            }
          }
          opts.log(
            `[${kind} ${date}] 結果 ${wanted.length} 件: 取得済み ${stats.skippedExisting.result - skippedBefore}・今回保存 ${
              stats.saved.result - savedBefore
            }・失敗 ${stats.errors - errorsBefore} ${statusLine()}`,
          );
        }
      }
    }
  } catch (e) {
    if (!(e instanceof LimitSignal)) {
      throw e;
    }
    stats.limitReached = true;
    opts.log(`--limit ${opts.limit} 件のリクエストに達したので止めます。再実行すると続きから取ります。`);
  }
  opts.log(
    `終了: リクエスト ${stats.requests}・保存(カレンダー ${stats.saved.calendar}・一覧 ${stats.saved.list}・結果 ${stats.saved.result})・` +
      `取得済みでスキップ(カレンダー ${stats.skippedExisting.calendar}・一覧 ${stats.skippedExisting.list}・結果 ${stats.skippedExisting.result})・` +
      `未来日 ${stats.skippedFuture}・空の一覧 ${stats.emptyLists}・エラー ${stats.errors}`,
  );
  return stats;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type ParsedFetchArgs =
  | { readonly ok: true; readonly value: { from: string; to: string; outDir: string; kinds: Kind[]; limit?: number } }
  | { readonly ok: false; readonly message: string };

export const FETCH_USAGE =
  "使い方: pnpm tsx scripts/history-results/fetch.ts --from 2021-11 --to 2026-10 --out <ディレクトリ> [--central] [--nar-jpn] [--limit N]\n" +
  "  --central と --nar-jpn はどちらも付けなければ両方。--limit は新しく出すリクエストの数の上限(再実行で続きから)。";

export function parseFetchArgs(argv: readonly string[]): ParsedFetchArgs {
  let from: string | undefined;
  let to: string | undefined;
  let outDir: string | undefined;
  let limit: number | undefined;
  let central = false;
  let nar = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string | undefined => argv[++i];
    if (a === "--from") from = next();
    else if (a === "--to") to = next();
    else if (a === "--out") outDir = next();
    else if (a === "--limit") {
      const v = next();
      if (v === undefined || !/^[1-9][0-9]*$/.test(v)) {
        return { ok: false, message: `--limit は正の整数で指定してください(値: ${v ?? "なし"})` };
      }
      limit = Number(v);
    } else if (a === "--central") central = true;
    else if (a === "--nar-jpn") nar = true;
    else return { ok: false, message: `知らない引数です: ${a}` };
  }
  if (from === undefined || !MONTH.test(from)) return { ok: false, message: `--from は YYYY-MM で指定してください(値: ${from ?? "なし"})` };
  if (to === undefined || !MONTH.test(to)) return { ok: false, message: `--to は YYYY-MM で指定してください(値: ${to ?? "なし"})` };
  if (from > to) return { ok: false, message: `--from ${from} が --to ${to} より後です` };
  if (outDir === undefined || outDir === "") return { ok: false, message: "--out は必須です" };
  const kinds: Kind[] = !central && !nar ? ["central", "nar"] : [...(central ? (["central"] as const) : []), ...(nar ? (["nar"] as const) : [])];
  return { ok: true, value: { from, to, outDir, kinds, ...(limit !== undefined ? { limit } : {}) } };
}
