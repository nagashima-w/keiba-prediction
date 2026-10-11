import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  computeGolden,
  type GoldenFile,
} from "./golden/pipeline-golden-scenarios.js";

/**
 * Issue #176(#164-a)AC-a1: runAnalysis の出力が、変更前(b821c97〈v1.19.9〉)に生成した golden JSON と一致すること。
 * runAnalysis をクラウドに載せるための変更(バレル import の差し替え・deps の非同期許容・当日傾向のバッチ読み出し)で、
 * exe の保存レコード(AnalysisRecord)・画面に返す結果(AnalysisResult)・LLM に渡る入力とプロンプト本文が変わらないことを固定する。
 * golden の生成手順: `pnpm tsx scripts/gen-pipeline-golden.ts`(シナリオは `golden/pipeline-golden-scenarios.ts`)。
 */

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./golden/pipeline-golden.json", import.meta.url)),
    "utf-8",
  ),
) as GoldenFile;

describe("runAnalysis の golden(exe の出力が変わらないこと。Issue #176 AC-a1)", () => {
  it("前提(空振り防止): golden が、組合せオッズ・配分・当日傾向・重賞傾向・LLM のプロンプトを実際に含んでいる", () => {
    // 配分は多点(退化入力ではない)
    expect(golden.noLlmAllBets.record.allocation?.bets.length ?? 0).toBeGreaterThan(1);
    expect(golden.noLlmAllBets.result.rows).toHaveLength(16);
    // 組合せオッズ(全券種)
    expect(Object.keys(golden.noLlmAllBets.result.trifectaCombo ?? {}).length).toBeGreaterThan(1000);
    // LLM のシナリオ: 当日傾向と重賞傾向が入っている
    const llm = golden.llmStubSameDayGrade;
    expect(llm.promptInput?.race.sameDayTrend).not.toBeNull();
    expect(llm.promptInput?.race.gradeWinnerTrend).not.toBeNull();
    expect(llm.promptText?.length ?? 0).toBeGreaterThan(1000);
    expect(llm.result.llmUsed).toBe(true);
    // 当日傾向は自レース(11R)より前の 01〜10R だけを引く
    expect(llm.resultDetailLookups).toEqual(
      Array.from({ length: 10 }, (_, i) => `2026030202${String(i + 1).padStart(2, "0")}`),
    );
    // LLM なし・開催日なしは、近似日付になる
    expect(golden.noLlmNoAllocationNoDate.result.dateApproximate).toBe(true);
    expect(golden.noLlmNoAllocationNoDate.record.allocation).toBeUndefined();
  });

  // 個別のタイムアウト(Issue #255)。既定の 5000ms は、負荷のあるときに足りない。
  // 時間の大半は `computeGolden()`(3 シナリオの runAnalysis。16 頭立ての全券種の組合せオッズを含む)で、`toEqual` の比較は約 40ms にすぎない
  // (単独の実行で computeGolden 約 2.75 秒・toEqual 約 0.04 秒。4 コアの環境、N=2 回の実測。N が小さいので桁の目安)。
  // 再現(旧の既定 5000ms のとき): packages/app で `for i in 1 2 3 4; do (timeout 60 node -e "while(true){}" &); done; pnpm exec vitest run`
  // (4 コアに 4 プロセスの負荷をかけると、このテストだけが 5.8 秒で落ちた。N=1。負荷なしでは約 3 秒)。
  // 全テストの timeout を延ばす・直列にする案は、ほかのテストの異常(無限ループなど)の検知を鈍らせるので採らない。
  it("3シナリオとも、今の runAnalysis の出力が golden と完全に一致する", async () => {
    const actual = await computeGolden();
    expect(actual.noLlmAllBets).toEqual(golden.noLlmAllBets);
    expect(actual.llmStubSameDayGrade).toEqual(golden.llmStubSameDayGrade);
    expect(actual.noLlmNoAllocationNoDate).toEqual(golden.noLlmNoAllocationNoDate);
  }, 30_000);
});
