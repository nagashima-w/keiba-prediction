import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPrompt,
  PROMPT_VERSION,
  type BuildPromptInput,
  type GradeWinnerFetcher,
  type RaceData,
} from "../../packages/core/src/index.js";
import {
  createRecordedGradeFetcher,
} from "../probability-quality-41-llm/grade-recorder.js";
import { driveRunAnalysis, type DriveInput } from "../probability-quality-41-llm/drive.js";
import { applyRace, type ApplyInput } from "../probability-quality-41-llm/apply.js";
import { sha256Hex } from "../probability-quality-41-llm/records.js";

/**
 * 段階3の適用(`applyRace`)と、重賞過去結果の記録・再生フェッチャ(`createRecordedGradeFetcher`)を
 * 保存済みフィクスチャでオフラインに検証する。応答は合成(サブエージェントの出力の代わり)。
 * 対象は地方12頭(raceId=202654071210・実レース日 2026/07/12・重賞バッジなし)。
 */

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8")) as T;
}
function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");
}

const RAW = loadJson<RaceData>("../../docs/investigations/combo-odds-real-fetch/nar-on.json");
const RESULT_HTML = loadFixture("nar_result_202654071210.html");
const RACE_ID = "202654071210";
const NO_GRADE: GradeWinnerFetcher = {
  fetchText: async () => {
    throw new Error("呼ばれない想定(重賞バッジなし)");
  },
};

const driveInput: DriveInput = {
  raceId: RACE_ID,
  kaisaiDate: "20260712",
  raceData: RAW,
  resultHtml: RESULT_HTML,
  resultHtmlOf: () => undefined,
  gradeFetcher: NO_GRADE,
};

/** 段階1と同じ経路でプロンプトと prior を作る(応答の合成と、照合の期待値に使う)。 */
async function capture(): Promise<{ input: BuildPromptInput; prompt: string; priors: Map<number, number> }> {
  let captured: BuildPromptInput | null = null;
  await driveRunAnalysis(driveInput, async (input) => {
    captured = input;
    return { horses: [], fallback: true, retryCount: 0, fallbackReason: "捕捉のみ" };
  });
  const input = captured as BuildPromptInput | null;
  if (input === null) throw new Error("前提: プロンプト入力を捕まえられなかった");
  return {
    input,
    prompt: buildPrompt(input),
    priors: new Map(input.horses.map((h) => [h.umaban, h.prior])),
  };
}

/** 馬番→補正量(prior への加算)。◎は先頭の馬番に付ける。 */
function responseText(
  priors: ReadonlyMap<number, number>,
  deltas: ReadonlyMap<number, number>,
  marks: ReadonlyMap<number, string> = new Map([[1, "◎"]]),
): string {
  const horses = [...priors].map(([umaban, prior]) => ({
    number: umaban,
    place_prob: Math.min(1, Math.max(0, prior + (deltas.get(umaban) ?? 0))),
    reason: `馬番${umaban}の根拠(3着内率から補正)`,
    mark: marks.get(umaban) ?? null,
  }));
  return JSON.stringify({ horses });
}

async function makeInput(
  attempts: ReadonlyArray<string | undefined>,
  over: Partial<ApplyInput> = {},
): Promise<ApplyInput> {
  const cap = await capture();
  return {
    drive: driveInput,
    caseId: "case-07",
    promptSha256: sha256Hex(cap.prompt),
    observedPriors: cap.priors,
    readAttempt: (n) => attempts[n - 1],
    ...over,
  };
}

describe("applyRace: 応答を production の analyzeRace に通して補正後確率を作る", () => {
  it("正常な応答: 補正後確率は prior±0.10 にクリップされ、クリップ・prior 採用・印の情報を record に残す", async () => {
    const cap = await capture();
    const deltas = new Map<number, number>([[1, 0.2], [2, -0.2], [3, 0.04], [4, -0.03]]);
    const out = await applyRace(await makeInput([responseText(cap.priors, deltas)]));
    expect(out.status).toBe("final");
    if (out.status !== "final") throw new Error("前提");
    const r = out.record;
    expect(r.raceId).toBe(RACE_ID);
    expect(r.caseId).toBe("case-07");
    expect(r.promptVersion).toBe(PROMPT_VERSION);
    expect(r.maxAdjust).toBe(0.1);
    expect(r.fallback).toBe(false);
    expect(r.attempts).toBe(1);
    expect(r.retryCount).toBe(0);
    expect(r.horses).toHaveLength(12);
    const h = (n: number) => r.horses.find((x) => x.umaban === n)!;
    // クリップ: +0.2 → +0.10、-0.2 → -0.10(prior が 0.10 以上なら下限で止まる)。
    expect(h(1).adjustedProb).toBeCloseTo(Math.min(1, cap.priors.get(1)! + 0.1), 12);
    expect(h(1).clipped).toBe(true);
    expect(h(2).clipped).toBe(true);
    expect(h(2).adjustedProb).toBeCloseTo(Math.max(0, cap.priors.get(2)! - 0.1), 12);
    expect(h(3).clipped).toBe(false);
    expect(h(3).adjustedProb).toBeCloseTo(cap.priors.get(3)! + 0.04, 12);
    expect(h(4).adjustedProb).toBeCloseTo(cap.priors.get(4)! - 0.03, 12);
    expect(h(1).mark).toBe("◎");
    expect(h(5).mark).toBeNull();
    // 補正量が実際に0でない(クリップ・補正が自明に成立していない)。
    expect(Math.abs(h(3).adjustedProb - h(3).prior)).toBeGreaterThan(0.03);
    // prior は段階1の prior(runAnalysis の出力)と一致する。
    for (const x of r.horses) expect(x.prior).toBe(cap.priors.get(x.umaban));
  });

  it("record は応答ファイルの SHA-256 を試行の数だけ持つ", async () => {
    const cap = await capture();
    const text = responseText(cap.priors, new Map([[3, 0.02]]));
    const out = await applyRace(await makeInput([text]));
    if (out.status !== "final") throw new Error("前提");
    expect(out.record.responseSha256).toEqual([sha256Hex(text)]);
    expect(out.record.promptSha256).toBe(sha256Hex(cap.prompt));
  });

  it("1回目が JSON として壊れ、2回目が正常なら、2回目を採用する(retryCount=1・attempts=2)", async () => {
    const cap = await capture();
    const good = responseText(cap.priors, new Map([[3, 0.05]]));
    const out = await applyRace(await makeInput(["これは JSON ではありません", good]));
    if (out.status !== "final") throw new Error("前提");
    expect(out.record.fallback).toBe(false);
    expect(out.record.retryCount).toBe(1);
    expect(out.record.attempts).toBe(2);
    expect(out.record.responseSha256).toEqual([sha256Hex("これは JSON ではありません"), sha256Hex(good)]);
    expect(out.record.horses.find((x) => x.umaban === 3)!.adjustedProb).toBeCloseTo(cap.priors.get(3)! + 0.05, 12);
  });

  it("2回とも壊れていれば production どおり prior に fallback する(補正後=prior・fallbackReason あり)", async () => {
    const out = await applyRace(await makeInput(["壊れ1", "壊れ2"]));
    if (out.status !== "final") throw new Error("前提");
    expect(out.record.fallback).toBe(true);
    expect(out.record.fallbackReason).not.toBeNull();
    expect(out.record.attempts).toBe(2);
    expect(out.record.horses).toHaveLength(12);
    for (const x of out.record.horses) {
      expect(x.adjustedProb).toBe(x.prior);
      expect(x.usedPrior).toBe(true);
    }
  });

  it("印の制約違反(◎が2頭)が2回続くと、確率補正は採用し印だけ全馬 null にする(marksDropped)", async () => {
    const cap = await capture();
    const marks = new Map([[1, "◎"], [2, "◎"]]);
    const bad = responseText(cap.priors, new Map([[3, 0.05]]), marks);
    const out = await applyRace(await makeInput([bad, bad]));
    if (out.status !== "final") throw new Error("前提");
    expect(out.record.fallback).toBe(false);
    expect(out.record.marksDropped).toBe(true);
    expect(out.record.horses.every((x) => x.mark === null)).toBe(true);
    expect(out.record.horses.find((x) => x.umaban === 3)!.adjustedProb).toBeCloseTo(cap.priors.get(3)! + 0.05, 12);
  });
});

describe("applyRace: 応答が揃っていないとき(pending。集計に進ませない)", () => {
  it("1回目の応答が無ければ missingAttempt=1", async () => {
    const out = await applyRace(await makeInput([]));
    expect(out).toEqual({ status: "pending", missingAttempt: 1 });
  });

  it("1回目が壊れていて2回目が無ければ missingAttempt=2(リトライ用の応答が必要)", async () => {
    const out = await applyRace(await makeInput(["壊れた応答"]));
    expect(out).toEqual({ status: "pending", missingAttempt: 2 });
  });

  it("1回目が正常なら2回目が無くても final(2回目は要らない)", async () => {
    const cap = await capture();
    const out = await applyRace(await makeInput([responseText(cap.priors, new Map())]));
    expect(out.status).toBe("final");
  });
});

describe("applyRace: 整合性の検証(食い違えば失敗する)", () => {
  it("段階3で組み立てたプロンプトの SHA-256 が段階1の記録と違えば失敗する", async () => {
    const cap = await capture();
    const input = await makeInput([responseText(cap.priors, new Map())], { promptSha256: sha256Hex("別のプロンプト") });
    await expect(applyRace(input)).rejects.toThrow(/プロンプト.*一致しない/);
  });

  it("prior が #41 の観測と食い違えば失敗する", async () => {
    const cap = await capture();
    const shifted = new Map(cap.priors);
    shifted.set(3, cap.priors.get(3)! + 0.01);
    const input = await makeInput([responseText(cap.priors, new Map())], { observedPriors: shifted });
    await expect(applyRace(input)).rejects.toThrow(/prior.*食い違/);
  });

  it("馬番の集合が #41 の観測と違えば失敗する", async () => {
    const cap = await capture();
    const fewer = new Map(cap.priors);
    fewer.delete(12);
    const input = await makeInput([responseText(cap.priors, new Map())], { observedPriors: fewer });
    await expect(applyRace(input)).rejects.toThrow(/馬番/);
  });

  it("重賞の過去結果が再生できず(応答の記録が無い)プロンプトが変わる場合も、黙って進まない", async () => {
    // バッジありのレース相当: 出馬表の hasGradeBadge を立て、再生用の応答ファイルが無い状態にする。
    const cap = await capture();
    const badged: DriveInput = {
      ...driveInput,
      raceData: { ...RAW, race: { ...RAW.race, hasGradeBadge: true } },
      gradeFetcher: { fetchText: async () => { throw new Error("記録がありません"); } },
    };
    const input = await makeInput([responseText(cap.priors, new Map())], { drive: badged });
    await expect(applyRace(input)).rejects.toThrow(/重賞の過去結果|記録がありません/);
  });
});

describe("createRecordedGradeFetcher: 記録と再生", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(path.join(tmpdir(), "pq41llm-"));
    dirs.push(d);
    return d;
  }

  it("記録が無ければネットワークから取得して生の応答を保存し、2回目はネットワークを使わず保存分を返す", async () => {
    const dir = tmp();
    let calls = 0;
    const okBody = loadFixture("grade_winner_202603020211.json");
    const network: GradeWinnerFetcher = { fetchText: async () => { calls += 1; return okBody; } };
    const f1 = createRecordedGradeFetcher({ dir, raceId: "202603020211", network });
    expect(await f1.fetchText("https://example/api", { method: "POST" })).toBe(okBody);
    expect(calls).toBe(1);
    expect(readFileSync(path.join(dir, "202603020211.json"), "utf-8")).toBe(okBody);

    const f2 = createRecordedGradeFetcher({ dir, raceId: "202603020211", network });
    expect(await f2.fetchText("https://example/api")).toBe(okBody);
    expect(calls).toBe(1);
  });

  it("network が null(再生専用)で記録が無ければ、ネットワークに出ずに失敗する", async () => {
    const dir = tmp();
    const f = createRecordedGradeFetcher({ dir, raceId: "202603020211", network: null });
    await expect(f.fetchText("https://example/api")).rejects.toThrow(/記録がありません/);
  });

  it("非重賞の応答(status: NG)は正常な応答として保存する(null になるだけで、取り直す必要はない)", async () => {
    const dir = tmp();
    const ng = loadFixture("grade_winner_ng_202602010607.json");
    const network: GradeWinnerFetcher = { fetchText: async () => ng };
    const f = createRecordedGradeFetcher({ dir, raceId: "202602010607", network });
    expect(await f.fetchText("https://example/api")).toBe(ng);
    expect(readFileSync(path.join(dir, "202602010607.json"), "utf-8")).toBe(ng);
  });

  it("応答がパースできない(HTML・構造の壊れた応答)ときは、保存せずに失敗する(壊れた応答を記録しない)", async () => {
    for (const broken of ["<html>メンテナンス中</html>", '{"status":"OK"}', ""]) {
      const dir = tmp();
      const network: GradeWinnerFetcher = { fetchText: async () => broken };
      const f = createRecordedGradeFetcher({ dir, raceId: "202603020211", network });
      await expect(f.fetchText("https://example/api")).rejects.toThrow();
      expect(existsSync(path.join(dir, "202603020211.json"))).toBe(false);
    }
  });

  it("ネットワーク取得が失敗したときは何も保存しない(壊れた記録を残さない)", async () => {
    const dir = tmp();
    const network: GradeWinnerFetcher = { fetchText: async () => { throw new Error("HTTP 500"); } };
    const f = createRecordedGradeFetcher({ dir, raceId: "202603020211", network });
    await expect(f.fetchText("https://example/api")).rejects.toThrow("HTTP 500");
    expect(existsSync(path.join(dir, "202603020211.json"))).toBe(false);
  });
});
