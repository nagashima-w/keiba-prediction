# Cloudflare 移行スパイク(Issue #159〈#21-A〉)の結果

#21(分析全体とスマホの画面を Cloudflare へ移す)の前提だった2点を、実際に Cloudflare に Worker をデプロイして測った。

1. netkeiba は、Cloudflare Workers からのアクセスを受け付けるか
2. 無料(Free)プランの範囲で、処理を組めるか(普通の Worker と、SQLite バックエンドの Durable Object〈以下 DO〉の両方)

**このファイルの数値は、第2ラウンドの結果 JSON(`round2-result.json`)から `scripts/cloudflare-spike/render-report.ts` で
生成した節(「第2ラウンドの結果」)にある。手で書き写していない。** 生成の節の外にある本文は手で書いたもので、数値を
繰り返さず、表を指す。例外として、JSON の個別のサンプルを指して引用した数値には出所(`cpu.samples[n]`)を添えた。

## 1. 結論(事実と推測を分ける)

### 事実(結果 JSON に記録されていること)

- **Workers → netkeiba**: Worker から取得した race.netkeiba.com(出馬表)と db.netkeiba.com(馬ページ)は、どちらも
  **HTTP 400・本文0バイト**だった(応答ヘッダは `server: cloudflare`、`x-cache: Error from cloudfront`)。2回連続の拒否で Worker は
  打ち切ったため、nar.netkeiba.com・race のオッズ API・db の戦績 API は **Worker からは未測定**
- **ランナー(GitHub Actions)→ netkeiba**: 同じ URL・同じヘッダ(User-Agent を含む)・同じ取得コード・同じ記録の形で、
  ランナーの Node から5対象とも **HTTP 200 で、既存パーサが読めた**(応答ヘッダは `server: Apache`、`x-cache: Miss from cloudfront`)。
  EUC-JP の馬ページも文字化けなし。**変えたのは送信元だけ**(Worker か ランナーか)
- **EUC-JP のデコード**: 本番の Worker 内で、`HttpClient`(iconv-lite、`nodejs_compat`)による往復が一致した
- **Durable Object(Free プラン)**: CPU 超過は HTTP 500
  `Durable Object exceeded its CPU time limit and was reset.`(`cpu.samples` の超過 10 件すべて)。**重い計算(全券種の配分 = allocFull)が、
  1 リクエストの中で数十回分(下の表の maxPassReps)収まった**。allocFull を1回だけ動かした壁時計は約1秒(`cpu.samples` の DO・allocFull・reps=1。2回とも 1 秒前後)
- **普通の Worker(Free プラン)**: 通過する量は DO よりずっと小さい(下の表)。Worker の超過は HTTP 503
- **後片付け**: 接頭辞付きの Worker は残り0件。DO の名前空間も Worker と一緒に消えた(`durableObjectNamespaces: removed`)
- **この実行から取れなかった測定**: 補助に入れた時計(Worker 内の `performance.now()` の差)は、DO では常に 0、普通の Worker でも
  処理の直後(`insideMs`)は常に 0 だった(本番では実行中に I/O が無いと時計が進まない、というドキュメントのとおり)。I/O を挟んだ
  後の値(`afterIoMs`)は、Worker では 0 でない値が出るが、ローカルの値との比が処理によってばらばらで、CPU 時間の代わりにならない

### 推測・未確認(事実ではない)

- **400 の原因は未切り分け。** 「Cloudflare の送信元 IP の範囲」なのか、「Workers が subrequest に付ける要素(ヘッダ・TLS の特徴など)」
  なのかは分からない。**データセンター IP 全般ではない**(ランナーもデータセンターの IP で、通った)。ただし、ランナーの IP 範囲
  だけが通る可能性は残る。UA を変える実験は、変数を1つずつ動かす原則により、この対照の結果を見てから決める(今回は行っていない)
- **「30 秒」はドキュメントの値であり、実測ではない。** 測ったのは「通過した最大の反復回数」と「超過した最小の反復回数」だけで、
  上限を 30 秒と仮定すると 1 回あたりの CPU の目安が出る(生成した節の「1回あたりの CPU の推定」。**30 秒を仮定した目安**)
- **普通の Worker の「10 ms」は、この測定では、CPU 時間の単純な打ち切りとしては説明できない。** ローカルの 1 reps あたりの値(生成した節の
  「ローカル(workerd)」)を掛けると、parse は約 200 ms 相当まで通る一方、score は約 30 ms 相当で超過した(概算。ローカルの CPU は
  本番とは違う)。さらに、allocFull を1回動かすだけで約 0.9 秒の壁時計がかかった要求が、1回は 200 で完了し(`cpu.samples[44]`)、
  同じ条件の直後の試行は超過した(`cpu.samples[45]`)。再現性が無いので、**Worker で重い計算を動かす根拠にはならない**。
  機序は調べていない
- 第1ラウンド(`round1.md`)の Worker の測定は、超過の直後に軽い処理まで落ちていた疑いがあり、汚染されていた可能性が高い。
  第2ラウンドでは超過の直後の `/ping` がすべて 200 で、**汚染の証拠は見つからなかった**(生成した節の「超過の後の測定は独立か」)。
  逆転(同じ reps で通過と超過が混在)は、上限付近の揺らぎと読む

## 2. 実行の概要

| | 第1ラウンド | 第2ラウンド |
|---|---|---|
| 記録 | [`round1.md`](./round1.md)(メインがジョブログから転記) | [`round2-result.json`](./round2-result.json)(結果ブロックをログからプログラムで切り出したもの) |
| run | GitHub Actions run 37182126251 | GitHub Actions run 37184397455(結果 JSON の `runId` は `37184397455-1`) |
| コード | 0c47222(**意図せず起動した**。コミットメッセージの本文に起動の印が含まれ、当時の部分一致の条件が成立した) | 20f2746(ワークフローは 63714cc) |
| 変えたこと | — | Worker に加え、ランナーからも同じ対象を取得(対照)。netkeiba への合計 10 本以内・2 秒間隔・送信元ごとの2回連続拒否で打ち切り。削除は API の DELETE を主に |
| 日時(UTC) | 2026-10-04 06:12〜06:28 | 上の JSON の `startedAt` / `finishedAt` |

第1ラウンドの結果(Worker から race が 400 など)は `round1.md` を参照。第2ラウンドの Worker の拒否は第1ラウンドと同じ形で、
ランナーとの対照で「送信元の違い」に絞れた。

## 3. 第2ラウンドの結果(自動生成)

以下は `round2-result.json` から生成した節。再生成のコマンドは「5. 再現手順」。

<!-- GENERATED:BEGIN(render-report.ts が生成。手で編集しない) -->
### Cloudflare 移行スパイク結果(run 37184397455-1)

- 開始: 2026-10-04T06:59:40.004Z / 終了: 2026-10-04T07:17:05.773Z

#### 到達性(netkeiba への取得。Worker とランナーの対照)

- 出したリクエスト(Worker とランナーの合計): 7 本 / 全体の打ち切り理由: なし
- 送信元ごとの打ち切り: worker: consecutive-blocks / runner: なし
- 判定の件数: ok: 5 / reachable-but-unparsed: 0 / blocked: 2 / challenge: 0 / redirect: 0 / http-error: 0 / network-error: 0
- 送信元ごとの ok / 総数: worker 0 / 2、runner 5 / 5

| ホスト | ok / 総数 |
|---|---|
| race.netkeiba.com | 2 / 3 |
| db.netkeiba.com | 2 / 3 |
| nar.netkeiba.com | 1 / 1 |

| 対象 | 送信元 | ステータス | 本文バイト | charset | パース | 判定 | 理由 |
|---|---|---|---|---|---|---|---|
| central-shutuba | worker | 400 | 0 | UTF-8 | 未実施 | blocked | 拒否されました(HTTP 400) |
| central-shutuba | runner | 200 | 277256 | UTF-8 | shutuba 16 件 | ok | HTTP 200、既存パーサで 16 件を読めました |
| db-horse-page | worker | 400 | 0 | EUC-JP | 未実施 | blocked | 拒否されました(HTTP 400) |
| db-horse-page | runner | 200 | 84018 | EUC-JP | horse-page 1 件 | ok | HTTP 200、既存パーサで 1 件を読めました |
| nar-shutuba | runner | 200 | 218738 | UTF-8 | shutuba 12 件 | ok | HTTP 200、既存パーサで 12 件を読めました |
| central-odds | runner | 200 | 890 | UTF-8 | odds-json 16 件 | ok | HTTP 200、既存パーサで 16 件を読めました |
| db-horse-results | runner | 200 | 140135 | UTF-8 | horse-results 26 件 | ok | HTTP 200、既存パーサで 26 件を読めました |

##### 対照(同じ対象を Worker とランナーから。変えたのは送信元だけ)

| 対象 | Worker | ランナー |
|---|---|---|
| central-shutuba | blocked(400) | ok(200) |
| db-horse-page | blocked(400) | ok(200) |
| nar-shutuba | 未測定 | ok(200) |
| central-odds | 未測定 | ok(200) |
| db-horse-results | 未測定 | ok(200) |

- 暫定の読み: worker-only-blocked: Worker だけが拒否(400/403/429 または challenge)された。Cloudflare(Workers)からのアクセスに固有の疑いがある。

#### EUC-JP のデコード(Worker 内の往復)

成功(往復一致)

#### CPU(反復回数を増やして上限超過になる点を探索)

| 実行環境 | 処理 | maxPassReps | minFailReps | 停止理由 | 試行数 |
|---|---|---|---|---|---|
| Worker | parse | 8 | 9 | converged | 16 |
| Worker | score | 64 | 68 | converged | 26 |
| Worker | alloc | 通過なし(reps=1 は 1 回通過・1 回超過) | 1 | converged | 2 |
| Worker | allocFull | 通過なし(reps=1 は 1 回通過・1 回超過) | 1 | converged | 2 |
| Durable Object(SQLite) | parse | 544 | 576 | converged | 26 |
| Durable Object(SQLite) | score | 4096 | 上限未検出 | max-reps | 26 |
| Durable Object(SQLite) | alloc | 112 | 120 | converged | 22 |
| Durable Object(SQLite) | allocFull | 36 | 38 | converged | 18 |

##### Durable Object: 1回あたりの CPU の推定

**注意**: 30 秒はドキュメントに書かれている上限の値であり、実測ではない。実測したのは「通過した最大の反復回数」と「超過した最小の反復回数」だけで、以下は上限を 30 秒と仮定したときの目安である(30 秒 ÷ 超過した最小 reps 〜 30 秒 ÷ 通過した最大 reps)。

| 処理 | 1回あたりの CPU(ms) |
|---|---|
| parse | 52 〜 55 |
| score | 不明 〜 7 |
| alloc | 250 〜 268 |
| allocFull | 789 〜 833 |

##### Worker: 超過の後の測定は独立か

- 超過の直後の /ping(処理なし): 11 件中 0 件が 200 以外
- 逆転(以前に通過した reps 以下の reps が失敗): 2 件
- 読み: 超過の直後の /ping はすべて 200(軽い処理は落ちていない)。逆転は、同じ reps で通過と超過が混在している(上限付近の揺らぎ)ことを示す。超過の後に軽い処理まで落ちる、という意味で測定が独立でない証拠は無い。

#### ローカル(workerd)での 1 reps あたり ms(本番の CPU とは異なる目安)

| 実行環境 | 処理 | reps | 試行 | 1 reps あたり ms(小さい順) |
|---|---|---|---|---|
| worker | parse | 10 | 3 | 24.10, 24.50, 25.90 |
| worker | score | 10 | 3 | 0.40, 0.50, 0.50 |
| worker | alloc | 3 | 3 | 134.67, 135.00, 135.67 |
| worker | allocFull | 2 | 3 | 583.00, 587.00, 589.00 |
| durableObject | parse | 10 | 3 | 23.20, 23.30, 23.30 |
| durableObject | score | 10 | 3 | 0.40, 0.50, 0.50 |
| durableObject | alloc | 3 | 3 | 135.00, 138.67, 139.33 |
| durableObject | allocFull | 2 | 3 | 579.50, 590.00, 591.00 |

#### 後片付け

- 結果: OK(接頭辞付きの Worker は残っていない)
- Durable Object の名前空間: removed

#### 注記

- Worker が応答するまで 3 回の /ping を要した
- Durable Object の /do/ping: HTTP 200 {"ok":true,"runtime":"durableObject","sqliteOk":true}
<!-- GENERATED:END -->

## 4. #21 への含意

### 到達性

**事実**: Worker からは race と db が 400 で、ランナーからは5対象とも 200。つまり、現行のスクレイピング(`scrapeRace`)を
**Cloudflare Workers の上でそのまま動かすと、少なくとも race.netkeiba.com と db.netkeiba.com は取得できない。**
nar.netkeiba.com は Worker からは測れていない(race・db の拒否で打ち切ったため。ランナーからは取れる)。

**推測・未確認**:

- 原因が「送信元の IP 範囲」か「Workers の subrequest の特徴」かで、取れる手が変わる。前者なら Workers からの取得は(ヘッダを
  いじっても)難しく、後者ならヘッダ等の調整で通る可能性がある。**未切り分け**
- 構成の選択肢(**決定ではない。#21 の子 Issue で判断する**):
  - 切り分けの追加実験(変数を1つずつ。UA、ヘッダ、取得先ホストごと)
  - netkeiba の取得を Workers の外(ユーザーの PC、GitHub Actions のようなランナー、別の実行環境)で行い、取得結果を Cloudflare に渡す構成。
    今回の結果で「ランナーからは取れる」ことは確認できたが、定時・手動の起動から結果の受け渡しまでの設計は未検討
  - Cloudflare のほかの実行環境は未調査

### CPU

**事実**:

- DO(Free プラン)は、1 リクエストの中で、全券種の配分計算(allocFull)を数十回分(表の maxPassReps)動かせる。**実運用の1レース分は、
  DO の 1 リクエストに十分収まっている**
- 普通の Worker(Free プラン)は、配分計算(alloc / allocFull)を、安定して1回も通せなかった(表のとおり、reps=1 で通過と超過が混在)
- 配分計算を「閲覧側のブラウザの Web Worker で行う」案(#21 の本文にある。#119 で Web Worker 化済み)は、今回の測定の対象外

**推測・未確認**:

- 「30 秒」はドキュメントの値。**DO の上限が Free でも 30 秒であることは、今回の結果と矛盾しないが、30 秒そのものは測っていない**
- DO を使えば、Free のままでも、1 レース分の配分は収まる見込み。ただし、複数レースを1つの DO で順に処理するか、レースごとに分けるか、
  DO の日次の制限(リクエスト数・GB-s)をどれだけ使うかは、未測定
- スクレイピングを Workers の中で行う場合は、別の制約もある(Free の subrequest は 50/呼び出し。`scrapeRace` は 16 頭で戦績 API だけで
  16 本 + 出馬表・オッズなどが要る。机上の見積もりで、今回は測っていない)

## 5. 再現手順

### ワークフローの起動

前提(コードとは別):

- リポジトリの Secrets に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` がある
- トークンの Workers の権限が **Admin(スコープ: Workers product)**。Editor では Worker を作成・削除できない(プリフライトが検出して止まる)
- Cloudflare アカウントの workers.dev のサブドメインが登録済み

起動:

- **作業ブランチへの push で、先端コミットのメッセージの先頭(件名の先頭)を `[CF-SPIKE]` にする。** 本文に書いても、先頭以外に書いても起動しない
  (部分一致にしていた第1ラウンドで、本文の説明に印が含まれて意図せず起動したため、先頭一致にした)。
  または、GitHub の Actions 画面から `Cloudflare 移行スパイク` を `workflow_dispatch` で実行する
- ワークフロー: `.github/workflows/cloudflare-spike.yml`。所要は第2ラウンドで 20 分弱(`startedAt` から `finishedAt` まで。JSON のとおり)。
  実行ごとに Worker を作成し、終了時に必ず削除する。netkeiba へは合計 10 本以内・2 秒間隔

### 結果の取り出しと report の生成(いずれもリポジトリのルートで)

```sh
# 1. ジョブログから、===CF-SPIKE-RESULT-BEGIN=== 〜 ===CF-SPIKE-RESULT-END=== の結果ブロックを切り出して JSON にする
pnpm tsx scripts/cloudflare-spike/render-report.ts extract <job.log> > docs/investigations/cloudflare-spike/round2-result.json

# 2. 結果 JSON から Markdown を作って標準出力へ(確認用)
pnpm tsx scripts/cloudflare-spike/render-report.ts markdown docs/investigations/cloudflare-spike/round2-result.json

# 3. この report.md の「第2ラウンドの結果(自動生成)」節を、結果 JSON から作り直して上書き
pnpm tsx scripts/cloudflare-spike/render-report.ts update \
  docs/investigations/cloudflare-spike/round2-result.json docs/investigations/cloudflare-spike/report.md
```

`pnpm test` には、「`report.md` の生成節が、`round2-result.json` から今の `renderMarkdown` で作った内容と完全に一致する」検査がある
(`scripts/test/cloudflare-spike-report-doc.test.ts`)。結果 JSON か生成器を変えて report を直し忘れると、ここで落ちる。

### ローカルでの確認(Cloudflare・netkeiba に接続しない)

```sh
pnpm exec vitest run scripts/test/cloudflare-spike      # 判定・記録の純ロジックと、ワークフローの静的検査
cd spikes/cloudflare
pnpm install --ignore-workspace --frozen-lockfile        # pnpm workspace の外に独立した依存(wrangler など)
pnpm run typecheck && pnpm run deploy:dry                # 型検査と、core をそのまま Worker に束ねられるかの確認(デプロイしない)
pnpm run smoke                                           # wrangler dev(ローカルの workerd)での配線のスモークテスト
```

## 6. この結果の限界

- 測ったのは1アカウント(Free プラン)・1回の実行(第2ラウンド)。Worker の通過量は、第1ラウンドと第2ラウンドで違う(例: parse の
  通過した最大 reps)。**実行間のばらつきがあり、表の下位の桁に意味は無い**
- ローカル(workerd)の値は、本番の CPU とは別物の目安
- ランナー側の取得は Node の fetch(undici)で、Worker の fetch とは、TLS・HTTP のバージョンなど、送信元以外の差がありうる。
  「変えたのは送信元だけ」と言えるのは、URL・ヘッダ・パース・記録の形の範囲
- netkeiba へのリクエストは、第1ラウンドと第2ラウンドを合わせて最小限に留めた(第2ラウンドは Worker 2 本・ランナー 5 本)
