# cloud/ — クラウド版(Cloudflare Worker)

Issue #161(#21-C)の土台と、#162(#21-D)段階2の netkeiba 取得の出口(ソケット・ゲート・確認ページ)、#171(#169-a)の D1(分析履歴)の土台(migration・binding・CI・health)、#174(#172-a)の R2(分析の詳細オブジェクト)の binding と権限確認、#175(#172-b)の分析履歴ストア(`D1AnalysisStore`)と読み取り専用の `GET /api/analyses`。分析の実行・保存の呼び出し元・画面は後続の Issue(#164〜)で載せる。**pnpm workspace の外**にあり、
独自の lockfile を持つ(既存の Windows CI のインストールを重くしないため)。

## 構成
- `src/handler.ts` — リクエスト処理の本体。**すべてのルートの前に認証**を掛ける(`GET /`・`GET /app.js`・`GET /check`・`GET /api/health` ほか)
- `src/access-jwt.ts` / `src/authenticate.ts` — Access の JWT の検証(署名・iss・aud・exp・許可メール1件)。取得元はヘッダ → クッキー、**JWT がどちらにも無いときだけ** `ctx.access`(JWT が付いていて不正なら `ctx.access` では救わず拒否)
- `src/netkeiba-gate-do.ts` — **netkeiba への取得の出口**(SQLite バックエンドの Durable Object。#162 段階2a)。全取得を単一インスタンス(固定名)に通し、DO の中の TCP ソケットで取得する。`cloudflare:sockets` を import するのはここだけ(薄い配線)
- `src/gate-core.ts` — ゲートの中身(**純ロジック**。Node でテストできる)。取得先の許可リスト(https の race / db / nar.netkeiba.com だけ)・直列化(同時に1本。プロミスの連鎖)・最小間隔 2 秒(最後の開始時刻を `ctx.storage.kv` に永続化)・サーキットブレーカー(400/403/429 が2回連続で30分、すべての取得を接続せずに拒否。手動リセットなし)・待ち行列の上限(8)
- `src/socket-fetch.ts` / `src/http1.ts` — ソケットで HTTP/1.1 を話す取得クライアント(`connect` を注入。送るヘッダは固定の4つ + `Host` + `Connection: close`、圧縮は要求しない、再試行・リダイレクト追従なし、サイズ上限 2 MiB・タイムアウト 20 秒)。調査(`spikes/cloudflare/`・`scripts/cloudflare-spike/`)の実装を本番用に作り直したもので、調査のコードは参照しない
- `src/gate-fetch.ts` — ゲートの `fetchRaw`(RPC)を core の `HttpClient` の fetch 注入口へ繋ぐ(`createGateHttpClient`: 間隔 0・再試行 0。間隔制御はゲートだけが行う)。**Worker の `fetch` で netkeiba を取る経路は持ち込まない**(#160。CloudFront から HTTP 400 になる)
- `src/netkeiba-check.ts` / `src/page.ts` — 確認用エンドポイント `GET /api/netkeiba/check` の処理(race_id の検証・出馬表の取得とパース)と、`/check` の確認フォーム(Issue #184 で `/` から移した。使い方は下の「確認ページの使い方」)
- `migrations/` — D1 の migration(#171)。`0001_init.sql` は exe の最終スキーマのダンプ(**生成物。手で編集しない**。`pnpm tsx scripts/gen-cloud-d1-migration.ts` で再生成)、`0002_d1.sql` は D1 専用の追加分(`analyses.detail_key`・索引2つ)、`0003_r2_ops.sql` は R2 の操作回数のカウンタの表(#173)。詳細は下の「D1(分析履歴)」・「分析履歴ストア」
- `src/d1-health.ts` — `GET /api/health` の D1 の疎通確認(`SELECT detail_key FROM analyses LIMIT 1`。migration の適用と binding を1回の読み取りで確かめる)
- `smoke-worker.ts` / `smoke-modules.d.ts` — **ローカル smoke 専用**のエントリ(偽ソケット。本番の `main` ではない)
- `src/undici-stub.ts` — core の `http-client.ts` が動的に import する `undici` の差し替え(バンドルに巨大な undici を入れない)
- **core(`packages/core`)は相対 import で取り込む**(workspace の外のため `@keiba/core` は解決できない。バレルは使わず `scraper/*.js` を個別に import する)。core の依存(cheerio・iconv-lite)は `packages/core/node_modules` が CI に無いので、**`wrangler.toml` の `[alias]`・`tsconfig.json` の `paths`・`vitest.config.ts` の `alias` の3か所**でこのディレクトリの `node_modules` へ向ける(`scripts/test/cloud-config-guard.test.ts` が3か所の対応を固定)。
  ★ローカルには `packages/core/node_modules` があるので、`tsconfig.json` の `paths`(型検査)か `wrangler.toml` の `[alias]`(バンドル。core を Worker から import した時点で効く)を書き忘れても、ローカルでは通り、**CI だけが落ちる**(実測: `packages/core/node_modules` の無い配置で、`paths` を外すと tsc が TS2307、`[alias]` を外すと wrangler の dry-run が `Could not resolve`)。vitest の `alias` は、無くても通ったが(Vite の解決が `cloud/node_modules` へ辿り着く)、解決の挙動に依存しないよう明示している。変更したら、`packages/core/node_modules` を持たない配置(リポジトリから `node_modules`・`.git` を除いたコピー)で `pnpm install --ignore-workspace --frozen-lockfile` から確かめる
- 認証に失敗したとき、設定が欠けているときは、理由を含まない固定の 403(`forbidden`)を返す(フェイルクローズ)。理由コードと経路名だけをログに出す

## コマンド(cloud/ で)
```
pnpm install --ignore-workspace --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run deploy:dry   # デプロイせずバンドルと設定を確かめる
pnpm run smoke        # wrangler dev(workerd)で 403 / 200 の配線を確かめる。終了時にプロセスを止める
pnpm exec wrangler d1 migrations apply DB --local   # D1 の migration をローカルに適用(CI の check ジョブも実行する)
```

## デプロイ
`.github/workflows/deploy-cloud.yml`。許可した作業ブランチの上で、承認印 `[PUBLISH-APPROVED]` 付きの push(「レビュー継続中」を含まない)
または手動実行のときだけ、`check`(型検査・テスト・dry-run・スモーク)の後に本番へ出す。

## D1(分析履歴。Issue #171〈#169-a〉)
クラウド版の分析履歴の保存先。**この Issue は土台だけ**(migration・binding・CI・health)で、保存・読み取りのロジック(`D1AnalysisStore`)と R2 は #174・#175(旧 #172)、R2 の操作回数の安全柵は #173。
- **binding**: `wrangler.toml` の `[[d1_databases]]`。binding 名 `DB`・database_name `keiba-cloud-db`。`database_id` は公開してよい値(ダッシュボードで作成した D1 の ID。リポジトリに書いてある)。
  **`remote = true` は付けない**(ローカルのテスト・開発が本番の D1 に繋がる。`scripts/test/cloud-config-guard.test.ts` が検査)。
- **migration**(`cloud/migrations/`)は**追加のみ**(DROP・DELETE・UPDATE・TRUNCATE・REPLACE・ALTER の DROP/RENAME を含まない。静的ガードがある)。
  本番では、デプロイの前に反映される(適用からデプロイまでの間は旧 Worker が新しい表で動くため)。
  - 0001 は exe の `new AnalysisStore()` 後の `sqlite_master` のダンプ(8表と `idx_analyses_race`)。exe のスキーマを変えたら `pnpm tsx scripts/gen-cloud-d1-migration.ts` で再生成する
    (`--check` で最新かだけ確かめられる)。コミット済みの 0001 との一致と、「0001+0002 の構造 = exe の最終スキーマ + 宣言した追加分」は `scripts/test/cloud-d1-schema.test.ts`(ルートの `pnpm test`)が固定している。
  - 後から足すときは 0003 以降の新しいファイルにする(適用済みのファイルを書き換えない)。
- **RaceDay(DO の SQLite)の表にスキーマ変更の仕組みは無い**: `CREATE TABLE IF NOT EXISTS` だけで作る(`src/race-day-core.ts` のコンストラクタ)。本番の RaceDay は未デプロイなので、今は列を足してよい。**最初の本番デプロイのあとに列を足すときは `ALTER TABLE ... ADD COLUMN` が要る**(D1 の migration とは別。足さないと、作成済みの表に列が無く INSERT/SELECT が落ちる)。
- **ローカルでの適用**: `pnpm exec wrangler d1 migrations apply DB --local`(資格情報なしで動く。再実行しても何も起きない)。`pnpm run smoke` は、起動の前に一時の保存先へ同じ migration を適用する。
- **テスト**(`test/d1-schema.test.ts`): 実コマンドで migration を適用したローカル(workerd)の D1 を `getPlatformProxy` で開き、外部キーと索引(`EXPLAIN QUERY PLAN`)を確かめる。
  ★**同じ SQL の文字列で `EXPLAIN QUERY PLAN` を繰り返すと、索引を DROP した後も古い実行計画が返る**(ローカルの D1 で実測)ので、テストは毎回文字列を変えている。
  ローカルの D1 は「1回の呼び出しで 50 クエリ」の制限を**強制しない**(bind 変数 100 個の制限は強制する)。本番の D1 とは別ビルドの SQLite でありうるので、`/api/health`(下)と最初の本番の実保存(#164 以降)で本番の挙動を確かめる。
- **`GET /api/health`**: `{ ok, durableObject: { sqlite }, d1: { ok } }`。DO と D1 は独立に確認し、どちらかが駄目なら 503(理由・例外の文面は返さない)。**デプロイ後の実機確認**: Access でログインしたブラウザで `/api/health` を開き、`d1.ok` が `true` であること
  (`false` なら、migration が本番の D1 に適用されていないか、binding が繋がっていない。ワークフローのログの「D1 の migration を本番に適用」を見る)。
- **容量の見積もり**: `pnpm tsx scripts/measure-d1-size.ts`(結果と N は `docs/current-spec.md` の「クラウド版の D1 の容量の見積もり」)。

### D1 の作成(ユーザー作業。済み)
ダッシュボードで **D1 SQL database** を開き、**Create Database** → 名前 `keiba-cloud-db` → Create(公式の Get started の手順)。ロケーションヒントは指定しない方針(決定 2026-10-06)。
**database_id(UUID)の見つけ方は、公式ドキュメントでダッシュボード上の場所を確認できなかった(未確認)**。ID が wrangler.toml に入るまでは、仮の値(ゼロ UUID)で開発・テストし、**承認印付きの push をしない**(deploy ジョブが仮の値で失敗する)。

### デプロイ時の D1 のステップと、ステータスコードの読み方
`deploy` ジョブは、`wrangler deploy` の前に次の順で実行する(`.github/workflows/deploy-cloud.yml`)。
1. **database_id が仮の値でないことを確認**(リポジトリの `cloud/wrangler.toml` を見るだけ。ゼロ UUID・UUID の形でない値・行が無い場合は失敗)
2. **D1 の権限を確認**: D1 の取得 API(`GET /accounts/{account_id}/d1/database/{database_id}`)のステータスコードだけで判定する(**応答の本文・トークン・アカウント ID はログに出さない**)。
3. **D1 の migration を本番に適用**: `wrangler d1 migrations apply DB --remote`。適用済みなら何もしない。失敗したらデプロイしない。

権限確認のステータスコード:
| HTTP | 意味 | 対処 |
|---|---|---|
| 200 | D1 を読めた | なし |
| 401・403 | 権限不足(トークンが D1 を読めない) | API トークンに **D1 の編集権限**を付ける(公式の D1 取得 API のページに必要な権限として「D1 Read」か「D1 Write」とある。ダッシュボードでの表示名は未確認) |
| 404 | その database_id の D1 が無い | `cloud/wrangler.toml` の `database_id` と、作成した D1 を確かめる(別アカウントの ID・作り直した後の古い ID など) |
| それ以外(500 台・000〈接続できない〉など) | 確認できない | ネットワークか Cloudflare 側の一時的な問題のことがある。再実行する |

`wrangler d1 migrations apply --remote` に必要な権限は、公式の wrangler コマンドのドキュメントに書かれていない(未確認)。上の D1 の編集権限で足りるはずだが、最初の本番の適用の結果で確かめる(足りなければ、ここに追記する)。
R2 の権限確認と binding は、次の「R2(分析の詳細オブジェクト)」。

## R2(分析の詳細オブジェクト。Issue #174〈#172-a〉)
大きな列(`race_snapshot_json`・`raw_response`・馬ごとの `contributions`)の置き場(方式 A。理由と容量の見積もりは #169・`docs/current-spec.md`)。
**この Issue は binding と権限確認だけ**で、R2 を使うコード(保存・読み出し)は #175(下の「分析履歴ストア」)、操作回数の安全柵は #173。health には R2 の疎通確認を足さない(足すと操作回数が増えるため)。
- **binding**: `wrangler.toml` の `[[r2_buckets]]`。binding 名 `ANALYSIS_DETAIL`・bucket_name `keiba-cloud-r2`(ユーザーがダッシュボードで作成済み。ロケーションはアジア太平洋)。
  **`remote = true`・`preview_bucket_name`・`jurisdiction` は付けない**(ローカルのテスト・開発が本番のバケットに繋がる。`scripts/test/cloud-config-guard.test.ts` が検査)。
- **ローカル**: `wrangler dev --local`・`getPlatformProxy` で、R2 はローカルのシミュレータで動く(資格情報は不要。`test/r2-binding.test.ts` が put・get・上書き・存在しないキー〈null〉・バイト列の往復を確かめる)。
  `pnpm run deploy:dry`(CI の check ジョブも実行する)も資格情報なしで binding を認識する。
- **圧縮(決定 2026-10-06)**: 詳細オブジェクトは `node:zlib` の **level 1** の gzip で置く(#175 で実装)。workerd 上の CPU 時間の実測は `docs/current-spec.md` の「R2 の詳細オブジェクトの圧縮」。再現: `pnpm tsx scripts/measure-worker-cpu.ts`。

## 分析履歴ストア(Issue #175〈#172-b〉)
`src/analysis-repository.ts`(`AnalysisRepository`・`D1AnalysisStore`)と `src/analysis-detail.ts`(R2 の詳細オブジェクトの符号化)。**要約は D1、大きな列は R2**(方式 A)。設計・保存の順序・既知の差分は `docs/current-spec.md` の「分析履歴ストア」と、`analysis-repository.ts` の先頭の説明。
- **コンストラクタは `{ db, bucket }` だけ**(Worker からでも DO からでも使える。R2 は `get`・`put` だけ。LIST・HEAD は型で使えない)。**保存の呼び出し元はまだ無い**(#164)。
- **本番の入口は読み取り専用の `GET /api/analyses?race_id=&kaisai_date=&limit=`**(Access の後ろ。D1 だけ。limit は既定 50・上限 200)。**デプロイ後の実機確認**: Access でログインしたブラウザで開き、`{"ok":true,"analyses":[]}` が返ること
  (保存の経路がまだ無いので、空の一覧が正しい。`503` で `d1-error` なら、migration の適用か binding を `/api/health` で確かめる)。
- **core は相対 import で、バレルや better-sqlite3 を使うモジュールは import しない**(`test/import-guard.test.ts` が推移的に検査。バンドルの実物は `test/bundle-guard.test.ts`)。
- **テスト**: `test/analysis-repository.test.ts`(ローカルの workerd の D1・R2。AC-b2〜b10・一覧・版別の COVERING INDEX など)・`test/analysis-detail.test.ts`(符号化)・`test/rows-written.test.ts`(1回の保存の D1 の書き込み行数。再現手段)。
  ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しないので、文の数は記録した値で直接 assert している。**batch が他の保存と交錯しない**(`(SELECT max(id) FROM analyses)` の前提)ことは、ローカルの並行テストで確かめたが本番では未検証。最初の本番の実保存で確かめる。

### R2 の操作回数の安全柵(Issue #173〈#169-c〉)
**R2 の月ごとの操作回数を D1 の `r2_ops` に数え、無料枠の 10% に達したら止める**(`src/r2-fence.ts` の純関数と定数。設計・限界は `docs/current-spec.md` の「R2 の操作回数の安全柵」)。
- **Class A(書き込み。PUT)が 10 万回/月に達したら**: R2 に書かず、D1 に要約だけを保存する(`saveAnalysis` が `detail: "skipped"` を返す。PUT 0 回・カウンタは増えない)。
- **Class B(読み出し。GET)が 100 万回/月に達したら**: 詳細の表示だけを拒否する(`getAnalysisDetail` が R2 を引かず `detail: "missing"`。要約・配分は出る)。
- **月は UTC の yyyymm**。`getR2Usage()` で今月の回数・柵の上限・許可の状態を返す(画面〈#165〉・通知〈#166〉への接続は、それぞれの Issue)。
- **migration 0003 が適用済みであることが前提**(保存と詳細の読み出しが今月の行を読む)。CI は migration を `wrangler deploy` の前に適用する。**手元で確かめるとき**は `pnpm exec wrangler d1 migrations apply DB --local`。
- テスト: `test/r2-fence.test.ts`(純関数)・`test/analysis-fence.test.ts`(D1・R2 のローカル。カウンタ・月の境界・閾値の境界・読み出しの柵・best-effort)。

### デプロイ時の R2 のステップと、ステータスコードの読み方
`deploy` ジョブは、D1 の権限確認の次(D1 の migration と `wrangler deploy` の前)に **「R2 の権限を確認」** を実行する(`.github/workflows/deploy-cloud.yml`)。
R2 のバケット取得 API(`GET /accounts/{account_id}/r2/buckets/{bucket_name}`。bucket_name は `wrangler.toml` から読む)の**ステータスコードだけ**で判定する
(**応答の本文・トークン・アカウント ID はログに出さない**)。

| HTTP | 意味 | 対処 |
|---|---|---|
| 200 | バケットを読めた | なし |
| 401・403 | **権限不足、または R2 が有効化されていない**(ステータスコードだけでは区別できない) | (1) アカウントで R2 を有効化したか(ダッシュボードの R2 のページ)。(2) API トークンに R2 の権限(「Workers R2 Storage」の Read か Edit。**この API に必要な権限を、公式ドキュメントで確認できなかった〈未確認〉**。ダッシュボードでの表示名も未確認)を付ける |
| 404 | バケットが見つからない | `wrangler.toml` の `bucket_name` と、作成したバケットの名前を確かめる。**バケットに管轄(jurisdiction。EU など)の指定がある場合も、この確認では見つからない**見込み(公式の API に `cf-r2-jurisdiction` ヘッダがあるため。推測。未確認)。その場合は、binding に `jurisdiction` を足し、この確認ステップも直す必要がある |
| それ以外(500 台・000〈接続できない〉など) | 確認できない | ネットワークか Cloudflare 側の一時的な問題のことがある。再実行する |

**未確認の点(最初の本番の実行の結果で確定する)**:
1. 上の API に必要なトークン権限(公式ドキュメントのページに記載が無かった)。403 が出たら、トークンに R2 の権限を足してから再実行する。足した権限の名前は、ここに追記する。
2. 存在しないバケットが 404 を返すか(ドキュメントに記載が無い)。
3. **`wrangler deploy` が、R2 の binding を持つ Worker のアップロードに、追加の権限を要するか**(権限確認が 200 でも、デプロイの段階で別の理由で失敗する可能性は残る)。
4. 403 の原因が「権限不足」か「R2 の未有効化」か(ユーザーは R2 を有効化済みと申告している。こちらからは未検証)。

## Worker の secret(ユーザーがダッシュボードで登録する。値はリポジトリ・チャットに書かない)
Workers & Pages > 対象の Worker > Settings > Variables and Secrets > Add。**Type は Secret**(vars は次のデプロイで上書きされる)。

| 名前 | 内容 |
|---|---|
| `ACCESS_TEAM_NAME` | Zero Trust のチーム名(`<チーム名>.cloudflareaccess.com` の左側。小文字・数字・ハイフンのみ) |
| `ACCESS_AUD` | Access アプリケーションの AUD タグ |
| `ACCESS_ALLOWED_EMAIL` | 許可するメールアドレス(1件) |
| `ANTHROPIC_API_KEY` | (#164 で使う。今は登録しない) |
| `DISCORD_WEBHOOK_URL` | (#166 で使う。今は登録しない) |

未設定の間は、Worker が全リクエストに 403 を返す(これが正しい動作)。

## 初回セットアップ(ユーザー作業)
公式ドキュメントで確認できなかった箇所は「未確認」と書いている。
1. **Zero Trust の組織を作る**: ダッシュボードで Zero Trust を選び、チーム名を決め、Free プランを選ぶ。Free でも支払い情報の入力を求められる(課金はされない、と公式にある)。チーム名を後から変えられるかは未確認。
2. **Google の OAuth クライアントを作る**(Google Cloud): プロジェクト作成 → APIs & Services > Credentials > 同意画面(External)→ OAuth クライアント(Web application)。
   承認済みの JavaScript 生成元に `https://<チーム名>.cloudflareaccess.com`、リダイレクト URI に `https://<チーム名>.cloudflareaccess.com/cdn-cgi/access/callback`。同意画面がテスト状態のときのテストユーザー登録の要否は未確認。
3. **Google の IdP を登録する**: Zero Trust > Integrations > Identity providers > Add new identity provider > Google。Client ID と Client secret を入れて保存し、Test で確かめる。
4. **先に、許可するメール1件のポリシーを作る**: Zero Trust(Cloudflare One)> Access コントロール > ポリシー > ポリシーを追加。
   アクション = Allow、含める = Emails(許可する1件)、要求 = Login Method(Google)。
5. **初回デプロイの後に、Worker に Access を掛ける**: Workers & Pages > 対象の Worker > Access タブ > Protect this Worker behind Access > **All traffic**。
   ポリシーは「Cloudflare account」「Email domain」ではなく、**既存のポリシー**(4. で作ったもの)を選ぶ(公式ドキュメントに「select an existing policy」とある)。
   **★アプリのログイン方法は、既定で「利用可能なすべての IdP を許可」になる**(2026-10-06 に実機で確認)。このままだとログイン画面に「Cloudflare」
   (Cloudflare アカウントでのログイン)も出るので、Zero Trust > Access コントロール > アプリケーション > 対象のアプリ > ログイン方法 で **Google だけ**にする。
   AUD タグは同じアプリの画面で控える。
6. **secret を登録する**(上の表)。Workers & Pages > 対象の Worker > 設定 > 変数とシークレット > 追加 で、環境は「プロダクション」、3つとも「シークレット」にチェックを入れる。
7. Access の設定のための API トークンの権限の追加は不要(ユーザー本人のダッシュボード操作)。**D1 を使う #171 以降は、デプロイ用の API トークンに D1 の編集権限が要る**(上の「D1(分析履歴)」)。

## 初回の実機確認で見ること
Workers Logs(`observability` を有効にしてある)に、認証の経路が `access: ok via=header` / `via=cookie` / `via=ctx-access` で出る。
どれで通ったかで、Worker レベルの Access が JWT ヘッダ・クッキーを渡すかが分かる(公式ドキュメントには明記がない)。
**2026-10-06 の初回確認では `via=header`** だった(Worker 単位の Access は JWT を `Cf-Access-Jwt-Assertion` ヘッダで渡す。#161)。
拒否は `access: denied reason=<経路:理由コード>` で出る(トークン・メール・チーム名・AUD は出ない)。

## スマホ画面(Issue #184〈#165-b〉。配信の基盤と一覧の画面)
`GET /` がスマホ向けの画面(Access でログイン後)。**この Issue は配信の基盤と一覧の画面だけ**(レース画面・結果画面は #185〈下の節〉、分析の起動・状態の更新〈ポーリング〉は #186)。
- **使い方**: スマホのブラウザで Worker の URL を開く → 開催日(日付の入力。既定は今日〈JST〉)と「中央」「地方」を選ぶ → 場ごとにレースの一覧が出る。各レースの右に、朝の準備・発走前それぞれの状態(未実行・待ち・取得済み・完了・失敗)が出る。「更新」で一覧と状態を取り直す。レースをタップすると `#date=…&venue=…&race=…` に移る(#185 でレース画面になった。#184 の時点では「準備中」の表示)。戻るボタンで一覧に戻れる(画面の状態は URL のハッシュ `#date=YYYYMMDD&venue=central|nar` に持つ)。
- **取得の回数**: 一覧(`GET /api/races`。netkeiba に出うる)は (開催日, 区分) ごとに1回、状態(`GET /api/analyses/status`。DO の読み取りだけ)は開催日ごとに1回で、画面の往復では取り直さない。失敗は自動で再試行しない(「更新」だけ)。
- **配信**: クライアントの TS(`client/`)を `build-client.ts` が esbuild で 1 ファイル(IIFE・minify)にし、`src/client-bundle.generated.ts`(**生成物。コミットする。手で編集しない**)にする。Worker が `GET /app.js` で、**認証の関門の後ろ**から文字列として返す(`[assets]` は使わない。`run_worker_first` を付け忘れると認証を素通りする配信になるため。wrangler 4.147.0 で、`run_worker_first = false` は未認証でも 200 が返ること・`true` は Worker に届くことを確かめた)。
  - **クライアントを変えたら**: cloud/ で `pnpm run build:client` を実行して生成物を更新する(忘れると `test/client-bundle.test.ts` のドリフトの検査が落ちる)。
  - **CSP**: `default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; …`(インラインスクリプトなし。`connect-src` が無いと fetch が止まる)。外から来た文字列(レース名など)は、テキストノードとしてだけ DOM に入れる(HTML として解釈する API は使わない。静的ガードあり)。
  - 型検査: `tsconfig.client.json`(DOM の型。workers-types とは別の設定)。`pnpm run typecheck` が両方を検査する。
- **表示で未確認(#185 以降・実機確認で見る)**: スマホ実機でのレイアウト・タップ(自動検査できない。デプロイ後にユーザーが確認する)。
- 検査: `test/client-*.test.ts`(route・date・api・api-contract〈実際の `handle()` の応答を通す〉・list・app・dom・bundle)、`test/handler.test.ts`、smoke(`/app.js`・CSP・`/check`)。

## スマホ画面のレース画面・結果画面(Issue #185〈#165-c〉。読み取りのみ。**起動・ポーリングは #186**)
- **使い方**: 一覧のレースをタップ → **レース画面**(`#date=…&venue=…&race=<12桁>`)。「朝の準備」「発走前」の 2 枚のカードに状態(未実行・待ち・取得済み・完了・失敗。失敗のときは原因の文を小さく)が出る。朝が完了していれば prior(3着内率)の順位、発走前が完了していれば「結果を見る」(押すと**結果画面**〈`#analysis=<id>`〉へ。自動では開かない)。下に過去の分析の一覧(新しい順。タップで結果画面)。「更新」で状態と過去の分析を取り直す。**分析の起動のボタンはまだ無い**(#186。今は exe・手動の POST で起動する)。
- **結果画面**: 見出し・分析時刻(JST)・分析モデル(無ければ「LLM 未使用(統計のみ)」)・馬ごとのカード(馬番・馬名・3着内率・複勝オッズ下限・EV。EV プラスは強調、推定 EV は「(推定)」)・配分の提案(exe の表示と同じ文言)。印は `mark` があるときだけ。「AI補正後」は出さない。**配分は、資金・1レース上限を D1 の `cloud_settings` に入れるまで「見送り」と表示される**(編集の画面は範囲外)。
- **取得の回数**: レース画面は、開いたとき `GET /api/analyses/status?kaisai_date=&race_id=`(DO の読み取りだけ)と `GET /api/analyses?race_id=&kaisai_date=&limit=20`(D1 だけ)を 1 回ずつ。**一覧(netkeiba に出る)は取らない**。結果画面は `GET /api/analyses/{id}` を開いたとき 1 回だけ(⚠️ R2 の Class B を +1 する。メモリにキャッシュし、往復で取り直さない。失敗したときだけ「更新」で取り直せる)。自動の再取得・ポーリングは無い。
- **API の変更**: `GET /api/analyses/{id}` の `allocation` に `fallbackReason`・`betUnit` を追加(配分の注記を exe と揃えるため)。
- **ビルド**: クライアントが exe の `renderer/allocation-proposal-view`・`renderer/format` を取り込む。renderer が import する core のサブパスは、`tsconfig.client.json` の paths で解決する(esbuild もこれを読む)(CI に各 package の node_modules が無くても動く)。**exe の renderer・core の ev を変えたら、`pnpm run build:client` で生成物を更新する**(忘れるとドリフトの検査が落ちる)。
- **表示で未確認(実機確認で見る)**: スマホ実機でのレイアウト・タップ(自動検査できない。デプロイ後にユーザーが確認する)。
- 検査: `test/client-*.test.ts`(api-analysis・api-analysis-contract〈ローカルの D1・R2 に保存した分析を `handle()` で読む〉・race・result・view・app・bundle)、`test/analysis-view.test.ts`。

## 確認ページの使い方(#162 段階2。本番での実機確認)
netkeiba の取得が、本番(Cloudflare)で通ることを、出馬表1本で確かめるページ。**netkeiba へ実際にリクエストが出る**(1回の確認で1本。ゲートが 2 秒間隔・直列に絞る)。
1. Access でログインして **`/check`** を開く(Issue #184 で `/` から移した。`/` はスマホ画面)。「netkeiba の取得の確認」のフォームがある(初期値は `202603020211`)。
2. **初回は、初期値の実在するレース(`202603020211`。中央。fixture と #162 段階1の実測で HTTP 200 だったもの)で「確認する」を押す。**
   JSON が返る。見ること: `ok: true`・`status: 200`・`horses: 16`・`kind: "central"`・`elapsedMs`(ソケットの所要時間。段階1の実測は 0.4 秒前後)・`queuedMs`・`gate`(ブレーカーの状態)。
3. 地方も確かめるなら、実在する地方の race_id(12桁。場コード 30〜64。例: 段階1で使った `202654071210`)を入れる。`kind: "nar"` になる。
- **実在しない race_id は、netkeiba に拒否(400 など)されることがある。拒否が 2 回続くと、安全のため 30 分間、すべての取得を止める**(サーキットブレーカー。手動で戻す手段は無く、時間経過でだけ戻る)。
  止まっている間は HTTP 503・`error.reason: "blocked"` が返り、`gate.blockedUntil`(解除時刻。epoch ミリ秒)で分かる。
- `race_id` が無効(12桁の数字でない・帯広・地方で実在しない日付など)なら HTTP 400 で、netkeiba へは出ない。
- 失敗の種類(`error.type`): `gate-refused`(ゲートが拒否。`reason` に blocked / queue-full / network-error / timeout / bad-response)・`http-error`(netkeiba が 2xx 以外。`status`)・
  `parse-error`(取得できたが出馬表として読めない)・`fetch-failed`(ゲートの呼び出し自体の失敗)。
- 中身の確認は `GET /api/netkeiba/check?race_id=...` を直接開いても同じ(GET のみ。HEAD では取得しない)。
- Worker での decode + parse の CPU が足りない場合(Free の Worker の CPU 上限)は、本番で `Error 1102` になりうる。その場合は、確認の処理(`src/netkeiba-check.ts`。`fetchRaw` を受け取る関数)を DO の中へ移す。

## ローカル smoke の偽ソケット(netkeiba へ出さない)
`pnpm run smoke` の E は、`main` を `smoke-worker.ts` にした一時設定で起動する。`smoke-worker.ts` は DO の接続関数(`connectFn()`)を、fixture を返す偽ソケットに差し替えたサブクラスを `NetkeibaGate` として export する。
workerd と nodejs_compat の実環境で、Worker → DO → ソケットクライアント → HttpClient → cheerio が通り、2 秒間隔・ブレーカーが効くことを確かめる。**本番の `main` は `src/worker.ts` で、偽ソケットは本番のバンドルに入らない**
(`test/bundle-guard.test.ts` が、本番の `wrangler deploy --dry-run` のバンドルに偽ソケットの印が無いこと・core が入っていること・圧縮後 3 MB 以内を固定している)。

## 手動起動の入口(Issue #180)
Access の後ろの2つのルート(使い方・仕様は `docs/current-spec.md` の「手動起動の入口」)。**netkeiba への取得の起点は、認証の後ろの手動の操作だけ**(この POST の予約・下の `GET /api/races`・`GET /api/netkeiba/check`。定時の Cron は無い。呼び出し箇所の数は `scripts/test/cloud-config-guard.test.ts` が固定)。
- `POST /api/analyses/run` — 本文 JSON `{"race_id": "202603020211", "kaisai_date": "20260628", "mode": "morning"}`。`mode` は `morning`(省略時。朝の取得と prior。D1・R2 には書かない)か `pre_race`(発走前の分析。LLM なし。D1・R2 に保存)。**同じオリジンのページから**(`Origin` が必要。curl で試すときは `-H "Origin: https://<自分の Worker のホスト>"` と `-H "Content-Type: application/json"` を付ける)。202 で予約され、取得 → 計算はアラームの中で進む(中央16頭で約 40 秒)。
- `GET /api/analyses/status?kaisai_date=20260628[&race_id=202603020211]` — 状態と、朝の prior の最小限。

## 読み取りの API(Issue #183)
Access の後ろの GET が2つ(仕様の詳細は `docs/current-spec.md` の「スマホ画面のための読み取り API」)。
- `GET /api/races?kaisai_date=20260628&venue=central|nar` — 開催日のレース一覧(場 → R の順)。`venue` は必須。開催日の DO(RaceDay)が、gate 経由・DO のキャッシュ(6 時間)で取る。**netkeiba に出うる GET**(HEAD は 405。`Sec-Fetch-Site` が `same-origin`・`none` 以外なら 403)。開催なしの日は `races: []`。取得の失敗は 503 `netkeiba-unavailable`(`reason`: `blocked`・`busy`・`failed`)。
  **デプロイ後の実機確認**: Access でログインしたブラウザで、開催のある日と開催のない日を開く。公開前の日・遠い未来・過去の日付で netkeiba が何を返すかは、まだ実測していない。
- `GET /api/analyses/{id}` — 分析1件(馬名つき・配分つき)。`rawResponse`・`contributions`・raceSnapshot の全体は返さない。R2 の柵に達した・R2 に無いときは、馬名なしの同じ形(`detail: "missing"`)。**詳細が present のとき、D1 の書き込みが1行ある**(`r2_ops` の Class B の +1)ので、画面から自動で繰り返し呼ばない。
- 検査: `test/race-day-list.test.ts`・`test/handler-races.test.ts`・`test/analysis-view.test.ts`・`test/handler-analysis-detail.test.ts`、smoke。

## 設定(Issue #178)
発走前の分析の設定(資金・1レース上限・ケリー係数・組合せオッズの取得・各券種の配分など)は D1 の `cloud_settings` の1行(`id = 1`)。**行が無ければ全項目が exe の既定値**(資金・1レース上限は 0 = 配分提案なし、組合せオッズの取得は OFF)。
編集する画面・API は #165。値を決めたら、`wrangler d1 execute DB --remote --command "INSERT INTO cloud_settings (id, settings_json, updated_at) VALUES (1, '{\"bankroll\":1000000,\"perRaceCap\":100000}', datetime('now')) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at"` のように入れる(項目と検証は `cloud/src/settings.ts`)。
