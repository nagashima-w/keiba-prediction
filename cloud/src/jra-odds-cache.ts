/**
 * JRA のオッズの頁を、パース済みの小さな JSON にして取得キャッシュ(`fetch_cache`)に置き、計算の段が `OddsOverride` として読む(Issue #675。#668-D)。
 *
 * - 置くのは**パース済みの JSON だけ**(生の HTML は置かない。三連単は HTML が約 1MB、JSON は 18 頭で数百 KB)。パースは頁を取った段の中で 1 頁ずつ行う。
 * - キーは netkeiba のオッズの URL の分類(`ODDS_URL_PATTERN`)に当たらない形にする(計算の段の「古い netkeiba のオッズを使わない」守りと混ざらない)。
 *   鮮度は {@link createJraOddsOverride} が、キャッシュの取得時刻と `oddsSince` で同じ守りをかける。
 * - 読み出しは例外を投げない(壊れた・版の違う・種別の違う JSON は「無い」=null。`scrapeRace` が netkeiba に戻る)。
 */
import type { ComboBetType, ComboOddsCell } from "../../packages/core/src/scraper/combo-odds-key";
import type { OddsOverride, OddsOverrideCombo } from "../../packages/core/src/scraper/odds-override";
import { parseJraComboOddsWithHeader, parseJraWinPlaceOdds } from "../../packages/core/src/scraper/parse-jra-odds";
import type { JraOddsPage } from "../../packages/core/src/scraper/parse-jra-odds-index";
import type { OddsSnapshot } from "../../packages/core/src/scraper/types";

/** 組合せの券種 → JRA の式別(頁)。 */
export const JRA_PAGE_FOR_BET: Readonly<Record<ComboBetType, Exclude<JraOddsPage, "tanpuku">>> = {
  wide: "wide",
  trio: "sanrenpuku",
  quinella: "umaren",
  exacta: "umatan",
  trifecta: "sanrentan",
  bracketQuinella: "wakuren",
};

/** JSON の版。形を変えたら上げる(古い版は読まない=null)。 */
const PAYLOAD_VERSION = 1;

/** オッズの頁の JSON を置くキー。 */
export const jraOddsCacheKey = (raceId: string, page: JraOddsPage): string => `jra-odds:${raceId}:${page}`;
/** そのレースの式別ごとの cname(JRA の cname の対応)を置くキー。 */
export const jraLinksCacheKey = (raceId: string): string => `jra-odds-links:${raceId}`;

export type ParsedJraOddsPage =
  | { readonly status: "ok"; readonly page: JraOddsPage; readonly json: string }
  | { readonly status: "unavailable" | "parse-error" };

/**
 * 頁(Shift_JIS をデコード済みの文字列)をパースして、キャッシュに置く JSON にする。
 * @param raceDate `YYYY-MM-DD`(頁の時刻の日付)
 * @param bet 組合せの頁のとき、その券種(`tanpuku` では省く)
 */
export function parseJraOddsPage(page: JraOddsPage, html: string, raceDate: string, bet?: ComboBetType): ParsedJraOddsPage {
  try {
    if (page === "tanpuku") {
      const parsed = parseJraWinPlaceOdds(html, raceDate);
      if (parsed.state !== "available") {
        return { status: "unavailable" };
      }
      return { status: "ok", page, json: JSON.stringify({ v: PAYLOAD_VERSION, page, snapshot: parsed.snapshot, horseIds: parsed.horseIds }) };
    }
    if (bet === undefined || JRA_PAGE_FOR_BET[bet] !== page) {
      return { status: "parse-error" };
    }
    const parsed = parseJraComboOddsWithHeader(html, bet, raceDate);
    if (parsed.result.state !== "available") {
      return { status: "unavailable" };
    }
    const cells = [...parsed.result.odds.entries()];
    return { status: "ok", page, json: JSON.stringify({ v: PAYLOAD_VERSION, page, officialDatetime: parsed.header?.officialDatetime ?? null, cells }) };
  } catch {
    return { status: "parse-error" };
  }
}

/** 取得キャッシュのうち読む部分。 */
export interface JraOddsCacheReader {
  get(key: string): { readonly value: string; readonly fetchedAt: number } | undefined;
}

function readPayload(cache: JraOddsCacheReader, raceId: string, page: JraOddsPage, oddsSince: number): Record<string, unknown> | null {
  try {
    const entry = cache.get(jraOddsCacheKey(raceId, page));
    if (entry === undefined || entry.fetchedAt < oddsSince) {
      return null;
    }
    const parsed: unknown = JSON.parse(entry.value);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return record.v === PAYLOAD_VERSION && record.page === page ? record : null;
  } catch {
    return null;
  }
}

export interface CreateJraOddsOverrideDeps {
  readonly cache: JraOddsCacheReader;
  readonly raceId: string;
  /** 取得の段の開始時刻。これより古く取った JSON は使わない(古いオッズを今のオッズとして使わない)。 */
  readonly oddsSince: number;
}

/** キャッシュの JSON だけを読む差し込み口(ネットワークには出ない)。 */
export function createJraOddsOverride(deps: CreateJraOddsOverrideDeps): OddsOverride {
  return {
    source: "jra",
    async winPlace(): Promise<OddsSnapshot | null> {
      const payload = readPayload(deps.cache, deps.raceId, "tanpuku", deps.oddsSince);
      const snapshot = payload?.snapshot;
      return typeof snapshot === "object" && snapshot !== null ? (snapshot as OddsSnapshot) : null;
    },
    async combo(betType: ComboBetType): Promise<OddsOverrideCombo | null> {
      const payload = readPayload(deps.cache, deps.raceId, JRA_PAGE_FOR_BET[betType], deps.oddsSince);
      if (payload === null || !Array.isArray(payload.cells)) {
        return null;
      }
      const datetime = payload.officialDatetime;
      return {
        odds: new Map(payload.cells as [string, ComboOddsCell][]),
        officialDatetime: typeof datetime === "string" ? datetime : null,
      };
    },
  };
}
