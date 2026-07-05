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

/** 競馬新聞ページ(出馬表+各馬過去走+horse_idリンク)のURL。 */
export function newspaperUrl(raceId: RaceId): string {
  return `${RACE_BASE}/race/newspaper.html?race_id=${raceId}`;
}

/**
 * 追い切り(調教)ページの候補URL。
 * 注意: 仕様書は `?pid=oikiri` 相当と記載するが、実URLは調査未了。
 * 現時点は計画書(docs/phase1-scraping-plan.md #3)の候補URLで実装しており、
 * ネットワーク解除後の構造調査で確定・修正すること。
 */
export function oikiriUrl(raceId: RaceId): string {
  return `${RACE_BASE}/race/oikiri.html?race_id=${raceId}`;
}

/**
 * 厩舎コメントページの候補URL。
 * 注意: 仕様書は `?pid=comment` 相当と記載するが、実URLは調査未了。
 * 現時点は計画書(docs/phase1-scraping-plan.md #4)の候補URLで実装しており、
 * ネットワーク解除後の構造調査で確定・修正すること。
 */
export function commentUrl(raceId: RaceId): string {
  return `${RACE_BASE}/race/comment.html?race_id=${raceId}`;
}

/** 馬個別ページ(全戦績)のURL。末尾スラッシュはnetkeibaの正規形に合わせる。 */
export function horseUrl(horseId: HorseId): string {
  return `${DB_BASE}/horse/${horseId}/`;
}
