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
 *    docs/current-spec.md・docs/handover-next-session.md に再混入していない(Issue #43 の作業中、
 *    この文言が2つのドキュメントに独立して2回残存する事故が実際に起きたため追加。対象は
 *    利用者/現状仕様の記述(および同種の現在形の断定を含む引き継ぎメモ)であり、開発者向けの
 *    CLAUDE.md・docs/development-workflow.md・yml は対象外とする——CLAUDE.md/development-workflow.md
 *    は「どう運用するか」の手続きを書く文脈であり、「今 dev-latest がどう更新されるか」を
 *    利用者/現状仕様として断定する文とは性質が違うため、この不変条件のスコープに含めない。yml を
 *    対象外とする理由(時点依存ではない恒久的な理由)は hasStalePushEverySemantics のコメントを
 *    参照。この不変条件には正の対照(過去に実際に問題だった本文を検出器が true と判定すること)を
 *    別途用意し、検出器側の変異(パターンの無害化)で空振りになっていないことを保証する
 *    (検出できる範囲・できない範囲は STALE_PUSH_EVERY_PATTERN のコメントを参照)
 * 14. 承認印([PUBLISH-APPROVED])の付与指示が、CLAUDE.md 手順6・docs/development-workflow.md
 *    手順7において**命令形**(「必ず」+「付与」の近接共起)のまま維持されている(Issue #43 の
 *    メタレビューで「承認印への言及4箇所すべてが説明的で命令が無かった」という重大指摘が
 *    あったため、退行防止の機械検査を追加。抽出範囲は開始/終了の目印で厳密に区切り、範囲が
 *    後続セクションまで伸びていないことを無条件 expect で先に固定する——範囲が伸びると、
 *    対象の手順から命令形が消えても下流の別リテラルと「必ず」で条件が満たされてしまい、
 *    素通りする穴になるため)
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
const HANDOVER_NEXT_SESSION_PATH = path.join(
  REPO_ROOT,
  "docs/handover-next-session.md",
);

/**
 * テキストファイルを読み、改行コードを LF に正規化して返す。
 * CI(windows-latest)の checkout は `.gitattributes` 次第で CRLF になりうる。本ファイルで
 * 文書テキストに正規表現(近接パターン・行アンカー等)を当てるすべての箇所は、この関数を通した
 * 正規化済みテキストに対して行う(1箇所だけ生読みにすると、そこだけ CRLF で挙動が変わり
 * 「ローカルでは緑・CI(CRLF)でだけ落ちる/素通りする」という、このゲート導入タスク自体で
 * 実際に起きた見落としが再発するため)。
 */
function readNormalized(filePath: string): string {
  return readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

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
 * 「dev-latest」が同じ文の中で近接して現れる——に絞る。しきい値 100 文字の根拠は、実際に
 * 事故当時(コミット `67f5b65`)の文例で測った間隔——README.md が10文字(「プレリリース **`」)、
 * docs/current-spec.md が8文字(「固定タグ **`」)——に対し、10倍以上の余裕を持たせた値であり、
 * 章をまたぐような遠い偶然の共起までは拾わない。
 * (`git show 67f5b65:README.md` / `git show 67f5b65:docs/current-spec.md` で再計測できる)
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
 * 利用者/現状仕様向けの散文(README.md・docs/current-spec.md・docs/handover-next-session.md 等)
 * から、旧セマンティクスの再混入を検出する。
 *
 * yml(.github/workflows/build-windows.yml)は対象外とする。この除外の理由は「今回の書き換えで
 * 直したから」という**時点依存のもの**ではなく、恒久的に成立する理由に基づく:
 *   1. yml の実コード(公開可否ゲート)の主たる防御は不変条件2(PUBLISH_DEV_LATEST の定義行を
 *      期待する式と完全一致でピン留めする検査)であり、演算子・条件式の変異はそちらが検出する。
 *      本パターンが見ているのはコメント欄の散文であり、実コードの防御とは独立で価値が薄い。
 *   2. yml のヘッダ・各ステップのコメントには、公開ゲートと矛盾しない**正当な現行の記述**
 *      (「差し替える」「in-place 更新」「置き換える」等)が複数箇所に存在する。これらは
 *      STALE_PUSH_EVERY_PATTERN(「push ごとに」+「dev-latest」の近接)そのものとは字面が
 *      異なるため直接の誤検出は起きないが、yml の実際の旧文言(「毎回作り直して差し替える」)を
 *      捕まえようとして「差し替え」系の語まで拾うパターンを新たに足すと、これらの正当な記述と
 *      衝突して誤検出を招く。誤検出は「次にこのテストに当たった人がパターンを緩める」方向に働き、
 *      本パターンの docstring 自身が警告する形骸化を新たに1件作ることになる。
 * そのため yml のヘッダ散文は本関数の対象に含めず、機械検査は実コードのピン留め(不変条件2)に
 * 一本化する。
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
  // Issue #45(D-2): 版数運用規約(#44-D-1)の機械検査。
  tagVerify: "タグとバージョンの一致を検証",
  versionBumpCheck: "版数据え置きを検査(dev-latest 公開前)",
  // Issue #62: 配布 exe が「動くこと」を CI で検査するゲート(asar配置検査・ヘッドレススモーク)。
  asarLayoutCheck: "配布 exe の asar 配置を検査(A1/A2)",
  smokeCheck: "配布 exe のヘッドレススモークテスト",
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

/**
 * 文書のテキストから、開始目印(startMarker)〜終了目印(endMarker)の直前までの範囲を切り出す。
 * extractStep と同じ流儀: どちらかの目印が見つからない場合は、範囲比較そのものが無意味な値
 * (undefined や空文字が後続の検査に流れる)にすり替わらないよう、必ず例外を投げる。
 */
function extractStepBlock(
  text: string,
  startMarker: string,
  endMarker: string,
): string {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`開始位置が見つかりません: ${startMarker}`);
  }
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) {
    throw new Error(`終了位置が見つかりません: ${endMarker}`);
  }
  return text.slice(startIdx, endIdx);
}

/**
 * 承認印([PUBLISH-APPROVED])の運用を明記する箇所に、「必ず」+「付与」という命令形が
 * 近接して同居しているかを見る、緩い機械検査のパターン。
 *
 * 粒度の選定理由: 「を必ず付与する」のような文言を一言一句で固定すると、将来の言い換え
 * (例:「例外なく付与する」「省略せず付与すること」)だけで無意味に壊れ、次にここへ来た人が
 * パターンを緩める方向に動きかねない(STALE_PUSH_EVERY_PATTERN と同じ懸念)。逆に「付与」
 * という語単体だけを見ると、「付与すると公開される」のような**説明的な文**にも一致してしまい、
 * Issue #43 で実際に重大指摘だった「命令ではなく説明になっている」という退行を区別できない。
 * そこで「必ず」という強制を表す語と「付与」という動作語の**近接共起(0〜10文字以内)**を
 * 要求する: 「必ず」だけでは動作対象が特定できず無関係な強調表現にも一致し、「付与」だけでは
 * 説明文にも一致するため、両方の近接共起を要求することで「これは命令である」という最小限の
 * 判別力を持たせている。しきい値10文字は、実際の文言(「`[PUBLISH-APPROVED]` を必ず付与する」)
 * での間隔(「必ず付与」で0文字)に対して十分な余裕を持たせつつ、無関係な「必ず」と「付与」が
 * 遠く離れて偶然共起するような誤検出は避ける値として選んだ。
 */
const IMPERATIVE_ATTACH_PATTERN = /必ず[\s\S]{0,10}付与/;

/**
 * yml 本文で `<key>:` が実コード行(行頭のインデントの直後)として出現する回数を数える。
 * Issue #45(D-2)で追加した `continue-on-error` の全体出現回数の検査に使う。
 *
 * extractEnvValue と同じ理由で行頭アンカー(`^\s*<key>:`)にする: 素朴な部分一致だと、
 * このファイル自身の説明コメント(例:「# continue-on-error は付けない」)がヒットして
 * 実コードの出現回数と食い違う(実際に本タスクで踏んだ: コメントで1件多く数えてしまい
 * 「1回のはず」のテストが誤って落ちた)。コメント行は `#` から始まるため
 * `^\s*continue-on-error:` には一致しない。
 *
 * この関数自体が壊れていないことは、下の「正の対照」テスト(合成テキストへ2件注入して
 * 2 を返すことを確認する)で別途担保する(m7: 検査する側を無害化しても検査される側が
 * 正しければ緑のままになる、という空振りを防ぐ)。
 */
function countKeyLineOccurrences(yml: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRegex = new RegExp(`^\\s*${escaped}:`, "gm");
  return (yml.match(lineRegex) ?? []).length;
}

describe("build-windows.yml の dev-latest 公開ゲート(静的な不変条件)", () => {
  // 改行コードを LF に正規化してから読む(readNormalized)。Windows ランナー上の
  // checkout(actions/checkout)はリポジトリの .gitattributes 設定次第で CRLF になりうる。
  // 本テストの全パターンは `\n` を前提にしている。
  const yml = readNormalized(WORKFLOW_PATH);

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
    // 前提固定: このジョブが16ステップから成ることをまず固定する(配列比較が
    // 空配列同士の一致のような自明なもので満たされないようにするため。Issue #45 で
    // タグ検証・版数据え置き検査の2ステップが増えて12→14になり、Issue #62 で
    // asar配置検査・ヘッドレススモークの2ステップが増えて14→16になった)。
    const actualNames = extractAllStepNames(yml);
    expect(actualNames.length).toBe(16);

    expect(actualNames).toEqual([
      "リポジトリを取得",
      "pnpm をセットアップ",
      "Node.js をセットアップ",
      "依存をインストール",
      STEP_NAMES.tagVerify,
      STEP_NAMES.typecheck,
      "テストを実行",
      STEP_NAMES.build,
      "electron-builder で exe を生成",
      STEP_NAMES.asarLayoutCheck,
      STEP_NAMES.smokeCheck,
      STEP_NAMES.versionBumpCheck,
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

    const claudeMd = readNormalized(CLAUDE_MD_PATH);
    const currentSpec = readNormalized(CURRENT_SPEC_PATH);
    const developmentWorkflow = readNormalized(DEVELOPMENT_WORKFLOW_PATH);

    expect(claudeMd).toContain(APPROVAL_MARK);
    expect(currentSpec).toContain(APPROVAL_MARK);
    expect(developmentWorkflow).toContain(APPROVAL_MARK);
  });

  it("旧セマンティクス(「push ごとに dev-latest が更新される」)の文言が README.md・docs/current-spec.md・docs/handover-next-session.md に再混入していない(Issue #43)", () => {
    // Issue #43 の作業中、「push すれば常に dev-latest が更新される」という旧セマンティクスの
    // 文言が docs/current-spec.md・README.md の2箇所に独立して残存する事故が実際に2回起きた
    // (dev-latest 公開ゲートを追加した diff の中で、隣接する既存文言の更新が漏れた)。
    // 人の目視レビューで2回見落としたものは3回目も見落とされうるため、機械検査に落とす。
    // docs/handover-next-session.md も、同種の「push すれば自動的に exe が更新される」という
    // 現在形の断定を含みうる文書として対象に加える(要修正2で実際に見つかった)。
    //
    // 前提固定: 現時点でこの3ファイルに旧文言が存在しないこと(このテストが「常に真」の
    // 空振りになっていないこと)をまず確認する。
    const readme = readNormalized(README_PATH);
    const currentSpecForStaleCheck = readNormalized(CURRENT_SPEC_PATH);
    const handoverForStaleCheck = readNormalized(HANDOVER_NEXT_SESSION_PATH);

    expect(hasStalePushEverySemantics(readme)).toBe(false);
    expect(hasStalePushEverySemantics(currentSpecForStaleCheck)).toBe(false);
    expect(hasStalePushEverySemantics(handoverForStaleCheck)).toBe(false);
  });

  it("検出器(hasStalePushEverySemantics)自身が、過去に実際に問題だった本文を true と判定する(正の対照。空振り防止)", () => {
    // 上のテストは「今この3ファイルに旧文言が無いこと」(false)しか確認しておらず、
    // STALE_PUSH_EVERY_PATTERN 自体を無害化する変異(対象文字列を1文字も変えず検出器だけを
    // 壊す)で永久に緑になる空振りの穴があった(boss のメタレビューで指摘・実測済み)。
    // ここでは、検出器が「本当に旧文言を捕まえられること」を、過去に実在した悪い本文
    // (事故当時のコミット `67f5b65` の README.md / docs/current-spec.md に実在した該当文)を
    // 正の対照として固定する。
    //
    // 【以下の2つの文字列はテストデータである】現在のリポジトリの記述ではなく、Issue #43 の
    // 作業中に実際に混入していた旧セマンティクスの再現データとして、このテスト専用にリテラルで
    // 埋め込む。将来この文字列を見た人が「リポジトリに旧文言が残っている」と誤読しないよう、
    // ここに明記する。
    //
    // git show 67f5b65:<path> のような git 参照による取得ではなく、リテラル埋め込みを選ぶ理由:
    // .github/workflows/build-windows.yml の checkout ステップ(actions/checkout@v4)は
    // fetch-depth を指定しておらず既定値 1(浅いクローン)になる。浅いクローンでは過去コミット
    // `67f5b65` を参照できないため、git 参照に頼るとローカルでは通っても CI 上でだけ失敗する
    // (最悪、参照エラーを握りつぶすとテストが常に空振りする)不安定なテストになってしまう。
    const staleReadmeSnippet =
      "- **開発版**: 開発ブランチへの push ごとにプレリリース **`dev-latest`** を差し替え公開します。";
    const staleCurrentSpecSnippet =
      "`claude/keiba-prediction-handover-ojr8t1`)への push ごとに固定タグ **`dev-latest`** のプレリリースを";

    expect(hasStalePushEverySemantics(staleReadmeSnippet)).toBe(true);
    expect(hasStalePushEverySemantics(staleCurrentSpecSnippet)).toBe(true);
  });

  it("承認印の付与指示が CLAUDE.md 手順6・docs/development-workflow.md 手順7で命令形のまま維持されている(退行防止。Issue #43 メタレビューの提案対応)", () => {
    // Issue #43 の当初レビューで「重大」指摘だったのは、承認印(APPROVAL_MARK)への言及
    // 4箇所すべてが説明的で、「付けよ」という命令形が無かったこと。不変条件12はリテラルの
    // 存在しか見ないため、この退行が将来再発しても緑のままになる非対称があった。
    // ここでは、承認印の運用が明記される「コミットする」手順そのもの(CLAUDE.md 手順6・
    // docs/development-workflow.md 手順7)に絞って、承認印と命令形が同居することを固定する。
    const claudeMd = readNormalized(CLAUDE_MD_PATH);
    const developmentWorkflow = readNormalized(DEVELOPMENT_WORKFLOW_PATH);

    const claudeStep6 = extractStepBlock(
      claudeMd,
      "6. bossの承認が出たら",
      "\n7. ",
    );
    // 前提固定: 抽出範囲が手順6だけに収まっており、手順7(次のリスト項目)まで伸びていないこと・
    // 極端に長くなっていないことを無条件に確認する。範囲が伸びると、手順6の本文から命令形が
    // 消えても下流の別のリテラル・別の「必ず」で条件が満たされてしまい、退行が素通りする穴になる
    // (実測した現在の長さは292文字。400文字は文面の軽微な増減を許容しつつ、次のセクション
    // 全体を飲み込むような大きな抽出崩れは確実に検出できる余裕を見た値)。
    expect(claudeStep6).not.toContain("各Phase完了時に");
    expect(claudeStep6.length).toBeLessThan(400);
    expect(claudeStep6).toContain(APPROVAL_MARK);
    expect(IMPERATIVE_ATTACH_PATTERN.test(claudeStep6)).toBe(true);

    const workflowStep7 = extractStepBlock(
      developmentWorkflow,
      "7. **コミット**",
      "\n\n>",
    );
    // 実測した現在の長さは241文字。350文字は同様の余裕を見た値。
    expect(workflowStep7).not.toContain("実装完了 ≠");
    expect(workflowStep7.length).toBeLessThan(350);
    expect(workflowStep7).toContain(APPROVAL_MARK);
    expect(IMPERATIVE_ATTACH_PATTERN.test(workflowStep7)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Issue #45(D-2): 版数運用規約(#44-D-1)の機械検査(タグ検証・版数据え置き検査)
  // -------------------------------------------------------------------------

  it("タグ検証ステップの if: が正式リリースステップの if: と一致し、かつ startsWith(github.ref, 'refs/tags/v') そのものである", () => {
    // 不変条件1と同じ「一致」と「期待値そのもの」の両方を固定する流儀。タグ検証だけが
    // 別の条件式にずれると、正式リリースされないタグ push でタグ検証が block しない
    // (または逆に正式リリースされるのにタグ検証が走らない)事故になる。
    const tagVerifyIf = extractIfLine(extractStep(yml, STEP_NAMES.tagVerify));
    const tagReleaseIf = extractIfLine(extractStep(yml, STEP_NAMES.tagRelease));

    expect(tagVerifyIf).toBe(tagReleaseIf);
    expect(tagVerifyIf).toBe("startsWith(github.ref, 'refs/tags/v')");
  });

  it("版数据え置き検査ステップの if: が env.PUBLISH_DEV_LATEST == 'true' && github.event_name == 'push' で完全一致する", () => {
    // boss 着手前ゲート(C): env: マップ内から別の env は参照できないため、
    // PUBLISH_DEV_LATEST の判定式を検査ステップ用に複製することはできない(条件式を
    // 2箇所以上に複製しない規律への抵触)。この唯一解の字句そのものを固定する。
    // event_name == 'push' を明示するのは workflow_dispatch(同一コミット再送)を
    // 据え置き検査の対象から除外するため(docs/versioning.md の申し送り事項)。
    const checkIf = extractIfLine(extractStep(yml, STEP_NAMES.versionBumpCheck));

    expect(checkIf).toBe("env.PUBLISH_DEV_LATEST == 'true' && github.event_name == 'push'");
  });

  it("版数据え置き検査ステップが exe 生成の直後・公開ステップの直前に出現する", () => {
    const exeGenIndex = stepStartIndex(yml, "electron-builder で exe を生成");
    const checkIndex = stepStartIndex(yml, STEP_NAMES.versionBumpCheck);
    const publishIndex = stepStartIndex(yml, STEP_NAMES.publish);

    expect(exeGenIndex).toBeLessThan(checkIndex);
    expect(checkIndex).toBeLessThan(publishIndex);
  });

  it("タグ検証ステップが「app をビルド」・正式リリースステップより前に出現する", () => {
    const tagVerifyIndex = stepStartIndex(yml, STEP_NAMES.tagVerify);
    const buildIndex = stepStartIndex(yml, STEP_NAMES.build);
    const tagReleaseIndex = stepStartIndex(yml, STEP_NAMES.tagRelease);

    expect(tagVerifyIndex).toBeLessThan(buildIndex);
    expect(tagVerifyIndex).toBeLessThan(tagReleaseIndex);
  });

  it("両新ステップの run: 行が完全一致で固定されている(ステップ名だけ残して中身を骨抜きにする変異の検出)", () => {
    const tagVerifyRun = extractRunBlock(extractStep(yml, STEP_NAMES.tagVerify));
    const checkRun = extractRunBlock(extractStep(yml, STEP_NAMES.versionBumpCheck));

    // boss メタレビュー(提案 → オーケストレーターが採用): github.ref_name を run: に
    // 直接展開せず、env: 経由でシェル変数として渡す(タグ名はシェルメタ文字を含みうるため。
    // 孤児掃除ステップの CURRENT_EXE と同じ「値を env 変数化してから $VAR で参照する」流儀)。
    expect(tagVerifyRun).toBe(
      'pnpm exec tsx scripts/release-gate.ts tag-version "$TAG_NAME"',
    );
    expect(checkRun).toBe("pnpm exec tsx scripts/release-gate.ts version-bump-check");
  });

  it("タグ検証ステップの env: TAG_NAME が github.ref_name をそのまま渡している(シェル注入対策の配線)", () => {
    // extractEnvValue はキーがファイル中に厳密に1回だけ定義されていることも検証する
    // (PUBLISH_DEV_LATEST と同じ流儀)。TAG_NAME はこのステップの外では使わない前提。
    expect(extractEnvValue(yml, "TAG_NAME")).toBe("${{ github.ref_name }}");
  });

  it("continue-on-error が yml 全体で厳密に1回(掃除ステップのみ)出現する", () => {
    // boss 追加条件: 新設した2ステップのどちらにも continue-on-error を付けない
    // (block/skip の判定結果は必ずジョブの成否に反映されなければならない。
    // 付けると exit 1 がジョブ失敗に伝播せず、実装仕様2「continue-on-error を付けない」が
    // 静かに破られる)。掃除ステップの1件だけが正当な例外として残る。
    expect(countKeyLineOccurrences(yml, "continue-on-error")).toBe(1);
  });

  it("countKeyLineOccurrences 自身が複数出現を正しく数える(正の対照。検査する側の空振り防止。m7 対応)", () => {
    // 上のテストは「1回であること」しか確認しておらず、countKeyLineOccurrences を
    // 「常に1を返す」ような無害化(検査する側の変異)をしても、掃除ステップの1件と
    // 偶然辻褄が合って緑のままになる空振りの穴がある。ここでは合成テキストへ意図的に
    // 2件注入し、検出器が本当に2を返すことを固定する(hasStalePushEverySemantics に対する
    // 正の対照と同じ流儀)。コメント行への誤爆(上のdocstring参照)が無いことも併せて
    // 固定するため、合成テキストに紛らわしいコメント行を1件混ぜる。
    const synthetic =
      "steps:\n  # continue-on-error は付けない\n  - run: a\n    continue-on-error: true\n  - run: b\n    continue-on-error: true\n";
    expect(countKeyLineOccurrences(synthetic, "continue-on-error")).toBe(2);
  });

  it("版数据え置き検査ステップのコメントが、暗黙の success() 依存と block 経路が実物未検証であることに触れている(AC9)", () => {
    // GitHub Actions の「if: にステータス関数を含まなければ暗黙に success() が付く」という
    // 仕様(前段が失敗すればこのステップ以降がスキップされる根拠)はテストで検証できない
    // (yml の式を実際に評価するのは GitHub Actions 側であり、本テストファイルは静的な
    // テキスト検査に留まる)。boss 追加条件(AC9)により、この仕様依存と、block 経路
    // (版数据え置きで実際に exit 1 になる CI run)がテスト・ミューテーション以外では
    // 実物検証されていないことをコメントに明記する。
    const checkStep = extractStep(yml, STEP_NAMES.versionBumpCheck);

    expect(checkStep).toContain("success()");
    expect(checkStep).toContain("未検証");
  });
});
