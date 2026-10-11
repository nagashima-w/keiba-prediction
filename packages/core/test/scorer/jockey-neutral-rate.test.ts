import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCORER_CONFIG } from "../../src/scorer/config.js";
import { parseRaceList } from "../../src/scraper/parse-race-list.js";

/**
 * 騎手の複勝率の中立(`baseScore.jockeyNeutralPlaceRate`)の既定値の根拠を再現する(Issue #226)。
 *
 * 全騎乗の複勝率の平均は、各レースで3着以内に入る馬の数 min(3, 頭数) を全レースで足し、出走数(頭数の合計)で
 * 割った値 `Σ min(3,頭数) / Σ 頭数` に等しい。これをレース一覧のフィクスチャ(出走頭数が入っている)から求める。
 * 既存の `neutralPlaceRate`(0.33)は「馬」の複勝率の目安で、騎手の中立に流用すると平均的な騎手が全員マイナス補正になる
 * (中央の実測 0.22 に対し 0.33 は 0.11 高い)。そこで中央と地方で別の値を持つ。
 *
 * 再現: `cd packages/core && npx vitest run test/scorer/jockey-neutral-rate.test.ts`。
 * フィクスチャは**ファイル名を固定**している(glob にしない。レース一覧のフィクスチャが増えて計算結果が動いても、
 * 既定値の根拠が黙って変わらないように)。
 */

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** Σ min(3,頭数) / Σ 頭数 と、その内訳(検算用)。 */
function meanPlaceRate(files: readonly string[]): { rate: number; races: number; heads: number } {
  let races = 0;
  let heads = 0;
  let placed = 0;
  for (const f of files) {
    for (const entry of parseRaceList(loadFixture(f))) {
      races += 1;
      heads += entry.entryCount;
      placed += Math.min(3, entry.entryCount);
    }
  }
  return { rate: placed / heads, races, heads };
}

const CENTRAL_FILES = [
  "race_list_sub_20260214.html",
  "race_list_sub_20260314.html",
  "race_list_sub_20260418.html",
  "race_list_sub_20260628.html",
  "race_list_sub_20260808.html",
  "race_list_sub_20260926.html",
  "race_list_sub_20260927.html",
  "race_list_sub_20261004.html",
] as const;

const NAR_FILES = [
  "nar_race_list_sub_20260624.html",
  "nar_race_list_sub_20260712.html",
  "nar_race_list_sub_20260713.html",
  "nar_race_list_sub_20260808.html",
  "nar_race_list_sub_20260924.html",
  "nar_race_list_sub_20260927.html",
  "nar_race_list_sub_20260930.html",
] as const;

describe("騎手の複勝率の中立の既定値(全騎乗の平均複勝率 = Σmin(3,頭数)/Σ頭数)", () => {
  it("中央: 8開催日・252レース・3,501頭 → 0.2159 → 小数2桁で 0.22 が既定値", () => {
    const m = meanPlaceRate(CENTRAL_FILES);
    expect(m.races).toBe(252);
    expect(m.heads).toBe(3501);
    expect(m.rate).toBeCloseTo(0.2159, 4);
    expect(DEFAULT_SCORER_CONFIG.baseScore.jockeyNeutralPlaceRate.central).toBe(Math.round(m.rate * 100) / 100);
    expect(DEFAULT_SCORER_CONFIG.baseScore.jockeyNeutralPlaceRate.central).toBe(0.22);
  });

  it("地方: 7開催日・254レース・2,622頭 → 0.2906 → 小数2桁で 0.29 が既定値", () => {
    const m = meanPlaceRate(NAR_FILES);
    expect(m.races).toBe(254);
    expect(m.heads).toBe(2622);
    expect(m.rate).toBeCloseTo(0.2906, 4);
    expect(DEFAULT_SCORER_CONFIG.baseScore.jockeyNeutralPlaceRate.nar).toBe(Math.round(m.rate * 100) / 100);
    expect(DEFAULT_SCORER_CONFIG.baseScore.jockeyNeutralPlaceRate.nar).toBe(0.29);
  });

  it("中央と地方は別の値(地方は頭数が少ないぶん、平均複勝率が高い)", () => {
    const { central, nar } = DEFAULT_SCORER_CONFIG.baseScore.jockeyNeutralPlaceRate;
    expect(nar).toBeGreaterThan(central);
  });
});
