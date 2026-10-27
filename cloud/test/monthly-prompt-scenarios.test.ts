import { describe, expect, it } from "vitest";
import { scenarioFacts, scenarioPrompt } from "../print-monthly-prompt";
import { buildMonthlyScenario, MONTHLY_SCENARIO_IDS } from "../monthly-prompt-scenarios";

/**
 * Issue #280: 月報のプロンプトの近似確認用シナリオ(`print-monthly-prompt.ts`)。各シナリオが、名乗る場面(黒字・赤字・標本が少ない)を実際に満たしていること(退化していないこと)を固定する。
 * 偽のデータだけで、実 API・D1 には触れない。
 */

const [M1, M2, M3] = MONTHLY_SCENARIO_IDS.map((id) => buildMonthlyScenario(id)) as [ReturnType<typeof buildMonthlyScenario>, ReturnType<typeof buildMonthlyScenario>, ReturnType<typeof buildMonthlyScenario>];

describe("シナリオの場面", () => {
  it("M1 黒字の月: 回収率が 100% を超え、実際の的中が見込みを上回る。開催 9 日・216 レース・版が 2 つ", () => {
    const s = M1.stats;
    expect(s.dayCount).toBe(9);
    expect(s.raceCount).toBe(216);
    expect(s.recoveryRate!).toBeGreaterThan(1);
    expect(s.expectedBetCount).toBeGreaterThan(0);
    expect(s.expectedBaseHits).toBeGreaterThan(s.expectedHits);
    expect(s.byVersion.map((v) => v.promptVersion)).toEqual(["2026-10-12.1", "2026-10-13.1"]);
    expect(s.byVersion.every((v) => v.raceCount > 0)).toBe(true);
    expect(M1.lastDayPending).toBe(false);
  });

  it("M2 赤字の月: 回収率が 100% 未満で、実際の的中が見込みを下回る。開催 9 日・216 レース・版は 1 つ", () => {
    const s = M2.stats;
    expect(s.dayCount).toBe(9);
    expect(s.raceCount).toBe(216);
    expect(s.recoveryRate!).toBeLessThan(1);
    expect(s.expectedBaseHits).toBeLessThan(s.expectedHits);
    expect(s.byVersion).toHaveLength(1);
    expect(M2.lastDayPending).toBe(false);
  });

  it("M3 標本の少ない月: 開催 2 日・20 レース。最終日(10/31)の結果が未取込で、lastDayPending を立てる。版は 1 つ", () => {
    const s = M3.stats;
    expect(s.dayCount).toBe(2);
    expect(s.raceCount).toBe(20);
    expect(s.days.map((d) => d.date)).toEqual(["20261017", "20261031"]);
    expect(s.days[1]!.noResultRaceCount).toBe(10); // 最終日の 10 レースは結果なし
    expect(s.days[0]!.noResultRaceCount).toBe(0);
    expect(s.judgedBetCount).toBeLessThan(M1.stats.judgedBetCount / 5);
    expect(M3.lastDayPending).toBe(true);
    expect(s.byVersion).toHaveLength(1);
  });

  it("3 つの場面は互いに違う月(回収率・件数が同じにならない)", () => {
    const rates = [M1, M2, M3].map((m) => m.stats.recoveryRate);
    expect(new Set(rates).size).toBe(3);
  });
});

describe("プロンプトと確定値の一覧", () => {
  it("プロンプトは場面ごとの規則を持つ: M1 は版の規則あり・M3 は最終日未反映の規則あり・M2 はどちらも無い", () => {
    expect(scenarioPrompt(M1)).toContain("版の優劣を決める材料にしない");
    expect(scenarioPrompt(M2)).not.toContain("版の優劣");
    expect(scenarioPrompt(M3)).toContain("最終日の結果または日報がそろう前に作った");
    expect(scenarioPrompt(M1)).not.toContain("最終日の結果または日報がそろう前に作った");
  });

  it("プロンプトの長さは、日報の 36 レースの日(約 1.6 万字)より短い", () => {
    for (const sc of [M1, M2, M3]) {
      expect(scenarioPrompt(sc).length, sc.id).toBeLessThan(16_000);
    }
  });

  it("生成は決定的(同じシナリオなら同じ文字列・同じ確定値)", () => {
    expect(scenarioPrompt(buildMonthlyScenario("M1"))).toBe(scenarioPrompt(M1));
    expect(JSON.stringify(scenarioFacts(buildMonthlyScenario("M2")))).toBe(JSON.stringify(scenarioFacts(M2)));
  });

  it("確定値の一覧は、統計と同じ数字を持つ(プロンプトの数字を突き合わせる元)", () => {
    const facts = scenarioFacts(M1) as { raceCount: number; totalStake: number; totalReturn: number; days: unknown[]; byVersion: unknown[]; recoveryRate: number };
    expect(facts.raceCount).toBe(M1.stats.raceCount);
    expect(facts.totalStake).toBe(M1.stats.totalStake);
    expect(facts.totalReturn).toBe(M1.stats.totalReturn);
    expect(facts.days).toHaveLength(9);
    expect(facts.byVersion).toHaveLength(2);
    expect(facts.recoveryRate).toBeCloseTo(M1.stats.recoveryRate!, 3);
  });
});

describe("--with-fit: 補正の当たり具合の節を足したプロンプト(Issue #511。長さの測り直し用)", () => {
  const FIT_HEADING = "## 補正の当たり具合(確定値)";

  it("オプション無しは従来のまま(補正の節なし)。withFit を付けた分だけ長くなり、節の見出しと版別の見出しが入る", () => {
    for (const sc of [M1, M2, M3]) {
      const plain = scenarioPrompt(sc);
      const withFit = scenarioPrompt(sc, { withFit: true });
      expect(plain, sc.id).not.toContain(FIT_HEADING);
      expect(withFit, sc.id).toContain(FIT_HEADING);
      expect(withFit, sc.id).toContain("### 補正の当たり具合(月全体・");
      expect(withFit, sc.id).toContain("### 補正の向き別(版 ");
      expect(withFit.length, sc.id).toBeGreaterThan(plain.length);
      expect(withFit.length, sc.id).toBeLessThan(16_000);
    }
  });

  it("サンプルは決定的で、シナリオ本体の stats を書き換えない", () => {
    const before = JSON.stringify(M1.stats);
    expect(scenarioPrompt(M1, { withFit: true })).toBe(scenarioPrompt(M1, { withFit: true }));
    expect(JSON.stringify(M1.stats)).toBe(before);
    expect(M1.stats.adjustmentFit).toBeUndefined();
  });
});
