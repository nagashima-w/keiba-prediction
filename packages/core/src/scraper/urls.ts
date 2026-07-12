/**
 * netkeibaの各対象ページのURL構築を1ファイルに集約する。
 *
 * セレクタと同様、URL(パス・クエリ形式)もサイト構造変更の影響を受けるため、
 * 変更点を1箇所に閉じ込める。各関数は検証済みID型のみを受け取り、
 * 未検証文字列からのURL生成をコンパイル時に防ぐ。
 *
 * 対応表: docs/phase1-scraping-plan.md「対象ページとURL一覧」
 */

import type { HorseId, KaisaiDate, RaceId } from "./ids.js";
import { venueKindOfRaceId } from "./ids.js";

/** race.netkeiba.com のベースURL(PC版・中央レースページ群)。 */
const RACE_BASE = "https://race.netkeiba.com";

/** nar.netkeiba.com のベースURL(地方競馬のレースページ群)。 */
const NAR_BASE = "https://nar.netkeiba.com";

/** db.netkeiba.com のベースURL(馬・騎手等の個別データベースページ群。中央・地方共通)。 */
const DB_BASE = "https://db.netkeiba.com";

/**
 * race_idの場コードから、レースページのベースURL(中央/地方)を選択する。
 * 出馬表・レース結果は中央・地方でパスが同一で、ドメインのみが異なるため共通化する。
 * 詳細: docs/nar-scraping-plan.md「結論サマリ」。
 */
function raceBaseFor(raceId: RaceId): string {
  return venueKindOfRaceId(raceId) === "nar" ? NAR_BASE : RACE_BASE;
}

/**
 * 地方(NAR)では存在しないページのURLを要求されたことを表す例外。
 * 調教(oikiri)・厩舎コメント(comment)は nar.netkeiba.com にページ自体が存在しない
 * (実測: 404。詳細 docs/nar-scraping-plan.md)。
 */
export class NarUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarUnsupportedError";
  }
}

/** raceId が地方の場合、指定機能名を含む NarUnsupportedError を投げる。 */
function assertCentral(raceId: RaceId, featureName: string): void {
  if (venueKindOfRaceId(raceId) === "nar") {
    throw new NarUnsupportedError(
      `${featureName}は地方競馬(nar.netkeiba.com)には存在しないページです(race_id: "${raceId}")`,
    );
  }
}

/**
 * レース一覧サブHTML(開催日→race_id列挙用、中央)のURL。
 * race_list.html はJS描画のため、フラグメントを返すサブHTML側を第一候補とする。
 */
export function raceListSubUrl(kaisaiDate: KaisaiDate): string {
  return `${RACE_BASE}/top/race_list_sub.html?kaisai_date=${kaisaiDate}`;
}

/**
 * レース一覧サブHTML(開催日→race_id列挙用、地方)のURL。
 * 中央と同一パス・同一構造で、ドメインのみが異なる(実測: docs/nar-scraping-plan.md)。
 */
export function narRaceListSubUrl(kaisaiDate: KaisaiDate): string {
  return `${NAR_BASE}/top/race_list_sub.html?kaisai_date=${kaisaiDate}`;
}

/**
 * 出馬表ページのURL(スクレイピングの正式ルート)。
 * race_idの場コードに応じて race.netkeiba.com / nar.netkeiba.com を自動選択する
 * (中央・地方でパスは同一)。
 *
 * 仕様書は起点に newspaper.html を挙げていたが、実測(2026-07-05)で newspaper 系は
 * Riot.js のクライアントサイド描画であり静的HTMLに出馬表が含まれないと判明したため不採用。
 * shutuba.html は枠・馬番・馬名+horse_id・性齢・斤量・騎手+jockey_id・厩舎所在地+trainer_id・
 * 馬体重(増減)がすべて静的に含まれる(オッズ列のみJSプレースホルダ)。
 * 詳細: docs/phase1-scraping-plan.md「newspaper.html を不採用にした理由」。
 */
export function shutubaUrl(raceId: RaceId): string {
  return `${raceBaseFor(raceId)}/race/shutuba.html?race_id=${raceId}`;
}

/**
 * 追い切り(調教)ページのURL(中央のみ)。
 * 実測(2026-07-05)でこのURLに一致することを確認済み。
 * 無料範囲では調教評価テキスト(td.Training_Critic)と評価ランクが取得できる
 * (タイム・ラップはプレミアム領域のためスキーマ上optional)。
 *
 * 地方(NAR)にはページ自体が存在しない(実測404。docs/nar-scraping-plan.md)ため、
 * 地方race_idを渡すと NarUnsupportedError を投げる。
 */
export function oikiriUrl(raceId: RaceId): string {
  assertCentral(raceId, "調教(oikiri)ページ");
  return `${RACE_BASE}/race/oikiri.html?race_id=${raceId}`;
}

/**
 * 厩舎コメントページのURL(中央のみ)。
 * 実測(2026-07-05)でこのURLに一致することを確認済み。
 * ただしコメント本文はプレミアム限定で、無料範囲では取得できない(スキーマ上optional)。
 *
 * 地方(NAR)にはページ自体が存在しない(実測404。docs/nar-scraping-plan.md)ため、
 * 地方race_idを渡すと NarUnsupportedError を投げる。
 */
export function commentUrl(raceId: RaceId): string {
  assertCentral(raceId, "厩舎コメントページ");
  return `${RACE_BASE}/race/comment.html?race_id=${raceId}`;
}

/** 馬個別ページ(プロフィール)のURL。末尾スラッシュはnetkeibaの正規形に合わせる。 */
export function horseUrl(horseId: HorseId): string {
  return `${DB_BASE}/horse/${horseId}/`;
}

/**
 * 各馬の全戦績を返す内部API(JSON)のURL。
 *
 * 馬個別ページ本体の戦績テーブルはAjaxで遅延描画されるため、このAPIを直接叩く。
 * レスポンスは `{status:"OK", data:"<HTMLフラグメント>"}` で、data内に全戦績テーブルが入る。
 */
export function horseResultsApiUrl(horseId: HorseId): string {
  return `${DB_BASE}/horse/ajax_horse_results.html?input=UTF-8&output=json&id=${horseId}`;
}

/**
 * 単勝・複勝オッズを返す内部API(JSON、中央のみ)。
 *
 * `data.odds["1"]` が単勝、`data.odds["2"]` が複勝(下限/上限)で、複勝下限が直接取れる。
 * 発走直前の再取得にも同一エンドポイントを使う。
 *
 * 地方(NAR)には同等のJSON APIが存在しない(実測404。docs/nar-scraping-plan.md「オッズの取得方式」)ため、
 * 地方race_idを渡すと NarUnsupportedError を投げる(地方は narOddsPageUrl を使うこと)。
 */
export function oddsApiUrl(raceId: RaceId): string {
  assertCentral(raceId, "単勝・複勝オッズJSON API(api_get_jra_odds)");
  return `${RACE_BASE}/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init`;
}

/**
 * レース結果ページのURL。
 * race_idの場コードに応じて race.netkeiba.com / nar.netkeiba.com を自動選択する
 * (中央・地方でパスは同一)。
 * 全着順(着順・馬番・馬名)と確定払戻(単勝・複勝ほか)が静的HTMLに含まれる
 * (発走後に確定するため、未確定レースでは払戻テーブルが欠ける)。verify(実配当)の入力に用いる。
 */
export function raceResultUrl(raceId: RaceId): string {
  return `${raceBaseFor(raceId)}/race/result.html?race_id=${raceId}`;
}

/**
 * 単勝・複勝オッズページのURL(地方のみ)。
 *
 * 中央と異なりJSON APIが存在しない(実測404)ため、静的HTML(odds/index.html?type=b1)を
 * parseNarOdds でパースする方式を取る。詳細: docs/nar-scraping-plan.md「オッズの取得方式」。
 */
export function narOddsPageUrl(raceId: RaceId): string {
  return `${NAR_BASE}/odds/index.html?type=b1&race_id=${raceId}`;
}
