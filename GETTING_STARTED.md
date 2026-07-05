# 開始手順(Claude Code on the web / クラウド版)

ローカルへのインストールは一切不要。Node.js等はすべてクラウドVM側に入る。

## 1. このリポジトリをclaude.ai/codeに接続
- claude.ai/code を開き、GitHubアカウントを連携してこのリポジトリを選択
- Privateリポジトリの場合はGitHubアプリのインストール案内に従う
- 環境(environment)作成時の Network access は、netkeibaへ到達できる設定を選ぶ
  (デフォルトのTrustedはパッケージレジストリのみで、netkeibaには届かない)
- モデルはOpusを指定する

## 2. 最初のプロンプト(貼り付けるだけ)

---

keiba-ev-tool-spec.md の仕様と CLAUDE.md のワークフローに従って開発を進めてください。
必要なツール(Node.js LTS、pnpm等)のセットアップもすべてあなたが行ってください。
あなたはオーケストレーターとして進行管理に徹し、実装は tdd-implementer サブエージェント、
レビューは code-reviewer サブエージェントに委譲してください。
まずPhase 1(scraper)から。最初のタスクとして、対象ページのHTML構造調査と
フィクスチャ取得の計画を立ててから着手してください。
なお、GitHub ActionsでのWindows向けビルド(electron-builder)はPhase 4開始時点で
先に整備し、UI実装中は常にReleasesからexeがダウンロードできる状態を維持してください。

---

## 3. 動作確認の流れ
- ロジック(scraper/scorer/ev)はクラウド上のテストで完結する
- Electronの画面確認は、GitHub ActionsがビルドしたexeをReleasesから
  ダウンロードして手元で起動 → 感想をClaude Codeに返す、の往復で行う
