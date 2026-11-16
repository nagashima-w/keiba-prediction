/**
 * 騎手・調教師の年ごとの集計の純関数(Issue #729 段階 A)。`cloudflare:workers` や D1 を import しない(Node でテストできる)。
 * D1 への読み書きは `person-stats-repository.ts`、毎晩の段取りは `market-edge-core.ts`(#642 の DO に差し込む)、集計は `person-stats-aggregate.ts`。
 *
 * ## 定義(**このファイルの 2 つの関数だけが持つ**。並走の突き合わせで netkeiba の年度別成績と合わないときは、ここだけを直す)
 *  - **starts**: 取消・除外を除く全頭。中止・失格・着順の表示が空の馬は走った馬として数える(netkeiba の「1着・2着・3着・着外」の合計と同じ見立て。未確認で、並走で確かめる)。
 *    取消・除外の判定は、戦績への変換(`race-record-to-runs.ts` の `NON_START`)と同じく `finishStatus` の**先頭 1 文字**が「除」「取」。
 *  - **placed**: `finish <= 3`(降着の扱いは結果ページで未確認。`RecordHorse.finishDemoted` の JSDoc 参照)。
 *  - 障害のレースも含める。中央だけ・2021-01-01 以降だけ(2016〜2020 は窓に要らないので書き込みを増やさない)。
 *  - 市場の行(`market-edge-calc.ts` の `buildMarketRow`)と違い、単勝オッズの有無・頭数の下限は問わない(件数を数えるだけなので)。
 *  - 騎手 ID・調教師 ID が null の馬は、行には残し(区分は数える)、集計では数えない。
 */

/** この日付より前のレースは、人の集計に入れない(行も作らない)。`idx_race_archive_person_pending` の WHERE のリテラルと同じ値。 */
export const PERSON_STATS_FROM_DATE = "2021-01-01";

/** 人の行の版。定義(上)を変えたら上げる。`race_archive.person_version` の「取り込み済み」の値。 */
export const PERSON_ROWS_VERSION = 1;

/** 取消・除外(走っていない)。`race-record-to-runs.ts` の `NON_START` と同じ見方(先頭 1 文字)。 */
const NON_START = /^(除|取)/;

/** 結果の記録のうち、人の行を作るのに読む部分(`RaceRecord` の構造的な部分集合)。 */
export interface PersonSourceRecord {
  readonly raceId: string;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly kind: "central" | "nar";
  readonly venueCode: string;
  readonly courseType: "芝" | "ダ" | "障" | null;
  readonly distance: number | null;
  readonly horses: ReadonlyArray<{
    readonly finish: number | null;
    readonly finishStatus: string | null;
    readonly jockeyId: string | null;
    readonly trainerId: string | null;
  }>;
}

/** 1 頭分: [騎手 ID, 調教師 ID, 区分]。区分は 3 着内なら 1、着外なら 0。取消・除外の馬は入れない。 */
export type PersonHorse = readonly [jockeyId: string | null, trainerId: string | null, placed: 0 | 1];

/** 1 レース分の人の行(D1 の `race_person_rows` の 1 行に対応)。#256(コース別)に備えて、競馬場・芝ダ障・距離を持つ。 */
export interface PersonRow {
  readonly raceId: string;
  /** YYYY-MM-DD */
  readonly raceDate: string;
  readonly venueCode: string;
  readonly courseType: "芝" | "ダ" | "障" | null;
  readonly distance: number | null;
  readonly horses: readonly PersonHorse[];
}

/** 結果の記録から人の行を作る。地方・2021-01-01 より前・数える馬が 0 頭のときは null(呼び出し側は印だけ付ける)。 */
export function buildPersonRow(record: PersonSourceRecord): PersonRow | null {
  if (record.kind !== "central" || record.date < PERSON_STATS_FROM_DATE) return null;
  const horses: PersonHorse[] = [];
  for (const h of record.horses) {
    if (h.finishStatus !== null && NON_START.test(h.finishStatus)) continue;
    horses.push([h.jockeyId, h.trainerId, h.finish !== null && h.finish <= 3 ? 1 : 0]);
  }
  if (horses.length === 0) return null;
  return { raceId: record.raceId, raceDate: record.date, venueCode: record.venueCode, courseType: record.courseType, distance: record.distance, horses };
}

/** D1 に入れる `horses_json`。 */
export function encodePersonHorses(horses: readonly PersonHorse[]): string {
  return JSON.stringify(horses);
}

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

/** `horses_json` を読む。形が違えば null(壊れた行は集計に入れず、呼び出し側が数える)。 */
export function decodePersonHorses(json: string): PersonHorse[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const h of parsed) {
    if (!Array.isArray(h) || h.length !== 3) return null;
    if (!isNullableString(h[0]) || !isNullableString(h[1]) || (h[2] !== 0 && h[2] !== 1)) return null;
  }
  return parsed as PersonHorse[];
}

/** 年ごとの集計 1 行(D1 の `person_year` の 1 行に対応。`computedOn` は書き込みのときに付ける)。 */
export interface PersonYearRow {
  readonly personKind: "jockey" | "trainer";
  readonly personId: string;
  readonly year: number;
  readonly starts: number;
  readonly placed: number;
}

/** 人の行を、騎手・調教師ごと・年(開催日の年)ごとに数える。ID が null の馬は数えない。結果は (種別, ID, 年) の順で決定的。 */
export function aggregatePersonYears(rows: readonly PersonRow[]): PersonYearRow[] {
  const acc = new Map<string, { personKind: "jockey" | "trainer"; personId: string; year: number; starts: number; placed: number }>();
  const add = (personKind: "jockey" | "trainer", personId: string | null, year: number, placed: 0 | 1): void => {
    if (personId === null) return;
    const key = `${personKind}\u0000${personId}\u0000${year}`;
    const cur = acc.get(key) ?? { personKind, personId, year, starts: 0, placed: 0 };
    cur.starts += 1;
    cur.placed += placed;
    acc.set(key, cur);
  };
  for (const r of rows) {
    const year = Number(r.raceDate.slice(0, 4));
    for (const [jockeyId, trainerId, placed] of r.horses) {
      add("jockey", jockeyId, year, placed);
      add("trainer", trainerId, year, placed);
    }
  }
  return [...acc.values()].sort((a, b) => (a.personKind === b.personKind ? (a.personId === b.personId ? a.year - b.year : a.personId < b.personId ? -1 : 1) : a.personKind < b.personKind ? -1 : 1));
}
