import { describe, expect, it } from "vitest";

import {
  computeConditionChangeTags,
  parseRaceId,
  type AnalysisRecord,
  type BuildPromptInput,
  type RaceData,
} from "../../src/index.js";
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../../src/analysis/analysis-pipeline.js";
import type { AnalysisProgress, AnalysisResult } from "../../src/analysis/analysis-types.js";
import {
  ALL_BETS_SETTINGS,
  FIXED_NOW,
  KAISAI_DATE,
  RACE_ID,
  sameDayDetailOf,
  scrapeFixtureRace,
  stubAnalyze,
} from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #400(R-10a。親は #390): runAnalysis を段ごとの関数(analysis-llm-materials.ts・analysis-record.ts)に分割した際の特性テスト。
 * 分割の前後で変わらないことを、変異注入(分割後の関数に 1 つずつ変異を入れて既存テストが落ちるかを見る作業)で確かめたところ、
 * 既存テストが見ていなかった 7 件(下の各 describe)をここへ足した。いずれも分割前の eef585e のコードで緑になる(振る舞いは変えていない)。
 * 入力は golden と同じ実フィクスチャ(中央16頭 202603020211)と固定の合成値で、実ネットワーク・実 API には触れない。
 */

const NAR_RACE_ID = parseRaceId("202654071210");

interface Captured {
  readonly result: AnalysisResult;
  readonly record: AnalysisRecord;
  /** 呼び出しの順序ログ(進捗通知・now()・各 deps の呼び出しを 1 本にまとめる)。 */
  readonly events: string[];
}

async function runCaptured(
  overrides: Partial<AnalysisPipelineDeps>,
  options: { readonly raceId?: ReturnType<typeof parseRaceId>; readonly mutate?: (race: RaceData) => RaceData } = {},
): Promise<Captured> {
  const base = await scrapeFixtureRace();
  const race = options.mutate ? options.mutate(structuredClone(base)) : base;
  const events: string[] = [];
  const saved: AnalysisRecord[] = [];
  const deps: AnalysisPipelineDeps = {
    scrape: async () => {
      events.push("scrape");
      return race;
    },
    analyze: null,
    saveAnalysis: (record) => {
      events.push("save");
      saved.push(record);
      return saved.length;
    },
    allocationSettings: null,
    now: () => {
      events.push("now");
      return FIXED_NOW();
    },
    llmSkipReason: "テスト用の理由",
    ...overrides,
  };
  const result = await runAnalysis(
    options.raceId ?? RACE_ID,
    KAISAI_DATE,
    deps,
    (p: AnalysisProgress) => events.push(`progress:${p.stage}:${p.message}`),
  );
  expect(saved).toHaveLength(1);
  return { result, record: saved[0]!, events };
}

/** 呼び出し順を記録する LLM スタブ(stubAnalyze を包む)。 */
function loggingAnalyze(events: string[]): NonNullable<AnalysisPipelineDeps["analyze"]> {
  const inner = stubAnalyze([]);
  return async (input) => {
    events.push("analyze");
    return inner(input);
  };
}

describe("進捗通知の順序と now() の呼び出し回数・位置(分割の前後で不変。Issue #400 R-10a)", () => {
  it("前提(空振り防止): フィクスチャは16頭である", async () => {
    const race = await scrapeFixtureRace();
    expect(race.horses).toHaveLength(16);
  });

  it("LLM なし: 通知 → scrape → 通知 → (頭ごとに 通知→now) → LLM スキップ通知 → now(analyzedAt) → 保存通知 → save の順で、now は 17 回", async () => {
    const out = await runCaptured({});
    const scoring = Array.from({ length: 16 }, (_, i) => [
      `progress:スコアリング:スコアリング中(${i + 1}/16頭)`,
      "now",
    ]).flat();
    expect(out.events).toEqual([
      "progress:スクレイピング:レースデータを取得しています…",
      "scrape",
      "progress:スクレイピング:レースデータを取得しました(16頭)",
      ...scoring,
      "progress:LLM分析:LLM分析をスキップしました(テスト用の理由)",
      "now",
      "progress:保存:分析結果を保存しています…",
      "save",
    ]);
    expect(out.events.filter((e) => e === "now")).toHaveLength(17);
  });

  it("LLM あり: 「LLM分析」の通知が、当日傾向・重賞傾向・馬場の読み出しと analyze より前に出る(材料集めより前)", async () => {
    const merged = await runMerged();
    const iNotice = merged.indexOf("progress:LLM分析:LLMで複勝確率を補正しています…");
    const iFirstDetail = merged.findIndex((e) => e.startsWith("detail:"));
    const iGrade = merged.indexOf("grade");
    const iBaba = merged.indexOf("baba");
    const iAnalyze = merged.indexOf("analyze");
    const iSaveNotice = merged.indexOf("progress:保存:分析結果を保存しています…");
    expect(iNotice).toBeGreaterThan(-1);
    expect(iFirstDetail).toBeGreaterThan(iNotice);
    expect(iGrade).toBeGreaterThan(iFirstDetail);
    expect(iBaba).toBeGreaterThan(iGrade);
    expect(iAnalyze).toBeGreaterThan(iBaba);
    expect(iSaveNotice).toBeGreaterThan(iAnalyze);
    // 当日傾向は自レース(11R)より前の 01〜10R だけを、この順に引く
    expect(merged.filter((e) => e.startsWith("detail:"))).toHaveLength(10);
    // 材料集めの間に now() が呼ばれない(頭ごとの 16 回と analyzedAt の 1 回だけ)
    expect(merged.filter((e) => e === "now")).toHaveLength(17);
    // analyzedAt の now() は、analyze の後・保存通知の直前
    expect(merged[iSaveNotice - 1]).toBe("now");
  });
});

/** deps 内のログと進捗・now() を 1 本の時系列に統合して返す(LLM あり・全依存あり)。 */
async function runMerged(): Promise<string[]> {
  const race = await scrapeFixtureRace();
  const events: string[] = [];
  await runAnalysis(
    RACE_ID,
    KAISAI_DATE,
    {
      scrape: async () => race,
      analyze: loggingAnalyze(events),
      saveAnalysis: () => {
        events.push("save");
        return 1;
      },
      allocationSettings: null,
      now: () => {
        events.push("now");
        return FIXED_NOW();
      },
      getRaceResultDetail: (id) => {
        events.push(`detail:${id}`);
        return sameDayDetailOf(id);
      },
      getGradeWinnerTrend: async () => {
        events.push("grade");
        return null;
      },
      getBabaConditions: () => {
        events.push("baba");
        return null;
      },
    },
    (p) => events.push(`progress:${p.stage}:${p.message}`),
  );
  return events;
}

describe("LLM の応答に生応答テキストが無いときは、保存レコードの rawResponse が null になる(undefined にならない)", () => {
  it("analyze の結果に rawResponse が無い → record.rawResponse は null", async () => {
    const out = await runCaptured({
      analyze: async (input) => {
        const full = await stubAnalyze([])(input);
        const { rawResponse: _omitted, ...rest } = full;
        return rest;
      },
    });
    expect(out.record.rawResponse).toBeNull();
  });
});

describe("地方(NAR)の raceId では、開催区分が地方として LLM の入力・結果行・馬場の読み出しに効く", () => {
  it("馬場は読まない(中央だけ)、LLM 入力の venueKind は nar、結果行の条件替わりタグは地方の基準で算出される", async () => {
    let babaCalls = 0;
    const babaErrors: unknown[] = [];
    const captured: BuildPromptInput[] = [];
    const out = await runCaptured(
      {
        analyze: stubAnalyze(captured),
        getBabaConditions: () => {
          babaCalls += 1;
          return null;
        },
        onBabaError: (info) => babaErrors.push(info),
      },
      { raceId: NAR_RACE_ID },
    );
    expect(babaCalls).toBe(0);
    // 読まないだけで、失敗として警告フックに流れることもない
    expect(babaErrors).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.race.venueKind).toBe("nar");
    const race = await scrapeFixtureRace();
    // 前提: 中央として算出したタグと、地方として算出したタグが、少なくとも1頭で異なる(差が0でない)
    const tagsAs = (kind: "central" | "nar") =>
      race.horses
        .map((h) => ({
          umaban: h.shutuba.umaban,
          tags: computeConditionChangeTags({
            currentCourseType: race.race.courseType,
            currentDistance: race.race.distance,
            currentVenueKind: kind,
            pastRuns: (h.results ?? []).map((r) => ({
              courseType: r.courseType,
              distance: r.distance,
              venueKind: r.venueKind,
            })),
          }),
        }))
        .sort((a, b) => a.umaban - b.umaban);
    const asNar = tagsAs("nar");
    const asCentral = tagsAs("central");
    expect(asNar.some((n, i) => JSON.stringify(n.tags) !== JSON.stringify(asCentral[i]!.tags))).toBe(true);
    expect(out.result.rows.map((r) => ({ umaban: r.umaban, tags: r.conditionChangeTags }))).toEqual(asNar);
  });
});

describe("結果行は馬番昇順、保存レコードの馬は取得した順のまま", () => {
  it("取得した馬の並びを逆順にしても、rows は馬番昇順で、record.horses は逆順のまま", async () => {
    const out = await runCaptured({}, { mutate: (race) => ({ ...race, horses: [...race.horses].reverse() }) });
    const umabans = out.result.rows.map((r) => r.umaban);
    // 前提: 昇順に並べ替えが必要な入力である(逆順の入力では、並べ替えなしだと降順になる)
    expect(umabans).toHaveLength(16);
    expect([...umabans].sort((a, b) => a - b)).toEqual(umabans);
    expect(umabans[0]).toBeLessThan(umabans[15]!);
    expect(out.record.horses.map((h) => h.umaban)).toEqual([...umabans].reverse());
  });
});

describe("配分を計算しない呼び出しでは、保存レコードに allocation のキー自体が無い", () => {
  it("allocationSettings=null: 'allocation' in record が false / 非 null: true", async () => {
    const off = await runCaptured({});
    expect("allocation" in off.record).toBe(false);
    const on = await runCaptured({ allocationSettings: ALL_BETS_SETTINGS });
    expect("allocation" in on.record).toBe(true);
    expect(on.record.allocation).toBeDefined();
  });
});
