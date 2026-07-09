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
