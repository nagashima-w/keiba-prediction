/**
 * 日付入力(<input type="date"> の YYYY-MM-DD)と内部表現(YYYYMMDD)の相互変換(純関数)。
 *
 * レース選択画面の日付ピッカーは YYYY-MM-DD を扱うが、core の parseKaisaiDate は YYYYMMDD を
 * 期待するため、境界(桁ずれ・空入力)を含めてここで橋渡しし、単体テストで固定する。
 */

/** YYYYMMDD が8桁数字として妥当か。 */
export function isValidYyyymmdd(value: string): boolean {
  return /^[0-9]{8}$/.test(value);
}

/** YYYYMMDD を <input type="date"> 用の YYYY-MM-DD にする。無効な入力は空文字。 */
export function yyyymmddToInput(value: string): string {
  if (!isValidYyyymmdd(value)) {
    return "";
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** <input type="date"> の YYYY-MM-DD を YYYYMMDD にする(ハイフン除去)。 */
export function inputToYyyymmdd(value: string): string {
  return value.replaceAll("-", "");
}
