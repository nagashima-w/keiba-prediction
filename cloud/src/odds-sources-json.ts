import type { OddsSourcesMeta } from "../../packages/core/src/scraper/odds-override";

/** `analyses.odds_sources_json` の JSON の版。形を変えたら上げる。 */
export const ODDS_SOURCES_VERSION = 1;

/**
 * オッズの取得元の記録(Issue #675。core の `RaceDataMeta.oddsSources`)を、D1 の `analyses.odds_sources_json` に入れる JSON の文字列にする。
 * 記録なし(null・undefined・券種が 1 つも無い)は null(NULL で保存する=JRA を使わない保存は列に触れない)。
 * 形: `{"v":1,"sources":{"winPlace":{"source":"jra","officialDatetime":"…"},"wide":{"source":"netkeiba","officialDatetime":null,"fallbackReason":"…"},…}}`。
 */
export function serializeOddsSources(sources: OddsSourcesMeta | null | undefined): string | null {
  if (sources === null || sources === undefined || Object.keys(sources).length === 0) {
    return null;
  }
  return JSON.stringify({ v: ODDS_SOURCES_VERSION, sources });
}
