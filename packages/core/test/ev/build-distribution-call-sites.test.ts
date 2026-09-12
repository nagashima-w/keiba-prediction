import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * build-distribution-call-sites — Issue #80(#78-A)のAC-A1。
 *
 * `model.buildDistribution(`(`PlaceJointModel.buildDistribution`の呼び出し。同時分布モデルが
 * throwしうる唯一の入口)が production の `packages/core/src` 配下に何箇所あるかを
 * ソース走査で固定する(`packages/app/test/combo-odds-scope-guard.test.ts` の流儀に倣う)。
 *
 * 呼び出し構文(`<識別子>.buildDistribution(`)のみを数え、インターフェース宣言・メソッド定義
 * (`buildDistribution(horses, placeCount) {`。`place-joint-model.ts`・`plackett-luce-model.ts`)
 * は対象外にする(定義には`.`が付かないため、正規表現`\.buildDistribution\(`で自然に除外される)。
 *
 * 期待値(#80着手前ゲートでboss・実装担当の双方が実測し一致): 合計5箇所、内訳は
 * `bet-allocation.ts`1・`combo-bet-allocation.ts`2・`probability-quality-metrics.ts`2。
 * このうち**#80が受け皿を用意すべきものは前3件**(`bet-allocation.ts`・`combo-bet-allocation.ts`。
 * `probability-quality-metrics.ts`は`CONDITIONAL_BERNOULLI_MODEL`をハードコードしておりモデルを
 * 差し替える経路自体が存在しないため対象外。#79のスコープ)。
 *
 * *殺す変異*: 6つ目の呼び出し元を追加する / `combo-bet-allocation.ts`の1件を数から落とす
 *  → 合計・内訳のいずれかのリテラルと不一致になり必ず落ちる。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const coreSrcDir = path.join(currentDir, "../../src");

/** ディレクトリ配下の`.ts`ファイルを再帰的に読み込み、相対パス→内容のMapを返す。 */
function readSourceFiles(dir: string): Map<string, string> {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  const out = new Map<string, string>();
  for (const rel of entries) {
    if (!rel.endsWith(".ts")) continue;
    const full = path.join(dir, rel);
    out.set(rel.split(path.sep).join("/"), readFileSync(full, "utf8"));
  }
  return out;
}

/** `.buildDistribution(`(呼び出し構文のみ。メソッド定義は対象外)の出現数を数える。 */
function countBuildDistributionCalls(content: string): number {
  const matches = content.match(/\.buildDistribution\(/g);
  return matches?.length ?? 0;
}

describe("packages/core/src全体: model.buildDistribution(の呼び出し箇所が合計5箇所であること", () => {
  it("ヘルパー自己テスト(空振り防止): 呼び出し構文とメソッド定義を区別できること", () => {
    const callOnly = "  const d = model.buildDistribution(horses, 3);\n";
    const definitionOnly = "  buildDistribution(horses, placeCount) {\n    return [];\n  },\n";
    expect(countBuildDistributionCalls(callOnly)).toBe(1);
    expect(countBuildDistributionCalls(definitionOnly)).toBe(0);
  });

  it("合計5箇所(前提固定。内訳の和と一致することも兼ねて検算)", () => {
    const files = readSourceFiles(coreSrcDir);
    let total = 0;
    for (const content of files.values()) {
      total += countBuildDistributionCalls(content);
    }
    expect(total).toBe(5);
  });

  it("内訳: bet-allocation.tsが1箇所", () => {
    const files = readSourceFiles(coreSrcDir);
    const content = files.get("ev/bet-allocation.ts");
    expect(content).toBeDefined();
    expect(countBuildDistributionCalls(content!)).toBe(1);
  });

  it("内訳: combo-bet-allocation.tsが2箇所", () => {
    const files = readSourceFiles(coreSrcDir);
    const content = files.get("ev/combo-bet-allocation.ts");
    expect(content).toBeDefined();
    expect(countBuildDistributionCalls(content!)).toBe(2);
  });

  it("内訳: probability-quality-metrics.tsが2箇所(#80の受け皿対象外。CONDITIONAL_BERNOULLI_MODEL固定のため)", () => {
    const files = readSourceFiles(coreSrcDir);
    const content = files.get("ev/probability-quality-metrics.ts");
    expect(content).toBeDefined();
    expect(countBuildDistributionCalls(content!)).toBe(2);
  });

  it("内訳の和が合計と一致すること(内訳を書くときは和が総数と一致することを確かめる。CLAUDE.md)", () => {
    const files = readSourceFiles(coreSrcDir);
    const betAllocation = countBuildDistributionCalls(files.get("ev/bet-allocation.ts")!);
    const comboBetAllocation = countBuildDistributionCalls(files.get("ev/combo-bet-allocation.ts")!);
    const probabilityQuality = countBuildDistributionCalls(files.get("ev/probability-quality-metrics.ts")!);
    let total = 0;
    for (const content of files.values()) {
      total += countBuildDistributionCalls(content);
    }
    expect(betAllocation + comboBetAllocation + probabilityQuality).toBe(total);
  });

  it("上記3ファイル以外に呼び出しが無いこと(6つ目の呼び出し元を追加する変異を殺す)", () => {
    const files = readSourceFiles(coreSrcDir);
    const knownFiles = new Set([
      "ev/bet-allocation.ts",
      "ev/combo-bet-allocation.ts",
      "ev/probability-quality-metrics.ts",
    ]);
    const otherFilesWithCalls: string[] = [];
    for (const [file, content] of files) {
      if (knownFiles.has(file)) continue;
      if (countBuildDistributionCalls(content) > 0) {
        otherFilesWithCalls.push(file);
      }
    }
    expect(otherFilesWithCalls).toEqual([]);
  });

  it("#80が受け皿を用意すべきものは前3件のうちbet-allocation.ts+combo-bet-allocation.tsの3箇所(1+2)であること", () => {
    const files = readSourceFiles(coreSrcDir);
    const receptacleTargetCount =
      countBuildDistributionCalls(files.get("ev/bet-allocation.ts")!) +
      countBuildDistributionCalls(files.get("ev/combo-bet-allocation.ts")!);
    expect(receptacleTargetCount).toBe(3);
  });
});
