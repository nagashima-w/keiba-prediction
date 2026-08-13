import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * BatchAnalysisView.tsx の混在配分ブロック(renderMixedAllocationBlock)が、既存の複勝専用
 * 経路(buildAllocationNotices)と同じ3種の注記(advisory・確率合計警告・notDiversified)を
 * 漏れなく含んでいることをソース走査で固定する(boss メタレビュー差し戻し2026-08-13対応)。
 *
 * ## 背景
 * boss のメタレビューにより、混在経路が確率合計警告(probabilitySumWarning相当)を
 * 一切出していなかったことが判明した(advisoryとnotDiversifiedの2つしか積んでいなかった)。
 * `BatchAnalysisView.tsx` はReactコンポーネントであり、本リポジトリにはReact描画テスト基盤が
 * 無い(`@testing-library`/`jsdom`/`happy-dom`いずれも未導入)ため、実際に描画して「3種とも
 * 表示されること」を直接検証できない。**「書かれなかったもの(消えた注記)はミューテーションでは
 * 検出できない」**というboss指摘のとおり、通常のロジックテスト(mixed-allocation-view.test.ts)
 * だけでは、`display.probabilitySumWarning`という値そのものが存在しても、それを
 * `BatchAnalysisView.tsx`側が**noticesに積み忘れる**という退行までは検知できない。
 *
 * そこでソース走査により、`renderMixedAllocationBlock`関数の本体が3つの参照
 * (`result.advisory`・`display.probabilitySumWarning`・`result.notDiversified`)を
 * すべて含むことを固定する(将来この3つのうち1つでも削除されたらこのテストが落ちる)。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const batchAnalysisViewPath = path.join(currentDir, "../src/renderer/BatchAnalysisView.tsx");

/** `renderMixedAllocationBlock`関数の本体だけを取り出す(次の`function `宣言までの範囲)。 */
function extractRenderMixedAllocationBlockBody(source: string): string {
  const start = source.indexOf("function renderMixedAllocationBlock");
  if (start === -1) {
    throw new Error("renderMixedAllocationBlock関数が見つかりません");
  }
  const rest = source.slice(start + "function renderMixedAllocationBlock".length);
  const nextFunctionIdx = rest.indexOf("\nfunction ");
  return nextFunctionIdx === -1 ? rest : rest.slice(0, nextFunctionIdx);
}

describe("extractRenderMixedAllocationBlockBody(テストヘルパーの自己検証)", () => {
  it("2つの関数が並んだソースから、1つ目の関数本体だけを取り出せること", () => {
    const source = [
      "function renderMixedAllocationBlock(a) {",
      "  return a.advisory;",
      "}",
      "",
      "function other() {",
      "  return a.advisory; // これは含まれてはいけない",
      "}",
    ].join("\n");
    const body = extractRenderMixedAllocationBlockBody(source);
    expect(body).toContain("return a.advisory;");
    expect(body).not.toContain("これは含まれてはいけない");
  });
});

describe("renderMixedAllocationBlockのnoticesが既存経路の3種(advisory/確率合計警告/notDiversified)を漏れなく含むこと", () => {
  it("result.advisory・display.probabilitySumWarning・result.notDiversifiedの3つすべてを参照していること", () => {
    const source = readFileSync(batchAnalysisViewPath, "utf-8");
    const body = extractRenderMixedAllocationBlockBody(source);
    expect(body).toContain("result.advisory");
    expect(body).toContain("display.probabilitySumWarning");
    expect(body).toContain("result.notDiversified");
  });
});
