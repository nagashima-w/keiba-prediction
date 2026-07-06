/**
 * スクレイパのパース結果として得られるドメイン型。
 *
 * これらは今後 scorer(期待値計算)が参照する中心データ構造になるため、
 * 1ファイルに明確に定義して index.ts から公開する。
 */

import type { HorseId, RaceId } from "./ids.js";

/** コース種別。芝・ダート・障害の3種。 */
export type CourseType = "芝" | "ダ" | "障";

/** 厩舎所在地(トレセン)。 */
export type StableLocation = "美浦" | "栗東";

/**
 * レース一覧サブHTML(race_list_sub)から得られる1レース分の要約。
 * 注: レース名(name)はサーバ側で切り詰められている場合がある(full名は出馬表から取る)。
 */
export interface RaceListEntry {
  /** レースID(12桁)。 */
  readonly raceId: RaceId;
  /** レース名(切り詰められている場合あり)。 */
  readonly name: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 距離(メートル)。 */
  readonly distance: number;
  /** 出走頭数。 */
  readonly entryCount: number;
  /** 会場名(福島・小倉など)。取得できない構造では未定義。 */
  readonly venue?: string;
  /** レース番号(1〜12)。 */
  readonly raceNumber: number;
}

/** 馬体重とその増減(前走比)。未発表の場合は null で表す。 */
export interface BodyWeight {
  /** 馬体重(kg)。 */
  readonly weight: number;
  /** 前走からの増減(kg)。増は正、減は負、変わらずは0。 */
  readonly diff: number;
}

/** 出馬表の各出走馬。 */
export interface ShutubaHorse {
  /** 枠番(1〜8)。 */
  readonly wakuban: number;
  /** 馬番(1〜18)。 */
  readonly umaban: number;
  /** 馬名。 */
  readonly name: string;
  /** 馬ID(10桁)。 */
  readonly horseId: HorseId;
  /** 性別(牡/牝/セ)。 */
  readonly sex: string;
  /** 年齢。 */
  readonly age: number;
  /** 斤量(kg)。 */
  readonly kinryo: number;
  /** 騎手名。 */
  readonly jockeyName: string;
  /** 騎手ID。騎手未定・リンク欠損などで抽出できない場合は null。 */
  readonly jockeyId: string | null;
  /** 厩舎所在地(美浦/栗東)。 */
  readonly stableLocation: StableLocation;
  /** 調教師名。 */
  readonly trainerName: string;
  /** 調教師ID。リンク欠損などで抽出できない場合は null。 */
  readonly trainerId: string | null;
  /** 馬体重(増減)。未発表の場合は null。 */
  readonly bodyWeight: BodyWeight | null;
}

/** 出馬表ページ上部のレース情報。 */
export interface ShutubaRaceInfo {
  /** レース名。 */
  readonly raceName: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 距離(メートル)。 */
  readonly distance: number;
  /** 発走時刻(HH:MM)。取得できない場合は未定義。 */
  readonly startTime?: string;
  /** 天候。取得できない場合は未定義。 */
  readonly weather?: string;
  /** 馬場状態。取得できない場合は未定義。 */
  readonly trackCondition?: string;
}

/** 出馬表のパース結果(レース情報+出走馬)。 */
export interface Shutuba {
  /** レース情報。 */
  readonly race: ShutubaRaceInfo;
  /** 出走馬(馬番昇順にソート済み)。 */
  readonly horses: ShutubaHorse[];
}
