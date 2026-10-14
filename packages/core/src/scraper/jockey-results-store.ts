/**
 * 騎手の年ごとの成績(`parseJockeyResults` の出力)を、**日をまたいで共有する保存先**の契約(Issue #226。ユーザー決定 2026-10-11:
 * 騎手の成績の更新は週に 1 回で十分)。
 *
 * クラウド版は D1(`cloud/src/jockey-results-repository.ts`)で実装する。core は保存先の実体を知らない(関数注入。
 * `ScrapeDeps.jockeyStore`)。取得物のキャッシュ(`RaceFetcher`。クラウド版は開催日ごとの DO の SQLite)は日をまたいで再利用されない
 * ので、TTL をいくつにしても毎日取り直してしまう。そこで、パース後の小さな値だけをここに置く(生の HTML は置かない)。
 *
 * `scrapeRace` は、取得の前に `loadMany` で読み、取得日時から `ttl.jockeyMs`(既定 7 日)以内ならその値を使って netkeiba に出ない。
 * 超えた・無いものだけを取得し、取得したぶんを `saveMany` で**まとめて 1 回**保存する(1 回の `scrapeRace` あたり読み 1・書き 1。
 * D1 の「1 回の呼び出しあたりのクエリ数」を食わない)。読み書きの失敗は投げずに取得へフォールバックする(分析は止めない)。
 */

import type { RaceIdVenueKind } from "./ids.js";
import type { JockeyYearRecord } from "./parse-jockey-results.js";

/** 保存済みの騎手 1 人分(中央・地方の別は呼び出しの `kind` で決まる)。 */
export interface StoredJockeyResults {
  /** 取得した時刻(エポックミリ秒)。 */
  readonly fetchedAtMs: number;
  /** 年ごとの成績(新しい年が先)。中央の成績が無い騎手は空配列(「取得したが行が無い」。未取得とは別)。 */
  readonly years: readonly JockeyYearRecord[];
}

/** 保存する 1 人分。 */
export interface JockeyResultsSaveEntry {
  readonly jockeyId: string;
  readonly years: readonly JockeyYearRecord[];
  readonly fetchedAtMs: number;
}

export interface JockeyResultsStore {
  /**
   * 騎手 ID と開催区分(中央/地方)で読む。保存の無い騎手は結果に入れない。
   * 古さ(取得日時)の判定は呼び出し側が行う(許容鮮度は呼び出しごとに違う: 取得ステップは 7 日、計算ステップは実質無期限)。
   */
  loadMany(jockeyIds: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredJockeyResults>>;
  /** 騎手 ID と開催区分で上書き保存する(取得日時も更新する)。 */
  saveMany(kind: RaceIdVenueKind, entries: readonly JockeyResultsSaveEntry[]): Promise<void>;
}
