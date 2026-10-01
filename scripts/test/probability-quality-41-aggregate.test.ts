import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateObservations,
  summarizeFetchRuns,
  AGGREGATE_BOOTSTRAP,
  AGGREGATE_PERMUTATION,
  loadObservations,
} from "../probability-quality-41/aggregate.js";
import type { RunManifest } from "../probability-quality-41/run.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type HorseObservation,
  type RaceObservation,
  type RaceObservationExcluded,
  type RaceObservationOk,
} from "../probability-quality-41/observation.js";

/**
 * 集計(オフライン)のテスト。観測 JSON だけから再計算できること、中央・地方を混ぜないこと、
 * 市場比較の対象条件(8頭以上・確定オッズ・1超の除外)が観測の段階で効くこと(合成データ。
 * 実サイトへのリクエストは含まない)。
 */

const ODDS8 = [1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0, 15.0];

/** 馬ごとの観測。prior・outcome・オッズ下限を渡す(上限は下限と同じ)。 */
function horse(umaban: number, prior: number, outcome: 0 | 1, oddsMin: number | null, fetched = true): HorseObservation {
  return {
    umaban,
    horseName: `H${umaban}`,
    prior,
    placeOddsMin: oddsMin,
    placeOddsMax: oddsMin,
    finish: { kind: "順位", value: outcome === 1 ? 1 : 9 },
    outcome,
    resultsFetched: fetched,
    usedRunCount: fetched ? 5 : null,
  };
}

function okRace(
  raceId: string,
  region: "central" | "nar",
  horses: readonly HorseObservation[],
  over: Partial<RaceObservationOk> = {},
): RaceObservationOk {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    status: "ok",
    raceId,
    region,
    requestedDate: "20260926",
    kaisaiDate: "20260926",
    venueCode: raceId.slice(4, 6),
    raceNumber: 1,
    raceName: raceId,
    listedEntryCount: horses.length,
    courseType: "ダ",
    distance: 1200,
    runnerCount: horses.length,
    placedCount: horses.filter((h) => h.outcome === 1).length,
    oddsStatus: region === "central" ? "result" : "middle",
    horses,
    scratched: [],
    conditions: {
      priorSource: "prior-only",
      dateApproximate: false,
      leakFilter: {
        cutoffDate: "2026/09/26",
        totalResultCount: 100,
        removedCount: 3,
        removedByCutoffCount: 3,
        removedByInvalidDateCount: 0,
      },
      placeOddsKind: "placeOddsMinLowerBound",
    },
    warnings: [],
    resultsFailedHorseCount: horses.filter((h) => !h.resultsFetched).length,
    fetchedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

/** 8頭の標準レース: prior を人気順に降順(市場と順位が一致)または昇順(逆)にする。 */
function race8(raceId: string, region: "central" | "nar", order: "same" | "reverse", over: Partial<RaceObservationOk> = {}) {
  const priors = [0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1];
  const outcomes: Array<0 | 1> = [1, 1, 0, 1, 0, 0, 0, 0];
  const hs = ODDS8.map((o, i) =>
    horse(i + 1, order === "same" ? priors[i]! : priors[7 - i]!, outcomes[i]!, o),
  );
  return okRace(raceId, region, hs, over);
}

function excludedRace(raceId: string, region: "central" | "nar", reason: RaceObservationExcluded["reason"]): RaceObservationExcluded {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    status: "excluded",
    raceId,
    region,
    requestedDate: "20260926",
    kaisaiDate: "20260926",
    venueCode: raceId.slice(4, 6),
    raceNumber: 2,
    raceName: raceId,
    listedEntryCount: 10,
    reason,
    detail: "テスト",
    fetchedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("aggregateObservations: 中央と地方を混ぜない", () => {
  it("地域ごとに別の集計を返し、レース数・観測数が合う", () => {
    const obs: RaceObservation[] = [
      race8("202606050101", "central", "same"),
      race8("202606050102", "central", "reverse"),
      race8("202654071201", "nar", "same"),
    ];
    const agg = aggregateObservations(obs);
    expect(agg.central.okRaceCount).toBe(2);
    expect(agg.central.observationCount).toBe(16);
    expect(agg.nar.okRaceCount).toBe(1);
    expect(agg.nar.observationCount).toBe(8);
    expect(agg.central.brier.raceCount).toBe(2);
    expect(agg.nar.brier.raceCount).toBe(1);
  });

  it("計測条件を同梱する(LLM なし・乱数条件・用いた観測の件数)", () => {
    const agg = aggregateObservations([race8("202606050101", "central", "same")]);
    expect(agg.conditions.priorSource).toBe("prior-only");
    expect(agg.conditions.bootstrap).toEqual(AGGREGATE_BOOTSTRAP);
    expect(agg.conditions.permutation).toEqual(AGGREGATE_PERMUTATION);
    expect(AGGREGATE_BOOTSTRAP).toEqual({ iterations: 10000, seed: 20261001 });
    expect(AGGREGATE_PERMUTATION).toEqual({ iterations: 1000, seed: 20261001 });
    expect(agg.central.brier.conditions.priorSource).toBe("prior-only");
  });
});

describe("aggregateObservations: 観測から外したレース", () => {
  it("理由別の件数と一覧を出し、観測数には含めない", () => {
    const obs: RaceObservation[] = [
      race8("202606050101", "central", "same"),
      excludedRace("202606050102", "central", "result-not-confirmed"),
      excludedRace("202606050103", "central", "unclassified-finish"),
      excludedRace("202606050104", "central", "unclassified-finish"),
    ];
    const c = aggregateObservations(obs).central;
    expect(c.okRaceCount).toBe(1);
    expect(c.excludedRaceCount).toBe(3);
    expect(c.excludedByReason).toEqual({ "result-not-confirmed": 1, "unclassified-finish": 2 });
    expect(c.excludedRaces.map((e) => e.raceId)).toEqual(["202606050102", "202606050103", "202606050104"]);
    expect(c.observationCount).toBe(8);
  });

  it("レースが0件の地域でも落ちず、指標は reason 付き null", () => {
    const agg = aggregateObservations([race8("202606050101", "central", "same")]);
    expect(agg.nar.okRaceCount).toBe(0);
    expect(agg.nar.brier.model.brier.value).toBeNull();
    expect(typeof agg.nar.brier.model.brier.reason).toBe("string");
  });
});

describe("aggregateObservations: Brier(手計算との照合)", () => {
  it("モデルの Brier は馬ごとの (prior − 結果)² の平均と一致する", () => {
    const r = race8("202606050101", "central", "same");
    const agg = aggregateObservations([r]);
    const expected =
      r.horses.reduce((s, h) => s + (h.prior - h.outcome) ** 2, 0) / r.horses.length;
    expect(agg.central.brier.model.brier.value).toBeCloseTo(expected, 12);
  });

  it("市場の Brier は、複勝オッズ下限を Σ=3 に正規化した確率の二乗誤差平均(独立の式)", () => {
    const r = race8("202606050101", "central", "same");
    const inv = ODDS8.map((o) => 1 / o);
    const sum = inv.reduce((s, v) => s + v, 0);
    const market = inv.map((v) => (v / sum) * 3);
    const expected = market.reduce((s, p, i) => s + (p - r.horses[i]!.outcome) ** 2, 0) / 8;
    const cmp = aggregateObservations([r]).central.brier.marketComparison.lowerBound;
    expect(cmp.eligibleRaceCount).toBe(1);
    expect(cmp.marketBrier.value).toBeCloseTo(expected, 12);
  });
});

describe("aggregateObservations: 市場比較の対象条件", () => {
  it("中央で oddsStatus が result でないレースは、オッズを使わず市場比較から外し、一覧に残す", () => {
    const obs = [
      race8("202606050101", "central", "same"),
      race8("202606050102", "central", "same", { oddsStatus: "middle" }),
    ];
    const c = aggregateObservations(obs).central;
    expect(c.marketOddsNotFinalRaces).toEqual(["202606050102"]);
    expect(c.brier.marketComparison.lowerBound.eligibleRaceCount).toBe(1);
    // 確定でないレースは「確定でない」として数え、「複勝オッズの欠損・不正」には二重計上しない。
    expect(c.brier.marketComparison.lowerBound.excludedRaces.oddsNotFinal).toEqual(["202606050102"]);
    expect(c.brier.marketComparison.lowerBound.excludedRaces.marketUnavailable).toEqual([]);
    expect(c.brier.marketComparison.midpoint.excludedRaces.marketUnavailable).toEqual([]);
    expect(c.brier.model.decomposition.decomposition!.n).toBe(16); // モデル単独には入る
    expect(c.oddsStatusCounts).toEqual({ result: 1, middle: 1 });
  });

  it("地方では middle を確定後のオッズとして比較に使う(§3.5)", () => {
    const c = aggregateObservations([race8("202654071201", "nar", "same")]).nar;
    expect(c.marketOddsNotFinalRaces).toEqual([]);
    expect(c.brier.marketComparison.lowerBound.eligibleRaceCount).toBe(1);
  });

  it("地方で yoso(複勝なし)のレースは比較から外す", () => {
    const c = aggregateObservations([race8("202654071201", "nar", "same", { oddsStatus: "yoso" })]).nar;
    expect(c.marketOddsNotFinalRaces).toEqual(["202654071201"]);
    expect(c.brier.marketComparison.lowerBound.eligibleRaceCount).toBe(0);
    expect(c.brier.marketComparison.lowerBound.excludedRaces.oddsNotFinal).toEqual(["202654071201"]);
    expect(c.brier.marketComparison.lowerBound.excludedRaces.marketUnavailable).toEqual([]);
  });

  it("出走7頭のレースは市場比較に入らない(モデル単独には入る)", () => {
    const seven = okRace(
      "202606050105",
      "central",
      ODDS8.slice(0, 7).map((o, i) => horse(i + 1, 0.4, i < 3 ? 1 : 0, o)),
    );
    const c = aggregateObservations([seven]).central;
    expect(c.brier.marketComparison.lowerBound.excludedRaces.smallField).toEqual(["202606050105"]);
    expect(c.brier.model.decomposition.decomposition!.n).toBe(7);
  });
});

describe("aggregateObservations: 戦績取得失敗の馬を含むレースの感度", () => {
  it("主表は全レース、感度はそのレースを除いた集計(別掲)", () => {
    const failed = race8("202606050102", "central", "reverse");
    const failedRace: RaceObservationOk = {
      ...failed,
      horses: failed.horses.map((h, i) => (i === 0 ? { ...h, resultsFetched: false, usedRunCount: null } : h)),
      resultsFailedHorseCount: 1,
    };
    const c = aggregateObservations([race8("202606050101", "central", "same"), failedRace]).central;
    expect(c.resultsFailedRaces).toEqual(["202606050102"]);
    expect(c.brier.raceCount).toBe(2);
    expect(c.brierExcludingResultsFailed.raceCount).toBe(1);
    expect(c.brierExcludingResultsFailed.observationCount).toBe(8);
  });

  it("失敗レースが無ければ感度は主表と同じ件数", () => {
    const c = aggregateObservations([race8("202606050101", "central", "same")]).central;
    expect(c.resultsFailedRaces).toEqual([]);
    expect(c.brierExcludingResultsFailed.raceCount).toBe(1);
  });
});

describe("aggregateObservations: #40 の指標のレース別の中央値とレンジ", () => {
  it("Spearman ρ: 市場と同順位のレースは +1・逆順位は −1。中央値・最小・最大・件数を出す", () => {
    const obs = [
      race8("202606050101", "central", "same"),
      race8("202606050102", "central", "reverse"),
      race8("202606050103", "central", "same"),
    ];
    const m = aggregateObservations(obs).central.metrics40.spearmanRho;
    expect(m.n).toBe(3);
    expect(m.nullCount).toBe(0);
    expect(m.median).toBeCloseTo(1, 12);
    expect(m.min).toBeCloseTo(-1, 12);
    expect(m.max).toBeCloseTo(1, 12);
  });

  it("中央値は偶数件なら中央2つの平均", () => {
    const obs = [race8("202606050101", "central", "same"), race8("202606050102", "central", "reverse")];
    const m = aggregateObservations(obs).central.metrics40.spearmanRho;
    expect(m.n).toBe(2);
    expect(m.median).toBeCloseTo(0, 12); // (−1 + 1) / 2
  });

  it("市場側が関わる指標は出走8頭以上のレースだけ。7頭のレースは算出不能として数え、モデル単独の指標には入る", () => {
    const seven = okRace(
      "202606050105",
      "central",
      ODDS8.slice(0, 7).map((o, i) => horse(i + 1, 0.5 - i * 0.05, i < 3 ? 1 : 0, o)),
    );
    const m = aggregateObservations([race8("202606050101", "central", "same"), seven]).central.metrics40;
    expect(m.spearmanRho.n).toBe(1);
    expect(m.spearmanRho.nullCount).toBe(1);
    expect(m.maxMinRatioModel.n).toBe(2);
    expect(m.maxMinRatioModel.nullCount).toBe(0);
    expect(m.normalizedJointKlModel.n).toBe(2);
    expect(m.normalizedJointKlMarket.n).toBe(1);
  });

  it("三連複の全点EV÷払戻率は測定しない(組合せオッズを取得していない)旨を結果に残す", () => {
    const agg = aggregateObservations([race8("202606050101", "central", "same")]);
    expect(agg.central.metrics40.trioAllPointEvOverPayoutRate).toEqual({
      measured: false,
      reason: expect.stringContaining("組合せオッズ"),
    });
  });

  it("計測条件(使った遮断の診断値の合計)を集計に残す", () => {
    const c = aggregateObservations([
      race8("202606050101", "central", "same"),
      race8("202606050102", "central", "same"),
    ]).central;
    expect(c.leakFilter.removedCount).toBe(6);
    expect(c.leakFilter.totalResultCount).toBe(200);
  });
});

describe("aggregateObservations: 再計算できること", () => {
  const obs = [
    race8("202606050101", "central", "same"),
    race8("202606050102", "central", "reverse"),
    race8("202654071201", "nar", "same"),
  ];

  it("JSON を経由した観測から同じ集計が得られる(集計は観測 JSON だけから再計算できる)", () => {
    const roundTripped = JSON.parse(JSON.stringify(obs)) as RaceObservation[];
    expect(aggregateObservations(roundTripped)).toEqual(aggregateObservations(obs));
  });

  it("入力の並びに依らない(読み込み順に影響されない)", () => {
    expect(aggregateObservations([...obs].reverse())).toEqual(aggregateObservations(obs));
  });

  it("集計結果は JSON に直列化でき、往復しても同じ(NaN・undefined が紛れ込まない)", () => {
    const agg = aggregateObservations(obs);
    expect(JSON.parse(JSON.stringify(agg))).toEqual(agg);
  });
});

describe("loadObservations", () => {
  it("ディレクトリの観測 JSON を読む(manifest・aggregate は読まない)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pq41-"));
    try {
      writeFileSync(path.join(dir, "202606050101.json"), JSON.stringify(race8("202606050101", "central", "same")));
      writeFileSync(path.join(dir, "202654071201.json"), JSON.stringify(race8("202654071201", "nar", "same")));
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ not: "observation" }));
      const loaded = loadObservations(dir);
      expect(loaded.map((o) => o.raceId)).toEqual(["202606050101", "202654071201"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("スキーマ版が違う観測は読み込みで失敗する(黙って集計しない)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pq41-"));
    try {
      writeFileSync(
        path.join(dir, "202606050101.json"),
        JSON.stringify({ ...race8("202606050101", "central", "same"), schemaVersion: 99 }),
      );
      expect(() => loadObservations(dir)).toThrow(/schemaVersion/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("summarizeFetchRuns: manifest の実行記録から、保存しなかったレースと要求数を拾う", () => {
  function run(over: Partial<RunManifest>): RunManifest {
    return {
      gitCommit: "abc",
      plan: { central: ["20260926"], nar: [] },
      minIntervalMs: 2000,
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:10:00.000Z",
      days: [],
      processed: [],
      skippedExisting: [],
      halted: false,
      haltReason: null,
      requestCount: 100,
      urlsBlocked: [],
      ...over,
    };
  }

  it("not-saved のレースを、理由・文言・回数つきで返す", () => {
    const runs = [
      run({
        processed: [
          { raceId: "202606050101", status: "not-saved", reason: "scrape-error", detail: "boom" },
          { raceId: "202606050102", status: "ok" },
        ],
      }),
    ];
    const r = summarizeFetchRuns(runs, [okRace("202606050102", "central", [])]);
    expect(r.notSavedRaces).toEqual([
      { raceId: "202606050101", reason: "scrape-error", detail: "boom", attempts: 1 },
    ]);
  });

  it("再実行で観測が保存されたレースは、保存しなかったレースに数えない(最終状態で判断する)", () => {
    const runs = [
      run({ processed: [{ raceId: "202606050101", status: "not-saved", reason: "scrape-error", detail: "x" }] }),
      run({ processed: [{ raceId: "202606050101", status: "ok" }] }),
    ];
    const r = summarizeFetchRuns(runs, [race8("202606050101", "central", "same")]);
    expect(r.notSavedRaces).toEqual([]);
  });

  it("再実行でも保存されなかったレースは、最後の理由と試行回数(not-saved の回数)を返す", () => {
    const runs = [
      run({ processed: [{ raceId: "202606050101", status: "not-saved", reason: "scrape-error", detail: "a" }] }),
      run({ processed: [{ raceId: "202606050101", status: "not-saved", reason: "unclassified-finish", detail: "b" }] }),
    ];
    const r = summarizeFetchRuns(runs, []);
    expect(r.notSavedRaces).toEqual([
      { raceId: "202606050101", reason: "unclassified-finish", detail: "b", attempts: 2 },
    ]);
  });

  it("実行の要約(要求数の合計・停止の有無・コミット・開催日)を返す", () => {
    const runs = [
      run({ requestCount: 120, days: [{ region: "central", requestedDate: "20260926", usedDate: "20260926", attemptedDates: ["20260926"], raceIds: ["a", "b"] }] }),
      run({ requestCount: 30, halted: true, haltReason: "停止" }),
    ];
    const r = summarizeFetchRuns(runs, []);
    expect(r.runCount).toBe(2);
    expect(r.requestCountTotal).toBe(150);
    expect(r.anyHalted).toBe(true);
    expect(r.gitCommits).toEqual(["abc"]);
    expect(r.days).toEqual([
      { region: "central", requestedDate: "20260926", usedDate: "20260926", attemptedDates: ["20260926"], raceIds: ["a", "b"] },
    ]);
  });
});
