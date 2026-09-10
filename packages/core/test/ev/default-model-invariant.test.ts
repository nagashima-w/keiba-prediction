import { describe, expect, it } from "vitest";

import {
  allocateGeneralBets,
  buildComboCandidates,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type JointModelHorse,
} from "../../src/ev/combo-bet-allocation.js";
import { allocateBets, DEFAULT_BET_ALLOCATION_CONFIG, type AllocationHorse } from "../../src/ev/bet-allocation.js";
import { CONDITIONAL_BERNOULLI_MODEL } from "../../src/ev/place-joint-model.js";
import { buildComboOddsKey } from "../../src/scraper/combo-odds-key.js";

/**
 * default-model-invariant — Issue #80(#78-A)のAC-A6。
 *
 * #80は「任意のモデルがthrowしても外へ漏れない」受け皿を追加するタスクであり、既定モデル・
 * すべての数値は不変でなければならない(#78着手前ゲートで確定)。本ファイルは、AC-A1で数えた
 * 「#80が受け皿を用意すべき3箇所」(`allocateBets`・`allocateGeneralBets`・`buildComboCandidates`)
 * それぞれについて、既定(model引数省略)が`CONDITIONAL_BERNOULLI_MODEL`
 * (`modelId==="conditional-bernoulli"`)のままであることをリテラルで固定する。
 *
 * `allocateBets`/`allocateGeneralBets`は結果に`modelId`を載せるため直接比較できるが、
 * `buildComboCandidates`の戻り値(`ComboCandidateBuildResult`)は候補・診断値のみで
 * モデルのidを載せない。そのため、model引数を省略した呼び出しと`CONDITIONAL_BERNOULLI_MODEL`を
 * 明示的に渡した呼び出しが完全に同一の結果を返すことを構造的に確認する(等価性による間接証明)。
 */

function horse(umaban: number, placeProb: number): JointModelHorse & AllocationHorse {
  return { umaban, placeProb, placeOddsMin: 3, ev: 1.5, isPositive: true };
}

describe("AC-A6: #80が受け皿を用意する3箇所すべてで既定モデルがconditional-bernoulliのままであること", () => {
  it("CONDITIONAL_BERNOULLI_MODEL.id自体がリテラル'conditional-bernoulli'であること(前提固定)", () => {
    expect(CONDITIONAL_BERNOULLI_MODEL.id).toBe("conditional-bernoulli");
  });

  it("入口1: allocateBets(model省略)の結果.modelIdが'conditional-bernoulli'であること", () => {
    const horses = [horse(1, 0.6), horse(2, 0.5), horse(3, 0.4)];
    const result = allocateBets(horses, 1, {
      ...DEFAULT_BET_ALLOCATION_CONFIG,
      bankroll: 10000,
      perRaceCap: 10000,
    });
    expect(result.modelId).toBe("conditional-bernoulli");
  });

  it("入口2: allocateGeneralBets(model省略)の結果.modelIdが'conditional-bernoulli'であること", () => {
    const horses: JointModelHorse[] = [horse(1, 0.6), horse(2, 0.5), horse(3, 0.4)];
    const candidates = [
      { betType: "place" as const, umabans: [1], odds: 3, ev: 1.5, isPositive: true },
    ];
    const result = allocateGeneralBets(horses, 3, candidates, {
      ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
      bankroll: 10000,
      perRaceCap: 10000,
    });
    expect(result.modelId).toBe("conditional-bernoulli");
  });

  it("入口3: buildComboCandidates(model省略)がCONDITIONAL_BERNOULLI_MODEL明示指定と完全同一の結果を返すこと(間接証明)", () => {
    const horses: JointModelHorse[] = [horse(1, 0.6), horse(2, 0.5), horse(3, 0.4), horse(4, 0.3)];
    const oddsByKey = new Map<string, number | null>([
      [buildComboOddsKey([1, 2]), 50],
      [buildComboOddsKey([1, 3]), 50],
      [buildComboOddsKey([1, 4]), 50],
      [buildComboOddsKey([2, 3]), 50],
      [buildComboOddsKey([2, 4]), 50],
      [buildComboOddsKey([3, 4]), 50],
    ]);
    const withoutModel = buildComboCandidates(horses, 3, "wide", oddsByKey);
    const withExplicitCbModel = buildComboCandidates(horses, 3, "wide", oddsByKey, undefined, CONDITIONAL_BERNOULLI_MODEL);
    expect(withoutModel).toEqual(withExplicitCbModel);
    // 空振り防止: 候補が実際に1件以上あること(空配列同士のtoEqualという退化を避ける)。
    expect(withoutModel.candidates.length).toBeGreaterThan(0);
  });
});
