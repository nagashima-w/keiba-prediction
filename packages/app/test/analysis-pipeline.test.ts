import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";
import {
  buildPriorInput,
  buildPrompt,
  CLIP_VARIANTS,
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
  PROMPT_VERSION,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type CourseType,
  type HorseRaceResult,
  type OddsSnapshot,
  type RaceData,
  type RaceHorseData,
  type ShutubaHorse,
} from "@keiba/core";
import type { AnalysisRecord } from "@keiba/core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  resolveAnalysisDate,
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../src/main/analysis-pipeline.js";
import type { AnalysisProgress } from "../src/shared/analysis-types.js";

// buildPriorInput を実挙動そのままのスパイに差し替え、渡された race.date を検証できるようにする。
vi.mock("@keiba/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core")>();
  return { ...actual, buildPriorInput: vi.fn(actual.buildPriorInput) };
});

// ---- テスト用フェイクデータ組み立て ----------------------------------------

/**
 * テスト用の全戦績1走分を作る(指定した日付・通過順以外は空。pace/last3fは省略時null)。
 * courseType/distance/venueKind を extra 経由で上書きできる(条件替わりの配線テスト用。
 * 省略時は従来どおり courseType=null, distance=null, venueKind="中央" のまま=既存回帰は無変更)。
 */
function fakeResult(
  date: string,
  passing: number[] = [],
  extra: {
    pace?: string | null;
    last3f?: number | null;
    courseType?: HorseRaceResult["courseType"];
    distance?: number | null;
    venueKind?: HorseRaceResult["venueKind"];
  } = {},
): HorseRaceResult {
  return {
    date,
    venue: null,
    weather: null,
    raceNumber: null,
    raceName: null,
    raceId: null,
    raceIdRaw: null,
    venueKind: extra.venueKind ?? "中央",
    entryCount: 12,
    wakuban: null,
    umaban: null,
    odds: null,
    ninki: null,
    finishPosition: null,
    jockeyName: null,
    jockeyId: null,
    kinryo: null,
    courseType: extra.courseType ?? null,
    distance: extra.distance ?? null,
    trackCondition: null,
    time: null,
    margin: null,
    passing,
    pace: extra.pace ?? null,
    last3f: extra.last3f ?? null,
    bodyWeight: null,
    winnerName: null,
  };
}

/** テスト用の出馬表馬を作る。 */
function fakeHorse(umaban: number): ShutubaHorse {
  return {
    wakuban: umaban,
    umaban,
    name: `テスト馬${umaban}`,
    horseId: parseHorseId(`10000000${String(umaban).padStart(2, "0")}`),
    sex: "牡",
    age: 4,
    kinryo: 56,
    jockeyName: `騎手${umaban}`,
    jockeyId: null,
    stableLocation: "美浦",
    trainerName: `調教師${umaban}`,
    trainerId: null,
    bodyWeight: { weight: 480, diff: 0 },
  };
}

/**
 * 3頭・複勝オッズ付きのフェイクレースデータを作る。resultsByUmaban で戦績を差し込める。
 * oddsStatus="yoso" のときは複勝未発売を模して place を空にする(全馬EV対象外の検証用)。
 */
function fakeRaceData(
  raceId: string,
  resultsByUmaban: Record<number, HorseRaceResult[]> = {},
  oddsStatus: "result" | "middle" | "yoso" = "result",
  // レース自体のcourseType/fenceを上書きできる(芝の傷み目安#26-P3の配線テスト用)。
  // 省略時は従来どおり courseType="芝"・fenceキー無し(undefined)のまま=既存回帰は無変更。
  raceOverrides: { courseType?: CourseType; fence?: string | null } = {},
): RaceData {
  const horses: RaceHorseData[] = [1, 2, 3].map((n) => ({
    shutuba: fakeHorse(n),
    results: resultsByUmaban[n] ?? [],
    oikiri: null,
  }));
  const odds: OddsSnapshot = {
    officialDatetime: "2026-07-09 09:00:00",
    oddsStatus,
    // 単勝オッズ・人気(Task#22: LLMプロンプトの市場データに配線される)。
    // yoso(予想オッズ)でも単勝は値が入るため oddsStatus に関わらず同じ値を用意する。
    win: {
      1: { odds: 5.2, ninki: 3 },
      2: { odds: 1.3, ninki: 1 },
      // 3番は取消等で単勝オッズが欠損 → winOdds/popularity が null になること。
      3: { odds: null, ninki: null },
    },
    place:
      oddsStatus === "yoso"
        ? // 予想オッズ(yoso)は複勝未発売のため place が空 → 全馬EV対象外になる。
          {}
        : {
            1: { oddsMin: 5.0, oddsMax: 6.0, ninki: 3 },
            2: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 },
            // 3番は複勝オッズ下限が欠損 → EV対象外になること。
            3: { oddsMin: null, oddsMax: null, ninki: null },
          },
  };
  return {
    raceId: parseRaceId(raceId),
    race: {
      raceName: "テスト特別",
      courseType: raceOverrides.courseType ?? "芝",
      distance: 1600,
      weather: "晴",
      trackCondition: "良",
      // fenceは"fence"キーが指定されたときだけ持たせる(既存テストはキー自体を持たない=undefined相当を維持)。
      ...("fence" in raceOverrides ? { fence: raceOverrides.fence } : {}),
    },
    horses,
    odds,
    meta: {
      fetchedAt: "2026-07-09T00:00:00.000Z",
      oddsFetchedAt: "2026-07-09T00:00:05.000Z",
      warnings: [{ kind: "戦績", message: "馬ID xxx の戦績取得に失敗しました" }],
    },
  };
}

const RACE_ID = "202605020811"; // 場コード05 → 東京。
const NAR_RACE_ID = "202654071210"; // 場コード54 → 高知(2026/07/12・10R。docs/nar-scraping-plan.mdの実例)。
const KAISAI = "20260709"; // 開催日(選択済みとして渡す)。
const FIXED_NOW = new Date("2026-07-09T12:34:56.000Z");

describe("resolveAnalysisDate(開催日の解決)", () => {
  it("YYYYMMDD が渡れば YYYY/MM/DD に変換し、近似ではない", () => {
    expect(resolveAnalysisDate("20250115", () => FIXED_NOW)).toEqual({
      date: "2025/01/15",
      approximate: false,
    });
  });

  it("null(渡らない)なら当日日付で近似し、approximate=true", () => {
    expect(resolveAnalysisDate(null, () => FIXED_NOW)).toEqual({
      date: "2026/07/09",
      approximate: true,
    });
  });
});

describe("runAnalysis(分析パイプライン)", () => {
  let saved: AnalysisRecord[];
  let progress: AnalysisProgress[];
  let baseDeps: () => AnalysisPipelineDeps;

  beforeEach(() => {
    (buildPriorInput as unknown as Mock).mockClear();
    saved = [];
    progress = [];
    baseDeps = () => ({
      scrape: vi.fn(async () => fakeRaceData(RACE_ID)),
      analyze: null,
      saveAnalysis: vi.fn((rec: AnalysisRecord) => {
        saved.push(rec);
        return saved.length;
      }),
      now: () => FIXED_NOW,
      llmSkipReason: "APIキー未設定",
    });
  });

  const onProgress = (p: AnalysisProgress): void => {
    progress.push(p);
  };

  it("選択済み開催日を buildPriorInput の race.date と結果に反映する(近似ではない)", async () => {
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate("20250115"),
      baseDeps(),
      onProgress,
    );

    expect(result.date).toBe("2025/01/15");
    expect(result.dateApproximate).toBe(false);

    const calls = (buildPriorInput as unknown as Mock).mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[0].race.date).toBe("2025/01/15");
    }
  });

  it("deps.scorerConfig(重み変更済み)が buildPriorInput 経由で全頭のスコアリングに渡る", async () => {
    // 設定→パイプライン反映の検証: 重みを変えた ScorerConfig が各馬の PriorInput.config に載り、
    // その PriorInput が computeFieldPriors に渡る(buildPriorInput はその config を素通しする)。
    const scorerConfig = {
      ...DEFAULT_SCORER_CONFIG,
      weights: { ...DEFAULT_SCORER_CONFIG.weights, trackCondition: 0.42 },
    };
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      { ...baseDeps(), scorerConfig },
      onProgress,
    );

    const calls = (buildPriorInput as unknown as Mock).mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[0].config).toBe(scorerConfig);
      expect(call[0].config.weights.trackCondition).toBe(0.42);
    }
  });

  it("開催日が渡らない(null)場合は当日日付で近似し dateApproximate=true", async () => {
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      null,
      baseDeps(),
      onProgress,
    );
    expect(result.date).toBe("2026/07/09");
    expect(result.dateApproximate).toBe(true);
  });

  it("選択済み開催日(kaisaiDate)を保存レコードにそのまま記録すること(Task#34)", async () => {
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );
    expect(saved[0]!.kaisaiDate).toBe(KAISAI);
  });

  it("開催日が渡らない(null)場合は保存レコードのkaisaiDateもnullにすること(当日近似日付は保存しない、Task#34)", async () => {
    await runAnalysis(parseRaceId(RACE_ID), null, baseDeps(), onProgress);
    expect(saved[0]!.kaisaiDate).toBeNull();
  });

  it("LLM無し(analyze=null): prior をそのまま採用し、EV・保存まで実行して結果を返す", async () => {
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );

    expect(result.venueName).toBe("東京");
    expect(result.raceName).toBe("テスト特別");
    expect(result.llmUsed).toBe(false);
    expect(result.llmSkippedReason).toBe("APIキー未設定");
    expect(result.fallback).toBe(false);
    expect(result.fallbackReason).toBeNull(); // fallback:false ⇒ fallbackReason:null(不変条件)。
    expect(result.marksDropped).toBe(false); // LLMスキップ時はA救済も発生しない。
    expect(result.marksDroppedReason).toBeNull();

    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.umaban)).toEqual([1, 2, 3]);
    for (const row of result.rows) {
      expect(row.adjustedProb).toBe(row.prior);
      expect(row.reason).toBeNull();
      expect(row.prior).toBeGreaterThan(0);
      expect(row.prior).toBeLessThanOrEqual(1);
    }

    const row3 = result.rows.find((r) => r.umaban === 3)!;
    expect(row3.ev).toBeNull();
    expect(row3.isPositive).toBe(false);

    const row1 = result.rows.find((r) => r.umaban === 1)!;
    expect(row1.ev).toBeCloseTo(row1.adjustedProb * 5.0, 8);
    expect(row1.isPositive).toBe(row1.ev! > 1.0);

    expect(result.warnings).toContain("馬ID xxx の戦績取得に失敗しました");

    expect(saved).toHaveLength(1);
    expect(saved[0]!.raceId).toBe(RACE_ID);
    expect(saved[0]!.horses).toHaveLength(3);
    expect(result.analyzedAt).toBe(FIXED_NOW.toISOString());
  });

  it("各行に careerRunCount(戦績走数=results.length)を伝搬する(妙味スコアの低データ判定用)", async () => {
    // 1番は2走、2番は0走(新馬相当)、3番は既定(空)の戦績を差し込む。
    const results = {
      1: [fakeResult("2026/06/01"), fakeResult("2026/05/01")],
      2: [],
    };
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceData(RACE_ID, results, "middle")),
    };
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );
    const byUmaban = new Map(result.rows.map((r) => [r.umaban, r]));
    expect(byUmaban.get(1)!.careerRunCount).toBe(2);
    expect(byUmaban.get(2)!.careerRunCount).toBe(0);
    expect(byUmaban.get(3)!.careerRunCount).toBe(0);
  });

  it("戦績取得失敗(results=null)の馬は careerRunCount=null にする(新馬0走と区別)", async () => {
    const base = fakeRaceData(RACE_ID, { 1: [fakeResult("2026/06/01")] }, "middle");
    // 3番だけ戦績取得失敗(results=null)を模す。
    const race: RaceData = {
      ...base,
      horses: base.horses.map((h) =>
        h.shutuba.umaban === 3 ? { ...h, results: null } : h,
      ),
    };
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => race),
    };
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );
    const byUmaban = new Map(result.rows.map((r) => [r.umaban, r]));
    expect(byUmaban.get(1)!.careerRunCount).toBe(1); // 1走(判明)
    expect(byUmaban.get(2)!.careerRunCount).toBe(0); // 新馬(判明・0走)
    expect(byUmaban.get(3)!.careerRunCount).toBeNull(); // 取得失敗(不明)
  });

  it("オッズ発売状態(oddsStatus)を結果メタに反映する(middle)", async () => {
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceData(RACE_ID, {}, "middle")),
    };
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );
    expect(result.oddsStatus).toBe("middle");
  });

  it("予想オッズ(yoso・複勝未発売)では単勝オッズから推定した複勝下限でEVを概算し、evEstimated=trueになること(Task#25)", async () => {
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceData(RACE_ID, {}, "yoso")),
    };
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    expect(result.oddsStatus).toBe("yoso");
    expect(result.rows).toHaveLength(3);
    // 全行が「推定EV」であることを示す(レース単位で一律)。
    for (const row of result.rows) {
      expect(row.evEstimated).toBe(true);
    }

    // 1番: 単勝5.2倍 → 推定複勝下限 = 1.0+(5.2-1)×0.2 = 1.84。
    const row1 = result.rows.find((r) => r.umaban === 1)!;
    expect(row1.placeOddsMin).toBeCloseTo(1.84, 8);
    expect(row1.ev).toBeCloseTo(row1.prior * 1.84, 8);
    expect(row1.isPositive).toBe(row1.ev! > 1.0);

    // 2番: 単勝1.3倍 → 推定複勝下限 = 1.0+(1.3-1)×0.2 = 1.06。
    const row2 = result.rows.find((r) => r.umaban === 2)!;
    expect(row2.placeOddsMin).toBeCloseTo(1.06, 8);

    // 3番: 単勝オッズ自体が欠損 → 推定不可のためEVはnull(それでもevEstimated=trueのまま)。
    const row3 = result.rows.find((r) => r.umaban === 3)!;
    expect(row3.ev).toBeNull();
    expect(row3.placeOddsMin).toBeNull();
    expect(row3.isPositive).toBe(false);

    for (const row of result.rows) {
      // prior(事前確率)自体は算出できている。
      expect(row.prior).toBeGreaterThan(0);
      expect(row.prior).toBeLessThanOrEqual(1);
    }
    // 保存まで到達している(分析は成功扱い)。分析レコードにも推定フラグが立つ。
    expect(saved).toHaveLength(1);
    expect(saved[0]!.evEstimated).toBe(true);
  });

  it("確定・発売中(oddsStatus!==yoso)ではevEstimated=falseになること(回帰確認)", async () => {
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceData(RACE_ID, {}, "middle")),
    };
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );
    for (const row of result.rows) {
      expect(row.evEstimated).toBe(false);
    }
    expect(saved[0]!.evEstimated).toBe(false);
  });

  it("進捗コールバックは4段階(スクレイピング→スコアリング→LLM分析→保存)を通知し、スコアリングは n/N頭 を報告する", async () => {
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );

    const stagesInOrder = progress.map((p) => p.stage);
    const firstIndex = (stage: string): number =>
      stagesInOrder.indexOf(stage as AnalysisProgress["stage"]);
    expect(firstIndex("スクレイピング")).toBeGreaterThanOrEqual(0);
    expect(firstIndex("スクレイピング")).toBeLessThan(firstIndex("スコアリング"));
    expect(firstIndex("スコアリング")).toBeLessThan(firstIndex("LLM分析"));
    expect(firstIndex("LLM分析")).toBeLessThan(firstIndex("保存"));

    const scoring = progress.filter((p) => p.stage === "スコアリング");
    expect(scoring).toHaveLength(3);
    expect(scoring.map((p) => p.current)).toEqual([1, 2, 3]);
    expect(scoring.every((p) => p.total === 3)).toBe(true);
  });

  it("LLMスキップ時は LLM分析段階でスキップ理由を通知する", async () => {
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );
    const llm = progress.filter((p) => p.stage === "LLM分析");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.message).toContain("スキップ");
  });

  it("LLMスキップ時は全馬 mark が null になること(Task#23)", async () => {
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );
    expect(result.rows.every((r) => r.mark === null)).toBe(true);
    expect(saved[0]!.horses.every((h) => h.mark === null)).toBe(true);
  });

  it("LLMのmarkを分析結果(rows)と保存レコード(AnalysisRecord)へ伝播すること(Task#23)", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: h.prior,
          reason: null,
          clipped: false,
          usedPrior: true,
          mark: h.umaban === 1 ? "◎" : h.umaban === 2 ? "〇" : null,
        })),
        fallback: false,
        retryCount: 0,
        fallbackReason: null,
      }),
    );
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      { ...baseDeps(), analyze },
      onProgress,
    );
    expect(result.rows.find((r) => r.umaban === 1)!.mark).toBe("◎");
    expect(result.rows.find((r) => r.umaban === 2)!.mark).toBe("〇");
    expect(result.rows.find((r) => r.umaban === 3)!.mark).toBeNull();

    expect(saved[0]!.horses.find((h) => h.umaban === 1)!.mark).toBe("◎");
    expect(saved[0]!.horses.find((h) => h.umaban === 2)!.mark).toBe("〇");
    expect(saved[0]!.horses.find((h) => h.umaban === 3)!.mark).toBeNull();
  });

  it("LLMスキップ時は保存レコードの promptVersion が null になること(プロンプト未使用、Task#27)", async () => {
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      baseDeps(),
      onProgress,
    );
    expect(saved[0]!.promptVersion).toBeNull();
  });

  it("LLM有り: 保存レコードの promptVersion に PROMPT_VERSION を記録すること(Task#27)", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: h.prior,
          reason: null,
          clipped: false,
          usedPrior: true,
          mark: null,
        })),
        fallback: false,
        retryCount: 0,
        fallbackReason: null,
      }),
    );
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      { ...baseDeps(), analyze },
      onProgress,
    );
    expect(saved[0]!.promptVersion).toBe(PROMPT_VERSION);
  });

  describe("クリップ幅版(clipVariant)の配線(タスクD-2: ±10%↔±15%のA/B・新版並走)", () => {
    /** analyze をキャプチャして BuildPromptInput をそのまま記録するスタブ(条件替わり配線テストと同型)。 */
    function analyzeCapturing(
      captured: { value: BuildPromptInput | null },
    ): (input: BuildPromptInput) => Promise<AnalyzeRaceResult> {
      return async (input: BuildPromptInput) => {
        captured.value = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      };
    }

    it("deps.clipVariant='wide15' なら BuildPromptInput.clipVariant='wide15' が buildPrompt へ渡ること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze: analyzeCapturing(captured), clipVariant: "wide15" },
        onProgress,
      );
      expect(captured.value!.clipVariant).toBe("wide15");
    });

    it("deps.clipVariant未指定なら BuildPromptInput.clipVariant は既定('default')が渡ること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze: analyzeCapturing(captured) },
        onProgress,
      );
      expect(captured.value!.clipVariant).toBe("default");
    });

    it("LLM有り・deps.clipVariant='wide15': 保存レコードのpromptVersionが新版文字列になること", async () => {
      const analyze = vi.fn(
        async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        }),
      );
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze, clipVariant: "wide15" },
        onProgress,
      );
      expect(saved[0]!.promptVersion).toBe(CLIP_VARIANTS.wide15.promptVersion);
      expect(saved[0]!.promptVersion).not.toBe(PROMPT_VERSION);
    });

    it("LLMスキップ時はdeps.clipVariant='wide15'でも保存レコードのpromptVersionはnullのまま(プロンプト未使用)", async () => {
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), clipVariant: "wide15" },
        onProgress,
      );
      expect(saved[0]!.promptVersion).toBeNull();
    });
  });

  describe("条件替わり(妙味材料)の配線", () => {
    /** analyze をキャプチャして BuildPromptInput をそのまま記録するスタブ(追加指示テストと同型)。 */
    function analyzeCapturing(
      captured: { value: BuildPromptInput | null },
    ): (input: BuildPromptInput) => Promise<AnalyzeRaceResult> {
      return async (input: BuildPromptInput) => {
        captured.value = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      };
    }

    it("BuildPromptInput.race.venueKind と各馬の runConditions が実際に populate されること(optional省略で黙って劣化しないことの担保)", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        scrape: vi.fn(async () =>
          fakeRaceData(RACE_ID, {
            1: [
              fakeResult("2026/06/01", [1, 1], {
                courseType: "ダ",
                distance: 2000,
                venueKind: "地方",
              }),
            ],
          }),
        ),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);

      // RACE_ID(場コード05・東京)は中央のレースのため venueKind は "central" になる。
      expect(captured.value!.race.venueKind).toBe("central");
      const horse1 = captured.value!.horses.find((h) => h.umaban === 1)!;
      expect(horse1.runConditions).toEqual([
        { courseType: "ダ", distance: 2000, venueKind: "地方" },
      ]);
    });

    it("runConditions未指定(戦績なし)の馬は空配列になり、条件替わりタグが全て「なし」になること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);

      for (const h of captured.value!.horses) {
        expect(h.runConditions).toEqual([]);
      }
    });

    it("プロンプト行の『条件替わり=』とAnalysisRow.conditionChangeTagsが同一馬で一致すること(同一ソースデータを2箇所に配線する事故防止)", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        scrape: vi.fn(async () =>
          fakeRaceData(RACE_ID, {
            1: [
              fakeResult("2026/06/01", [1, 1], {
                courseType: "ダ",
                distance: 2000,
                venueKind: "地方",
              }),
            ],
          }),
        ),
        analyze: analyzeCapturing(captured),
      };
      const result = await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        deps,
        onProgress,
      );

      // このレース条件(芝1600・中央)+馬1の過去走(ダ2000・地方)なら、
      // サーフェス(初芝: 芝経験0)・距離短縮(平均比-400m)・開催(地方→中央)の3タグが立つ想定。
      const row1 = result.rows.find((r) => r.umaban === 1)!;
      expect(row1.conditionChangeTags).toEqual([
        { kind: "surface", label: "初芝" },
        { kind: "distance", label: "距離短縮(平均比-400m)" },
        { kind: "venue", label: "地方→中央" },
      ]);

      // buildPrompt が実際に組み立てるプロンプト本文でも、同じ馬番の行に同じラベル列(・区切り)が
      // 現れることを確認する(pipeline側とbuild-prompt側の2箇所呼び出しがずれていないことの担保)。
      const promptText = buildPrompt(captured.value!);
      const horse1Line = promptText
        .split("\n")
        .find((line) => line.startsWith("馬番1 "))!;
      const expectedTagsText = row1.conditionChangeTags
        .map((t) => t.label)
        .join("・");
      expect(horse1Line).toContain(`条件替わり=${expectedTagsText}`);
    });
  });

  describe("芝の傷み目安(タスク#26-P3)の配線", () => {
    /** analyze をキャプチャして BuildPromptInput をそのまま記録するスタブ(他の配線テストと同型)。 */
    function analyzeCapturing(
      captured: { value: BuildPromptInput | null },
    ): (input: BuildPromptInput) => Promise<AnalyzeRaceResult> {
      return async (input: BuildPromptInput) => {
        captured.value = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      };
    }

    it("中央芝: BuildPromptInput.race.turfWearHintが populate され、プロンプト本文に「芝コースの開催進行」行が出ること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        // RACE_ID(場コード05・東京・回次02・日次08)。fence未指定(芝だが柵不明)。
        scrape: vi.fn(async () => fakeRaceData(RACE_ID, {}, "result", { fence: null })),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);

      expect(captured.value!.race.turfWearHint).toEqual({
        開催日次: 8,
        開催回次: 2,
        柵: null,
        note:
          "中央2回8日目。開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。",
      });
      const promptText = buildPrompt(captured.value!);
      expect(promptText).toContain(
        "芝コースの開催進行: 中央2回8日目。開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。",
      );
    });

    it("中央ダート: turfWearHintがnullになり、プロンプト本文に「芝コースの開催進行」行が出ないこと", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        scrape: vi.fn(async () =>
          fakeRaceData(RACE_ID, {}, "result", { courseType: "ダ" }),
        ),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);

      expect(captured.value!.race.turfWearHint ?? null).toBeNull();
      const promptText = buildPrompt(captured.value!);
      expect(promptText).not.toContain("芝コースの開催進行");
    });

    it("中央障害: turfWearHintがnullになり、プロンプト本文に「芝コースの開催進行」行が出ないこと", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        scrape: vi.fn(async () =>
          fakeRaceData(RACE_ID, {}, "result", { courseType: "障" }),
        ),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);

      expect(captured.value!.race.turfWearHint ?? null).toBeNull();
      const promptText = buildPrompt(captured.value!);
      expect(promptText).not.toContain("芝コースの開催進行");
    });

    it("地方(NAR): turfWearHintがnullになり、プロンプト本文に「芝コースの開催進行」行が出ないこと", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        scrape: vi.fn(async () => fakeRaceData(NAR_RACE_ID)),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(
        parseRaceId(NAR_RACE_ID),
        parseKaisaiDate("20260712"),
        deps,
        onProgress,
      );

      expect(captured.value!.race.turfWearHint ?? null).toBeNull();
      const promptText = buildPrompt(captured.value!);
      expect(promptText).not.toContain("芝コースの開催進行");
    });
  });

  describe("追加指示(additionalInstruction)の配線(Task#28 プロンプト改善C)", () => {
    function analyzeCapturing(
      captured: { value: BuildPromptInput | null },
    ): (input: BuildPromptInput) => Promise<AnalyzeRaceResult> {
      return async (input: BuildPromptInput) => {
        captured.value = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      };
    }

    it("deps.additionalInstruction を BuildPromptInput.additionalInstruction として渡すこと", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        analyze: analyzeCapturing(captured),
        additionalInstruction: "人気薄の複勝率は慎重に見積もること",
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);
      expect(captured.value!.additionalInstruction).toBe(
        "人気薄の複勝率は慎重に見積もること",
      );
    });

    it("deps.additionalInstructionが未指定ならBuildPromptInput.additionalInstructionはundefinedになること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);
      expect(captured.value!.additionalInstruction).toBeUndefined();
    });

    it("deps.additionalInstructionが空白のみならBuildPromptInput.additionalInstructionはundefinedになること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        analyze: analyzeCapturing(captured),
        additionalInstruction: "   \n  ",
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);
      expect(captured.value!.additionalInstruction).toBeUndefined();
    });

    it("前後の空白をトリムして渡すこと", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        analyze: analyzeCapturing(captured),
        additionalInstruction: "  トリム対象  ",
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);
      expect(captured.value!.additionalInstruction).toBe("トリム対象");
    });

    it("LLM有り: 保存レコードのadditionalInstructionに設定値(トリム済み)を記録すること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        analyze: analyzeCapturing(captured),
        additionalInstruction: "  人気薄の複勝率は慎重に見積もること  ",
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);
      expect(saved[0]!.additionalInstruction).toBe(
        "人気薄の複勝率は慎重に見積もること",
      );
    });

    it("設定が空なら保存レコードのadditionalInstructionはnullになること", async () => {
      const captured: { value: BuildPromptInput | null } = { value: null };
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        analyze: analyzeCapturing(captured),
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);
      expect(saved[0]!.additionalInstruction).toBeNull();
    });

    it("LLMスキップ時は保存レコードのadditionalInstructionがnullになること(プロンプト未使用)", async () => {
      const deps: AnalysisPipelineDeps = {
        ...baseDeps(),
        additionalInstruction: "設定されているがLLM未使用のため使われない",
      };
      await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps, onProgress);
      expect(saved[0]!.additionalInstruction).toBeNull();
    });
  });

  it("LLM有り(analyze注入): 補正後確率と根拠を採用し、EVは補正後確率で計算する", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: 0.5,
          reason: `根拠${h.umaban}`,
          clipped: false,
          usedPrior: false,
          mark: null,
        })),
        fallback: false,
        retryCount: 0,
        fallbackReason: null,
      }),
    );
    const deps: AnalysisPipelineDeps = { ...baseDeps(), analyze };

    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.llmUsed).toBe(true);
    expect(result.llmSkippedReason).toBeNull();
    for (const row of result.rows) {
      expect(row.adjustedProb).toBe(0.5);
      expect(row.reason).toBe(`根拠${row.umaban}`);
    }
    const row1 = result.rows.find((r) => r.umaban === 1)!;
    expect(row1.ev).toBeCloseTo(2.5, 8);
    expect(row1.isPositive).toBe(true);
    const row2 = result.rows.find((r) => r.umaban === 2)!;
    expect(row2.ev).toBeCloseTo(0.6, 8);
    expect(row2.isPositive).toBe(false);

    expect(saved[0]!.horses.every((h) => h.adjustedProb === 0.5)).toBe(true);
  });

  it("LLMプロンプトへ restInterval(直近走→開催日のレース間隔)を供給する", async () => {
    let captured: BuildPromptInput | null = null;
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => {
        captured = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      },
    );
    // 1番の直近走は 2026/06/28。開催日 2026/07/09 まで11日 → 「連闘〜中3週」。
    const scrape = vi.fn(async () =>
      fakeRaceData(RACE_ID, { 1: [fakeResult("2026/06/28")] }),
    );
    const deps: AnalysisPipelineDeps = { ...baseDeps(), analyze, scrape };

    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    const horse1 = captured!.horses.find((h) => h.umaban === 1)!;
    expect(horse1.restInterval).toBe("連闘〜中3週");
    const horse2 = captured!.horses.find((h) => h.umaban === 2)!;
    expect(horse2.restInterval ?? null).toBeNull();
  });

  it("LLMプロンプトへ runs.pace/runs.last3f(展開想定強化の材料)を供給する", async () => {
    let captured: BuildPromptInput | null = null;
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => {
        captured = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      },
    );
    const scrape = vi.fn(async () =>
      fakeRaceData(RACE_ID, {
        1: [
          fakeResult("2026/06/28", [1, 1], { pace: "29.9-37.6", last3f: 35.0 }),
        ],
      }),
    );
    const deps: AnalysisPipelineDeps = { ...baseDeps(), analyze, scrape };

    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    const horse1 = captured!.horses.find((h) => h.umaban === 1)!;
    expect(horse1.runs[0]!.pace).toBe("29.9-37.6");
    expect(horse1.runs[0]!.last3f).toBe(35.0);
    // 戦績が無い馬(2・3番)は runs が空配列のまま(落ちない)。
    const horse2 = captured!.horses.find((h) => h.umaban === 2)!;
    expect(horse2.runs).toEqual([]);
  });

  it("LLMプロンプトへ単勝オッズ・人気・複勝オッズ下限・参考EVを供給する(Task#22)", async () => {
    let captured: BuildPromptInput | null = null;
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => {
        captured = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      },
    );
    const deps: AnalysisPipelineDeps = { ...baseDeps(), analyze };

    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    // 1番: 単勝5.2倍・3番人気、複勝下限5.0 → 参考EV = prior × 5.0。
    const horse1 = captured!.horses.find((h) => h.umaban === 1)!;
    expect(horse1.winOdds).toBe(5.2);
    expect(horse1.popularity).toBe(3);
    expect(horse1.placeOddsMin).toBe(5.0);
    expect(horse1.referenceEv).toBeCloseTo(horse1.prior * 5.0, 8);

    // 3番: 単勝・複勝ともオッズ欠損 → winOdds/popularity/placeOddsMin/referenceEv すべて null。
    const horse3 = captured!.horses.find((h) => h.umaban === 3)!;
    expect(horse3.winOdds).toBeNull();
    expect(horse3.popularity).toBeNull();
    expect(horse3.placeOddsMin).toBeNull();
    expect(horse3.referenceEv).toBeNull();
  });

  it("予想オッズ(yoso・複勝未発売)でも単勝オッズは供給し、複勝オッズ下限・参考EVはnullにする(Task#22)", async () => {
    let captured: BuildPromptInput | null = null;
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => {
        captured = input;
        return {
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        };
      },
    );
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      analyze,
      scrape: vi.fn(async () => fakeRaceData(RACE_ID, {}, "yoso")),
    };

    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      deps,
      onProgress,
    );

    const horse1 = captured!.horses.find((h) => h.umaban === 1)!;
    expect(horse1.winOdds).toBe(5.2); // yosoでも単勝オッズは供給される。
    expect(horse1.popularity).toBe(3);
    expect(horse1.placeOddsMin).toBeNull(); // 複勝未発売。
    expect(horse1.referenceEv).toBeNull(); // 複勝オッズ下限が無いため算出不可。
  });

  it("LLMがフェイルセーフで prior にフォールバックした場合、result.fallback=true を返す", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: h.prior,
          reason: null,
          clipped: false,
          usedPrior: true,
          mark: null,
        })),
        fallback: true,
        retryCount: 1,
        fallbackReason: "JSONパースに2回失敗",
      }),
    );
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      { ...baseDeps(), analyze },
      onProgress,
    );
    expect(result.llmUsed).toBe(true);
    expect(result.fallback).toBe(true);
    // core(analyzeRace)が返した fallbackReason をそのまま AnalysisResult に伝播すること(論点C)。
    expect(result.fallbackReason).toBe("JSONパースに2回失敗");
    // フォールバック(LLM応答が不正でpriorへフォールバック)でも、プロンプト自体は送信されている
    // ため promptVersion は記録される(Task#27)。llmUsed に連動する仕様であり、fallback有無では
    // 変わらないことをここで固定する(code-reviewer指摘: 既存はresult.fallbackのみ検証していた)。
    expect(saved[0]!.promptVersion).toBe(PROMPT_VERSION);
    // 印と無関係な失敗(JSON破損等)のフォールバックでは marksDropped は発生しない。
    expect(result.marksDropped).toBe(false);
    expect(result.marksDroppedReason).toBeNull();
  });

  it("fallbackReason は保存レコード(AnalysisRecord)には含めないこと(論点D: marksDroppedReasonと同方針・live専用)", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: h.prior,
          reason: null,
          clipped: false,
          usedPrior: true,
          mark: null,
        })),
        fallback: true,
        retryCount: 1,
        fallbackReason: "JSONパースに2回失敗",
      }),
    );
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      { ...baseDeps(), analyze },
      onProgress,
    );
    expect(saved[0]).not.toHaveProperty("fallbackReason");
  });

  it("LLM成功時(fallback:false)は result.fallbackReason=null であること(不変条件)", async () => {
    const analyze = vi.fn(
      async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
        horses: input.horses.map((h) => ({
          umaban: h.umaban,
          prior: h.prior,
          adjustedProb: h.prior + 0.01,
          reason: "通常補正",
          clipped: false,
          usedPrior: false,
          mark: null,
        })),
        fallback: false,
        retryCount: 0,
        fallbackReason: null,
      }),
    );
    const result = await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      { ...baseDeps(), analyze },
      onProgress,
    );
    expect(result.fallback).toBe(false);
    expect(result.fallbackReason).toBeNull();
  });

  describe("onFallback(診断ログ配線用フック・論点E)", () => {
    it("fallback:true のとき onFallback を raceId・stopReason・診断メッセージ付きで1回呼ぶこと", async () => {
      const onFallback = vi.fn();
      const analyze = vi.fn(
        async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: true,
            mark: null,
          })),
          fallback: true,
          retryCount: 1,
          fallbackReason: "応答が長さ上限(max_tokens)で切り詰められたため、3着内率をそのまま採用しました",
          truncated: true,
          stopReason: "max_tokens",
          diagnosticMessage:
            "応答が長さ上限(max_tokens)で切り詰められたため、3着内率をそのまま採用しました",
        }),
      );
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze, onFallback },
        onProgress,
      );
      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(onFallback).toHaveBeenCalledWith({
        raceId: parseRaceId(RACE_ID),
        stopReason: "max_tokens",
        diagnosticMessage:
          "応答が長さ上限(max_tokens)で切り詰められたため、3着内率をそのまま採用しました",
      });
    });

    it("LLM成功時(fallback:false)は onFallback を呼ばないこと", async () => {
      const onFallback = vi.fn();
      const analyze = vi.fn(
        async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: "通常補正",
            clipped: false,
            usedPrior: false,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
        }),
      );
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze, onFallback },
        onProgress,
      );
      expect(onFallback).not.toHaveBeenCalled();
    });

    it("印関連違反によるA救済(fallback:false・marksDropped:true)でも onFallback を呼ばないこと", async () => {
      const onFallback = vi.fn();
      const analyze = vi.fn(
        async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: "通常補正",
            clipped: false,
            usedPrior: false,
            mark: null,
          })),
          fallback: false,
          retryCount: 1,
          fallbackReason: null,
          marksDropped: true,
          marksDroppedReason: "印関連の制約違反のため確率補正のみ採用",
        }),
      );
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze, onFallback },
        onProgress,
      );
      expect(onFallback).not.toHaveBeenCalled();
    });

    it("LLM無し(analyze=null)では onFallback を呼ばないこと", async () => {
      const onFallback = vi.fn();
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), onFallback },
        onProgress,
      );
      expect(onFallback).not.toHaveBeenCalled();
    });
  });

  describe("予想印の制約緩和後フォールバック分離(A: marksDropped伝播・2026-07-19合意)", () => {
    it("通常成功(core側でmarksDropped未指定)は result.marksDropped=false になること", async () => {
      const analyze = vi.fn(
        async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: "通常補正",
            clipped: false,
            usedPrior: false,
            mark: null,
          })),
          fallback: false,
          retryCount: 0,
          fallbackReason: null,
          // marksDropped は core 側の型では optional のため、ここでは意図的に未指定にする。
        }),
      );
      const result = await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze },
        onProgress,
      );
      expect(result.fallback).toBe(false);
      expect(result.marksDropped).toBe(false);
      expect(result.marksDroppedReason).toBeNull();
    });

    it("印関連違反によるA救済(core側でfallback:false・marksDropped:true)を result にそのまま伝播すること", async () => {
      const analyze = vi.fn(
        async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior + 0.05, // prior に戻さず、確率補正が有効なままであることを示す。
            reason: "調教良化",
            clipped: false,
            usedPrior: false,
            mark: null, // A救済では全馬 mark=null。
          })),
          fallback: false,
          retryCount: 1,
          fallbackReason: null,
          marksDropped: true,
          marksDroppedReason:
            "印関連の制約違反のため2回目応答でも印を採用できず、確率補正のみ採用して印は全馬nullにしました",
        }),
      );
      const result = await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze },
        onProgress,
      );
      // fallback:false のまま(確率補正は有効)、marksDropped:true が伝播すること。
      expect(result.fallback).toBe(false);
      expect(result.marksDropped).toBe(true);
      expect(result.marksDroppedReason).toBe(
        "印関連の制約違反のため2回目応答でも印を採用できず、確率補正のみ採用して印は全馬nullにしました",
      );
      // 確率補正(prior+0.05)が反映され、prior に戻されていないこと。
      const row1 = result.rows.find((r) => r.umaban === 1)!;
      expect(row1.adjustedProb).toBeCloseTo(row1.prior + 0.05, 8);
      // 全馬 mark=null が rows・保存レコードの双方に伝播すること。
      expect(result.rows.every((r) => r.mark === null)).toBe(true);
      expect(saved[0]!.horses.every((h) => h.mark === null)).toBe(true);
    });

    it("印関連違反によるA救済でも保存レコード(AnalysisRecord)には marksDropped を含めないこと(live専用、fallbackと同じ扱い)", async () => {
      const analyze = vi.fn(
        async (input: BuildPromptInput): Promise<AnalyzeRaceResult> => ({
          horses: input.horses.map((h) => ({
            umaban: h.umaban,
            prior: h.prior,
            adjustedProb: h.prior,
            reason: null,
            clipped: false,
            usedPrior: false,
            mark: null,
          })),
          fallback: false,
          retryCount: 1,
          fallbackReason: null,
          marksDropped: true,
          marksDroppedReason: "テスト理由",
        }),
      );
      await runAnalysis(
        parseRaceId(RACE_ID),
        parseKaisaiDate(KAISAI),
        { ...baseDeps(), analyze },
        onProgress,
      );
      // fallback 同様、DB保存レコード(AnalysisRecord)には marksDropped 系のキーを持たせない
      // (live結果〈AnalysisResult〉専用のシグナルとする)。
      expect(saved[0]).not.toHaveProperty("marksDropped");
      expect(saved[0]).not.toHaveProperty("marksDroppedReason");
    });
  });
});

describe("runAnalysis(NAR: 地方レースの分析)", () => {
  let saved: AnalysisRecord[];
  let progress: AnalysisProgress[];
  let baseDeps: () => AnalysisPipelineDeps;

  beforeEach(() => {
    (buildPriorInput as unknown as Mock).mockClear();
    saved = [];
    progress = [];
    baseDeps = () => ({
      scrape: vi.fn(async () => fakeRaceData(NAR_RACE_ID)),
      analyze: null,
      saveAnalysis: vi.fn((rec: AnalysisRecord) => {
        saved.push(rec);
        return saved.length;
      }),
      now: () => FIXED_NOW,
      llmSkipReason: "APIキー未設定",
    });
  });

  const onProgress = (p: AnalysisProgress): void => {
    progress.push(p);
  };

  it("地方(NAR)のレースIDでも分析が貫通し、会場名が地方の対応表から解決されること", async () => {
    const result = await runAnalysis(
      parseRaceId(NAR_RACE_ID),
      parseKaisaiDate("20260712"),
      baseDeps(),
      onProgress,
    );
    expect(result.venueName).toBe("高知");
    expect(result.rows).toHaveLength(3);
    expect(result.date).toBe("2026/07/12");
    expect(result.dateApproximate).toBe(false);
  });

  it("地方(NAR)の予想オッズ(yoso)でも単勝オッズから推定EVを算出できること(Task#25)", async () => {
    const deps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceData(NAR_RACE_ID, {}, "yoso")),
    };
    const result = await runAnalysis(
      parseRaceId(NAR_RACE_ID),
      parseKaisaiDate("20260712"),
      deps,
      onProgress,
    );
    expect(result.oddsStatus).toBe("yoso");
    const row1 = result.rows.find((r) => r.umaban === 1)!;
    expect(row1.evEstimated).toBe(true);
    // NARのyosoも中央と同じ単勝オッズ(5.2倍)を使うフィクスチャなので同じ推定値になる。
    expect(row1.placeOddsMin).toBeCloseTo(1.84, 8);
    expect(row1.ev).not.toBeNull();
  });

  it("buildPriorInput に venueKind: nar が渡ること", async () => {
    await runAnalysis(
      parseRaceId(NAR_RACE_ID),
      parseKaisaiDate("20260712"),
      baseDeps(),
      onProgress,
    );
    const calls = (buildPriorInput as unknown as Mock).mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[0].race.venueKind).toBe("nar");
      expect(call[0].race.venueName).toBe("高知");
    }
  });

  it("中央レースでは buildPriorInput に venueKind: central が渡ること(回帰確認)", async () => {
    const centralDeps: AnalysisPipelineDeps = {
      ...baseDeps(),
      scrape: vi.fn(async () => fakeRaceData(RACE_ID)),
    };
    await runAnalysis(
      parseRaceId(RACE_ID),
      parseKaisaiDate(KAISAI),
      centralDeps,
      onProgress,
    );
    const calls = (buildPriorInput as unknown as Mock).mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[0].race.venueKind).toBe("central");
    }
  });
});
