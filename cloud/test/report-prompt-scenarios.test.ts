import { describe, expect, it } from "vitest";
import { buildDayStats, buildRaceDigest, excludingTopRecoveryRate } from "../src/daily-report-digest";
import { buildScenario, SCENARIO_IDS, type ScenarioId } from "../report-prompt-scenarios";
import { buildSavedRecord } from "./daily-report-fixtures";

/**
 * Issue #264: 近似確認(旧・新のプロンプトをサブエージェントに読ませる)のシナリオ。**シナリオが意図した性質を持つこと**を固定する。
 * 性質を取り違えたシナリオで確認すると、確認そのものが無意味になる(例: 『見込みより多く当たった日』の見込みが実は実際より多い)。
 */

const stats = (id: ScenarioId) => {
  const s = buildScenario(id);
  return { s, day: buildDayStats(s.inputs.map((i) => buildRaceDigest(i.view, i.result))) };
};

describe("近似確認のシナリオ", () => {
  it("S1〜S6 の 6 つ。どのシナリオも、その日に判定できた買い目が 20 点・レースが 19 件で、結果の無いレースは無い(日報の統計として読める)", () => {
    expect(SCENARIO_IDS).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    for (const id of SCENARIO_IDS) {
      const { day } = stats(id);
      expect(day.raceCount, id).toBe(19);
      expect(day.resultRaceCount, id).toBe(19);
      expect(day.judgedBetCount, id).toBe(20);
      expect(day.unjudgedBetCount, id).toBe(0);
      expect(day.expectedBetCount, id).toBe(20); // 全買い目の確率を導ける
    }
  });

  it("S1(実日報の形): 20 点中 1 点的中・賭け金 2,400 円・払戻 13,320 円(回収率 555%)。見込みは 1 点を超える(実際は見込みより少ない)", () => {
    const { day } = stats("S1");
    expect(day.hitBetCount).toBe(1);
    expect(day.totalStake).toBe(2400);
    expect(day.totalReturn).toBeCloseTo(13320, 6);
    expect(day.recoveryRate).toBeCloseTo(5.55, 10);
    expect(day.expectedHits).toBeGreaterThan(1.5);
    expect(day.maxPayout).toBeCloseTo(13320, 6);
    expect(excludingTopRecoveryRate(day)).toBe(0); // 最大の 1 点を除くと払戻 0
  });

  it("S2: 3 点的中・回収率 323%。見込みは 3 点より小さいが近い(見込み並みの的中)。4 週もプラス", () => {
    const { s, day } = stats("S2");
    expect(day.hitBetCount).toBe(3);
    expect(day.totalStake).toBe(2600);
    expect(day.totalReturn).toBeCloseTo(300 * 18.5 + 200 * 9.2 + 300 * 3.4, 6);
    expect(day.recoveryRate!).toBeGreaterThan(3);
    expect(day.expectedHits).toBeGreaterThan(1.5);
    expect(day.expectedHits).toBeLessThan(3.5);
    expect(s.prior.recoveryRate!).toBeGreaterThan(1);
  });

  it("S3: 的中 0 点・払戻 0。4 週はプラス(その日が 4 週を下回る向き)", () => {
    const { s, day } = stats("S3");
    expect(day.hitBetCount).toBe(0);
    expect(day.totalReturn).toBe(0);
    expect(day.totalStake).toBe(2400);
    expect(day.expectedHits).toBeGreaterThan(1.5);
    expect(s.prior.recoveryRate!).toBeGreaterThan(1);
  });

  it("S4: その日は S1 と同じ(統計が一致)で、直前 27 日は履歴が薄い(開催 1 日・24 点)", () => {
    const s1 = stats("S1");
    const s4 = stats("S4");
    expect(s4.day).toStrictEqual(s1.day);
    expect(s4.s.prior.dayCount).toBe(1);
    expect(s4.s.prior.judgedBetCount).toBe(24);
    expect(s4.s.prior.raceCount).toBe(12);
    expect(s1.s.prior.dayCount).toBe(8); // 対照: S1 の 4 週は開催 8 日
  });

  it("S5(1 点依存): その日は 1 点的中で、最大の 1 点を除くと 0%。4 週は 130% だが、最大の 1 点を除くと 100% 未満", () => {
    const { s, day } = stats("S5");
    expect(day.hitBetCount).toBe(1);
    expect(day.recoveryRate!).toBeGreaterThan(1); // その日は黒字(3,000 ÷ 2,400)
    expect(excludingTopRecoveryRate(day)).toBe(0);
    expect(s.prior.recoveryRate!).toBeCloseTo(1.3, 10);
    expect(excludingTopRecoveryRate(s.prior)!).toBeLessThan(1);
    expect(excludingTopRecoveryRate(s.prior)!).toBeGreaterThan(0.7);
  });

  it("S6(見込みより多く当たった): 5 点的中で、見込みの 2 倍以上(見込み ≦ 実際 ÷ 2)。回収率も 100% 超", () => {
    const { day } = stats("S6");
    expect(day.hitBetCount).toBe(5);
    expect(day.expectedHits).toBeLessThanOrEqual(day.hitBetCount / 2);
    expect(day.expectedHits).toBeGreaterThan(1);
    expect(day.recoveryRate!).toBeGreaterThan(1);
  });

  it("4 週の統計は内訳の和が全体に一致する(券種別の点数・的中・賭け金・払戻・見込み)", () => {
    for (const id of SCENARIO_IDS) {
      const p = buildScenario(id).prior;
      const types = Object.values(p.byBetType);
      expect(types.reduce((a, t) => a + t.betCount, 0), id).toBe(p.judgedBetCount);
      expect(types.reduce((a, t) => a + t.hitCount, 0), id).toBe(p.hitBetCount);
      expect(types.reduce((a, t) => a + t.stake, 0), id).toBe(p.totalStake);
      expect(types.reduce((a, t) => a + t.payout, 0), id).toBe(p.totalReturn);
      expect(types.reduce((a, t) => a + t.expectedHits, 0), id).toBeCloseTo(p.expectedHits, 10);
    }
  });

  it("本物の日報の組み立て(DailyReportCore)に通すと、プロンプトに『その日』『直前 27 日』『28 日累計』が入り、本文に累計が残る", async () => {
    const s = buildScenario("S6");
    const prompts: string[] = [];
    const record = await buildSavedRecord({ inputs: s.inputs, prior: s.prior, promptOut: prompts });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## 直前 27 日(その日を除く)の成績(確定値)");
    expect(prompts[0]).toContain(`見込みの的中数: ${record.body.stats.expectedHits.toFixed(2)} 点`);
    expect(record.body.rolling!.total.hitBetCount).toBe(s.prior.hitBetCount + 5);
  });
});
