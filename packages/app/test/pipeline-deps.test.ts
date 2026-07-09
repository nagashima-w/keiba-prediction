import { afterEach, describe, expect, it } from "vitest";

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

  it("APIキーがあれば analyze は関数として組み立てられる", () => {
    const r = createPipelineDeps({ dbPath: ":memory:", apiKey: "sk-ant-xxx" });
    resources.push(r);
    expect(typeof r.deps.analyze).toBe("function");
  });
});
