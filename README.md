# keiba-ev-tool

netkeibaのデータから**期待値がプラスの馬券**(複勝を軸に、単勝・ワイド・馬連・馬単・三連複・三連単・枠連まで)を抽出する分析ツール。

## 個人利用専用(重要)

> netkeibaのスクレイピングは同サイトの規約上グレーです。本ツールは**個人の分析用途に限定**して使用してください。

- リクエストは最低1.5秒間隔・User-Agent明示で行い、取得結果はSQLiteにキャッシュして**同一レースの再取得を避けます**。
- 取得したデータの再配布や商用利用は行わないでください。
- 馬券購入の自動化は行いません(本ツールは分析・通知まで)。

## 概要

Windows デスクトップアプリ(Electron + React。**アーカイブ済み**。最後の版は GitHub の Releases の `dev-latest`)と、web 版(下記の Uma Driller)。1レース分のデータ取得から、
期待値の算出、LLM(Claude API)による補正・根拠出し、馬券配分の提案、結果の検証(予実・回収率)、
Discord 通知までを一貫して行えます。主な機能:

- **取得**: netkeiba から出馬表・全戦績・調教評価・単勝/複勝オッズ(設定でワイド・馬連・馬単・三連複・三連単・枠連などの組合せオッズも)を取得(1.5秒間隔・SQLite キャッシュ)。中央/地方、期間指定の一括取得に対応。
- **スコアリング**: 複勝圏内確率(prior)を各種バイアス(コース形態・季節・輸送・脚質など)込みで算出し、複勝オッズから期待値を計算。
- **LLM 分析**: 展開想定・馬場や当日傾向・馬体重推移・人気着順乖離・乗り替わり・着差など多数の材料をプロンプト化し、Claude が補正後確率と根拠を返す(プロンプト版を記録し A/B・キャリブレーションを計測)。
- **馬券配分の提案**: 設定した総資金・1レース上限・ケリー係数のもとで、EV プラスの買い目への配分を券種横断で提案(複勝・単勝・組合せ券。組合せ券は券種ごとに配分へ含めるか選べる)。
- **検証**: 結果を取り込み、予測と実績のブレークダウン(中央/地方別・版別)を表示。提案した配分どおりに賭けた場合の回収率も券種別に集計。
- **通知**: EVプラス馬を Discord へ embed 送信(手動/自動)。

現状の仕様は [`docs/current-spec.md`](./docs/current-spec.md)、当初の設計・計画(Phase 1→6)の記録は
[`keiba-ev-tool-spec.md`](./keiba-ev-tool-spec.md)、開発ルールは [`CLAUDE.md`](./CLAUDE.md) を参照。

**Uma Driller(クラウド版)**: Cloudflare Worker 上で動くスマホ向けの web 画面(`cloud/`)。
開催日のレース一覧と、朝の準備・発走前の分析結果(3着内率・EV・配分提案)を見られ、設定の編集、
毎朝の自動実行(中央は全レース、地方は交流重賞のみ)と Discord 通知にも対応します。
Cloudflare Access(Google ログイン)で保護され、利用者自身が Cloudflare に構築して使います
(手順は [`cloud/README.md`](./cloud/README.md))。デスクトップアプリとは独立しています。

構成(pnpm ワークスペース):

```
packages/core   … スクレイパ・パーサ・スコアラ・ファサード(@keiba/core)
packages/app    … Electron + React デスクトップアプリ(@keiba/app)
scripts         … CLI等の起動シェル
fixtures        … テスト用の保存済みHTML/JSON(実サイトへはアクセスしない)
docs            … 現状の仕様・運用規約・調査記録
cloud           … クラウド版 Uma Driller(Cloudflare Worker。pnpm ワークスペースの外)
```

## CLI: レースデータのJSONダンプ(開発補助)

出走馬・全戦績・調教評価・単勝/複勝オッズを1レース分まとめて取得し、整形JSONで出力します
(取得層の動作確認・デバッグ用の補助 CLI。通常利用はデスクトップアプリで行います)。

```bash
# 1レースの完全データをダンプ(標準出力)
pnpm tsx scripts/dump-race.ts --race 202603020211

# ファイルに保存
pnpm tsx scripts/dump-race.ts --race 202603020211 --out race.json

# 発走直前にオッズだけキャッシュを迂回して再取得
pnpm tsx scripts/dump-race.ts --race 202603020211 --fresh-odds

# 開催日のレース一覧をダンプ
pnpm tsx scripts/dump-race.ts --date 20260628
```

オプション:

| フラグ | 説明 | 既定 |
|--------|------|------|
| `--race <race_id>` | 1レースの完全データをダンプ(`--date` と排他) | — |
| `--date <YYYYMMDD>` | 開催日のレース一覧をダンプ(`--race` と排他) | — |
| `--out <path>` | 出力先ファイル(未指定なら標準出力) | 標準出力 |
| `--fresh-odds` | オッズをキャッシュ迂回で再取得(`--race` のみ) | 無効 |
| `--db <path>` | キャッシュDBファイル | `cache.sqlite` |

エラー方針:

- **必須データ**(出馬表・オッズ)の取得失敗はコマンド全体を失敗させます。
- **optionalデータ**(調教)の失敗はその項目を `null` にして警告を標準エラーに出し、処理は継続します。
- **戦績**は馬単位で握るため、1頭の取得失敗では全体を落とさず、その馬のみ `results: null` + 警告になります。

## Windows 版(exe)はアーカイブ済み

**exe 版の公開は止めました**(2026-10-10。Issue #248)。以後の機能追加と統計モデルの見直しは web 版(Uma Driller。`cloud/`)だけが対象です。

- **最後の版**: GitHub の Releases → `開発版(最新ビルド)`(タグ `dev-latest`)に、`keiba-ev-tool-1.44.0-portable.exe`(portable 版・インストール不要。ダブルクリックで起動)を残してあります。これ以上は更新されません。
- **版数は 1.44.0 で凍結**しました([`docs/versioning.md`](./docs/versioning.md))。
- exe のビルドと `dev-latest` への公開をしていたワークフローは削除しました。いまの CI は [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)(型検査・テスト・`@keiba/app` のビルドの関門。公開はしない)と [`.github/workflows/deploy-cloud.yml`](./.github/workflows/deploy-cloud.yml)(web 版の検査と本番デプロイ)です。
- `packages/app` のコードとテストは残してあります(web 版が一部を import しています)。パッケージングの設定(`packages/app/electron-builder.yml`)も削除していません。
- **個人利用専用**である点は本ツール全体と同様です。
- exe に残っている過去の分析・結果を web 版へ移す手順は、`cloud/README.md` と、web 版の設定画面の「exe から移行」を参照してください。

### トラブルシュート

- **レース一覧取得などで「ネットワークエラーによりリクエストに失敗しました」**: Electron 内蔵 Node(20)と、以前 core が直接依存していた undici 8(engines は Node22+)の非互換で HTTP 取得が実行時に失敗していました。修正済み: main プロセスは Electron の `net.fetch` を注入して取得し(undici の fetch を呼ばない)、加えて core の undici を Electron 互換の ^7 へ整合させています(多層防御)。それでも失敗する場合はエラーメッセージ末尾の「(原因: …)」を確認してください。

## Discord 通知(Webhook)の設定

分析結果を Discord のチャンネルへプッシュ通知できます(Phase 5)。まず送信先チャンネルの Webhook URL を用意します。Discord のチャンネル設定 → **連携サービス → ウェブフック → 新しいウェブフック** を作成し、**ウェブフック URL をコピー**します(`https://discord.com/api/webhooks/...` で始まる URL)。アプリの **設定タブ**にその URL を貼り付けて保存すると、分析タブの結果表示に **「Discordに送信」** ボタンが有効化されます。押すと、レース名・日付・会場と **EVプラスの馬**(馬番・馬名・補正後確率・複勝下限・EV)・LLM補正の有無を embed で送信します(EVプラスが無ければ「該当なし」)。設定タブの **自動送信 ON** にしておくと、分析完了時に自動で送信します(送信に失敗しても分析結果自体は画面に表示され、送信失敗のみ通知します)。Webhook URL は個人の送信先を指すため、他人と共有しないでください。

### 仕様との差異(記録)

- **GitHub Actions ビルドの前倒し(記録)**: 仕様書では配布ビルドは Phase 5 の項目ですが、「UI 実装中は常に Releases から exe を入手できる状態を保つ」というユーザー指示により Phase 4 開始時点で先行整備していました。exe の公開は 2026-10-10 に止めました(上記)。
- **renderer は core を直接 import しない**: 仕様「UI はコアを直接 import して使う」に対し、`better-sqlite3` 等のネイティブ依存を renderer 側へ持ち込まないため、renderer は core を直接読まず **main プロセス経由(IPC)** で core の値を受け取る構成にしています。ネイティブ依存を扱う処理は main プロセスに集約する解釈です。

## クラウド版の定時の自動実行(Cloudflare Worker。`cloud/`)
クラウド版(Issue #166・#206)は、**毎朝 JST 9:00(UTC 0:00)に自動で実行を始める**(`cloud/wrangler.toml` の cron が 1 本)。
- **何をするか**: その日の開催の一覧を取得して計画し、**中央は全レース、地方は交流重賞(Jpn1/2/3)だけ**を対象に、発走の 45 分前(設定で変更可)に分析する。結果は Discord に通知する(Webhook を登録した場合)。
- **費用**: netkeiba への取得(中央の開催日は 1 日 700 本前後。間隔 1.5 秒以上)と、**Worker の secret `ANTHROPIC_API_KEY` を登録している場合は Claude API の呼び出し**(中央の開催日は最大 36 レース)が毎朝自動で行われる。API キーを登録しなければ LLM なしで保存する(課金なし)。
- **確かめ方**: `GET /api/plan?kaisai_date=YYYYMMDD`(Access の後ろ)で、計画・各レースの結果・通知の状態を読める。
- **止め方**: `cloud/wrangler.toml` を `crons = []` にしてデプロイする(`[triggers]` を消すだけでは止まらない)。ダッシュボードで消しても次のデプロイで戻る。課金だけ止めるなら `ANTHROPIC_API_KEY` を削除する(netkeiba への取得は続く)。詳しくは `cloud/README.md` の「定時の自動実行」。

## 開発コマンド

```bash
pnpm install                       # 依存インストール
pnpm test                          # packages/core・packages/app・scripts/ のテスト(vitest。cloud/ は含まない)
pnpm typecheck                     # 型検査(packages/core・packages/app と scripts/)

pnpm --filter @keiba/app build     # Electron アプリのビルド(renderer + main/preload。ci.yml の関門にも含まれる)
pnpm --filter @keiba/app build:win # Windows 向け exe を生成(Windows 上でのみ実行可。アーカイブ済みで、CI では使わない)
```

`cloud/` は pnpm ワークスペースの外にあり、依存の導入もテストも `cloud/` で別に実行します(手順は [`cloud/README.md`](./cloud/README.md))。

開発は**テスト駆動(Red→Green→Refactor)**で進めます。scraperのテストは `fixtures/` の保存済みデータに対して行い、実ネットワークへのリクエストはテストに含めません。詳細は [`CLAUDE.md`](./CLAUDE.md) を参照。
