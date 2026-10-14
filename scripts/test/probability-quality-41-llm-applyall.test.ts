import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPrompt, type BuildPromptInput, type RaceData } from "../../packages/core/src/index.js";
import { applyAll, type ApplyAllDeps } from "../probability-quality-41-llm/apply-all.js";
import { driveRunAnalysis } from "../probability-quality-41-llm/drive.js";
import { sha256Hex, type CaseIndexEntry, type LlmRaceRecord } from "../probability-quality-41-llm/records.js";

/**
 * 段階3の全レース適用(`applyAll`)を保存済みフィクスチャでオフラインに検証する。
 * 地方12頭(raceId=202654071210・バッジなし)と中央16頭(raceId=202603020211・バッジあり)。
 */

function loadRaw(name: string): RaceData {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../docs/investigations/combo-odds-real-fetch/${name}`, import.meta.url)), "utf-8")) as RaceData;
}
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");
}

const RAW = new Map([
  ["202603020211", { raceData: loadRaw("central-on.json"), resultHtml: fixture("result_202603020211.html"), kaisaiDate: "20260628" }],
  ["202654071210", { raceData: loadRaw("nar-on.json"), resultHtml: fixture("nar_result_202654071210.html"), kaisaiDate: "20260712" }],
]);
const GRADE_BODY = fixture("grade_winner_202603020211.json");

async function promptAndPriors(raceId: string): Promise<{ prompt: string; priors: Map<number, number> }> {
  const raw = RAW.get(raceId)!;
  let captured: BuildPromptInput | null = null;
  await driveRunAnalysis(
    { raceId, kaisaiDate: raw.kaisaiDate, raceData: raw.raceData, resultHtml: raw.resultHtml, resultHtmlOf: () => undefined, gradeFetcher: { fetchText: async () => GRADE_BODY } },
    async (input) => {
      captured = input;
      return { horses: [], fallback: true, retryCount: 0, fallbackReason: "x" };
    },
  );
  const input = captured as unknown as BuildPromptInput;
  return { prompt: buildPrompt(input), priors: new Map(input.horses.map((h) => [h.umaban, h.prior])) };
}

function responseFor(priors: ReadonlyMap<number, number>): string {
  return JSON.stringify({
    horses: [...priors].map(([umaban, prior]) => ({
      number: umaban,
      place_prob: prior + 0.01,
      reason: "根拠(3着内率から補正)",
      mark: umaban === 1 ? "◎" : null,
    })),
  });
}

async function setup(responses: Map<string, string>) {
  const central = await promptAndPriors("202603020211");
  const nar = await promptAndPriors("202654071210");
  const entries: CaseIndexEntry[] = [
    { caseId: "case-02", raceId: "202603020211", region: "central", kaisaiDate: "20260628", promptSha256: sha256Hex(central.prompt), promptChars: central.prompt.length, gradeWinnerFetched: true },
    { caseId: "case-01", raceId: "202654071210", region: "nar", kaisaiDate: "20260712", promptSha256: sha256Hex(nar.prompt), promptChars: nar.prompt.length, gradeWinnerFetched: false },
  ];
  const written = new Map<string, LlmRaceRecord>();
  const deps: ApplyAllDeps = {
    loadRaw: (raceId) => RAW.get(raceId)!,
    resultHtmlOf: () => undefined,
    gradeFetcherFor: () => ({ fetchText: async () => GRADE_BODY }),
    readPrompt: (raceId) => (raceId === "202603020211" ? central.prompt : nar.prompt),
    observedPriors: (raceId) => (raceId === "202603020211" ? central.priors : nar.priors),
    readResponse: (caseId, attempt) => responses.get(`${caseId}.attempt${attempt}`),
    writeRecord: (record) => void written.set(record.raceId, record),
  };
  return { entries, deps, written, central, nar };
}

describe("applyAll: 全レースを適用する", () => {
  it("応答が揃ったレースは記録を書き、揃っていないレースは pending に挙げる(記録は書かない)", async () => {
    const nar = await promptAndPriors("202654071210");
    const s = await setup(new Map([["case-01.attempt1", responseFor(nar.priors)]]));
    const r = await applyAll(s.entries, s.deps);
    expect(r.finalRaceIds).toEqual(["202654071210"]);
    expect(r.pending).toEqual([{ caseId: "case-02", raceId: "202603020211", missingAttempt: 1 }]);
    expect([...s.written.keys()]).toEqual(["202654071210"]);
    expect(s.written.get("202654071210")!.caseId).toBe("case-01");
  });

  it("両方の応答があれば pending は空", async () => {
    const nar = await promptAndPriors("202654071210");
    const central = await promptAndPriors("202603020211");
    const s = await setup(new Map([
      ["case-01.attempt1", responseFor(nar.priors)],
      ["case-02.attempt1", responseFor(central.priors)],
    ]));
    const r = await applyAll(s.entries, s.deps);
    expect(r.pending).toEqual([]);
    expect(r.finalRaceIds).toEqual(["202603020211", "202654071210"]);
    expect(s.written.size).toBe(2);
  });

  it("1回目が壊れていて2回目が無いレースは missingAttempt=2 で pending", async () => {
    const nar = await promptAndPriors("202654071210");
    const s = await setup(new Map([["case-01.attempt1", "壊れた"], ["case-02.attempt1", responseFor((await promptAndPriors("202603020211")).priors)]]));
    const r = await applyAll(s.entries, s.deps);
    expect(r.pending).toEqual([{ caseId: "case-01", raceId: "202654071210", missingAttempt: 2 }]);
    expect(nar.priors.size).toBe(12);
  });

  it("対応表のプロンプトの SHA-256 と、リポジトリ側のプロンプトファイルが食い違えば、何も書かずに失敗する", async () => {
    const s = await setup(new Map());
    const bad = s.entries.map((e, i) => (i === 0 ? { ...e, promptSha256: sha256Hex("別物") } : e));
    await expect(applyAll(bad, s.deps)).rejects.toThrow(/202603020211.*SHA-256/);
    expect(s.written.size).toBe(0);
  });
});
