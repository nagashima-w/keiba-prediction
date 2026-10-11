# Cloudflare 移行スパイク(Issue #159〈#21-A〉・#160〈#21-B〉・#162〈#21-D〉段階1)の結果

#21(分析全体とスマホの画面を Cloudflare へ移す)の前提だった2点を、実際に Cloudflare に Worker をデプロイして測った(#159)。

1. netkeiba は、Cloudflare Workers からのアクセスを受け付けるか
2. 無料(Free)プランの範囲で、処理を組めるか(普通の Worker と、SQLite バックエンドの Durable Object〈以下 DO〉の両方)

1 の答えは「Worker の fetch からは HTTP 400 で取れない」だったので、その原因の切り分けを #160 で行った(**第3ラウンド。§7**)。
その結果(ソケットなら通った)を受けて、取得を **Durable Object の中のソケット**で行えるかを、取得先を広げて測った(#162 段階1。**第4ラウンド。§8**)。

**このファイルの数値は、結果 JSON(第2ラウンドは `round2-result.json`、第3ラウンドは `round3-result.json`、第4ラウンドは `round4-result.json`)から
`scripts/cloudflare-spike/render-report.ts` で生成した節(「第2ラウンドの結果」「7.2 第3ラウンドの結果」「8.2 第4ラウンドの結果」)にある。手で書き写していない。**
生成の節の外にある本文は手で書いたもので、数値を繰り返さず、表を指す。例外として、JSON の個別のサンプルを指して引用した数値には
出所(`cpu.samples[n]`)を添えた。

## 1. 結論(事実と推測を分ける)

**第4ラウンド(#162 段階1。DO の中のソケットでの取得)の結果は §8。** 以下は第2ラウンドの時点の結論で、「測っていない」とした項目の一部は、そこで測った。

### 事実(結果 JSON に記録されていること)

- **Workers → netkeiba**: 第2ラウンドで Worker から取得した race.netkeiba.com(出馬表)と db.netkeiba.com(馬ページ)は、どちらも
  **HTTP 400・本文0バイト**だった(応答ヘッダは `server: cloudflare`、`x-cache: Error from cloudfront`)。第1ラウンドでは
  race のオッズ API も同じ 400 だった。2回連続の拒否で Worker は打ち切ったため、nar.netkeiba.com・db の戦績 API は
  **Worker からは未測定**(第2ラウンドの race のオッズ API も未測定)
- **ランナー(GitHub Actions)→ netkeiba**: 同じ URL・同じヘッダ(User-Agent を含む)・同じ取得コード・同じ記録の形で、
  ランナーの Node から5対象とも **HTTP 200 で、既存パーサが読めた**(応答ヘッダは `server: Apache`、`x-cache: Miss from cloudfront`)。
  EUC-JP の馬ページも文字化けなし。**変えたのは送信元だけ**(Worker か ランナーか)
- **EUC-JP のデコード**: 本番の Worker 内で、`HttpClient`(iconv-lite、`nodejs_compat`)による往復が一致した
- **Durable Object(Free プランと推定。§6)**: CPU 超過は HTTP 500
  `Durable Object exceeded its CPU time limit and was reset.`(`cpu.samples` の超過 10 件すべて)。**重い計算(全券種の配分 = allocFull)が、
  1 リクエストの中で数十回分(下の表の maxPassReps)収まった**。allocFull を1回だけ動かした壁時計は約1秒(`cpu.samples` の DO・allocFull・reps=1。2回とも 1 秒前後)
- **普通の Worker(Free プランと推定。§6)**: 通過する量は DO よりずっと小さい(下の表)。Worker の超過は HTTP 503
- **後片付け**: 接頭辞付きの Worker は残り0件。DO の名前空間も Worker と一緒に消えた(`durableObjectNamespaces: removed`)
- **この実行から取れなかった測定**: 補助に入れた時計(Worker 内の `performance.now()` の差)は、DO では常に 0、普通の Worker でも
  処理の直後(`insideMs`)は常に 0 だった(本番では実行中に I/O が無いと時計が進まない、というドキュメントのとおり)。I/O を挟んだ
  後の値(`afterIoMs`)は、Worker では 0 でない値が出るが、ローカルの値との比が処理によってばらばらで、CPU 時間の代わりにならない

### 推測・未確認(事実ではない)

- **400 の原因は、第2ラウンドの時点では未切り分けだった**(「Cloudflare の送信元 IP の範囲」か、「Workers が subrequest に付ける要素」か)。
  **第3ラウンド(§7)で切り分けを行い、「ヘッダが原因の疑いが強い」という結果になった**(ランナーに、Worker にだけ現れたヘッダを足すと
  拒否され、Cloudflare の送信元から TCP ソケットで取ると通った)。ただし**どのヘッダが効いたかは分離できていない**。
  **データセンター IP 全般ではない**(ランナーもデータセンターの IP で、通った)
- **「30 秒」はドキュメントの値であり、実測ではない。** 測ったのは「通過した最大の反復回数」と「超過した最小の反復回数」だけで、
  上限を 30 秒と仮定すると 1 回あたりの CPU の目安が出る(生成した節の「1回あたりの CPU の推定」。**30 秒を仮定した目安**)
- **普通の Worker の「10 ms」は、この測定では、CPU 時間の単純な打ち切りとしては説明できない。** ローカルの 1 reps あたりの値(生成した節の
  「ローカル(workerd)」)を掛けると、parse は約 200 ms 相当まで通る一方、score は約 30 ms 相当で超過した(概算。ローカルの CPU は
  本番とは違う)。さらに、allocFull を1回動かすだけで約 0.9 秒の壁時計がかかった要求が、1回は 200 で完了し(`cpu.samples[44]`)、
  同じ条件の直後の試行は超過した(`cpu.samples[45]`)。再現性が無いので、**Worker で重い計算を動かす根拠にはならない**。
  機序は調べていない
- 第1ラウンド(`round1.md`)の Worker の測定は、超過の直後に軽い処理まで落ちていた疑いがあり、汚染されていた可能性が高い。
  第2ラウンドでは、超過の直後の `/ping` が(Worker で超過した 11 件すべて)200 だった。**第1ラウンドの現象(超過の後に軽い処理まで落ちる)は
  見られなかった**。ただし、**測定が独立だったとまでは言えない**: 第2ラウンドの Worker には、同じ reps で通過と超過が混在した
  「逆転」が2件ある。これは **`cpu.samples[43]`(alloc・reps=1)と `[45]`(allocFull・reps=1)で、どちらも探索の最小点**であり、
  直前の `[42]`(200・壁時計 337 ms)と `[44]`(200・壁時計 899 ms)では、数百 ms 相当の計算が 10 ms の上限を超えて完了している。
  **この混在の原因は調べていない**(上限付近のばらつきとは読めない)

## 2. 実行の概要

| | 第1ラウンド | 第2ラウンド |
|---|---|---|
| 記録 | [`round1.md`](./round1.md)(メインがジョブログから転記) | [`round2-result.json`](./round2-result.json)(結果ブロックをログからプログラムで切り出したもの) |
| run | GitHub Actions run 37182126251 | GitHub Actions run 37184397455(結果 JSON の `runId` は `37184397455-1`) |
| コード | 0c47222(**意図せず起動した**。コミットメッセージの本文に起動の印が含まれ、当時の部分一致の条件が成立した) | 20f2746(ワークフローは 63714cc) |
| 変えたこと | — | Worker に加え、ランナーからも同じ対象を取得(対照)。netkeiba への合計 10 本以内・2 秒間隔・送信元ごとの2回連続拒否で打ち切り。削除は API の DELETE を主に |
| 日時(UTC) | 2026-10-04 06:12〜06:28 | 上の JSON の `startedAt` / `finishedAt` |

第1ラウンドの結果(Worker から race が 400 など)は `round1.md` を参照。第2ラウンドの Worker の拒否は第1ラウンドと同じ形で、
ランナーとの対照で「送信元の違い」に絞れた。**第3ラウンド(#160。400 の原因の切り分け)は §7**(結果 JSON は
[`round3-result.json`](./round3-result.json))。**第4ラウンド(#162 段階1。DO の中のソケットでの取得)は §8**(結果 JSON は
[`round4-result.json`](./round4-result.json))。

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
- 逆転の内訳: worker/alloc: reps=1 で超過(以前に reps=1 が通過)、worker/allocFull: reps=1 で超過(以前に reps=1 が通過)
- 読み: 超過の直後の /ping はすべて 200(軽い処理は落ちていない)。逆転は、同じ reps で通過と超過が混在していることを示す(原因は未調査)。超過の後に軽い処理まで落ちる、という意味では独立でない証拠は無いが、測定が独立だったとまでは言えない。

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

**事実**: Worker から測った対象のうち、race の出馬表・race のオッズ API(第1ラウンド)・db の馬ページは 400 で、ランナーからは5対象とも 200。
**測った範囲では**、現行のスクレイピング(`scrapeRace`)を Cloudflare Workers の上でそのまま動かしても、race.netkeiba.com と
db.netkeiba.com の馬ページは取得できなかった。db の戦績 API と nar.netkeiba.com は Worker からは測れていない
(race・db の拒否で打ち切ったため。ランナーからは取れる)。

**第3ラウンド(#160)の結果を踏まえた更新**: 原因の切り分けの結果(§7)は「ヘッダが原因の疑いが強い」で、**Worker の TCP ソケット
(`cloudflare:sockets`)からは、race の出馬表と db の馬ページ(EUC-JP)を取れた**。つまり、**測った範囲では**、Workers の `fetch` ではなく
ソケットで取れば、Cloudflare の上で netkeiba を取得できる(詳細・限界は §7)。

**推測・未確認**:

- 第2ラウンドの時点では「送信元の IP 範囲」か「Workers の subrequest の特徴」か未切り分けだったが、第3ラウンドで、**送信元(Cloudflare の IP)
  だけでは拒否されない**(ソケットなら通った)ことと、**ランナーでも Worker にだけ現れたヘッダを足すと拒否される**ことが分かった。
  ただし、どのヘッダが効くか、`fetch` の TLS・HTTP バージョンが関与するかは**分離できていない**(§7.5)
- 構成(**ユーザーの決定。2026-10-05**): 取得・計算・保存・画面まで全部 Cloudflare で進める。取得は **DO の中から TCP ソケット**で行う。
  この決定に使う根拠のうち、**測っていないもの**: DO の中からの `connect()`(今回の E3 は普通の Worker のハンドラからのソケット)、
  db の戦績 API・nar.netkeiba.com・race のオッズ API のソケットでの取得、繰り返し・長時間使ったときの再現性(1回の実行のみ)。
  (**第4ラウンド〈§8。#162 段階1〉で、DO の中からのソケット・db の戦績 API・nar・race のオッズ API・繰り返し取得〈再現性〉を測った。
  なお測っていないものは §8.5**)
- 以前の選択肢のうち、「netkeiba の取得を Workers の外(ユーザーの PC、GitHub Actions のようなランナー)で行う構成」は、上の決定では採っていない。
  「Cloudflare のほかの実行環境」は未調査のまま

### CPU

**事実**:

- DO(Free プランと推定。§6)は、1 リクエストの中で、全券種の配分計算(allocFull)を数十回分(表の maxPassReps)動かせる。**中央16頭・実オッズの
  1レース分(測った入力)は、DO の 1 リクエストに十分収まっている。18頭など、ほかの入力は未測定**
- 普通の Worker(Free プランと推定。§6)は、配分計算(alloc / allocFull)を、安定して1回も通せなかった(表のとおり、reps=1 で通過と超過が混在)
- 配分計算を「閲覧側のブラウザの Web Worker で行う」案(#21 の本文にある。#119 で Web Worker 化済み)は、今回の測定の対象外

**推測・未確認**:

- 「30 秒」はドキュメントの値。**DO の上限が Free でも 30 秒であることは、今回の結果と矛盾しないが、30 秒そのものは測っていない**
- DO を使えば、Free と推定されるアカウントのままでも、1 レース分(中央16頭)の配分は収まる見込み。ただし、複数レースを1つの DO で順に処理するか、レースごとに分けるか、
  DO の日次の制限(リクエスト数・GB-s)をどれだけ使うかは、未測定
- スクレイピングを Workers の中で行う場合は、別の制約もある(Free の subrequest は 50/呼び出し。`scrapeRace` は 16 頭で戦績 API だけで
  16 本 + 出馬表・オッズなどが要る。机上の見積もりで、今回は測っていない)

## 5. 再現手順

### ワークフローの起動

前提(コードとは別):

- リポジトリの Secrets に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` がある
- トークンの Workers の権限が **Admin(スコープ: Workers product)**。Editor では Worker を作成・削除できない(プリフライトが検出して止まる)
- Cloudflare アカウントの workers.dev のサブドメインが登録済み

起動(**実験の選び方は #160 で変わり、既定は #162 で `origin` から `socket-matrix` に変わった**。既定は `socket-matrix`):

- ワークフロー: `.github/workflows/cloudflare-spike.yml`。測定ステップの環境変数 `SPIKE_EXPERIMENTS` で、実行する実験を選ぶ:
  - `socket-matrix`(#162 段階1。DO の中のソケットでの取得。取得先の網羅・gzip・再現性。netkeiba へ 9 本。ほかに netkeiba へ出ない、
    Worker から DO を繰り返し呼ぶ試験がある)
  - `origin`(#160。400 の原因の切り分け E0〜E3。netkeiba へ 6 本。ほかに netkeiba へ出ないエコーが最大 4 回)
  - `reachability`(#159 第2ラウンドの到達性。5対象 × Worker・ランナー。netkeiba へ 10 本)
  - `cpu`(CPU 上限の探索。netkeiba へは出ない)
  - カンマ区切りで複数を選べる(例: `socket-matrix,cpu`、`reachability,cpu`、`origin,cpu`)。**netkeiba へ出る3実験(`socket-matrix`・`origin`・`reachability`)は、どの2つも同時に選べない**(netkeiba への合計 10 本以内の守りのため、ドライバが拒否する。本数の定義は `scripts/cloudflare-spike/experiments.ts`)。
    未設定・空・未知の名前もエラーで、何も測らずに失敗する
- **作業ブランチへの push**(先端コミットのメッセージの先頭〈件名の先頭〉が `[CF-SPIKE]`)で起動すると、**入力が空なので `socket-matrix` になる**
  (`${{ inputs.experiments || 'socket-matrix' }}`。#162 で `origin` から変更した。完了済みの `origin` の6本を、印付きの push で再実行しないため)。
  本文に書いても、先頭以外に書いても起動しない
  (部分一致にしていた第1ラウンドで、本文の説明に印が含まれて意図せず起動したため、先頭一致にした)
- **`workflow_dispatch`(Actions 画面から `Cloudflare 移行スパイク` を手動実行)**では、入力 `experiments`(既定 `socket-matrix`)で選ぶ。
  #159 の第2ラウンドと同じ測定をやり直すには、`reachability`(CPU も測るなら `reachability,cpu`)を指定する。
  入力は env 経由でだけ使い、シェルには直接展開しない(スクリプト注入の防止。静的テストで固定している)
- 所要は、`socket-matrix` は約 19 秒(第4ラウンドの JSON の `startedAt` から `finishedAt` まで)、`origin` は短い(第3ラウンドの JSON のとおり)。
  第2ラウンドは、CPU の探索を含めて 20 分弱(JSON のとおり)。実行ごとに Worker を作成し、終了時に必ず削除する。netkeiba へは合計 10 本以内・2 秒間隔

### 結果の取り出しと report の生成(いずれもリポジトリのルートで)

```sh
# 1. ジョブログから、===CF-SPIKE-RESULT-BEGIN=== 〜 ===CF-SPIKE-RESULT-END=== の結果ブロックを切り出して JSON にする
pnpm tsx scripts/cloudflare-spike/render-report.ts extract <job.log> > docs/investigations/cloudflare-spike/round2-result.json

# 2. 結果 JSON から Markdown を作って標準出力へ(確認用)
pnpm tsx scripts/cloudflare-spike/render-report.ts markdown docs/investigations/cloudflare-spike/round2-result.json

# 3. この report.md の「第2ラウンドの結果(自動生成)」節を、結果 JSON から作り直して上書き
pnpm tsx scripts/cloudflare-spike/render-report.ts update \
  docs/investigations/cloudflare-spike/round2-result.json docs/investigations/cloudflare-spike/report.md

# 4. 第3ラウンド(#160)の節は、末尾に節の名前 round3 を付ける(見出しは1段深く置くので3段下げる)
pnpm tsx scripts/cloudflare-spike/render-report.ts update \
  docs/investigations/cloudflare-spike/round3-result.json docs/investigations/cloudflare-spike/report.md round3

# 5. 第4ラウンド(#162 段階1)の節は、末尾に節の名前 round4 を付ける(同じく3段下げる)
pnpm tsx scripts/cloudflare-spike/render-report.ts update \
  docs/investigations/cloudflare-spike/round4-result.json docs/investigations/cloudflare-spike/report.md round4
```

`pnpm test` には、「`report.md` の生成節が、結果 JSON(第2ラウンドは `round2-result.json`、第3・第4ラウンドは `round3-result.json`・`round4-result.json`)から
今の `renderMarkdown` で作った内容と完全に一致する」検査がある(`scripts/test/cloudflare-spike-report-doc.test.ts`)。
結果 JSON か生成器を変えて report を直し忘れると、ここで落ちる。

### ローカルでの確認(Cloudflare・netkeiba に接続しない)

```sh
pnpm exec vitest run scripts/test/cloudflare-spike      # 判定・記録の純ロジックと、ワークフローの静的検査
cd spikes/cloudflare
pnpm install --ignore-workspace --frozen-lockfile        # pnpm workspace の外に独立した依存(wrangler など)
pnpm run typecheck && pnpm run deploy:dry                # 型検査と、core をそのまま Worker に束ねられるかの確認(デプロイしない)
pnpm run smoke                                           # wrangler dev(ローカルの workerd)での配線のスモークテスト
```

## 6. この結果の限界

- 測ったのは1アカウント・1回の実行(第2ラウンド)。**プランはスパイクで確認していない**(結果の表の「Free」は、ユーザーの申告と、観測された傾向〈Worker は小さい量で超過し、DO は1リクエストで数十秒規模の計算が通る〉からの推定)。Worker の通過量は、第1ラウンドと第2ラウンドで違う(例: parse の
  通過した最大 reps)。**実行間のばらつきがあり、表の下位の桁に意味は無い**
- ローカル(workerd)の値は、本番の CPU とは別物の目安
- ランナー側の取得は Node の fetch(undici)で、Worker の fetch とは、TLS・HTTP のバージョンなど、送信元以外の差がありうる。
  「変えたのは送信元だけ」と言えるのは、URL・ヘッダ・パース・記録の形の範囲
- netkeiba へのリクエストは、第1ラウンドと第2ラウンドを合わせて最小限に留めた(第2ラウンドは Worker 2 本・ランナー 5 本)
- 第3ラウンド(#160)の限界は §7.5 と §7.6。測ったのは1回の実行で、E0・E2・E3 の標本は小さい(各実験の対象は1〜2対象)

## 7. 第3ラウンド(Issue #160〈#21-B〉): Worker からの 400 の原因の切り分け

§1 のとおり、Worker の `fetch` からは race・db が HTTP 400 になり、ランナーからは同じ URL・同じヘッダで取れた。この差の原因が
(a) Workers の fetch がサブリクエストに付けるヘッダ、(b) 送信元の IP(Cloudflare の範囲)、(c) User-Agent などリクエストの
中身との組み合わせ、のどれかを、変数を1つずつ動かして調べた。

- **E0 基準の再確認**: race の出馬表を、Worker の `fetch` とランナーの `fetch` から1本ずつ(第2ラウンドと同じ 400 / 200 の再現)
- **E1 ヘッダの観測(netkeiba へは出ない)**: Worker とランナーの `fetch` から、受け取ったヘッダをそのまま返すエコー
  (tls.peet.ws。失敗したら httpbin.org)を叩き、届いたヘッダの差を記録する
- **E2 ランナー + Workers 風のヘッダ → netkeiba**: 送信元はランナーのまま、E1 で **Worker にだけ現れたヘッダ**を足して取得する
  (race と db の馬ページ)。変えるのはヘッダだけ
- **E3 Worker の TCP ソケット → netkeiba**: 送信元は Cloudflare のまま、`cloudflare:sockets` の `connect()`(TLS)で HTTP/1.1 の GET を
  自前で組み立てて送る(race と db の馬ページ)。ヘッダは**ランナーの `fetch` の観測から導出したもの**
  (`User-Agent`・`accept`・`accept-language`・`sec-fetch-mode`)。ランナーの観測にある `accept-encoding` と `connection` は**送っていない**
  (`Accept-Encoding` は送らず**圧縮なしで取り**、`Connection: close` で EOF まで読む。`Host` は自前で付ける)。
  再試行・リダイレクトの追従はしない

結論の型(組合せ表と、E0 の再現を前提ゲートにする規則)は `scripts/cloudflare-spike/origin-plan.ts` の `concludeOrigin`
(単体テストで固定)。守りは #159 と同じ(netkeiba へ合計 10 本以内・2 秒間隔・送信元〈場所:手段〉ごとの2回連続拒否で打ち切り)。

### 7.1 実行の概要

| | 第3ラウンド |
|---|---|
| 記録 | [`round3-result.json`](./round3-result.json)(結果ブロックをジョブログからプログラムで切り出したもの。値は変えていない) |
| run | GitHub Actions run 37349098565(結果 JSON の `runId` は `37349098565-1`) |
| コード | 83ad5dd(実測を起動したコミットは 7ae15a3。起動の印は件名の先頭) |
| 選んだ実験 | `origin`(結果 JSON の `experiments`) |
| 日時(UTC) | 上の JSON の `startedAt` / `finishedAt` |

### 7.2 第3ラウンドの結果(自動生成)

以下は `round3-result.json` から生成した節。再生成のコマンドは「5. 再現手順」。

<!-- GENERATED:BEGIN round3(render-report.ts が生成。手で編集しない) -->
#### Cloudflare 移行スパイク結果(run 37349098565-1)

- 開始: 2026-10-05T17:32:24.174Z / 終了: 2026-10-05T17:32:39.918Z
- 実行した実験: origin

##### 到達性(netkeiba への取得。Worker とランナーの対照)

未実施(この実行では選んでいない)

##### 400 の原因の切り分け(Issue #160。E0〜E3)

- netkeiba へ出した本数: 6 本 / 全体の打ち切り理由: なし
- 送信元(場所:手段)ごとの打ち切り: worker:fetch: なし / runner:fetch: なし / runner:fetch+worker-headers: consecutive-blocks / worker:socket: なし
- エコーへ出した回数(netkeiba の本数には含めない): 2 回

###### E1 ヘッダの観測(netkeiba へは出ない)

- 両側で取れたエコー: peet
- 警告: エコー(peet)の応答に Cloudflare 上にある疑い(cf-ray または server: cloudflare)があった(worker 側)。Workers の振る舞いが CloudFront 宛てと変わりうる

| 試行 | 場所 | エコー | 結果 | ステータス | 理由 |
|---|---|---|---|---|---|
| 1 | worker | peet | 成功 | 200 | - |
| 2 | runner | peet | 成功 | 200 | - |

| 場所 | エコー | HTTP バージョン | TLS の JA4 | HTTP/2 の Akamai 指紋 |
|---|---|---|---|---|
| worker | peet | h2 | t13d1312h2_a44d0ee8b3cc_e381dae6da6b | 175a6d4585f5a5c52b0f6fcca2977cd0 |
| runner | peet | HTTP/1.1 | t13d5212h1_b262b3658495_8e6e362c5eac | - |

- Worker にだけ現れたヘッダ: x-forwarded-for: <ip> / cf-ray: <ray>-ATL / cf-ew-via: 15 / cdn-loop: cloudflare; loops=1 / cf-worker: <subdomain>.workers.dev / cf-visitor: {"scheme":"https"} / x-forwarded-proto: https
- ランナーにだけ現れたヘッダ: connection, accept, accept-language, sec-fetch-mode
- 名前は同じで値が違うヘッダ: accept-encoding(worker: gzip, br / runner: br, gzip, deflate)

###### E0・E2・E3 の記録

| 実験 | 場所 | 手段 | 対象 | ステータス | 本文バイト | パース | 判定 | 理由 |
|---|---|---|---|---|---|---|---|---|
| E0 | worker | fetch | central-shutuba | 400 | 0 | 未実施 | blocked | HTTPエラー(400)が発生しました: https://race.netkeiba.com/race/shutuba.html?race_id=202603020211 |
| E0 | runner | fetch | central-shutuba | 200 | 276708 | shutuba 16 件 | ok | HTTP 200、既存パーサで 16 件を読めました |
| E3 | worker | socket | central-shutuba | 200 | 276708 | shutuba 16 件 | ok | HTTP 200、既存パーサで 16 件を読めました |
| E3 | worker | socket | db-horse-page | 200 | 83984 | horse-page 1 件 | ok | HTTP 200、既存パーサで 1 件を読めました |
| E2 | runner | fetch+worker-headers | central-shutuba | 400 | 0 | 未実施 | blocked | HTTPエラー(400)が発生しました: https://race.netkeiba.com/race/shutuba.html?race_id=202603020211 |
| E2 | runner | fetch+worker-headers | db-horse-page | 400 | 0 | 未実施 | blocked | HTTPエラー(400)が発生しました: https://db.netkeiba.com/horse/2021105857/ |

###### E2 ランナー + Workers 風のヘッダ → netkeiba

- 付けたヘッダ(Worker が実際に付けた名前。値はマスク済み): x-forwarded-for: <ip> / cf-ray: <ray>-ATL / cf-ew-via: 15 / cdn-loop: cloudflare; loops=1 / cf-worker: <subdomain>.workers.dev / cf-visitor: {"scheme":"https"} / x-forwarded-proto: https

###### E3 Worker の TCP ソケット → netkeiba

- 送ったヘッダ(Host と Connection: close に加えて): User-Agent, accept, accept-language, sec-fetch-mode / 導出元: ランナーの観測から導出(E1)

###### 結論

- 基準(E0)の再現: はい(Worker の fetch は拒否、ランナーの fetch は ok)
- E2(ランナー + Workers 風のヘッダ): 拒否された(bad)
- E3(Worker のソケット): 通った(good)
- 結論: **ヘッダが原因の疑いが強い**
- 読み: ヘッダが原因の疑いが強い(送信元をランナーのまま、Workers 風のヘッダを付けただけで拒否された)。
- 限界:
  - E2 は送信元(ランナー)を変えずに、Worker にだけ現れたヘッダをまとめて足した実験で、拒否された。どのヘッダ(CF-Worker・CF-Connecting-IP・CDN-Loop など)が効いたかは分離できない。
  - 各実験の対象は2対象(race の出馬表と db の馬ページ。E0 は race の1対象)で、標本が小さい。
  - E1 はエコーサービス宛ての Worker の fetch が見せるヘッダ・TLS であり、CloudFront 宛てでも同じとは限らない。

##### EUC-JP のデコード(Worker 内の往復)

成功(往復一致)

##### CPU(反復回数を増やして上限超過になる点を探索)

未実施(この実行では選んでいない)

##### ローカル(workerd)での 1 reps あたり ms(本番の CPU とは異なる目安)

| 実行環境 | 処理 | reps | 試行 | 1 reps あたり ms(小さい順) |
|---|---|---|---|---|
| worker | parse | 10 | 3 | 16.20, 17.40, 18.80 |
| worker | score | 10 | 3 | 0.20, 0.20, 0.30 |
| worker | alloc | 3 | 3 | 68.00, 68.33, 68.33 |
| worker | allocFull | 2 | 3 | 257.50, 258.00, 259.50 |
| durableObject | parse | 10 | 3 | 16.50, 16.80, 17.20 |
| durableObject | score | 10 | 3 | 0.20, 0.20, 0.20 |
| durableObject | alloc | 3 | 3 | 67.33, 67.33, 67.33 |
| durableObject | allocFull | 2 | 3 | 258.00, 262.50, 267.50 |

##### 後片付け

- 結果: OK(接頭辞付きの Worker は残っていない)
- Durable Object の名前空間: removed

##### 注記

- Worker が応答するまで 2 回の /ping を要した
- Durable Object の /do/ping: HTTP 200 {"ok":true,"runtime":"durableObject","sqliteOk":true}
<!-- GENERATED:END round3 -->

### 7.3 事実(結果 JSON に記録されていること)

- **E0 は再現した**: 同じ実行の中で、Worker の `fetch` は race の出馬表が HTTP 400・本文0バイト(`x-cache: Error from cloudfront`)、
  ランナーの `fetch` は 200 で既存パーサが読めた
- **E1(エコーは tls.peet.ws。Worker・ランナーの両側で取れ、httpbin へのフォールバックは使っていない)**:
  - **Worker にだけ現れたヘッダは7つ**: `x-forwarded-for`・`cf-ray`・`cf-ew-via`・`cdn-loop`・`cf-worker`・`cf-visitor`・`x-forwarded-proto`
    (値は生成節の「Worker にだけ現れたヘッダ」。IP・サブドメインはマスク済み)
  - ランナーにだけ現れたヘッダは `connection`・`accept`・`accept-language`・`sec-fetch-mode`。名前は同じで値が違うのは `accept-encoding`
  - **`cf-connecting-ip` と `x-real-ip` は、Worker 側の観測に無かった**(Cloudflare のドキュメント
    〈<https://developers.cloudflare.com/fundamentals/reference/http-headers/>。2026-10-04 に参照。要約で読んだもので、原文の引用は保存していない〉
    には、非 Cloudflare 宛ての subrequest に付くとあるが、エコーに届いたヘッダには無かった。エコー宛ての観測であり、netkeiba 宛てでの有無は未確認)
  - **HTTP バージョンと TLS の指紋は、両側で違った**(Worker は HTTP/2、ランナーは HTTP/1.1。JA4 も違う。生成節の表のとおり)
- **E2(ランナー + Worker にだけ現れたヘッダ7つ)は、race・db の馬ページとも HTTP 400・本文0バイト**(`x-cache: Error from cloudfront`)だった。
  E2 の送信元はランナーのままで、E0 のランナー(ヘッダを足さない)は 200 だった
- **E3(Worker の TCP ソケット)は、race の出馬表・db の馬ページ(EUC-JP)とも HTTP 200 で、既存パーサが読めた**(出馬表は16頭、
  馬ページは1件。文字化けなし)。出馬表の本文バイト数は、E0 のランナーの `fetch` と同じだった。ヘッダの導出元はランナーの観測(`runner-echo`)で、
  静的フォールバックは使っていない
- 守り: netkeiba へ出したのは6本(上限 10 本以内)、エコーは2回。E2 の2本がどちらも 400 だったので、送信元
  `runner:fetch+worker-headers` は連続拒否として記録された(2本で終わる計画なので、止められた送信は無い)
- 後片付け: 接頭辞付きの Worker は残り0件、DO の名前空間も removed(生成節のとおり)

### 7.4 推測・未確認(事実ではない)

- **結論の読み(`header-suspected`:「ヘッダが原因の疑いが強い」)は推測を含む。** E2 が拒否されたことは、「Worker にだけ現れたヘッダの追加が、
  ランナー(拒否されない送信元・手段)からでも拒否を起こすのに十分だった」ことを示す。E3 が通ったことは、「送信元(Cloudflare の IP)だけでは
  拒否されない」ことを示す。これらを合わせて「ヘッダが原因」と読んでいるが、**どのヘッダが効いたかは分かっていない**。`cdn-loop` や
  `cf-worker` などが関与する、という見方もできるが、**これは仮説であり、検証していない**
- **E1 の `warnings`(「エコー(peet)の応答に Cloudflare 上にある疑い」。Worker 側のみ)について**: 警告が出たのは、Worker の `fetch` の
  応答に `cf-ray`(または `server: cloudflare`)があったため。ランナー側の同じエコーの応答には無かった。**エコーが Cloudflare 上にあるのではなく、
  Worker の `fetch` の応答に Cloudflare が付けたヘッダを拾った可能性が高い、と推測している**(E0 の Worker の 400 の応答にも、
  `server: cloudflare` と `cf-ray` があり、ランナーとソケットの応答は `server: Apache` だった)。**確認はしていない**。
  ローカル(Cloudflare を経由しない場所)の `curl -sS -D - -o /dev/null https://tls.peet.ws/api/all` の応答ヘッダは、`server: TrackMe.peet.ws` で
  `cf-ray` は無かった(2026-10-04 に見たときの**一次データは保存していない**。2026-10-06 に同じコマンドを再実行して、同じだった)
- E2 の 400 の応答の `server` は `Apache`(ランナーの 200 と同じ)で、E0 の Worker の 400 の `server: cloudflare` とは違う。
  この違いの意味は調べていない
- E3 が通った機序(「Worker の `fetch` の経路に入る Cloudflare 側の仕組み〈`cdn-loop: cloudflare; loops=1`・`cf-ew-via` が示唆する〉を
  ソケットは通らない」など)は、**推測であり、検証していない**
- netkeiba(CloudFront)の拒否規則が今後も同じかどうかは未確認(1回の実行のみ)

### 7.5 分離できないもの(結論を読むときの注意)

- **E2 は7つのヘッダをまとめて足した**。どれが効いたか、組合せが必要か(1つでは足りないか)は**分離できない**
- **E2 で付けた値は、Worker が(エコー宛てに)送った値の再利用**である(`x-forwarded-for` はそのときの IP、`cf-ray` は別の接続の ID)。
  拒否の原因が「ヘッダがあること」か「値が実際の接続と食い違うこと」かは**分離できない**
- **E3 は、ヘッダ・TLS の特徴・HTTP バージョン・圧縮の有無を同時に変えている**(Worker の `fetch` が付ける7つのヘッダが無い・`fetch` の TLS ではない・
  HTTP/1.1 を自前で話す・**`accept-encoding` を送らず圧縮なしで取っている**〈`fetch` は圧縮を要求する。ランナーの観測にも `accept-encoding` はあるが、
  E3 では送っていない〉・`connection` は `keep-alive` ではなく `close`)。**これらも `fetch` との差分の一つ**で、E3 が通った理由が、
  このうちどれかは**分離できない**。E2 が「ヘッダの追加だけで拒否される」ことを示すので
  ヘッダが原因という読みになるが、E3 単独ではヘッダと TLS・HTTP バージョンを区別できない。**E3 のソケットの TLS の指紋は観測していない**
  (エコーは `fetch` でしか叩いていない)
- **E1 は、エコー(第三者のサーバ)宛ての観測**で、Worker が netkeiba へ実際に送るヘッダを見たものではない。**エコーに届いたヘッダを、
  netkeiba 宛ての代理として使っている**(CloudFront 宛てでも同じとは限らない)。E2 で足したヘッダも、この代理の観測に基づく

### 7.6 この結果の限界

- 測ったのは1アカウント・1回の実行。E0 は race の1対象、E2・E3 は race と db の馬ページの2対象で、標本が小さい
- ソケットで測ったのは、race の出馬表と db の馬ページ(EUC-JP)だけ。**db の戦績 API・nar.netkeiba.com・race のオッズ API はソケットでは未測定**
- E3 は**普通の Worker のハンドラから**のソケット。**DO の中からの `connect()` は未測定**
- プランは確認していない(§6 と同じ Secrets のアカウントで、§6 では「Free と推定」した)。Cloudflare のドキュメント
  (<https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/>。2026-10-04 に参照)には、Free でソケットが
  使えるかの記載が見当たらなかったので、今回の E3 の成功は、**Free と推定されるアカウントでソケットが使えた**ことを示す(プランそのものは未確認)
- ソケットで取る HTTP/1.1 のクライアント(`scripts/cloudflare-spike/http1.ts`・`spikes/cloudflare/src/socket-probe.ts`)は、スパイクの実装で、
  本番コードではない。chunked・Content-Length・EOF の扱いは単体テストで固定してあるが、**長時間・多数の取得での挙動は未測定**
- ドキュメント(<https://developers.cloudflare.com/workers/platform/limits/>。2026-10-04 に参照。要約で読んだもので、原文の引用は保存していない)
  では、ソケットは「同時に応答ヘッダを待つ接続 6 本」の上限に数えられる。subrequest 数(Free は 50/呼び出し)に数えられるかは確認していない

### 7.7 #21 への含意

**事実**: **測った範囲では**、Workers の `fetch` ではなく TCP ソケット(`cloudflare:sockets`)で取得すれば、Cloudflare の上で race の出馬表と
db の馬ページ(EUC-JP)を取得でき、既存パーサ(`parseShutuba`・馬ページのパーサ)で読めた。

**ユーザーの決定(2026-10-05)**: 取得・計算・保存・画面まで全部 Cloudflare で進める。取得は DO の中から TCP ソケットで行う。

**この決定に残る未測定**(子 Issue の仕様を詰めるときに、実測が要る): 上の「この結果の限界」のうち、DO の中からのソケット、ほかの取得先
(db の戦績 API・nar・オッズ API)、繰り返し取得したときの再現性、subrequest・接続数の制約。
(**第4ラウンド〈§8。#162 段階1〉で、DO の中からのソケット・ほかの取得先の一部・繰り返し取得・`accept-encoding` を付けた場合を測った。**
測ったもの・測っていないものは §8.5。)

**本番の取得で守ること**(スパイクの実装から引き継ぐ前提): 再試行しない・リダイレクトに従わない・サイズ上限とタイムアウトを設ける・
ヘッダは明示した集合だけを送る(ランナーの `fetch` の観測から導出した集合
(`User-Agent`・`accept`・`accept-language`・`sec-fetch-mode`)を、`accept-encoding` なし・`Connection: close` で送ったときに通った)。
**`accept-encoding` を付けた場合に通るかは未測定**(圧縮を要求した応答の解凍も、スパイクの実装は扱っていない)。
どのヘッダが拒否の原因かは分かっていないので、Worker の `fetch` で取得する経路は、本番に持ち込まない。

## 8. 第4ラウンド(Issue #162〈#21-D〉段階1): DO の中のソケットでの取得

§7 のとおり、通常の Worker のハンドラからのソケットなら、race の出馬表と db の馬ページが取れた。本番(#21)では、取得を **Durable Object(DO)の
中**からソケットで行い、netkeiba への間隔制御もそこで一本化する方針(ユーザーの決定 2026-10-05)なので、その前提を、取得先を広げて測った
(`socket-matrix`。選んだ実験は結果 JSON の `experiments`)。変えるのは取得の場所(通常の Worker → DO)と、最後の2本の `Accept-Encoding: gzip` だけで、
送るヘッダは §7 の E3 と同じ4つ(`User-Agent`・`accept`・`accept-language`・`sec-fetch-mode`)。

- 取得先(netkeiba へ 9 本。上限 10 本以内): race の出馬表・単勝複勝オッズ API・三連複オッズ API、db の戦績 API、nar の出馬表・オッズページ(単勝複勝)、
  さらに出馬表の2回目(再現性)、出馬表と三連複の gzip 版(`Accept-Encoding: gzip` を足した版)。計画の順序・対象は
  `scripts/cloudflare-spike/socket-matrix-plan.ts`(単体テストで固定)
- 守りは #159・#160 と同じ(2 秒間隔・2回連続の 400/403/429 で打ち切り。ただし今回は送信元をまたいだ全体で数える)。再試行・リダイレクトの追従はしない
- このほかに、netkeiba へ出ない試験として、Worker から DO を 60 回呼び、呼び出し側の subrequest の数え方(Free は 50/呼び出し)を見た

### 8.1 実行の概要

| | 第4ラウンド |
|---|---|
| 記録 | [`round4-result.json`](./round4-result.json)(結果ブロックをジョブログからプログラムで切り出したもの。値は変えていない) |
| run | GitHub Actions run 37455078310(結果 JSON の `runId` は `37455078310-1`) |
| コード | 139171c(実測を起動したコミットは a1b17fe。起動の印は件名の先頭) |
| 選んだ実験 | `socket-matrix`(結果 JSON の `experiments`) |
| 日時(UTC) | 上の JSON の `startedAt` / `finishedAt` |

### 8.2 第4ラウンドの結果(自動生成)

以下は `round4-result.json` から生成した節。再生成のコマンドは「5. 再現手順」。

<!-- GENERATED:BEGIN round4(render-report.ts が生成。手で編集しない) -->
#### Cloudflare 移行スパイク結果(run 37455078310-1)

- 開始: 2026-10-06T11:15:08.134Z / 終了: 2026-10-06T11:15:27.557Z
- 実行した実験: socket-matrix

##### 到達性(netkeiba への取得。Worker とランナーの対照)

未実施(この実行では選んでいない)

##### DO の中のソケットでの取得(Issue #162 段階1。socket-matrix)

- netkeiba へ出した本数: 9 本(計画 9 本)
- 打ち切り: なし
- DO のインスタンス: 記録全体で異なる ID は 1 個(呼び出し通番の最大は 9)

###### 取得先ごとの記録

| ステップ | 対象 | 方式 | ステータス | 本文バイト(展開後) | パース | 判定 | DO(インスタンス #通番) | 時間 ms(opened / 最初のバイト / 全体) | 理由 |
|---|---|---|---|---|---|---|---|---|---|
| S1 | central-shutuba | identity | 200 | 276742 | shutuba 16 件 | ok | f29353f4 #1 | 37 / 306 / 431 | HTTP 200、既存パーサで 16 件を読めました |
| R1 | db-horse-results | identity | 200 | 140135 | horse-results 26 件 | ok | f29353f4 #2 | 42 / 291 / 292 | HTTP 200、既存パーサで 26 件を読めました |
| N1 | nar-shutuba | identity | 200 | 218738 | shutuba 12 件 | ok | f29353f4 #3 | 33 / 309 / 438 | HTTP 200、既存パーサで 12 件を読めました |
| O1 | central-odds | identity | 200 | 890 | odds-json 16 件 | ok | f29353f4 #4 | 11 / 155 / 155 | HTTP 200、既存パーサで 16 件を読めました |
| T1 | central-trio-odds | identity | 200 | 17856 | combo-trio-json 560 件 | ok | f29353f4 #5 | 9 / 177 / 177 | HTTP 200、既存パーサで 560 件を読めました |
| N2 | nar-odds-page | identity | 200 | 56459 | nar-odds-page 12 件 | ok | f29353f4 #6 | 39 / 230 / 231 | HTTP 200、既存パーサで 12 件を読めました |
| S1r | central-shutuba | identity | 200 | 276742 | shutuba 16 件 | ok | f29353f4 #7 | 11 / 408 / 536 | HTTP 200、既存パーサで 16 件を読めました |
| S1g | central-shutuba | gzip | 200 | 276742 | shutuba 16 件 | ok | f29353f4 #8 | 11 / 294 / 422 | HTTP 200、既存パーサで 16 件を読めました |
| T1g | central-trio-odds | gzip | 200 | 17856 | combo-trio-json 560 件 | ok | f29353f4 #9 | 13 / 193 / 193 | HTTP 200、既存パーサで 560 件を読めました |

###### gzip の比較(identity との対)

| ステップ | 対 | ステータス(identity / gzip) | 線上の本文バイト(identity / gzip) | 展開後バイト(gzip) | 比率(gzip / identity) | 全体 ms(identity / gzip) | 最初のバイト ms(identity / gzip) | 本文のハッシュ | 圧縮(content-encoding) |
|---|---|---|---|---|---|---|---|---|---|
| S1g | S1 | 200 / 200 | 276742 / 276742 | 276742 | 1 | 431 / 422 | 306 / 294 | 一致 | 圧縮されなかった |
| T1g | T1 | 200 / 200 | 17856 / 17856 | 17856 | 1 | 177 / 193 | 177 / 193 | 一致 | 圧縮されなかった |

###### 再現性(同じ URL を間隔を空けて2回)

| ステップ | 対 | 対象 | ステータス(1本目 → 2本目) | 本文バイト | 本文のハッシュ | 間隔 ms | DO のインスタンス | 全体 ms(1本目 / 2本目) |
|---|---|---|---|---|---|---|---|---|
| S1r | S1 | central-shutuba | 200 → 200 | 同じ | 一致 | 12004 | 同じ | 431 / 536 |

###### Worker から DO を繰り返し呼ぶ試験(netkeiba へは出ない)

- 60 回すべて成功した

###### 事実(記録に書かれていること)

- DO の中のソケットで netkeiba へ出した本数: 9 本
- S1: 200(central-shutuba。判定 ok、パース 16 件、本文 276742 バイト)
- R1: 200(db-horse-results。判定 ok、パース 26 件、本文 140135 バイト)
- N1: 200(nar-shutuba。判定 ok、パース 12 件、本文 218738 バイト)
- O1: 200(central-odds。判定 ok、パース 16 件、本文 890 バイト)
- T1: 200(central-trio-odds。判定 ok、パース 560 件、本文 17856 バイト)
- N2: 200(nar-odds-page。判定 ok、パース 12 件、本文 56459 バイト)
- S1r: 200(central-shutuba。判定 ok、パース 16 件、本文 276742 バイト)
- S1g: 200(central-shutuba、gzip を要求。判定 ok、パース 16 件、本文 276742 バイト)
- T1g: 200(central-trio-odds、gzip を要求。判定 ok、パース 560 件、本文 17856 バイト)
- 打ち切り: なし
- 出馬表(S1)の本文は 276742 バイトで、#160 E3(通常の Worker のソケット)の 276708 バイトと違う
- S1g: gzip を要求したが圧縮されなかった(content-encoding: なし)。本文は 276742 バイトで、identity(S1。276742 バイト)と同じ。所要時間(全体)は gzip 422 ms / identity 431 ms、本文のハッシュは一致
- T1g: gzip を要求したが圧縮されなかった(content-encoding: なし)。本文は 17856 バイトで、identity(T1。17856 バイト)と同じ。所要時間(全体)は gzip 193 ms / identity 177 ms、本文のハッシュは一致
- S1r: S1 と同じ URL の2回目(12004 ms 後)。ステータスは 200 → 200、本文のバイト数は同じ、本文のハッシュは一致、DO のインスタンスは同じ
- DO のインスタンス: 記録全体で異なる ID は 1 個(呼び出し通番の最大は 9)
- Worker から DO を 60 回呼ぶ試験: 60 回すべて成功した

###### 推測(事実ではない)

- DO の中から、通常の Worker(#160 E3)と同じヘッダで、出馬表が通った(取得でき、既存パーサで読めた)。これは1回の観測で、DO と通常の Worker で送信元の扱いが同じかどうかは分離できていない。
- 測った identity の取得先(S1・R1・N1・O1・T1・N2)は、すべて ok と判定された。取得先ごとに1本ずつの観測である。
- S1g: Accept-Encoding: gzip を足しても拒否されなかったが、サーバは圧縮せずに返した(圧縮されなかった。この取得先の1本の観測)。
- T1g: Accept-Encoding: gzip を足しても拒否されなかったが、サーバは圧縮せずに返した(圧縮されなかった。この取得先の1本の観測)。
- Worker から DO を 60 回呼んで失敗しなかったので、DO の呼び出し(stub.fetch)は、Free の subrequest 上限(50)に数えられていないか、上限がこのアカウントでは違う可能性がある(プランは未確認)。

###### 限界

- 標本が小さい: 各セルは n=1(同じ取得先・同じ方式の取得は1本。再現性だけが同じ URL の2本)で、1アカウント・1回の実行。通った・拒否されたという結果は、その1回の観測である。
- ms(所要時間)は、CloudFront のキャッシュの状態・経路・実行のタイミングの揺れを含む。n=1 なので、セルどうしの差の下位桁に意味はなく、読めるのは大まかな桁だけ。
- 本文のハッシュの不一致は、サーバ側での更新(出馬表・オッズの更新)による正当な違いでありうる。拒否や不具合の証拠とは読まない。
- プランは確認していない(§6・§7 と同じ Secrets のアカウント。Free と推定しているだけ)。Free でソケットが使えるかの公式の記載は見当たらない。
- ヘッダは #160 E3 と同じ4つ(User-Agent・accept・accept-language・sec-fetch-mode)。どのヘッダが拒否に効くか、TLS の特徴や HTTP バージョンが効くかは、この実験では分離できない。
- gzip は、2対象(出馬表・三連複のオッズ)だけで測った。ほかの取得先で gzip が通るかは未測定。

##### EUC-JP のデコード(Worker 内の往復)

成功(往復一致)

##### CPU(反復回数を増やして上限超過になる点を探索)

未実施(この実行では選んでいない)

##### ローカル(workerd)での 1 reps あたり ms(本番の CPU とは異なる目安)

| 実行環境 | 処理 | reps | 試行 | 1 reps あたり ms(小さい順) |
|---|---|---|---|---|
| worker | parse | 10 | 3 | 18.50, 19.30, 20.10 |
| worker | score | 10 | 3 | 0.40, 0.40, 0.90 |
| worker | alloc | 3 | 3 | 73.33, 75.33, 84.33 |
| worker | allocFull | 2 | 3 | 276.00, 282.00, 284.00 |
| durableObject | parse | 10 | 3 | 18.00, 19.90, 23.30 |
| durableObject | score | 10 | 3 | 0.20, 0.20, 0.30 |
| durableObject | alloc | 3 | 3 | 73.67, 76.00, 79.33 |
| durableObject | allocFull | 2 | 3 | 283.00, 284.00, 303.50 |

##### 後片付け

- 結果: OK(接頭辞付きの Worker は残っていない)
- Durable Object の名前空間: removed

##### 注記

- Worker が応答するまで 1 回の /ping を要した
- Durable Object の /do/ping: HTTP 200 {"ok":true,"runtime":"durableObject","sqliteOk":true}
<!-- GENERATED:END round4 -->

### 8.3 事実(結果 JSON に記録されていること)

- netkeiba へ出した 9 本は、**すべて HTTP 200 で、既存パーサが読めた**(判定はすべて ok)。打ち切りは起きていない。取得先ごとの件数・本文バイト・時間は
  8.2 の表を参照(race・db・nar の3ホストと、出馬表・単勝複勝・三連複・戦績 API・地方の出馬表・地方オッズページの6種類)
- 9 本は、**同じ DO インスタンス**で取った(異なるインスタンス ID は 1 個)
- 出馬表(S1)の本文は **276742 バイト**で、#160 E3(通常の Worker のソケット)の **276708 バイト**と違う
- gzip を要求した2本(出馬表・三連複)は、**どちらも `content-encoding` なしで返った**(圧縮されなかった)。本文は identity の対と
  バイト数も本文のハッシュも一致した
- 同じ出馬表を 12004 ms あけて2回取ったところ(S1・S1r)、ステータス・バイト数・本文のハッシュが一致し、同じ DO インスタンスだった
- Worker から DO を 60 回呼ぶ試験は、60 回すべて成功した
- 後片付け: 接頭辞付きの Worker は残り0件。DO の名前空間も removed

### 8.4 推測・未確認(事実ではない)

- **標本は各セル n=1**(再現性だけが同じ URL の2本)で、1アカウント・1回の実行。結果は「その1回の観測」であり、netkeiba の判定が今後も同じとは言えない
- **出馬表の本文のバイト数が #160 E3 と違う件**: 今回は #160 の実測とは別の日の取得なので、出馬表のサーバ側での更新による差でありうる。**拒否の証拠とは読まない**
  (同じ実行の中の2本〈S1・S1r〉は一致している)。違いの原因は調べていない
- **gzip を要求したのに圧縮されなかった件**: 事実は「この2つの取得先で、このヘッダを足して要求したとき、圧縮されずに返った」だけで、
  「netkeiba は gzip を返さない」とは**一般化しない**(ほかの取得先・ほかのヘッダでは未測定。なぜ圧縮されなかったかも調べていない)。
  所要時間の差(gzip 版と identity 版)は n=1 で、読み取れるのは大まかな桁だけ(8.2 の限界のとおり)。
  要求ヘッダの送信は単体テストで固定している。実測では送信したバイト列を観測していない
- **DO の呼び出し 60 回が成功した件**: 8.2 の推測のとおり、DO の呼び出し(stub.fetch)は、Free の subrequest 上限(50)に数えられていないか、
  上限がこのアカウントでは違う可能性がある。**Free の上限の数え方は未確定のまま**(プランは未確認)。
  また、**DO の中のソケットが subrequest に数えられるかは測っていない**(この試験は、呼び出し側が DO を呼ぶ回数だけを見た)
- DO の中から通常の Worker(#160 E3)と同じヘッダで取れたことは、DO と通常の Worker で netkeiba から見た送信元の扱いが同じことまでは意味しない(分離できていない)

### 8.5 測っていないこと

- 調教(追い切り)ページ(中央の出馬表の補助で取得している)、ワイド・馬連・馬単・三連単・枠連の各オッズ API、地方の組合せオッズ(3連複の軸馬別取得を含む)、
  地方の払戻・レース一覧など、今回の9本に入っていない取得先
- 取得の同時実行(今回は 2 秒間隔の直列)と、1 レース分(数十本)を続けて取ったときの挙動
- DO が evict された後の挙動(今回は 9 本とも同じインスタンスで、実行は約 20 秒)
- Free の subrequest 上限と DO の中のソケットの関係、DO の duration の課金(ダッシュボードの値は見ていない)

### 8.6 段階2への含意

**事実**: DO の中のソケットで、race・db・nar の各ホスト、中央のオッズ API(単勝複勝・三連複)、地方オッズページまで取得でき、既存パーサで読めた。
繰り返し取得(同じ URL を 12 秒あけて2回)も、同じ結果だった。

**判断材料**(推測を含む): この実測は、#162 段階2(本番のソケット取得 + `NetkeibaGate`)に進める根拠になる。段階2では次のように読む。

- **identity で取得する(Accept-Encoding を送らない)**: gzip を要求しても圧縮されず、得るものがなかった。#160 E3 で通った形(`accept-encoding` なし・
  `Connection: close`)のまま、展開の処理を本番に持ち込まない。ただし「netkeiba は gzip を返さない」とは一般化しない(§8.4)
- **ヘッダは明示した集合だけを送る**(E3 と同じ4つ)。再試行しない・リダイレクトに従わない・サイズ上限とタイムアウトを設ける(§7.7 のとおり)
- **subrequest の数え方は、設計で余裕を持たせる**: DO の呼び出しが数えられる可能性は否定できない(未確定)。1 レース分の取得を呼び出し側が何回呼ぶかを
  50 より十分小さく保つ(#21 のコメントの「レース単位で順に処理する」)
- 測っていないもの(§8.5)は、段階2の取得先に含めるなら、その時点で別に確かめる
