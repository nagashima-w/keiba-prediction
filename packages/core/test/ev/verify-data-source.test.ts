import { describe, expect, it } from "vitest";
import { AnalysisStore } from "../../src/ev/analysis-store.js";
import type { VerifyDataSource } from "../../src/ev/analysis-store-types.js";
import {
  computeVerifyReport,
  DEFAULT_VERIFY_CONFIG,
  PRODUCTION_VERIFY_CONFIG,
} from "../../src/ev/verify.js";
import { classifyLookaheadSuspicion, extractStartTime, isLookaheadGuarded, type LookaheadSuspicionInput } from "../../src/ev/lookahead-suspicion.js";

/**
 * Issue #219: クラウド版(D1)が `computeVerifyReport` を使うための、core 側の入口の検査。
 *  - `VerifyDataSource`: 集計が使う4メソッドだけの狭い型(`AnalysisStore` を引かずに型検査が通る)
 *  - `PRODUCTION_VERIFY_CONFIG`: exe とクラウドで共有する本番の検証設定
 *  - `extractStartTime`: スナップショットから発走時刻の文字列を取り出す(先読み判定と補完が同じ関数を使う)
 */
describe("VerifyDataSource(集計の入口の狭い型)", () => {
  it("AnalysisStore は VerifyDataSource として渡せ、空のストアは空のレポートになる(型と実行の両方)", () => {
    const store = new AnalysisStore();
    const source: VerifyDataSource = store;
    const report = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "all");
    expect(report.includedAnalysisCount).toBe(0);
    expect(report.proposedBet.population.noRecord).toBe(0);
  });

  it("4メソッドだけを持つ手書きの実装でも集計できる(AnalysisStore の他のメソッドに依存しない)", () => {
    const source: VerifyDataSource = {
      listAnalyses: () => [],
      getResult: () => undefined,
      getComboPayouts: () => ({ state: "not_imported" }),
      getAllocationForVerify: () => undefined,
    };
    expect(computeVerifyReport(source).includedAnalysisCount).toBe(0);
  });
});

describe("PRODUCTION_VERIFY_CONFIG(本番の検証設定)", () => {
  it("既定の設定に、先読みリーク疑いの除外だけを足したもの(exe の検証画面の設定と同じ)", () => {
    expect(PRODUCTION_VERIFY_CONFIG).toEqual({ ...DEFAULT_VERIFY_CONFIG, excludeLookaheadSuspects: true });
    // 空振り防止: 既定との差は excludeLookaheadSuspects の1項目だけで、その値は true
    expect(DEFAULT_VERIFY_CONFIG.excludeLookaheadSuspects).toBe(false);
    expect(PRODUCTION_VERIFY_CONFIG.excludeLookaheadSuspects).toBe(true);
  });
});

describe("extractStartTime(スナップショットの発走時刻)", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string | null]> = [
    ["HH:MM の文字列はそのまま返す", { race: { startTime: "15:45" } }, "15:45"],
    ["1桁の時も読める形なら返す(先読み判定と同じ受理条件)", { race: { startTime: "9:05" } }, "9:05"],
    ["範囲外の時(24:00)は null", { race: { startTime: "24:00" } }, null],
    ["範囲外の分(10:60)は null", { race: { startTime: "10:60" } }, null],
    ["形が違う文字列は null", { race: { startTime: "午後3時" } }, null],
    ["文字列でない値は null", { race: { startTime: 1545 } }, null],
    ["startTime が null は null", { race: { startTime: null } }, null],
    ["race が無いと null", { horses: [] }, null],
    ["race がオブジェクトでないと null", { race: "x" }, null],
    ["スナップショットが null は null", null, null],
    ["スナップショットが文字列は null", "15:45", null],
  ];
  it.each(cases)("%s", (_name, snapshot, expected) => {
    expect(extractStartTime(snapshot)).toBe(expected);
  });
});

describe("isLookaheadGuarded(遮断済みか。分類の第1段と同じ定義)", () => {
  const base: LookaheadSuspicionInput = {
    raceId: "202606030811",
    analyzedAt: "2026-07-05T07:00:00.000Z",
    kaisaiDate: "20260705",
    promptVersion: "v1",
    historyCutoffDate: "20260705",
    promptLookaheadGuarded: true,
    raceSnapshot: null,
  };
  const cases: ReadonlyArray<readonly [string, Partial<LookaheadSuspicionInput>, boolean]> = [
    ["戦績側の印あり・LLM使用・プロンプト側も遮断済み", {}, true],
    ["戦績側の印あり・LLM未使用(プロンプト側の印は見ない)", { promptVersion: null, promptLookaheadGuarded: null }, true],
    ["戦績側の印あり・LLM使用・プロンプト側が false(明示的に未遮断)", { promptLookaheadGuarded: false }, false],
    ["戦績側の印あり・LLM使用・プロンプト側が null(記録なし)", { promptLookaheadGuarded: null }, false],
    ["戦績側の印なし(LLM未使用でも未遮断)", { historyCutoffDate: null, promptVersion: null }, false],
    ["両方なし", { historyCutoffDate: null, promptLookaheadGuarded: null }, false],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(isLookaheadGuarded({ ...base, ...overrides })).toBe(expected);
  });

  it("遮断済みの行は、発走時刻・分析時刻・開催日にかかわらず clean(= 発走時刻の欠落が判定に影響しない)", () => {
    for (const startTime of ["06:00", "23:59", null]) {
      for (const analyzedAt of ["2026-07-04T00:00:00.000Z", "2026-07-06T00:00:00.000Z", "壊れた日時"]) {
        const input = { ...base, analyzedAt, raceSnapshot: startTime === null ? null : { race: { startTime } } };
        expect(isLookaheadGuarded(input)).toBe(true);
        expect(classifyLookaheadSuspicion(input)).toBe("clean");
      }
    }
  });
});
