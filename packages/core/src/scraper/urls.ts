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
 * 過去10年結果・優勝馬API(AplGradeWinner、タスク機能B)の固定URL。
 * race_idはURLではなくPOSTボディに含めるが、ホスト(中央/地方)はrace_idの場コードで選択する。
 *
 * 2026-07-28 実測訂正: 当初「地方(NAR)にはこのAPI相当が存在しない」と判断していたが、これは
 * 中央ホスト(race.netkeiba.com)に地方race_idを投げていたための誤りだった。正しくは地方専用の
 * nar.netkeiba.comに同一パラメータでPOSTすればよく、パラメータ・レスポンス形式(zlib+base64)は
 * 中央と完全に同一(2026-07-28 boss着手前ゲート合意の訂正を反映)。
 */
export function gradeWinnerApiUrl(raceId: RaceId): string {
  return `${raceBaseFor(raceId)}/race_api/`;
}

/**
 * 過去10年結果・優勝馬APIのReferer。
 * 中央はpast10.html、地方はpast5.htmlとページ名が異なる点に注意(いずれも実際には過去10年分を返す。
 * ページ名の「5」は地方側の表示件数を指すものではなく、単にURLパスが異なるだけ)。
 */
export function gradeWinnerRefererUrl(raceId: RaceId): string {
  const page = venueKindOfRaceId(raceId) === "nar" ? "past5.html" : "past10.html";
  return `${raceBaseFor(raceId)}/race/${page}?race_id=${raceId}`;
}

/** 過去10年結果・優勝馬APIのOrigin(ホストのみ。中央/地方でgradeWinnerApiUrlと同じホストを返す)。 */
export function gradeWinnerOriginUrl(raceId: RaceId): string {
  return raceBaseFor(raceId);
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

/**
 * ワイドオッズを返す内部API(JSON、中央のみ、機能D-1)。
 *
 * `data.odds["5"]` に馬番ペア(4桁。例 "0102")をキーとした [下限,上限,人気] が入る。
 * 実測(2026-08-04, race_id=202603020211・16頭)で1リクエストにC(16,2)=120件全組合せが
 * 返ることを確認済み(組合せ集合が期待値と完全一致)。既存の単勝・複勝API(oddsApiUrl)と
 * 同一エンドポイント(api_get_jra_odds.html)の type クエリのみが異なる
 * (type=1: 単勝複勝, type=5: ワイド)。type値は中央のオッズページのタブJS
 * (odds_get_form.html?type=b5 のフラグメント内 `oddsType:'5'`)から独立に観測した。
 *
 * 地方(NAR)には同等のJSON APIが存在しない(oddsApiUrlと同じ理由。docs/nar-scraping-plan.md)ため、
 * 地方race_idを渡すと NarUnsupportedError を投げる(地方は narWideOddsPageUrl を使うこと)。
 */
export function wideOddsApiUrl(raceId: RaceId): string {
  assertCentral(raceId, "ワイドオッズJSON API(api_get_jra_odds、type=5)");
  return `${RACE_BASE}/api/api_get_jra_odds.html?race_id=${raceId}&type=5&action=init`;
}

/**
 * 3連複オッズを返す内部API(JSON、中央のみ、機能D-1)。
 *
 * `data.odds["7"]` に馬番トリオ(6桁。例 "010203")をキーとした配列が入るが、
 * 単勝と同様に2要素目は常に"0.0"のダミーで、3連複は下限・上限を持たない単一値
 * (1要素目がオッズ、3要素目が人気)。実測(2026-08-04, race_id=202603020211・16頭)で
 * 1リクエストにC(16,3)=560件全組合せが返ることを確認済み(組合せ集合が期待値と完全一致)。
 * type値の観測方法は wideOddsApiUrl と同じ(odds_get_form.html?type=b7 フラグメント内
 * `oddsType:'7'`)。
 *
 * 地方(NAR)には同等のJSON APIが存在しない(oddsApiUrlと同じ理由)ため、
 * 地方race_idを渡すと NarUnsupportedError を投げる(地方は narTrioOddsPageUrl を使うこと)。
 */
export function trioOddsApiUrl(raceId: RaceId): string {
  assertCentral(raceId, "3連複オッズJSON API(api_get_jra_odds、type=7)");
  return `${RACE_BASE}/api/api_get_jra_odds.html?race_id=${raceId}&type=7&action=init`;
}

/**
 * ワイドオッズページのURL(地方のみ、機能D-1)。
 *
 * 中央と異なりJSON APIが存在しないため、静的HTML(odds/index.html?type=b5)をパースする
 * 方式を取る(narOddsPageUrlと同じ理由)。実測(2026-08-04, race_id=202654071210・12頭)で、
 * 1ページに全軸のテーブルが含まれ、C(12,2)=66件全組合せが1リクエストで取得できることを
 * 確認済み(軸馬別の制限を受けない。3連複〈narTrioOddsPageUrl〉とは挙動が異なる点に注意)。
 */
export function narWideOddsPageUrl(raceId: RaceId): string {
  return `${NAR_BASE}/odds/index.html?type=b5&race_id=${raceId}`;
}

/**
 * 3連複オッズページのURL(地方のみ、機能D-1)。
 *
 * 静的HTML(odds/index.html?type=b7)をパースする方式を取る(narOddsPageUrlと同じ理由)。
 *
 * 実測(2026-08-04, race_id=202654071210・12頭)での重要な制約: このURL(軸馬クエリ
 * `jiku` 未指定)は「軸馬1固定」のC(11,2)=55件(=全組合せC(12,3)=220件の一部)しか
 * 返さない(地方の3連複は軸馬別取得。中央〈trioOddsApiUrl〉が1リクエストで全組合せを
 * 返すのとは異なる)。ページ内のJS(`view_3odds_normal`)は
 * `../odds/odds_get_form.html?type=b7&race_id=...&jiku=<軸馬番>` のAJAX GETで軸を
 * 切り替えている。軸2(`jiku=2`)の応答を実測したところ「馬02を含む全トリオ」C(11,2)=55件と
 * 完全一致し(`nar_odds_b7_jiku2_202654071210.html`)、「馬02を最小とするトリオのみ」
 * C(10,2)=45件という対抗仮説は棄却された(=`jiku=k`はkを含む全トリオを返す。詳細:
 * docs/wide-trio-odds-investigation.md §3.2)。この性質から、軸1〜(頭数-2)を叩けば
 * 全組合せC(n,3)を漏れなく網羅できる(**導出値**。3頭の組合せの最小馬番は必ず頭数-2以下に
 * なるため)。ただし実物の軸馬選択プルダウン(`#list_select_horse`)自体は**軸1〜頭数の
 * 全頭(観測値)**を選択肢として提示しており、`頭数-2`はサイトが提示する値ではない
 * (両者を混同しないこと)。全軸を機械的に走査する挙動を本関数には持たせていない
 * (機能Dへの備え。#14着手前ゲートで方針を判断する。詳細: docs/wide-trio-odds-investigation.md)。
 */
export function narTrioOddsPageUrl(raceId: RaceId): string {
  return `${NAR_BASE}/odds/index.html?type=b7&race_id=${raceId}`;
}
