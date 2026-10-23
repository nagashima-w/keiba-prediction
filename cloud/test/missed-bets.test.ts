import { describe, expect, it } from "vitest";
import { parseMissedJson, serializeMissed } from "../src/missed-bets";
import type { AnalysisMissedBetRecord } from "../../packages/core/src/ev/analysis-store-types.js";

/**
 * Issue #470: 外した買い目の記録(`analysis_allocation_meta.missed_json`)の JSON の形。
 * 表し方: null = 記録していない / `[]` = 外れた候補はあったが賭け金が付くものは無かった / 1件以上 = 外さなかった場合に賭け金が付いた候補。
 */
const ROW: AnalysisMissedBetRecord = { betType: "trio", comboKey: "010203", hitProb: 0.0125, odds: 260.2, ev: 3.25, wouldStake: 900 };
const ROW2: AnalysisMissedBetRecord = { betType: "exacta", comboKey: "1308", hitProb: 0.03, odds: 83.6, ev: 2.5, wouldStake: 200 };

describe("serializeMissed", () => {
  it("null は null のまま(記録していない)。空配列は '[]'(外れたが賭け金が付くものは無かった)。両者は区別できる", () => {
    expect(serializeMissed(null)).toBeNull();
    expect(serializeMissed(undefined)).toBeNull();
    expect(serializeMissed([])).toBe("[]");
  });

  it("各要素は snake_case のキー(bet_type・combo_key・hit_prob・odds・ev・would_stake)で、入力の並びのまま", () => {
    const json = serializeMissed([ROW, ROW2])!;
    expect(JSON.parse(json)).toEqual([
      { bet_type: "trio", combo_key: "010203", hit_prob: 0.0125, odds: 260.2, ev: 3.25, would_stake: 900 },
      { bet_type: "exacta", combo_key: "1308", hit_prob: 0.03, odds: 83.6, ev: 2.5, would_stake: 200 },
    ]);
    // キーの並びも固定(保存した JSON を人が読むとき・差分を取るときに安定させる)
    expect(Object.keys(JSON.parse(json)[0])).toEqual(["bet_type", "combo_key", "hit_prob", "odds", "ev", "would_stake"]);
  });
});

describe("parseMissedJson(読み戻し)", () => {
  it("往復で元に戻る。null・'[]' も区別して戻る", () => {
    expect(parseMissedJson(serializeMissed([ROW, ROW2]))).toEqual([ROW, ROW2]);
    expect(parseMissedJson(null)).toBeNull();
    expect(parseMissedJson("[]")).toEqual([]);
  });

  it("壊れた JSON・配列でないもの・要素の型違いは null(読めない。例外にしない)", () => {
    expect(parseMissedJson("{")).toBeNull();
    expect(parseMissedJson("{}")).toBeNull();
    expect(parseMissedJson(JSON.stringify([{ bet_type: "trio" }]))).toBeNull();
    expect(parseMissedJson(JSON.stringify([{ bet_type: "trio", combo_key: "x", hit_prob: "0.1", odds: 1, ev: 1, would_stake: 100 }]))).toBeNull();
  });
});
