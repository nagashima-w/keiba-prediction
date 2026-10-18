import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { computeCloseComparison, type VerifyCloseRows } from "../src/verify-close";
import { buildVerifySource, type VerifyReadRows } from "../src/verify-read";
import { pathFromMeta } from "./meta-path";

/**
 * Issue #373(#352 の【記録】): 検証画面の回の見出し「5分前」は、サーバの回の定義(`analysis-close.ts` の定数 → `CLOSE_ROUNDS`)に追随する。
 * 連鎖は 3 段(定数 → CLOSE_ROUNDS → `computeCloseComparison` の leadMinutes → クライアントのラベル)。ここでは前の 2 段を検査する(最後の段は client-verify-model.test.ts)。
 *  - leadMinutes が CLOSE_ROUNDS に追随すること: `CLOSE_ROUNDS` を 7 分・3 分に差し替えて(vi.mock)、`leadMinutes` が [7, 3] になることを見る。実値の 5・2 のままでは、leadMinutes をベタ書きしても緑になる。
 *  - 定数 → CLOSE_ROUNDS: 実値が同じ(5 分)ままでは、`CLOSE_ROUNDS` が定数を使わずベタ書きでも緑になるため、ソースの文字列で検査する。
 *    **これは文字列検査なので、同じ意味の別の書き方(定数を一度ローカル変数に入れるなど)には誤って落ちる。意味の検査ではなく、現在の書き方の固定である。**
 */

vi.mock("../src/analysis-close", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/analysis-close")>();
  return {
    ...actual,
    CLOSE_ROUNDS: [
      { round: 1, leadMs: 7 * 60_000 },
      { round: 2, leadMs: 3 * 60_000 },
    ],
  };
});

const rows: VerifyReadRows = {
  analyses: [
    {
      id: 1, raceId: "202606030801", analyzedAt: "2026-07-05T05:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
      model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: "20260705", promptLookaheadGuarded: 1, startTime: "15:45",
    },
  ],
  horses: [],
  results: [{ raceId: "202606030801", umaban: 1, finishPosition: 1, placePayout: 300, winPayout: null }],
  allocationMeta: [{ analysisId: 1, route: "place-only", skipReasonCode: null }],
  bets: [{ analysisId: 1, betType: "place", comboKey: "01", stake: 1000 }],
  comboPayouts: [],
  comboImports: [],
};
const close: VerifyCloseRows = {
  meta: [{ analysisId: 1, round: 1, status: "ok", route: "place-only", skipReasonCode: null }],
  bets: [{ analysisId: 1, round: 1, betType: "place", comboKey: "01", stake: 500 }],
};

describe("回のリード(分)は CLOSE_ROUNDS から作る(Issue #373)", () => {
  it("CLOSE_ROUNDS を 7 分・3 分に差し替えると、leadMinutes も [7, 3] になる(5・2 のベタ書きではない)", () => {
    const c = computeCloseComparison(buildVerifySource(rows), close);
    expect(c).not.toBeNull();
    expect(c!.rounds.map((r) => [r.round, r.leadMinutes])).toEqual([[1, 7], [2, 3]]);
  });
});

describe("定数 → CLOSE_ROUNDS(ソースの文字列検査。上のコメントの限界を参照)", () => {
  it("analysis-close.ts の CLOSE_ROUNDS は、回 1 を CLOSE_FIRST_LEAD_MS、回 2 を CLOSE_FINAL_LEAD_MS から作っている", () => {
    const source = readFileSync(pathFromMeta("../src/analysis-close.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\{ round: 1, leadMs: CLOSE_FIRST_LEAD_MS \}/);
    expect(source).toMatch(/\{ round: 2, leadMs: CLOSE_FINAL_LEAD_MS \}/);
  });
});
