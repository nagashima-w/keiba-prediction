# cloud/ — クラウド版(Cloudflare Worker)

Issue #161(#21-C)の土台。取得・分析・保存・画面は後続の Issue(#162〜)で載せる。**pnpm workspace の外**にあり、
独自の lockfile を持つ(既存の Windows CI のインストールを重くしないため)。

## 構成
- `src/handler.ts` — リクエスト処理の本体。**すべてのルートの前に認証**を掛ける(`GET /`、`GET /api/health`)
- `src/access-jwt.ts` / `src/authenticate.ts` — Access の JWT の検証(署名・iss・aud・exp・許可メール1件)。取得元はヘッダ → クッキー → `ctx.access`
- `src/netkeiba-gate-do.ts` — SQLite バックエンドの Durable Object の雛形(#162 で取得と間隔制御に使う)
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
4. **初回デプロイの後に、Worker に Access を掛ける**: Workers & Pages > 対象の Worker > Access タブ > Protect this Worker behind Access > **All traffic**。
   ポリシーの選択肢は公式には Cloudflare account と Email domain の2種類(メール1件の指定は未確認)。作成後に Zero Trust > Access controls > Applications で編集し、
   Include = Emails(許可する1件)、Require = Login Methods(Google)にし、Accepted identity providers から Google 以外(One-time PIN 等)を外す。
   Worker レベルのアプリがその一覧に出るか、編集できるかは未確認。AUD タグも同じ画面で控える(画面上の位置は未確認)。
5. **secret を登録する**(上の表)。
6. API トークンの権限の追加は不要(Access の設定はユーザー本人のダッシュボード操作)。

## 初回の実機確認で見ること
Workers Logs(`observability` を有効にしてある)に、認証の経路が `access: ok via=header` / `via=cookie` / `via=ctx-access` で出る。
どれで通ったかで、Worker レベルの Access が JWT ヘッダ・クッキーを渡すかが分かる(公式ドキュメントには明記がない)。
拒否は `access: denied reason=<経路:理由コード>` で出る(トークン・メール・チーム名・AUD は出ない)。
