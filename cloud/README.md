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
- **core(`packages/core`)は相対 import で取り込む**(workspace の外のため `@keiba/core` は解決できない。バレルは使わず `scraper/*.js` を個別に import する)。core の依存(cheerio・iconv-lite・`@anthropic-ai/sdk`〈Issue #193〉)は `packages/core/node_modules` が CI に無いので、**`wrangler.toml` の `[alias]`・`tsconfig.json` の `paths`・`vitest.config.ts` の `alias` の3か所**でこのディレクトリの `node_modules` へ向ける(`scripts/test/cloud-config-guard.test.ts` が3か所の対応を固定)。**core のサブパス(`@keiba/core/pipeline`・`@keiba/core/llm` など)は `[alias]` に1行ずつ**(wrangler の alias は完全一致)。
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
- **使い方**: 一覧のレースをタップ → **レース画面**(`#date=…&venue=…&race=<12桁>`)。「朝の準備」「発走前」の 2 枚のカードに状態(未実行・待ち・取得済み・完了・失敗。失敗のときは原因の文を小さく)が出る。朝が完了していれば prior(3着内率)の順位、発走前が完了していれば**最新の分析の結果がカードの中に最初から出る**(Issue #188。旧版の「結果を見る」のリンクは廃止。下の「発走前の結果をカードの中に出す」の節)。下に過去の分析の一覧(新しい順。タップで結果画面)。「更新」で状態と過去の分析を取り直す。**分析の起動のボタンはまだ無い**(#186。今は exe・手動の POST で起動する)。
- **結果画面**: 見出し・分析時刻(JST)・分析モデル(無ければ「LLM 未使用(統計のみ)」)・馬ごとのカード(馬番・馬名・3着内率・複勝オッズ下限・EV。EV プラスは強調、推定 EV は「(推定)」)・配分の提案(exe の表示と同じ文言)。印は `mark` があるときだけ。「AI補正後」は出さない。**配分は、資金・1レース上限を設定する(トップの「設定」。Issue #189)まで、「配分の提案は出ていません。…未設定です」と表示される**(既定値は 0 なので、ほぼ全件がこの状態。**両方が未設定のとき**、exe の「設定画面で入力」ではなく cloud 専用の文言〈トップの「設定」を案内〉。片方だけ未設定のときは exe の注記)。
- **取得の回数**: レース画面は、開いたとき `GET /api/analyses/status?kaisai_date=&race_id=`(DO の読み取りだけ)と `GET /api/analyses?race_id=&kaisai_date=&limit=20`(D1 だけ)を 1 回ずつ。**一覧(netkeiba に出る)は取らない**。結果画面は `GET /api/analyses/{id}` を開いたとき 1 回だけ(⚠️ R2 の Class B を +1 する。メモリにキャッシュし、往復で取り直さない。失敗したときだけ「更新」で取り直せる)。自動の再取得・ポーリングは無い。
- **API の変更**: `GET /api/analyses/{id}` の `allocation` に `fallbackReason`・`betUnit` を追加(配分の注記を exe と揃えるため)。
- **ビルド**: クライアントが exe の `renderer/allocation-proposal-view`・`renderer/format` を取り込む。renderer が import する core のサブパスは、`tsconfig.client.json` の paths で解決する(esbuild もこれを読む)(CI に各 package の node_modules が無くても動く)。**exe の renderer・core の ev を変えたら、`pnpm run build:client` で生成物を更新する**(忘れるとドリフトの検査が落ちる)。
- **表示で未確認(実機確認で見る)**: スマホ実機でのレイアウト・タップ(自動検査できない。デプロイ後にユーザーが確認する)。
- 検査: `test/client-*.test.ts`(api-analysis・api-analysis-contract〈ローカルの D1・R2 に保存した分析を `handle()` で読む〉・race・result・view・app・bundle)、`test/analysis-view.test.ts`。

## スマホ画面の発走前の結果をカードの中に出す(Issue #188〈#165-f〉。v1.19.20)
- **使い方**: レース画面の「発走前」のカードが完了(`done`)なら、最新の分析の結果が**最初からカードの中に出る**(分析時刻・分析モデル・馬ごとのカード・配分の提案。結果画面と同じ表示)。見出し(`▾ 分析の結果`)のタップで畳める(畳んだ状態はアプリのメモリに (開催日, レース) ごとに持つ。**ページを再読込すると開に戻る**。「更新」・一覧への往復では保たれる)。16 頭 + 配分で長くなるので、畳める。
- **「結果を見る」のリンクは無い**。結果画面(`#analysis=<id>`)は、**過去の分析の一覧**のリンクから開く(古い分析を見る用)。
- **最新の分析**: 板の発走前の行が `done` で `analysis_id` を持つときのその id。実行中(待ち・取得済み)・失敗・未実行のときは取らず、結果も出さない(再実行の間、前の結果を見せない。前の分析は過去の分析の一覧から見られる)。
- **取得の回数(⚠️ R2 の Class B +1・D1 の書き込み 1 行)**: `GET /api/analyses/{id}` を **id ごとに 1 回**(メモリにキャッシュ。結果画面とキャッシュを共有する)。取るのは、そのレース画面を開いたとき(戻ったときを含む)と、そのレース画面で見ている間に発走前の完了を検知したとき(新しい id を 1 回)だけ。**ポーリングの周期では取らない・再描画や開閉では取らない・失敗は自動で再試行しない**。したがって、完了済みのレースを開くたびに id ごとに 1 回ずつ R2 を読む(12 レースを順に開けば 12 回。**ページを再読込するとキャッシュが消えて取り直す**)。
- **失敗**: 固定の文言(サーバの文面は出さない)と「更新で再取得できます」の案内をカードに出す。**「更新」は、失敗した最新の分析だけを取り直す**(成功した分析は取り直さない)。取得中は「読み込み中」で、「更新」は押せない。
- **【記録】**: 板で `done` なのに `analysis_id` が無い場合(サーバ側では到達しない)は何も出さない/取得した分析の `raceId` が画面のレースと違う場合の検査はしない(板の行から取った id なので、サーバの整合が前提)。
- **実機で確認する項目**(自動検査できない): 結果を含むカードの長さ・スクロール位置・見出しのタップ(44px 以上)・畳んだときの見た目。
- 検査: `test/client-race.test.ts`(`latestAnalysisIdOf`・`card.result`)・`client-view.test.ts`(カードの結果の VNode・`data-*` の契約・XSS)・`client-app.test.ts`(取得の回数・失敗・「更新」・開閉・結果画面とのキャッシュ共有)・`client-app-run.test.ts`(ポーリング・完了への遷移・再実行・一覧にいる間の完了)。

## スマホ画面の土台と名前(Issue #191〈#165-h〉。v1.19.21)
- **名前**: web の画面の名前は **Uma Driller**(`<title>`・見出し。`/check` は「Uma Driller(確認ページ)」)。**exe の名前は変えない**(#190)。見出しは**トップ(一覧の画面)へのリンク**(`<a href="#">`。押すと今日・中央の一覧に戻る)。
- **カードの説明**: レース画面の「朝の準備」「発走前」のカードに、何をするかの説明(1〜2行)が出る。内容は実際の挙動に合わせてある。朝の準備は、出馬表・オッズ・各馬の戦績・調教(**調教は中央のみ**。地方には調教のページが無い)を netkeiba から取得して3着内率の順位を出す(頭数によるが**1分弱**。gate の最小間隔 2 秒 × 取得の本数〈中央は頭数 N なら N+3 本、地方は調教が無いので N+2 本〉からの導出で、**実測はしていない**)・戦績・調教は発走前に使い回す・分析の履歴には残さない。発走前は、出馬表と最新のオッズ(組合せオッズは設定が ON のとき)を取り直し、3着内率・EV を出して記録に残す(**配分は、総資金・1レースの上限を設定しているときだけ**出る。既定は両方 0 で、出ない)。**現在は LLM を使わない**(#179 で LLM を使うようになったら、この説明を直す)。
- **画面の判定**: 「今どの画面か」は `client/route.ts` の `screenOf(route)`(`list`・`race`・`result`。analysis > race > 一覧の優先)に集約した。`app.ts` は `switch` と `never` の網羅チェックで使う(画面を足すとき、`case` の足し忘れが型エラーになる)。
- **core の変更**: 調教(追い切り)のキャッシュ許容鮮度 `DEFAULT_OIKIRI_TTL_MS` を 6 時間から 24 時間(戦績と同じ)に延ばした。調教は当日の朝に取れていれば、その後に更新されないため(ユーザー判断 2026-10-07)。朝の準備(午前)で取った調教が、夕方の発走前の分析でも使い回される。exe にも効くが、取り直しが減るだけで分析結果は変わらない。
- **実機で確認する項目**(自動検査できない): 見出しのリンクのタップ(44px 以上・押すと一覧に戻る)・カードの説明の見え方(長さ・折り返し)・朝の準備の実所要時間(説明の「1分弱」)。
- 検査: `test/page.test.ts`・`client-route.test.ts`(`screenOf`・`app.ts` が画面を直接比べないこと)・`client-race.test.ts`・`client-view.test.ts`(カードの説明)・`packages/core/test/scraper/scrape-race-shutuba-ttl.test.ts`(調教の鮮度の境界)。

## スマホ画面の「ログイン中」の表示名(Issue #192〈#165-i〉。v1.19.23)
変更は `cloud/client/` のクライアントだけ(サーバ・CSP・`page.ts`・`dom.ts` は無変更。exe も無変更)。
- **何をするか**: ページの読み込み後に **1 回だけ** `GET /cdn-cgi/access/get-identity`(同じオリジン・`credentials: "same-origin"`)を呼び、応答の `name` が整えたあとに空でなければ、「ログイン中: …」の行のメールアドレスを、その名前に置き換える。ハッシュの遷移・「更新」・設定画面への遷移では呼ばない。CSP の `connect-src 'self'` が同じオリジンの `/cdn-cgi/` を許す。
- **取れなかったときは、メールアドレスのまま(これが正しい挙動)**: 通信失敗(セッション切れのリダイレクトによる CORS 失敗を含む)・200 以外・JSON でない(HTML が返った)・オブジェクトでない・`name` が文字列でない・整えた結果が空。失敗は画面に出さず、再試行もしない。`name` 以外のキーは読まない(Content-Type も確認しない。HTML なら `json()` が失敗して同じ結果になる)。
- **名前は表示にだけ使う。認可には使わない**(認可はサーバの JWT の検証だけ)。名前を出すとき、メールアドレスはどこにも残さない(`title` 属性などにも出さない)。
- **整え方**(`client/identity.ts` の `sanitizeDisplayName`): 先頭の 1,000 UTF-16 単位だけを読む → 制御文字・行/段落の区切り・双方向制御(U+061C・U+200E/200F・U+202A〜202E・U+2066〜2069)・幅ゼロの空白(U+200B)・BOM・孤立したサロゲートを落とす → 前後の空白を除く → **64 コードポイントまで**(超えたら先頭 63 + 「…」。サロゲートペアを割らない)。**ZWJ・ZWNJ(U+200D・U+200C)は残す**(絵文字の結合・ペルシャ語やインド系の文字の表示に要るため)。内部の空白(全角を含む)は畳まない。
- **書き込み**: 「ログイン中」の行は `page.ts` の静的な HTML(`p.who > span.email`)で、VNode の mounter(`dom.ts`)の外にある(許可リストの対象外。mounter の担当は `#app` だけ)。`main.ts` が `document.querySelector(".who .email")` を `identity.ts` の `applyDisplayName` に渡し、**`textContent` だけ**で書く(HTML として解釈されない)。セレクタ `WHO_NAME_SELECTOR` と `renderPage` の出力との対応は、`test/client-identity.test.ts` が固定している。JavaScript が無い・失敗したときは、サーバが描いたメールアドレスのまま。
- **ローカル(wrangler dev・smoke)**: `/cdn-cgi/access/get-identity` は Access の機能で、ローカルには無い(Worker は JWT が無い要求に 403 の平文を返す)。`json()` が失敗して、メールアドレスのままになる。smoke はブラウザを動かさず `/app.js` を文字列として取るだけで、影響しない。
- **検査**: `test/client-identity.test.ts`(取得の表・整形の表・境界・書き込み・`renderPage` との対応)・`test/client-bundle.test.ts`(生成物を偽の DOM・偽の fetch で実行: 1 回だけ呼ぶ・`textContent` に入る・失敗でメールのまま・遷移で呼ばない)。
- **実機で確認する項目(自動検査できない。本番の Access の後ろでしか確かめられない)**:
  - **Google 経由でログインしたとき、`name` が出るか**(「ログイン中:」の行がメールアドレスでなく Google のユーザー名になるか)。`get-identity` の実際の応答の形(`name` のキー名・IdP ごとの違い)は、こちらでは観測できていない。
  - **出ない場合は、メールアドレスのまま表示されること**(それが正しい挙動であり、不具合ではない)。ワンタイムピンなど `name` を持たない IdP でも同じ。
  - 未ログイン・セッション切れのときに、画面が壊れず(エラーが出ず)メールアドレスのままであること。
  - 名前の表示がスマホで折り返しても崩れないこと(長い名前は 64 文字で「…」になる)。

## スマホ画面の一覧を場ごとに畳む(Issue #187〈#165-e〉。v1.19.18)
- **使い方**: 一覧の場の見出し(`▸ 大井・実行中 3・失敗 1` のような 1 行のボタン。レース数は出さない)をタップすると、その場のレースが開閉する。場が 2 つ以上なら、最初は全部閉じている(1 場なら開いている)。見出しの要約は、その場の実行中(待ち・取得済み)・失敗のレース数(0 は出さない。板が取れていないときは要約なしで場名だけ)。
- **覚え方**: 開閉の状態はアプリのメモリに (開催日, 区分) ごと・場ごとに持つ(**ページを再読込すると既定に戻る**。ハッシュ・localStorage には持たない)。「更新」・レース画面から一覧への戻りでは保たれる。開閉で取得は起こらない。
- **実機で確認する項目**(自動検査できない。デプロイ後にユーザーが確認する):
  - 見出しのタップ領域(44px 以上)・開閉が ▾/▸ の文字で分かること。
  - **スクロール位置**: 見出しをタップして場が縮む・伸びるとき、画面が意図せず飛ばないか(画面は描画のたびに DOM を全置換するので、実機で見る)。
  - 「更新」を押したあと、開いていた場が開いたままか。
- **【記録】**: ボタンを押すとフォーカスが `body` に戻る・`#app` が `aria-live="polite"` のため開閉で画面全体が読み上げ直される可能性がある(#186 で「同じ木なら DOM を触らない」ようにしたが、木が変わる描画では同じ。下の節の【記録】)。

## スマホ画面の起動と状態の追跡(Issue #186〈#165-d〉。v1.19.19)
- **使い方**: レース画面の各カードの起動のボタン(朝「朝の準備を実行」・発走前「発走前の分析を実行」。完了後は「やり直す」「再実行(新しい分析として保存されます)」)を押すと、`POST /api/analyses/run`。**netkeiba へ実際に取得に行く**ので、確認ダイアログは出さないが二重押しは防ぐ(送信中は押せない)。押すと「待ち」→「取得済み」→「完了」と、バッジが自動で変わる。
- **追跡**: `status` を 3 秒 × 10 回・その後は 5 秒で取る。**全部終わる・5 分たつ(非表示の時間は数えない)・通信の失敗が 3 回続く**のどれかで止まる。止まったときは注記と「状態を更新」ボタンが出る(押すと、すぐ取って再開)。ページを非表示にしている間は止まり、戻るとすぐ更新される。
- **Origin(仕様の読みと保険)**: 起動の `fetch` に `referrerPolicy: "same-origin"` を付け、`mode` は指定しない。**現行の Fetch 仕様では、fetch の既定(mode が cors)の POST は参照元ポリシー no-referrer でも実際の Origin を送るので、仕様上は不要の見込み**で、ブラウザ差への保険。詳細は `docs/current-spec.md` の「スマホ画面の起動と状態の追跡」。
- **実機で確認する項目**(自動検査できない。デプロイ後にユーザーが確認する):
  - **起動が 403 にならないこと**(403 の文言は、Origin の不一致なら「Origin の不一致」、ログインの期限切れなら「ログインの期限切れ」と分かれる)。
  - 起動のボタンのタップ・押した直後の表示・バッジが自動で変わること。
  - 場の開閉・日付ピッカーが、ポーリングで壊れないこと。
- **レース数を外した**: 場の見出しは `▸ 門別・実行中 n・失敗 m`(要約が無ければ `▸ 門別`)。
- **【記録】**: 木が変わる描画ではフォーカスが `body` に戻る・`aria-live` が画面全体を読み上げ直す可能性/ 取得のタイムアウトが無い(取得が止まったままだと追跡も止まる。「状態を更新」で再開できる)。

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

## LLM の土台(Issue #193〈#179-a〉。**挙動は変えない**。実行本体は #194)
発走前の分析で LLM(Anthropic の API)を使うための**依存と入口だけ**を足した。本番の入口(`worker.ts`)・`RaceDay` は、まだ LLM を呼ばない(呼び出し元は #194)。
- **`@anthropic-ai/sdk` を cloud の依存に足した理由**: core の `anthropic-client.ts`(メッセージ送信)・`model-selection.ts`(Models API)が値で import する。cloud は workspace の外で `packages/core/node_modules` が CI に無いので、cheerio と同じく cloud/node_modules に入れ、**3か所の alias**(`wrangler.toml`・`tsconfig.json`・`vitest.config.ts`)で向ける。
  版は core の `package.json` の範囲(`^0.70.1`)と同じ **0.70.1 を exact で固定**(`scripts/test/cloud-config-guard.test.ts` が一致と、`pnpm-lock.yaml` への固定を検査)。推移的に増えるのは 3 パッケージ(json-schema-to-ts・@babel/runtime・ts-algebra)。
- **`@keiba/core/llm`**(core の `src/llm.ts`): `analyze-race`・`anthropic-client`・`model-selection` の再 export だけの狭い入口。better-sqlite3 を値でも型でも経由しない(`packages/core/test/ev/native-free-modules.test.ts`)。`@keiba/core/pipeline` に足さない理由は、SDK がバンドルに入る経路を「この入口を import したとき」だけにするため(`test/bundle-guard.test.ts` が、pipeline だけの入口に SDK の文字列が無いことを検査)。
- **`src/llm-sender.ts`**: クラウド版の呼び出しの設定値を1か所に置く(sender の上限時間 180 秒〈**暫定**。実 API で測ってから調整〉・モデル一覧 30 秒・SDK の内部再試行 0 回)。core の `createSdkMessageSender`・`createSdkModelLister` に、省略可の `timeout`・`maxRetries` を足した(exe は渡さない。省略時は SDK の既定のまま)。
  再試行を 0 にする理由: SDK の既定(2 回)と `analyzeRace` の再送(1 回)が重なると、1 レースの HTTP が最大 9 本になる。cloud は `analyzeRace` の再送だけに任せる。
- **バンドルの実測**(`wrangler deploy --dry-run`): SDK + `analyzeRace` 一式の入口(NetkeibaGate の export を含む probe)で 309.94 KiB・gzip 63.10 KiB(本番の現状は 1952.76 KiB・gzip 512.63 KiB)(`test/bundle-guard.test.ts` が、本番との和が 3 MB に収まることと、単体 512 KiB 以内を検査)。
- **Workers での実行**: 偽 fetch を注入した workerd(`wrangler dev --local`)で、Models API の取得 → メッセージ送信が通ること、`timeout` が効くこと、429 で `maxRetries` の既定が 3 本・0 が 1 本であることを確かめた。**実 API には出ていない。**
- **API キーの secret(`ANTHROPIC_API_KEY`)は、この Issue ではまだ使わない**(登録の案内は #194 で行う。上の「Worker の secret」の表は更新しない)。

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
**編集は Issue #189**(下の「設定の API」と「設定画面」)。直接 D1 に入れてもよい: `wrangler d1 execute DB --remote --command "INSERT INTO cloud_settings (id, settings_json, updated_at) VALUES (1, '{\"bankroll\":1000000,\"perRaceCap\":100000}', datetime('now')) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at"` のように入れる(項目と検証は `cloud/src/settings.ts`)。

### 設定の API(Issue #189)
- `GET /api/settings` — `{ "ok": true, "settings": {…14項目。camelCase}, "source": "default"|"d1"|"invalid" }`。`default` は行が無い、`invalid` は行があるが JSON として読めない、またはオブジェクトでない(`null`・`[]`・`123` など。どちらも既定値を返している)。**読む側**の範囲なので、D1 に手で入れた不正な項目は、その項目だけ既定値になって返る。D1 の失敗は 503(`d1-error`。文面なし)。GET だけ(HEAD・PUT 等は 405。`Allow: GET, POST`)。
- `POST /api/settings` — 本文は **14項目すべて**の JSON(全項目の置き換え。部分更新は受けない)。成功は 200 で `{ "ok": true, "settings": {…保存した設定} }`。**同じオリジンのページから**(`Origin` が必要。`POST /api/analyses/run` と同じ守りで、`readJsonObjectBody` を共有する)。順序: Origin(403)→ Content-Type(415)→ 本文の大きさ(413。上限は **16 KiB**。run は 1 KiB)→ JSON のオブジェクト(400)→ 項目の検証(400)→ 保存(D1 の失敗は 503)。
  - 項目が欠けている・未知のキーがある・範囲外の値があるときは 400(黙って既定値に戻さない)。本文は固定の message と、欠けた・範囲外の**既知の項目名**(`fields`)。入力の値・未知のキー名は返さない。
  - **範囲(書く側)**: bankroll 整数 0〜1億 / perRaceCap 整数 0〜1000万 / evThreshold > 0 / kellyFraction **0.05〜1**(読む側は 0〜1。exe の画面と同じ下限) / clipVariant `default`・`wide15` / include 系は真偽値 / **preRaceOffsetMinutes 整数 10〜180(既定 45。cloud 専用。定時の自動実行〈#166〉を入れるまで効かない)** / additionalInstruction **2,000 文字まで**(UTF-16 コード単位。読む側には上限が無い。#179 のプロンプトの組み立ては自分でも切り詰めること)。
  - 書く側は読む側の部分集合(書ける値は必ず読める)。述語は `cloud/src/settings.ts` の `CLOUD_SETTINGS_RULES` に項目ごとに1か所。
  - 検査: `test/settings.test.ts`(境界値の表・保存 → 読み戻し)・`test/handler-settings.test.ts`・`test/handler-json-guard.test.ts`(守りの順序を run と同じ表で)。

### 設定画面(Issue #189。`#settings`)
- **入口**: トップ(一覧の画面)の「設定」リンク(`#settings`)。`#settings` の**完全一致**のときだけ設定画面(`#settings&date=…` などは従来どおり)。戻るは `#`(今日・中央の一覧)。
- **項目と並び**: exe の設定画面に合わせる(EV閾値 → 組合せオッズの取得 → 各券種を配分に含めるか〈ワイド・馬連・枠連・馬単・三連複・三連単〉→ 資金・1レースの上限・ケリー係数 → 追加指示 → クリップ幅)。末尾に cloud 専用の「発走の何分前に評価するか」(「定時の自動実行を入れるまで効きません」と注記)。ラベルは exe の共有定数を流用し、補助文は cloud の実際の挙動に合わせた(**追加指示・クリップ幅は、現在は LLM を使わないので効かない**〈#179〉と注記)。
  API キーと Discord の Webhook は出さない(Worker の secret)。LLM の ON/OFF と上限は作らない。
- **取得**: 開くと `GET /api/settings` だけ(一覧・板・レース・分析は取らない)。失敗は自動で再試行せず、「再読込」(未保存の入力は捨てる)だけ。`source` が `default` なら「まだ保存されていません(既定値を表示しています)」、`invalid` なら「保存済みの設定が読めないため、既定値を表示しています」。
- **追跡中も入力中の欄を壊さない**: 設定画面の**強制なしの再描画**(追跡のポーリング・他の取得の完了など、設定画面の外の原因)は、最後に強制描画したときの内容(画面に出ている内容)から木を作る。打っている途中の下書きは、次の強制描画(保存・再読込・取得完了・検証エラー・失敗)まで木に出さない(木が同じなので DOM を置き換えず、フォーカス・スマホのキーボードが保たれる)。保存は最新の下書きを読む。
- **下書きと保存**: 入力は下書きを書くだけで再描画しない(数値欄・追加指示は `input`〈打つたび〉と `change`、チェックボックス・選択は `change`)。保存・再読込・失敗の直後は強制的に再描画する。**保存の押下時**に項目ごとに検証し(エラーは項目の下)、OK なら全 14 項目を POST する。保存中は入力欄・保存ボタンが無効(二重に送らない)。サーバの失敗は固定の文言(入力は残る)。成功は「保存しました。次に実行する発走前の分析から使われます。」。画面を離れたら下書きを破棄する。
- **検査**: `test/client-settings-form.test.ts`・`client-view-settings.test.ts`・`client-app-settings.test.ts`・`client-api-settings.test.ts`・`client-api-settings-contract.test.ts`・`client-dom.test.ts`・`client-bundle.test.ts`(生成物を偽の DOM で実行)。
- **実機(スマホ)で確かめること(自動検査できない)**:
  - **入力の直後(キーボードを閉じずに)「保存」をタップしたとき、直前の入力が保存に含まれること**。`change` は入力欄を離れたとき(blur)に発火し、click との順序はブラウザ次第で観測できないので、**数値欄・追加指示は `input`(打つたび)でも下書きを書く**ようにした(blur の順序に頼らない)。実機で、打った直後に保存して、保存後の表示が打った値であることを確かめる。チェックボックス・選択は選んだ時点で `change` が届く。
  - 数値欄で数字のキーボードが出ること(`inputmode`)。textarea・select の見た目と、チェックボックスのタップのしやすさ(44px)。
  - 保存のあとにページを再読み込みして、保存した値が出ること。画面を離れて戻ると、未保存の入力が消えること。
