import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";
import { parseKaisaiDate, parseRaceId, type FetchLike, type FetchResponse } from "@keiba/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPipelineDeps,
  shouldUseLlm,
  type PipelineResources,
} from "../src/main/pipeline-deps.js";

describe("shouldUseLlm(APIキー有無の判定)", () => {
  it("APIキーが未設定・空白のみなら false", () => {
    expect(shouldUseLlm(undefined)).toBe(false);
    expect(shouldUseLlm("")).toBe(false);
    expect(shouldUseLlm("   ")).toBe(false);
  });

  it("APIキーがあれば true", () => {
    expect(shouldUseLlm("sk-ant-xxx")).toBe(true);
  });
});

describe("createPipelineDeps(本番依存の配線)", () => {
  const resources: PipelineResources[] = [];
  afterEach(() => {
    for (const r of resources.splice(0)) {
      r.close();
    }
  });

  it("APIキー未設定なら analyze=null・スキップ理由付きで組み立てる", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(r.deps.analyze).toBeNull();
    expect(r.deps.llmSkipReason).toContain("APIキー");
    expect(typeof r.deps.saveAnalysis).toBe("function");
    expect(typeof r.deps.scrape).toBe("function");
    expect(typeof r.listRaces).toBe("function");
  });

  it("onFallback 未指定なら deps.onFallback は undefined であること(論点E)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(r.deps.onFallback).toBeUndefined();
  });

  it("onFallback を渡すと deps.onFallback から診断メッセージ・raceId・stopReason で呼ばれること(論点E: ログ配線用)", () => {
    const onFallback = vi.fn();
    const r = createPipelineDeps({ dbPath: ":memory:", onFallback });
    resources.push(r);
    r.deps.onFallback?.({
      raceId: parseRaceId("202605020811"),
      stopReason: "max_tokens",
      diagnosticMessage: "テスト診断メッセージ",
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("テスト診断メッセージ", {
      raceId: "202605020811",
      stopReason: "max_tokens",
    });
  });

  it("getVerifyReportByPromptVersion が組み立てられ、未分析なら空配列を返すこと(Task#27)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getVerifyReportByPromptVersion).toBe("function");
    expect(r.getVerifyReportByPromptVersion()).toEqual([]);
  });

  it("deleteUnknownPromptVersionAnalyses が組み立てられ、分析が無ければ削除0件を返すこと(Task#33)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.deleteUnknownPromptVersionAnalyses).toBe("function");
    expect(r.deleteUnknownPromptVersionAnalyses()).toEqual({ deletedCount: 0 });
  });

  it("deleteUnknownPromptVersionAnalyses が版不明の分析だけをAnalysisStoreから削除し、版ありは残すこと(Task#33)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    r.deps.saveAnalysis({
      raceId: "版不明レース",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
    });
    r.deps.saveAnalysis({
      raceId: "版ありレース",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
      promptVersion: "2026-07-14.1",
    });

    const result = r.deleteUnknownPromptVersionAnalyses();

    expect(result).toEqual({ deletedCount: 1 });
    expect(r.getVerifyReportByPromptVersion()).toHaveLength(1);
    expect(r.getVerifyReportByPromptVersion()[0]!.promptVersion).toBe("2026-07-14.1");
  });

  it("getRaceLedger が組み立てられ、未分析なら空配列を返すこと(検証画面UI統合: 旧listAnalysisHistory+getRaceBreakdownの置換)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getRaceLedger).toBe("function");
    expect(r.getRaceLedger()).toEqual([]);
  });

  it("getRaceLedger は結果未取込の分析も対象に含めること(旧getRaceBreakdownとの違い。母集団は分析済みの全レース)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    r.deps.saveAnalysis({
      raceId: "202605020811", // 場コード05 → 東京、末尾2桁11 → 11R。
      analyzedAt: "2026-07-08T10:00:00.000Z",
      kaisaiDate: "20260708",
      horses: [
        {
          umaban: 1,
          prior: 0.5,
          adjustedProb: 0.5,
          placeOddsMin: 2.0,
          ev: 1.0,
          isPositive: true,
          contributions: null,
          mark: null,
        },
      ],
    });
    // 結果はまだ未取込だが、レース一覧統合の母集団には含まれ、hasResult=falseで返ること。
    const [entry] = r.getRaceLedger();
    expect(entry).toBeDefined();
    expect(entry!.raceId).toBe("202605020811");
    expect(entry!.venueName).toBe("東京");
    expect(entry!.raceNumber).toBe(11);
    expect(entry!.hasResult).toBe(false);
    expect(entry!.hasPayout).toBe(false);
  });

  it("getVerifyReport が組み立てられ、未分析なら includedAnalysisCount=0 を返すこと", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getVerifyReport).toBe("function");
    expect(r.getVerifyReport().includedAnalysisCount).toBe(0);
  });

  it("getVerifyReport は venueKind 引数を computeVerifyReport へそのまま伝え、開催区分で絞り込むこと(Task#32)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    // 中央(場コード05)の分析を1件、結果未取込のまま保存する。
    r.deps.saveAnalysis({
      raceId: "202605020811",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
    });

    // venueKind未指定("all"相当)・central はこの分析を対象に含める(結果未取込のため除外件数として)。
    expect(r.getVerifyReport().excludedAnalysisCount).toBe(1);
    expect(r.getVerifyReport("central").excludedAnalysisCount).toBe(1);
    // nar で絞り込むと、この中央分析はそもそも母集団に入らない(除外件数にも計上されない)。
    expect(r.getVerifyReport("nar").excludedAnalysisCount).toBe(0);
    expect(r.getVerifyReport("nar").includedAnalysisCount).toBe(0);
  });

  it("listUnimportedRaceIds が組み立てられ、未分析なら空配列を返すこと(Task#31)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.listUnimportedRaceIds).toBe("function");
    expect(r.listUnimportedRaceIds()).toEqual([]);
  });

  it("listUnimportedRaceIds が分析済みだが結果未取込のレースIDを返すこと(Task#31)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    r.deps.saveAnalysis({
      raceId: "202605020811",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
    });
    expect(r.listUnimportedRaceIds()).toEqual(["202605020811"]);
  });

  it("APIキーがあれば analyze は関数として組み立てられる", () => {
    const r = createPipelineDeps({ dbPath: ":memory:", apiKey: "sk-ant-xxx" });
    resources.push(r);
    expect(typeof r.deps.analyze).toBe("function");
  });

  it("scorerConfig / evConfig を渡すと deps にそのまま反映される(設定の適用)", () => {
    const scorerConfig = {
      ...DEFAULT_SCORER_CONFIG,
      weights: { ...DEFAULT_SCORER_CONFIG.weights, trackCondition: 0.5 },
    };
    const evConfig = { threshold: 1.4 };
    const r = createPipelineDeps({
      dbPath: ":memory:",
      scorerConfig,
      evConfig,
    });
    resources.push(r);
    expect(r.deps.scorerConfig).toBe(scorerConfig);
    expect(r.deps.evConfig).toBe(evConfig);
  });

  it("additionalInstruction を渡すと deps にそのまま反映される(設定の適用、Task#28)", () => {
    const r = createPipelineDeps({
      dbPath: ":memory:",
      additionalInstruction: "人気薄の複勝率は慎重に見積もること",
    });
    resources.push(r);
    expect(r.deps.additionalInstruction).toBe(
      "人気薄の複勝率は慎重に見積もること",
    );
  });

  it("additionalInstruction未指定ならdeps.additionalInstructionはundefinedのまま(Task#28)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(r.deps.additionalInstruction).toBeUndefined();
  });

  it("config.fetch を渡すと、実HTTP取得(undici既定)ではなく注入した fetch が使われる", async () => {
    // 空HTMLを返す euc-jp レスポンス。parseRaceList は対象要素が無ければ空配列を返す。
    const emptyResponse: FetchResponse = {
      status: 200,
      ok: true,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-type"
            ? "text/html; charset=euc-jp"
            : null,
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
    const fetch = vi.fn<FetchLike>(async () => emptyResponse);

    const r = createPipelineDeps({ dbPath: ":memory:", fetch });
    resources.push(r);

    const entries = await r.listRaces(parseKaisaiDate("20260101"));

    // 注入した fetch がレース一覧サブHTMLの URL で呼ばれ、undici 既定経路を通らないこと。
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain("race_list_sub.html");
    expect(entries).toEqual([]);
  });

  it("listNarRaces は地方(nar.netkeiba.com)のURLで注入fetchを呼ぶこと", async () => {
    const emptyResponse: FetchResponse = {
      status: 200,
      ok: true,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-type"
            ? "text/html; charset=euc-jp"
            : null,
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
    const fetch = vi.fn<FetchLike>(async () => emptyResponse);

    const r = createPipelineDeps({ dbPath: ":memory:", fetch });
    resources.push(r);

    expect(typeof r.listNarRaces).toBe("function");
    const entries = await r.listNarRaces(parseKaisaiDate("20260101"));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain("nar.netkeiba.com");
    expect(fetch.mock.calls[0]![0]).toContain("race_list_sub.html");
    expect(entries).toEqual([]);
  });

  it("config.onWarn を渡すと、HttpClientのサポート外charset警告がconsole.warnではなくonWarnへ届くこと(要修正4: coreはelectronに依存できないため注入経路を組み立てる)", async () => {
    const shiftJisResponse: FetchResponse = {
      status: 200,
      ok: true,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-type"
            ? "text/html; charset=shift_jis"
            : null,
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
    const fetch = vi.fn<FetchLike>(async () => shiftJisResponse);
    const onWarn = vi.fn();

    const r = createPipelineDeps({ dbPath: ":memory:", fetch, onWarn });
    resources.push(r);

    await r.listRaces(parseKaisaiDate("20260101"));

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain("shift_jis");
  });
});
