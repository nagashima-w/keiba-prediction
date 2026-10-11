import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AnalysisStore,
  buildPrompt,
  buildPriorInput,
  classifyTrackWetness,
  collectGradeWinnerTrend,
  computeFieldPriors,
  parseGradeWinnerResponse,
  parseKaisaiDate,
  parseRaceId,
  parseRaceResult,
  summarizeGradeWinnerTrend,
  summarizeSameDayTrend,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type HorseRaceResult,
  type RaceData,
  type RaceResult,
} from "@keiba/core";
import type { AnalysisRecord } from "@keiba/core";
import { describe, expect, it, vi } from "vitest";

import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../src/main/analysis-pipeline.js";
import { importRaceResult } from "../src/main/result-import.js";
import type { AnalysisResult } from "../src/shared/analysis-types.js";

/**
 * 先読みリークの遮断(Issue #39)。`runAnalysis` が、分析対象レース自身の走と施行日以降の走を、
 * prior・LLMプロンプト入力・結果行の材料からすべて取り除くことを、実フィクスチャと製品コード
 * (`runAnalysis`)経由で固定する。
 *
 * ## 期待値の作り方(独立オラクル)
 * 遮断の実装(`filterRaceDataBefore`・`excludeOwnRaceResults`)を期待値の計算に使わない。
 * テスト側で生フィクスチャの戦績を「raceIdRaw が自レースでない かつ 日付が施行日より前」という
 * 単純な文字列比較(フィクスチャの日付は全件ゼロ埋めであることを前提として固定する)で
 * 絞った RaceData(`trimmed`)を作り、
 *   - 生フィクスチャで走らせた結果 と `trimmed` で走らせた結果が全項目で一致すること(=製品が
 *     オラクルと同じ絞り込みをしている。かつ、絞り済みの入力に対しては何も変えない〈冪等・
 *     当日運用の no-op〉)
 * を、消費10箇所それぞれについて固定する。加えて走数の減少はリテラルでも固定する。
 *
 * ## 非空振り
 * 「生」と「trimmed」で消費項目の値が実際に異なること(絞った差が0でないこと)を、生の戦績から
 * 直接数えた走数とテスト側の参照 prior(`buildPriorInput`+`computeFieldPriors`)で固定する。
 */

// ---------------------------------------------------------------------------
// フィクスチャと実行ヘルパ
// ---------------------------------------------------------------------------

interface FixtureCase {
  readonly label: string;
  readonly fileName: string;
  /** 実レース日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  /** 生の戦績の総走数。 */
  readonly rawTotal: number;
  /** 当該レース自身の走数(raceIdRaw 一致)。 */
  readonly ownRuns: number;
  /** 施行日より後の走数。 */
  readonly laterRuns: number;
}

const CASES: readonly FixtureCase[] = [
  { label: "中央16頭", fileName: "central-on.json", kaisaiDate: "20260628", rawTotal: 114, ownRuns: 16, laterRuns: 5 },
  { label: "中央18頭", fileName: "central18-on.json", kaisaiDate: "20260808", rawTotal: 282, ownRuns: 18, laterRuns: 10 },
  { label: "地方12頭", fileName: "nar-on.json", kaisaiDate: "20260712", rawTotal: 667, ownRuns: 12, laterRuns: 12 },
];

function loadFixture(fileName: string): RaceData {
  const url = new URL(
    `../../../docs/investigations/combo-odds-real-fetch/${fileName}`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as RaceData;
}

/** YYYYMMDD → YYYY/MM/DD。 */
function toSlash(ymd: string): string {
  return `${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`;
}

/** 全馬の戦績を返す(取得失敗 null は空扱い)。 */
function allRuns(raceData: RaceData): HorseRaceResult[] {
  return raceData.horses.flatMap((h) => h.results ?? []);
}

/**
 * 独立オラクル: 自レースでなく、かつ日付が基準日(YYYY/MM/DD・ゼロ埋め)より前の走だけを残す。
 * 実装の絞り込み関数を使わず、ゼロ埋め済み日付の辞書順比較(フィクスチャがゼロ埋めであることは
 * 別のテストで前提として固定する)で判定する。
 */
function oracleTrim(raceData: RaceData, cutoffSlash: string): RaceData {
  return {
    ...raceData,
    horses: raceData.horses.map((h) => ({
      ...h,
      results:
        h.results === null
          ? null
          : h.results.filter(
              (r) => r.raceIdRaw !== raceData.raceId && r.date !== null && r.date < cutoffSlash,
            ),
    })),
  };
}

interface RunOutput {
  readonly result: AnalysisResult;
  readonly prompt: BuildPromptInput;
  readonly records: AnalysisRecord[];
}

// 実行日の近似(toYmdSlash はローカル時刻の暦日を使う)。タイムゾーンに依らず 2026/09/30 になるようローカル生成する。
const FIXED_NOW = new Date(2026, 8, 30, 12, 0, 0);

/** LLMをフェイクにして(prior をそのまま返す)、プロンプト入力・結果・保存レコードを捕捉する。 */
async function run(
  raceData: RaceData,
  kaisaiDate: string | null,
  extraDeps: Partial<AnalysisPipelineDeps> = {},
): Promise<RunOutput> {
  let prompt: BuildPromptInput | null = null;
  const records: AnalysisRecord[] = [];
  const deps: AnalysisPipelineDeps = {
    ...extraDeps,
    scrape: async () => raceData,
    analyze: async (input): Promise<AnalyzeRaceResult> => {
      prompt = input;
      return {
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: h.prior,
          reason: "テスト",
          highlights: [],
          concerns: [],
          clipped: false,
          usedPrior: true,
          mark: null,
        })),
        fallback: false,
        retryCount: 0,
        fallbackReason: null,
        rawResponse: "",
      };
    },
    saveAnalysis: (rec) => {
      records.push(rec);
      return records.length;
    },
    allocationSettings: null,
    now: () => FIXED_NOW,
  };
  const result = await runAnalysis(
    raceData.raceId,
    kaisaiDate === null ? null : parseKaisaiDate(kaisaiDate),
    deps,
  );
  expect(prompt).not.toBeNull();
  return { result, prompt: prompt!, records };
}

/** LLM未使用(prior採用)で走らせ、保存レコードだけを返す。 */
async function runWithoutLlm(raceData: RaceData, kaisaiDate: string | null): Promise<AnalysisRecord[]> {
  const records: AnalysisRecord[] = [];
  const deps: AnalysisPipelineDeps = {
    scrape: async () => raceData,
    analyze: null,
    saveAnalysis: (rec) => {
      records.push(rec);
      return records.length;
    },
    allocationSettings: null,
    now: () => FIXED_NOW,
  };
  await runAnalysis(raceData.raceId, kaisaiDate === null ? null : parseKaisaiDate(kaisaiDate), deps);
  return records;
}

// ---------------------------------------------------------------------------
// 前提(フィクスチャの実態)の固定
// ---------------------------------------------------------------------------

describe.each(CASES)("先読みリーク遮断の前提: $label", (c) => {
  const raw = loadFixture(c.fileName);
  const cutoff = toSlash(c.kaisaiDate);

  it("フィクスチャの走数・自レースの走数・施行日より後の走数が想定どおりで、日付は全件ゼロ埋めであること", () => {
    const runs = allRuns(raw);
    expect(runs).toHaveLength(c.rawTotal);
    expect(runs.filter((r) => r.raceIdRaw === raw.raceId)).toHaveLength(c.ownRuns);
    expect(runs.filter((r) => r.date !== null && r.date > cutoff)).toHaveLength(c.laterRuns);
    // 辞書順比較のオラクルが成り立つ前提(ゼロ埋め・欠損なし)。
    expect(runs.every((r) => r.date !== null && /^\d{4}\/\d{2}\/\d{2}$/.test(r.date))).toBe(true);
  });

  it("オラクルで絞ると走数が rawTotal − 自レース − 施行日より後 に減る(差が0でない)", () => {
    const trimmed = allRuns(oracleTrim(raw, cutoff));
    expect(c.ownRuns + c.laterRuns).toBeGreaterThan(0);
    expect(trimmed).toHaveLength(c.rawTotal - c.ownRuns - c.laterRuns);
  });
});

it("地方フィクスチャの自レースの走は raceId が null で raceIdRaw にだけ値がある(raceId 比較の実装は地方で効かない)", () => {
  const raw = loadFixture("nar-on.json");
  const own = allRuns(raw).filter((r) => r.raceIdRaw === raw.raceId);
  expect(own).toHaveLength(12);
  expect(own.every((r) => r.raceId === null)).toBe(true);
});

// ---------------------------------------------------------------------------
// 本体: 消費10箇所がすべて絞った戦績を使う
// ---------------------------------------------------------------------------

/** 消費10箇所の観測点。取り出し関数は (プロンプト入力の馬 or 結果行) → 値。 */
const PROMPT_FIELDS = [
  "prior", // 戦績→prior(analysis-pipeline.ts の buildPriorInput への raceResults)
  "runs", // 脚質・ペース傾向の材料
  "runConditions", // 条件替わりの過去走条件(プロンプト側)
  "bodyWeightTrend",
  "marketGap",
  "jockeyChange",
  "marginTrend",
  "restInterval",
] as const;
const ROW_FIELDS = [
  "careerRunCount", // 戦績走数(低データ判定)
  "conditionChangeTags", // 条件替わりタグ(結果行側)
] as const;

describe.each(CASES)("runAnalysis の先読みリーク遮断(kaisaiDate明示): $label", (c) => {
  const raw = loadFixture(c.fileName);
  const cutoff = toSlash(c.kaisaiDate);

  it("結果行の戦績走数の合計が、生の合計から自レース・施行日より後の走を引いた数になる(リテラル固定)", async () => {
    const { result } = await run(raw, c.kaisaiDate);
    const total = result.rows.reduce((a, r) => a + (r.careerRunCount ?? 0), 0);
    expect(total).toBe(c.rawTotal - c.ownRuns - c.laterRuns);
  });

  it("馬ごとの戦績走数が、オラクルで絞った走数と一致する", async () => {
    const { result } = await run(raw, c.kaisaiDate);
    const expected = new Map(
      oracleTrim(raw, cutoff).horses.map((h) => [h.shutuba.umaban, h.results!.length]),
    );
    expect(result.rows).toHaveLength(raw.horses.length);
    for (const row of result.rows) {
      expect(row.careerRunCount).toBe(expected.get(row.umaban));
    }
  });

  it.each(PROMPT_FIELDS)(
    "プロンプト入力の %s が、オラクルで絞った戦績で走らせた結果と全馬で一致する(絞り忘れ・冪等性の固定)",
    async (field) => {
      const dirty = await run(raw, c.kaisaiDate);
      const clean = await run(oracleTrim(raw, cutoff), c.kaisaiDate);
      expect(dirty.prompt.horses).toHaveLength(raw.horses.length);
      expect(dirty.prompt.horses.map((h) => h[field])).toEqual(clean.prompt.horses.map((h) => h[field]));
    },
  );

  it.each(ROW_FIELDS)(
    "結果行の %s が、オラクルで絞った戦績で走らせた結果と全馬で一致する",
    async (field) => {
      const dirty = await run(raw, c.kaisaiDate);
      const clean = await run(oracleTrim(raw, cutoff), c.kaisaiDate);
      expect(dirty.result.rows.map((r) => r[field])).toEqual(clean.result.rows.map((r) => r[field]));
    },
  );

  it("保存レコードの prior・寄与度も、オラクルで絞った戦績で走らせた結果と一致する", async () => {
    const dirty = await run(raw, c.kaisaiDate);
    const clean = await run(oracleTrim(raw, cutoff), c.kaisaiDate);
    expect(dirty.records).toHaveLength(1);
    expect(dirty.records[0]!.horses.map((h) => h.prior)).toEqual(clean.records[0]!.horses.map((h) => h.prior));
    expect(dirty.records[0]!.horses.map((h) => h.contributions)).toEqual(
      clean.records[0]!.horses.map((h) => h.contributions),
    );
  });

  it("絞り済みの入力(当日運用相当: 自レース・施行日以降の走が最初から無い)では何も変わらない", async () => {
    const trimmed = oracleTrim(raw, cutoff);
    const a = await run(trimmed, c.kaisaiDate);
    // 前提: trimmed は絞る対象を含まない。
    expect(allRuns(trimmed).filter((r) => r.raceIdRaw === raw.raceId || (r.date ?? "") >= cutoff)).toHaveLength(0);
    const total = a.result.rows.reduce((s, r) => s + (r.careerRunCount ?? 0), 0);
    expect(total).toBe(allRuns(trimmed).length);
  });

  it("入力(scrape が返した RaceData)の戦績を書き換えない", async () => {
    const before = JSON.stringify(raw);
    await run(raw, c.kaisaiDate);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 非空振り: リークありの参照値と実際に異なる
// ---------------------------------------------------------------------------

describe("先読みリーク遮断の非空振り(中央16頭)", () => {
  const c = CASES[0]!;
  const raw = loadFixture(c.fileName);

  /** 生の戦績(リークあり)から、pipeline と同じ条件で prior を作る参照実装(core の公開関数のみ)。 */
  function leakyPriors(): number[] {
    const inputs = raw.horses.map((h) =>
      buildPriorInput({
        horse: h.shutuba,
        raceResults: h.results ?? [],
        race: {
          courseType: raw.race.courseType,
          distance: raw.race.distance,
          venueName: "福島",
          isWet: classifyTrackWetness(raw.race.trackCondition ?? null, raw.race.courseType)?.isWet ?? false,
          date: toSlash(c.kaisaiDate),
          venueKind: "central",
        },
        fieldSize: raw.horses.length,
      }),
    );
    return computeFieldPriors(inputs).map((p) => p.prior);
  }

  it("リークあり参照の prior と、遮断後の prior は全16頭で異なる(差が0でない)", async () => {
    const { result } = await run(raw, c.kaisaiDate);
    const leaky = leakyPriors();
    const clean = result.rows.map((r) => r.prior);
    expect(leaky).toHaveLength(16);
    expect(clean).toHaveLength(16);
    const byUmaban = new Map(raw.horses.map((h, i) => [h.shutuba.umaban, leaky[i]!]));
    const differing = result.rows.filter((r) => r.prior !== byUmaban.get(r.umaban));
    expect(differing).toHaveLength(16);
  });

  it("リークあり参照の戦績走数(生)と遮断後の戦績走数は、全16頭で異なる", async () => {
    const { result } = await run(raw, c.kaisaiDate);
    const rawCount = new Map(raw.horses.map((h) => [h.shutuba.umaban, h.results!.length]));
    expect(result.rows.filter((r) => r.careerRunCount !== rawCount.get(r.umaban))).toHaveLength(16);
  });

  it("遮断後の prior 上位3頭は、実着順の上位3頭(1着=13・2着=8・3着=5)と一致しない(リークの指紋が消えている)", async () => {
    const { result } = await run(raw, c.kaisaiDate);
    const top3 = [...result.rows]
      .sort((a, b) => b.prior - a.prior)
      .slice(0, 3)
      .map((r) => r.umaban)
      .sort((a, b) => a - b);
    // 実着順(2026/06/28 ラジオNIKKEI賞): 1着=13, 2着=8, 3着=5(Issue #39 本文・フィクスチャの自走の着順から)。
    const actualTop3 = raw.horses
      .map((h) => ({
        umaban: h.shutuba.umaban,
        fin: h.results!.find((r) => r.raceIdRaw === raw.raceId)?.finishPosition,
      }))
      .filter((x) => x.fin !== undefined && x.fin !== null && x.fin.kind === "順位" && x.fin.value <= 3)
      .map((x) => x.umaban)
      .sort((a, b) => a - b);
    // 前提: フィクスチャの自走の着順から得た実着順上位3頭が [5, 8, 13]。
    expect(actualTop3).toEqual([5, 8, 13]);
    expect(top3).not.toEqual(actualTop3);
  });
});

// ---------------------------------------------------------------------------
// 基準日の境界(pipeline に渡す基準日が施行日そのものであること)
// ---------------------------------------------------------------------------

describe("runAnalysis の基準日の境界(中央16頭・馬番1に走を1本ずつ足して検証)", () => {
  const c = CASES[0]!; // 施行日 2026/06/28
  const raw = loadFixture(c.fileName);

  /** 馬番1の戦績の先頭に、指定日付・別レースIDの走を足した RaceData を作る(他の馬・他項目は不変)。 */
  function withInjectedRun(date: string, raceIdRaw: string): RaceData {
    const template = raw.horses[0]!.results!.find((r) => r.raceIdRaw !== raw.raceId)!;
    const injected: HorseRaceResult = { ...template, date, raceId: null, raceIdRaw };
    return {
      ...raw,
      horses: raw.horses.map((h, i) => (i === 0 ? { ...h, results: [injected, ...h.results!] } : h)),
    };
  }

  async function count(raceData: RaceData): Promise<number> {
    const { result } = await run(raceData, c.kaisaiDate);
    return result.rows.find((r) => r.umaban === raw.horses[0]!.shutuba.umaban)!.careerRunCount!;
  }

  it("施行日の前日の別レースの走は残り、施行日当日の別レースの走(自レースでなくても同日)は除かれる", async () => {
    const base = await count(raw);
    // 前提: 馬番1の基準の走数は、オラクルで絞った走数と等しい(注入の効果だけを測る)。
    expect(base).toBe(oracleTrim(raw, toSlash(c.kaisaiDate)).horses[0]!.results!.length);
    expect(await count(withInjectedRun("2026/06/27", "202603020199"))).toBe(base + 1); // 前日: 残る
    expect(await count(withInjectedRun("2026/06/28", "202603020199"))).toBe(base); // 当日: 除かれる
    expect(await count(withInjectedRun("2026/06/29", "202603020199"))).toBe(base); // 翌日: 除かれる
  });
});

// ---------------------------------------------------------------------------
// 近似日(kaisaiDate=null): 自レースの走は日付に依らず除外される
// ---------------------------------------------------------------------------

describe.each(CASES)("runAnalysis の先読みリーク遮断(kaisaiDate=null・実行日で近似): $label", (c) => {
  const raw = loadFixture(c.fileName);
  // 実行日(FIXED_NOW = 2026/09/30)。基準日は resolveAnalysisDate が当日日付で近似する。
  const approxCutoff = "2026/09/30";

  it("dateApproximate=true であり、自レースの走は raceIdRaw で除外される(日付だけでは残る走が除かれる)", async () => {
    const { result } = await run(raw, null);
    expect(result.dateApproximate).toBe(true);
    // 前提: 生の戦績のうち、実行日より前(=日付だけの絞り込みでは残る)の自レースの走が実在する。
    const own = allRuns(raw).filter((r) => r.raceIdRaw === raw.raceId);
    expect(own).toHaveLength(c.ownRuns);
    expect(own.every((r) => r.date !== null && r.date < approxCutoff)).toBe(true);
    const total = result.rows.reduce((a, r) => a + (r.careerRunCount ?? 0), 0);
    // 自レースの走が全て除かれ、その分だけ減る。
    expect(total).toBeLessThan(c.rawTotal);
    expect(total).toBe(allRuns(oracleTrim(raw, approxCutoff)).length);
  });
});

// ---------------------------------------------------------------------------
// マーカー(analyses.history_cutoff_date に書く基準日)
// ---------------------------------------------------------------------------

describe("保存レコードの基準日マーカー(historyCutoffDate)", () => {
  const raw = loadFixture("central-on.json");

  it("開催日が渡ったとき、使った基準日(施行日 YYYYMMDD)を LLM 使用時の保存レコードに書く", async () => {
    const { records } = await run(raw, "20260628");
    expect(records).toHaveLength(1);
    expect(records[0]!.historyCutoffDate).toBe("20260628");
  });

  it("LLM未使用(prior採用)の保存レコードにも基準日を書く", async () => {
    const records = await runWithoutLlm(raw, "20260628");
    expect(records).toHaveLength(1);
    expect(records[0]!.historyCutoffDate).toBe("20260628");
  });

  it("開催日が渡らず実行日で近似したときも、実際に使った基準日(実行日)を書く(null にしない)", async () => {
    const { records, result } = await run(raw, null);
    expect(result.dateApproximate).toBe(true);
    // 実行日は resolveAnalysisDate(now) の当日日付(FIXED_NOW の暦日=2026/09/30)。
    expect(result.date).toBe("2026/09/30");
    expect(records[0]!.historyCutoffDate).toBe("20260930");
    expect(records[0]!.historyCutoffDate).toMatch(/^[0-9]{8}$/);
  });

  it("kaisaiDate(開催日)の保存は従来どおり、近似のときは null のまま(基準日マーカーとは別の値)", async () => {
    const approx = await run(raw, null);
    expect(approx.records[0]!.kaisaiDate).toBeNull();
    expect(approx.records[0]!.historyCutoffDate).not.toBeNull();
    const exact = await run(raw, "20260628");
    expect(exact.records[0]!.kaisaiDate).toBe("20260628");
  });
});

// ---------------------------------------------------------------------------
// マーカー(analyses.prompt_lookahead_guarded。LLMプロンプト側の遮断を通った印。Issue #153)
// ---------------------------------------------------------------------------

describe("保存レコードの遮断済みマーカー(promptLookaheadGuarded)", () => {
  const raw = loadFixture("central-on.json");

  it("LLM使用時の保存レコードに true を書く", async () => {
    const { records } = await run(raw, "20260628");
    expect(records).toHaveLength(1);
    expect(records[0]!.promptLookaheadGuarded).toBe(true);
  });

  it("LLM未使用(prior採用)の保存レコードにも true を書く(遮断を通る経路で作られたことの印)", async () => {
    const records = await runWithoutLlm(raw, "20260628");
    expect(records).toHaveLength(1);
    expect(records[0]!.promptLookaheadGuarded).toBe(true);
  });

  it("開催日が渡らず実行日で近似した分析にも true を書く", async () => {
    const { records, result } = await run(raw, null);
    expect(result.dateApproximate).toBe(true);
    expect(records[0]!.promptLookaheadGuarded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sameDayTrend: 自レースより後のレース番号の結果は材料にしない(Issue #153)
// ---------------------------------------------------------------------------

describe("LLMプロンプトの当日傾向(sameDayTrend)は自レースより前のレース番号だけを材料にする", () => {
  // 同一開催日(2026/08/08 中京)の実物の結果 R1・R2・R5(いずれも芝)。
  const SAME_DAY_HEAD = "2026070205";
  const SAME_DAY_NUMBERS = ["01", "02", "05"] as const;
  const KAISAI = "20260808";

  function loadResultHtml(raceNumber: string): string {
    const url = new URL(`../../../fixtures/result_${SAME_DAY_HEAD}${raceNumber}.html`, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf-8");
  }

  /** 実物の結果を、本番と同じ経路(importRaceResult → AnalysisStore.saveResult)で DB に取り込む。 */
  async function importedStore(): Promise<AnalysisStore> {
    const store = new AnalysisStore();
    for (const n of SAME_DAY_NUMBERS) {
      await importRaceResult(parseRaceId(`${SAME_DAY_HEAD}${n}`), {
        fetchText: async () => loadResultHtml(n),
        parse: parseRaceResult,
        saveResult: (rid, entries, courseType, comboPayouts) =>
          store.saveResult(rid, entries, courseType, comboPayouts),
      });
    }
    return store;
  }

  /** 独立オラクル用: 実物の結果を直接パースした RaceResult(DB を通さない)。 */
  function parsedResult(raceNumber: string): RaceResult {
    return parseRaceResult(loadResultHtml(raceNumber));
  }

  /** 出馬表は central-on.json(芝)の raceId だけを差し替えた合成(結果は上の実物)。 */
  function targetRaceData(raceNumber: string): RaceData {
    return { ...loadFixture("central-on.json"), raceId: `${SAME_DAY_HEAD}${raceNumber}` as RaceData["raceId"] };
  }

  it("前提: 取り込んだ3本はすべて芝で、出走表(合成)の面も芝である(面が一致するため、面フィルタで落ちない)", async () => {
    const store = await importedStore();
    for (const n of SAME_DAY_NUMBERS) {
      const detail = store.getRaceResultDetail(`${SAME_DAY_HEAD}${n}`);
      expect(detail).toBeDefined();
      expect(detail!.courseType).toBe("芝");
      expect(detail!.horses.length).toBeGreaterThan(0);
    }
    expect(targetRaceData("03").race.courseType).toBe("芝");
    store.close();
  });

  it("自番号03のレース: 先行の R1・R2 の2本だけを集計し、後続の R5 の結果は混ざらない(オラクルと一致・リテラルで固定)", async () => {
    const store = await importedStore();
    const { prompt } = await run(targetRaceData("03"), KAISAI, {
      getRaceResultDetail: (id) => store.getRaceResultDetail(id),
    });
    const trend = prompt.race.sameDayTrend;
    expect(trend).not.toBeNull();
    expect(trend!.サンプル数.レース数).toBe(2);
    // 独立オラクル: R1・R2 を直接集計した結果と全項目で一致する。
    expect(trend).toEqual(summarizeSameDayTrend([parsedResult("01"), parsedResult("02")]));
    // 非空振り: 後続の R5 まで含めた集計(従来の挙動)とは異なる(レース数3で、結果が一致しない)。
    const leaky = summarizeSameDayTrend([parsedResult("01"), parsedResult("02"), parsedResult("05")]);
    expect(leaky.サンプル数.レース数).toBe(3);
    expect(trend).not.toEqual(leaky);
    store.close();
  });

  it("自番号03のレース: getRaceResultDetail は先行の01・02だけを引き、自番号・後続は一度も引かない", async () => {
    const store = await importedStore();
    const lookup = vi.fn((id: string) => store.getRaceResultDetail(id));
    await run(targetRaceData("03"), KAISAI, { getRaceResultDetail: lookup });
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(["202607020501", "202607020502"]);
    store.close();
  });

  it("自番号02のレース: 先行は R1 の1本だけでデータ不足になり、sameDayTrend は null(後続の R5 が取込済みでも補われない)", async () => {
    const store = await importedStore();
    const { prompt } = await run(targetRaceData("02"), KAISAI, {
      getRaceResultDetail: (id) => store.getRaceResultDetail(id),
    });
    expect(prompt.race.sameDayTrend ?? null).toBeNull();
    // 非空振り: 後続の R5 を含めれば(従来の挙動)データ不足にならない。
    expect(summarizeSameDayTrend([parsedResult("01"), parsedResult("05")]).脚質傾向).not.toBe("データ不足");
    store.close();
  });

  it("当日運用相当(自番号06・先行の R1・R2・R5 がすべて取込済みで後続は未取込): 先行3本を全て集計し、従来と同じ結果になる", async () => {
    const store = await importedStore();
    const { prompt } = await run(targetRaceData("06"), KAISAI, {
      getRaceResultDetail: (id) => store.getRaceResultDetail(id),
    });
    const trend = prompt.race.sameDayTrend;
    expect(trend).not.toBeNull();
    expect(trend!.サンプル数.レース数).toBe(3);
    expect(trend).toEqual(summarizeSameDayTrend([parsedResult("01"), parsedResult("02"), parsedResult("05")]));
    store.close();
  });

  it("プロンプト文面にも、後続のレースを含めた集計は出ない(自番号03: 当日の同場・同面傾向の行が「確定2R」で、「確定3R」にならない)", async () => {
    const store = await importedStore();
    const { prompt } = await run(targetRaceData("03"), KAISAI, {
      getRaceResultDetail: (id) => store.getRaceResultDetail(id),
    });
    const text = buildPrompt(prompt);
    expect(text).toContain("当日の同場・同面傾向(芝、確定2R)");
    expect(text).not.toContain("確定3R");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// gradeWinnerTrend: 当該回自身と基準日以降の回は材料にしない(Issue #153)
// ---------------------------------------------------------------------------

describe("LLMプロンプトの同レース過去傾向(gradeWinnerTrend)は先読みになる回を材料にしない", () => {
  function loadGradeWinnerRaw(name: string): string {
    return readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), "utf-8");
  }

  function rawEntries(name: string) {
    const parsed = parseGradeWinnerResponse(loadGradeWinnerRaw(name));
    expect(parsed).not.toBeNull();
    return parsed!;
  }

  /** 本番の core 関数(collectGradeWinnerTrend)を、固定のレスポンスを返すフェッチャで束縛した deps。呼び出し引数も捕捉する。 */
  function gradeWinnerDeps(fixtureName: string) {
    const calls: Array<{ raceId: string; cutoffDate: string }> = [];
    const fetcher = { fetchText: async () => loadGradeWinnerRaw(fixtureName) };
    const getGradeWinnerTrend: NonNullable<AnalysisPipelineDeps["getGradeWinnerTrend"]> = (
      raceId,
      conditions,
      cutoffDate,
    ) => {
      calls.push({ raceId, cutoffDate });
      return collectGradeWinnerTrend(raceId, conditions, cutoffDate, { fetcher });
    };
    return { calls, getGradeWinnerTrend };
  }

  /** 地方(大井 ダ2000)の出馬表(合成): nar-on.json の raceId・面・距離・重賞バッジを差し替えたもの。 */
  function narRaceData(raceId: string): RaceData {
    const base = loadFixture("nar-on.json");
    return {
      ...base,
      raceId: raceId as RaceData["raceId"],
      race: { ...base.race, courseType: "ダ", distance: 2000, hasGradeBadge: true },
    };
  }

  const NAR_CONDITIONS = { trackCode: "44", track: "ダ" as const, kyori: 2000 };
  const CENTRAL_CONDITIONS = { trackCode: "03", track: "芝" as const, kyori: 1800 };

  it("地方・当該回自身が応答に含まれる実物(2026年の回): 当該回を除いた9回で集計し、プロンプトの「対象」も9回になる(オラクル+リテラル)", async () => {
    const name = "grade_winner_nar_202644070111.json";
    const raw = rawEntries(name);
    // 前提: 先頭が当該回自身(raceId 一致)。
    expect(raw[0]!.raceId).toBe("202644070111");
    const { calls, getGradeWinnerTrend } = gradeWinnerDeps(name);

    const { prompt } = await run(narRaceData("202644070111"), "20260701", { getGradeWinnerTrend });

    expect(calls).toEqual([{ raceId: "202644070111", cutoffDate: "2026/07/01" }]);
    const trend = prompt.race.gradeWinnerTrend;
    expect(trend).not.toBeNull();
    expect(trend!.対象回数).toBe(9);
    expect(trend!.複勝圏内馬数).toBe(27);
    expect(trend!.複勝配当中央値).toBe(160);
    expect(trend).toEqual(summarizeGradeWinnerTrend(raw.slice(1), NAR_CONDITIONS));
    // 非空振り: 絞らない集計(従来の挙動)とは異なる。
    const leaky = summarizeGradeWinnerTrend(raw, NAR_CONDITIONS)!;
    expect(leaky.対象回数).toBe(10);
    expect(trend).not.toEqual(leaky);
    // 利用者から見える文面(LLMプロンプト)。
    const text = buildPrompt(prompt);
    expect(text).toContain("対象9回中");
    expect(text).not.toContain("対象10回中");
  });

  it("地方・過去の回を後から分析(2023年の回。応答は2026〜2024年の回と当該回を含む実物): 基準日 2023/06/28 で2022年以前の6回に絞る", async () => {
    const name = "grade_winner_nar_202344062811.json";
    const raw = rawEntries(name);
    // 前提: 応答は2026〜2017年の10回で、当該回(2023年)はその4番目。
    expect(raw).toHaveLength(10);
    expect(raw[3]!.raceId).toBe("202344062811");
    const { calls, getGradeWinnerTrend } = gradeWinnerDeps(name);

    const { prompt } = await run(narRaceData("202344062811"), "20230628", { getGradeWinnerTrend });

    expect(calls).toEqual([{ raceId: "202344062811", cutoffDate: "2023/06/28" }]);
    const trend = prompt.race.gradeWinnerTrend;
    expect(trend).not.toBeNull();
    expect(trend!.対象回数).toBe(6);
    expect(trend!.複勝配当中央値).toBe(165);
    expect(trend).toEqual(summarizeGradeWinnerTrend(raw.slice(4), NAR_CONDITIONS));
    expect(trend).not.toEqual(summarizeGradeWinnerTrend(raw, NAR_CONDITIONS));
    const text = buildPrompt(prompt);
    expect(text).toContain("対象6回中");
  });

  it("地方・開催日が渡らず実行日(2026/09/30)で近似した過去分析: 当該回は raceId で除かれるが、実行日より前の後の回(2024〜2026年)は残る(近似日の既知の限界)", async () => {
    const name = "grade_winner_nar_202344062811.json";
    const raw = rawEntries(name);
    const { calls, getGradeWinnerTrend } = gradeWinnerDeps(name);

    const { prompt, result } = await run(narRaceData("202344062811"), null, { getGradeWinnerTrend });

    expect(result.dateApproximate).toBe(true);
    expect(calls).toEqual([{ raceId: "202344062811", cutoffDate: "2026/09/30" }]);
    // 当該回(2023年)だけが除かれ9回。2024〜2026年は残る(日付だけでは落とせないため)。
    expect(prompt.race.gradeWinnerTrend!.対象回数).toBe(9);
    expect(prompt.race.gradeWinnerTrend).toEqual(
      summarizeGradeWinnerTrend(raw.filter((e) => e.raceId !== "202344062811"), NAR_CONDITIONS),
    );
  });

  it("中央・当日運用(応答に当該回を含まず、全て施行日より前の実物): 何も除かれず、絞らない集計と全項目で一致する(no-op)", async () => {
    const name = "grade_winner_202603020211.json";
    const raw = rawEntries(name);
    const { calls, getGradeWinnerTrend } = gradeWinnerDeps(name);

    const { prompt } = await run(loadFixture("central-on.json"), "20260628", { getGradeWinnerTrend });

    expect(calls).toEqual([{ raceId: "202603020211", cutoffDate: "2026/06/28" }]);
    expect(prompt.race.gradeWinnerTrend).toEqual(summarizeGradeWinnerTrend(raw, CENTRAL_CONDITIONS));
    expect(prompt.race.gradeWinnerTrend!.対象回数).toBe(10);
    expect(buildPrompt(prompt)).toContain("対象10回中");
  });

  it("中央の日付分岐の疑似ケース(合成: 2026年の応答を開催日 2023/07/02 の分析に当てる): 同日の2023年と後の2024・2025年が除かれ2022年以前の7回になる", async () => {
    const name = "grade_winner_202603020211.json";
    const raw = rawEntries(name);
    const { getGradeWinnerTrend } = gradeWinnerDeps(name);

    const { prompt } = await run(loadFixture("central-on.json"), "20230702", { getGradeWinnerTrend });

    expect(raw[3]!.raceDate).toBe("2022-07-03");
    expect(prompt.race.gradeWinnerTrend!.対象回数).toBe(7);
    expect(prompt.race.gradeWinnerTrend).toEqual(summarizeGradeWinnerTrend(raw.slice(3), CENTRAL_CONDITIONS));
  });

  it("基準日(cutoffDate)は戦績の絞り込み(#39)と同じ分析日(analysisDate)で、保存レコードの基準日マーカーと同じ日付である", async () => {
    const { getGradeWinnerTrend, calls } = gradeWinnerDeps("grade_winner_202603020211.json");
    const { records } = await run(loadFixture("central-on.json"), "20260628", { getGradeWinnerTrend });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cutoffDate.replaceAll("/", "")).toBe(records[0]!.historyCutoffDate);
  });
});
