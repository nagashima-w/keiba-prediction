import { describe, expect, it } from "vitest";
import type { RaceData } from "../../src/index.js";
import type { PrevRaceCondition } from "../../src/scraper/parse-newspaper.js";
import { computeGolden, RACE_ID, scrapeFixtureRace, viaJson, type GoldenFile } from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #421 段階 1-b の AC-P: **前走の条件は、スナップショットに残すだけで、LLM のプロンプト・統計モデルの確率・配分には一切使わない**。
 *
 * golden は `includePrevConditions` を渡さない(RaceData に `prevRaceConditions` が載らない)ので、`prevRaceConditions` が載った RaceData が
 * プロンプトや統計モデルに漏れても golden では検出できない。そこで、**同じ 3 シナリオを、前走の表を載せた RaceData と載せない RaceData で走らせ**、
 * 違いが `record.raceSnapshot.horses[].prevRace` だけであることを固定する(プロンプトの全文・LLM への入力・確率・配分・結果行はバイト単位で同じ)。
 *
 * 表は**全馬の全走**の race_id について作る(前走だけでなく、どの走を引いても当たる。どの走の条件を使っても差が出る)。
 * 値は馬・走ごとに変える(牝馬限定・ハンデ・見込を混ぜる。使われれば特徴量やプロンプトの文面が変わりうる値)。
 * **結合後の前走の値が馬ごとに散っていること**(牝馬限定が true/false/null の馬がそれぞれ複数頭いる)を、スナップショットの実出力で無条件に固定する
 * (Issue #433。表の値が複数種でも、結合後が偏ると、「前走が牝馬限定なら prior を動かす」ような値に依存する漏れを検出できない。フィクスチャは 16 頭中 13 頭が同じ馬ページなので、走の ID を馬ごとに書き換える)。
 */

/**
 * 馬ごと・走ごとに一意な合成のレース ID に、全走の raceIdRaw を書き換えた RaceData(自レースの走と raceIdRaw が null の走は書き換えない)。
 * **なぜ書き換えるか**: フィクスチャは 16 頭中 13 頭が同じ馬ページで、そのまま使うと結合後の前走(自レース除外・日付の絞りの後の先頭)が 13 頭で同一になり、
 * 馬ごとの値(牝馬限定・ハンデなど)を散らせない。値に依存する漏れ(前走が牝馬限定なら prior を動かす等)は、`true` の馬が少数・0 頭だと検出できない。
 * 書き換えは入力側だけで、比較する 2 つの RaceData(表を載せる側・載せない側)は同じ書き換え後のベースから作る。
 * 自レースの走は残す(`excludeOwnRaceResults` が `raceIdRaw === raceId` で除くため。書き換えると自レース除外が効かなくなる)。
 */
function withDistinctRunIds(race: RaceData): RaceData {
  return {
    ...race,
    horses: race.horses.map((horse, i) => ({
      ...horse,
      results:
        horse.results === null || horse.results === undefined
          ? horse.results
          : horse.results.map((run, j) =>
              run.raceIdRaw === null || run.raceIdRaw === RACE_ID
                ? run
                : { ...run, raceIdRaw: `2025${String(i).padStart(2, "0")}${String(j).padStart(2, "0")}0000` },
            ),
    })),
  };
}

/**
 * 全馬の全走の raceIdRaw → 走ごとに値を変えた条件。
 * 値は馬の番号 i と走の番号 j の和で循環させる(馬 i の結合される走は先頭の 1 走だけなので、結合後の値が馬ごとに散る)。
 * 牝馬限定は true/false/null の 3 種、負担重量の種別は 6 種(null を含む)。
 */
function buildExhaustiveTable(race: RaceData): Record<string, PrevRaceCondition> {
  const table: Record<string, PrevRaceCondition> = {};
  const kinds = ["ハンデ", "別定", "定量", "馬齢", "見込", null] as const;
  race.horses.forEach((horse, i) => {
    (horse.results ?? []).forEach((run, j) => {
      if (run.raceIdRaw === null || Object.hasOwn(table, run.raceIdRaw)) return;
      const k = i + j;
      const fillies = k % 3 === 0 ? true : k % 3 === 1 ? false : null;
      table[run.raceIdRaw] = { weightType: kinds[k % kinds.length]!, condition: fillies === null ? null : fillies ? "(国際)牝(指)" : "(混)[指]", filliesOnly: fillies };
    });
  });
  return table;
}

/** スナップショットの prevRace の中身(結合された前走)。 */
interface PrevRaceJoined {
  readonly raceId: string;
  readonly weightType: string | null;
  readonly condition: string | null;
  readonly filliesOnly: boolean | null;
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
    const scraped = await scrapeFixtureRace({ includeJockeyStats: true, includeTrainerStats: true, jockeyRequestLimit: 1000 });
    const base = withDistinctRunIds(scraped);
    // 前提: 書き換えは前走の走だけに効く。自レースの走(raceIdRaw === RACE_ID)と null の走の数は書き換え前と同じで、自レースの走は残っている(自レース除外を壊していない)
    const countRuns = (r: RaceData, pred: (id: string | null) => boolean): number => r.horses.reduce((n, h) => n + (h.results ?? []).filter((x) => pred(x.raceIdRaw)).length, 0);
    expect(countRuns(base, (id) => id === RACE_ID)).toBeGreaterThanOrEqual(1);
    expect(countRuns(base, (id) => id === RACE_ID)).toBe(countRuns(scraped, (id) => id === RACE_ID));
    expect(countRuns(base, (id) => id === null)).toBeGreaterThanOrEqual(1);
    expect(countRuns(base, (id) => id === null)).toBe(countRuns(scraped, (id) => id === null));
    // 前提: 全走の件数は変わらない(走を捨てても足してもいない)
    expect(countRuns(base, () => true)).toBe(countRuns(scraped, () => true));
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
    // 前提(★値に依存する漏れを検出する条件): **結合された前走**(スナップショットの prevRace。自レース除外・日付の絞りの後の先頭の走で引かれた値)の値が、馬ごとに散っている。
    // 表全体の値の種類ではなく、結合後の実出力で固定する(表の値が複数種でも、結合後が偏れば、値に依存する漏れは検出できない)。
    for (const scenario of [withTable.noLlmAllBets, withTable.llmStubSameDayGrade, withTable.noLlmNoAllocation]) {
      const joined = (scenario.record.raceSnapshot as { horses: Array<{ prevRace?: PrevRaceJoined | null }> }).horses.map((h) => h.prevRace ?? null);
      const rows = joined.filter((p): p is PrevRaceJoined => p !== null);
      expect(joined.length - rows.length, "前走を引けない馬(戦績の raceIdRaw が全て null の馬)が 1 頭以上いる").toBeGreaterThanOrEqual(1);
      expect(rows.filter((p) => p.filliesOnly === true).length, "結合後に牝馬限定=true の馬").toBeGreaterThanOrEqual(2);
      expect(rows.filter((p) => p.filliesOnly === false).length, "結合後に牝馬限定=false の馬").toBeGreaterThanOrEqual(2);
      expect(rows.filter((p) => p.filliesOnly === null).length, "結合後に牝馬限定=null の馬").toBeGreaterThanOrEqual(2);
      expect(new Set(rows.map((p) => p.weightType)).size, "結合後の負担重量の種別(null を含む)").toBeGreaterThanOrEqual(5);
      expect(new Set(rows.map((p) => p.raceId)).size, "結合後の前走のレース ID").toBeGreaterThanOrEqual(8);
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
