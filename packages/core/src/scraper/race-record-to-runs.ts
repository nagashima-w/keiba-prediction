/**
 * 過去の結果ページのレコード(`RaceRecord`)を、戦績 API の 1 走(`HorseRaceResult`。`encodeHorseRun` で 26 スロット)にする純関数。
 * Issue #553(#549-B2)。変換の実行と書き込みは #549-B3。
 *
 * ## 方針(ユーザー決定。#549)
 * - **列の意味をそろえる**: 同じ馬・同じレースの戦績 API の行と、スロットごとに同じ意味・同じ文字にする(実例 3 件で一致を確認している)。
 * - 騎手名(スロット 13)は **null**。結果ページは略称、戦績 API はフルネームなので、同じスロットに入れると意味が混ざる。騎手 ID(14)だけを持つ。
 * - **除外・取消の行は作らない**(戦績 API の保存も作らない)。頭数(7)からも除く。中止・失格は走っているので行を作り、頭数にも数える。
 * - スロットは足さない。調教師・性齢・クラス・払戻などは R2 の保存物に残る。
 *
 * ## 結果ページから導く項目
 * - 頭数(7): 除外・取消を除いた行数。
 * - 着差(20): 勝ち馬との時計差(0.1 秒の整数で引いてから 10 で割る)。**1 着の馬は 2 着(`finish === 2`)との時計差で、負または 0**(戦績 API の 1 着の行と同じ)。
 * - 勝ち馬名(25): 1 着馬の名前。**1 着の馬は 2 着馬の名前を括弧で包む**(`(メイショウフジタカ)`。戦績 API の国内の 1 着 17 行がすべてこの形)。
 * - ペース(22): ラップ表から(`RaceRecord.pace`)。ラップ表が無いレース(地方の多く・障害)は null。
 * - 馬場(18): 稍重→稍・不良→不(良・重はそのまま)。
 * - 開催(1): 中央は `[回次, 会場, 日目, "1函館6"]`、地方は `[null, 会場, null, 会場]`。
 * - 着順(12): 数字は数値、降着は `[順位, 1]`、非数値は**先頭 1 文字**(中止→中・失格→失)。
 * - レース名(4): 名前に、格が G1〜G3 なら `(GI)`〜`(GIII)`、Jpn1〜3 なら `(JpnI)`〜`(JpnIII)` を付ける(API の書き方)。OP・L・障害の格・地方のクラスの括弧は付けない。
 *
 * ## 戦績 API と違うところ(意図した差、または未確認)
 * - **地方の通過順(21)は空配列**。地方の結果ページに通過順の列が無い。API は 4 コーナー分を持つ。
 * - **地方のペース(22)は多くが null**。地方の結果ページにはラップ表が無いレースが多い。API は地方でもペースを返す行が多い。
 * - **地方のレース名(4)は API と一致しない行が出る**。API は `ギボウシ特別(C3)` のようにクラスの括弧を付け、`(重賞)`・`(2歳)` なども付く。結果ページの名前は書き方が違う(`夏至特別A2B1`)。
 * - **レース名の 10 文字の切り詰めはしない**。API は名前を 10 文字に切ってから格を付ける(地方の実例 `ジャパンダートクラシ(JpnI)`)。中央で 11 文字以上の名前の実例が無く、
 *   中央も同じかは未確認。
 * - 騎手名(13)は意図して null。
 *
 * ## 実例が無く、確かめられていない点
 * - 中央の 1 着の行(着差の符号・勝ち馬名の括弧)。実例は地方の 1 着 1 件だけ(`nar_result_202654071201`)。API の中央の 1 着 4 行は、結果ページのフィクスチャが無い。
 * - 着順の非数値の文字: API で観測したのは「除」だけ。中止→「中」・失格→「失」・取消→「取」は推測(結果ページの「中止」「失格」「取消」の先頭 1 文字)。
 * - 同着 1 着・降着(結果ページでの写り方が未確認。#549-A1 で保留)・障害の馬場と天候の API 側の文字・天候「小雨」の API 側の文字。
 * - 馬体重: 体重と増減がそろったときだけ `[体重, 増減]` にする。増減が読めない行(初出走の「初」など)は null にする案で、API 側の扱いは `PATTERNS.weight` からの推測。
 * - 取得できていない実例の候補(結果ページを取れば照合できる。戦績 API のフィクスチャにはある):
 *   中央の 1 着 `202308020404`・`202408040502`・`202606030706`(着差 0)・`202503020605`、
 *   地方の 1 着(グレード付き)`202444122909`(GI)・`202444100211`/`202345121311`(JpnI)・`202543100111`(JpnII)・`202330110311`(JpnIII)、
 *   地方の 1 着(馬場 重・不)`202654041208`・`202654032507`、地方の 1 着(着差 0)`202342062905`、中央の重馬場 `202609020507`。
 *
 * ## 版({@link RESULT_RUN_VERSION})
 * 結果ページ由来の行の `parser_version` に入れる値。**戦績 API の `HORSE_RUN_PARSER_VERSION` とは別の目盛り**。
 * 戦績 API の保存は、`source = 'result'` の行を版にかかわらず置き換える(戦績 API を正とする)ので、この値が大きくても置き換えは妨げられない。
 * 変換の意味(上の表)か、レコードの意味(`RACE_RECORD_PARSER_VERSION`)が変わったら上げる。
 */

import { parseRaceId } from "./ids.js";
import type { RaceRecord, RecordHorse } from "./race-record.js";
import { horseRunKey } from "./horse-run-record.js";
import type { BodyWeight, FinishPosition, HorseRaceResult, RaceVenue } from "./types.js";

/** 結果ページ由来の行の版(`horse_runs.parser_version`)。変換かレコードの意味を変えたら上げる。 */
export const RESULT_RUN_VERSION = 1;

/** 変換で得た 1 頭分。`horseId` と `raceKey` が `horse_runs` の鍵。 */
export interface ResultRun {
  readonly horseId: string;
  readonly raceKey: string;
  readonly run: HorseRaceResult;
}

export type ConvertResult =
  | {
      readonly ok: true;
      readonly runs: ResultRun[];
      /** 除外・取消で行を作らなかった数。 */
      readonly skippedNonStart: number;
      /** 馬 ID が無くて行を作れなかった数(走った馬)。 */
      readonly skippedNoHorseId: number;
    }
  | { readonly ok: false; readonly reason: string };

/** 除外・取消(走っていない)。`isNonStartResult` と同じく、先頭 1 文字で見る。 */
const NON_START = /^(除|取)/;

const GOING_ABBREVIATION: Readonly<Record<string, string>> = { 良: "良", 稍重: "稍", 重: "重", 不良: "不" };

/** 格 → レース名に付ける括弧(API の書き方)。ここに無い格(JG1〜3・L など)は付けない。 */
const GRADE_SUFFIX: Readonly<Record<string, string>> = {
  G1: "(GI)",
  G2: "(GII)",
  G3: "(GIII)",
  Jpn1: "(JpnI)",
  Jpn2: "(JpnII)",
  Jpn3: "(JpnIII)",
};

/** `1:34.5` → 945、`59.8` → 598(0.1 秒の整数)。読めなければ null。 */
function timeTenths(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const m = /^(?:(\d+):)?(\d{1,2})\.(\d)$/.exec(raw.trim());
  return m === null ? null : Number(m[1] ?? 0) * 600 + Number(m[2]) * 10 + Number(m[3]);
}

function isNonStart(h: RecordHorse): boolean {
  return h.finishStatus !== null && NON_START.test(h.finishStatus);
}

function raceNameOf(record: RaceRecord): string | null {
  if (record.name === null) {
    return null;
  }
  return record.name + (record.grade === null ? "" : (GRADE_SUFFIX[record.grade] ?? ""));
}

function venueOf(record: RaceRecord): RaceVenue | null {
  if (record.venueName === null) {
    return null;
  }
  if (record.kind === "central" && record.kai !== null && record.nichime !== null) {
    return { round: record.kai, name: record.venueName, day: record.nichime, raw: `${record.kai}${record.venueName}${record.nichime}` };
  }
  return { round: null, name: record.venueName, day: null, raw: record.venueName };
}

function finishOf(h: RecordHorse): FinishPosition | null {
  if (h.finish !== null) {
    return h.finishDemoted ? { kind: "順位", value: h.finish, demoted: true } : { kind: "順位", value: h.finish };
  }
  if (h.finishStatus !== null && h.finishStatus !== "") {
    return { kind: "非数値", text: h.finishStatus.slice(0, 1) };
  }
  return null;
}

function bodyWeightOf(h: RecordHorse): BodyWeight | null {
  return h.bodyWeight !== null && h.bodyWeightDiff !== null ? { weight: h.bodyWeight, diff: h.bodyWeightDiff } : null;
}

/**
 * 結果ページのレコード 1 レース分を、馬ごとの 1 走にする。
 * 行数が宣言の頭数(`fieldSizeDeclared`)と合わない(一部の行しか載っていないページ・宣言が読めない)レースは、
 * 頭数・着差・勝ち馬名が誤るので**変換を拒否**する(`ok: false`)。
 */
export function raceRecordToRuns(record: RaceRecord): ConvertResult {
  if (record.fieldSizeDeclared === null) {
    return { ok: false, reason: "ページの頭数の宣言が読めないので、行数が足りているか確かめられません" };
  }
  if (record.fieldSizeDeclared !== record.horses.length) {
    return { ok: false, reason: `行数(${record.horses.length})がページの頭数の宣言(${record.fieldSizeDeclared})と合いません` };
  }

  const starters = record.horses.filter((h) => !isNonStart(h));
  const entryCount = starters.length;
  const winner = record.horses.find((h) => h.finish === 1) ?? null;
  const second = record.horses.find((h) => h.finish === 2) ?? null;
  const winnerTenths = winner === null ? null : timeTenths(winner.timeRaw);
  const secondTenths = second === null ? null : timeTenths(second.timeRaw);

  const date = record.date.replace(/-/g, "/");
  const venue = venueOf(record);
  const raceName = raceNameOf(record);
  const going = record.going === null ? null : (GOING_ABBREVIATION[record.going] ?? null);
  const venueKind = record.kind === "central" ? "中央" : "地方";
  let raceId: HorseRaceResult["raceId"] = null;
  if (record.kind === "central") {
    try {
      raceId = parseRaceId(record.raceId);
    } catch {
      raceId = null;
    }
  }

  const runs: ResultRun[] = [];
  let skippedNonStart = 0;
  let skippedNoHorseId = 0;
  for (const h of record.horses) {
    if (isNonStart(h)) {
      skippedNonStart += 1;
      continue;
    }
    if (h.horseId === null) {
      skippedNoHorseId += 1;
      continue;
    }
    const isWinner = h.finish === 1;
    const own = timeTenths(h.timeRaw);
    const reference = isWinner ? secondTenths : winnerTenths;
    const margin = own !== null && reference !== null ? (own - reference) / 10 : null;
    let winnerName: string | null = null;
    if (isWinner) {
      winnerName = second === null ? null : `(${second.horseName})`;
    } else if (winner !== null) {
      winnerName = winner.horseName;
    }
    const run: HorseRaceResult = {
      date,
      venue,
      weather: record.weather,
      raceNumber: record.raceNumber,
      raceName,
      raceId,
      raceIdRaw: record.raceId,
      venueKind,
      entryCount,
      wakuban: h.wakuban,
      umaban: h.umaban,
      odds: h.winOdds,
      ninki: h.ninki,
      finishPosition: finishOf(h),
      jockeyName: null,
      jockeyId: h.jockeyId,
      kinryo: h.burden,
      courseType: record.courseType,
      distance: record.distance,
      trackCondition: going,
      time: h.timeRaw === null || h.timeRaw === "" ? null : h.timeRaw,
      margin,
      passing: [...h.passing],
      pace: record.pace,
      last3f: h.last3f,
      bodyWeight: bodyWeightOf(h),
      winnerName,
    };
    runs.push({ horseId: h.horseId, raceKey: horseRunKey(run) ?? record.raceId, run });
  }
  return { ok: true, runs, skippedNonStart, skippedNoHorseId };
}
