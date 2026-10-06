# cloud/ — クラウド版(Cloudflare Worker)

Issue #161(#21-C)の土台と、#162(#21-D)段階2の netkeiba 取得の出口(ソケット・ゲート・確認ページ)。分析・保存・画面は後続の Issue(#163〜)で載せる。**pnpm workspace の外**にあり、
独自の lockfile を持つ(既存の Windows CI のインストールを重くしないため)。

## 構成
- `src/handler.ts` — リクエスト処理の本体。**すべてのルートの前に認証**を掛ける(`GET /`、`GET /api/health`)
- `src/access-jwt.ts` / `src/authenticate.ts` — Access の JWT の検証(署名・iss・aud・exp・許可メール1件)。取得元はヘッダ → クッキー、**JWT がどちらにも無いときだけ** `ctx.access`(JWT が付いていて不正なら `ctx.access` では救わず拒否)
- `src/netkeiba-gate-do.ts` — **netkeiba への取得の出口**(SQLite バックエンドの Durable Object。#162 段階2a)。全取得を単一インスタンス(固定名)に通し、DO の中の TCP ソケットで取得する。`cloudflare:sockets` を import するのはここだけ(薄い配線)
- `src/gate-core.ts` — ゲートの中身(**純ロジック**。Node でテストできる)。取得先の許可リスト(https の race / db / nar.netkeiba.com だけ)・直列化(同時に1本。プロミスの連鎖)・最小間隔 2 秒(最後の開始時刻を `ctx.storage.kv` に永続化)・サーキットブレーカー(400/403/429 が2回連続で30分、すべての取得を接続せずに拒否。手動リセットなし)・待ち行列の上限(8)
- `src/socket-fetch.ts` / `src/http1.ts` — ソケットで HTTP/1.1 を話す取得クライアント(`connect` を注入。送るヘッダは固定の4つ + `Host` + `Connection: close`、圧縮は要求しない、再試行・リダイレクト追従なし、サイズ上限 2 MiB・タイムアウト 20 秒)。調査(`spikes/cloudflare/`・`scripts/cloudflare-spike/`)の実装を本番用に作り直したもので、調査のコードは参照しない
- `src/gate-fetch.ts` — ゲートの `fetchRaw`(RPC)を core の `HttpClient` の fetch 注入口へ繋ぐ(`createGateHttpClient`: 間隔 0・再試行 0。間隔制御はゲートだけが行う)。**Worker の `fetch` で netkeiba を取る経路は持ち込まない**(#160。CloudFront から HTTP 400 になる)
- `src/netkeiba-check.ts` / `src/page.ts` — 確認用エンドポイント `GET /api/netkeiba/check` の処理(race_id の検証・出馬表の取得とパース)と、`/` のフォーム(使い方は下の「確認ページの使い方」)
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
```

## デプロイ
`.github/workflows/deploy-cloud.yml`。許可した作業ブランチの上で、承認印 `[PUBLISH-APPROVED]` 付きの push(「レビュー継続中」を含まない)
または手動実行のときだけ、`check`(型検査・テスト・dry-run・スモーク)の後に本番へ出す。

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
7. API トークンの権限の追加は不要(Access の設定はユーザー本人のダッシュボード操作)。

## 初回の実機確認で見ること
Workers Logs(`observability` を有効にしてある)に、認証の経路が `access: ok via=header` / `via=cookie` / `via=ctx-access` で出る。
どれで通ったかで、Worker レベルの Access が JWT ヘッダ・クッキーを渡すかが分かる(公式ドキュメントには明記がない)。
**2026-10-06 の初回確認では `via=header`** だった(Worker 単位の Access は JWT を `Cf-Access-Jwt-Assertion` ヘッダで渡す。#161)。
拒否は `access: denied reason=<経路:理由コード>` で出る(トークン・メール・チーム名・AUD は出ない)。

## 確認ページの使い方(#162 段階2。本番での実機確認)
netkeiba の取得が、本番(Cloudflare)で通ることを、出馬表1本で確かめるページ。**netkeiba へ実際にリクエストが出る**(1回の確認で1本。ゲートが 2 秒間隔・直列に絞る)。
1. Access でログインして `/` を開く。「netkeiba の取得の確認」のフォームがある(初期値は `202603020211`)。
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
