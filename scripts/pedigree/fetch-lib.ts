/**
 * 血統ページの取得(fetch)の本体。Issue #542 手順 2。開発用。ネットワークは `fetchText` を差し込む(テストは偽物)。
 *
 * - 入力は馬 ID の並び(`collectHorseIds` が `--races`〈#532 の parse の出力〉と `--ids`〈1 行 1 ID〉から作る)。並びの順に 1 頭 1 リクエスト、直列。
 * - 取った HTML は UTF-8 のテキストを gzip で `layout.ts` の場所へ保存する(一時ファイルに書いて rename)。すでにある raw は取らない(再実行で続きから)。
 * - 保存前の検査は「空・文字化け(U+FFFD)・血統表なし・canonical の馬 ID が要求と違う」だけ。**セル数や木の形は見ない**
 *   (祖先が欠けた馬などで恒久的に形が違うページを、毎回取り直さないため。その扱いは parse の rejects/issues)。
 *   **存在しない ID は HTTP 200 で、62 個の空のセルを持つページが返り、canonical が `/horse//` になる**ので、canonical の検査で弾く。
 * - 不合格・取得の失敗は保存せず、errors.ndjson に段階(ped)・ID・分類・理由を追記する(再実行でもう一度試す)。
 * - HTTP 400・403・429 は、アクセスを制限された可能性が高いので、1 件目でもその場で打ち切る(`aborted` と `restricted`)。
 * - 取得の失敗が連続 `maxConsecutiveFailures` 件(既定 20)になったら打ち切る。成功が 1 件あれば数え直す。
 * - `limit` は新しく出したリクエストの数の上限(スキップは数えない)。
 * #532 の `history-results/fetch-lib.ts` から、制限の判定・原子的な書き込み・既定値・打ち切りの文を共有する。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { HorseId } from "../../packages/core/src/scraper/ids.js";
import { horseUrl } from "../../packages/core/src/scraper/urls.js";
import {
  atomicWrite,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  httpStatusOf,
  MIN_INTERVAL_MS,
  RESTRICTED_STATUSES,
} from "../history-results/fetch-lib.js";
import { errorsFilePath, rawPedPath } from "./layout.js";
import { canonicalHorseIdOf, hasBloodTable } from "./pedigree-html.js";

/** 血統ページの URL。ホストは馬ページのビルダ(urls.ts)から導く(ホストの定数を二重に持たない)。 */
export function pedigreeUrl(horseId: string): string {
  const origin = new URL(horseUrl("0000000000" as HorseId)).origin;
  return `${origin}/horse/ped/${horseId}/`;
}

/** 血統ページの文字コード(実測: EUC-JP)。 */
export const PED_ENCODING = "euc-jp";

/** HttpClient を包んで、EUC-JP でデコードした本文を返す fetchText にする。 */
export function createPedFetchText(client: { fetchText: (url: string, options: { encoding: "euc-jp" }) => Promise<string> }): (url: string) => Promise<string> {
  return (url) => client.fetchText(url, { encoding: PED_ENCODING });
}

export interface PedFetchOptions {
  readonly outDir: string;
  /** 取る馬の ID(この順に取る)。 */
  readonly horseIds: readonly string[];
  /** 新しく出すリクエストの数の上限。 */
  readonly limit?: number;
  /** URL を取って UTF-8 のテキストを返す(失敗は例外)。 */
  readonly fetchText: (url: string) => Promise<string>;
  readonly log: (message: string) => void;
  /** 取得の失敗が連続したら打ち切る件数。既定 20。 */
  readonly maxConsecutiveFailures?: number;
}

export interface PedFetchStats {
  requests: number;
  saved: number;
  skippedExisting: number;
  errors: number;
  limitReached: boolean;
  /** 連続失敗の上限か、HTTP 400・403・429 で打ち切ったか(CLI は 0 以外の終了コードで終わる)。 */
  aborted: boolean;
  /** HTTP 400・403・429 でアクセスを制限された可能性があるとして打ち切ったか(aborted も true になる)。 */
  restricted: boolean;
}

/** 失敗の分類(errors.ndjson の category)。 */
type FailCategory = "空" | "文字化け" | "表なし" | "馬ID不一致" | "HTTP" | "通信";

/** 保存前の検査。問題があれば分類と理由、無ければ null。 */
function validate(text: string, horseId: string): { category: FailCategory; reason: string } | null {
  if (text.trim() === "") return { category: "空", reason: "0 バイト(または空白のみ)の応答" };
  if (text.includes("�")) return { category: "文字化け", reason: "文字化け(U+FFFD を含む)" };
  if (!hasBloodTable(text)) return { category: "表なし", reason: "血統表(table.blood_table)がありません" };
  const canonical = canonicalHorseIdOf(text);
  if (canonical !== horseId) {
    return { category: "馬ID不一致", reason: `canonical の馬 ID が要求した ID と違います(要求 ${horseId}・canonical ${canonical ?? "なし"})。存在しない ID は canonical が /horse// になります` };
  }
  return null;
}

class LimitSignal extends Error {}
class FailureSignal extends Error {}
class RestrictedSignal extends Error {}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runPedFetch(opts: PedFetchOptions): Promise<PedFetchStats> {
  const stats: PedFetchStats = { requests: 0, saved: 0, skippedExisting: 0, errors: 0, limitReached: false, aborted: false, restricted: false };
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  let consecutiveFailures = 0;
  let lastFailureReason = "";

  const recordError = (id: string, url: string, category: FailCategory, reason: string): void => {
    stats.errors += 1;
    mkdirSync(opts.outDir, { recursive: true });
    appendFileSync(errorsFilePath(opts.outDir), `${JSON.stringify({ at: new Date().toISOString(), stage: "ped", id, url, category, reason })}\n`);
  };

  const failed = (id: string, url: string, category: FailCategory, reason: string, status?: number): void => {
    recordError(id, url, category, reason);
    if (status !== undefined && RESTRICTED_STATUSES.has(status)) {
      lastFailureReason = `[ped ${id}] HTTP ${status}: ${reason}`;
      throw new RestrictedSignal();
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      lastFailureReason = `[ped ${id}] ${reason}`;
      throw new FailureSignal();
    }
  };

  const statusLine = (): string => `累計 リクエスト ${stats.requests}・保存 ${stats.saved}・取得済みでスキップ ${stats.skippedExisting}・エラー ${stats.errors}`;

  try {
    for (const id of opts.horseIds) {
      const file = rawPedPath(opts.outDir, id);
      if (existsSync(file)) {
        try {
          gunzipSync(readFileSync(file));
          stats.skippedExisting += 1;
          continue;
        } catch (e) {
          opts.log(`既存の raw が読めないので取り直します: ${file} (${errMessage(e)})`);
        }
      }
      if (opts.limit !== undefined && stats.requests >= opts.limit) throw new LimitSignal();
      const url = pedigreeUrl(id);
      stats.requests += 1;
      let text: string;
      try {
        text = await opts.fetchText(url);
      } catch (e) {
        const status = httpStatusOf(e);
        failed(id, url, status !== undefined ? "HTTP" : "通信", errMessage(e), status);
        continue;
      }
      const problem = validate(text, id);
      if (problem !== null) {
        failed(id, url, problem.category, problem.reason);
        continue;
      }
      atomicWrite(file, gzipSync(Buffer.from(text, "utf8")));
      stats.saved += 1;
      consecutiveFailures = 0;
      if (stats.requests % 25 === 0) opts.log(`${stats.requests}/${opts.horseIds.length} 頭目 ${statusLine()}`);
    }
  } catch (e) {
    if (e instanceof LimitSignal) {
      stats.limitReached = true;
      opts.log(`--limit ${opts.limit} 件のリクエストに達したので止めます。再実行すると続きから取ります。`);
    } else if (e instanceof RestrictedSignal) {
      stats.aborted = true;
      stats.restricted = true;
      opts.log(
        `アクセスを制限された可能性があります(HTTP 400・403・429)。その場で打ち切ります。直近の失敗: ${lastFailureReason}。` +
          `間隔を広げ(--interval-ms)、時間を置いて再実行すると、取れたものは使い回して続きから取ります。`,
      );
    } else if (e instanceof FailureSignal) {
      stats.aborted = true;
      opts.log(
        `連続 ${maxConsecutiveFailures} 件の取得失敗のため打ち切ります(アクセス制限の可能性があります)。直近の失敗: ${lastFailureReason}。` +
          `時間を置いて再実行すると、取れたものは使い回して続きから取ります。` +
          `恒久的に失敗する馬が続いて先へ進めないときは、連続失敗の上限(--max-consecutive-failures)を上げると、先へ進めることがあります。`,
      );
    } else {
      throw e;
    }
  }
  opts.log(`終了: リクエスト ${stats.requests}・保存 ${stats.saved}・取得済みでスキップ ${stats.skippedExisting}・エラー ${stats.errors}`);
  return stats;
}

/** 取る馬の ID として受け付ける形(10 桁の英数字)。URL に埋め込むので、これ以外は拒否する。 */
const HORSE_ID = /^[0-9A-Za-z]{10}$/;

export interface CollectedHorseIds {
  /** 取る馬の ID(重複なし。`--ids` の順 → `--races` の新しい順)。 */
  readonly ids: string[];
  /** `--races` に horseId が null の馬がいた数。 */
  readonly nullHorseIds: number;
  /** 重複で捨てた数。 */
  readonly duplicates: number;
  /** 10 桁の英数字でなかったもの。 */
  readonly invalid: string[];
}

interface RaceLine {
  readonly date?: unknown;
  readonly horses?: ReadonlyArray<{ readonly horseId?: unknown }>;
}

/** #532 の parse の出力(NDJSON。`.gz` なら gzip)を読む。 */
function readRaceLines(file: string): RaceLine[] {
  const buf = readFileSync(file);
  const text = (file.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as RaceLine);
}

export function collectHorseIds(input: { readonly raceFiles: readonly string[]; readonly idFiles: readonly string[] }): CollectedHorseIds {
  const ids: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  let nullHorseIds = 0;
  let duplicates = 0;
  const add = (id: string): void => {
    if (!HORSE_ID.test(id)) {
      invalid.push(id);
    } else if (seen.has(id)) {
      duplicates += 1;
    } else {
      seen.add(id);
      ids.push(id);
    }
  };

  for (const f of input.idFiles) {
    for (const raw of readFileSync(f, "utf8").split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      add(line);
    }
  }

  const races = input.raceFiles.flatMap((f) => readRaceLines(f));
  // 日付の新しい順(同じ日は入力の順のまま。Array.prototype.sort は安定)
  const sorted = [...races].sort((a, b) => {
    const da = typeof a.date === "string" ? a.date : "";
    const db = typeof b.date === "string" ? b.date : "";
    return da < db ? 1 : da > db ? -1 : 0;
  });
  for (const race of sorted) {
    for (const h of race.horses ?? []) {
      if (typeof h.horseId === "string") add(h.horseId);
      else nullHorseIds += 1;
    }
  }
  return { ids, nullHorseIds, duplicates, invalid };
}

export type ParsedPedFetchArgs =
  | {
      readonly ok: true;
      readonly value: { outDir: string; raceFiles: string[]; idFiles: string[]; limit?: number; maxConsecutiveFailures?: number; intervalMs: number };
    }
  | { readonly ok: false; readonly message: string };

export const PED_FETCH_USAGE =
  "使い方: pnpm tsx scripts/pedigree/fetch.ts --out <ディレクトリ> [--races <#532 の parse の出力.ndjson.gz>]... [--ids <1 行 1 ID のファイル>]... [--limit N] [--max-consecutive-failures N] [--interval-ms N]\n" +
  "  --races と --ids は少なくとも 1 つ(繰り返し可)。--ids の馬が先、--races は日付の新しい順。--limit は新しく出すリクエストの数の上限(再実行で続きから)。\n" +
  "  --interval-ms は最低間隔(既定 10000、1500 未満は不可)。\n" +
  "  HTTP 400・403・429 は、アクセスの制限を疑ってその場で打ち切る(終了コード 1)。\n" +
  "  取得の失敗が連続 20 件(--max-consecutive-failures で変更)になったら打ち切り、終了コード 1 で終わる。";

export function parsePedFetchArgs(argv: readonly string[]): ParsedPedFetchArgs {
  let outDir: string | undefined;
  const raceFiles: string[] = [];
  const idFiles: string[] = [];
  let limit: number | undefined;
  let maxConsecutiveFailures: number | undefined;
  let intervalMs = DEFAULT_INTERVAL_MS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string | undefined => argv[++i];
    if (a === "--out") outDir = next();
    else if (a === "--races" || a === "--ids") {
      const v = next();
      if (v === undefined || v === "" || v.startsWith("--")) return { ok: false, message: `${a} にはファイルを指定してください(値: ${v ?? "なし"})` };
      (a === "--races" ? raceFiles : idFiles).push(v);
    } else if (a === "--limit") {
      const v = next();
      if (v === undefined || !/^[1-9][0-9]*$/.test(v)) return { ok: false, message: `--limit は正の整数で指定してください(値: ${v ?? "なし"})` };
      limit = Number(v);
    } else if (a === "--max-consecutive-failures") {
      const v = next();
      if (v === undefined || !/^[1-9][0-9]*$/.test(v)) return { ok: false, message: `--max-consecutive-failures は正の整数で指定してください(値: ${v ?? "なし"})` };
      maxConsecutiveFailures = Number(v);
    } else if (a === "--interval-ms") {
      const v = next();
      if (v === undefined || !/^[1-9][0-9]*$/.test(v) || Number(v) < MIN_INTERVAL_MS) {
        return { ok: false, message: `--interval-ms は ${MIN_INTERVAL_MS} 以上の整数で指定してください(値: ${v ?? "なし"})` };
      }
      intervalMs = Number(v);
    } else return { ok: false, message: `知らない引数です: ${a}` };
  }
  if (outDir === undefined || outDir === "") return { ok: false, message: "--out は必須です" };
  if (raceFiles.length === 0 && idFiles.length === 0) return { ok: false, message: "--races か --ids を少なくとも 1 つ指定してください" };
  return {
    ok: true,
    value: { outDir, raceFiles, idFiles, ...(limit !== undefined ? { limit } : {}), ...(maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures } : {}), intervalMs },
  };
}
