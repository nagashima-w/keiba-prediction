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
 * 1. 公開ステップと孤児掃除ステップの if: が、公開を許可する極性(== 'true')で完全一致する
 *    (ずれると「公開せずに掃除だけ実行」となり dev-latest の exe が全滅する — 最重要。
 *    「一致」だけの検査だと、両方が同時に != 'true' へ反転しても素通りしてしまうため
 *    「一致」と「期待する極性そのもの」の両方を固定する)
 * 2. 公開可否ゲート(env: PUBLISH_DEV_LATEST)の定義行が期待する式と完全一致する
 *    (head_commit.message・「レビュー継続中」参照に加え、外側の否定 !(...)・event_name の
 *    == 判定・refs/heads/ 限定・&&/|| の結合順のすべてを1つの完全一致で固定する。部分一致
 *    (toContain)の組み合わせだと、`!` の除去・演算子の反転・&&/||の入れ替えなどを個別に
 *    見逃す穴が残ることが実際に確認されたため、字句そのものをピン留めする)
 * 3. v* タグの正式リリースステップの条件に「レビュー継続中」が現れない
 *    (タグでの正式公開は、レビュー継続中の判定と無関係であるべき)
 * 4. スキップ通知(::notice::)ステップの条件が期待する式と完全一致する
 *    (ブランチ限定・公開ゲートの否定・&&の結合をすべて1つの完全一致で固定する。
 *    部分一致の組み合わせでは `&&` → `||` への反転(常に通知が出るようになる事故)を
 *    見逃すことが実際に確認されたため、字句そのものをピン留めする)
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

/**
 * yml 本文から `<key>: <値>` の定義行(1行、実コード行のみ)を抽出する。
 * `^\s*<key>:` で行頭からキーを要求するため、`# PUBLISH_DEV_LATEST: ...` のような
 * コメント行(先頭が `#`)にはマッチしない。これにより、コメント中の記述が実コードの
 * 演算子検証を偽装して素通りさせる事故(コメントと実コードが乖離しても toContain が
 * 満たされてしまう)を避ける。
 */
function extractEnvValue(yml: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = yml.match(new RegExp(`^\\s*${escaped}:\\s*(.+)$`, "m"));
  const captured = match?.[1];
  if (captured === undefined) {
    throw new Error(`env 定義行が見つかりません: ${key}`);
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

  it("公開ステップと孤児掃除ステップの if: 条件が、公開を許可する極性(== 'true')で完全一致する(ずれると exe 全滅)", () => {
    const publishIf = extractIfLine(extractStep(yml, STEP_NAMES.publish));
    const cleanupIf = extractIfLine(extractStep(yml, STEP_NAMES.cleanup));

    // 期待値そのものを固定する。「publishIf === cleanupIf」という一致だけの検査だと、
    // 両方が同時に == → != に反転しても(等価性は保たれたまま)素通りしてしまう
    // (実際に変異させて素通りすることを確認済み。この場合レビュー継続中コミットでのみ
    // 公開・掃除が走るという完全な意味の逆転になる)。期待する極性そのものを固定することで、
    // 「片方だけのズレ」と「両方同時のズレ」の両方を検出する。
    const expected = "env.PUBLISH_DEV_LATEST == 'true'";
    expect(publishIf).toBe(expected);
    expect(cleanupIf).toBe(expected);
  });

  it("公開可否ゲート(PUBLISH_DEV_LATEST)の定義行が期待する式と完全一致する", () => {
    // 検査対象は env ブロック全体(コメント込み)ではなく、PUBLISH_DEV_LATEST: の定義行そのもの
    // (実コード1行)に絞る。env ブロック全体を対象にすると、コメント文中に同じ語句
    // (例: 説明コメント中の「github.event_name == 'push'」)が含まれているだけで
    // toContain が満たされてしまい、実コードの演算子が反転していても検出できない
    // (過去のレビューで実際に検出漏れとして指摘された)。
    const gateValue = extractEnvValue(yml, "PUBLISH_DEV_LATEST");

    // 部分一致(toContain)の組み合わせでは、以下のような変異が個別に見逃されることが
    // 実際に確認された:
    //   - 外側の否定 `!(...)` の `!` を除去(印ありコミットだけ公開され、印なし=承認済みの
    //     コミットが黙って公開されなくなる完全な意味の逆転。このタスクが防ごうとしている
    //     実害そのもの)
    //   - `github.event_name == 'push'` → `!= 'push'`
    //   - `startsWith(github.ref, 'refs/heads/')` → `'refs/tags/'`
    //   - 外側 `&&` → `||`(ブランチ以外でも常に公開扱いになりうる)
    //   - 内側 `&&` → `||`(印の有無に関わらず全 push でスキップになりうる)
    //   - `contains(...)` → `startsWith(...)`(印の位置次第で検出漏れになる)
    // 個別の toContain/not.toContain を積み上げるのではなく、期待する式そのものを
    // 完全一致で固定することで、上記すべてと将来の未知の字句変異を一括で検出する。
    expect(gateValue).toBe(
      "${{ startsWith(github.ref, 'refs/heads/') && !(github.event_name == 'push' && contains(github.event.head_commit.message, 'レビュー継続中')) }}",
    );
  });

  it("v* タグの正式リリースステップの条件に「レビュー継続中」が現れない", () => {
    const tagStep = extractStep(yml, STEP_NAMES.tagRelease);
    const tagIf = extractIfLine(tagStep);

    // 前提固定: 対象ステップがタグ push 判定そのものであること(無関係なステップを誤って
    // 拾っていないことの確認)。
    expect(tagIf).toContain("refs/tags/v");

    expect(tagStep).not.toContain("レビュー継続中");
  });

  it("スキップ通知ステップの if: 条件が期待する式と完全一致する(タグ push で誤通知せず、== への反転や &&/|| の入れ替えも検出する)", () => {
    const noticeIf = extractIfLine(extractStep(yml, STEP_NAMES.skipNotice));

    // 部分一致(toContain)の組み合わせでは、`&&` → `||` への反転
    // (ブランチ push/手動実行であれば PUBLISH_DEV_LATEST の値に関わらず常に notice が出て
    // しまう。「refs/heads/ を含む」「!= 'true' を含む」は両方とも真のままなので検出できない
    // ことを実際に確認した)を見逃す。期待する式そのものを完全一致で固定することで、
    // ブランチ限定・公開ゲートの否定・&& の結合をまとめて検出する。
    expect(noticeIf).toBe(
      "startsWith(github.ref, 'refs/heads/') && env.PUBLISH_DEV_LATEST != 'true'",
    );
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
