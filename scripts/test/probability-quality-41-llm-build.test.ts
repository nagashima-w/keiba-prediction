import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  CLIP_VARIANTS,
  PROMPT_VERSION,
  type BuildPromptInput,
  type GradeWinnerFetcher,
  type RaceData,
} from "../../packages/core/src/index.js";
import { driveRunAnalysis } from "../probability-quality-41-llm/drive.js";
import { CASE_ID_SEED } from "../probability-quality-41-llm/case-ids.js";
import { buildPromptArtifacts, type PromptTarget } from "../probability-quality-41-llm/build-prompts.js";
import { sha256Hex } from "../probability-quality-41-llm/records.js";

/**
 * 段階1(プロンプト生成)の中核 `buildPromptArtifacts` を保存済みフィクスチャでオフラインに検証する
 * (ネットワークは注入された関数だけ。実サイトへのリクエストは含まない)。
 * 中央(raceId=202603020211・重賞バッジあり)と地方(raceId=202654071210・バッジなし)。
 */

function loadRaw(name: string): RaceData {
  const url = new URL(`../../docs/investigations/combo-odds-real-fetch/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as RaceData;
}
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");
}

const RAW = new Map<string, { raceData: RaceData; resultHtml: string }>([
  ["202603020211", { raceData: loadRaw("central-on.json"), resultHtml: fixture("result_202603020211.html") }],
  ["202654071210", { raceData: loadRaw("nar-on.json"), resultHtml: fixture("nar_result_202654071210.html") }],
]);
const GRADE_BODY = fixture("grade_winner_202603020211.json");

const TARGETS: PromptTarget[] = [
  { raceId: "202603020211", region: "central", kaisaiDate: "20260628" },
  { raceId: "202654071210", region: "nar", kaisaiDate: "20260712" },
];

function setup(grade: GradeWinnerFetcher = { fetchText: async () => GRADE_BODY }) {
  const gradeCalls: string[] = [];
  const repoPrompts = new Map<string, string>();
  const subagentPrompts = new Map<string, string>();
  const deps = {
    loadRaw: (raceId: string) => RAW.get(raceId)!,
    resultHtmlOf: () => undefined,
    gradeFetcherFor: (raceId: string): GradeWinnerFetcher => ({
      fetchText: async (url, options) => {
        gradeCalls.push(raceId);
        return grade.fetchText(url, options);
      },
    }),
    writeRepoPrompt: (raceId: string, text: string) => void repoPrompts.set(raceId, text),
    writeSubagentPrompt: (caseId: string, text: string) => void subagentPrompts.set(caseId, text),
  };
  return { deps, gradeCalls, repoPrompts, subagentPrompts };
}

describe("buildPromptArtifacts: プロンプトと対応表", () => {
  it("レースごとに production の buildPrompt の文字列を書き、対応表にハッシュ・文字数・版を記録する", async () => {
    const s = setup();
    const index = await buildPromptArtifacts(TARGETS, s.deps, { gitCommit: "abc123" });
    expect(index.promptVersion).toBe(PROMPT_VERSION);
    expect(index.clipVariant).toBe("default");
    expect(index.maxAdjust).toBe(CLIP_VARIANTS.default.maxAdjust);
    expect(index.caseIdSeed).toBe(CASE_ID_SEED);
    expect(index.gitCommit).toBe("abc123");
    expect(index.entries.map((e) => e.raceId)).toEqual(["202603020211", "202654071210"]);
    for (const e of index.entries) {
      const text = s.repoPrompts.get(e.raceId)!;
      expect(text.length).toBeGreaterThan(1000);
      expect(e.promptChars).toBe(text.length);
      expect(e.promptSha256).toBe(sha256Hex(text));
    }
    // production の入力と同じ: プロンプトはレース名・出走馬・指示を含み、許容幅は ±10%。
    const central = s.repoPrompts.get("202603020211")!;
    expect(central).toContain("ラジオNIKKEI賞");
    expect(central).toContain("絶対値0.10");
    // 独立の参照: 同じ入力で runAnalysis を駆動して捕まえた BuildPromptInput から buildPrompt した文字列と一致する。
    let captured: BuildPromptInput | null = null;
    const raw = RAW.get("202603020211")!;
    await driveRunAnalysis(
      {
        raceId: "202603020211",
        kaisaiDate: "20260628",
        raceData: raw.raceData,
        resultHtml: raw.resultHtml,
        resultHtmlOf: () => undefined,
        gradeFetcher: { fetchText: async () => GRADE_BODY },
      },
      async (input) => {
        captured = input;
        return { horses: [], fallback: true, retryCount: 0, fallbackReason: "捕捉のみ" };
      },
    );
    expect(captured).not.toBeNull();
    expect(central).toBe(buildPrompt(captured as unknown as BuildPromptInput));
  });

  it("サブエージェント用のファイルは匿名のケース ID で書き、中身はリポジトリ側のプロンプトと同一", async () => {
    const s = setup();
    const index = await buildPromptArtifacts(TARGETS, s.deps, { gitCommit: "abc123" });
    expect(s.subagentPrompts.size).toBe(2);
    for (const e of index.entries) {
      expect(e.caseId).toMatch(/^case-\d{2}$/);
      expect(s.subagentPrompts.get(e.caseId)).toBe(s.repoPrompts.get(e.raceId));
    }
    expect(new Set(index.entries.map((e) => e.caseId)).size).toBe(2);
    // サブエージェントに見せる側にレース ID を含むキーは無い。
    for (const key of s.subagentPrompts.keys()) {
      expect(key).not.toMatch(/[0-9]{12}/);
    }
  });

  it("重賞バッジのあるレースだけ重賞の過去結果を取りに行く(対応表に記録する)", async () => {
    const s = setup();
    const index = await buildPromptArtifacts(TARGETS, s.deps, { gitCommit: "x" });
    expect(s.gradeCalls).toEqual(["202603020211"]);
    expect(index.entries.find((e) => e.raceId === "202603020211")!.gradeWinnerFetched).toBe(true);
    expect(index.entries.find((e) => e.raceId === "202654071210")!.gradeWinnerFetched).toBe(false);
    expect(s.repoPrompts.get("202603020211")!).toContain("同レース過去傾向");
    expect(s.repoPrompts.get("202654071210")!).not.toContain("同レース過去傾向");
  });

  it("対応表の地域・実レース日は入力の対象から転記する", async () => {
    const s = setup();
    const index = await buildPromptArtifacts(TARGETS, s.deps, { gitCommit: "x" });
    const e = index.entries.find((x) => x.raceId === "202654071210")!;
    expect(e.region).toBe("nar");
    expect(e.kaisaiDate).toBe("20260712");
  });
});

describe("buildPromptArtifacts: 失敗は黙らせない", () => {
  it("重賞の過去結果の取得が失敗したら、プロンプトを書かずに失敗する(production は黙って null にするが、計測では黙らせない)", async () => {
    const s = setup({ fetchText: async () => { throw new Error("HTTP 500"); } });
    await expect(buildPromptArtifacts(TARGETS, s.deps, { gitCommit: "x" })).rejects.toThrow(/202603020211.*HTTP 500/);
    expect(s.repoPrompts.has("202603020211")).toBe(false);
    expect(s.subagentPrompts.size).toBe(0);
  });

  it("対象が重複していれば失敗する", async () => {
    const s = setup();
    await expect(buildPromptArtifacts([...TARGETS, TARGETS[0]!], s.deps, { gitCommit: "x" })).rejects.toThrow(/重複/);
  });
});
