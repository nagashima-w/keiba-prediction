/**
 * レースIDの場コード(5〜6桁目)から中央10場の会場名を導出する。
 *
 * レースIDは YYYY(年4桁)+ 競馬場コード(2桁 01〜10)+ 回次(2桁)+ 日次(2桁)+ レース番号(2桁)。
 * scorer の competition/コース特性は会場名(「東京」等)をキーに参照するため、
 * scrapeRace が返すレース情報に会場名が無い場合の一次情報としてレースIDから導出する。
 * コード→会場名の対応は JRA の場コード割り当て(01=札幌 … 10=小倉)に従う。
 */

/**
 * 場コード(2桁文字列)→ 中央競馬場名。JRAの割り当て順。
 *
 * Map を使うのは列挙順を保証するため。プレーンオブジェクトでは "10" のような
 * 整数インデックス相当のキーが先頭へ繰り上がり、"01"〜"09" との列挙順が崩れる。
 */
export const VENUE_BY_TRACK_CODE: ReadonlyMap<string, string> = new Map([
  ["01", "札幌"],
  ["02", "函館"],
  ["03", "福島"],
  ["04", "新潟"],
  ["05", "東京"],
  ["06", "中山"],
  ["07", "中京"],
  ["08", "京都"],
  ["09", "阪神"],
  ["10", "小倉"],
]);

/**
 * レースID(12桁)から会場名を導出する。
 * 12桁でない、または場コードが中央10場(01〜10)に対応しない場合は例外を投げる。
 *
 * @param raceId レースID(12桁数字の文字列)
 * @returns 中央競馬場名
 */
export function venueNameFromRaceId(raceId: string): string {
  if (!/^[0-9]{12}$/.test(raceId)) {
    throw new Error(`レースIDは12桁の数字である必要があります(入力: "${raceId}")`);
  }
  const trackCode = raceId.slice(4, 6);
  const venue = VENUE_BY_TRACK_CODE.get(trackCode);
  if (venue === undefined) {
    throw new Error(
      `場コード "${trackCode}" に対応する中央競馬場がありません(レースID: "${raceId}")`,
    );
  }
  return venue;
}
