/**
 * JRA 公式サイトのオッズの入口の頁(開催選択・レース選択)のパーサー(Issue #673 段階 A)。
 *
 * オッズの頁へは、`POST /JRADB/accessO.html` の `cname` を頁のリンクから拾ってたどる(`docs/jra-odds-investigation.md` §2)。
 * 末尾の検査値は計算できないので、組み立てずに頁のリンクの値をそのまま使う。本モジュールは **Shift_JIS をデコードした後の文字列**だけを受け、
 * 次の 2 つの頁から「netkeiba の race_id → 式別 → cname」の対応を作る(純関数。取得とデコードは呼び出し側の仕事)。
 *
 * - 開催選択(`pw15oli00/6D`): 場ごとのレース選択の cname(`pw15orl` + 区分 2 桁 + 場 2 桁 + 年 4 桁 + 回 2 桁 + 日 2 桁 + 開催日 8 桁 + `/` + 符号)。
 * - レース選択: 1 レースにつき 7 つの式別のオッズの頁の cname(`pw15{1,3〜8}ou` + 区分 2 文字 + 場 + 年 + 回 + 日 + R + 開催日 + `Z`〈3連複は `Z99`〉+ `/` + 符号)。
 *
 * race_id は netkeiba と同じ 12 桁(年 + 場 + 回 + 日 + R)。出馬表(`cloud/src/jra-entries-parse.ts` の `parseRaceCname`)も同じ組み立てで、
 * 東京 8R の `202605050208` で netkeiba の慣行と一致することを調査記録(§2.2)で確かめてある。
 *
 * 人気順の頁(`op`)・欠番の `pw152`・軸馬を指定した頁は対象外(`null`)。
 */

/** オッズの頁の式別(`pw151`〜`pw158`。`pw152` は欠番。単勝と複勝は同じ頁)。 */
export const JRA_ODDS_PAGES = ["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"] as const;
export type JraOddsPage = (typeof JRA_ODDS_PAGES)[number];

const PAGE_BY_DIGIT: Readonly<Record<string, JraOddsPage>> = {
  "1": "tanpuku",
  "3": "wakuren",
  "4": "umaren",
  "5": "wide",
  "6": "umatan",
  "7": "sanrenpuku",
  "8": "sanrentan",
};

/** オッズの頁の cname を分解したもの。 */
export interface JraOddsCname {
  readonly page: JraOddsPage;
  /** JRA の場コード 2 桁(netkeiba の race_id の 5〜6 桁目と同じ)。 */
  readonly venueCode: string;
  readonly year: string;
  readonly kai: string;
  readonly day: string;
  readonly race: string;
  /** 開催日 YYYYMMDD。 */
  readonly date: string;
  /** netkeiba の race_id(年 + 場 + 回 + 日 + R の 12 桁)。 */
  readonly raceId: string;
}

// 区分 2 文字(`S3` や 11/7 の `10`。意味は未確認)は読み飛ばす。3連複は末尾が `Z99`(軸馬指定なし=すべて)。
const ODDS_CNAME = /^pw15([1345678])ou[A-Z0-9]{2}(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})(\d{8})Z(?:99)?\/[0-9A-F]{2}$/;

export function parseJraOddsCname(cname: string): JraOddsCname | null {
  const m = ODDS_CNAME.exec(cname);
  if (m === null) return null;
  const [, digit, venueCode, year, kai, day, race, date] = m as unknown as [string, string, string, string, string, string, string, string];
  return { page: PAGE_BY_DIGIT[digit]!, venueCode, year, kai, day, race, date, raceId: `${year}${venueCode}${kai}${day}${race}` };
}

/** 場ごとのレース選択への入口。 */
export interface JraOddsVenueLink {
  readonly venueCode: string;
  readonly year: string;
  readonly kai: string;
  readonly day: string;
  /** 開催日 YYYYMMDD。 */
  readonly date: string;
  /** レース選択の cname(`pw15orl…`)。 */
  readonly racesCname: string;
}

const RACES_CNAME_GLOBAL = /pw15orl\d{2}(\d{2})(\d{4})(\d{2})(\d{2})(\d{8})\/[0-9A-F]{2}/g;
const DATE_PATTERN = /^\d{8}$/;
const VENUE_PATTERN = /^\d{2}$/;

function assertDate(date: string): void {
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`開催日は YYYYMMDD 形式である必要があります(値: "${date}")`);
  }
}

/**
 * 開催選択の頁から、指定の日の場ごとのレース選択の cname を場コードの順に返す(同じ場の重複は先の 1 つ)。
 * 頁にレース選択のリンクが 1 つも無ければ null(別の頁・壊れた頁。指定の日だけが無いときの空の配列とは区別する)。
 * @param date 開催日 `YYYYMMDD`(形が違えば throw)
 */
export function parseJraOddsVenueListPage(html: string, date: string): readonly JraOddsVenueLink[] | null {
  assertDate(date);
  const found = new Map<string, JraOddsVenueLink>();
  let any = false;
  for (const m of html.matchAll(RACES_CNAME_GLOBAL)) {
    any = true;
    const [whole, venueCode, year, kai, day, d] = m as unknown as [string, string, string, string, string, string];
    if (d === date && !found.has(venueCode)) {
      found.set(venueCode, { venueCode, year, kai, day, date: d, racesCname: whole });
    }
  }
  if (!any) return null;
  return [...found.values()].sort((a, b) => a.venueCode.localeCompare(b.venueCode));
}

/** 1 レースぶんの、式別ごとのオッズの頁の cname。 */
export interface JraOddsRaceLinks {
  readonly raceId: string;
  readonly race: string;
  readonly cnames: Readonly<Record<JraOddsPage, string>>;
}

const ODDS_CNAME_GLOBAL = /pw15[1345678]ou[A-Z0-9]{2}\d{2}\d{4}\d{2}\d{2}\d{2}\d{8}Z(?:99)?\/[0-9A-F]{2}/g;

/**
 * レース選択の頁から、指定の場・日のレースごとの式別の cname を、R の順に返す。
 * 7 つの式別が揃わないレースは返さない(一部だけを使うと、取れない式別があるレースを呼び出し側が気づけない)。同じ式別が複数あれば先の 1 つ。
 * @param date 開催日 `YYYYMMDD`
 * @param venueCode 場コード 2 桁
 */
export function parseJraOddsRaceListPage(html: string, date: string, venueCode: string): readonly JraOddsRaceLinks[] {
  assertDate(date);
  if (!VENUE_PATTERN.test(venueCode)) {
    throw new Error(`場コードは 2 桁である必要があります(値: "${venueCode}")`);
  }
  const byRace = new Map<string, Partial<Record<JraOddsPage, string>>>();
  for (const m of html.matchAll(ODDS_CNAME_GLOBAL)) {
    const parsed = parseJraOddsCname(m[0]);
    if (parsed === null || parsed.date !== date || parsed.venueCode !== venueCode) continue;
    const links = byRace.get(parsed.raceId) ?? {};
    if (links[parsed.page] === undefined) links[parsed.page] = m[0];
    byRace.set(parsed.raceId, links);
  }
  const out: JraOddsRaceLinks[] = [];
  for (const [raceId, links] of [...byRace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (JRA_ODDS_PAGES.every((p) => links[p] !== undefined)) {
      out.push({ raceId, race: raceId.slice(10), cnames: links as Record<JraOddsPage, string> });
    }
  }
  return out;
}
