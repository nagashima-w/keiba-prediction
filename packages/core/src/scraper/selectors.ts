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
  /**
   * 時刻・距離・頭数を含むデータ枠。
   * 頭数(例: 16頭)は中央では span.RaceList_Itemnumber でラップされるが、地方(NAR)では
   * ラップの無いプレーンテキストで入るため、専用セレクタは持たずこの枠のテキスト全体
   * (PATTERNS.entryCount)から正規表現で取り出す(中央・地方で共通のロジックにするため)。
   */
  raceData: ".RaceData",
  /** 会場見出し内の回次・日次の注記(<small>2回</small> など)。会場名抽出時に除去する。 */
  titleAnnotation: "small",
  /**
   * グレードラベル(テキスト方式)。
   * 実測(2026-06-24 浦和さきたま杯 Jpn1・2026-07-12 盛岡やまびこ賞 重賞・2026-07-13 瑞鳳賞 OP)で、
   * NARは `Icon_Grade_None_Text Icon_GradeType Icon_GradeType{N} Icon_GradePos01` の内テキストに
   * "Jpn1"/"重賞"/"OP" 等がそのまま入ることを確認済み(class番号も併記されるがテキストを優先採用)。
   * 中央は同じ枠が `Icon_GradeType` のみ(Icon_Grade_None_Text クラス無し)で内テキストが常に空の
   * 画像アイコン方式のため、このセレクタではマッチせず自然に undefined になる。
   * 詳細: docs/nar-scraping-plan.md。
   */
  grade: ".Icon_Grade_None_Text",
} as const;

/** 出馬表(shutuba.html)のセレクタ。 */
export const SHUTUBA_SELECTORS = {
  /** レース名(ページ上部)。 */
  raceName: "h1.RaceName",
  /**
   * 重賞グレードバッジ(タスク機能B 要修正2: 非重賞への無駄なAPI呼び出しを避ける事前判定)。
   * RaceName配下にIcon_GradeTypeクラスを持つ要素があるかどうかで判定する(有無のみ。
   * グレード番号〈Icon_GradeType{N}〉は中央・地方で体系が異なるため一切解釈しない)。
   * 中央は<h1 class="RaceName">…<span class="Icon_GradeType Icon_GradeType3">、
   * 地方(NAR)は<div class="RaceName">…<span class="Icon_Grade_None_Text Icon_GradeType
   * Icon_GradeType19 …">Jpn1</span>とタグ名(h1/div)が異なるため、raceNameセレクタ
   * (h1限定)を使い回さず、タグ名を問わないクラスセレクタ(.RaceName)で自己完結させる
   * (実測: 2026-07-28 boss着手前ゲート裁定)。
   */
  gradeBadge: ".RaceName .Icon_GradeType",
  /** 発走時刻・距離・コース・天候・馬場を含む行。 */
  raceData01: ".RaceData01",
  /** 会場・条件・頭数などを含む行。 */
  raceData02: ".RaceData02",
  /** 出走馬の行。 */
  horseRow: "tr.HorseList",
  /**
   * 枠番(class が Waku1〜Waku8 と可変のため前方一致)。
   * 中央は数字が span で包まれるが、地方(NAR)は td 直下にテキストが入るため、
   * span を要求せず td 自体のテキスト(descendant textを含む .text()で両対応)を取る。
   */
  waku: 'td[class^="Waku"]',
  /** 馬番(class が Umaban1〜Umaban18 と可変のため前方一致)。 */
  umaban: 'td[class^="Umaban"]',
  /** 馬情報セル(実データ行の判定にも使う)。 */
  horseInfo: "td.HorseInfo",
  /** 馬名+horse_idリンク(title属性が馬名)。 */
  horseLink: "td.HorseInfo span.HorseName a",
  /**
   * 性齢セル(例: 牝3)・斤量セルの取得はいずれも位置依存(horseInfoの直後のtd = 性齢、
   * その次のtd = 斤量)。中央は性齢セルに class="Barei" が付くが、地方(NAR)は
   * class無しのtd内にspan.Ageで入るため、classに依存せず horseInfo からの相対位置で取る
   * (中央・地方で共通のロジックにするため)。
   */
  kinryoCell: "td",
  /** 騎手リンク(URL末尾が jockey_id、title属性が騎手名)。 */
  jockeyLink: "td.Jockey a",
  /**
   * 厩舎所在地ラベル。中央は Label1=美浦 / Label2=栗東、地方(NAR)は LabelGray に
   * 所属会場名(例: 高知・浦和)が入る。[class^="Label"] で両対応する。
   */
  trainerLabel: 'td.Trainer span[class^="Label"]',
  /** 調教師リンク(URL末尾が trainer_id、title属性が調教師名)。 */
  trainerLink: "td.Trainer a",
  /** 馬体重(増減)(例: 464<small>(-8)</small>)。 */
  weight: "td.Weight",
} as const;

/** 馬プロフィール(db.netkeiba.com/horse/{id}/)のセレクタ。 */
export const HORSE_PROFILE_SELECTORS = {
  /** 馬名(ページ見出し)。 */
  name: "div.horse_title h1",
  /** プロフィールテーブル(生年月日・調教師・通算成績など)。 */
  profTable: "table.db_prof_table",
  /** テーブル各行の見出しセル。 */
  rowHeader: "th",
  /** テーブル各行のデータセル。 */
  rowData: "td",
  /** 調教師リンク(href が /trainer/{id}/、title が調教師名)。 */
  trainerLink: 'a[href*="/trainer/"]',
} as const;

/** 全戦績(ajax_horse_results)のセレクタ。 */
export const HORSE_RESULTS_SELECTORS = {
  /** 戦績テーブル。 */
  table: "table.db_h_race_results",
  /** 行(ヘッダ行含む)。 */
  row: "tr",
  /** ヘッダ列セル(列数の基準にする)。 */
  headerCell: "th",
  /** データセル。 */
  dataCell: "td",
} as const;

/**
 * レース結果(result.html)のセレクタ。
 *
 * 注意: 文書全体には結果本体(全着順)以外にも tr を持つテーブルが複数ある
 * (プレミアムのラップサマリー等)。誤って余分な行を取り込まないよう、結果本体は
 * id=All_Result_Table にスコープする(resultTable 配下でのみ resultRow を探す)。
 */
export const RACE_RESULT_SELECTORS = {
  /**
   * 発走時刻・距離・コース・天候・馬場を含む行(タスク#27-A2: 面〈course_type〉解決に使う)。
   * SHUTUBA_SELECTORS.raceData01 と値は重複するが、セレクタ群はページ単位で自己完結させる
   * 既存規約(RACE_LIST_SELECTORS/SHUTUBA_SELECTORS等の作法)に合わせ、ここにも独立して持つ。
   */
  raceData01: ".RaceData01",
  /** 全着順テーブル(結果本体)。他テーブルの行と区別するため id で限定する。 */
  resultTable: "#All_Result_Table",
  /**
   * 出走馬の結果行(resultTable 配下でのみ使用)。
   * 中央は行に class="HorseList" が付くが、地方(NAR)は付かない(<tr >のみ)ため、
   * class に依存せず tbody の直接の子trを結果行とする(ヘッダ行はtheadにあり除外される。
   * resultTable スコープ内に他テーブルは無いため、余分な行を拾う心配もない)。
   */
  resultRow: "tbody > tr",
  /** 着順表示(td.Result_Num 内の順位)。 */
  finishRank: "td.Result_Num div.Rank",
  /**
   * 枠・馬番のセル(いずれも td.Num)。枠セルは class に Waku{n} を持つため、
   * パーサー側で Waku を持たない td.Num を馬番として選ぶ(枠と馬番の取り違え防止)。
   */
  numCell: "td.Num",
  /** 馬名リンク(title属性が馬名)。 */
  horseNameLink: "td.Horse_Info span.Horse_Name a",
  /**
   * ヘッダ行(thead 配下)。後3F・コーナー通過順の列インデックス解決に使う。
   * これらの列は複数セルが同じ class(class="Time" 等)を共有し class だけでは区別できないため、
   * ヘッダテキストから列位置を解決し、データ行側は同じ位置の td を位置ベースで読む
   * (parse-horse-results がヘッダ列数を基準に検証する流儀に準拠)。
   */
  headerRow: "thead tr.Header",
  /** ヘッダ列セル。 */
  headerCell: "th",
  /** データセル(位置ベースで後3F・コーナー通過順を取り出すために使う。resultRow 配下)。 */
  dataCell: "td",
  /** 払戻テーブル(単勝・複勝・馬連…を含む。ページ内に複数ある)。 */
  payoutTable: "table.Payout_Detail_Table",
  /** 単勝の払戻行。 */
  winRow: "tr.Tansho",
  /** 複勝の払戻行。 */
  placeRow: "tr.Fukusho",
  /** 払戻行の的中馬番セル(内部の空でない span が馬番)。 */
  payoutResult: "td.Result",
  /** 払戻行の払戻金額セル(内部で <br> 区切り。複数点あり)。 */
  payoutAmount: "td.Payout",
} as const;

/**
 * レース結果(result.html)のヘッダテキストラベル。
 * 後3F・コーナー通過順の列インデックスをこのテキストから解決する
 * (地方(NAR)ではコーナー通過順の列自体が存在しない場合がある)。
 */
export const RACE_RESULT_HEADER_LABELS = {
  /** 後3F列のヘッダテキスト。 */
  last3f: "後3F",
  /** コーナー通過順列のヘッダテキスト。 */
  passing: "コーナー通過順",
} as const;

/**
 * 地方(NAR)オッズページ(odds/index.html?type=b1)のセレクタ。
 *
 * 発売後は #odds_tan_block(単勝)・#odds_fuku_block(複勝)の2ブロックが静的に入る。
 * 発売前(前売り前)はこの2ブロックが存在せず、代わりに「予想オッズ」テーブル
 * (class に Ninki が付く)のみが単勝相当として表示される。
 * いずれの行も「馬番」列は先頭から2列目(0始まりで列インデックス1)に固定で現れるため、
 * 枠/人気など1列目の意味が発売前後で違っても位置ベースで共通に取り出せる。
 * 詳細: docs/nar-scraping-plan.md「オッズの取得方式」。
 */
export const NAR_ODDS_SELECTORS = {
  /** 発売後・単勝ブロック。 */
  tanBlock: "#odds_tan_block table.RaceOdds_HorseList_Table",
  /** 発売後・複勝ブロック。 */
  fukuBlock: "#odds_fuku_block table.RaceOdds_HorseList_Table",
  /** 発売前・予想オッズ(単勝相当)テーブル。 */
  yosoTable: "table.RaceOdds_HorseList_Table.Ninki",
  /** データ行(ヘッダ行はthのみでtdを持たないため、tdを持つ行をデータ行とみなす)。 */
  row: "tr",
} as const;

/**
 * 地方(NAR)ワイド・3連複オッズページ(odds/index.html?type=b5|b7、
 * および軸馬別AJAXフラグメント odds_get_form.html?type=b7&jiku=N)のセレクタ
 * (機能D-2b-A・Issue #32)。
 *
 * `parse-nar-odds.ts`(単勝・複勝、`#odds_tan_block`/`#odds_fuku_block`ベースの行構造)とは
 * 別の構造を持つ: 組合せオッズは軸馬ごとの `table.Odds_Table`(グリッド行列)に跨って
 * `td.Odds` セルが並び、各セルの `id`(例: `chk_..._b5_c0_1_2`)に馬番の組が埋め込まれている。
 * 1ページに複数の `table.Odds_Table` があるため、既存 `parse-nar-odds.ts` の行走査
 * (`dataRows`)は流用せず、`id` パターンマッチでセルを直接走査する
 * (`wide-trio-odds-fixtures.test.ts`〈機能D-1〉で実測済みの抽出方式を踏襲)。
 *
 * ## 「オッズ文書として正当か」の判定根拠(受け入れ条件8)
 *
 * boss実測(2026-08-06、実リクエスト0): 3種のページで次の組み合わせを確認した。
 *
 * | ページ | `#odds_select` | `#odds_view_form` | `td.Odds` |
 * |---|---|---|---|
 * | 発売後(`nar_odds_b5_202654071210.html`) | あり | あり | 66 |
 * | AJAXフラグメント(`nar_odds_b7_jiku2_...`) | あり | **なし** | 55 |
 * | 発売前(`nar_odds_b1_presale_202642071301.html`) | **なし** | あり | 11 |
 *
 * `#odds_select` は投票カートの選択済み件数を表示する `<span>`(「選択済み：<span
 * id="odds_select"></span>件」)であり、通常ページ・AJAXフラグメントには含まれるが、
 * 投票対象が無い発売前ページには含まれない。`#odds_view_form` はオッズ本文を包む
 * 汎用ラッパーで、通常ページ・発売前ページには含まれるが、AJAXで差し替わる中身
 * そのものであるフラグメント自身には(外枠が無いため)含まれない。したがって
 * **`#odds_select` 単独をページである証拠にすると発売前ページで throw し、
 * `#odds_view_form` 単独だと AJAXフラグメントで throw する**。両者の **OR**
 * (いずれか一方でもあれば正当な文書とみなす)で3ケースすべてを正しく判定できる。
 *
 * 上記3ケースのうち発売前ページはb1(単勝・複勝)のものだったが、状態③(受け入れ条件9)で
 * b5/b7の実物発売前ページ(`nar_odds_b5_presale_202655080803_20260806.html`ほか)を取得し、
 * 同じOR判定が正しく分岐すること(`#odds_select`なし・`#odds_view_form`あり・throwせず
 * unavailable)を確認済み(`docs/wide-trio-odds-investigation.md` §11.3)。
 *
 * 発見: b5/b7の発売前ページは、券種固有のプレビューではなく単勝の「予想オッズ」プレビュー
 * (`td.Odds`は12件だが、いずれも`id`属性を持たない=`chk_`接頭辞のid規約がb1の発売前ページと
 * 同様に付かない)に一律フォールバックする。このため`oddsCell`(id属性で組合せを識別する
 * セレクタ)は発売前ページでは0件になり、unavailable判定の`reason`(下記
 * `NarComboOddsUnavailableReason`)には`td.Odds`の**生の総数**(id属性の有無を問わない)を
 * 別途 `oddsCellAny` で数えて持たせる(boss裁定2026-08-07。型の取り違え〈b1発売後ページを
 * wideパーサに通す〉との区別に使う: 型の取り違えはtd.Odds自体は24件〈idなし〉存在するが、
 * 本当の未発売は12件〈同じくidなし〉と、いずれも`oddsCell`は0件で見分けが付かないため、
 * `oddsCellAny`のような生の全体件数を別途持たせないと2つの経路が区別不能になる)。
 */
export const NAR_COMBO_ODDS_SELECTORS = {
  /** 投票カートの選択済み件数(「オッズ文書として正当か」判定の一方の根拠)。 */
  cartCount: "#odds_select",
  /** オッズ本文を包む汎用ラッパー(同上、もう一方の根拠)。 */
  viewFormWrapper: "#odds_view_form",
  /** 組合せオッズセル(id属性に馬番の組が埋め込まれる)。実際にパースに使うセルの走査対象。 */
  oddsCell: 'td.Odds[id^="chk_"]',
  /**
   * `td.Odds`の生の総数を数えるためのセレクタ(id属性の有無を問わない)。
   * `oddsCell`とは異なる集合になり得る(発売前ページの予想オッズプレビューは`td.Odds`は
   * 存在するが`id`属性を持たないため、`oddsCell`では0件になる)。`unavailable`のreasonに
   * 診断値として残す用途専用で、パース本体の値抽出には使わない。
   */
  oddsCellAny: "td.Odds",
} as const;

/** 調教(oikiri.html)のセレクタ。 */
export const OIKIRI_SELECTORS = {
  /** 調教テーブル。 */
  table: "table.OikiriTable",
  /** 出走馬の行。 */
  row: "tr.HorseList",
  /** 馬番セル。 */
  umaban: "td.Umaban",
  /** 馬名+horse_idリンク。 */
  horseLink: "td.Horse_Info div.Horse_Name a",
  /** 調教評価テキスト(例: 動き良化)。 */
  critic: "td.Training_Critic",
  /** 調教評価ランク(class が Rank_〜 と可変のため前方一致。例: B)。 */
  rank: 'td[class^="Rank_"]',
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
  /**
   * href から jockey_id を取り出す。
   * 中央は数字のみ(例: 01043)だが、地方(NAR)は英字混じりの5桁ID(例: a01bb)もあるため
   * 英数字で受理する。
   */
  jockeyIdFromHref: /\/jockey\/result\/recent\/([0-9a-zA-Z]+)/,
  /**
   * href から trainer_id を取り出す。
   * 中央は数字のみだが、地方(NAR)は英字混じりのID(例: a030b)もあるため英数字で受理する。
   */
  trainerIdFromHref: /\/trainer\/result\/recent\/([0-9a-zA-Z]+)/,
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
  /**
   * 芝コース区分(柵)の括弧内容を取り出す(タスク#26-P1)。
   * 「芝XXXXm」の直後の `(...)` 内のみをキャプチャする(RaceData01全体から `[A-Z]` を
   * 拾うと他要素の英字を誤って柵と誤認する恐れがあるため、必ず芝の距離表記に直接後続する
   * 括弧に限定する)。実測(fixtures/shutuba_202602010601.html 等): `芝1200m (右&nbsp;A)`。
   * \s は ECMAScript の仕様上 U+00A0(&nbsp;)を含むため、実体参照の区切りもそのまま吸収できる。
   * ダート(`ダXXXXm (右)`)・障害はこのパターンにそもそもマッチしないため、
   * 呼び出し側で courseType==="芝" のときのみ適用するガードと二重で安全性を確保する。
   */
  turfFenceParen: /芝\s*\d+\s*m\s*\(([^)]*)\)/,
  /**
   * 芝コース区分(柵)の括弧内容から柵letter(A〜Z単体)を取り出す(タスク#26-P1)。
   * 括弧内容は `右`/`左`/`直`(回り方向)・`内`/`外`(内外)・柵letterの組み合わせで、
   * 区切りは実体 `&nbsp;`(U+00A0。\s に含まれる)。内・外・回り方向はいずれも漢字のため
   * `[A-Z]` に一致せず、柵letterの判別にのみ「柵letterでない」ことの消去法として働く
   * (これらの語自体を型やフィールドとして持つ必要はない)。
   *
   * 採用方針(境界ケースの挙動を明記):
   * - `(右 外)` のように柵letterが無ければ不一致 → 呼び出し側で null(判別不能)。
   * - `(右 外 A)` のような複合表記でも、単独の大文字1文字トークンがあれば
   *   前後の語(外/内)に関わらずそれを柵letterとして安全に抽出する(部分マッチではなく
   *   単語境界〈空白 or 文字列端〉で区切られた1文字のみを対象にするため、"A"を含む
   *   別の単語を誤って拾うことはない)。
   */
  fenceLetterToken: /(?:^|\s)([A-Z])(?:\s|$)/,
  /** href から trainer_id を取り出す(プロフィール表: /trainer/01126/ 形式)。 */
  trainerIdFromProfileHref: /\/trainer\/(\d+)/,
  /** 括弧内の値を取り出す(例: 木村哲也 (美浦) → 美浦)。半角・全角括弧に対応。 */
  parenContent: /[(（]\s*([^)）]+?)\s*[)）]/,
  /** 全戦績の距離表記(例: 芝1800 / ダ1700 / 障3000。m 表記なし)。 */
  courseAndDistanceCompact: /(芝|ダ|障)\s*(\d+)/,
  /** 開催表記を回次・会場・日目に分解する(例: 2福島2 → 2, 福島, 2)。 */
  venueRound: /^(\d+)(\D+?)(\d+)$/,
  /** 通過順位を分解する区切り(例: 2-3-4-3)。 */
  passingSeparator: /-/,
  /**
   * href からレースIDセグメントを英数字ごと取り出す(戦績のレース名リンク: /race/{id}/ 形式)。
   * 海外走は `2026J0010109` のように英字が混じるため、数字のみでは途中で切れる。
   * 区分判定は取り出した生セグメントに対して行う。
   */
  raceIdSegmentFromRacePath: /\/race\/([0-9A-Za-z]+)/,
  /** 降着表記の着順(例: 5(降) / 3(降))から確定順位を取り出す。半角・全角括弧に対応。 */
  demotedFinish: /^(\d+)\s*[(（]\s*降\s*[)）]$/,
  /** 結果テーブルの枠セル判定(class に Waku{n} を含むか)。 */
  wakuClass: /\bWaku\d/,
  /** NARオッズの単勝セル(単一の数値。例: 24.8)。 */
  narWinOdds: /^[0-9]+(\.[0-9]+)?$/,
  /** NARオッズの複勝セル(下限 - 上限。例: 6.8 - 8.5)。 */
  narPlaceOddsRange: /^([0-9]+(?:\.[0-9]+)?)\s*-\s*([0-9]+(?:\.[0-9]+)?)$/,
  /**
   * 交流重賞(Jpn1/2/3)のグレード表記。半角数字("Jpn1"等)またはローマ数字
   * ("JpnⅠ"等)のみを受理し、全角数字("Jpn１")は受理しない(実測で確認済みの
   * "Jpn1" 表記を主対象としつつ、将来のローマ数字表記にも備える)。
   * 前後の空白は呼び出し側で trim してから照合する想定。
   */
  jpnGrade: /^Jpn(?:[123]|[ⅠⅡⅢ])$/,
} as const;
