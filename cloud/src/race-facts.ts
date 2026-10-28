/**
 * 分析のスナップショット(R2 の詳細の `raceSnapshot`。core の `buildRaceSnapshot` の形)から、条件別の見える化(Issue #385)が使うレースの事実を取り出す純関数(Issue #389〈#385-B の a〉)。
 * 検証の DO が、発走時刻の補完と同じ get で取り出して D1 の `analyses` に写す(migration 0023)。画面での使い方(距離帯・馬場の表記・芝ダ)は #389-b。グレード・レース名の列は画面で使わない(クラスは #426 が保存した正確な値〈`raceClass`〉だけを #389-c の節が使い、レース名・グレードからは推定しない)。
 *
 * **想定外の形・型は例外にせず、その項目だけ null**(推測で直さない)。値は**生のまま**持つ(馬場の略記・グレードの表記・レース名を正規化しない。区切りや推定を後から変えても R2 を読み直さずに済ませるため)。
 * `prior-export-format.ts` の同種の取り出し(`toSnapshotColumns`)とは別物: こちらは距離を正の整数だけ・芝ダを 3 値だけに絞り、文字列は前後の空白を除き、長すぎる値を null にする。書き出しの結果は変えない。
 */

/** 文字列の最大文字数(コードポイント)。超える値は自由文の疑いで null にする(実データのレース名は最長でも 30 文字前後)。切り詰めない=途中で切れた名前を事実として持たない。 */
export const RACE_FACT_TEXT_MAX_LENGTH = 100;

export interface RaceFacts {
  /** 芝 / ダ / 障。 */
  readonly courseType: string | null;
  /** 距離(メートル。正の整数)。 */
  readonly distance: number | null;
  /** 馬場状態の生の値(分析時点)。 */
  readonly trackCondition: string | null;
  /** グレードの生の値。 */
  readonly grade: string | null;
  /** レース名の生の値。 */
  readonly raceName: string | null;
  /**
   * レースのクラス(Issue #426。出馬表の `RaceData02` から読んだ値。中央は正準ラベル、地方は区分の生のトークン)。**値があるときだけキーを持つ**
   * (クラスを保存する前のスナップショット・読めなかったレースはキー自体が無い。他の項目と違って null を足さないのは、従来の事実の形を変えないため)。
   */
  readonly raceClass?: string;
}

const COURSE_TYPES: ReadonlySet<string> = new Set(["芝", "ダ", "障"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const trimmed = v.trim();
  return trimmed === "" || Array.from(trimmed).length > RACE_FACT_TEXT_MAX_LENGTH ? null : trimmed;
}

const NO_FACTS: RaceFacts = { courseType: null, distance: null, trackCondition: null, grade: null, raceName: null };

export function extractRaceFacts(snapshot: unknown): RaceFacts {
  if (!isRecord(snapshot) || !isRecord(snapshot["race"])) {
    return NO_FACTS;
  }
  const race = snapshot["race"];
  const courseType = race["courseType"];
  const distance = race["distance"];
  const raceClass = textOrNull(race["raceClass"]);
  return {
    courseType: typeof courseType === "string" && COURSE_TYPES.has(courseType) ? courseType : null,
    distance: typeof distance === "number" && Number.isInteger(distance) && distance > 0 ? distance : null,
    trackCondition: textOrNull(race["trackCondition"]),
    grade: textOrNull(race["grade"]),
    raceName: textOrNull(race["raceName"]),
    ...(raceClass !== null ? { raceClass } : {}),
  };
}
