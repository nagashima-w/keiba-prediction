# Cloudflare 移行スパイク 第1ラウンドの記録(Issue #159)

- 実行: GitHub Actions run 37182126251(job 111376632332)、2026-10-04 06:12〜06:28 UTC
- コード: コミット 0c47222(レビュー前)。**このコミットは意図して起動したものではない。** コミットメッセージの本文に
  実測の印の文字列が含まれ、当時の起動条件(部分一致の `contains`)が成立して起動した。起動条件はその後、件名の先頭一致に改めた(284c49f)
- 出典: ジョブログの結果ブロック(`===CF-SPIKE-RESULT-BEGIN===` 〜 `END`)。下の数値は、メインがログの実物から転記した
- 旧コードの既知の欠陥(予算切れで中断した点を失敗として扱う、`check` を検査しない、リダイレクトに従う)は、
  この実行では結果に影響していない。中断した点は記録に無く(失敗した点はすべて `cpuExceeded >= 1`)、
  netkeiba への応答に 3xx も無かった

## 1. netkeiba への到達性(Worker から)

| 対象 | URL | HTTP | 本文 | 主なヘッダ |
|---|---|---|---|---|
| central-shutuba | `https://race.netkeiba.com/race/shutuba.html?race_id=202603020211` | 400 | 0 バイト | `server: cloudflare`、`via: 1.1 …cloudfront.net (CloudFront)`、`x-cache: Error from cloudfront` |
| central-odds | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init` | 400 | 0 バイト | 同上 |

- 2回連続の拒否で打ち切った(`stoppedReason: consecutive-blocks`、`requestCount: 2`)。db.netkeiba.com・nar.netkeiba.com は**未測定**
- 400 を返しているのは netkeiba の手前の CloudFront と読める。原因(送信元が Cloudflare であること/データセンター IP 全般/
  リクエストの内容)は、この実行だけでは切り分けられない → 第2ラウンドで、ランナーから同じ URL・同じヘッダの対照を取る

## 2. 自己検査

- EUC-JP の往復(`HttpClient` + iconv-lite、`nodejs_compat`): 本番の Worker で一致(`eucJpRoundTrip: true`)

## 3. CPU 上限の探索(Free プランのアカウント)

各点は「その reps を何回試し、何回通ったか」。超過の応答は、Worker が HTTP 503(Cloudflare のエラーページ)、
Durable Object が HTTP 500 `Durable Object exceeded its CPU time limit and was reset.`

### 普通の Worker

| 処理 | 通過した最大 reps | 超過した最小 reps | 備考 |
|---|---|---|---|
| parse(出馬表1ページ) | 4 | 5(1回通過・1回超過) | reps=8 は超過、6・5 は通過と超過が1回ずつ |
| score | なし | 1 | |
| alloc | なし | 1 | |
| allocFull | なし | 1 | |

- score はローカルで 1 回 0.3ms 程度の処理だが、reps=1 で超過した(壁時計 20ms)。**最初の超過の後、Worker は軽い処理でも
  すぐ 503 を返している疑いがあり、parse 以降の測定は独立とは言えない。** 第2ラウンドでは超過の直後に `/ping` を打って記録する

### Durable Object(SQLite バックエンド)

| 処理 | 通過した最大 reps | 超過した最小 reps | 試行の内訳(抜粋) |
|---|---|---|---|
| parse | 512 | 544 | 512 は2回とも通過(壁時計 37.8 / 45.5 秒)。544・576・640・768・1024 は各1回で超過 |
| score | 4096 以上(探索の上限) | なし | 4096 は2回とも通過(2.5 秒) |
| alloc(単勝・複勝・ワイド・三連複) | 88 | 96 | 80・88 は2回とも通過。96・128 は各1回で超過 |
| allocFull(全券種) | 32 | 34 | 32 は2回とも通過(30.4 / 31.1 秒)。34・36・40・48・64 は各1回で超過 |

- **Free プランでも、Durable Object の CPU 上限は普通の Worker の 10ms よりはるかに大きい。** ドキュメントの「30 seconds (default)」を
  上限と仮定すると、allocFull は1回あたりおよそ 0.88〜0.94 秒(30秒÷34 〜 30秒÷32)。**30 秒はドキュメントの値で、実測ではない**
- 参考(ローカルの workerd での 1 rep あたり、ms): parse 18〜20、score 0.2〜0.4、alloc 102〜106、allocFull 405〜420

## 4. 後片付け

- `wrangler delete` は `A request to the Cloudflare API (/accounts/***/storage/kv/namespaces) failed. Authentication error [code: 10000]` で exit 1
  (トークンに KV の権限が無いため)。ただし直後の一覧の確認では、接頭辞 `keiba-cf-spike-` の Worker は**残り0件**、
  Durable Object の名前空間は removed、API による再削除は不要だった
- → 第2ラウンドから、削除は API の DELETE を主にした

## 5. 公開ログへの露出

- リポジトリは public。この実行のログには、各ステップの環境変数の表示に workers.dev のサブドメインが平文で出ている
  (284c49f 以降は、プリフライトでマスクを登録してから環境変数に書く)
