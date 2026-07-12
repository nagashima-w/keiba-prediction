/**
 * netkeibaの各種ID・開催日の型定義と検証。
 *
 * 未検証の生文字列と検証済みIDをコンパイル時に取り違えないよう、ブランド型を用いる。
 * ブランド型は実行時には単なる文字列だが、`__brand` フィールドにより型レベルで区別される。
 * 検証済み値は必ず本モジュールのパース関数を通してのみ生成できる(コンストラクタは非公開)。
 */

/** 一意なブランドを付与するためのヘルパ型。 */
type Branded<T, B extends string> = T & { readonly __brand: B };

/**
 * レースID: 12桁数字。
 *
 * 構成は中央・地方で異なる(いずれも YYYY(年4桁) + 場コード(2桁) + □□(2桁) + □□(2桁) + レース番号(2桁 01〜12)):
 * - 中央(場コード01〜10): YYYY + 場コード + 回次(2桁) + 日次(2桁) + レース番号
 * - 地方(場コード30〜64): YYYY + 場コード + 月(2桁) + 日(2桁) + レース番号(開催日がIDに直接埋め込まれる)
 *
 * 場コード65(帯広・ばんえい競馬)はそり曳きで平地競走ではないため対象外とし、11〜29・66以上とともに拒否する。
 * 詳細: docs/nar-scraping-plan.md「race_id の体系」。
 */
export type RaceId = Branded<string, "RaceId">;

/** レースIDの開催区分(場コードから判定)。 */
export type RaceIdVenueKind = "central" | "nar";

/** 開催日: YYYYMMDD形式(実在する日付のみ)。 */
export type KaisaiDate = Branded<string, "KaisaiDate">;

/** 馬ID: 10桁数字(db.netkeiba.com/horse/{horse_id} の形式)。 */
export type HorseId = Branded<string, "HorseId">;

/**
 * ID・開催日の検証失敗を表す例外。理由を日本語メッセージに含める。
 */
export class InvalidIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdError";
  }
}

/** 与えられた文字列がちょうど指定桁数の半角数字のみで構成されるか判定する。 */
function isDigits(value: string, length: number): boolean {
  return value.length === length && /^[0-9]+$/.test(value);
}

/** ある年が閏年(グレゴリオ暦)かどうかを判定する。 */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 各月の日数(1始まりの月番号でアクセスする。閏年の2月は別途加算)。 */
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 年・月・日が実在する日付かどうかを判定する(閏年判定を含む)。 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) {
    return false;
  }
  const maxDay =
    month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month] ?? 0;
  return day >= 1 && day <= maxDay;
}

/** 地方の場コード範囲(30〜64、帯広=65は除く)。 */
const NAR_TRACK_CODE_MIN = 30;
const NAR_TRACK_CODE_MAX = 64;
/** 帯広(ばんえい競馬)の場コード。そり曳きで平地競走ではないため明示的に対象外とする。 */
const OBIHIRO_BANEI_TRACK_CODE = 65;

/**
 * レースIDをパースする。不正な入力は理由付きの InvalidIdError を投げる。
 *
 * @param input 検証対象の文字列
 * @returns 検証済みの RaceId
 */
export function parseRaceId(input: string): RaceId {
  if (!isDigits(input, 12)) {
    throw new InvalidIdError(
      `レースIDは12桁の数字である必要があります(入力: "${input}")`,
    );
  }

  // 5〜6桁目: 場コード。中央(JRA10場)は01〜10、地方は30〜64を許容する。
  // 65(帯広・ばんえい競馬)はそり曳きで平地競走ではないため明示的に拒否する。
  const trackCode = Number(input.slice(4, 6));
  const isCentralTrack = trackCode >= 1 && trackCode <= 10;
  const isNarTrack =
    trackCode >= NAR_TRACK_CODE_MIN && trackCode <= NAR_TRACK_CODE_MAX;
  if (trackCode === OBIHIRO_BANEI_TRACK_CODE) {
    throw new InvalidIdError(
      `帯広(ばんえい競馬・場コード65)はそり曳きで平地競走ではないため対象外です(入力: "${input.slice(4, 6)}")`,
    );
  }
  if (!isCentralTrack && !isNarTrack) {
    throw new InvalidIdError(
      `競馬場コードは01〜10(中央)または30〜64(地方)の範囲である必要があります(入力: "${input.slice(4, 6)}")`,
    );
  }

  // 地方(場コード30〜64)は7〜10桁目に開催日(月日)が直接埋め込まれるため、実在日として検証する。
  // 中央の7〜10桁目は回次・日次であり日付ではないため、この検証の対象外とする。
  if (isNarTrack) {
    const year = Number(input.slice(0, 4));
    const month = Number(input.slice(6, 8));
    const day = Number(input.slice(8, 10));
    if (!isRealDate(year, month, day)) {
      throw new InvalidIdError(
        `地方レースIDの月日部(7〜10桁目)が実在日ではありません(入力: "${input}", ${year}年${month}月${day}日)`,
      );
    }
  }

  // 11〜12桁目: レース番号。1レース〜12レースの 01〜12 のみ許容する。
  const raceNumber = Number(input.slice(10, 12));
  if (raceNumber < 1 || raceNumber > 12) {
    throw new InvalidIdError(
      `レース番号は01〜12の範囲である必要があります(入力: "${input.slice(10, 12)}")`,
    );
  }

  return input as RaceId;
}

/**
 * レースIDから開催区分(中央/地方)を判定する。
 * parseRaceId を通過した値のみを受け取るため、場コードは 01〜10 または 30〜64 のいずれかである。
 *
 * @param raceId 検証済みのレースID
 * @returns 中央なら "central"、地方なら "nar"
 */
export function venueKindOfRaceId(raceId: RaceId): RaceIdVenueKind {
  const trackCode = Number(raceId.slice(4, 6));
  return trackCode <= 10 ? "central" : "nar";
}

/**
 * 開催日(YYYYMMDD)をパースする。不正な入力は理由付きの InvalidIdError を投げる。
 * 月・日の範囲に加え、閏年判定を含む実在日チェックを行う(2月30日等は不正)。
 *
 * @param input 検証対象の文字列
 * @returns 検証済みの KaisaiDate
 */
export function parseKaisaiDate(input: string): KaisaiDate {
  if (!isDigits(input, 8)) {
    throw new InvalidIdError(
      `開催日はYYYYMMDD形式の8桁数字である必要があります(入力: "${input}")`,
    );
  }

  const year = Number(input.slice(0, 4));
  const month = Number(input.slice(4, 6));
  const day = Number(input.slice(6, 8));

  if (month < 1 || month > 12) {
    throw new InvalidIdError(
      `月は01〜12の範囲である必要があります(入力: "${input.slice(4, 6)}")`,
    );
  }

  if (!isRealDate(year, month, day)) {
    throw new InvalidIdError(
      `${year}年${month}月に${day}日は存在しません(入力: "${input}")`,
    );
  }

  return input as KaisaiDate;
}

/**
 * 馬IDをパースする。不正な入力は理由付きの InvalidIdError を投げる。
 *
 * @param input 検証対象の文字列
 * @returns 検証済みの HorseId
 */
export function parseHorseId(input: string): HorseId {
  if (!isDigits(input, 10)) {
    throw new InvalidIdError(
      `馬IDは10桁の数字である必要があります(入力: "${input}")`,
    );
  }
  return input as HorseId;
}
