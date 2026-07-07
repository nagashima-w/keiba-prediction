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
packages/core   … スクレイパ・パーサ・ファサード(@keiba/core)
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

## 開発コマンド

```bash
pnpm install        # 依存インストール
pnpm test           # 全パッケージのテスト(vitest)
pnpm typecheck      # 型検査(packages/core と scripts/)
```

開発は**テスト駆動(Red→Green→Refactor)**で進めます。scraperのテストは `fixtures/` の保存済みデータに対して行い、実ネットワークへのリクエストはテストに含めません。詳細は [`CLAUDE.md`](./CLAUDE.md) を参照。
