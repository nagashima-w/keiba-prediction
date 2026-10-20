/**
 * 新聞形式の API(AplNewsPaper)の取得アダプタ(Issue #421 段階 1-b)。`fetch-grade-winner.ts` と同じ形の IO 層で、
 * パース(`parse-newspaper.ts`)とは分離する。
 *
 * ⚠️ race_id が URL でなく POST ボディに入る API なので、URL をキャッシュキーにすると全レースが同じキーになる
 * (`cached-fetcher.ts` の `cacheKey` の JSDoc)。必ず race_id を含む {@link newspaperCacheKey} を渡す。
 * grade-winner のキー(`race_api#AplGradeWinner#…`)とは class の部分で衝突しない。
 *
 * ホストの選択は `urls.ts` の `newspaper*Url` に委譲する(中央 race / 地方 nar。この API は両方にある)。
 */

import type { CachedFetchTextOptions } from "./cached-fetcher.js";
import type { RaceId } from "./ids.js";
import { type PrevRaceCondition, parseNewspaperResponse } from "./parse-newspaper.js";
import { newspaperApiUrl, newspaperOriginUrl, newspaperRefererUrl } from "./urls.js";

/** この API 呼び出し専用のキャッシュキー(race_id を含めて一意にする)。 */
export function newspaperCacheKey(raceId: RaceId): string {
  return `race_api#AplNewsPaper#${raceId}`;
}

/** {@link fetchNewspaperConditions} が要求する最小限のフェッチャ(CachedFetcher が構造的に満たす)。 */
export interface NewspaperFetcher {
  fetchText(url: string, options?: CachedFetchTextOptions): Promise<string>;
}

/** {@link fetchNewspaperConditions} に注入する依存。 */
export interface FetchNewspaperDeps {
  readonly fetcher: NewspaperFetcher;
  /** キャッシュの許容鮮度(ミリ秒)。省略時は無期限(前走の条件は確定データだが、馬柱は出走ごとに増えるので、通常は呼び出し側が指定する)。 */
  readonly maxAgeMs?: number;
}

/**
 * 指定レースの各馬の前走までの条件を取得し、race_id → 条件の表にして返す(中央・地方の両方。地方の条件の文言は空)。
 * @throws NewspaperParseError 応答が読めない(status が OK でない・構造が壊れている)
 */
export async function fetchNewspaperConditions(
  raceId: RaceId,
  deps: FetchNewspaperDeps,
): Promise<Readonly<Record<string, PrevRaceCondition>>> {
  const raw = await deps.fetcher.fetchText(newspaperApiUrl(raceId), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: newspaperRefererUrl(raceId),
      Origin: newspaperOriginUrl(raceId),
    },
    body: `input=UTF-8&output=json&class=AplNewsPaper&method=get&compress=1&race_id=${raceId}`,
    ...(deps.maxAgeMs !== undefined ? { maxAgeMs: deps.maxAgeMs } : {}),
    cacheKey: newspaperCacheKey(raceId),
    encoding: "utf-8",
  });
  return parseNewspaperResponse(raw);
}
