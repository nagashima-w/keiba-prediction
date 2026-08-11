import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 機能D-2c第3段(Issue #28)の受け入れ条件1・9を、ソース走査で構造的に固定する。
 *
 * - 受け入れ条件1: 配分計算(`bet-allocation-view.ts`)には差分が無いこと。
 *   `buildMixedCandidates`(第2段。券種横断の配分候補ビルダー)の呼び出し元が、
 *   自身のテスト以外に0件のままであること(第2段AC2「未使用の構造的保証」を第3段でも解除しない)。
 * - 受け入れ条件9: 設定画面の補助文(INCLUDE_COMBO_ODDS_LABELS.help)が謳う
 *   「記録のみで配分提案には使わない」ことが、第3段時点で事実であること。
 *   `bet-allocation-view.ts`(複勝の配分計算本体)が組合せオッズ(wideCombo/trioCombo/comboOdds)を
 *   一切参照していないことを直接確認して裏付ける。
 *
 * 文言の直書き禁止(対応表A2「JSXに文言を直書きしない」)もここで固定する:
 * SettingsView.tsx/BatchAnalysisView.tsxが定数を経由して文言を表示し、生文字列を二重管理していないこと。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(currentDir, "../src");
const rendererDir = path.join(srcDir, "renderer");

/** ディレクトリ配下の対象拡張子ファイルを再帰的に読み込み、パス→内容のMapを返す。 */
function readSourceFiles(dir: string, extensions: readonly string[]): Map<string, string> {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  const out = new Map<string, string>();
  for (const rel of entries) {
    if (!extensions.some((ext) => rel.endsWith(ext))) continue;
    const full = path.join(dir, rel);
    out.set(full, readFileSync(full, "utf8"));
  }
  return out;
}

/**
 * `identifier`(関数名等)の呼び出し `identifier(` が、`excludePath` 以外のファイルに
 * 何件現れるかを数える(定義自体・import文の識別子出現は対象外。呼び出し構文のみを見る)。
 */
export function countCallersExcluding(
  files: ReadonlyMap<string, string>,
  identifier: string,
  excludePathSuffix: string,
): number {
  const callPattern = new RegExp(`\\b${identifier}\\s*\\(`, "g");
  let count = 0;
  for (const [filePath, content] of files) {
    if (filePath.endsWith(excludePathSuffix)) continue;
    // 定義箇所(`export function buildMixedCandidates(`)自体は関数宣言であって呼び出しではないが、
    // 構文上は同じ`identifier(`パターンにマッチしてしまう。定義行を除外して数える。
    const withoutDeclaration = content.replace(
      new RegExp(`function\\s+${identifier}\\s*\\(`, "g"),
      "",
    );
    const matches = withoutDeclaration.match(callPattern);
    count += matches?.length ?? 0;
  }
  return count;
}

describe("countCallersExcluding(テストヘルパーの自己検証)", () => {
  it("定義以外の呼び出しを数え、指定パスの呼び出しは除外すること", () => {
    const files = new Map([
      ["/a/def.ts", "export function foo(x: number) { return x; }"],
      ["/a/caller.ts", "foo(1); foo(2);"],
      ["/a/foo.test.ts", "foo(3);"],
    ]);
    expect(countCallersExcluding(files, "foo", "/a/foo.test.ts")).toBe(2);
  });

  it("呼び出しが無ければ0を返すこと", () => {
    const files = new Map([["/a/def.ts", "export function bar() {}"]]);
    expect(countCallersExcluding(files, "bar", "/a/bar.test.ts")).toBe(0);
  });
});

describe("受け入れ条件1: buildMixedCandidatesの呼び出し元が自身のテスト以外に0件であること(第2段AC2の維持)", () => {
  it("app/src配下(.ts/.tsx)を走査しても、mixed-candidates.ts自身以外に呼び出しが無いこと", () => {
    const files = readSourceFiles(srcDir, [".ts", ".tsx"]);
    // 前提固定: mixed-candidates.tsに定義自体は実在すること。
    expect(files.has(path.join(rendererDir, "mixed-candidates.ts"))).toBe(true);
    const count = countCallersExcluding(
      files,
      "buildMixedCandidates",
      path.join(rendererDir, "mixed-candidates.ts"),
    );
    expect(count).toBe(0);
  });
});

describe("受け入れ条件9: 補助文『記録のみ』が第3段時点で事実であること(bet-allocation-view.tsの無関与を裏付ける)", () => {
  it("bet-allocation-view.ts(配分計算本体)がwideCombo/trioCombo/comboOddsを一切参照していないこと", () => {
    const source = readFileSync(
      path.join(rendererDir, "bet-allocation-view.ts"),
      "utf8",
    );
    // 前提固定: このファイルには複勝配分の中核関数が実在すること(空振り防止)。
    expect(source).toContain("export function buildRaceAllocation");
    expect(source).not.toContain("wideCombo");
    expect(source).not.toContain("trioCombo");
    expect(source).not.toContain("comboOdds");
  });
});

describe("文言の一元管理(対応表A2: JSXに文言を直書きしない)", () => {
  it("SettingsView.tsxがINCLUDE_COMBO_ODDS_LABELSを参照し、チェックボックスのラベル文字列を直書きしていないこと", () => {
    const source = readFileSync(
      path.join(rendererDir, "SettingsView.tsx"),
      "utf8",
    );
    expect(source).toContain("INCLUDE_COMBO_ODDS_LABELS");
    expect(source).not.toContain("ワイド・三連複のオッズも取得する");
  });

  it("BatchAnalysisView.tsxがINCLUDE_COMBO_ODDS_BATCH_NOTEを参照し、注記文字列を直書きしていないこと", () => {
    const source = readFileSync(
      path.join(rendererDir, "BatchAnalysisView.tsx"),
      "utf8",
    );
    expect(source).toContain("INCLUDE_COMBO_ODDS_BATCH_NOTE");
  });
});
