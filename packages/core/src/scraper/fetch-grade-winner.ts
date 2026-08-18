/**
 * 同レース(重賞)の過去10年結果・優勝馬 API(AplGradeWinner)の取得アダプタ(タスク機能B)。
 *
 * パーサ(parse-grade-winner.ts)とは分離し、本ファイルは「fetchText(注入されたキャッシュ付き
 * フェッチャ)でPOSTリクエストを組み立て、結果をパーサに渡す」IO層のみを持つ。
 *
 * ⚠️ 最重要(boss着手前ゲート指摘): このAPIは race_id がURLでなくPOSTボディに入るため、
 * URLをそのままキャッシュキーにすると全レースで同一キーになり、最初に取得したレースのデータが
 * 以降すべての重賞レースに誤って返る事故になる。必ず CachedFetchTextOptions.cacheKey に
 * race_id を含む一意なキー(gradeWinnerCacheKey)を渡す。
 *
 * 中央/地方(NAR)の両対応(2026-07-28 実測訂正): 当初は「地方(NAR)にはこのAPI相当のページが
 * 存在しない(oikiri/comment同様)」と判断していたが、これは中央ホスト(race.netkeiba.com)に
 * 地方race_idを投げていたための誤りだった。正しくは地方専用ホスト(nar.netkeiba.com)に
 * 同一パラメータでPOSTすれば取得できる(パラメータ・レスポンス形式は中央と完全に同一。
 * Refererのページ名のみ中央がpast10.html、地方がpast5.htmlと異なる)。ホストの選択は
 * urls.ts の gradeWinnerApiUrl/gradeWinnerRefererUrl/gradeWinnerOriginUrl に委譲し
 * (raceListSubUrl/narRaceListSubUrl等と同じ「中央/地方でURLビルダを分ける」流儀)、
 * 本ファイルはNAR固有の分岐・例外送出を一切持たない。
 */

import type { CachedFetchTextOptions } from "./cache.js";
import type { RaceId } from "./ids.js";
import {
  type GradeWinnerEntry,
  parseGradeWinnerResponse,
} from "./parse-grade-winner.js";
import {
  gradeWinnerApiUrl,
  gradeWinnerOriginUrl,
  gradeWinnerRefererUrl,
} from "./urls.js";

/**
 * このAPI呼び出し専用のキャッシュキーを組み立てる(race_idを含めて一意にする)。
 * fetchGradeWinnerEntries が内部で使うのと同じロジックを外部(呼び出し側テスト等)からも
 * 参照できるようexportする。
 */
export function gradeWinnerCacheKey(raceId: RaceId): string {
  return `race_api#AplGradeWinner#${raceId}`;
}

/** fetchGradeWinnerEntries が要求する最小限のフェッチャ(CachedFetcher が構造的に満たす)。 */
export interface GradeWinnerFetcher {
  fetchText(url: string, options?: CachedFetchTextOptions): Promise<string>;
}

/** fetchGradeWinnerEntries に注入する依存。 */
export interface FetchGradeWinnerDeps {
  /** キャッシュ付きフェッチャ(通常は CachedFetcher)。 */
  readonly fetcher: GradeWinnerFetcher;
}

/**
 * 指定レースの過去10年結果・優勝馬データを取得する(中央・地方〈NAR〉のいずれにも対応)。
 *
 * @param raceId 分析対象のレースID(検証済み)
 * @param deps 注入依存(fetcher)
 * @returns status:OK のとき過去回配列(長さ10とは限らない)。非重賞・対象データなし(status:NG)は
 *   null(呼び出し側はこれを異常とみなさず静かにスキップすること)。
 * @throws GradeWinnerParseError status:OKであるにもかかわらず応答構造が壊れている場合
 */
export async function fetchGradeWinnerEntries(
  raceId: RaceId,
  deps: FetchGradeWinnerDeps,
): Promise<readonly GradeWinnerEntry[] | null> {
  const body =
    `input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=${raceId}`;
  const raw = await deps.fetcher.fetchText(gradeWinnerApiUrl(raceId), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: gradeWinnerRefererUrl(raceId),
      Origin: gradeWinnerOriginUrl(raceId),
    },
    body,
    // 過去回は確定データのため maxAgeMs は指定しない(無期限キャッシュ)。
    cacheKey: gradeWinnerCacheKey(raceId),
    encoding: "utf-8",
  });

  return parseGradeWinnerResponse(raw);
}
