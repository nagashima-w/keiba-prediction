/**
 * 戦績の1走(`HorseRaceResult`)を D1 に貯める形(位置タプル)の符号化(Issue #256 段階A)。
 *
 * ## 目的
 * 事前分析で取った各馬の戦績を、(馬 ID, 行の鍵)で冪等に貯める(クラウド版の D1 `horse_runs`。migration 0014)。保存は**事実の記録**で、
 * 段階 C(保存済みの行から読む)・D(結果ページから行を作る)・E(騎手 × コースの集計)・#274(走破タイムの基準)が読む。
 * 戦績 API は後から安く取り直せないので、`HorseRaceResult` の**全項目**を欠けずに持つ(スロット表の型検査と網羅ガードのテストが、項目の追加を赤にする)。
 *
 * ## 形
 * 27 項目のうち `raceId` は `raceIdRaw` から導けるので持たず、残り 26 項目を {@link HORSE_RUN_SLOT_COUNT} 個のスロットの配列にする(JSON にして保存する。
 * 項目名を毎行に持たないので小さい)。入れ子は、開催 `[回次, 会場, 日目, 生テキスト]`・馬体重 `[体重, 増減]`・着順(下記)。
 * 着順: 通常の順位 = 数値 / 降着つきの順位 = `[順位, 1]` / 非数値(中止・失格など) = 文字列。
 * 符号化は決定的(同じ入力は同じ JSON 文字列)。重複・不一致の判定は保存済みの文字列との比較で行うため。
 *
 * ## 版数
 * {@link HORSE_RUN_PARSER_VERSION}: パーサの出力の意味(どの文字をどの値にするか)を変えたら上げる。保存済みの行がこれより古ければ、
 * 次に取ったときに上書きする(遅延した取り直し)。
 */

import { parseRaceId } from "./ids.js";
import type { BodyWeight, CourseType, FinishPosition, HorseRaceResult, RaceVenue, VenueKind } from "./types.js";

/** 位置タプルの版数。パーサの出力の意味を変えたら上げる(保存済みの行は、次の取得で上書きされる)。 */
export const HORSE_RUN_PARSER_VERSION = 1;

/**
 * `HorseRaceResult` の各項目がタプルのどのスロットに入るか。`raceId` だけは `raceIdRaw` から導くので null。
 * `satisfies Record<keyof HorseRaceResult, …>` により、項目が足された・消えたら型検査が落ちる(網羅ガード)。
 */
export const HORSE_RUN_FIELD_SLOTS = {
  date: 0,
  venue: 1,
  weather: 2,
  raceNumber: 3,
  raceName: 4,
  raceId: null,
  raceIdRaw: 5,
  venueKind: 6,
  entryCount: 7,
  wakuban: 8,
  umaban: 9,
  odds: 10,
  ninki: 11,
  finishPosition: 12,
  jockeyName: 13,
  jockeyId: 14,
  kinryo: 15,
  courseType: 16,
  distance: 17,
  trackCondition: 18,
  time: 19,
  margin: 20,
  passing: 21,
  pace: 22,
  last3f: 23,
  bodyWeight: 24,
  winnerName: 25,
} as const satisfies Record<keyof HorseRaceResult, number | null>;

/** タプルのスロット数(`raceId` を除く 26)。 */
export const HORSE_RUN_SLOT_COUNT = 26;

const S = HORSE_RUN_FIELD_SLOTS;

function encodeFinish(finish: FinishPosition | null): unknown {
  if (finish === null) {
    return null;
  }
  if (finish.kind === "非数値") {
    return finish.text;
  }
  return finish.demoted === true ? [finish.value, 1] : finish.value;
}

function decodeFinish(raw: unknown): FinishPosition | null {
  if (typeof raw === "number") {
    return { kind: "順位", value: raw };
  }
  if (typeof raw === "string") {
    return { kind: "非数値", text: raw };
  }
  if (Array.isArray(raw) && typeof raw[0] === "number") {
    return { kind: "順位", value: raw[0], demoted: true };
  }
  return null;
}

/** 1走をタプル(JSON にできる配列)にする。 */
export function encodeHorseRun(run: HorseRaceResult): unknown[] {
  const tuple: unknown[] = new Array<unknown>(HORSE_RUN_SLOT_COUNT).fill(null);
  tuple[S.date] = run.date;
  tuple[S.venue] = run.venue === null ? null : [run.venue.round, run.venue.name, run.venue.day, run.venue.raw];
  tuple[S.weather] = run.weather;
  tuple[S.raceNumber] = run.raceNumber;
  tuple[S.raceName] = run.raceName;
  tuple[S.raceIdRaw] = run.raceIdRaw;
  tuple[S.venueKind] = run.venueKind;
  tuple[S.entryCount] = run.entryCount;
  tuple[S.wakuban] = run.wakuban;
  tuple[S.umaban] = run.umaban;
  tuple[S.odds] = run.odds;
  tuple[S.ninki] = run.ninki;
  tuple[S.finishPosition] = encodeFinish(run.finishPosition);
  tuple[S.jockeyName] = run.jockeyName;
  tuple[S.jockeyId] = run.jockeyId;
  tuple[S.kinryo] = run.kinryo;
  tuple[S.courseType] = run.courseType;
  tuple[S.distance] = run.distance;
  tuple[S.trackCondition] = run.trackCondition;
  tuple[S.time] = run.time;
  tuple[S.margin] = run.margin;
  tuple[S.passing] = run.passing;
  tuple[S.pace] = run.pace;
  tuple[S.last3f] = run.last3f;
  tuple[S.bodyWeight] = run.bodyWeight === null ? null : [run.bodyWeight.weight, run.bodyWeight.diff];
  tuple[S.winnerName] = run.winnerName;
  return tuple;
}

/**
 * タプルから1走に戻す(段階Aでは読み出しに使わない。往復の保証のテストと、後の段階 C・D・E のため)。
 * 配列でない・長さが違うものは null(例外にしない)。各スロットの値の型は信頼する(自分が書いた行を読む前提)。
 */
export function decodeHorseRun(raw: unknown): HorseRaceResult | null {
  if (!Array.isArray(raw) || raw.length !== HORSE_RUN_SLOT_COUNT) {
    return null;
  }
  const t = raw as unknown[];
  const venueRaw = t[S.venue] as [number | null, string | null, number | null, string] | null;
  const venue: RaceVenue | null =
    venueRaw === null ? null : { round: venueRaw[0], name: venueRaw[1], day: venueRaw[2], raw: venueRaw[3] };
  const bodyRaw = t[S.bodyWeight] as [number, number] | null;
  const bodyWeight: BodyWeight | null = bodyRaw === null ? null : { weight: bodyRaw[0], diff: bodyRaw[1] };
  const raceIdRaw = t[S.raceIdRaw] as string | null;
  const venueKind = t[S.venueKind] as VenueKind;
  let raceId: HorseRaceResult["raceId"] = null;
  if (venueKind === "中央" && raceIdRaw !== null) {
    try {
      raceId = parseRaceId(raceIdRaw);
    } catch {
      raceId = null; // 場コードは中央でもレース番号が範囲外の行は、パーサも raceId を null にしている
    }
  }
  return {
    date: t[S.date] as string | null,
    venue,
    weather: t[S.weather] as string | null,
    raceNumber: t[S.raceNumber] as number | null,
    raceName: t[S.raceName] as string | null,
    raceId,
    raceIdRaw,
    venueKind,
    entryCount: t[S.entryCount] as number | null,
    wakuban: t[S.wakuban] as number | null,
    umaban: t[S.umaban] as number | null,
    odds: t[S.odds] as number | null,
    ninki: t[S.ninki] as number | null,
    finishPosition: decodeFinish(t[S.finishPosition]),
    jockeyName: t[S.jockeyName] as string | null,
    jockeyId: t[S.jockeyId] as string | null,
    kinryo: t[S.kinryo] as number | null,
    courseType: t[S.courseType] as CourseType | null,
    distance: t[S.distance] as number | null,
    trackCondition: t[S.trackCondition] as string | null,
    time: t[S.time] as string | null,
    margin: t[S.margin] as number | null,
    passing: t[S.passing] as number[],
    pace: t[S.pace] as string | null,
    last3f: t[S.last3f] as number | null,
    bodyWeight,
    winnerName: t[S.winnerName] as string | null,
  };
}

/**
 * 1走の鍵(同じ馬の中で一意)。レース ID(`raceIdRaw`。中央も地方も12桁)があればそれ、無ければ(海外・リンク欠損)`'X' + 日付(YYYYMMDD)`。
 * 馬は1日に1走しかできないので、日付で衝突しない。ID も日付の形(`YYYY/MM/DD`)も無い行は null(保存しない。件数だけ数える)。
 */
export function horseRunKey(run: Pick<HorseRaceResult, "raceIdRaw" | "date">): string | null {
  if (run.raceIdRaw !== null) {
    return run.raceIdRaw;
  }
  const m = run.date === null ? null : /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(run.date);
  return m === null ? null : `X${m[1]}${m[2]}${m[3]}`;
}
