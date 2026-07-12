/**
 * フィクスチャ取得スクリプト(scripts/fetch-fixtures.ts)の純粋ロジック。
 *
 * 実IO(HTTP取得・ファイル書き込み)からは分離し、
 * 「引数のパース」と「取得対象(URL・ファイル名・エンコーディング)の決定」を
 * テスト可能な純関数として切り出す。命名規則は docs/phase1-scraping-plan.md に準拠する。
 */

import {
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  venueKindOfRaceId,
  type HorseId,
  type KaisaiDate,
  type RaceId,
} from "./ids.js";
import type { SupportedEncoding } from "./http-client.js";
import {
  commentUrl,
  horseResultsApiUrl,
  horseUrl,
  narOddsPageUrl,
  oddsApiUrl,
  oikiriUrl,
  raceListSubUrl,
  shutubaUrl,
} from "./urls.js";

/** パース済みのフィクスチャ取得引数。 */
export interface FetchFixturesArgs {
  /** レース一覧サブHTML取得用の開催日(未指定なら取得しない)。 */
  readonly date?: KaisaiDate;
  /** 取得対象のレースID一覧。 */
  readonly races: RaceId[];
  /** 取得対象の馬ID一覧。 */
  readonly horses: HorseId[];
}

/** 1つのフィクスチャ取得対象(取得先URLと保存ファイル名の対応)。 */
export interface FixtureTarget {
  /** 取得先URL。 */
  readonly url: string;
  /** 保存ファイル名(計画書の命名規則に従う)。 */
  readonly filename: string;
  /**
   * デコードに使うエンコーディング。
   * EUC-JPページ(db.netkeiba.com)でのみ明示指定し、それ以外は未指定(既定=UTF-8)。
   */
  readonly encoding?: SupportedEncoding;
}

/**
 * コマンドライン引数(process.argv.slice(2) 相当)をパースする。
 *
 * 対応フラグ:
 * - `--date YYYYMMDD` : レース一覧取得用の開催日(1回のみ)
 * - `--race <race_id>` : 取得対象レース(複数指定可)
 * - `--horse <horse_id>`: 取得対象馬(複数指定可)
 *
 * 各値は ids.ts の検証を通す。不正値は InvalidIdError として伝播する。
 *
 * @param argv 実行引数(実行ファイル名等を除いたもの)
 * @returns 検証済みの取得引数
 */
export function parseFetchArgs(argv: string[]): FetchFixturesArgs {
  let date: KaisaiDate | undefined;
  const races: RaceId[] = [];
  const horses: HorseId[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];

    switch (flag) {
      case "--date": {
        if (value === undefined) {
          throw new Error("--date には開催日(YYYYMMDD)の値が必要です");
        }
        if (date !== undefined) {
          throw new Error("開催日(--date)は1回のみ指定できます");
        }
        date = parseKaisaiDate(value);
        i += 1;
        break;
      }
      case "--race": {
        if (value === undefined) {
          throw new Error("--race にはレースIDの値が必要です");
        }
        races.push(parseRaceId(value));
        i += 1;
        break;
      }
      case "--horse": {
        if (value === undefined) {
          throw new Error("--horse には馬IDの値が必要です");
        }
        horses.push(parseHorseId(value));
        i += 1;
        break;
      }
      default:
        throw new Error(`未知の引数です: ${flag}`);
    }
  }

  return { date, races, horses };
}

/**
 * 取得引数から、実際に取得すべき対象(URL・ファイル名・エンコーディング)の一覧を決める。
 *
 * - 開催日: レース一覧サブHTML(1件)
 * - 各レース(中央race_id): 出馬表・追い切り・厩舎コメント・オッズJSON(4件)
 * - 各レース(地方race_id): 出馬表・NARオッズページ(2件)。
 *   調教(oikiri)・厩舎コメント(comment)はNARにページ自体が存在しない
 *   (oikiriUrl/commentUrlはNAR race_idに対しNarUnsupportedErrorを投げる)ため、
 *   計画対象から除外する。オッズも中央用JSON API(oddsApiUrl)ではなく
 *   NAR用の静的HTMLページ(narOddsPageUrl)を計画する。詳細: docs/nar-scraping-plan.md。
 * - 各馬: 馬個別ページ(EUC-JP指定)・全戦績JSON(2件、中央・地方共通)
 *
 * 同一の `--race` / `--horse` が重複指定された場合、同一URLの取得対象は
 * 最初の1回だけ計画する(同じページを二重にGETしない)。
 *
 * @param args 検証済みの取得引数
 * @returns 取得対象の一覧(URL重複を除いたもの)
 */
export function planFixtureTargets(args: FetchFixturesArgs): FixtureTarget[] {
  const targets: FixtureTarget[] = [];
  // 既に計画済みのURL。重複指定による二重取得を防ぐ。
  const seenUrls = new Set<string>();

  const add = (target: FixtureTarget): void => {
    if (seenUrls.has(target.url)) {
      return;
    }
    seenUrls.add(target.url);
    targets.push(target);
  };

  if (args.date !== undefined) {
    add({
      url: raceListSubUrl(args.date),
      filename: `race_list_sub_${args.date}.html`,
    });
  }

  for (const raceId of args.races) {
    // 出馬表はshutubaUrlが場コードに応じてrace/nar.netkeiba.comを自動選択するため共通。
    add({
      url: shutubaUrl(raceId),
      filename: `shutuba_${raceId}.html`,
    });

    if (venueKindOfRaceId(raceId) === "nar") {
      // 地方: 調教・厩舎コメントは対象外。オッズはNAR用の静的HTMLページを計画する。
      add({
        url: narOddsPageUrl(raceId),
        filename: `nar_odds_b1_${raceId}.html`,
      });
      continue;
    }

    // 中央: 従来通り出馬表以外に追い切り・厩舎コメント・オッズJSONを計画する。
    add({
      url: oikiriUrl(raceId),
      filename: `oikiri_${raceId}.html`,
    });
    add({
      url: commentUrl(raceId),
      filename: `comment_${raceId}.html`,
    });
    add({
      url: oddsApiUrl(raceId),
      filename: `odds_${raceId}.json`,
    });
  }

  for (const horseId of args.horses) {
    add({
      url: horseUrl(horseId),
      filename: `horse_${horseId}.html`,
      // db.netkeiba.com はEUC-JPで配信され、Content-Typeにcharsetが無いため明示する。
      encoding: "euc-jp",
    });
    add({
      url: horseResultsApiUrl(horseId),
      filename: `horse_results_${horseId}.json`,
      // 全戦績APIはUTF-8のJSONを返すため、エンコーディング指定は不要。
    });
  }

  return targets;
}
