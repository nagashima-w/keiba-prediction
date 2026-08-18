/**
 * CI ワークフロー(.github/workflows/build-windows.yml)の
 * 「dev-latest への公開には承認印([PUBLISH-APPROVED])付きの push が必要」ゲートに関する
 * 静的な不変条件テスト(Issue #43)。
 *
 * 注意: 本テストは yml のテキストを正規表現で検査するものであり、
 * GitHub Actions の式(if:/env: の ${{ }} 式)そのものを実際に評価・実行するものではない。
 * ゲートが CI 上で意図通り動くかどうかは実物検証(オーケストレーターが CI の run で確認する。AC7)に
 * 委ねる。本テストが保証するのは「壊れると実害が出る」静的な不変条件のみ。
 *
 * 背景(Issue #43): 旧仕様(「レビュー継続中」を含まなければ公開する = 既定で公開する)は、
 * 印の無い自動コミットが1つ割り込むだけで未レビューのコードが公開される事故を招いた
 * (コミット `10a4c54` が「レビュー継続中」を含まないまま単独 push され、その時点でブランチには
 * boss 承認前の実装が4コミット載っていた)。本タスクは既定値を安全側(既定で非公開)へ反転し、
 * 「承認印([PUBLISH-APPROVED])付きの push」または「workflow_dispatch」のときだけ公開する。
 *
 * 検証する不変条件:
 * 1. 公開ステップと孤児掃除ステップの if: が、公開を許可する極性(== 'true')で完全一致する
 *    (ずれると「公開せずに掃除だけ実行」となり dev-latest の exe が全滅する — 最重要。
 *    「一致」だけの検査だと、両方が同時に != 'true' へ反転しても素通りしてしまうため
 *    「一致」と「期待する極性そのもの」の両方を固定する)
 * 2. 公開可否ゲート(env: PUBLISH_DEV_LATEST)の定義行が期待する式と完全一致する
 *    (承認印リテラル・「レビュー継続中」参照・event_name 判定(push/workflow_dispatch)・
 *    refs/heads/ 限定・&&/|| の結合順・括弧構造のすべてを1つの完全一致で固定する。部分一致
 *    (toContain)の組み合わせだと、演算子の反転・&&/||の入れ替えなどを個別に見逃す穴が残ることが
 *    実際に確認されたため、字句そのものをピン留めする)
 * 2b. ゲート式が、承認印なしで公開されてしまう旧仕様(「レビュー継続中」の否定だけで公開を許可する
 *    骨格)の字句を含まない(不変条件2と目的は重複するが、極性の反転は本タスクが修正する事故の
 *    核心そのものであるため、字句レベルでも独立して固定する価値がある)
 * 3. v* タグの正式リリースステップの条件に「レビュー継続中」・承認印リテラルのいずれも現れない
 *    (タグでの正式公開は、この静的ゲートの判定と無関係であるべき)
 * 4. スキップ通知ステップの if: 条件が期待する式と完全一致する
 *    (ブランチ限定・公開ゲートの否定・&&の結合をすべて1つの完全一致で固定する。
 *    部分一致の組み合わせでは `&&` → `||` への反転(常に通知が出るようになる事故)を
 *    見逃すことが実際に確認されたため、字句そのものをピン留めする)
 * 5. スキップ通知ステップの文言が、承認印リテラル・掃除もスキップしたこと・回復手段
 *    (承認印付きコミットの push / workflow_dispatch)に触れている
 * 6. スキップ通知ステップに always() が付いていない
 *    (付けると前段の失敗を「公開スキップ」と誤って名乗ってしまう)
 * 7. 公開ステップが孤児掃除ステップより前に出現する(構造的な順序の不変条件)
 *    (掃除ステップのコメントが明記する atomicity の前提そのもの。入れ替わると、掃除が
 *    新 exe のアップロード前に走り、その時点で dev-latest に残る旧バージョンの exe を
 *    孤児と誤判定して削除する。直後に公開が失敗・中断すると dev-latest の資産がゼロになる)
 * 8. 公開可否ゲート(env: PUBLISH_DEV_LATEST)のキーがファイル中に厳密に1回だけ定義されている
 *    (ジョブ env と同名キーをステップ env で再定義する「シャドーイング」が起きていないことの
 *    構造的な保証。字句の完全一致(不変条件2)だけでは、ジョブ env 側の定義行自体は無傷のまま
 *    別の場所に同名キーが追加される変異を検出できない)
 * 9. 全ステップの名前と出現順序が期待する配列と完全一致する
 *    (不変条件7の publish/cleanup ペア限定の順序比較では、「if: を持たず常に実行される
 *    無関係なステップを2ステップの間に挿入する」ような、既存ステップの条件式を1文字も
 *    変えない構造変異を検出できないことが実際に確認された。全ステップの並びを配列として
 *    まるごと比較することで、挿入・削除・並べ替えを種類を問わず一括で検出する)
 * 10. 公開ステップに continue-on-error が付いていない
 *    (付くと公開(action-gh-release)の失敗をジョブが握りつぶし、同じゲートで守られている
 *    掃除ステップが「新 exe が未アップロードのまま」実行されうる。不変条件7が警告する
 *    非アトミック性と同根の実害で、条件式を1文字も変えずに起こせることが実際に確認された)
 * 11. 型検査ステップ(Issue #38)が存在し、ルートの `pnpm typecheck`
 *    (= `pnpm -r typecheck && tsc -p tsconfig.scripts.json`。core・app・scripts の3プログラムを
 *    覆う)を実行し、「app をビルド」ステップより前にある(fail fast: 型検査が壊れた状態で
 *    ビルド・パッケージングへ進まない)
 * 12. 承認印リテラル([PUBLISH-APPROVED])が CLAUDE.md・docs/current-spec.md・
 *    docs/development-workflow.md にワークフローと同一の文字列で現れる(Issue #43 の事故は
 *    「規約に書いた運用と CI の実装がずれても誰も気付かない」構造が土台にあるため、規約と CI の
 *    乖離を機械的に検出できるようにする。語句の言い換えでは検出できないが、トークンの存在のみを
 *    見る緩い検査でも「規約からリテラルが丸ごと消える/書き換わる」ような乖離は検出できる)
 * 13. 旧セマンティクス(「push ごとに dev-latest が更新される」)の文言が README.md・
 *    docs/current-spec.md に再混入していない(Issue #43 の作業中、この文言が2つのドキュメントに
 *    独立して2回残存する事故が実際に起きたため追加。対象は利用者/現状仕様の記述であり、
 *    開発者向けの CLAUDE.md・docs/development-workflow.md は対象外とする——両ファイルは
 *    「どう運用するか」の手続きを書く文脈であり、「今 dev-latest がどう更新されるか」を
 *    利用者/現状仕様として断定する文とは性質が違うため、この不変条件のスコープに含めない。
 *    検出できる範囲・できない範囲は STALE_PUSH_EVERY_PATTERN のコメントを参照)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(currentDir, "../../..");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/build-windows.yml",
);
const CLAUDE_MD_PATH = path.join(REPO_ROOT, "CLAUDE.md");
const CURRENT_SPEC_PATH = path.join(REPO_ROOT, "docs/current-spec.md");
const DEVELOPMENT_WORKFLOW_PATH = path.join(
  REPO_ROOT,
  "docs/development-workflow.md",
);
const README_PATH = path.join(REPO_ROOT, "README.md");

/** dev-latest 公開の承認印リテラル。CI・CLAUDE.md・docs の全箇所で同一文字列である必要がある。 */
const APPROVAL_MARK = "[PUBLISH-APPROVED]";

/**
 * 旧セマンティクス(「push すれば常に dev-latest が更新される」)の再混入を検出するための
 * 近接パターン。Issue #43 の作業中に、この文言が `docs/current-spec.md`・`README.md` の
 * 2箇所に独立して残存する事故が実際に2回起きたため、機械検査に落とす。
 *
 * 「push ごとに」という字句単体を全文検索すると、正当な文脈(例えば別の自動化を指して
 * 「push ごとに CI が走る」のような無関係な記述)まで誤検出し、次にこのテストに当たった人が
 * テストを緩める方向へ動きかねない。そこで今回実際に問題になった形——「push ごとに」と
 * 「dev-latest」が同じ文の中で近接して現れる——に絞る。しきい値 100 文字は、実際に事故が
 * 起きた2つの文例(例:「push ごとに固定タグ **`dev-latest`** のプレリリースを」)の間隔
 * (20〜30文字程度)に安全マージンを加えた値であり、章をまたぐような遠い偶然の共起までは
 * 拾わない。
 *
 * 【このテストが守るもの】「push ごとに」と「dev-latest」が同一文脈(100文字以内)で
 * 共起する、今回実際に発生した形そのものの再混入。
 * 【このテストが守らないもの】同じ意味の言い換え(例:「毎回公開されます」「push するたびに
 * 差し替わります」等)。パターンを広げて言い換えまで拾おうとすると、正当な文脈での誤検出が
 * 増え、テストが形骸化(緩和・削除)される方向に働くため、あえて対応しない。次にこの領域を
 * 触る人が「このテストがあるから言い換えも安全」と誤解しないよう、ここに明記する。
 */
const STALE_PUSH_EVERY_PATTERN = /push\s*ごとに[\s\S]{0,100}dev-latest/;

/**
 * yml 以外の任意テキストから、旧セマンティクスの再混入を検出する。
 * yml 側は既にワークフロー自体の書き換え(このタスク)で正しい記述に揃っているため対象外とし、
 * 「規約・ドキュメントに旧文言が戻っていないか」を確認する用途に絞る。
 */
function hasStalePushEverySemantics(text: string): boolean {
  return STALE_PUSH_EVERY_PATTERN.test(text);
}

const STEP_NAMES = {
  typecheck: "型検査を実行",
  build: "app をビルド",
  publish: "Releases に公開(dev-latest を in-place 更新 / ブランチ push 時)",
  cleanup: "dev-latest の孤児 exe アセットを掃除(現行ファイル名以外を削除)",
  skipNotice: "dev-latest 公開スキップをログに記録(承認印なしコミット時)",
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

/**
 * ステップブロックから `run:` の内容を抽出する。単一行(`run: <cmd>`)・複数行
 * (`run: |` ブロックスカラー)の両方に対応する(複数行は次のトップレベルキー
 * (ステップと同じインデント、または step 内の別キー)が現れるまでを本文とみなす)。
 */
function extractRunBlock(stepBlock: string): string {
  const singleLine = stepBlock.match(/^\s*run:\s+(?!\|)(.+)$/m);
  if (singleLine?.[1] !== undefined) {
    return singleLine[1].trim();
  }
  const blockMatch = stepBlock.match(/^(\s*)run:\s*\|\s*\n([\s\S]*?)(?=\n\1\S|\n {0,7}\S|$)/m);
  if (blockMatch?.[2] !== undefined) {
    return blockMatch[2];
  }
  throw new Error(`run: が見つかりません:\n${stepBlock}`);
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
 *
 * さらに、キーがファイル中に厳密に1回だけ出現することを要求する(グローバル検索して件数を
 * 数える)。ジョブ env で定義したキーと同名のキーをステップ env で再定義する
 * (シャドーイング)と、`.match()` の非グローバル検索では最初の一致(ジョブ env 側)しか
 * 見えず、後続の再定義に気づけない。GitHub Actions 上でシャドーイングが `if:` の評価に
 * 実際に効くかは別途実物検証が要るが、テストの前提として「唯一の定義を検証している」ことは
 * 安価に保証できるため、複数出現そのものを異常として検出する。
 */
function extractEnvValue(yml: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRegex = new RegExp(`^\\s*${escaped}:\\s*(.+)$`, "gm");
  const matches = [...yml.matchAll(lineRegex)];

  if (matches.length === 0) {
    throw new Error(`env 定義行が見つかりません: ${key}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `env 定義行が複数出現しています(${matches.length}箇所、シャドーイングの疑い): ${key}`,
    );
  }

  const captured = matches[0]?.[1];
  if (captured === undefined) {
    throw new Error(`env 定義行の値が取得できません: ${key}`);
  }
  return captured.trim();
}

/**
 * yml 本文中でのステップ開始位置(該当 `- name: <name>` 行の先頭インデックス)を返す。
 * ステップの出現順序(index の大小比較)を検証するために使う。extractStep と同じ
 * 「名前で一意に引き当てる」設計を踏襲し、見つからない場合は同じ流儀で例外を投げる
 * (見つからないときに順序比較そのものが無意味な値(-1 同士の比較等)にすり替わらないように
 * するため)。
 */
function stepStartIndex(yml: string, stepName: string): number {
  const marker = `      - name: ${stepName}`;
  const idx = yml.indexOf(marker);
  if (idx === -1) {
    throw new Error(`ステップが見つかりません: ${stepName}`);
  }
  return idx;
}

/**
 * yml 本文に出現する全ステップの名前を出現順に列挙する。
 * `publishIndex < cleanupIndex` のようなペア単位の順序比較では、既知の2ステップ間の
 * 前後関係しか見えず、「無関係な新規ステップを2ステップの間に挿入する」
 * (if: を持たず常に実行される・条件式を1文字も変えない)ような構造変異を検出できない。
 * 全ステップの並びを列挙して期待する配列とまるごと比較することで、挿入・削除・並べ替えを
 * 種類を問わず一括で検出する。
 */
function extractAllStepNames(yml: string): string[] {
  const matches = [...yml.matchAll(/^ {6}- name: (.+)$/gm)];
  return matches.map((m) => {
    const captured = m[1];
    if (captured === undefined) {
      throw new Error("ステップ名の抽出に失敗しました(正規表現の不整合)");
    }
    return captured.trim();
  });
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
    // (実際に変異させて素通りすることを確認済み。この場合承認印付きコミットでのみ
    // 公開・掃除が走らないという完全な意味の逆転になる)。期待する極性そのものを固定することで、
    // 「片方だけのズレ」と「両方同時のズレ」の両方を検出する。
    const expected = "env.PUBLISH_DEV_LATEST == 'true'";
    expect(publishIf).toBe(expected);
    expect(cleanupIf).toBe(expected);
  });

  it("公開可否ゲート(PUBLISH_DEV_LATEST)の定義行が期待する式と完全一致する(Issue #43: 既定で非公開に反転)", () => {
    // 検査対象は env ブロック全体(コメント込み)ではなく、PUBLISH_DEV_LATEST: の定義行そのもの
    // (実コード1行)に絞る。env ブロック全体を対象にすると、コメント文中に同じ語句が含まれている
    // だけで toContain が満たされてしまい、実コードの演算子が反転していても検出できない
    // (過去のレビューで実際に検出漏れとして指摘された)。
    const gateValue = extractEnvValue(yml, "PUBLISH_DEV_LATEST");

    // 部分一致(toContain)の組み合わせでは、以下のような変異が個別に見逃されることが
    // 実際に確認された:
    //   - 承認印の contains(...) を除去(印なしで公開される = Issue #43 の事故の再現)
    //   - `github.event_name == 'workflow_dispatch'` を欠落させる(手動実行での復旧レバーが失われる)
    //   - `startsWith(github.ref, 'refs/heads/')` → `'refs/tags/'`
    //   - 外側 `&&` → `||`(ブランチ以外でも常に公開扱いになりうる)
    //   - 内側 `&&` → `||`(承認印の有無に関わらず全 push で公開されうる)
    //   - `!contains(...レビュー継続中...)` の `!` を除去(承認印があっても
    //     「レビュー継続中」を含めば公開が止まらなくなる)
    // 個別の toContain/not.toContain を積み上げるのではなく、期待する式そのものを
    // 完全一致で固定することで、上記すべてと将来の未知の字句変異を一括で検出する。
    expect(gateValue).toBe(
      "${{ startsWith(github.ref, 'refs/heads/') && (github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && contains(github.event.head_commit.message, '[PUBLISH-APPROVED]') && !contains(github.event.head_commit.message, 'レビュー継続中'))) }}",
    );
  });

  it("公開可否ゲートの式が、承認印なしで公開されてしまう旧仕様の骨格を含まない(極性は本タスクの核心のため独立して固定する)", () => {
    const gateValue = extractEnvValue(yml, "PUBLISH_DEV_LATEST");

    // 完全一致テスト(上記)と目的は重複するが、Issue #43 が修正する事故は「印なしコミットで
    // 公開される」極性の反転そのものであるため、字句レベルでも独立して固定する価値がある。
    // 旧仕様は「レビュー継続中」の否定だけで公開を許可しており(骨格:
    // `startsWith(...) && !(github.event_name == 'push' && contains(...レビュー継続中...))`)、
    // 承認印(contains(..., '[PUBLISH-APPROVED]'))を要求しなかった。
    expect(gateValue).toContain(
      "contains(github.event.head_commit.message, '[PUBLISH-APPROVED]')",
    );
    expect(gateValue).not.toMatch(
      /^\$\{\{ startsWith\(github\.ref, 'refs\/heads\/'\) && !\(github\.event_name/,
    );
  });

  it("v* タグの正式リリースステップの条件に「レビュー継続中」・承認印リテラルのいずれも現れない", () => {
    const tagStep = extractStep(yml, STEP_NAMES.tagRelease);
    const tagIf = extractIfLine(tagStep);

    // 前提固定: 対象ステップがタグ push 判定そのものであること(無関係なステップを誤って
    // 拾っていないことの確認)。
    expect(tagIf).toContain("refs/tags/v");

    expect(tagStep).not.toContain("レビュー継続中");
    expect(tagStep).not.toContain(APPROVAL_MARK);
  });

  it("スキップ通知ステップの if: 条件が期待する式と完全一致する(タグ push で誤通知せず、== への反転や &&/|| の入れ替えも検出する)", () => {
    const noticeIf = extractIfLine(extractStep(yml, STEP_NAMES.skipNotice));

    // 部分一致(toContain)の組み合わせでは、`&&` → `||` への反転
    // (ブランチ push/手動実行であれば PUBLISH_DEV_LATEST の値に関わらず常に notice が出て
    // しまう。「refs/heads/ を含む」「!= 'true' を含む」は両方とも真のままなので検出できない
    // ことを実際に確認した)を見逃す。期待する式そのものを完全一致で固定することで、
    // ブランチ限定・公開ゲートの否定・&& の結合をまとめて検出する。
    //
    // この if: 自体は Issue #43 での極性反転(env 側)の影響を受けない(PUBLISH_DEV_LATEST の
    // 意味が変わっても「!= 'true' ならスキップを通知する」という関係は変わらないため)。
    expect(noticeIf).toBe(
      "startsWith(github.ref, 'refs/heads/') && env.PUBLISH_DEV_LATEST != 'true'",
    );
  });

  it("スキップ通知ステップの文言が、承認印・掃除もスキップしたことと回復手段(承認印付きコミット / workflow_dispatch)に触れている", () => {
    const noticeStep = extractStep(yml, STEP_NAMES.skipNotice);

    expect(noticeStep).toContain(APPROVAL_MARK);
    expect(noticeStep).toContain("掃除");
    expect(noticeStep).toContain("workflow_dispatch");
  });

  it("スキップ通知ステップに always() が付いていない(前段失敗を誤ってスキップ扱いしないため)", () => {
    const noticeStep = extractStep(yml, STEP_NAMES.skipNotice);
    expect(noticeStep).not.toContain("always()");
  });

  it("公開ステップが孤児掃除ステップより前に出現する(atomicity: 掃除は新exeのアップロード後でなければならない)", () => {
    const publishIndex = stepStartIndex(yml, STEP_NAMES.publish);
    const cleanupIndex = stepStartIndex(yml, STEP_NAMES.cleanup);

    // 順序そのものが安全性の前提。掃除ステップのコメントが明記する通り、掃除ステップは
    // 「直前の公開ステップの後に置く」ことで、最新 exe が必ず先にアップロード済みの状態を
    // 保ったまま(atomicity を壊さず)現行ファイル名以外の .exe だけを削除している。
    // 入れ替わると、掃除が新 exe のアップロード前に走り、その時点で dev-latest に残る
    // 旧バージョンの exe を孤児と誤判定して削除する。直後に公開が成功すれば最終的な資産は
    // 揃うが、掃除と公開の間で公開が失敗・中断すると dev-latest の資産がゼロになる
    // (コメントが警告している非アトミック性そのもの)。両ステップの `if:` や文言を
    // 一切変更せず出現順序だけを入れ替える変異は、これまでの字句レベルの不変条件
    // (1〜6・8)では検出できないため、構造(出現位置)を直接比較する。
    expect(publishIndex).toBeLessThan(cleanupIndex);
  });

  it("公開可否ゲート(PUBLISH_DEV_LATEST)のキーがファイル中に厳密に1回だけ定義されている(シャドーイングの検出)", () => {
    // extractEnvValue はキーが複数出現すると例外を投げる設計にしている(ジョブ env と
    // 同名キーをステップ env で再定義する「シャドーイング」を検出するため)。ここでは
    // 「例外を投げずに呼び出せること」自体を、唯一性が保たれていることの直接証拠として
    // 確認する(不変条件2の値の完全一致だけでは、ジョブ env 側の定義行自体は無傷のまま
    // 別の場所に同名キーが追加される変異を検出できない)。
    expect(() => extractEnvValue(yml, "PUBLISH_DEV_LATEST")).not.toThrow();
  });

  it("全ステップの名前と出現順序が期待する配列と完全一致する(挿入・削除・並べ替えを一括で検出する)", () => {
    // 【このテストが落ちたときの正しい対応】
    // ゲートと無関係なステップ(依存インストール等)を改名しただけでもここは落ちる。
    // そのときは**下の期待配列を更新するのが正しい対応**であり、この不変条件を緩めたり
    // 削除したりしてはならない。配列の完全一致は、公開ステップと孤児掃除ステップの間に
    // 未知のステップが割り込むこと・順序が入れ替わることを一括で防いでいる(掃除は公開の
    // 後でなければ、新しい実行ファイルのアップロード前に旧版を削除してしまう)。
    // 精密な部分検査に置き換えようとすると、本ファイルが辿った「部分一致の積み上げでは
    // 意味の逆転を検出できない」という失敗に逆戻りする。
    //
    // 前提固定: このジョブが12ステップから成ることをまず固定する(配列比較が
    // 空配列同士の一致のような自明なもので満たされないようにするため)。
    const actualNames = extractAllStepNames(yml);
    expect(actualNames.length).toBeGreaterThan(0);

    expect(actualNames).toEqual([
      "リポジトリを取得",
      "pnpm をセットアップ",
      "Node.js をセットアップ",
      "依存をインストール",
      STEP_NAMES.typecheck,
      "テストを実行",
      STEP_NAMES.build,
      "electron-builder で exe を生成",
      STEP_NAMES.publish,
      STEP_NAMES.cleanup,
      STEP_NAMES.skipNotice,
      STEP_NAMES.tagRelease,
    ]);
  });

  it("公開ステップに continue-on-error が付いていない(atomicity: 公開失敗を握りつぶすと、新exe未アップロードのまま掃除だけ実行されうる)", () => {
    const publishStep = extractStep(yml, STEP_NAMES.publish);

    // continue-on-error: true が付くと、公開(action-gh-release)が失敗してもジョブは
    // 成功継続する。同じ PUBLISH_DEV_LATEST == 'true' で守られている掃除ステップは
    // 「前段(公開)成功」を前提に実行されるため、公開失敗を握りつぶすと「新 exe が
    // アップロードされていないのに掃除だけ走る」という、不変条件7が警告する非アトミック性
    // (dev-latest の資産がゼロになる)と同じ実害を招く。条件式・出現順序を1文字も変えずに
    // 起こせる変異のため、別途この属性の不在を検証する。
    expect(publishStep).not.toContain("continue-on-error");
  });

  it("型検査ステップが存在し、ルートの pnpm typecheck を実行し、app をビルドするステップより前にある(Issue #38)", () => {
    const typecheckStep = extractStep(yml, STEP_NAMES.typecheck);
    const runLine = extractRunBlock(typecheckStep);

    // pnpm -r typecheck だけでは scripts/ の型検査(tsconfig.scripts.json)が走らない
    // (Issue #38 の事故の直接原因)。ルートの `pnpm typecheck`
    // (= `pnpm -r typecheck && tsc -p tsconfig.scripts.json`)を呼ぶことを固定する。
    expect(runLine).toBe("pnpm typecheck");

    const typecheckIndex = stepStartIndex(yml, STEP_NAMES.typecheck);
    const buildIndex = stepStartIndex(yml, STEP_NAMES.build);
    expect(typecheckIndex).toBeLessThan(buildIndex);
  });

  it("承認印リテラル([PUBLISH-APPROVED])が CLAUDE.md・docs/current-spec.md・docs/development-workflow.md にワークフローと同一の文字列で現れる(規約とCIの乖離検出。Issue #43)", () => {
    // Issue #43 の事故は「規約に書いた運用と CI の実装がずれても誰も気付かない」構造が
    // 土台にある。承認印リテラルが規約側とワークフロー側で同一文字列になっていることを
    // 機械的に固定することで、将来どちらか一方だけが書き換わる乖離を検出できるようにする。
    // 語句の言い換え(例: 説明文だけが変わる)までは検出できないが、「規約からリテラルが
    // 丸ごと消える/別の文字列に変わる」ような乖離は検出できる。
    expect(yml).toContain(APPROVAL_MARK);

    const claudeMd = readFileSync(CLAUDE_MD_PATH, "utf8");
    const currentSpec = readFileSync(CURRENT_SPEC_PATH, "utf8");
    const developmentWorkflow = readFileSync(
      DEVELOPMENT_WORKFLOW_PATH,
      "utf8",
    );

    expect(claudeMd).toContain(APPROVAL_MARK);
    expect(currentSpec).toContain(APPROVAL_MARK);
    expect(developmentWorkflow).toContain(APPROVAL_MARK);
  });

  it("旧セマンティクス(「push ごとに dev-latest が更新される」)の文言が README.md・docs/current-spec.md に再混入していない(Issue #43)", () => {
    // Issue #43 の作業中、「push すれば常に dev-latest が更新される」という旧セマンティクスの
    // 文言が docs/current-spec.md・README.md の2箇所に独立して残存する事故が実際に2回起きた
    // (dev-latest 公開ゲートを追加した diff の中で、隣接する既存文言の更新が漏れた)。
    // 人の目視レビューで2回見落としたものは3回目も見落とされうるため、機械検査に落とす。
    //
    // 前提固定: 現時点でこの2ファイルに旧文言が存在しないこと(このテストが「常に真」の
    // 空振りになっていないこと)をまず確認する。
    const readme = readFileSync(README_PATH, "utf8");
    const currentSpecForStaleCheck = readFileSync(CURRENT_SPEC_PATH, "utf8");

    expect(hasStalePushEverySemantics(readme)).toBe(false);
    expect(hasStalePushEverySemantics(currentSpecForStaleCheck)).toBe(false);
  });
});
