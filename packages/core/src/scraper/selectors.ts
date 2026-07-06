/**
 * netkeibaのHTML構造に依存するCSSセレクタ・正規表現を1ファイルに集約する。
 *
 * 仕様の必須制約: 出馬表・レース一覧のセレクタはすべてここに定数として置き、
 * パーサーはこれを参照する。サイトの構造変更時の修正箇所を1箇所に閉じ込めるため。
 *
 * セレクタメモの出所: docs/phase1-scraping-plan.md「出馬表(shutuba.html)の主要セレクタメモ」。
 */

/** レース一覧サブHTML(race_list_sub)のセレクタ。 */
export const RACE_LIST_SELECTORS = {
  /** 会場ごとのグループ(dl)。 */
  group: "dl.RaceList_DataList",
  /** グループ見出し内の会場タイトル(例: <small>2回</small> 福島 <small>2日目</small>)。 */
  groupTitle: "p.RaceList_DataTitle",
  /** 1レース分の項目(li)。 */
  item: "li.RaceList_DataItem",
  /** レースID を含むリンク(race_id クエリ付き)。 */
  itemLink: 'a[href*="race_id="]',
  /** レース番号(例: 11R)。 */
  raceNumber: ".Race_Num",
  /** レース名(切り詰められている場合あり)。 */
  itemTitle: ".ItemTitle",
  /** 時刻・距離・頭数を含むデータ枠。 */
  raceData: ".RaceData",
  /** 頭数(例: 16頭)。 */
  entryCount: ".RaceList_Itemnumber",
  /** 会場見出し内の回次・日次の注記(<small>2回</small> など)。会場名抽出時に除去する。 */
  titleAnnotation: "small",
} as const;

/** 出馬表(shutuba.html)のセレクタ。 */
export const SHUTUBA_SELECTORS = {
  /** レース名(ページ上部)。 */
  raceName: "h1.RaceName",
  /** 発走時刻・距離・コース・天候・馬場を含む行。 */
  raceData01: ".RaceData01",
  /** 会場・条件・頭数などを含む行。 */
  raceData02: ".RaceData02",
  /** 出走馬の行。 */
  horseRow: "tr.HorseList",
  /** 枠番(class が Waku1〜Waku8 と可変のため前方一致)。 */
  waku: 'td[class^="Waku"] span',
  /** 馬番(class が Umaban1〜Umaban18 と可変のため前方一致)。 */
  umaban: 'td[class^="Umaban"]',
  /** 馬情報セル(実データ行の判定にも使う)。 */
  horseInfo: "td.HorseInfo",
  /** 馬名+horse_idリンク(title属性が馬名)。 */
  horseLink: "td.HorseInfo span.HorseName a",
  /** 性齢(例: 牝3)。 */
  barei: "td.Barei",
  /** 斤量セル: 性齢セル(Barei)の直後のtd(専用classが無く位置依存で取得する)。 */
  kinryoCell: "td",
  /** 騎手リンク(URL末尾が jockey_id、title属性が騎手名)。 */
  jockeyLink: "td.Jockey a",
  /** 厩舎所在地ラベル(Label1=美浦 / Label2=栗東)。 */
  trainerLabel: 'td.Trainer span[class^="Label"]',
  /** 調教師リンク(URL末尾が trainer_id、title属性が調教師名)。 */
  trainerLink: "td.Trainer a",
  /** 馬体重(増減)(例: 464<small>(-8)</small>)。 */
  weight: "td.Weight",
} as const;

/** パースに用いる正規表現。 */
export const PATTERNS = {
  /** href から race_id(12桁)を取り出す。 */
  raceIdFromHref: /race_id=(\d+)/,
  /** テキストからコース種別と距離を取り出す(例: 芝1800m / ダ1700m / 障2750m)。 */
  courseAndDistance: /(芝|ダ|障)\s*(\d+)\s*m/,
  /** テキストから頭数を取り出す(例: 16頭)。 */
  entryCount: /(\d+)\s*頭/,
  /** テキストからレース番号を取り出す(例: 11R)。 */
  raceNumber: /(\d+)\s*R/,
  /** href から horse_id を取り出す。 */
  horseIdFromHref: /\/horse\/(\d+)/,
  /** href から jockey_id を取り出す。 */
  jockeyIdFromHref: /\/jockey\/result\/recent\/(\d+)/,
  /** href から trainer_id を取り出す。 */
  trainerIdFromHref: /\/trainer\/result\/recent\/(\d+)/,
  /** 性齢を性別と年齢に分解する(例: 牝3 → 牝, 3)。 */
  sexAndAge: /^(\D+)(\d+)$/,
  /** 馬体重表記を体重と増減に分解する(例: 464(-8) → 464, -8)。 */
  weight: /^(\d+)\(([-+]?\d+)\)$/,
  /** 発走時刻を取り出す(例: 15:45発走 → 15:45)。 */
  startTime: /(\d{1,2}:\d{2})発走/,
  /** 天候を取り出す(例: 天候:晴 → 晴)。 */
  weather: /天候\s*[:：]\s*([^\s<>/]+)/,
  /** 馬場状態を取り出す(例: 馬場:良 → 良)。 */
  trackCondition: /馬場\s*[:：]\s*([^\s<>/]+)/,
} as const;
