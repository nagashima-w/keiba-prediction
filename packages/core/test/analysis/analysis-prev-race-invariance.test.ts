import { describe, expect, it } from "vitest";
import type { RaceData } from "../../src/index.js";
import type { PrevRaceCondition } from "../../src/scraper/parse-newspaper.js";
import { computeGolden, scrapeFixtureRace, viaJson, type GoldenFile } from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #421 段階 1-b の AC-P: **前走の条件は、スナップショットに残すだけで、LLM のプロンプト・統計モデルの確率・配分には一切使わない**。
 *
 * golden は `includePrevConditions` を渡さない(RaceData に `prevRaceConditions` が載らない)ので、`prevRaceConditions` が載った RaceData が
 * プロンプトや統計モデルに漏れても golden では検出できない。そこで、**同じ 3 シナリオを、前走の表を載せた RaceData と載せない RaceData で走らせ**、
 * 違いが `record.raceSnapshot.horses[].prevRace` だけであることを固定する(プロンプトの全文・LLM への入力・確率・配分・結果行はバイト単位で同じ)。
 *
 * 表は**全馬の全走**の race_id について作る(前走だけでなく、どの走を引いても当たる。どの走の条件を使っても差が出る)。
 * 値は走ごとに変える(牝馬限定・ハンデ・見込を混ぜる。使われれば特徴量やプロンプトの文面が変わりうる値)。
 */

/** 全馬の全走の raceIdRaw → 走ごとに値を変えた条件。 */
function buildExhaustiveTable(race: RaceData): Record<string, PrevRaceCondition> {
  const table: Record<string, PrevRaceCondition> = {};
  const kinds = ["ハンデ", "別定", "定量", "馬齢", "見込", null] as const;
  let i = 0;
  for (const horse of race.horses) {
    for (const run of horse.results ?? []) {
      if (run.raceIdRaw === null || Object.hasOwn(table, run.raceIdRaw)) continue;
      const fillies = i % 3 === 0 ? true : i % 3 === 1 ? false : null;
      table[run.raceIdRaw] = { weightType: kinds[i % kinds.length]!, condition: fillies === null ? null : fillies ? "(国際)牝(指)" : "(混)[指]", filliesOnly: fillies };
      i += 1;
    }
  }
  return table;
}

/** record.raceSnapshot.horses[].prevRace を取り除いた複製(それ以外は変えない)。 */
function withoutPrevRace(golden: GoldenFile): GoldenFile {
  const copy = viaJson(golden);
  for (const scenario of [copy.noLlmAllBets, copy.llmStubSameDayGrade, copy.noLlmNoAllocation]) {
    const snapshot = scenario.record.raceSnapshot as { horses: Array<Record<string, unknown>> };
    for (const h of snapshot.horses) {
      delete h["prevRace"];
    }
  }
  return copy;
}

describe("前走の条件の不変性(AC-P)", () => {
  it("前走の表を載せた RaceData でも、3 シナリオの出力(プロンプト全文・LLM への入力・確率・配分・結果行)は、載せない場合と prevRace を除いて完全に一致する", async () => {
    // 騎手・調教師の年度別成績も取った RaceData を土台にする(統計モデルの入力に使われる項目を揃える。揃えないと、それらを捨てる/変える漏れが、元から無い項目の上で等価になって検出できない)。
    const base = await scrapeFixtureRace({ includeJockeyStats: true, includeTrainerStats: true, jockeyRequestLimit: 1000 });
    // 前提(空振り防止): 騎手・調教師の成績が実際に載っている
    expect(Object.keys(base.jockeyStats ?? {}).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(base.trainerStats ?? {}).length).toBeGreaterThanOrEqual(3);
    const table = buildExhaustiveTable(base);
    // 前提(空振り防止): 表が多数の走を覆い、条件の値が複数種類ある(退化していない)
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(10);
    expect(new Set(Object.values(table).map((v) => v.weightType)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(Object.values(table).map((v) => v.filliesOnly)).size).toBe(3);

    const without = await computeGolden({}, base);
    const withTable = await computeGolden({}, { ...base, prevRaceConditions: table });

    // 前提: 表を載せた側のスナップショットには、実際に prevRace が(null でなく)入っている=差が構成されている
    for (const scenario of [withTable.noLlmAllBets, withTable.llmStubSameDayGrade, withTable.noLlmNoAllocation]) {
      const horses = (scenario.record.raceSnapshot as { horses: Array<{ prevRace?: unknown }> }).horses;
      expect(horses).toHaveLength(16);
      expect(horses.filter((h) => h.prevRace !== null && h.prevRace !== undefined).length).toBeGreaterThanOrEqual(8);
    }
    // 前提: 載せない側には prevRace のキーが無い
    expect(JSON.stringify(without)).not.toContain("prevRace");
    // 前提: LLM のシナリオでプロンプトを実際に作っている
    expect(withTable.llmStubSameDayGrade.promptText?.length ?? 0).toBeGreaterThan(1000);
    expect(withTable.llmStubSameDayGrade.promptInput).toBeDefined();

    // 本体: prevRace だけを除いて完全一致
    expect(withoutPrevRace(withTable)).toEqual(without);
    // prevRace はスナップショットの外(結果・プロンプト・LLM への入力)に出ていない
    for (const scenario of [withTable.noLlmAllBets, withTable.llmStubSameDayGrade, withTable.noLlmNoAllocation]) {
      expect(JSON.stringify(scenario.result)).not.toContain("prevRace");
    }
    expect(JSON.stringify(withTable.llmStubSameDayGrade.promptInput)).not.toContain("prevRace");
    expect(withTable.llmStubSameDayGrade.promptText).not.toContain("prevRace");
    expect(withTable.llmStubSameDayGrade.promptText).toBe(without.llmStubSameDayGrade.promptText);
  }, 60_000);
});
