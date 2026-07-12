/**
 * レース妙味スコア(computeRaceOpportunity)の純関数テスト。
 *
 * 仕様(ユーザー要望「妙味がありそうなレースを探す」)に基づく振る舞い:
 *  - 主成分は EVプラス馬それぞれの (EV − 1) × 補正後確率 の最大値
 *    (=期待利益率 × 当たりやすさ。大穴一辺倒を防ぐ設計)
 *  - 出走馬の低データ(キャリアN走未満)割合が高いほどスコアを減衰する(モデル過信の抑制)
 *  - oddsStatus=yoso(複勝未発売)/ EVプラス0頭 のレースはスコア null + 理由
 *  - 同スコアは馬番昇順で決定的に筆頭候補を選ぶ
 *
 * ネットワーク・LLM・SQLite には一切依存しない。
 */

import { describe, expect, it } from "vitest";

import {
  computeRaceOpportunity,
  DEFAULT_RACE_OPPORTUNITY_CONFIG,
  type RaceOpportunityHorse,
  type RaceOpportunityMeta,
} from "../../src/ev/race-opportunity.js";

/** テスト用の1頭を作る(既定はEVプラス・十分なキャリア)。 */
function horse(
  over: Partial<RaceOpportunityHorse> & { umaban: number },
): RaceOpportunityHorse {
  return {
    umaban: over.umaban,
    horseName: over.horseName ?? `馬${over.umaban}`,
    // 明示的な null(オッズ欠損 / 戦績取得失敗)を既定値に潰さないため in 演算子で判定する。
    ev: "ev" in over ? (over.ev ?? null) : 1.3,
    adjustedProb: over.adjustedProb ?? 0.5,
    isPositive: over.isPositive ?? true,
    careerRunCount:
      "careerRunCount" in over ? (over.careerRunCount ?? null) : 10,
  };
}

const middleMeta: RaceOpportunityMeta = { oddsStatus: "middle" };

describe("computeRaceOpportunity(レース妙味スコア)", () => {
  it("EVプラス馬の (EV−1)×補正後確率 の最大値を主成分にする(低データ0なら減衰なし)", () => {
    // 本命寄り: raw = (1.5−1)×0.6 = 0.30 / 大穴寄り: raw = (5.0−1)×0.05 = 0.20
    const horses = [
      horse({ umaban: 1, ev: 1.5, adjustedProb: 0.6 }),
      horse({ umaban: 2, ev: 5.0, adjustedProb: 0.05 }),
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    expect(r.score).toBeCloseTo(0.3, 10);
    expect(r.evPlusCount).toBe(2);
    expect(r.excludedReason).toBeNull();
    // 大穴(2番)ではなくバランスの良い1番が筆頭候補になる(大穴偏重の緩和)。
    expect(r.bestPick).not.toBeNull();
    expect(r.bestPick?.umaban).toBe(1);
    expect(r.bestPick?.ev).toBeCloseTo(1.5, 10);
    expect(r.bestPick?.adjustedProb).toBeCloseTo(0.6, 10);
  });

  it("中間域では確率二重計上でも大穴が本命を上回りうる(挙動の固定・断定しない)", () => {
    // レビュアー検算: 本命 (1.2−1)×0.30 = 0.060 < 大穴 (1.8−1)×0.08 = 0.064。
    // 主成分は max raw を取るだけであり、「常に本命寄りが勝つ」性質は保証しない。
    // 抑制されるのは極端な大穴(確率差が極端な場合)のみ、という実挙動を仕様として固定する。
    const horses = [
      horse({ umaban: 1, ev: 1.2, adjustedProb: 0.3 }), // 本命寄り raw=0.060
      horse({ umaban: 2, ev: 1.8, adjustedProb: 0.08 }), // 大穴寄り raw=0.064
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    expect(r.bestPick?.umaban).toBe(2);
    expect(r.score).toBeCloseTo(0.064, 10);
  });

  it("戦績取得失敗(careerRunCount=null)の馬は低データ割合の分母・分子から除外する", () => {
    // 新馬(0走)は「判明した低データ」、取得失敗(null)は「不明」で集計に含めない。
    const horses = [
      horse({ umaban: 1, ev: 2.0, adjustedProb: 0.5, careerRunCount: 10 }), // 通常
      horse({ umaban: 2, ev: 1.2, adjustedProb: 0.5, careerRunCount: 0 }), // 新馬=低データ
      horse({ umaban: 3, ev: 1.1, adjustedProb: 0.5, careerRunCount: null }), // 取得失敗=除外
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    // 判明馬は2頭(1番・2番)、うち低データは1番以外=1頭 → 1/2 = 0.5(3番は分母に入れない)。
    expect(r.lowDataRatio).toBeCloseTo(0.5, 10);
  });

  it("戦績が全馬取得失敗(全 null)なら低データ割合は0(減衰なし)", () => {
    const horses = [
      horse({ umaban: 1, ev: 2.0, adjustedProb: 0.5, careerRunCount: null }),
      horse({ umaban: 2, ev: 1.5, adjustedProb: 0.4, careerRunCount: null }),
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    expect(r.lowDataRatio).toBe(0);
    // 減衰なし → 主成分 max = (2.0−1)×0.5 = 0.5 がそのままスコア。
    expect(r.score).toBeCloseTo(0.5, 10);
  });

  it("低データ馬割合に応じてスコアを減衰する(全馬低データなら 1 − 係数 倍)", () => {
    // 既定 lowDataPenaltyCoef=0.5。全馬低データ(ratio=1)→ 係数 (1 − 1×0.5)=0.5。
    const horses = [
      horse({ umaban: 1, ev: 1.5, adjustedProb: 0.6, careerRunCount: 1 }),
      horse({ umaban: 2, ev: 1.2, adjustedProb: 0.5, careerRunCount: 0 }),
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    // 主成分 max = (1.5−1)×0.6 = 0.30。減衰後 0.30×0.5 = 0.15。
    expect(r.lowDataRatio).toBeCloseTo(1, 10);
    expect(r.score).toBeCloseTo(0.15, 10);
  });

  it("低データ判定は閾値未満(< N)であり、ちょうどN走は低データに数えない(境界)", () => {
    // 既定 lowDataThreshold=5。careerRunCount=5 は低データではない、4 は低データ。
    const horses = [
      horse({ umaban: 1, ev: 2.0, adjustedProb: 0.5, careerRunCount: 5 }),
      horse({ umaban: 2, ev: 1.1, adjustedProb: 0.5, careerRunCount: 4 }),
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    // 低データは2番のみ → ratio = 1/2 = 0.5。減衰係数 = 1 − 0.5×0.5 = 0.75。
    expect(r.lowDataRatio).toBeCloseTo(0.5, 10);
    // 主成分 max = (2.0−1)×0.5 = 0.5。減衰後 0.5×0.75 = 0.375。
    expect(r.score).toBeCloseTo(0.375, 10);
    expect(r.bestPick?.umaban).toBe(1);
  });

  it("EVプラスが0頭のレースはスコア null + 理由(bestPick も null)", () => {
    const horses = [
      horse({ umaban: 1, isPositive: false, ev: 0.8 }),
      horse({ umaban: 2, isPositive: false, ev: 0.9, careerRunCount: 2 }),
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    expect(r.score).toBeNull();
    expect(r.bestPick).toBeNull();
    expect(r.evPlusCount).toBe(0);
    expect(r.excludedReason).toContain("EVプラス");
    // 除外レースでも低データ割合は算出しておく(表示の注記用)。
    expect(r.lowDataRatio).toBeCloseTo(0.5, 10);
  });

  it("EV=null(オッズ欠損)の馬は isPositive でも妙味計算に含めない", () => {
    const horses = [
      horse({ umaban: 1, ev: null, isPositive: true, adjustedProb: 0.9 }),
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    expect(r.score).toBeNull();
    expect(r.evPlusCount).toBe(0);
    expect(r.excludedReason).toContain("EVプラス");
  });

  it("oddsStatus=yoso(複勝未発売)はスコア null + 専用理由(EVプラス判定より優先)", () => {
    const horses = [horse({ umaban: 1, ev: 3.0, adjustedProb: 0.5 })];
    const r = computeRaceOpportunity(horses, { oddsStatus: "yoso" }, DEFAULT_RACE_OPPORTUNITY_CONFIG);
    expect(r.score).toBeNull();
    expect(r.bestPick).toBeNull();
    expect(r.excludedReason).toContain("複勝オッズ未発売");
  });

  it("同スコアのときは馬番昇順で筆頭候補を決める(決定性)", () => {
    // 3番と1番が同 raw = (1.4−1)×0.5 = 0.20。昇順で 1番が選ばれる。
    const horses = [
      horse({ umaban: 3, ev: 1.4, adjustedProb: 0.5 }),
      horse({ umaban: 1, ev: 1.4, adjustedProb: 0.5 }),
    ];
    const r = computeRaceOpportunity(
      horses,
      middleMeta,
      DEFAULT_RACE_OPPORTUNITY_CONFIG,
    );
    expect(r.bestPick?.umaban).toBe(1);
    expect(r.score).toBeCloseTo(0.2, 10);
  });

  it("空の出走馬配列はスコア null(低データ割合は0)", () => {
    const r = computeRaceOpportunity([], middleMeta, DEFAULT_RACE_OPPORTUNITY_CONFIG);
    expect(r.score).toBeNull();
    expect(r.evPlusCount).toBe(0);
    expect(r.lowDataRatio).toBe(0);
  });

  it("oddsStatus=result(確定)でも妙味計算は行う", () => {
    const horses = [horse({ umaban: 1, ev: 2.0, adjustedProb: 0.5 })];
    const r = computeRaceOpportunity(horses, { oddsStatus: "result" }, DEFAULT_RACE_OPPORTUNITY_CONFIG);
    expect(r.score).toBeCloseTo(0.5, 10);
  });
});
