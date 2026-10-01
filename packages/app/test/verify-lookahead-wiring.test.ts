import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisStore,
  classifyLookaheadSuspicion,
  parseKaisaiDate,
  type AnalysisRecord,
  type RaceData,
} from "@keiba/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAnalysis, type AnalysisPipelineDeps } from "../src/main/analysis-pipeline.js";
import {
  createPipelineDeps,
  type PipelineResources,
} from "../src/main/pipeline-deps.js";
import type { VerifyReportView } from "../src/shared/analysis-types.js";

/**
 * 検証画面の集計へ「先読みリーク疑いの除外」を配線したこと(Issue #152 B)を、実 AnalysisStore
 * (一時ファイルの SQLite)と production の `createPipelineDeps` を通して固定する。
 *
 * core(A)は `VerifyConfig.excludeLookaheadSuspects`(既定 false)を用意しただけで、production は
 * まだ呼び出していなかった。`getVerifyReport`・`getVerifyReportByPromptVersion` のどちらの呼び出しでも
 * フラグを落とすと、利用者に見える集計が静かに旧来(除外なし)へ戻る。
 *
 * 行の保存は `deps.saveAnalysis`(production の保存経路)、結果の保存は同じファイルを開いた
 * 別の `AnalysisStore` で行う(`importResult` は実サイトへ取りに行くため使わない)。
 */

// ---------------------------------------------------------------------------
// 行の表
// ---------------------------------------------------------------------------

/** 中央の実在形式 raceId(2026年・場コード06・回次03・日次 nn・11R)。 */
function centralId(nn: number): string {
  return `20260603${String(nn).padStart(2, "0")}11`;
}
/** 地方の実在形式 raceId(2026年・場コード44・月日 mmdd・rr R)。 */
function narId(mmdd: string, rr: string): string {
  return `202644${mmdd}${rr}`;
}

/** 発走時刻つきスナップショット。 */
function snapshot(startTime: string | null): unknown {
  return { race: { raceName: "テスト", startTime }, horses: [] };
}

type Expected = "clean" | "suspect" | "unknown";

interface Row {
  readonly label: string;
  readonly expected: Expected;
  readonly record: Omit<AnalysisRecord, "horses">;
}

/** 両方の遮断印(戦績側・プロンプト側)。LLM 使用の新規分析が持つ印。 */
const MARKERS = { historyCutoffDate: "20260705", promptLookaheadGuarded: true } as const;

const ROWS: readonly Row[] = [
  {
    label: "A 中央・発走前(印なし)",
    expected: "clean",
    record: { raceId: centralId(1), kaisaiDate: "20260705", analyzedAt: "2026-07-05T05:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" },
  },
  {
    label: "B 中央・発走後だが両印あり(新規分析)",
    expected: "clean",
    record: { raceId: centralId(2), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1", ...MARKERS },
  },
  {
    label: "C 中央・発走後・印なし",
    expected: "suspect",
    record: { raceId: centralId(3), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" },
  },
  {
    label: "D 中央・同日・時刻なし・印なし(版不明)",
    expected: "unknown",
    record: { raceId: centralId(4), kaisaiDate: "20260705", analyzedAt: "2026-07-05T03:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: null },
  },
  {
    label: "E 地方・前日・時刻なし・印なし",
    expected: "clean",
    record: { raceId: narId("0715", "08"), kaisaiDate: null, analyzedAt: "2026-07-14T10:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: "v1" },
  },
  {
    label: "F 地方・発走後(20:50 JST ちょうど)・印なし(別の版)",
    expected: "suspect",
    record: { raceId: narId("0714", "12"), kaisaiDate: null, analyzedAt: "2026-07-14T11:50:00.000Z", raceSnapshot: snapshot("20:50"), promptVersion: "v2" },
  },
];

/** 各行は賭け金100円の配分を1点持つ。clean の行は的中(払戻200円)、それ以外は不的中。 */
function seed(r: PipelineResources, dbPath: string): void {
  for (const row of ROWS) {
    r.deps.saveAnalysis({
      horses: [
        { umaban: 1, prior: 0.5, adjustedProb: 0.5, placeOddsMin: 2.0, ev: 1.0, isPositive: true, contributions: null, mark: null },
      ],
      ...row.record,
    });
  }
  const resultStore = new AnalysisStore({ filename: dbPath });
  try {
    for (const row of ROWS) {
      const hit = row.expected === "clean";
      resultStore.saveResult(
        row.record.raceId,
        hit
          ? [
              { umaban: 1, finishPosition: 1, placePayout: 300 },
              { umaban: 2, finishPosition: 2, placePayout: 150 },
            ]
          : [
              { umaban: 1, finishPosition: 5 },
              { umaban: 2, finishPosition: 1, placePayout: 150 },
            ],
      );
    }
  } finally {
    resultStore.close();
  }
}

/** 全カウンタの和(= 分析総数)。 */
function counterSum(v: VerifyReportView): number {
  return (
    v.includedAnalysisCount +
    v.excludedAnalysisCount +
    v.supersededAnalysisCount +
    v.excludedEstimatedCount +
    v.excludedLookaheadSuspectCount +
    v.excludedLookaheadUnknownCount
  );
}

let tempDir: string;
let dbPath: string;
const resources: PipelineResources[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "keiba-verify-lookahead-"));
  dbPath = path.join(tempDir, "test.db");
});
afterEach(() => {
  for (const r of resources.splice(0)) {
    r.close();
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function open(): PipelineResources {
  const r = createPipelineDeps({ dbPath });
  resources.push(r);
  return r;
}

// ---------------------------------------------------------------------------
// 配線
// ---------------------------------------------------------------------------

describe("検証画面の集計への先読みリーク疑い除外の配線(Issue #152 B)", () => {
  it("前提: 表は clean 3・suspect 2・unknown 1 の6行で、中央4行・地方2行", () => {
    expect(ROWS).toHaveLength(6);
    expect(ROWS.filter((r) => r.expected === "clean")).toHaveLength(3);
    expect(ROWS.filter((r) => r.expected === "suspect")).toHaveLength(2);
    expect(ROWS.filter((r) => r.expected === "unknown")).toHaveLength(1);
    expect(ROWS.filter((r) => r.record.kaisaiDate === null)).toHaveLength(2);
  });

  it("前提: 表の期待分類が、保存済み行に対する core の分類と一致する(表がラベルどおりの行を保存している)", () => {
    const r = open();
    seed(r, dbPath);
    const store = new AnalysisStore({ filename: dbPath });
    try {
      const stored = store.listAnalyses();
      expect(stored).toHaveLength(ROWS.length);
      expect(stored.map((a) => classifyLookaheadSuspicion(a))).toEqual(ROWS.map((row) => row.expected));
    } finally {
      store.close();
    }
  });

  it("getVerifyReport: 既定(全体)で clean だけが集計され、suspect と unknown が別カウンタに入り、回収率が除外を反映する", () => {
    const r = open();
    seed(r, dbPath);
    const v = r.getVerifyReport();

    expect(v.includedAnalysisCount).toBe(3);
    expect(v.excludedLookaheadSuspectCount).toBe(2);
    expect(v.excludedLookaheadUnknownCount).toBe(1);
    expect(counterSum(v)).toBe(ROWS.length);
    // clean 3件はすべて的中(複勝300円)。除外した3件は不的中なので、混ざれば回収率が下がる。
    expect(v.bet.totalStake).toBe(300);
    expect(v.bet.totalReturn).toBe(900);
    expect(v.bet.recoveryRate).toBe(3);
    // 配分ベースも同じ母集団に追随する。
    expect(v.proposedBet.population.allocated + v.proposedBet.population.noRecord).toBe(3);
  });

  it("getVerifyReport: 開催区分フィルタ(central/nar)の経路でも除外が効き、中央+地方が全体に一致する", () => {
    const r = open();
    seed(r, dbPath);
    const all = r.getVerifyReport("all");
    const central = r.getVerifyReport("central");
    const nar = r.getVerifyReport("nar");

    // 前提: 地方の2行が実際に地方側へ入り、中央の4行が中央側へ入っている。
    expect(counterSum(nar)).toBe(2);
    expect(counterSum(central)).toBe(4);
    expect(central.includedAnalysisCount).toBe(2);
    expect(central.excludedLookaheadSuspectCount).toBe(1);
    expect(central.excludedLookaheadUnknownCount).toBe(1);
    expect(nar.includedAnalysisCount).toBe(1);
    expect(nar.excludedLookaheadSuspectCount).toBe(1);
    expect(nar.excludedLookaheadUnknownCount).toBe(0);
    expect(central.includedAnalysisCount + nar.includedAnalysisCount).toBe(all.includedAnalysisCount);
    expect(central.excludedLookaheadSuspectCount + nar.excludedLookaheadSuspectCount).toBe(
      all.excludedLookaheadSuspectCount,
    );
    expect(central.bet.recoveryRate).toBe(3);
    expect(nar.bet.recoveryRate).toBe(3);
  });

  it("getVerifyReportByPromptVersion: 各版グループにも同じ除外が効き、グループごとのカウンタの和が分析数に一致する", () => {
    const r = open();
    seed(r, dbPath);
    const groups = r.getVerifyReportByPromptVersion();
    const byVersion = new Map(groups.map((g) => [g.promptVersion, g.report] as const));

    expect(groups).toHaveLength(3);
    // v1: A(clean)・B(clean)・C(suspect)・E(clean)。
    const v1 = byVersion.get("v1")!;
    expect(v1.includedAnalysisCount).toBe(3);
    expect(v1.excludedLookaheadSuspectCount).toBe(1);
    expect(v1.excludedLookaheadUnknownCount).toBe(0);
    expect(counterSum(v1)).toBe(4);
    expect(v1.bet.recoveryRate).toBe(3);
    // v2: F(suspect)のみ。集計対象は0で、回収率は出ない。
    const v2 = byVersion.get("v2")!;
    expect(v2.includedAnalysisCount).toBe(0);
    expect(v2.excludedLookaheadSuspectCount).toBe(1);
    expect(counterSum(v2)).toBe(1);
    expect(v2.bet.recoveryRate).toBeNull();
    // 版不明: D(unknown)のみ。
    const none = byVersion.get(null)!;
    expect(none.includedAnalysisCount).toBe(0);
    expect(none.excludedLookaheadUnknownCount).toBe(1);
    expect(counterSum(none)).toBe(1);
  });

  it("除外は表示用の集計だけに効き、保存された分析行そのものは減らない(削除確認の件数の母集団)", () => {
    const r = open();
    seed(r, dbPath);
    r.getVerifyReport();
    r.getVerifyReportByPromptVersion();
    const store = new AnalysisStore({ filename: dbPath });
    try {
      expect(store.listAnalyses()).toHaveLength(ROWS.length);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// スナップショットの形のずれの検査
// ---------------------------------------------------------------------------

describe("buildRaceSnapshot が保存する race.startTime を core の分類が読めること(Issue #152 B)", () => {
  function loadFixture(fileName: string): RaceData {
    const url = new URL(
      `../../../docs/investigations/combo-odds-real-fetch/${fileName}`,
      import.meta.url,
    );
    return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as RaceData;
  }

  /** 実フィクスチャのレースを production の保存経路(runAnalysis → deps.saveAnalysis)で保存し、保存済み行を返す。 */
  async function analyzeAndStore(
    raceData: RaceData,
    kaisaiDate: string | null,
    now: Date,
  ): Promise<ReturnType<AnalysisStore["listAnalyses"]>[number]> {
    const r = open();
    const deps: AnalysisPipelineDeps = {
      ...r.deps,
      scrape: async () => raceData,
      analyze: null,
      allocationSettings: null,
      now: () => now,
    };
    await runAnalysis(
      raceData.raceId,
      kaisaiDate === null ? null : parseKaisaiDate(kaisaiDate),
      deps,
    );
    const store = new AnalysisStore({ filename: dbPath });
    try {
      const stored = store.listAnalyses();
      expect(stored).toHaveLength(1);
      return stored[0]!;
    } finally {
      store.close();
    }
  }

  /** 遮断印を外した写し(旧行を模す)を分類する。印があると発走時刻を見ずに clean になるため。 */
  function classifyWithoutMarkers(stored: Awaited<ReturnType<typeof analyzeAndStore>>) {
    return classifyLookaheadSuspicion({
      ...stored,
      historyCutoffDate: null,
      promptLookaheadGuarded: null,
    });
  }

  it("中央(15:45発走): 保存された race.startTime が分類で読まれ、発走の1分前は clean・発走ちょうどは suspect(unknown に落ちない)", async () => {
    const raw = loadFixture("central-on.json");
    // 前提: フィクスチャは発走時刻を持つ(15:45 JST = 06:45Z)。
    expect(raw.race.startTime).toBe("15:45");

    const before = await analyzeAndStore(raw, "20260628", new Date("2026-06-28T06:44:59.000Z"));
    expect((before.raceSnapshot as { race: { startTime: unknown } }).race.startTime).toBe("15:45");
    expect(classifyWithoutMarkers(before)).toBe("clean");
    resources.splice(0).forEach((x) => x.close());
    rmSync(dbPath);

    const atStart = await analyzeAndStore(raw, "20260628", new Date("2026-06-28T06:45:00.000Z"));
    expect(classifyWithoutMarkers(atStart)).toBe("suspect");
  });

  it("地方(20:50発走): 開催日は raceId から決まり、発走時刻が読まれて前後が判定される", async () => {
    const raw = loadFixture("nar-on.json");
    expect(raw.race.startTime).toBe("20:50");

    // 20:50 JST = 11:50Z。kaisaiDate を渡さない(地方は raceId の月日から決まる)。
    const before = await analyzeAndStore(raw, null, new Date("2026-07-12T11:49:59.000Z"));
    expect(classifyWithoutMarkers(before)).toBe("clean");
    resources.splice(0).forEach((x) => x.close());
    rmSync(dbPath);

    const atStart = await analyzeAndStore(raw, null, new Date("2026-07-12T11:50:00.000Z"));
    expect(classifyWithoutMarkers(atStart)).toBe("suspect");
  });

  it("production で保存した新規分析は両方の遮断印を持ち、発走後に分析しても clean として集計される", async () => {
    const raw = loadFixture("central-on.json");
    const stored = await analyzeAndStore(raw, "20260628", new Date("2026-06-28T07:00:00.000Z"));
    expect(stored.historyCutoffDate).not.toBeNull();
    expect(stored.promptLookaheadGuarded).toBe(true);
    expect(classifyLookaheadSuspicion(stored)).toBe("clean");
    // 印が無ければ同じ行は suspect(印が効いていることの対照。差が0でない)。
    expect(classifyWithoutMarkers(stored)).toBe("suspect");
  });
});
