/**
 * 承認印([PUBLISH-APPROVED])の運用文書と CI の乖離を検出する静的テスト(Issue #43 起源、Issue #248 で付け替え)。
 *
 * 経緯: 旧 packages/app/test/release-workflow-gate.test.ts(25 件)は、build-windows.yml の dev-latest 公開ゲートを
 * 固定しつつ、承認印の文書側の不変条件も見ていた。Issue #248 で exe の公開を止めて build-windows.yml を消したため、
 * ゲートの固定(20 件)はステップごと消え、文書側の不変条件(5 件のうち 4 件)を本ファイルに移した。
 * 承認印は cloud の本番デプロイの関門(deploy-cloud.yml の deploy ジョブ)として残る。式そのものは
 * scripts/test/cloud-deploy-workflow.test.ts が完全一致と真理値表で固定している。
 *
 * 新旧の対応(旧 → 新):
 * - 型検査ステップが app のビルドより前にある(旧) → scripts/test/ci-workflow.test.ts(順序とコマンドを拡張)
 * - 承認印リテラルが CLAUDE.md・current-spec・development-workflow とワークフローで同一(旧) → 本ファイルの不変条件 1
 *   (ワークフローを build-windows.yml から deploy-cloud.yml に付け替えた)
 * - 旧セマンティクス「push ごとに dev-latest」の再混入検出とその正の対照(旧 2 件) → 本ファイルの不変条件 2・3(無変更)
 * - 承認印の付与指示が命令形のまま維持されている(旧) → 本ファイルの不変条件 4(無変更)
 * - 公開ゲート・公開ステップ・孤児掃除・タグ検証・版数据え置き検査の固定(旧 20 件) → ステップごと廃止(ci.yml にそれらは無い)。
 *   代わりに ci-workflow.test.ts が「公開が戻っていない」ことを固定する
 *
 * 検証する不変条件:
 * 1. 承認印リテラルが deploy-cloud.yml・CLAUDE.md・docs/current-spec.md・docs/development-workflow.md に同一の文字列で現れる
 * 2. 旧セマンティクスの文言が README.md・docs/current-spec.md・docs/handover-next-session.md に再混入していない
 * 3. 2 の検出器自身が過去に実際に問題だった本文を true と判定する(正の対照)
 * 4. 承認印の付与指示が CLAUDE.md 手順6・docs/development-workflow.md 手順7で命令形のまま維持されている
 * 5. (Issue #248 で追加)廃止した build-windows.yml と「exe 再ビルドを確認する」運用が、運用の指示文書に現在形で残っていない
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** テキストファイルを読み、改行コードを LF に正規化して返す。 */
function readNormalized(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), "utf8").replace(/\r\n/g, "\n");
}

/** 承認印の文字列。CI(deploy-cloud.yml)・CLAUDE.md・docs の全箇所で同一である必要がある。 */
const APPROVAL_MARK = "[PUBLISH-APPROVED]";

/**
 * 旧セマンティクス(「push すれば常に dev-latest が更新される」)の再混入を検出するための近接パターン。
 * 「push ごとに」と「dev-latest」が同じ文の中で近接して現れる形に絞る(Issue #43 の作業中に、この文言が
 * docs/current-spec.md・README.md の 2 箇所に独立して残存する事故が実際に 2 回起きた)。しきい値 100 文字は、
 * 事故当時(コミット 67f5b65)の文例の間隔(README.md が 10 文字、docs/current-spec.md が 8 文字)に
 * 10 倍以上の余裕を持たせた値。
 * 【守るもの】「push ごとに」と「dev-latest」が 100 文字以内で共起する、実際に発生した形そのものの再混入。
 * 【守らないもの】同じ意味の言い換え(パターンを広げると正当な文脈での誤検出が増え、緩和・削除される方向に働くため)。
 */
const STALE_PUSH_EVERY_PATTERN = /push\s*ごとに[\s\S]{0,100}dev-latest/;

function hasStalePushEverySemantics(text: string): boolean {
  return STALE_PUSH_EVERY_PATTERN.test(text);
}

/**
 * 文書のテキストから、開始目印〜終了目印の直前までの範囲を切り出す。目印が見つからなければ例外
 * (範囲比較そのものが無意味な値にすり替わらないようにするため)。
 */
function extractStepBlock(text: string, startMarker: string, endMarker: string): string {
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
 * 承認印の運用を明記する箇所に、「必ず」+「付与」という命令形が近接(0〜10 文字)して同居しているかを見る、
 * 緩い機械検査のパターン。「付与」単体だと「付与すると公開される」のような説明文にも一致し、Issue #43 で
 * 重大指摘だった「命令ではなく説明になっている」退行を区別できない。「必ず」との近接共起を要求することで、
 * 「これは命令である」という最小限の判別力を持たせている。
 */
const IMPERATIVE_ATTACH_PATTERN = /必ず[\s\S]{0,10}付与/;

describe("承認印の文書と CI の乖離検出", () => {
  it("1. 承認印リテラルが deploy-cloud.yml・CLAUDE.md・docs/current-spec.md・docs/development-workflow.md に同一の文字列で現れる", () => {
    const workflow = readNormalized(".github", "workflows", "deploy-cloud.yml");
    expect(workflow).toContain(APPROVAL_MARK);
    expect(readNormalized("CLAUDE.md")).toContain(APPROVAL_MARK);
    expect(readNormalized("docs", "current-spec.md")).toContain(APPROVAL_MARK);
    expect(readNormalized("docs", "development-workflow.md")).toContain(APPROVAL_MARK);
  });

  it("2. 旧セマンティクス(「push ごとに dev-latest が更新される」)の文言が README.md・docs/current-spec.md・docs/handover-next-session.md に再混入していない", () => {
    expect(hasStalePushEverySemantics(readNormalized("README.md"))).toBe(false);
    expect(hasStalePushEverySemantics(readNormalized("docs", "current-spec.md"))).toBe(false);
    expect(hasStalePushEverySemantics(readNormalized("docs", "handover-next-session.md"))).toBe(false);
  });

  it("3. 検出器(hasStalePushEverySemantics)自身が、過去に実際に問題だった本文を true と判定する(正の対照。空振り防止)", () => {
    // 【以下の 2 つの文字列はテストデータである】現在のリポジトリの記述ではなく、Issue #43 の作業中に実際に
    // 混入していた旧セマンティクスの再現データ(コミット 67f5b65 の README.md / docs/current-spec.md の該当文)。
    // git 参照ではなくリテラルにする理由: checkout が浅いクローン(fetch-depth 1)だと過去コミットを参照できず、
    // CI 上でだけ失敗する(または握りつぶすと常に空振りする)不安定なテストになるため。
    const staleReadmeSnippet =
      "- **開発版**: 開発ブランチへの push ごとにプレリリース **`dev-latest`** を差し替え公開します。";
    const staleCurrentSpecSnippet =
      "`claude/keiba-prediction-handover-ojr8t1`)への push ごとに固定タグ **`dev-latest`** のプレリリースを";
    expect(hasStalePushEverySemantics(staleReadmeSnippet)).toBe(true);
    expect(hasStalePushEverySemantics(staleCurrentSpecSnippet)).toBe(true);
  });

  it("4. 承認印の付与指示が CLAUDE.md 手順6・docs/development-workflow.md 手順7で命令形のまま維持されている(退行防止)", () => {
    const claudeMd = readNormalized("CLAUDE.md");
    const developmentWorkflow = readNormalized("docs", "development-workflow.md");

    const claudeStep6 = extractStepBlock(claudeMd, "6. メタレビューの承認が出たら", "\n7. ");
    // 前提固定: 抽出範囲が手順6だけに収まっている(手順7以降まで伸びると、手順6から命令形が消えても
    // 下流の別の「必ず」で条件が満たされ、退行が素通りする)。400 文字は文面の軽微な増減を許容しつつ、
    // 次のセクション全体を飲み込む抽出崩れは検出できる余裕。
    expect(claudeStep6).not.toContain("各Phase完了時に");
    expect(claudeStep6.length).toBeLessThan(400);
    expect(claudeStep6).toContain(APPROVAL_MARK);
    expect(IMPERATIVE_ATTACH_PATTERN.test(claudeStep6)).toBe(true);

    const workflowStep7 = extractStepBlock(developmentWorkflow, "7. **コミット**", "\n\n>");
    expect(workflowStep7).not.toContain("実装完了 ≠");
    expect(workflowStep7.length).toBeLessThan(350);
    expect(workflowStep7).toContain(APPROVAL_MARK);
    expect(IMPERATIVE_ATTACH_PATTERN.test(workflowStep7)).toBe(true);
  });
});

/** 廃止した運用の指示を、現在形で語り直していないかを見る語。 */
const RETIRED_OPERATION_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "廃止したワークフロー build-windows.yml の名指し", pattern: /build-windows\.yml/ },
  { name: "exe 再ビルドを実物で確認する運用", pattern: /exe\s*再ビルド/ },
  { name: "dev-latest の exe の updated_at を確認する運用", pattern: /updated_at/ },
];

/** 運用の指示を書く文書(現在形の指示)。履歴の記録(docs/lessons-learned.md ほか)は対象外。 */
const INSTRUCTION_DOCS: readonly (readonly string[])[] = [
  ["CLAUDE.md"],
  ["docs", "development-workflow.md"],
  ["docs", "gate-and-meta-review.md"],
  [".claude", "agents", "code-reviewer.md"],
  [".claude", "agents", "tdd-implementer.md"],
];

describe("5. 廃止した exe 公開の運用が、運用の指示文書に現在形で残っていない(Issue #248)", () => {
  it("前提: 検査対象の文書が 5 つあり、いずれも読めて空でない(空振りしていない)", () => {
    expect(INSTRUCTION_DOCS.length).toBe(5);
    for (const segments of INSTRUCTION_DOCS) {
      expect(readNormalized(...segments).length, segments.join("/")).toBeGreaterThan(100);
    }
  });

  it.each(INSTRUCTION_DOCS.map((s) => [s.join("/"), s] as const))("%s に、廃止した運用の語が無い", (_name, segments) => {
    const text = readNormalized(...segments);
    for (const { name, pattern } of RETIRED_OPERATION_PATTERNS) {
      expect(pattern.test(text), `${segments.join("/")}: ${name}`).toBe(false);
    }
  });

  it("正の対照: 検出パターンが、旧運用の実際の文言(CLAUDE.md の旧版にあった文)を捕まえる", () => {
    const old = [
      "CI(`build-windows.yml`)の該当 run が `conclusion=success` になったこと、かつ `dev-latest` リリースの",
      "毎回 exe 再ビルドを実物で確認して報告する",
      "exe の `updated_at` がプッシュ後の時刻であること",
    ].join("\n");
    for (const { name, pattern } of RETIRED_OPERATION_PATTERNS) {
      expect(pattern.test(old), name).toBe(true);
    }
  });
});
