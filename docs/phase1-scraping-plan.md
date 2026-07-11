# Phase 1: HTML構造調査とフィクスチャ取得計画

## ブロッカー(解消済み)

~~この実行環境のネットワークポリシーでは netkeiba への到達が拒否される~~
→ 2026-07-05、ユーザーが環境の Network access を変更し解消。同日に構造調査とフィクスチャ取得を実施した(結果は「調査結果」節)。

## 対象ページとURL一覧

| # | ページ | URL | 取得したい要素 |
|---|--------|-----|----------------|
| 1 | レース一覧(日付→race_id列挙) | `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=YYYYMMDD` | 当日の開催・レースID一覧。`race_list.html` はJS描画のため、サブHTML(フラグメント)側を第一候補とする |
| 2 | 競馬新聞(出馬表+過去走) | `https://race.netkeiba.com/race/newspaper.html?race_id={race_id}` | 馬名・馬番・枠・騎手・斤量・馬体重・horse_idリンク・レース条件(コース/距離/馬場)・天候 |
| 3 | 調教(追い切り) | `https://race.netkeiba.com/race/oikiri.html?race_id={race_id}`(仕様書の `?pid=oikiri` 相当。実URLは調査で確定) | 調教タイム・ラップ・本数・併せ馬結果・調教評価(プレミアム領域はoptional) |
| 4 | 厩舎コメント | `https://race.netkeiba.com/race/comment.html?race_id={race_id}`(同上、実URLは調査で確定) | 陣営コメント・厩舎談話(optional) |
| 5 | 馬個別ページ(全戦績) | `https://db.netkeiba.com/horse/{horse_id}/` | 全戦績テーブル: 着順・タイム・上がり3F・コース・距離・馬場・通過順・開催日・馬体重・枠番/馬番・厩舎所在地(美浦/栗東) |
| 6 | 騎手・調教師のコース成績 | `https://db.netkeiba.com/jockey/{jockey_id}/` 等(調査で確定) | 当該コース複勝率 |
| 7 | 単勝・複勝オッズ | 静的HTMLには含まれない可能性が高い。内部API(XHR)を特定する(候補: `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=...&type=1` 系。実エンドポイント・パラメータは調査で確定) | 単勝オッズ・複勝オッズ(下限/上限)。発走直前に再取得できる構造 |

## 取得方式の確定手順(仕様書の要求)

各要素について「静的HTML / 内部API / Playwright」のどれで取るかを Phase 1 で確定させる:

1. curl(UA明示)で素のHTMLを取得し、目的の要素が含まれるか cheerio で確認
2. 含まれない要素は、ページのscriptタグ・fetch先を調べ内部APIエンドポイントを特定し、直接叩いてJSON/HTMLフラグメントを確認
3. どちらも不可の場合のみ Playwright フォールバック(Chromiumは環境にプリインストール済み)
4. 結果を本ドキュメントの「調査結果」節に記録し、要素→取得方式の対応表を確定する

## フィクスチャ取得計画

### 保存先と命名

```
fixtures/
  race_list_sub_{kaisai_date}.html
  newspaper_{race_id}.html
  oikiri_{race_id}.html
  comment_{race_id}.html
  horse_{horse_id}.html
  odds_{race_id}.json        # APIの場合
```

**保存形式**: フィクスチャは**デコード済みUTF-8テキスト**として保存する(生バイト列は保存しない)。`HttpClient.fetchText` はレスポンスをエンコーディング(Content-Type または明示指定)に従ってデコードしたJS文字列を返し、パーサーはそのJS文字列を入力とする。フィクスチャも同じ文字列をそのままUTF-8で書き出すことで、テスト入力と本番入力の形を一致させる。EUC-JP配信の `db.netkeiba.com`(馬個別ページ)も取得時点でデコード済みのため、保存物はUTF-8になる。

### 選定基準(テストの境界値を意識)

- **レースA**: 芝・多頭数(16〜18頭)の重賞。過去走が豊富でnewspaperページの情報量が多い
- **レースB**: ダート・少頭数(〜12頭)の平場。芝/ダートの構造差・少頭数時のHTML差を確認
- **馬**: 以下の3タイプを含める
  - キャリア10走以上(全戦績テーブルのフル構造)
  - キャリア2走未満(サンプル不足境界のテスト用)
  - 地方・海外遠征歴あり(戦績テーブルの変則行の確認)
- レースIDは開催日ページ(#1)から列挙して選ぶ。開催日は直近の完了済み開催(例: 2026年6月末の土日)を使う

### 取得スクリプト

- `scripts/fetch-fixtures.ts` として実装(コアのHTTPクライアントを再利用)
- リクエスト間隔は最低1.5秒、User-Agent明示(仕様の制約に準拠)
- 取得回数は最小限: 上記フィクスチャ一式で 10リクエスト前後を想定
- 実行はネットワークポリシー解除後、1回のみ

## 調査結果(2026-07-05 実測)

### 要素→取得方式の確定表

| 要素 | 方式 | URL | charset | 備考 |
|------|------|-----|---------|------|
| レース一覧(日付→race_id) | **静的HTML** | `race.netkeiba.com/top/race_list_sub.html?kaisai_date=YYYYMMDD` | UTF-8(ヘッダ明示) | race_id・レース名・条件(芝/ダ・距離)・頭数・グレードアイコンが含まれる |
| 出馬表 | **静的HTML** | `race.netkeiba.com/race/shutuba.html?race_id={race_id}` | UTF-8(ヘッダ明示) | **newspaper.html は不採用**(下記) 。枠・馬番・馬名+horse_id・性齢・斤量・騎手+jockey_id・厩舎所在地(美浦/栗東)+trainer_id・馬体重(増減)がすべて静的に含まれる。オッズ列のみ `---.-` プレースホルダ(JS) |
| 各馬の全戦績 | **内部API** | `db.netkeiba.com/horse/ajax_horse_results.html?input=UTF-8&output=json&id={horse_id}` | UTF-8(JSON) | `{status:"OK", data:"<HTMLフラグメント>"}`。全戦績テーブル(下記列構成)が入る。馬ページ本体の戦績はこのAjaxで遅延描画されるため直接APIを叩く |
| 馬プロフィール | **静的HTML** | `db.netkeiba.com/horse/{horse_id}/` | **EUC-JP。ただしContent-Typeにcharsetなし(`text/html`のみ)→ 呼び出し側で `encoding: "euc-jp"` の明示指定が必須** | `db_prof_table`: 生年月日・調教師(美浦/栗東)・馬主・通算成績など。戦績テーブルは含まれない(上記Ajaxで取得) |
| 単勝・複勝オッズ | **内部API** | `race.netkeiba.com/api/api_get_jra_odds.html?race_id={race_id}&type=1&action=init` | UTF-8(JSON) | `data.odds["1"]` = 単勝 `{馬番(2桁): [オッズ, "0.0", 人気]}`、`data.odds["2"]` = 複勝 `{馬番: [下限, 上限, 人気]}`。`data.official_datetime` 付き。**複勝下限が直接取れる**(EV計算の要件に合致)。**`status` は実測で3種**: `"result"`(確定)/`"middle"`(発売中の暫定。単勝セル第2要素は `"0"`)/`"yoso"`(前売り前の予想オッズ。`odds["2"]`複勝が無く単勝のみ・第2要素は空文字)。**発走前分析が主用途のため result 以外も受理する**(yoso は複勝未発売でEV計算対象外) |
| 調教(追い切り) | **静的HTML(無料範囲)** | `race.netkeiba.com/race/oikiri.html?race_id={race_id}` | UTF-8(ヘッダ明示) | 無料で取れるのは**評価テキスト(`td.Training_Critic` 例「動き良化」)と評価ランク(例「B」)**。調教タイム・ラップはプレミアム領域 → スキーマ上optional(仕様想定通り) |
| 厩舎コメント | **プレミアム限定** | `race.netkeiba.com/race/comment.html?race_id={race_id}` | UTF-8 | 無料ではコメント本文が含まれない(ナビのみ)。スキーマ上optionalとし、無料実装ではスキップ。analyzerは調教評価のみで動く設計にする |
| 騎手・調教師コース成績 | 未調査 | `db.netkeiba.com/jockey/result/recent/{jockey_id}/` へのリンクを出馬表から確認済み | - | scorer実装時(Phase 2)に調査 |

- Playwrightフォールバックは**全要素で不要**と確定。
- `rapl.netkeiba.com`(newspaper系のAPL)は使用しない。

### newspaper.html を不採用にした理由

仕様書はスクレイピング起点に `newspaper.html` を挙げていたが、実測の結果、出馬表・各馬過去走テーブルは **Riot.js によるクライアントサイド描画**(`riot-shutuba-past` タグ + `race.netkeiba.com/race_api/`)で、静的HTMLには含まれない(タイム表記0件)。代替として:
- 出馬表 → `shutuba.html`(静的で全項目が取れる)
- 各馬過去走 → `ajax_horse_results.html`(全戦績が取れるので過去5走に限らずスコアリング要件をすべて満たす)

で同等以上の情報が取得できるため、こちらを正式ルートとする。取得済みの `fixtures/newspaper_202603020211.html` は不採用判断の証跡として保持。

### 戦績HTMLフラグメントの列構成(ajax_horse_results)

1行=1走、33セル。主要列: 日付(`2026/06/28`)・開催(`2福島2`)・天候・R・レース名(+race_idリンク)・頭数・枠・馬番・オッズ・人気・**着順**・騎手(+jockey_idリンク)・斤量・**距離(`芝1800`: 種別と距離が結合)**・馬場・タイム(`1:45.9`)・着差・**通過(`2-3-4-3`)**・ペース・**上り3F(`35.0`)**・**馬体重(`464(-8)`)**・勝ち馬名。

#### 地方・海外の変則行の実測(2026-07-07 追加、`horse_results_2021105727.json` = フォーエバーヤング15走)

当初サンプル(3頭)は中央のみだったため変則行を実測できていなかった。地方交流・海外遠征を含む実馬で追加取得し、以下を確認した。

- **列構造は不変**: 地方・海外を含む全15行とも `td` 数は33でヘッダ(33th)と一致する。行全体が壊れる変則ではなく、**個別セルの欠損・ID形式差**で表れる。
- **レースIDリンクの形式差(重要バグの原因)**:
  - 中央走: 12桁数値ID(例 `202308020404`)。5〜6桁目の場コードが `01`〜`10`。
  - 地方交流走: 12桁数値IDだが場コードが中央範囲外(実例: `202543100111`=船橋・日本テレビ盃、`202444122909`=大井・東京大賞典、`202330110311`=門別・JBC2歳優駿)。
  - 海外走: 英字混じりの別形式ID(実例: `2026J0010109`=ドバイワールドC、`2026P0010109`=サウジC、`2025FP010109`=BCクラシック)。数字のみの正規表現では途中で切れ(`2026`)、中央/地方の12桁数値IDとしては**取得不能**。
  - → 旧実装は全レースIDに 12桁+場コード01〜10 の厳格検証を掛けており、地方・海外走を1行でも含む馬は `parseHorseResults` 全体が `InvalidIdError` で失敗していた。
- **海外行の欠損実例**(ドバイワールドC・メイダン行): 枠番・タイム・着差・通過・ペース・上り3F が空、馬体重は「計不」(→ null)。開催は「メイダン」で回次・日目の数字がなく round/day は null。※頭数は当該行では空ではなく `9` が入る(欠損は行・レースにより一定でない)。

**対応方針(実装反映済み)**: レースIDリンクIDから開催区分を判定する。12桁数値IDかつ場コード01〜10=**中央**(`raceId` に `RaceId` 型を入れる)、それ以外の12桁数値ID=**地方**(`raceId` は null、生値を `raceIdRaw` に保持)、12桁数値IDとして取れない(英字混じり・リンク欠損)=**海外**(`raceId`/`raceIdRaw` とも null)。区分は `HorseRaceResult.venueKind`(`"中央"|"地方"|"海外"`)に持つ。Phase2で地方・海外走も馬場適性・ローテーション集計に使うため、**行そのものは絶対に捨てない**。判定はリンクIDのみに基づき会場名テキストとは独立させる。リンク欠損行は場コードを判定できないため基準「IDなし=海外」に従い海外に区分する(中央走は必ずリンクが付くため実害は小さいトレードオフ)。

### 出馬表(shutuba.html)の主要セレクタメモ

- 行: `tr.HorseList`
- 枠: `td[class^="Waku"] span`、馬番: `td[class^="Umaban"]`
- 馬名+horse_id: `td.HorseInfo span.HorseName a[href*="/horse/"]`(title属性=馬名)
- 性齢: `td.Barei`、斤量: 性齢の次の `td.Txt_C`
- 騎手: `td.Jockey a[href*="/jockey/result/recent/"]`(URL末尾がjockey_id)
- 厩舎: `td.Trainer span.Label1`(美浦/栗東)+ `a[href*="/trainer/"]`
- 馬体重(増減): `td.Weight`(例 `464<small>(-8)</small>`。出走前は未発表の場合あり)
- レース名・条件(距離/コース/発走時刻/馬場): ページ上部 `div.RaceList_Item02`(RaceName / RaceData01 / RaceData02)

### 取得済みフィクスチャ(2026-06-28開催、fixtures/)

| ファイル | 内容 |
|---|---|
| `race_list_sub_20260628.html` | 3場36レースの一覧 |
| `shutuba_202603020211.html` | レースA: ラジオNIKKEI賞(GIII) 福島芝1800・16頭 |
| `shutuba_202602010607.html` | レースB: 函館ダ1700・3歳以上1勝クラス・10頭 |
| `shutuba_202602010601.html` | レースC: 函館芝1200・2歳未勝利・8頭(キャリア浅い馬の供給源) |
| `oikiri_202603020211.html` | 調教評価(16頭分、評価+ランク) |
| `comment_202603020211.html` | プレミアム壁の確認用(本文なし) |
| `newspaper_202603020211.html` | 不採用判断の証跡(Riot描画) |
| `horse_2023103386.html` | 馬プロフィール: ルージュボヤージュ(牝3、EUC-JP→UTF-8デコード済み) |
| `horse_2021105857.html` | 馬プロフィール: ウィンターガーデン(牝5) |
| `horse_results_2023103386.json` | 戦績5走(3歳・中堅サンプル) |
| `horse_results_2021105857.json` | 戦績22走(フル構造・古馬) |
| `horse_results_2024104976.json` | 戦績2走(サンプル不足境界: チカバリエンテ 牝2) |
| `horse_results_2021105727.json` | 戦績15走(**地方交流・海外遠征の変則行を含む**: フォーエバーヤング。地方=船橋/大井/門別/川崎、海外=メイダン/デルマー等) |
| `odds_202603020211.json` | 単勝+複勝(下限/上限)+人気、official_datetime付き(`status:"result"` 確定) |
| `odds_middle_202603020611.json` | `status:"middle"` 発売中。単勝16頭+複勝16頭で構造は result と同一。単勝セル第2要素が `"0"`(result の `"0.0"` と揺れる) |
| `odds_yoso_202602011011.json` | `status:"yoso"` 前売り前の予想オッズ。**`odds["1"]`(単勝)のみで `odds["2"]`(複勝)が存在しない**。単勝セル第2要素は空文字 `""`。複勝未発売のためEV計算対象外 |

### 実装への反映事項(パーサー実装時に対応)

1. `urls.ts` を確定URLに更新: `shutubaUrl` を追加(newspaperUrl は非推奨化 or 削除)、`horseResultsApiUrl`、`oddsApiUrl` を追加。`oikiriUrl`/`commentUrl` は実URL一致を確認済み(コメントの「調査未了」注記を解除)
2. `fixture-plan.ts` を確定URL・確定エンコーディングに更新(horse ページに `encoding: "euc-jp"` 明示。Content-Typeにcharsetがないため必須)
3. セレクタは仕様通り `selectors.ts` に集約する

## ネットワーク解除待ちの間の先行実装

依存の向きから、実HTML不要の以下を先に TDD で実装する:

1. レート制限付きHTTPクライアント(fetch注入可能、最低1.5秒間隔、UA明示)
2. SQLiteキャッシュ層(URL→レスポンス、再取得抑止)
3. race_id・開催日のバリデーションと型定義
4. セレクタ集約ファイルの骨格(`selectors.ts`)

パーサー本体(cheerioでのDOM解釈)は実フィクスチャ取得後に着手する。
