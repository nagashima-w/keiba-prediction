/**
 * CI ワークフロー(.github/workflows/build-windows.yml)の
 * 「レビュー継続中コミットでは dev-latest への公開をスキップする」ゲートに関する
 * 静的な不変条件テスト。
 *
 * 注意: 本テストは yml のテキストを正規表現で検査するものであり、
 * GitHub Actions の式(if:/env: の ${{ }} 式)そのものを実際に評価・実行するものではない。
 * ゲートが CI 上で意図通り動くかどうかは実物検証(オーケストレーターが CI の run で確認する)に委ねる。
 * 本テストが保証するのは「壊れると実害が出る」静的な不変条件のみ。
 *
 * 検証する不変条件:
 * 1. 公開ステップと孤児掃除ステップの if: が完全に一致する
 *    (ずれると「公開せずに掃除だけ実行」となり dev-latest の exe が全滅する — 最重要)
 * 2. 公開可否ゲート(env: PUBLISH_DEV_LATEST)が head_commit.message と「レビュー継続中」を参照している
 * 3. v* タグの正式リリースステップの条件に「レビュー継続中」が現れない
 *    (タグでの正式公開は、レビュー継続中の判定と無関係であるべき)
 * 4. スキップ通知(::notice::)ステップの条件が、ブランチ push / ブランチへの手動実行に限定され、
 *    かつ公開ゲート(PUBLISH_DEV_LATEST)の否定(!=)である
 *    (ブランチ限定でなければ v* タグ push でも誤通知が出る。否定でなければ「!=」→「==」の
 *    1文字反転で「公開成功時に毎回通知・レビュー継続中では無言」という真逆の挙動になり、
 *    「判定していない事象を判定結果として報告する」欠陥に直結する)
 * 5. スキップ通知ステップの文言が、掃除もスキップしたことと回復手段(workflow_dispatch)に触れている
 * 6. スキップ通知ステップに always() が付いていない
 *    (付けると前段の失敗を「レビュー継続中スキップ」と誤って名乗ってしまう)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(
  currentDir,
  "../../../.github/workflows/build-windows.yml",
);

const STEP_NAMES = {
  publish: "Releases に公開(dev-latest を in-place 更新 / ブランチ push 時)",
  cleanup: "dev-latest の孤児 exe アセットを掃除(現行ファイル名以外を削除)",
  skipNotice: "dev-latest 公開スキップをログに記録(レビュー継続中コミット時)",
  tagRelease: "Releases に公開(正式リリース / v* タグ push 時)",
} as const;

/**
 * yml 本文からステップ名で該当ステップのブロック(次のステップ直前まで)を抽出する。
 * `      - name: <name>` の行(6スペースインデント)を境界に素朴に切り出す
 * (js-yaml 等のパーサ依存は禁止されているため、正規表現ベースで必要十分な範囲のみ扱う)。
 */
function extractStep(yml: string, stepName: string): string {
  const steps = yml.split(/\n(?=      - name: )/);
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = steps.find((s) =>
    new RegExp(`^      - name: ${escaped}$`, "m").test(s),
  );
  if (found === undefined) {
    throw new Error(`ステップが見つかりません: ${stepName}`);
  }
  return found;
}

/** ステップブロックから if: 行(1行)を抽出する。 */
function extractIfLine(stepBlock: string): string {
  const match = stepBlock.match(/^\s*if:\s*(.+)$/m);
  const captured = match?.[1];
  if (captured === undefined) {
    throw new Error(`if: 行が見つかりません:\n${stepBlock}`);
  }
  return captured.trim();
}

describe("build-windows.yml の dev-latest 公開ゲート(静的な不変条件)", () => {
  // 改行コードを LF に正規化してから読む。Windows ランナー上の checkout(actions/checkout)は
  // リポジトリの .gitattributes 設定次第で CRLF になりうる。本テストの全パターンは `\n` を
  // 前提にしている。読み込み直後の1箇所で正規化することで、6件すべてのパターンに
  // 個別対応する必要をなくす(パターン側を `\r?\n` にする案は、1つでも直し漏れると
  // 同じ事故が再発するため採らない)。
  const yml = readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n/g, "\n");

  it("公開ステップと孤児掃除ステップの if: 条件が完全に一致する(ずれると exe 全滅)", () => {
    const publishIf = extractIfLine(extractStep(yml, STEP_NAMES.publish));
    const cleanupIf = extractIfLine(extractStep(yml, STEP_NAMES.cleanup));

    // 前提固定: 両ステップとも一元化されたゲート変数を参照していることを先に固定する。
    // これが無いと「一致」の主張が自明(例: 両方とも空文字列)になりうる。
    expect(publishIf).toContain("PUBLISH_DEV_LATEST");
    expect(cleanupIf).toContain("PUBLISH_DEV_LATEST");

    expect(publishIf).toBe(cleanupIf);
  });

  it("公開可否ゲートがコミットメッセージの「レビュー継続中」を参照している", () => {
    // ゲート定義(env: PUBLISH_DEV_LATEST)を含む jobs.build.env ブロックを対象にする。
    const envBlockMatch = yml.match(/\n {4}env:\n([\s\S]*?)\n {4}steps:\n/);
    expect(envBlockMatch).not.toBeNull();
    const envBlock = envBlockMatch![1];

    expect(envBlock).toContain("head_commit.message");
    expect(envBlock).toContain("レビュー継続中");
    // workflow_dispatch で head_commit が null になるケースの暗黙型強制に依存しないための明示。
    expect(envBlock).toContain("github.event_name == 'push'");
  });

  it("v* タグの正式リリースステップの条件に「レビュー継続中」が現れない", () => {
    const tagStep = extractStep(yml, STEP_NAMES.tagRelease);
    const tagIf = extractIfLine(tagStep);

    // 前提固定: 対象ステップがタグ push 判定そのものであること(無関係なステップを誤って
    // 拾っていないことの確認)。
    expect(tagIf).toContain("refs/tags/v");

    expect(tagStep).not.toContain("レビュー継続中");
  });

  it("スキップ通知ステップの条件はブランチ限定かつ公開ゲートの否定(!=)である(タグ push で誤通知せず、== への反転も検出する)", () => {
    const noticeIf = extractIfLine(extractStep(yml, STEP_NAMES.skipNotice));

    // ブランチ限定にしていなければ、v* タグ push でも PUBLISH_DEV_LATEST が false になり
    // 「レビュー継続中のためスキップした」という事実と異なる通知が出てしまう。
    expect(noticeIf).toContain("refs/heads/");

    // 極性固定: 公開ゲートの「否定」(!=)であることを、演算子込みの文字列で固定する。
    // 「PUBLISH_DEV_LATEST を含む」「refs/heads/ を含む」という含有チェックのみでは、
    // != を == に1文字反転しても両方とも真のままで見逃す(実際に反転した変異体で全6件が
    // 緑のまま通過することを確認済み)。反転後の挙動は「公開に成功する度に毎回notice、
    // レビュー継続中コミットでは逆に無言」という正反対のもので、これを演算子ごと固定して検出する。
    expect(noticeIf).toContain("PUBLISH_DEV_LATEST != 'true'");
    expect(noticeIf).not.toContain("PUBLISH_DEV_LATEST == 'true'");
  });

  it("スキップ通知ステップの文言が、掃除もスキップしたことと回復手段(workflow_dispatch)に触れている", () => {
    const noticeStep = extractStep(yml, STEP_NAMES.skipNotice);

    expect(noticeStep).toContain("レビュー継続中");
    expect(noticeStep).toContain("掃除");
    expect(noticeStep).toContain("workflow_dispatch");
  });

  it("スキップ通知ステップに always() が付いていない(前段失敗を誤ってスキップ扱いしないため)", () => {
    const noticeStep = extractStep(yml, STEP_NAMES.skipNotice);
    expect(noticeStep).not.toContain("always()");
  });
});
