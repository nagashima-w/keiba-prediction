# yomiyasu の取り込み元

このディレクトリは、外部の Agent Skill「yomiyasu」を取り込んだものである(Issue #466)。
`UPSTREAM.md` 以外のファイルは、上流のものを書き換えずに複製している。

- 上流: https://github.com/nanaism/yomiyasu (`skills/yomiyasu/` 以下)
- コミット: a34d94ffaa93e958316cd0f02cda9273db4dd0e2
- 版: 2.2.0
- 取り込んだ日: 2026-10-23
- ライセンス: MIT

## 除いたファイル

| 除いたもの | 理由 |
|---|---|
| `assets/algo-artis.png`(`assets/` ごと) | 他社のロゴで、スキルからの参照もないため |
| `.codex-plugin/` | Codex 用で、このリポジトリでは使わないため |

## ライセンスのファイル

- `LICENSE`: このディレクトリの直下(MIT)
- `UNICODE-LICENSE.txt`: このディレクトリの直下。`scripts/yomiyasu_lint.py` が Unicode 由来のデータを含むので、同梱が必要である
  (上流のルートにある同名ファイルと内容は同じ)

## 置き方の注意

- `scripts/` と `references/lists/*.txt` の相対配置を崩さない。lint と diff が、実行するときに `scripts/../references/lists/` を読む。
- このスキルは検査の記録を git の最上位の `.yomiyasu/` に書く。ルートの `.gitignore` に `.yomiyasu/` を足してある。

## フックは登録しない

上流には `scripts/yomiyasu_hook.py` が付いているが、`.claude/settings.json` には登録しない。
使う場面は `CLAUDE.md` の「言語規約」の節に書いたものに限る。

## 更新の手順

1. 新しい Issue を立てる(取り込み先の版・差分の概要を書く)。
2. 上流の新しいコミットを取得し、中身を確かめ直す(スクリプトの挙動・ネットワークや外部コマンドの利用・ファイルを書く場所)。
3. 確かめ終えてから、このディレクトリの中身を入れ替える。除いたファイル(上の表)は、入れ替えのたびに除く。
4. 上の「コミット」「版」「取り込んだ日」を書き換える。
