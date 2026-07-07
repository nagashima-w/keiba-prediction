/**
 * JSONダンプCLIの引数パース(純関数)。
 *
 * 実IO(HttpClient/ScrapeCache生成・ファイル書き込み・console出力)は起動シェル
 * (scripts/dump-race.ts)に置き、ここは引数→コマンド構造への変換だけを担う。
 * これによりコマンド解釈をテストで完結できる。
 */

import { parseKaisaiDate, parseRaceId, type KaisaiDate, type RaceId } from "./ids.js";

/** 既定のキャッシュDBファイル名。 */
export const DEFAULT_CACHE_DB = "cache.sqlite";

/** レース1件をダンプするコマンド。 */
export interface RaceDumpCommand {
  readonly kind: "race";
  /** 対象レースID。 */
  readonly raceId: RaceId;
  /** 出力先ファイル(未指定なら標準出力)。 */
  readonly out: string | null;
  /** オッズをキャッシュ迂回で再取得するか。 */
  readonly freshOdds: boolean;
  /** キャッシュDBファイルパス。 */
  readonly db: string;
}

/** 開催日のレース一覧をダンプするコマンド。 */
export interface DateDumpCommand {
  readonly kind: "date";
  /** 対象開催日。 */
  readonly date: KaisaiDate;
  /** 出力先ファイル(未指定なら標準出力)。 */
  readonly out: string | null;
  /** キャッシュDBファイルパス。 */
  readonly db: string;
}

/** CLIコマンド(レースダンプ or 一覧ダンプ)。 */
export type CliCommand = RaceDumpCommand | DateDumpCommand;

/**
 * コマンドライン引数(process.argv.slice(2) 相当)をパースする。
 *
 * 対応フラグ:
 * - `--race <race_id>` : 1レースをダンプ(--date と排他、いずれか必須)
 * - `--date <YYYYMMDD>`: 開催日のレース一覧をダンプ(--race と排他)
 * - `--out <path>`     : 出力先ファイル(未指定なら標準出力)
 * - `--fresh-odds`     : オッズをキャッシュ迂回で再取得(--race 時のみ有効)
 * - `--db <path>`      : キャッシュDBファイル(既定 cache.sqlite)
 *
 * ID・開催日の検証は ids.ts に委譲し、不正値は InvalidIdError として伝播する。
 *
 * @param argv 実行引数(実行ファイル名等を除いたもの)
 */
export function parseCliArgs(argv: string[]): CliCommand {
  let raceIdRaw: string | undefined;
  let dateRaw: string | undefined;
  // out/db は「未指定」と「明示指定」を区別するため undefined で持つ(重複検知のため)。
  let out: string | undefined;
  let db: string | undefined;
  let freshOdds = false;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) {
      throw new Error(`${flag} には値が必要です`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];

    switch (flag) {
      case "--race": {
        if (raceIdRaw !== undefined) {
          throw new Error("--race は1回のみ指定できます");
        }
        raceIdRaw = requireValue("--race", value);
        i += 1;
        break;
      }
      case "--date": {
        if (dateRaw !== undefined) {
          throw new Error("--date は1回のみ指定できます");
        }
        dateRaw = requireValue("--date", value);
        i += 1;
        break;
      }
      case "--out": {
        if (out !== undefined) {
          throw new Error("--out は1回のみ指定できます");
        }
        out = requireValue("--out", value);
        i += 1;
        break;
      }
      case "--db": {
        if (db !== undefined) {
          throw new Error("--db は1回のみ指定できます");
        }
        db = requireValue("--db", value);
        i += 1;
        break;
      }
      case "--fresh-odds": {
        freshOdds = true;
        break;
      }
      default:
        throw new Error(`未知の引数です: ${flag}`);
    }
  }

  if (raceIdRaw !== undefined && dateRaw !== undefined) {
    throw new Error("--race と --date は同時に指定できません");
  }
  if (raceIdRaw === undefined && dateRaw === undefined) {
    throw new Error("--race または --date のいずれかを指定してください");
  }

  // 未指定なら既定値に解決する。
  const resolvedOut = out ?? null;
  const resolvedDb = db ?? DEFAULT_CACHE_DB;

  if (dateRaw !== undefined) {
    if (freshOdds) {
      throw new Error("--fresh-odds は --race 指定時のみ有効です");
    }
    return {
      kind: "date",
      date: parseKaisaiDate(dateRaw),
      out: resolvedOut,
      db: resolvedDb,
    };
  }

  return {
    kind: "race",
    raceId: parseRaceId(raceIdRaw!),
    out: resolvedOut,
    freshOdds,
    db: resolvedDb,
  };
}
