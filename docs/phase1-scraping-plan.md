# Phase 1: HTML構造調査とフィクスチャ取得計画

## 現状のブロッカー(要ユーザー対応)

この実行環境のネットワークポリシーでは netkeiba への到達が拒否される(CONNECT に対しゲートウェイが 403 を返す。curl / WebFetch とも不可)。

- `race.netkeiba.com` → 403(ポリシー拒否)
- `db.netkeiba.com` → 403(ポリシー拒否)

**対応**: 環境設定の Network access を netkeiba に到達できる設定に変更する(GETTING_STARTED.md 記載の通り、デフォルトの Trusted はパッケージレジストリのみ許可)。解除されるまで、実HTMLに依存するパーサー実装は保留し、ネットワーク非依存の基盤(HTTPクライアント・キャッシュ・型定義)を先行実装する。

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

## 調査結果(未実施)

> ネットワーク解除後にここへ追記する。
> 要素ごとの「静的/API/Playwright」対応表、および各ページの主要セレクタのメモを記録する。

## ネットワーク解除待ちの間の先行実装

依存の向きから、実HTML不要の以下を先に TDD で実装する:

1. レート制限付きHTTPクライアント(fetch注入可能、最低1.5秒間隔、UA明示)
2. SQLiteキャッシュ層(URL→レスポンス、再取得抑止)
3. race_id・開催日のバリデーションと型定義
4. セレクタ集約ファイルの骨格(`selectors.ts`)

パーサー本体(cheerioでのDOM解釈)は実フィクスチャ取得後に着手する。
