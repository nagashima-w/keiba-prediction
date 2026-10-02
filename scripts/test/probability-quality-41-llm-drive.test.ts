import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  CLIP_VARIANTS,
  parseKaisaiDate,
  parseRaceResult,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type GradeWinnerFetcher,
  type RaceData,
} from "../../packages/core/src/index.js";
import { runAnalysis } from "../../packages/app/src/main/analysis-pipeline.js";
import { assignCaseIds, CASE_ID_SEED } from "../probability-quality-41-llm/case-ids.js";
import { buildRaceResultDetail, driveRunAnalysis, type DriveInput } from "../probability-quality-41-llm/drive.js";
import { FileLlmClient } from "../probability-quality-41-llm/file-llm-client.js";

/**
 * #156(#41-B)段階1・3 の共通部(`driveRunAnalysis`)・ファイル版 LLM クライアント・匿名ケース ID を、
 * 保存済みフィクスチャでオフラインに検証する(実サイトへのリクエストは含まない)。
 * 中央16頭(raceId=202603020211・福島・実レース日 2026/06/28・重賞バッジあり・確定オッズ)と、
 * 地方12頭(raceId=202654071210・実レース日 2026/07/12・重賞バッジなし)。
 */

function loadRaceData(name: string): RaceData {
  const url = new URL(`../../docs/investigations/combo-odds-real-fetch/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as RaceData;
}
function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");
}

const CENTRAL = {
  raceId: "202603020211",
  kaisaiDate: "20260628",
  raceData: loadRaceData("central-on.json"),
  resultHtml: loadFixture("result_202603020211.html"),
};
const NAR = {
  raceId: "202654071210",
  kaisaiDate: "20260712",
  raceData: loadRaceData("nar-on.json"),
  resultHtml: loadFixture("nar_result_202654071210.html"),
};
const GRADE_BODY = loadFixture("grade_winner_202603020211.json");

/** プロンプトを捕まえるだけの analyze(production の deps.analyze と同じ形)。 */
function capturing(): {
  analyze: (input: BuildPromptInput) => Promise<AnalyzeRaceResult>;
  inputs: BuildPromptInput[];
} {
  const inputs: BuildPromptInput[] = [];
  return {
    inputs,
    analyze: async (input) => {
      inputs.push(input);
      return { horses: [], fallback: true, retryCount: 0, fallbackReason: "捕捉のみ" };
    },
  };
}

/** 呼び出しを記録するグレード用フェッチャ。 */
function gradeFetcher(body: string | Error): { fetcher: GradeWinnerFetcher; calls: Array<{ url: string; cacheKey?: string; method?: string }> } {
  const calls: Array<{ url: string; cacheKey?: string; method?: string }> = [];
  return {
    calls,
    fetcher: {
      fetchText: async (url, options) => {
        calls.push({ url, cacheKey: options?.cacheKey, method: options?.method });
        if (body instanceof Error) throw body;
        return body;
      },
    },
  };
}

function baseInput(fx: typeof CENTRAL, over: Partial<DriveInput> = {}): DriveInput {
  return {
    raceId: fx.raceId,
    kaisaiDate: fx.kaisaiDate,
    raceData: fx.raceData,
    resultHtml: fx.resultHtml,
    resultHtmlOf: () => undefined,
    gradeFetcher: gradeFetcher(new Error("呼ばれない想定")).fetcher,
    ...over,
  };
}

describe("driveRunAnalysis: production の runAnalysis と同じプロンプト入力", () => {
  it("analyze は BuildPromptInput を1回受け取り、各馬の prior は LLM なしの runAnalysis の出力と一致する", async () => {
    const cap = capturing();
    const out = await driveRunAnalysis(baseInput(NAR), cap.analyze);
    expect(cap.inputs).toHaveLength(1);
    const reference = await runAnalysis(
      NAR.raceData.raceId,
      parseKaisaiDate(NAR.kaisaiDate),
      { scrape: async () => NAR.raceData, analyze: null, saveAnalysis: () => 0, allocationSettings: null },
    );
    expect(reference.rows).toHaveLength(12);
    expect(cap.inputs[0]!.horses).toHaveLength(12);
    for (const h of cap.inputs[0]!.horses) {
      expect(h.prior).toBe(reference.rows.find((r) => r.umaban === h.umaban)!.prior);
    }
    expect(out.analysis.dateApproximate).toBe(false);
    expect(out.classification.runners).toHaveLength(12);
  });

  it("clipVariant は production の既定(default・±10%)で、追加指示は注入されない", async () => {
    const cap = capturing();
    await driveRunAnalysis(baseInput(NAR), cap.analyze);
    const input = cap.inputs[0]!;
    expect(input.clipVariant).toBe("default");
    expect(input.additionalInstruction).toBeUndefined();
    const prompt = buildPrompt(input);
    expect(prompt).toContain("絶対値0.10");
    expect(prompt).not.toContain("追加指示");
    expect(CLIP_VARIANTS.default.maxAdjust).toBe(0.1);
  });
});

describe("driveRunAnalysis: 同日傾向は自レースより前のレースだけを使う", () => {
  it("問い合わせるのは同じ日・同じ会場の自レース番号より小さい01〜10だけ(自レース・後続の12は問い合わせない)", async () => {
    const cap = capturing();
    const asked: string[] = [];
    const out = await driveRunAnalysis(
      baseInput(CENTRAL, {
        resultHtmlOf: (rid) => {
          asked.push(rid);
          return undefined;
        },
        gradeFetcher: gradeFetcher(GRADE_BODY).fetcher,
      }),
      cap.analyze,
    );
    const expected = Array.from({ length: 10 }, (_, i) => `2026030202${String(i + 1).padStart(2, "0")}`);
    expect(out.resultDetailLookups).toEqual(expected);
    expect(asked).toEqual(expected);
    expect(asked).not.toContain("202603020211");
    expect(asked).not.toContain("202603020212");
  });

  it("先行レースの結果ページがあれば、同日傾向がプロンプトに入る(無ければ入らない)", async () => {
    const withPreceding = capturing();
    await driveRunAnalysis(
      baseInput(CENTRAL, {
        // 前提: 自レースと同じ面(芝)の確定結果を先行レースとして与える。
        resultHtmlOf: (rid) => (rid <= "202603020210" ? CENTRAL.resultHtml : undefined),
        gradeFetcher: gradeFetcher(GRADE_BODY).fetcher,
      }),
      withPreceding.analyze,
    );
    expect(buildPrompt(withPreceding.inputs[0]!)).toContain("当日の同場・同面傾向");

    const without = capturing();
    await driveRunAnalysis(baseInput(CENTRAL, { gradeFetcher: gradeFetcher(GRADE_BODY).fetcher }), without.analyze);
    expect(buildPrompt(without.inputs[0]!)).not.toContain("当日の同場・同面傾向");
  });

  it("buildRaceResultDetail は取込(toResultEntries)と同じ形(馬番昇順・着順は数値のみ・通過順と上がり3F)", () => {
    const detail = buildRaceResultDetail(CENTRAL.resultHtml);
    expect(detail).toBeDefined();
    const parsed = parseRaceResult(CENTRAL.resultHtml);
    expect(detail!.courseType).toBe(parsed.courseType ?? null);
    expect(detail!.horses).toHaveLength(parsed.horses.length);
    const umabans = detail!.horses.map((h) => h.umaban);
    expect(umabans).toEqual([...umabans].sort((a, b) => a - b));
    const winner = parsed.horses.find((h) => h.finishPosition?.kind === "順位" && h.finishPosition.value === 1)!;
    expect(detail!.horses.find((h) => h.umaban === winner.umaban)!.finishPosition).toBe(1);
    expect(detail!.horses.some((h) => h.passing.length > 0)).toBe(true);
    expect(detail!.horses.some((h) => h.last3f !== null)).toBe(true);
  });
});

describe("driveRunAnalysis: 重賞の過去結果(バッジありのレースだけ・cutoff は分析日)", () => {
  it("バッジあり(中央)は AplGradeWinner を1回 POST し、取得できた傾向がプロンプトに入る", async () => {
    const cap = capturing();
    const g = gradeFetcher(GRADE_BODY);
    await driveRunAnalysis(baseInput(CENTRAL, { gradeFetcher: g.fetcher }), cap.analyze);
    expect(CENTRAL.raceData.race.hasGradeBadge).toBe(true);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.method).toBe("POST");
    expect(g.calls[0]!.cacheKey).toBe("race_api#AplGradeWinner#202603020211");
    expect(buildPrompt(cap.inputs[0]!)).toContain("同レース過去傾向");
  });

  it("バッジなし(地方)は問い合わせない", async () => {
    const cap = capturing();
    const g = gradeFetcher(new Error("呼ばれない想定"));
    await driveRunAnalysis(baseInput(NAR, { gradeFetcher: g.fetcher }), cap.analyze);
    expect(NAR.raceData.race.hasGradeBadge).toBe(false);
    expect(g.calls).toHaveLength(0);
    expect(buildPrompt(cap.inputs[0]!)).not.toContain("同レース過去傾向");
  });

  it("取得が失敗しても分析は続く(null)が、失敗は gradeWinnerErrors に残り黙らせない", async () => {
    const cap = capturing();
    const g = gradeFetcher(new Error("接続できません"));
    const out = await driveRunAnalysis(baseInput(CENTRAL, { gradeFetcher: g.fetcher }), cap.analyze);
    expect(g.calls).toHaveLength(1);
    expect(out.gradeWinnerErrors).toEqual([{ raceId: "202603020211", message: "接続できません" }]);
    expect(buildPrompt(cap.inputs[0]!)).not.toContain("同レース過去傾向");
  });

  it("基準日(cutoff)より後の回は集計に入らない: 分析日を過去にずらすと対象回数が減る", async () => {
    const early = capturing();
    const late = capturing();
    await driveRunAnalysis(baseInput(CENTRAL, { gradeFetcher: gradeFetcher(GRADE_BODY).fetcher }), late.analyze);
    // 実レース日を大きく過去(2015/06/28)にして、同じ応答を再生する。
    await driveRunAnalysis(
      baseInput(CENTRAL, { kaisaiDate: "20150628", gradeFetcher: gradeFetcher(GRADE_BODY).fetcher }),
      early.analyze,
    );
    const nOf = (p: string): number | null => {
      const m = /同レース過去傾向\(対象(\d+)回/.exec(p);
      return m === null ? null : Number(m[1]);
    };
    const lateN = nOf(buildPrompt(late.inputs[0]!));
    expect(lateN).not.toBeNull();
    const earlyN = nOf(buildPrompt(early.inputs[0]!));
    // 古い基準日では対象回が減る(減って3回未満なら null=節なしでも「減った」ことを表す)。
    expect(earlyN === null || earlyN < lateN!).toBe(true);
  });
});

describe("driveRunAnalysis: 取消・除外の馬と異常", () => {
  it("結果ページで取消の馬は出走馬から除かれ、プロンプトの出走馬にも入らない", async () => {
    // 結果の馬番2を「取消」にした HTML は作れないため、パース済み結果を差し替える代わりに、
    // 出馬表に結果へいない馬を足すのではなく、結果側の着順文言を書き換える。
    const html = CENTRAL.resultHtml;
    const parsed = parseRaceResult(html);
    const target = parsed.horses.find((h) => h.umaban === 2)!;
    expect(target.finishPosition).not.toBeNull();
    // 着順セルの文言を取消へ置換(結果ページの該当行の着順セル)。
    const rewritten = replaceFinishWithScratched(html, 2);
    const cap = capturing();
    const out = await driveRunAnalysis({ ...baseInput(CENTRAL), resultHtml: rewritten, gradeFetcher: gradeFetcher(GRADE_BODY).fetcher }, cap.analyze);
    expect(out.classification.scratched.map((s) => s.umaban)).toEqual([2]);
    expect(out.runnerRace.horses).toHaveLength(15);
    expect(cap.inputs[0]!.horses).toHaveLength(15);
    expect(cap.inputs[0]!.horses.some((h) => h.umaban === 2)).toBe(false);
  });

  it("着順を分類できない結果ページでは失敗する(黙って進まない)", async () => {
    const cap = capturing();
    const html = CENTRAL.resultHtml;
    const bad = replaceFinishWithText(html, 2, "謎文言");
    await expect(
      driveRunAnalysis({ ...baseInput(CENTRAL), resultHtml: bad, gradeFetcher: gradeFetcher(GRADE_BODY).fetcher }, cap.analyze),
    ).rejects.toThrow(/着順を分類できない/);
    expect(cap.inputs).toHaveLength(0);
  });
});

describe("FileLlmClient: N 回目の complete は attemptN の内容を返し、未生成は記録する", () => {
  it("N 回目の応答を順に返し、渡されたプロンプトを記録する", async () => {
    const texts = new Map<number, string>([[1, "一回目"], [2, "二回目"]]);
    const c = new FileLlmClient((n) => texts.get(n));
    expect(await c.complete("P")).toBe("一回目");
    expect(await c.complete("P")).toBe("二回目");
    expect(c.prompts).toEqual(["P", "P"]);
    expect(c.missingAttempt).toBeNull();
  });

  it("1回目が無ければ missingAttempt=1(例外は投げない)", async () => {
    const c = new FileLlmClient(() => undefined);
    await expect(c.complete("P")).resolves.toBe("");
    await expect(c.complete("P")).resolves.toBe("");
    expect(c.missingAttempt).toBe(1);
  });

  it("2回目だけ無ければ missingAttempt=2(1回目は返る)", async () => {
    const c = new FileLlmClient((n) => (n === 1 ? "x" : undefined));
    expect(await c.complete("P")).toBe("x");
    expect(c.missingAttempt).toBeNull();
    expect(await c.complete("P")).toBe("");
    expect(c.missingAttempt).toBe(2);
  });
});

describe("assignCaseIds: 匿名ケース ID", () => {
  const ids = ["202606040801", "202606040802", "202630093001", "202630093002", "202606040901"];

  it("全レースに重複なく case-01〜case-05 を割り当て、入力の並びに依らず同じ結果になる", () => {
    const a = assignCaseIds(ids);
    const b = assignCaseIds([...ids].reverse());
    expect([...a.values()].sort()).toEqual(["case-01", "case-02", "case-03", "case-04", "case-05"]);
    const byId = (m: Map<string, string>) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    expect(byId(a)).toEqual(byId(b));
    expect(new Set(a.values()).size).toBe(5);
  });

  it("レース ID の昇順をそのまま番号にしない(日付・会場の並びが番号から読めない)", () => {
    const map = assignCaseIds(ids);
    const inOrder = [...ids].sort().map((id) => map.get(id));
    expect(inOrder).not.toEqual(["case-01", "case-02", "case-03", "case-04", "case-05"]);
  });

  it("シードを変えると割り当てが変わり、既定シードは固定値", () => {
    expect(CASE_ID_SEED).toBe(20261002);
    expect([...assignCaseIds(ids, 1)]).not.toEqual([...assignCaseIds(ids, 2)]);
  });

  it("36件では桁が足りる(case-01〜case-36)", () => {
    const many = Array.from({ length: 36 }, (_, i) => `2026060408${String(i).padStart(2, "0")}`);
    const m = assignCaseIds(many);
    expect(new Set(m.values()).size).toBe(36);
    expect(m.get(many[0]!)).toMatch(/^case-\d{2}$/);
  });
});

// ---- テスト補助: 結果ページ HTML の着順セルの書き換え ----------------------------------------

/**
 * 結果ページ HTML の指定馬番の着順セルを書き換える。実 HTML の構造は parse-result.ts のセレクタに依る
 * ため、書き換え後に parseRaceResult で意図どおりになったことを確かめる。
 */
function replaceFinishWithScratched(html: string, umaban: number): string {
  return replaceFinishWithText(html, umaban, "取消");
}
function replaceFinishWithText(html: string, umaban: number, text: string): string {
  const parsed = parseRaceResult(html);
  const horse = parsed.horses.find((h) => h.umaban === umaban)!;
  expect(horse.finishPosition?.kind).toBe("順位");
  const finish = horse.finishPosition!.kind === "順位" ? horse.finishPosition!.value : 0;
  // 着順セル(`<div class="Rank">N</div>`)のうち、対象行(馬番セルが一致する行)のものを置換する。
  const rows = html.split(/(?=<tr[^>]*class="HorseList")/);
  let replaced = false;
  const out = rows.map((row) => {
    if (replaced) return row;
    const m = /<td class="Num Txt_C">\s*<div>(\d+)<\/div>/g;
    const nums = [...row.matchAll(m)].map((x) => Number(x[1]));
    if (nums.includes(umaban) && new RegExp(`<div class="Rank">\\s*${finish}\\s*</div>`).test(row)) {
      replaced = true;
      return row.replace(new RegExp(`(<div class="Rank">)\\s*${finish}\\s*(</div>)`), `$1${text}$2`);
    }
    return row;
  });
  expect(replaced).toBe(true);
  const reparsed = parseRaceResult(out.join(""));
  const h2 = reparsed.horses.find((h) => h.umaban === umaban)!;
  expect(h2.finishPosition).toEqual({ kind: "非数値", text });
  return out.join("");
}
