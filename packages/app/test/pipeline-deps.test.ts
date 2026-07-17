import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";
import { parseKaisaiDate, type FetchLike, type FetchResponse } from "@keiba/core";
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

  it("getVerifyReportByPromptVersion が組み立てられ、未分析なら空配列を返すこと(Task#27)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getVerifyReportByPromptVersion).toBe("function");
    expect(r.getVerifyReportByPromptVersion()).toEqual([]);
  });

  it("getRaceBreakdown が組み立てられ、未分析なら空配列を返すこと(Task#34)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getRaceBreakdown).toBe("function");
    expect(r.getRaceBreakdown()).toEqual([]);
  });

  it("getRaceBreakdown は結果未取込の分析を対象外(空配列)にすること(Task#34。verifyと同じ母集団)", () => {
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
    // 結果はまだ未取込なので対象外(空配列)。
    expect(r.getRaceBreakdown()).toEqual([]);
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
