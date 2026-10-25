/**
 * combo-stats.test.ts — Issue #296(配分の提案に、組合せの券種ごとのオッズ・EV プラス・配分の点数を出す)の書き込み側。
 *
 * 配分の計算(`buildMixedRaceAllocationWithOutcome`)は候補の診断(券種ごとの EV プラス・判定できた点数)を作るが、D1 には保存されない。
 * このタスクで (1) 診断を `MixedRaceAllocationOutcome.candidateDiagnostics` に載せ、(2) 券種ごとの `{ positive, judged }` に縮めた `comboStats` を
 * R2 のスナップショット(`raceSnapshot.comboStats`)に残す。読み出し(`normalizeComboStats`)は不正な値を捨てて整える。
 */
import { describe, expect, it } from "vitest";

import type { AnalysisRow } from "../../src/analysis/analysis-types.js";
import {
  buildComboStats,
  COMBO_STATS_BET_TYPES,
  COMBO_STATS_SNAPSHOT_KEY,
  normalizeComboStats,
} from "../../src/analysis/combo-stats.js";
import type { MixedCandidateBuildInput } from "../../src/analysis/mixed-candidates.js";
import {
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
  type MixedRaceAllocationOutcome,
} from "../../src/analysis/mixed-race-allocation.js";
import { buildAllocationBetComboKey } from "../../src/ev/combo-bet-allocation.js";

function row(umaban: number, adjustedProb: number): AnalysisRow {
  return {
    umaban,
    wakuban: ((umaban - 1) % 8) + 1,
    horseName: `${umaban}番`,
    prior: 0.3,
    adjustedProb,
    placeOddsMin: 3,
    winOdds: 1000,
    ev: 1.5,
    isPositive: true,
    reason: null,
    highlights: [],
    concerns: [],
    careerRunCount: 999,
    mark: null,
    evEstimated: false,
    conditionChangeTags: [],
  };
}

function settings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    minHitProb: 0, // Issue #470: 既存のテストは下限なしで固定する
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

/** ワイド: 全ペア。奇数番の組み合わせは高オッズ(EVプラス)、それ以外は 1.1 倍(EV 非プラス)にして、プラスと非プラスの両方が出るようにする。 */
function widePairs(n: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const a of range(n)) {
    for (const b of range(n)) {
      if (a < b) record[buildAllocationBetComboKey("wide", [a, b])] = a % 2 === 1 ? 500 : 1.1;
    }
  }
  return record;
}

function trifectaTriples(n: number, odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const a of range(n)) {
    for (const b of range(n)) {
      for (const c of range(n)) {
        if (a !== b && b !== c && a !== c) record[buildAllocationBetComboKey("trifecta", [a, b, c])] = odds;
      }
    }
  }
  return record;
}

function race(overrides: Partial<MixedCandidateBuildInput> = {}): MixedCandidateBuildInput {
  return { oddsStatus: "result", rows: range(8).map((u) => row(u, 0.375)), wideCombo: widePairs(8), ...overrides };
}

function mixedOutcome(s: Partial<MixedAllocationSettings> = {}): MixedRaceAllocationOutcome {
  return buildMixedRaceAllocationWithOutcome(race(), settings(s));
}

describe("MixedRaceAllocationOutcome.candidateDiagnostics(Issue #296)", () => {
  it("mixed の経路では、view.diagnostics と同じ診断(ワイドに実際のプラス・非プラスの判定がある)が載る", () => {
    const outcome = mixedOutcome();
    expect(outcome.view.kind).toBe("mixed");
    if (outcome.view.kind !== "mixed") throw new Error("mixed のはず");
    expect(outcome.candidateDiagnostics).toBe(outcome.view.diagnostics);
    const wide = outcome.candidateDiagnostics!.wide;
    expect(wide.kind).toBe("built");
    if (wide.kind !== "built") throw new Error("built のはず");
    // 前提固定(空振り防止): プラスも非プラスも 1 点以上ある。
    expect(wide.build.judged.positiveCount).toBeGreaterThan(0);
    expect(wide.build.judged.notPositiveCount).toBeGreaterThan(0);
  });

  it("no-combo-candidates のフォールバック(place-only)でも診断が載る(組合せの候補は 0 点)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome({ oddsStatus: "result", rows: range(8).map((u) => row(u, 0.375)) }, settings());
    expect(outcome.outcome.route).toBe("place-only");
    expect(outcome.outcome.fallbackReason).toBe("no-combo-candidates");
    const diag = outcome.candidateDiagnostics;
    expect(diag).toBeDefined();
    expect(diag!.trifecta.kind).toBe("built");
    if (diag!.trifecta.kind !== "built") throw new Error("built のはず");
    expect(diag!.trifecta.build.judged.positiveCount).toBe(0);
  });

  it("候補を作る前に決まる経路(unset・yoso・組合せオッズ取得 OFF・組合せ券種すべて OFF)では載らない", () => {
    const cases: Array<[string, MixedRaceAllocationOutcome]> = [
      ["unset", buildMixedRaceAllocationWithOutcome(race(), settings({ bankroll: 0, perRaceCap: 0 }))],
      ["yoso", buildMixedRaceAllocationWithOutcome(race({ oddsStatus: "yoso" }), settings())],
      ["combo-odds-not-requested", buildMixedRaceAllocationWithOutcome(race(), settings({ includeComboOdds: false }))],
      [
        "combo-bet-types-off",
        buildMixedRaceAllocationWithOutcome(
          race(),
          settings({
            includeWideInAllocation: false,
            includeTrioInAllocation: false,
            includeQuinellaInAllocation: false,
            includeExactaInAllocation: false,
            includeTrifectaInAllocation: false,
            includeBracketQuinellaInAllocation: false,
          }),
        ),
      ],
    ];
    expect(cases.map(([, o]) => o.outcome.route === "unset" || o.outcome.route === "yoso" || o.outcome.fallbackReason !== null)).toEqual([true, true, true, true]);
    for (const [name, outcome] of cases) {
      expect(outcome.candidateDiagnostics, name).toBeUndefined();
    }
  });
});

describe("buildComboStats(Issue #296)", () => {
  it("券種ごとに { positive: EV プラスの点数, judged: 判定できた点数(プラス+非プラス) } を、診断の値から作る", () => {
    const outcome = mixedOutcome();
    const wide = outcome.candidateDiagnostics!.wide;
    if (wide.kind !== "built") throw new Error("built のはず");
    const stats = buildComboStats(outcome);
    expect(stats).not.toBeNull();
    const { positiveCount, notPositiveCount } = wide.build.judged;
    expect(positiveCount).toBeGreaterThan(0);
    expect(notPositiveCount).toBeGreaterThan(0);
    // 判定できた点数はプラス+非プラス(positive と同じ値にも、非プラスだけの値にもならない)。
    expect(stats!.wide).toEqual({ positive: positiveCount, judged: positiveCount + notPositiveCount });
    expect(stats!.wide!.judged).not.toBe(stats!.wide!.positive);
  });

  it("候補を作らなかった券種(配分に含めない設定)は入れない。作った券種は 0 点でも入る", () => {
    const stats = buildComboStats(mixedOutcome({ includeTrifectaInAllocation: false, includeExactaInAllocation: false }))!;
    expect(Object.keys(stats).sort()).toEqual(["bracketQuinella", "quinella", "trio", "wide"]);
    // オッズが無い券種(馬連・枠連・三連複)は、作ったが判定できた点数が 0 点。
    expect(stats.quinella).toEqual({ positive: 0, judged: 0 });
    expect(stats.trio).toEqual({ positive: 0, judged: 0 });
  });

  it("no-combo-candidates のフォールバックでも、含めた券種が { positive: 0, judged: 0 } で入る", () => {
    const outcome = buildMixedRaceAllocationWithOutcome({ oddsStatus: "result", rows: range(8).map((u) => row(u, 0.375)) }, settings());
    const stats = buildComboStats(outcome)!;
    expect(stats).not.toBeNull();
    expect(Object.keys(stats).sort()).toEqual([...COMBO_STATS_BET_TYPES].sort());
    for (const type of COMBO_STATS_BET_TYPES) {
      expect(stats[type], type).toEqual({ positive: 0, judged: 0 });
    }
  });

  it("診断が載っていない経路(unset など)は null", () => {
    expect(buildComboStats(buildMixedRaceAllocationWithOutcome(race(), settings({ bankroll: 0, perRaceCap: 0 })))).toBeNull();
    expect(buildComboStats(buildMixedRaceAllocationWithOutcome(race({ oddsStatus: "yoso" }), settings()))).toBeNull();
  });

  it("順序の確率が定まらない形(固定馬 2 頭以上)では、三連単はオッズがあっても judged 0 になる(「EV プラス 0 点」と区別できる)", () => {
    const probs = [1, 1, 0.5, 0.3, 0.2];
    const outcome = buildMixedRaceAllocationWithOutcome(
      { oddsStatus: "result", rows: probs.map((p, i) => row(i + 1, p)), trifectaCombo: trifectaTriples(5, 500) },
      settings(),
    );
    const trifecta = outcome.candidateDiagnostics!.trifecta;
    if (trifecta.kind !== "built") throw new Error("built のはず");
    expect(trifecta.build.enumeratedCount).toBe(60); // 前提固定: 60 通りを列挙し、オッズも全部ある
    expect(buildComboStats(outcome)!.trifecta).toEqual({ positive: 0, judged: 0 });
  });

  it("三連単が実際にプラスになる形では、positive が診断の値になる(券種を取り違えない)", () => {
    const outcome = buildMixedRaceAllocationWithOutcome(
      { oddsStatus: "result", rows: range(8).map((u) => row(u, 0.375)), wideCombo: widePairs(8), trifectaCombo: trifectaTriples(8, 3000) },
      settings(),
    );
    const stats = buildComboStats(outcome)!;
    const trifecta = outcome.candidateDiagnostics!.trifecta;
    if (trifecta.kind !== "built") throw new Error("built のはず");
    expect(trifecta.build.judged.positiveCount).toBeGreaterThan(0);
    expect(stats.trifecta).toEqual({ positive: trifecta.build.judged.positiveCount, judged: trifecta.build.judged.positiveCount + trifecta.build.judged.notPositiveCount });
    expect(stats.trifecta).not.toEqual(stats.wide);
  });
});

describe("normalizeComboStats(Issue #296。R2 から読んだ unknown を整える)", () => {
  it("キー名はスナップショットに入れる名前", () => {
    expect(COMBO_STATS_SNAPSHOT_KEY).toBe("comboStats");
  });

  it("正しい値はそのまま返す(許可した券種だけ)", () => {
    expect(normalizeComboStats({ wide: { positive: 3, judged: 10 }, trifecta: { positive: 0, judged: 0 } })).toEqual({
      wide: { positive: 3, judged: 10 },
      trifecta: { positive: 0, judged: 0 },
    });
  });

  it("オブジェクトでない・null・配列は null", () => {
    for (const raw of [null, undefined, "x", 3, [], true]) {
      expect(normalizeComboStats(raw), String(raw)).toBeNull();
    }
  });

  it("不正な項目は捨てる(未知の券種・負数・小数・judged < positive・数でない・余計なキー)。有効な項目が残らなければ null", () => {
    expect(
      normalizeComboStats({
        wide: { positive: 3, judged: 10, extra: "SECRET" },
        win: { positive: 1, judged: 1 },
        quinella: { positive: -1, judged: 4 },
        exacta: { positive: 1.5, judged: 4 },
        trio: { positive: 5, judged: 4 },
        bracketQuinella: { positive: "1", judged: 4 },
        trifecta: null,
      }),
    ).toEqual({ wide: { positive: 3, judged: 10 } });
    expect(normalizeComboStats({ wide: { positive: 5, judged: 4 } })).toBeNull();
    expect(normalizeComboStats({})).toBeNull();
  });
});
