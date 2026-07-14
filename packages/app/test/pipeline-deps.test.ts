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
});
