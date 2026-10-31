/**
 * 結果ページ 1 枚から、NDJSON の 1 行(1 レース)を作る。Issue #532。#549-A1 で `scripts/history-results/build-record.ts` から core へ移した
 * (開発用スクリプトと、本番の Cloudflare の取得〈#549-A3〉の両方から使う)。
 *
 * 既存の `parseRaceResult`(着順・通過順・後3F・人気・単勝オッズ・払戻)と、補助パーサ(`parse-result-extra.ts`)の両方で読み、
 * **行順・馬番・馬名が合うことを確かめてから**馬ごとに合成する。合わなければそのレースは「読めない」として理由つきで返す
 * (値を黙って合成しない)。ほかにも、race_id と title の食い違い(年・レース番号・地方の月日)・種別の置き場違い・文字化けを弾く。
 */

import {
  InvalidIdError,
  kaisaiDateFromNarRaceId,
  parseRaceId,
  venueKindOfRaceId,
  type RaceIdVenueKind,
} from "./ids.js";
import {
  parseRaceResult,
  RaceResultNotConfirmedError,
} from "./parse-race-result.js";
import type {
  RaceComboPayoutResult,
  RacePayoutEntry,
  RaceResult,
} from "./types.js";
import { parseResultExtra, ResultExtraError, type ExtraHeader, type ExtraRow } from "./parse-result-extra.js";

/** 中央か地方か(結果ページの置き場の区別)。race_id の場コードが示す種別と同じ型。 */
export type Kind = RaceIdVenueKind;

/**
 * 出力(`RaceRecord`)の意味を変えたら上げる版数。レコードの `parserVersion` に入る。
 * 1: #549-A1 の前(版数なし。移動前の出力)。 2: ラップ表(`lapTimes`・`lapDistances`・`pace`・`paceClass`)を足した。
 */
export const RACE_RECORD_PARSER_VERSION = 2;

/** 読めなかった理由の分類(parse の最後に件数を出す)。 */
export type RejectCategory =
  | "race_id不正"
  | "種別不一致"
  | "文字化け"
  | "構造異常"
  | "ヘッダ不足"
  | "結果未確定"
  | "日付不明"
  | "年不一致"
  | "日付不一致"
  | "レース番号不一致"
  | "race_id不一致"
  | "突き合わせ不一致"
  | "gzip失敗";

export interface RecordHorse {
  readonly umaban: number;
  readonly wakuban: number | null;
  /** 表示された着順の数字。非数値(中止・除外・取消など)は null。降着(`5(降)`)は数字を入れ、`finishDemoted` を true にする(数字の意味は読まず、生の文字は `finishRaw`)。 */
  readonly finish: number | null;
  /** 非数値の着順の文字(中止・除外・取消など)。数値なら null。 */
  readonly finishStatus: string | null;
  /**
   * 降着(`5(降)` の形。戦績 API の表記で、`parseRaceResult` がこの形を想定している)のとき true。
   * **結果ページでの降着の写り方は未確認**(#549-A1 で保留。降着のあったレースのフィクスチャが無い)。手元の過去の結果 1,254 レース
   * (16,774 頭)では 0 件だが、拾えていないのではなく降着が無かったと見ている: (1) ページ(script を除く)に「降着」「審議」
   * 「繰り上げ」「失格」「妨害」「入線」「着順変更」の語が無い、(2) `.Rank` の数字でない値は中止・除外・取消だけ、
   * (3) 着順とタイムの逆転が 0(降着があれば入線順と着順が食い違う)。実ページを取れたら、写り方を確かめて版数を上げる。
   */
  readonly finishDemoted: boolean;
  readonly finishRaw: string;
  readonly horseId: string | null;
  readonly horseName: string;
  readonly sexAgeRaw: string | null;
  readonly sex: ExtraRow["sex"];
  readonly age: number | null;
  readonly burden: number | null;
  readonly jockeyId: string | null;
  readonly jockeyName: string | null;
  readonly jockeyMark: string | null;
  readonly timeRaw: string | null;
  readonly timeSec: number | null;
  readonly marginRaw: string | null;
  readonly ninki: number | null;
  readonly winOdds: number | null;
  readonly last3f: number | null;
  /** コーナー通過順。地方は列が無いので空配列。 */
  readonly passing: readonly number[];
  readonly trainerId: string | null;
  readonly trainerName: string | null;
  readonly trainerArea: string | null;
  readonly bodyWeight: number | null;
  readonly bodyWeightRaw: string | null;
  readonly bodyWeightDiff: number | null;
  readonly bodyWeightDiffRaw: string | null;
  readonly cellsAligned: boolean;
}

export interface RacePayouts {
  readonly win: RacePayoutEntry[];
  readonly place: RacePayoutEntry[];
  readonly wide: RaceComboPayoutResult;
  readonly trio: RaceComboPayoutResult;
  readonly quinella: RaceComboPayoutResult;
  readonly exacta: RaceComboPayoutResult;
  readonly trifecta: RaceComboPayoutResult;
  readonly bracketQuinella: RaceComboPayoutResult;
}

export interface RaceRecord extends Omit<ExtraHeader, "date" | "venueName" | "raceNumber"> {
  /** 読み取りの版数({@link RACE_RECORD_PARSER_VERSION})。 */
  readonly parserVersion: number;
  readonly kind: Kind;
  readonly raceId: string;
  /** `YYYY-MM-DD` */
  readonly date: string;
  readonly venueCode: string;
  readonly venueName: string | null;
  readonly raceNumber: number;
  /** この行で既存パーサの読めなかった列(ヘッダに無かったもの)。 */
  readonly missingColumns: readonly string[];
  readonly horses: RecordHorse[];
  readonly payouts: RacePayouts;
}

export type BuildResult =
  | { readonly ok: true; readonly record: RaceRecord }
  | { readonly ok: false; readonly category: RejectCategory; readonly detail: string };

const reject = (category: RejectCategory, detail: string): BuildResult => ({ ok: false, category, detail });

/** 払戻の欄が既存パーサの戻りに無かったとき(常には起きない)の代わりの値。 */
const ABSENT: RaceComboPayoutResult = {
  state: "undetermined",
  reason: { kind: "payoutTableAbsent", message: "既存パーサが払戻の欄を返さなかった", observedGroupCount: null, observedPayoutCount: null, rawHtml: null },
};

/**
 * 既存パーサの馬の並びと補助パーサの行の並びを突き合わせる。そろっていれば null、食い違いがあれば理由。
 * 補助パーサの馬番が null(行の列がずれていて位置で読めなかった)の行は、馬名だけで照合する。
 */
export function crossCheckRows(core: RaceResult["horses"], extra: readonly ExtraRow[]): string | null {
  if (core.length !== extra.length) {
    return `行数が違います(既存パーサ ${core.length} 行・補助パーサ ${extra.length} 行)`;
  }
  for (let i = 0; i < core.length; i++) {
    const c = core[i]!;
    const e = extra[i]!;
    if (e.umaban !== null && e.umaban !== c.umaban) {
      return `${i + 1} 行目の馬番が違います(既存パーサ ${c.umaban}・補助パーサ ${e.umaban})`;
    }
    if (e.horseName !== c.horseName) {
      return `${i + 1} 行目の馬名が違います(既存パーサ「${c.horseName}」・補助パーサ「${e.horseName ?? "null"}」)`;
    }
  }
  return null;
}

/**
 * 結果ページの HTML から 1 レースの行を作る。
 * @param raceId race_id(12 桁)
 * @param kind 置き場(raw/ か raw/nar/ か)。race_id の場コードが示す種別と合わなければ拒否する
 */
export function buildRaceRecord(html: string, raceId: string, kind: Kind): BuildResult {
  let parsedId;
  try {
    parsedId = parseRaceId(raceId);
  } catch (e) {
    if (e instanceof InvalidIdError) {
      return reject("race_id不正", e.message);
    }
    throw e;
  }
  if (venueKindOfRaceId(parsedId) !== kind) {
    return reject("種別不一致", `race_id ${raceId} は ${venueKindOfRaceId(parsedId)} の場コードですが、置き場は ${kind} です`);
  }
  if (html.includes("�")) {
    return reject("文字化け", "ページに U+FFFD(置換文字)が含まれています");
  }

  let core: RaceResult;
  try {
    core = parseRaceResult(html);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return e instanceof RaceResultNotConfirmedError ? reject("結果未確定", msg) : reject("構造異常", msg);
  }

  let extra;
  try {
    extra = parseResultExtra(html, kind);
  } catch (e) {
    if (e instanceof ResultExtraError) {
      return reject(e.category, e.message);
    }
    throw e;
  }

  const h = extra.header;
  if (h.date === null) {
    return reject("日付不明", "title から日付(YYYY年M月D日)を読めませんでした");
  }
  if (h.date.slice(0, 4) !== raceId.slice(0, 4)) {
    return reject("年不一致", `race_id の年 ${raceId.slice(0, 4)} と title の日付 ${h.date} の年が違います`);
  }
  if (kind === "nar") {
    const fromId = kaisaiDateFromNarRaceId(raceId);
    const fromTitle = h.date.replace(/-/g, "");
    if (fromId === null || fromId !== fromTitle) {
      return reject("日付不一致", `race_id から導いた開催日 ${fromId ?? "null"} と title の日付 ${fromTitle} が違います`);
    }
  }
  const idRaceNumber = Number(raceId.slice(10, 12));
  if (h.raceNumber === null || h.raceNumber !== idRaceNumber) {
    return reject("レース番号不一致", `race_id のレース番号 ${idRaceNumber} と title のレース番号 ${h.raceNumber ?? "null"} が違います`);
  }

  // ページ自身が名乗る race_id(canonical)と、中央の回次・日次(race_id の 7〜10 桁目)。別のレースのページが
  // 紛れ込んでも、年とレース番号が偶然合うことがあるので、さらに確かめる。
  if (h.canonicalRaceId !== null && h.canonicalRaceId !== raceId) {
    return reject("race_id不一致", `ページの canonical の race_id ${h.canonicalRaceId} と、ファイルの race_id ${raceId} が違います`);
  }
  if (kind === "central") {
    const idKai = Number(raceId.slice(6, 8));
    const idNichime = Number(raceId.slice(8, 10));
    if ((h.kai !== null && h.kai !== idKai) || (h.nichime !== null && h.nichime !== idNichime)) {
      return reject("race_id不一致", `race_id の回次・日次 ${idKai}回${idNichime}日目 と、ページの ${h.kai ?? "?"}回${h.nichime ?? "?"}日目 が違います`);
    }
  }

  const mismatch = crossCheckRows(core.horses, extra.rows);
  if (mismatch !== null) {
    return reject("突き合わせ不一致", mismatch);
  }

  const horses: RecordHorse[] = core.horses.map((c, i) => {
    const e = extra.rows[i]!;
    const fp = c.finishPosition;
    return {
      umaban: c.umaban,
      wakuban: c.wakuban,
      finish: fp !== null && fp.kind === "順位" ? fp.value : null,
      finishStatus: fp !== null && fp.kind === "非数値" ? fp.text : null,
      finishDemoted: fp !== null && fp.kind === "順位" && fp.demoted === true,
      finishRaw: e.finishRaw,
      horseId: e.horseId,
      horseName: c.horseName,
      sexAgeRaw: e.sexAgeRaw,
      sex: e.sex,
      age: e.age,
      burden: e.burden,
      jockeyId: e.jockeyId,
      jockeyName: e.jockeyName,
      jockeyMark: e.jockeyMark,
      timeRaw: e.timeRaw,
      timeSec: e.timeSec,
      marginRaw: e.marginRaw,
      ninki: c.ninki ?? null,
      winOdds: c.winOdds ?? null,
      last3f: c.last3f,
      passing: c.passing,
      trainerId: e.trainerId,
      trainerName: e.trainerName,
      trainerArea: e.trainerArea,
      bodyWeight: e.bodyWeight,
      bodyWeightRaw: e.bodyWeightRaw,
      bodyWeightDiff: e.bodyWeightDiff,
      bodyWeightDiffRaw: e.bodyWeightDiffRaw,
      cellsAligned: e.cellsAligned,
    };
  });

  const { date, venueName, raceNumber: _rn, ...restHeader } = h;
  return {
    ok: true,
    record: {
      parserVersion: RACE_RECORD_PARSER_VERSION,
      kind,
      raceId,
      date,
      venueCode: raceId.slice(4, 6),
      venueName,
      raceNumber: idRaceNumber,
      ...restHeader,
      missingColumns: extra.missingColumns,
      horses,
      payouts: {
        win: core.winPayouts,
        place: core.placePayouts,
        wide: core.widePayouts ?? ABSENT,
        trio: core.trioPayouts ?? ABSENT,
        quinella: core.quinellaPayouts ?? ABSENT,
        exacta: core.exactaPayouts ?? ABSENT,
        trifecta: core.trifectaPayouts ?? ABSENT,
        bracketQuinella: core.bracketQuinellaPayouts ?? ABSENT,
      },
    },
  };
}
