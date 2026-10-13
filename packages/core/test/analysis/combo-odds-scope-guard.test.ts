import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 機能D-2c第3段(Issue #28)の受け入れ条件1・9を、ソース走査で構造的に固定する。
 *
 * 【機能D-2c第4段(Issue #28)で本ファイルの2つのdescribeを改訂した】
 * - 受け入れ条件1: 第3段時点では「`buildMixedCandidates`の呼び出し元が自身のテスト以外に
 *   0件であること」を「未使用であることの構造的保証」として固定していた。第4段はこの関数を
 *   実際に呼び出す(`mixed-allocation-view.ts`)ことが目的そのものであるため、
 *   「0件」という制約はもはや正しい不変条件ではない。**「唯一の承認された呼び出し元
 *   (`mixed-allocation-view.ts`)以外からは呼ばれていないこと」**に改訂する(ガードの精神
 *   ——`BatchAnalysisView.tsx`等が`mixed-allocation-view.ts`を経由せず直接呼ぶ、という
 *   「単一定義の原則」違反を検知する——は維持したまま、期待値だけを更新する)。
 * - 受け入れ条件9: 第3段時点の「補助文が『記録のみ』を謳っている」という前提自体は、
 *   第4段のAC19により`INCLUDE_COMBO_ODDS_LABELS.help`の文言が変わったため成立しなくなった
 *   (`settings-validation.test.ts`が新しい文言〈依存関係の明記〉を検証している)。
 *   一方、**このdescribeが実際に固定していた構造的事実
 *   (`bet-allocation-view.ts`がwideCombo/trioCombo/comboOddsを一切参照しない)自体は
 *   第4段でも変わっていない**(組合せオッズへの参照は`mixed-allocation-view.ts`が持ち、
 *   複勝専用の`bet-allocation-view.ts`は「単一定義の原則(D-2)」によりそれを知らないまま
 *   でよい設計のため)。したがって検証対象(何を保証するか)を「文言の裏付け」から
 *   「単一定義の原則の維持」に述べ直し、**アサーション自体は一切弱めていない**。
 *
 * 【Issue #287(#285 の段階B)】`packages/app/test/` から移した。文言の直書き禁止(対応表A2「JSXに文言を直書きしない」。exe の
 * SettingsView.tsx/BatchAnalysisView.tsx だけを見ていた 2 件の describe)は、exe の削除とともに消した。残りの 7 件(ヘルパー自己検証 4・受け入れ条件1 の 1・受け入れ条件9 の 2)は無変更。
 *
 * 【Issue #57でさらに改訂】配分計算の純関数を`renderer`から`shared`へ移設したことに伴い、
 * 以下の2点を空振り防止アサートの付け替え・期待値の更新で継承する(アサーションの強度は
 * 弱めていない。むしろ受け入れ条件9は1ファイル→2ファイルの検証に拡張した):
 * - 受け入れ条件1: `buildMixedCandidates`の定義は`renderer/mixed-candidates.ts`から
 *   `shared/mixed-candidates.ts`へ(ファイル名は変えず移動のみ)。唯一の承認された呼び出し元も
 *   `renderer/mixed-allocation-view.ts`から`shared/mixed-race-allocation.ts`(移設後の
 *   `buildMixedRaceAllocation`)へ変わった。
 * - 受け入れ条件9: `buildRaceAllocation`(複勝専用の配分計算本体)は
 *   `renderer/bet-allocation-view.ts`から`shared/race-allocation.ts`へ移設した。元の
 *   「bet-allocation-view.tsが組合せオッズに無関与」という1ファイルの保証を、
 *   分割後の2ファイル(`shared/race-allocation.ts`=計算・`renderer/bet-allocation-view.ts`=表示)
 *   それぞれについて個別に検証する形に拡張し、保証の対象範囲を移設前と同じ(むしろ広く)保つ。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// 【Issue #287(#285 の段階B)】exe(packages/app)を削除した。走査の範囲は、移設前の「app/src 全体 + core/src 全体」から、core/src 全体になった
// (app/src に呼び出し元が無いことは、app/src ごと無くなったので自明に成り立つ)。web(cloud/)の走査への拡張は、この段階では行わない。
const coreSrcDir = path.join(currentDir, "../../src");
const sharedDir = path.join(coreSrcDir, "analysis");
const coreViewDir = path.join(coreSrcDir, "view");

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

/**
 * `identifier`(関数名等)の呼び出し `identifier(` を含むファイルパスの一覧を、
 * `excludePathSuffixes`(定義ファイル・自身のテスト等)を除いて返す(呼び出し元の集合を
 * 特定するため。件数だけでなく「どのファイルが呼んでいるか」を機械的に固定する)。
 */
export function listCallerFiles(
  files: ReadonlyMap<string, string>,
  identifier: string,
  excludePathSuffixes: readonly string[],
): string[] {
  const callers: string[] = [];
  for (const [filePath, content] of files) {
    if (excludePathSuffixes.some((suffix) => filePath.endsWith(suffix))) continue;
    // グローバルフラグ付き正規表現は.test()を複数回呼ぶとlastIndexが状態を持ち、
    // 交互にfalseを返す(実測で自己テストが検知)。countCallersExcludingと同じ
    // .match()ベースの数え方(ファイルごとに新規マッチさせる)に揃える。
    const callPattern = new RegExp(`\\b${identifier}\\s*\\(`, "g");
    const withoutDeclaration = content.replace(
      new RegExp(`function\\s+${identifier}\\s*\\(`, "g"),
      "",
    );
    const matches = withoutDeclaration.match(callPattern);
    if ((matches?.length ?? 0) > 0) {
      callers.push(filePath);
    }
  }
  return callers.sort();
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

describe("listCallerFiles(テストヘルパーの自己検証)", () => {
  it("呼び出しを含むファイルのパス一覧を返し、除外指定したパスは含めないこと", () => {
    const files = new Map([
      ["/a/def.ts", "export function foo(x: number) { return x; }"],
      ["/a/caller1.ts", "foo(1);"],
      ["/a/caller2.ts", "foo(2);"],
      ["/a/foo.test.ts", "foo(3);"],
      ["/a/nocall.ts", "const x = 1;"],
    ]);
    expect(listCallerFiles(files, "foo", ["/a/def.ts", "/a/foo.test.ts"])).toEqual([
      "/a/caller1.ts",
      "/a/caller2.ts",
    ]);
  });

  it("呼び出しが1件も無ければ空配列を返すこと", () => {
    const files = new Map([["/a/def.ts", "export function bar() {}"]]);
    expect(listCallerFiles(files, "bar", ["/a/def.ts"])).toEqual([]);
  });
});

describe("受け入れ条件1(第4段で改訂、Issue #57でさらに改訂): buildMixedCandidatesの呼び出し元がanalysis/mixed-race-allocation.ts以外に無いこと(単一定義の原則)", () => {
  it("core/src配下(.ts/.tsx)を走査しても、analysis/mixed-candidates.ts自身とanalysis/mixed-race-allocation.ts以外に呼び出しが無いこと", () => {
    const files = readSourceFiles(coreSrcDir, [".ts", ".tsx"]);
    // 前提固定: 両ファイルに定義・呼び出しが実在すること(空振り防止)。
    expect(files.has(path.join(sharedDir, "mixed-candidates.ts"))).toBe(true);
    expect(files.has(path.join(sharedDir, "mixed-race-allocation.ts"))).toBe(true);
    const callers = listCallerFiles(files, "buildMixedCandidates", [
      path.join(sharedDir, "mixed-candidates.ts"),
    ]);
    // 唯一の承認された呼び出し元(analysis/mixed-race-allocation.ts の buildMixedRaceAllocation)
    // 以外は無いこと。exe の BatchAnalysisView.tsx(#287 で削除。3c1664e まで)等が単一定義の原則(D-2)を破って直接呼んでいないことの検知。
    expect(callers).toEqual([path.join(sharedDir, "mixed-race-allocation.ts")]);
  });
});

describe("受け入れ条件9(第4段で改訂、Issue #57でさらに改訂): 複勝専用の配分計算・表示が単一定義の原則により組合せオッズに一切関与しないこと", () => {
  it("analysis/race-allocation.ts(複勝専用の配分計算本体。Issue #57でbet-allocation-view.tsから分離)がwideCombo/trioCombo/comboOddsを一切参照していないこと", () => {
    const source = readFileSync(path.join(sharedDir, "race-allocation.ts"), "utf8");
    // 前提固定: このファイルには複勝配分の中核関数が実在すること(空振り防止)。
    expect(source).toContain("export function buildRaceAllocation");
    expect(source).not.toContain("wideCombo");
    expect(source).not.toContain("trioCombo");
    expect(source).not.toContain("comboOdds");
  });

  it("view/bet-allocation-view.ts(複勝専用の表示関数群)がwideCombo/trioCombo/comboOddsを一切参照していないこと", () => {
    const source = readFileSync(path.join(coreViewDir, "bet-allocation-view.ts"), "utf8");
    // 前提固定: このファイルには複勝配分の表示関数が実在すること(空振り防止)。
    expect(source).toContain("export function placeBetUnavailableMessage");
    expect(source).not.toContain("wideCombo");
    expect(source).not.toContain("trioCombo");
    expect(source).not.toContain("comboOdds");
  });
});
