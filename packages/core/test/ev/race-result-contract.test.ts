import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  computeRaceResultContract,
  type RaceResultContract,
} from "../golden/race-result-scenarios.js";

/**
 * Issue #207(#182-A)AC-A3: 結果の保存の golden(共有フィクスチャ)。
 *
 * `test/golden/race-result-contract.json` は、同じ入力(シナリオ)を exe の `AnalysisStore.saveResult` で保存したときの**4表のダンプ**
 * (race_results・race_result_meta・race_combo_payouts・race_combo_payout_imports)と、`getRaceResultDetail` の復元結果。
 * クラウド版の `D1ResultStore`(cloud/test/result-repository.test.ts)が同じファイルを読み、**同じ入力から同じダンプ・同じ復元結果**になることを確かめる。
 * ここ(exe 側)は、golden が exe の実際の出力であること(= golden が exe から乖離していないこと)を固定する。
 *
 * golden は `pnpm tsx scripts/gen-race-result-contract.ts`(リポジトリルートで)で生成する。入力はリポジトリ内のフィクスチャ(`fixtures/`)と固定の合成値で、
 * 実ネットワークには触れない。**exe の保存の挙動を意図して変えたときだけ再生成する**(意図しない差分が出たら、それは exe の出力が変わったことを意味する)。
 */

const GOLDEN_PATH = fileURLToPath(new URL("../golden/race-result-contract.json", import.meta.url));
const committed = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as RaceResultContract;

describe("golden が exe の実際の出力であること", () => {
  it("同じシナリオを exe の AnalysisStore で保存し直した結果が、コミット済みの golden と一致する", () => {
    expect(computeRaceResultContract()).toStrictEqual(committed);
  });
});

describe("golden の前提(空振りを防ぐ。入力が退化していないこと)", () => {
  const byName = (name: string) => committed.cases.find((c) => c.name === name)!;

  it("ケース名は一意で、期待するシナリオがそろっている", () => {
    const names = committed.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "central-fixture-16-heads",
      "nar-fixture",
      "synthetic-18-heads-all-bet-types",
      "all-finish-null-no-meta-no-combo",
      "resave-delete-then-insert-undetermined-keeps",
      "undetermined-only",
      "defensive-restore",
    ]);
  });

  it("18頭のケースは、馬ごとの UPSERT の束縛値が 100 を超える大きさ(18頭 × 7列 = 126)で、全6券種が parsed", () => {
    const c = byName("synthetic-18-heads-all-bet-types");
    const step = c.steps[0]!;
    expect(step.entries).toHaveLength(18);
    expect(step.entries.length * 7).toBeGreaterThan(100);
    expect(c.expected.race_results).toHaveLength(18);
    const combo = step.comboPayouts!;
    expect(Object.keys(combo).sort()).toEqual(["bracketQuinella", "exacta", "quinella", "trifecta", "trio", "wide"]);
    expect(Object.values(combo).every((r) => r.state === "parsed")).toBe(true);
    // 全6券種のマーカーが書かれている
    expect(c.expected.race_combo_payout_imports.map((r) => r.bet_type).sort()).toEqual(
      ["bracketQuinella", "exacta", "quinella", "trifecta", "trio", "wide"],
    );
  });

  it("全頭中止のケースは、行はあるが着順が全て null で、面・組合せの行は無い", () => {
    const c = byName("all-finish-null-no-meta-no-combo");
    expect(c.expected.race_results.length).toBeGreaterThan(0);
    expect(c.expected.race_results.every((r) => r.finish_position === null)).toBe(true);
    expect(c.expected.race_result_meta).toEqual([]);
    expect(c.expected.race_combo_payouts).toEqual([]);
    expect(c.expected.race_combo_payout_imports).toEqual([]);
  });

  it("再保存のケース: 2回目の保存で、wide は払戻0件(マーカーのみ)・trio は undetermined で据え置き・quinella は行が減る・別レースは無傷", () => {
    const c = byName("resave-delete-then-insert-undetermined-keeps");
    expect(c.steps).toHaveLength(3);
    const rowsOf = (raceId: string, bet: string) =>
      c.expected.race_combo_payouts.filter((r) => r.race_id === raceId && r.bet_type === bet);
    expect(rowsOf("202603020211", "wide")).toHaveLength(0);
    expect(c.expected.race_combo_payout_imports).toContainEqual({ race_id: "202603020211", bet_type: "wide" });
    expect(rowsOf("202603020211", "trio").length).toBeGreaterThan(0); // 据え置き
    expect(rowsOf("202603020211", "quinella")).toHaveLength(1); // 2→1
    expect(rowsOf("202603020212", "wide").length).toBeGreaterThan(0); // 別レース
  });

  it("undetermined だけのケースは、着順は保存されるが、組合せの行もマーカーも無い", () => {
    const c = byName("undetermined-only");
    expect(c.expected.race_results.length).toBeGreaterThan(0);
    expect(c.expected.race_combo_payouts).toEqual([]);
    expect(c.expected.race_combo_payout_imports).toEqual([]);
  });

  it("防御的復元のケース: 壊れた通過順と未知の面が入っていて、復元は [] と null になる(正常な馬1は値のまま)", () => {
    const c = byName("defensive-restore");
    expect(c.raw!.race_results.some((r) => r.passing_json === "broken")).toBe(true);
    expect(c.raw!.race_result_meta[0]!.course_type).toBe("turf");
    const detail = c.expectedDetails["202603020299"]!;
    expect(detail.courseType).toBeNull();
    // 馬1は正常な通過順、馬2〜5は壊れた値(壊れた JSON・NULL・文字列の要素・数値でない要素)で、いずれも [] に復元される
    expect(detail.horses.map((h) => h.passing)).toEqual([[1, 2], [], [], [], []]);
  });

  it("実フィクスチャのケースは、馬単・三連単の順序付きキー(昇順でない)と、複勝・単勝の払戻を含む", () => {
    const nar = byName("nar-fixture");
    const keys = nar.expected.race_combo_payouts.map((r) => `${r.bet_type}:${r.combo_key}`);
    expect(keys).toContain("exacta:0507");
    expect(keys).toContain("trifecta:050701");
    const central = byName("central-fixture-16-heads");
    expect(central.expected.race_results).toHaveLength(16);
    expect(central.expected.race_results.some((r) => r.place_payout !== null)).toBe(true);
    expect(central.expected.race_results.some((r) => r.win_payout !== null)).toBe(true);
    expect(central.expected.race_combo_payout_imports.length).toBeGreaterThan(0);
  });

  it("expectedDetails は、触れた全レースに加えて、存在しないレース(null)を含む", () => {
    for (const c of committed.cases) {
      expect(Object.values(c.expectedDetails).some((d) => d === null), c.name).toBe(true);
      expect(Object.values(c.expectedDetails).some((d) => d !== null), c.name).toBe(true);
    }
  });
});
