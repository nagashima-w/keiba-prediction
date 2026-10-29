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
 * - **今日以降**の開催日は取らない(errors にもしない。件数だけ数える)。当日は結果が途中のことがあり、保存すると二度と取り直さないため。
 * - 結果は、頭数(`.RaceData02` の N頭)と結果の表の行数が合うものだけ保存する(合わない・頭数が読めないものは途中の結果とみなして保存しない)。
 *   実物では取消・除外・中止の行も頭数に含まれる。
 * - カレンダーは、今月(today の月)以降なら raw があっても毎回取り直す(開催日が増えるため)。過去の月は使い回す。
 * - 中央の一覧に race_id が 0 件のものは異常として保存しない(中央のカレンダーには開催日しか載らない)。地方の 0 件は保存する(開催のない日)。
 * - 取得の失敗(HTTP エラー・保存前の検査の不合格)が連続 `maxConsecutiveFailures` 件(既定 20)になったら打ち切る(`aborted`)。
 *   アクセスを制限されたときに叩き続けないため。成功が 1 件あれば数え直す。raw は残るので、再実行で続きから取る。
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
import { parseRaceFieldSize } from "../../packages/core/src/scraper/parse-race-result.js";
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
  /** 取得の失敗が連続したら打ち切る件数。既定 20。 */
  readonly maxConsecutiveFailures?: number;
}

/** 連続失敗の上限の既定値。 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 20;

export interface FetchStats {
  requests: number;
  saved: Record<Stage, number>;
  skippedExisting: Record<Stage, number>;
  skippedFuture: number;
  errors: number;
  /** 一覧のコンテナはあるがレースが 0 件だった日の数(保存はする。errors にはしない)。 */
  emptyLists: number;
  limitReached: boolean;
  /** 連続失敗の上限に達して打ち切ったか(CLI は 0 以外の終了コードで終わる)。 */
  aborted: boolean;
  /** 地方の一覧で見えたグレード表記ごとの件数(表記なしは `(なし)`)。 */
  gradeCounts: Record<string, number>;
}

/** limit に達して取得を打ち切るための内部の合図。 */
class LimitSignal extends Error {}

/** 連続失敗の上限に達して打ち切るための内部の合図。 */
class FailureSignal extends Error {}

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

/** 一覧の項目のリンクから、その種別の race_id を文書の順に重複なしで取る。 */
function listRaceIds(html: string, kind: Kind): string[] {
  const $ = cheerio.load(html);
  return [
    ...new Set(
      $(RACE_LIST_SELECTORS.item)
        .map((_, li) => PATTERNS.raceIdFromHref.exec($(li).find(RACE_LIST_SELECTORS.itemLink).first().attr("href") ?? "")?.[1])
        .get()
        .filter((id): id is string => id !== undefined && /^\d{12}$/.test(id) && isIdOfKind(kind, id)),
    ),
  ];
}

/** 保存前の検査。問題があれば理由、無ければ null。 */
function validate(kind: Kind, stage: Stage, text: string): string | null {
  if (text.trim() === "") {
    return "0 バイト(または空白のみ)の応答";
  }
  if (text.includes("\uFFFD")) {
    return "文字化け(U+FFFD を含む)";
  }
  if (stage === "calendar" && !text.includes("Calendar_Table")) {
    return "カレンダーの表(Calendar_Table)がありません";
  }
  if (stage === "list") {
    if (!text.includes("RaceList_Body")) {
      return "レース一覧のコンテナ(RaceList_Body)がありません";
    }
    if (kind === "central" && listRaceIds(text, kind).length === 0) {
      return "中央の一覧に race_id が 0 件です(カレンダーには開催日しか載らないので異常)";
    }
  }
  if (stage === "result") {
    const rows = cheerio.load(text)("#All_Result_Table tbody > tr").length;
    if (rows === 0) {
      return "結果の表(#All_Result_Table)に行がありません";
    }
    const size = parseRaceFieldSize(text);
    if (size === null) {
      return "頭数が読めません(.RaceData02 に N頭 の span がありません)。途中の結果か、構造が変わった可能性があります";
    }
    if (size !== rows) {
      return `頭数 ${size} と結果の行 ${rows} が合いません(途中の結果の可能性)`;
    }
  }
  return null;
}

/** グレード表記の件数を「表記 件数」の・区切りに整える(件数の多い順、同数は表記の順)。 */
function formatGradeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([g, n]) => `${g} ${n}`)
    .join("・");
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
    aborted: false,
    gradeCounts: {},
  };
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  let consecutiveFailures = 0;
  let lastFailureReason = "";
  const todayMonth = `${opts.today.slice(0, 4)}-${opts.today.slice(4, 6)}`;

  const recordError = (kind: Kind, stage: string, id: string, url: string, reason: string): void => {
    stats.errors += 1;
    mkdirSync(opts.outDir, { recursive: true });
    appendFileSync(
      errorsFilePath(opts.outDir),
      `${JSON.stringify({ at: new Date().toISOString(), kind, stage, id, url, reason })}\n`,
    );
  };

  /** 取得の失敗を記録し、連続失敗の上限に達したら打ち切りの合図を投げる。保存はしない(null を返す)。 */
  function failed(kind: Kind, stage: Stage, id: string, url: string, reason: string): null {
    recordError(kind, stage, id, url, reason);
    consecutiveFailures += 1;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      lastFailureReason = `[${kind} ${stage} ${id}] ${reason}`;
      throw new FailureSignal();
    }
    return null;
  }

  /**
   * 1 ページを手に入れる。raw にあれば読み(`needBody` が false なら中身は読まず存在だけ確かめる)、無ければ取って保存する。
   * 取れなかった・保存してはいけないページは null(errors に記録済み)。
   */
  async function acquire(kind: Kind, stage: Stage, id: string, url: string, needBody: boolean, refresh = false): Promise<string | null> {
    const file = rawFilePath(opts.outDir, kind, stage, id);
    if (!refresh && existsSync(file)) {
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
      return failed(kind, stage, id, url, errMessage(e));
    }
    const problem = validate(kind, stage, text);
    if (problem !== null) {
      return failed(kind, stage, id, url, problem);
    }
    atomicWrite(file, gzipSync(Buffer.from(text, "utf8")));
    stats.saved[stage] += 1;
    consecutiveFailures = 0;
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
        // 今月以降は開催日が増えるので、raw があっても取り直す(取り直しに失敗したら古い raw は残し、この月は飛ばす)
        const calHtml = await acquire(kind, "calendar", month, calUrl, true, month >= todayMonth);
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
        const monthGradeCounts: Record<string, number> = {};

        for (const date of dates) {
          if (date >= opts.today) {
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
            const rawIds = listRaceIds(listHtml, kind);
            if (rawIds.length === 0) {
              if (kind === "central") {
                // 保存前の検査で弾くが、古い実行で保存された一覧にも当たる。結果は取らず、記録だけ残す
                recordError(kind, "list", date, lUrl, "中央の一覧に race_id が 0 件です(カレンダーには開催日しか載らないので異常)");
                continue;
              }
              stats.emptyLists += 1;
              opts.log(`[${kind} ${date}] 一覧のレース 0 件(開催のない日として保存します)`);
            }
            const entries = parseRaceList(listHtml);
            if (kind === "nar") {
              for (const e of entries) {
                const g = e.grade === undefined || e.grade.trim() === "" ? "(なし)" : e.grade.trim();
                stats.gradeCounts[g] = (stats.gradeCounts[g] ?? 0) + 1;
                monthGradeCounts[g] = (monthGradeCounts[g] ?? 0) + 1;
              }
            }
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
        if (Object.keys(monthGradeCounts).length > 0) {
          opts.log(`[${kind} ${month}] グレード表記の件数: ${formatGradeCounts(monthGradeCounts)}`);
        }
      }
    }
  } catch (e) {
    if (e instanceof LimitSignal) {
      stats.limitReached = true;
      opts.log(`--limit ${opts.limit} 件のリクエストに達したので止めます。再実行すると続きから取ります。`);
    } else if (e instanceof FailureSignal) {
      stats.aborted = true;
      opts.log(
        `連続 ${maxConsecutiveFailures} 件の取得失敗のため打ち切ります(アクセス制限の可能性があります)。直近の失敗: ${lastFailureReason}。` +
          `時間を置いて再実行すると、取れたものは使い回して続きから取ります。`,
      );
    } else {
      throw e;
    }
  }
  opts.log(
    `終了: リクエスト ${stats.requests}・保存(カレンダー ${stats.saved.calendar}・一覧 ${stats.saved.list}・結果 ${stats.saved.result})・` +
      `取得済みでスキップ(カレンダー ${stats.skippedExisting.calendar}・一覧 ${stats.skippedExisting.list}・結果 ${stats.skippedExisting.result})・` +
      `今日以降の開催日 ${stats.skippedFuture}・空の一覧 ${stats.emptyLists}・エラー ${stats.errors}` +
      (Object.keys(stats.gradeCounts).length > 0 ? `・地方のグレード表記: ${formatGradeCounts(stats.gradeCounts)}` : ""),
  );
  return stats;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type ParsedFetchArgs =
  | { readonly ok: true; readonly value: { from: string; to: string; outDir: string; kinds: Kind[]; limit?: number; maxConsecutiveFailures?: number } }
  | { readonly ok: false; readonly message: string };

export const FETCH_USAGE =
  "使い方: pnpm tsx scripts/history-results/fetch.ts --from 2021-11 --to 2026-10 --out <ディレクトリ> [--central] [--nar-jpn] [--limit N] [--max-consecutive-failures N]\n" +
  "  --central と --nar-jpn はどちらも付けなければ両方。--limit は新しく出すリクエストの数の上限(再実行で続きから)。\n" +
  "  取得の失敗が連続 20 件(--max-consecutive-failures で変更)になったら打ち切り、終了コード 1 で終わる。";

export function parseFetchArgs(argv: readonly string[]): ParsedFetchArgs {
  let from: string | undefined;
  let to: string | undefined;
  let outDir: string | undefined;
  let limit: number | undefined;
  let maxConsecutiveFailures: number | undefined;
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
    } else if (a === "--max-consecutive-failures") {
      const v = next();
      if (v === undefined || !/^[1-9][0-9]*$/.test(v)) {
        return { ok: false, message: `--max-consecutive-failures は正の整数で指定してください(値: ${v ?? "なし"})` };
      }
      maxConsecutiveFailures = Number(v);
    } else if (a === "--central") central = true;
    else if (a === "--nar-jpn") nar = true;
    else return { ok: false, message: `知らない引数です: ${a}` };
  }
  if (from === undefined || !MONTH.test(from)) return { ok: false, message: `--from は YYYY-MM で指定してください(値: ${from ?? "なし"})` };
  if (to === undefined || !MONTH.test(to)) return { ok: false, message: `--to は YYYY-MM で指定してください(値: ${to ?? "なし"})` };
  if (from > to) return { ok: false, message: `--from ${from} が --to ${to} より後です` };
  if (outDir === undefined || outDir === "") return { ok: false, message: "--out は必須です" };
  const kinds: Kind[] = !central && !nar ? ["central", "nar"] : [...(central ? (["central"] as const) : []), ...(nar ? (["nar"] as const) : [])];
  return { ok: true, value: { from, to, outDir, kinds, ...(limit !== undefined ? { limit } : {}), ...(maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures } : {}) } };
}
