/**
 * 騎手・調教師の年ごとの集計(Issue #729 段階 A)。取り込みで触れた年の人の行(`race_person_rows`)を D1 から読み、人 × 年の集計(`person_year`)を置き換える。
 * ストアは注入(本番は {@link D1PersonStatsStore})。R2 には触れない。構造は `market-edge-aggregate.ts`(#642)を写した。
 *
 * ## 読み取りの見積もり
 * 1 年は中央で約 3,450 レース(1 行 約 0.4KB)。ページ({@link PERSON_AGGREGATE_PAGE} 行)ごとに D1 を 1 回呼ぶので 1 年あたり約 7 回。
 * 毎晩は触れた年だけ(定常は当年の 1 年)。初回の埋め戻しが終わった晩だけ 2021〜当年の全部(約 20,000 行・約 41 回)を読む。
 *
 * ## 書き込み
 * 値が変わった行だけ書く(`UPSERT_PERSON_YEAR_SQL` の WHERE)。同じ値の再計算は 0 行。人の行が 1 行もない年は何も書かない。
 * 壊れた行(`horses_json` を読めなかった行)がある年は、数が少ないまま書かないために**その年を書かず**、`skippedYears` に返す(呼び出し側は触れた年として残し、次の晩にもう一度試す)。
 *
 * ## 消えた人は消さない
 * 取り込み直しで、ある年にいた人が全部の行から消える(パーサの修正など)ことは起こりうるが、`person_year` の主キーは (人, 年) で、年の範囲を消す安い SQL が無い
 * (全走査になる)ので、置き換えは UPSERT だけで、消えた人の行は残る。起こったら、診断(並走の突き合わせ)で気づく。
 */
import { aggregatePersonYears, type PersonRow, type PersonYearRow } from "./person-stats-calc";
import type { PersonRowsCursor, PersonRowsPage } from "./person-stats-repository";

/** 1 回の読み取りで読む人の行の数(1 行 約 0.4KB)。 */
export const PERSON_AGGREGATE_PAGE = 500;

/** 集計が使うストアの部分(`D1PersonStatsStore` の部分集合)。 */
export interface PersonAggregateStore {
  readRowsPage(after: PersonRowsCursor, toExclusive: string, limit: number): Promise<PersonRowsPage>;
  replaceYears(years: readonly PersonYearRow[], computedOn: string): Promise<{ rowsWritten: number }>;
}

export type PersonAggregateResult =
  | { readonly status: "no-years" }
  | {
      readonly status: "written";
      /** 書いた(人の行が 1 行以上あった)年。 */
      readonly years: readonly number[];
      /** 壊れた行があって書かなかった年。 */
      readonly skippedYears: readonly number[];
      readonly rowsWritten: number;
      /** 読んだ人の行(レース)の数。 */
      readonly races: number;
      /** 読めなかった(壊れた)人の行の数。 */
      readonly broken: number;
    };

/** 指定した年(西暦)ごとに、人の行を読んで人 × 年の集計を置き換える。`today` は JST の YYYY-MM-DD(書いた行の `computed_on`)。 */
export async function aggregatePersonYearsFor(
  store: PersonAggregateStore,
  years: readonly number[],
  today: string,
  options: { readonly pageSize?: number } = {},
): Promise<PersonAggregateResult> {
  if (years.length === 0) return { status: "no-years" };
  const pageSize = options.pageSize ?? PERSON_AGGREGATE_PAGE;
  const written: number[] = [];
  const skippedYears: number[] = [];
  let rowsWritten = 0;
  let races = 0;
  let broken = 0;
  for (const year of [...years].sort((a, b) => a - b)) {
    const rows: PersonRow[] = [];
    let yearBroken = 0;
    const to = `${year + 1}-01-01`;
    let cursor: PersonRowsCursor | null = { raceDate: `${year}-01-01`, raceId: "" };
    while (cursor !== null) {
      const page: PersonRowsPage = await store.readRowsPage(cursor, to, pageSize);
      rows.push(...page.rows);
      yearBroken += page.broken;
      cursor = page.next;
    }
    broken += yearBroken;
    if (yearBroken > 0) {
      skippedYears.push(year);
      continue;
    }
    if (rows.length === 0) continue;
    races += rows.length;
    const saved = await store.replaceYears(aggregatePersonYears(rows), today);
    rowsWritten += saved.rowsWritten;
    written.push(year);
  }
  return { status: "written", years: written, skippedYears, rowsWritten, races, broken };
}
