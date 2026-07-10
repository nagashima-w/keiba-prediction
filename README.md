# keiba-ev-tool

netkeibaのデータから**複勝の期待値がプラスの馬券**を抽出する分析ツール。

## 個人利用専用(重要)

> netkeibaのスクレイピングは同サイトの規約上グレーです。本ツールは**個人の分析用途に限定**して使用してください。

- リクエストは最低1.5秒間隔・User-Agent明示で行い、取得結果はSQLiteにキャッシュして**同一レースの再取得を避けます**。
- 取得したデータの再配布や商用利用は行わないでください。
- 馬券購入の自動化は行いません(本ツールは分析・通知まで)。

## 概要

仕様は [`keiba-ev-tool-spec.md`](./keiba-ev-tool-spec.md)、開発ルールは [`CLAUDE.md`](./CLAUDE.md) を参照。
フェーズ順(Phase 1→6)に実装します。

- **Phase 1(現在)**: `@keiba/core` の scraper + JSONダンプCLI。データが正しく取れることの確認を最優先。
- Phase 2 以降: scorer(期待値計算)、analyzer(Claude API)、Electron UI、Discord通知。

構成(pnpm ワークスペース):

```
packages/core   … スクレイパ・パーサ・スコアラ・ファサード(@keiba/core)
packages/app    … Electron + React デスクトップアプリ(@keiba/app、Phase 4)
scripts         … CLI等の起動シェル
fixtures        … テスト用の保存済みHTML/JSON(実サイトへはアクセスしない)
```

## Phase 1 CLI: レースデータのJSONダンプ

出走馬・全戦績・調教評価・単勝/複勝オッズを1レース分まとめて取得し、整形JSONで出力します。

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

## Releases からのダウンロード(Windows)

Phase 4 の UI(Electron アプリ)は、開発ブランチへの push ごとに GitHub Actions で
Windows 向け exe を自動ビルドし、Releases のプレリリース **`dev-latest`** に差し替え公開しています。
UI 実装中は常にここから最新の実行ファイルを入手できます。

- 入手先: リポジトリの **Releases → `開発版(最新ビルド)`(タグ `dev-latest`)**
- ファイル: `keiba-ev-tool-<version>-portable.exe`(portable 版・インストール不要)
- 使い方: ダウンロードした exe をダブルクリックで起動します。

> 注意: `dev-latest` は開発中のローリングプレリリースです。予告なく内容が変わります。**個人利用専用**である点は本ツール全体と同様です。

ワークフロー定義: [`.github/workflows/build-windows.yml`](./.github/workflows/build-windows.yml)。
ビルド構成(パッケージング)は [`packages/app/electron-builder.yml`](./packages/app/electron-builder.yml) を参照。

### トラブルシュート

- **レース一覧取得などで「ネットワークエラーによりリクエストに失敗しました」**: Electron 内蔵 Node(20)と、以前 core が直接依存していた undici 8(engines は Node22+)の非互換で HTTP 取得が実行時に失敗していました。修正済み: main プロセスは Electron の `net.fetch` を注入して取得し(undici の fetch を呼ばない)、加えて core の undici を Electron 互換の ^7 へ整合させています(多層防御)。それでも失敗する場合はエラーメッセージ末尾の「(原因: …)」を確認してください。

## Discord 通知(Webhook)の設定

分析結果を Discord のチャンネルへプッシュ通知できます(Phase 5)。まず送信先チャンネルの Webhook URL を用意します。Discord のチャンネル設定 → **連携サービス → ウェブフック → 新しいウェブフック** を作成し、**ウェブフック URL をコピー**します(`https://discord.com/api/webhooks/...` で始まる URL)。アプリの **設定タブ**にその URL を貼り付けて保存すると、分析タブの結果表示に **「Discordに送信」** ボタンが有効化されます。押すと、レース名・日付・会場と **EVプラスの馬**(馬番・馬名・補正後確率・複勝下限・EV)・LLM補正の有無を embed で送信します(EVプラスが無ければ「該当なし」)。設定タブの **自動送信 ON** にしておくと、分析完了時に自動で送信します(送信に失敗しても分析結果自体は画面に表示され、送信失敗のみ通知します)。Webhook URL は個人の送信先を指すため、他人と共有しないでください。

### 仕様との差異(記録)

- **GitHub Actions ビルドの前倒し**: 仕様書では配布ビルドは Phase 5 の項目ですが、「UI 実装中は常に Releases から exe を入手できる状態を保つ」というユーザー指示により Phase 4 開始時点で先行整備しています。
- **renderer は core を直接 import しない**: 仕様「UI はコアを直接 import して使う」に対し、`better-sqlite3` 等のネイティブ依存を renderer 側へ持ち込まないため、renderer は core を直接読まず **main プロセス経由(IPC)** で core の値を受け取る構成にしています。ネイティブ依存を扱う処理は main プロセスに集約する解釈です。

## 開発コマンド

```bash
pnpm install                       # 依存インストール
pnpm test                          # 全パッケージのテスト(vitest)
pnpm typecheck                     # 型検査(packages/core・packages/app と scripts/)

pnpm --filter @keiba/app build     # Electron アプリのビルド(renderer + main/preload)
pnpm --filter @keiba/app build:win # Windows 向け exe を生成(Windows 上でのみ実行可)
```

開発は**テスト駆動(Red→Green→Refactor)**で進めます。scraperのテストは `fixtures/` の保存済みデータに対して行い、実ネットワークへのリクエストはテストに含めません。詳細は [`CLAUDE.md`](./CLAUDE.md) を参照。
