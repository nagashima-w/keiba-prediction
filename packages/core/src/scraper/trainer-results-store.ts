/**
 * 調教師の年ごとの成績(`parseJockeyResults` の出力)を、**日をまたいで共有する保存先**の契約(Issue #354)。
 * 騎手の `JockeyResultsStore`(#226)と同じ形で、調教師 ID の番号体系は騎手と別なので表も別(クラウド版は D1 の `trainer_results`)。
 *
 * 騎手との違いは鮮度の判定だけ: 騎手は取得日時から 7 日以内、調教師は**取得日時がレースの年の 1 月 1 日(JST)以降**なら使う
 * (`scrapeRace`。前2年の行は確定値なので年に 1 回の取得で足りる)。判定は呼び出し側が行い、ここは取得日時を返すだけ。
 * `scrapeRace` は取得の前に `loadMany` で読み、取得したぶんを `saveMany` で**まとめて 1 回**保存する。読み書きの失敗は投げずに取得へフォールバックする。
 */

import type { RaceIdVenueKind } from "./ids.js";
import type { JockeyYearRecord } from "./parse-jockey-results.js";

/** 保存済みの調教師 1 人分。 */
export interface StoredTrainerResults {
  /** 取得した時刻(エポックミリ秒)。 */
  readonly fetchedAtMs: number;
  /** 年ごとの成績(新しい年が先)。成績の行が無い調教師は空配列(「取得したが行が無い」。未取得とは別)。 */
  readonly years: readonly JockeyYearRecord[];
}

/** 保存する 1 人分。 */
export interface TrainerResultsSaveEntry {
  readonly trainerId: string;
  readonly years: readonly JockeyYearRecord[];
  readonly fetchedAtMs: number;
}

export interface TrainerResultsStore {
  /** 調教師 ID と開催区分(中央/地方)で読む。保存の無い調教師は結果に入れない。古さの判定は呼び出し側が行う。 */
  loadMany(trainerIds: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredTrainerResults>>;
  /** 調教師 ID と開催区分で上書き保存する(取得日時も更新する)。 */
  saveMany(kind: RaceIdVenueKind, entries: readonly TrainerResultsSaveEntry[]): Promise<void>;
}
