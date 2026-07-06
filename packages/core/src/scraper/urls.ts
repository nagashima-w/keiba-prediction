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

/** race.netkeiba.com のベースURL(PC版レースページ群)。 */
const RACE_BASE = "https://race.netkeiba.com";

/** db.netkeiba.com のベースURL(馬・騎手等の個別データベースページ群)。 */
const DB_BASE = "https://db.netkeiba.com";

/**
 * レース一覧サブHTML(開催日→race_id列挙用)のURL。
 * race_list.html はJS描画のため、フラグメントを返すサブHTML側を第一候補とする。
 */
export function raceListSubUrl(kaisaiDate: KaisaiDate): string {
  return `${RACE_BASE}/top/race_list_sub.html?kaisai_date=${kaisaiDate}`;
}

/**
 * 出馬表ページのURL(スクレイピングの正式ルート)。
 *
 * 仕様書は起点に newspaper.html を挙げていたが、実測(2026-07-05)で newspaper 系は
 * Riot.js のクライアントサイド描画であり静的HTMLに出馬表が含まれないと判明したため不採用。
 * shutuba.html は枠・馬番・馬名+horse_id・性齢・斤量・騎手+jockey_id・厩舎所在地+trainer_id・
 * 馬体重(増減)がすべて静的に含まれる(オッズ列のみJSプレースホルダ)。
 * 詳細: docs/phase1-scraping-plan.md「newspaper.html を不採用にした理由」。
 */
export function shutubaUrl(raceId: RaceId): string {
  return `${RACE_BASE}/race/shutuba.html?race_id=${raceId}`;
}

/**
 * 追い切り(調教)ページのURL。
 * 実測(2026-07-05)でこのURLに一致することを確認済み。
 * 無料範囲では調教評価テキスト(td.Training_Critic)と評価ランクが取得できる
 * (タイム・ラップはプレミアム領域のためスキーマ上optional)。
 */
export function oikiriUrl(raceId: RaceId): string {
  return `${RACE_BASE}/race/oikiri.html?race_id=${raceId}`;
}

/**
 * 厩舎コメントページのURL。
 * 実測(2026-07-05)でこのURLに一致することを確認済み。
 * ただしコメント本文はプレミアム限定で、無料範囲では取得できない(スキーマ上optional)。
 */
export function commentUrl(raceId: RaceId): string {
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
 * 単勝・複勝オッズを返す内部API(JSON)のURL。
 *
 * `data.odds["1"]` が単勝、`data.odds["2"]` が複勝(下限/上限)で、複勝下限が直接取れる。
 * 発走直前の再取得にも同一エンドポイントを使う。
 */
export function oddsApiUrl(raceId: RaceId): string {
  return `${RACE_BASE}/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init`;
}
