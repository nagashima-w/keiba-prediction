/**
 * レースIDの場コード(5〜6桁目)から中央競馬(JRA)10場/地方競馬(NAR)の会場名を導出する。
 *
 * レースIDは YYYY(年4桁)+ 競馬場コード(2桁)+ □□(2桁)+ □□(2桁)+ レース番号(2桁)。
 * 場コード01〜10は中央10場、30〜64は地方競馬(NAR)を表す(docs/nar-scraping-plan.md
 * 「race_id の体系」・packages/core/src/scraper/ids.ts 参照。65=帯広ばんえいは対象外)。
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
 * 場コード(2桁文字列)→ 地方競馬(NAR)会場名。実測済み(docs/nar-scraping-plan.md参照)の
 * 14場のみを網羅する。地方の場コード帯(30〜64)は netkeiba側の公式割り当てを完全には
 * 実測できていないため、この表にない場コードは venueNameFromRaceId 側でフォールバック表示名
 * (「地方(コードNN)」)にする(未知コードを例外にしない。受け入れ条件どおり)。
 */
export const VENUE_BY_NAR_TRACK_CODE: ReadonlyMap<string, string> = new Map([
  ["30", "門別"],
  ["35", "盛岡"],
  ["36", "水沢"],
  ["42", "浦和"],
  ["43", "船橋"],
  ["44", "大井"],
  ["45", "川崎"],
  ["46", "金沢"],
  ["47", "笠松"],
  ["48", "名古屋"],
  ["50", "園田"],
  ["51", "姫路"],
  ["54", "高知"],
  ["55", "佐賀"],
]);

/** 地方(NAR)の場コード範囲(30〜64、帯広=65は対象外)。packages/core/src/scraper/ids.ts と同じ範囲。 */
const NAR_TRACK_CODE_MIN = 30;
const NAR_TRACK_CODE_MAX = 64;

/**
 * レースID(12桁)から会場名を導出する。
 * 場コードが中央10場(01〜10)なら中央競馬場名、地方(30〜64)なら地方競馬場名を返す
 * (地方は実測済みの14場を優先し、未知コードは「地方(コードNN)」にフォールバックする)。
 * 12桁でない、または場コードがいずれの範囲にも属さない場合は例外を投げる。
 *
 * @param raceId レースID(12桁数字の文字列)
 * @returns 競馬場名(中央競馬場名、地方競馬場名、または地方の未知コードのフォールバック表示名)
 */
export function venueNameFromRaceId(raceId: string): string {
  if (!/^[0-9]{12}$/.test(raceId)) {
    throw new Error(`レースIDは12桁の数字である必要があります(入力: "${raceId}")`);
  }
  const trackCode = raceId.slice(4, 6);
  const central = VENUE_BY_TRACK_CODE.get(trackCode);
  if (central !== undefined) {
    return central;
  }
  const trackCodeNum = Number(trackCode);
  if (trackCodeNum >= NAR_TRACK_CODE_MIN && trackCodeNum <= NAR_TRACK_CODE_MAX) {
    return VENUE_BY_NAR_TRACK_CODE.get(trackCode) ?? `地方(コード${trackCode})`;
  }
  throw new Error(
    `場コード "${trackCode}" に対応する競馬場がありません(レースID: "${raceId}")`,
  );
}
