import { describe, expect, it } from "vitest";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import {
  buildAdjustmentFit,
  classifyDirection,
  FIT_MIN_VERSION_RACES,
  popularityBand,
  selectFitAnalyses,
  type AdjustmentFit,
  type FitCandidate,
  type FitHorseRow,
  type FitResultRow,
} from "../src/adjustment-fit";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyReadRows } from "../src/verify-read";

/**
 * Issue #509(#337-B1): 月報の「補正の当たり具合」の計算(純関数)。
 *  - 区分の境目(d = 補正後 − 統計モデル が ±0.01・±0.05 ちょうど・わずかに外)と人気の帯の境目
 *  - 版別の表を出す境目(29 / 30 レース)・月全体には 30 レース未満の版も入ること
 *  - k = Σd(y−prior)/Σd² と、分母 0 のとき null
 *  - 母集団が検証画面(computeVerifyReport。PRODUCTION_VERIFY_CONFIG)と同じこと(Brier・評価した馬の数・採用件数の突合)
 */

describe("classifyDirection: 補正の向き別 5 区分の境目(d = 補正後 − 統計モデル)", () => {
  const CASES: ReadonlyArray<readonly [string, number, number, string]> = [
    // [名前, prior, adjusted, 期待する区分]
    ["d = +0.05 ちょうど → 上げた(大きくは含めない)", 0.2, 0.25, "up"],
    ["d = +0.05 をわずかに超える → 大きく上げた", 0.2, 0.2500001, "bigUp"],
    ["d = +0.5 → 大きく上げた", 0.2, 0.7, "bigUp"],
    ["d = +0.01 ちょうど → ほぼそのまま(浮動小数の 0.31 − 0.30 でも)", 0.3, 0.31, "same"],
    ["d = +0.01 をわずかに超える → 上げた", 0.3, 0.3100001, "up"],
    ["d = 0 → ほぼそのまま", 0.3, 0.3, "same"],
    ["d = −0.01 ちょうど → ほぼそのまま", 0.31, 0.3, "same"],
    ["d = −0.01 をわずかに超えて下げた → 下げた", 0.3100001, 0.3, "down"],
    ["d = −0.05 ちょうど → 下げた(大きくは含めない)", 0.25, 0.2, "down"],
    ["d = −0.05 をわずかに超えて下げた → 大きく下げた", 0.2500001, 0.2, "bigDown"],
    ["d = −0.3 → 大きく下げた", 0.5, 0.2, "bigDown"],
  ];
  for (const [name, prior, adjusted, expected] of CASES) {
    it(name, () => {
      expect(classifyDirection(prior, adjusted)).toBe(expected);
    });
  }
});

describe("popularityBand: 人気の帯 4 区分の境目", () => {
  const CASES: ReadonlyArray<readonly [number | null | undefined, string | null]> = [
    [1, "1"],
    [2, "2-3"],
    [3, "2-3"],
    [4, "4-6"],
    [6, "4-6"],
    [7, "7+"],
    [18, "7+"],
    [null, null],
    [undefined, null],
    [0, null],
    [-1, null],
    [2.5, null],
  ];
  for (const [ninki, expected] of CASES) {
    it(`人気 ${String(ninki)} → ${String(expected)}`, () => {
      expect(popularityBand(ninki)).toBe(expected);
    });
  }
});

// ---- 組み立ての補助 ----

const DAY = "20261010";
const BEFORE_START = "2026-10-10T00:00:00.000Z"; // JST 09:00(発走 15:45 より前)
const AFTER_START = "2026-10-10T08:00:00.000Z"; // JST 17:00(発走より後)

interface Spec {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt?: string;
  readonly promptVersion?: string | null;
  readonly model?: string | null;
  readonly guarded?: boolean;
  readonly startTime?: string | null;
  readonly evEstimated?: 0 | 1;
}

function candidate(s: Spec): FitCandidate {
  const guarded = s.guarded ?? true;
  return {
    id: s.id,
    raceId: s.raceId,
    analyzedAt: s.analyzedAt ?? BEFORE_START,
    kaisaiDate: DAY,
    promptVersion: s.promptVersion === undefined ? "v1" : s.promptVersion,
    detailKey: null,
    evEstimated: s.evEstimated ?? 0,
    promptLookaheadGuarded: guarded ? 1 : null,
    historyCutoffDate: guarded ? "20261009" : null,
    startTime: s.startTime === undefined ? "15:45" : s.startTime,
    model: s.model === undefined ? "claude-x" : s.model,
  };
}

const horse = (analysisId: number, umaban: number, prior: number, adjustedProb: number): FitHorseRow => ({ analysisId, umaban, prior, adjustedProb });
const result = (raceId: string, umaban: number, finishPosition: number | null, ninki: number | null = null, scratched: number | null = null): FitResultRow => ({ raceId, umaban, finishPosition, ninki, scratched });

function fitOf(specs: readonly Spec[], horses: readonly FitHorseRow[], results: readonly FitResultRow[]): AdjustmentFit {
  return buildAdjustmentFit(selectFitAnalyses(specs.map(candidate)), horses, results);
}

describe("buildAdjustmentFit: 集計", () => {
  it("向き別・人気別の頭数・平均・3 着内率を出す(手計算と一致)", () => {
    // 1 レース 4 頭。d: +0.10(大きく上げた)・+0.03(上げた)・0(そのまま)・−0.10(大きく下げた)
    const specs = [{ id: 1, raceId: "R1" }];
    const horses = [horse(1, 1, 0.3, 0.4), horse(1, 2, 0.2, 0.23), horse(1, 3, 0.1, 0.1), horse(1, 4, 0.4, 0.3)];
    const results = [result("R1", 1, 1, 1), result("R1", 2, 4, 5), result("R1", 3, 2, 3), result("R1", 4, 3, 9)];
    const fit = fitOf(specs, horses, results);
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.all.raceCount).toBe(1);
    expect(fit.all.horseCount).toBe(4);
    const byKey = Object.fromEntries(fit.all.byDirection.map((b) => [b.key, b]));
    expect(fit.all.byDirection.map((b) => b.key)).toEqual(["bigUp", "up", "same", "down", "bigDown"]);
    expect(byKey["bigUp"]).toMatchObject({ count: 1, placedCount: 1, meanPrior: 0.3, meanAdjusted: 0.4 });
    expect(byKey["up"]).toMatchObject({ count: 1, placedCount: 0, meanPrior: 0.2, meanAdjusted: 0.23 });
    expect(byKey["same"]).toMatchObject({ count: 1, placedCount: 1 });
    expect(byKey["down"]).toMatchObject({ count: 0, placedCount: 0, meanPrior: null, meanAdjusted: null });
    expect(byKey["bigDown"]).toMatchObject({ count: 1, placedCount: 1, meanPrior: 0.4, meanAdjusted: 0.3 });
    // 人気: 1 → 1、5 → 4-6、3 → 2-3、9 → 7+
    expect(fit.all.byPopularity.map((b) => [b.key, b.count])).toEqual([["1", 1], ["2-3", 1], ["4-6", 1], ["7+", 1]]);
    // 頭数の合計 = 評価した馬の数
    expect(fit.all.byDirection.reduce((n, b) => n + b.count, 0)).toBe(fit.all.horseCount);
  });

  it("着順なし(null)・取消(scratched=1)・結果に無い馬は評価しない。人気 null の馬は人気別の表だけから除く", () => {
    const specs = [{ id: 1, raceId: "R1" }];
    const horses = [horse(1, 1, 0.3, 0.3), horse(1, 2, 0.3, 0.3), horse(1, 3, 0.3, 0.3), horse(1, 4, 0.3, 0.3), horse(1, 5, 0.3, 0.3)];
    const results = [
      result("R1", 1, 1, 1),
      result("R1", 2, null, null), // 着順なし(中止など)
      result("R1", 3, 5, 4, 1), // 取消・除外の印が付いた馬(着順があっても評価しない)
      result("R1", 4, 6, null), // 人気 null: 向き別には入るが人気別には入らない
      // 馬番 5 は結果に行が無い
    ];
    const fit = fitOf(specs, horses, results);
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.all.horseCount).toBe(2);
    expect(fit.all.byDirection.reduce((n, b) => n + b.count, 0)).toBe(2);
    expect(fit.all.byPopularity.reduce((n, b) => n + b.count, 0)).toBe(1);
  });

  it("3 着内の判定は着順 3 以下(4 は外)", () => {
    const specs = [{ id: 1, raceId: "R1" }];
    const horses = [horse(1, 1, 0.3, 0.3), horse(1, 2, 0.3, 0.3)];
    const fit = fitOf(specs, horses, [result("R1", 1, 3, 1), result("R1", 2, 4, 2)]);
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.all.byDirection.find((b) => b.key === "same")).toMatchObject({ count: 2, placedCount: 1 });
  });

  it("Brier は (確率 − 結果)² の平均。k は Σd(y−prior)/Σd² で、手計算の例と一致する", () => {
    // 2 頭: (prior 0.2, 補正後 0.3, 3 着内 y=1)、(prior 0.6, 補正後 0.4, 3 着外 y=0)
    // d = +0.1, −0.2。Σd² = 0.05。Σd(y−prior) = 0.1×0.8 + (−0.2)×(−0.6) = 0.08 + 0.12 = 0.20。k = 4
    const specs = [{ id: 1, raceId: "R1" }];
    const horses = [horse(1, 1, 0.2, 0.3), horse(1, 2, 0.6, 0.4)];
    const fit = fitOf(specs, horses, [result("R1", 1, 1, 1), result("R1", 2, 9, 2)]);
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.all.optimalK).toBeCloseTo(4, 12);
    // prior の Brier = ((0.2−1)² + (0.6−0)²)/2 = (0.64 + 0.36)/2 = 0.5。補正後 = ((0.3−1)² + 0.4²)/2 = (0.49 + 0.16)/2 = 0.325
    expect(fit.all.brier.prior).toBeCloseTo(0.5, 12);
    expect(fit.all.brier.adjusted).toBeCloseTo(0.325, 12);
  });

  it("分母(Σd²)が 0 のとき k は null。Brier は両方同じ値", () => {
    const specs = [{ id: 1, raceId: "R1" }];
    const horses = [horse(1, 1, 0.3, 0.3), horse(1, 2, 0.5, 0.5)];
    const fit = fitOf(specs, horses, [result("R1", 1, 1, 1), result("R1", 2, 8, 2)]);
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.all.horseCount).toBe(2); // 前提: 評価した馬がいる(いないから null なのではない)
    expect(fit.all.optimalK).toBeNull();
    expect(fit.all.brier.prior).toBe(fit.all.brier.adjusted);
  });

  it("評価できる馬が 1 頭もないとき: raceCount 0・Brier と k は null・全区分が 0 頭", () => {
    const specs = [{ id: 1, raceId: "R1" }];
    const fit = fitOf(specs, [horse(1, 1, 0.3, 0.4)], [result("R1", 1, null, 1)]);
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.all.raceCount).toBe(0);
    expect(fit.all.horseCount).toBe(0);
    expect(fit.all.brier).toEqual({ prior: null, adjusted: null });
    expect(fit.all.optimalK).toBeNull();
    expect(fit.all.byDirection.every((b) => b.count === 0)).toBe(true);
    expect(fit.all.byPopularity.every((b) => b.count === 0)).toBe(true);
    expect(fit.byVersion).toEqual([]);
  });
});

describe("buildAdjustmentFit: 版別(30 レース未満は表に出さない。月全体には入れる)", () => {
  /** 版ごとにレース数を指定して、各レース 1 頭(d = +0.1。3 着内)の標本を作る。 */
  function manyRaces(counts: Readonly<Record<string, number>>): AdjustmentFit {
    const specs: Spec[] = [];
    const horses: FitHorseRow[] = [];
    const results: FitResultRow[] = [];
    let id = 0;
    for (const [version, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i += 1) {
        id += 1;
        const raceId = `R${id}`;
        specs.push({ id, raceId, promptVersion: version });
        horses.push(horse(id, 1, 0.3, 0.4));
        results.push(result(raceId, 1, 1, 1));
      }
    }
    return fitOf(specs, horses, results);
  }

  it("29 レースの版は出さず(hiddenVersionCount に数える)、30 レースの版は出す。月全体には両方入る", () => {
    const fit = manyRaces({ "v-29": 29, "v-30": 30 });
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(FIT_MIN_VERSION_RACES).toBe(30);
    expect(fit.byVersion.map((v) => [v.promptVersion, v.raceCount])).toEqual([["v-30", 30]]);
    expect(fit.hiddenVersionCount).toBe(1);
    expect(fit.all.raceCount).toBe(59); // 前提: 29 レースの版も月全体には入る
    expect(fit.all.horseCount).toBe(59);
  });

  it("版は昇順に並び、版ごとの値はその版のレースだけから出る", () => {
    const fit = manyRaces({ "v-b": 31, "v-a": 30 });
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.byVersion.map((v) => v.promptVersion)).toEqual(["v-a", "v-b"]);
    expect(fit.byVersion.map((v) => v.horseCount)).toEqual([30, 31]);
    expect(fit.hiddenVersionCount).toBe(0);
  });

  it("版ごとのレース数は『評価した馬が 1 頭以上いるレース』で数える(馬が 0 頭のレースは数えない)", () => {
    // v1: 30 レースのうち 1 つは馬が全員着順なし → 29 レースで出さない
    const specs: Spec[] = [];
    const horses: FitHorseRow[] = [];
    const results: FitResultRow[] = [];
    for (let id = 1; id <= 30; id += 1) {
      specs.push({ id, raceId: `R${id}` });
      horses.push(horse(id, 1, 0.3, 0.4));
      results.push(result(`R${id}`, 1, id === 30 ? null : 1, 1));
    }
    const fit = fitOf(specs, horses, results);
    if ("unavailable" in fit) throw new Error("到達しない");
    expect(fit.all.raceCount).toBe(29);
    expect(fit.byVersion).toEqual([]);
    expect(fit.hiddenVersionCount).toBe(1);
  });
});

describe("selectFitAnalyses: 母集団", () => {
  it("LLM を使っていない最新の分析(model が null)は、古い LLM の分析に代えずレースごと除き、notLlm に数える", () => {
    const sel = selectFitAnalyses([
      candidate({ id: 1, raceId: "R1", analyzedAt: "2026-10-09T00:00:00.000Z" }),
      candidate({ id: 2, raceId: "R1", model: null }), // 新しい方が LLM 不使用
      candidate({ id: 3, raceId: "R2", promptVersion: null, model: null }),
      candidate({ id: 4, raceId: "R3" }),
    ]);
    expect(sel.chosen.map((c) => c.id)).toEqual([4]);
    expect(sel.excluded.notLlm).toBe(2);
  });

  it("model があっても prompt_version が null なら LLM を使った分析としない", () => {
    const sel = selectFitAnalyses([candidate({ id: 1, raceId: "R1", promptVersion: null, model: "claude-x" })]);
    expect(sel.chosen).toEqual([]);
    expect(sel.excluded.notLlm).toBe(1);
  });

  it("先読みの疑い(suspect)・発走時刻の補完待ち・推定 EV は除き、内訳に数える", () => {
    const sel = selectFitAnalyses([
      candidate({ id: 1, raceId: "R1", guarded: false, analyzedAt: AFTER_START }), // suspect
      candidate({ id: 2, raceId: "R2", guarded: false, startTime: null }), // 補完待ち
      candidate({ id: 3, raceId: "R3", evEstimated: 1 }), // 推定 EV
      candidate({ id: 4, raceId: "R4", guarded: false, startTime: "", analyzedAt: "2026-10-10T03:00:00.000Z" }), // unknown(時刻なしで開催日の当日中)
      candidate({ id: 5, raceId: "R5" }), // 採用
    ]);
    expect(sel.chosen.map((c) => c.id)).toEqual([5]);
    expect(sel.excluded).toEqual({ suspect: 1, unknown: 1, uncheckedRaces: 1, estimated: 1, notLlm: 0 });
  });
});

describe("検証画面(computeVerifyReport。PRODUCTION_VERIFY_CONFIG)との突合: 同じ母集団・同じ Brier", () => {
  /** 同じ入力から、検証画面の読み取り口(buildVerifySource)を作る。 */
  function verifyOf(specs: readonly Spec[], horses: readonly FitHorseRow[], results: readonly FitResultRow[]) {
    const analyses: VerifyAnalysisRow[] = specs.map((s) => {
      const c = candidate(s);
      return {
        id: c.id, raceId: c.raceId, analyzedAt: c.analyzedAt, evEstimated: c.evEstimated, promptVersion: c.promptVersion, additionalInstruction: null, kaisaiDate: c.kaisaiDate,
        model: null, rawResponse: null, raceSnapshotJson: c.startTime !== null && /^[0-9]/.test(c.startTime) ? JSON.stringify({ race: { startTime: c.startTime } }) : null,
        historyCutoffDate: c.historyCutoffDate, promptLookaheadGuarded: c.promptLookaheadGuarded, startTime: c.startTime,
      };
    });
    const rows: VerifyReadRows = {
      analyses,
      horses: horses.map((h) => ({
        analysisId: h.analysisId, umaban: h.umaban, prior: h.prior, adjusted_prob: h.adjustedProb, place_odds_min: null, ev: null, is_positive: 0,
        contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null,
      })),
      allocationMeta: [],
      bets: [],
      results: results.map((r) => ({ raceId: r.raceId, umaban: r.umaban, finishPosition: r.finishPosition, placePayout: null, winPayout: null, scratched: r.scratched ?? null, ninki: r.ninki ?? null })),
      comboPayouts: [],
      comboImports: [],
    };
    return buildVerifySource(rows);
  }

  it("先読みの疑い・推定 EV・古い分析・結果なしが混ざる月で、採用件数・評価した馬の数・補正前/補正後の Brier が検証画面の quality と一致する", () => {
    const specs: Spec[] = [
      { id: 1, raceId: "R1", analyzedAt: "2026-10-09T00:00:00.000Z" }, // R1 の古い分析(R1 は id 2 が最新)
      { id: 2, raceId: "R1" },
      { id: 3, raceId: "R2", guarded: false }, // 遮断なしで発走前 → clean
      { id: 4, raceId: "R3", guarded: false, analyzedAt: AFTER_START }, // suspect
      { id: 5, raceId: "R4", evEstimated: 1 }, // 推定 EV(丸ごと除外)
      { id: 6, raceId: "R5" }, // 結果なしのレース(候補の SQL が除くが、突合では検証画面側も除く)
      { id: 7, raceId: "R6", promptVersion: "v2" },
    ];
    const horses: FitHorseRow[] = [];
    const results: FitResultRow[] = [];
    const pri = [0.42, 0.31, 0.18, 0.09];
    const adj = [0.5, 0.28, 0.2, 0.05];
    for (const s of specs) {
      pri.forEach((p, i) => horses.push(horse(s.id, i + 1, p, adj[i]! + (s.id % 3) * 0.01)));
    }
    for (const raceId of ["R1", "R2", "R3", "R4", "R6"]) {
      [1, 3, 2, 8].forEach((finish, i) => results.push(result(raceId, i + 1, finish, i + 1)));
    }
    results.push(result("R6", 5, null, null)); // 着順なしの馬(結果にはいるが、馬は分析に居ない)

    const source = verifyOf(specs, horses, results);
    const report = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG);
    // 結果があるレースの分析だけを候補にする(本番の候補の SQL と同じ)
    const withResult = new Set(results.map((r) => r.raceId));
    const fit = buildAdjustmentFit(selectFitAnalyses(specs.filter((s) => withResult.has(s.raceId)).map(candidate)), horses, results);
    if ("unavailable" in fit) throw new Error("到達しない");

    expect(report.includedAnalysisCount).toBe(3); // 前提: R1(id 2)・R2・R6 だけが採用される(空振りでない)
    expect(fit.all.raceCount).toBe(report.includedAnalysisCount);
    expect(fit.all.horseCount).toBe(report.quality.evaluatedCount);
    expect(report.quality.priorBrier).not.toBeNull();
    expect(fit.all.brier.prior).toBeCloseTo(report.quality.priorBrier!, 12);
    expect(fit.all.brier.adjusted).toBeCloseTo(report.quality.adjustedBrier!, 12);
    // 補正前と補正後の Brier が異なる(同じ値同士の一致ではない)
    expect(fit.all.brier.prior).not.toBeCloseTo(fit.all.brier.adjusted!, 6);
  });
});
