import { describe, expect, it } from "vitest";

import {
  allocateGeneralBets,
  buildComboCandidates,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type JointModelHorse,
} from "../../src/ev/combo-bet-allocation.js";
import { allocateBets, DEFAULT_BET_ALLOCATION_CONFIG, type AllocationHorse } from "../../src/ev/bet-allocation.js";
import { CONDITIONAL_BERNOULLI_MODEL } from "../../src/ev/place-joint-model.js";
import { PLACKETT_LUCE_MODEL } from "../../src/ev/plackett-luce-model.js";
import { fitPlackettLuceStrengths } from "../../src/ev/plackett-luce-strength.js";
import { buildComboOddsKey } from "../../src/scraper/combo-odds-key.js";

/**
 * default-model-invariant — 元は Issue #80(#78-A)の AC-A6 として新設(既定が
 * `CONDITIONAL_BERNOULLI_MODEL` のままであることの固定)。Issue #81(#78-B)で既定を
 * `PLACKETT_LUCE_MODEL` へ切り替えたため、AC-B1' として**反転**する
 * (#81着手前ゲートで確定。CB行の期待値を書き換えるのではなく、CB行は明示的に
 * `CONDITIONAL_BERNOULLI_MODEL` を渡す形へ変え、新たに「引数なし = PL 行」を検証する)。
 *
 * 本ファイルは、「model引数を省略できる3箇所」(`allocateBets`・`allocateGeneralBets`・
 * `buildComboCandidates`)それぞれについて、既定(model引数省略)が`PLACKETT_LUCE_MODEL`
 * (`modelId==="plackett-luce"`)になったことをリテラルで固定する。
 *
 * `allocateBets`/`allocateGeneralBets`は結果に`modelId`を載せるため直接比較できるが、
 * `buildComboCandidates`の戻り値(`ComboCandidateBuildResult`)は候補・診断値のみで
 * モデルのidを載せない。そのため、model引数を省略した呼び出しと`PLACKETT_LUCE_MODEL`を
 * 明示的に渡した呼び出しが完全に同一の結果を返すことを構造的に確認する(等価性による間接証明)。
 * **加えて、model引数を省略した呼び出しが`CONDITIONAL_BERNOULLI_MODEL`明示指定とは
 * 異なる結果を返すことも`not.toEqual`で固定する**(#80版には無かった観点。これが無いと、
 * 両モデルがたまたま一致するフィクスチャに差し替えられても検出できない)。
 */

function horse(umaban: number, placeProb: number): JointModelHorse & AllocationHorse {
  return { umaban, placeProb, placeOddsMin: 3, ev: 1.5, isPositive: true };
}

describe("AC-B1': model引数を省略できる3箇所すべてで既定モデルがplackett-luceになったこと(#81)", () => {
  it("CONDITIONAL_BERNOULLI_MODEL.id自体がリテラル'conditional-bernoulli'であること(前提固定)", () => {
    expect(CONDITIONAL_BERNOULLI_MODEL.id).toBe("conditional-bernoulli");
  });

  it("PLACKETT_LUCE_MODEL.id自体がリテラル'plackett-luce'であること(前提固定。#81で既定に採用したモデル)", () => {
    expect(PLACKETT_LUCE_MODEL.id).toBe("plackett-luce");
  });

  it("入口1: allocateBets(model省略)の結果.modelIdが'plackett-luce'であること", () => {
    const horses = [horse(1, 0.6), horse(2, 0.5), horse(3, 0.4)];
    const result = allocateBets(horses, 1, {
      ...DEFAULT_BET_ALLOCATION_CONFIG,
      bankroll: 10000,
      perRaceCap: 10000,
    });
    expect(result.modelId).toBe("plackett-luce");
  });

  it("入口2: allocateGeneralBets(model省略)の結果.modelIdが'plackett-luce'であること", () => {
    const horses: JointModelHorse[] = [horse(1, 0.6), horse(2, 0.5), horse(3, 0.4)];
    const candidates = [
      { betType: "place" as const, umabans: [1], odds: 3, ev: 1.5, isPositive: true },
    ];
    const result = allocateGeneralBets(horses, 3, candidates, {
      ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
      bankroll: 10000,
      perRaceCap: 10000,
    });
    expect(result.modelId).toBe("plackett-luce");
  });

  it("入口3: buildComboCandidates(model省略)がPLACKETT_LUCE_MODEL明示指定と完全同一の結果を返し、CONDITIONAL_BERNOULLI_MODEL明示指定とは異なること(間接証明)", () => {
    // #80版のフィクスチャ(p=[0.6,0.5,0.4,0.3], k=3)はPLで`not-converged`(θ推定の非収束)により
    // throwするため使えない(#81着手前ゲートboss実測)。収束し、かつdegenerateFixedCount===0
    // (縮退経路に落ちずθフィットそのものを通る)フィクスチャへ差し替える。
    const horses: JointModelHorse[] = [horse(1, 0.5), horse(2, 0.45), horse(3, 0.35), horse(4, 0.25)];
    const placeCount = 3;

    // 前提(無条件expect): このフィクスチャがPLで実際にθフィットの自由集合を解いている
    // (縮退〈p=0除外・p=1固定・水詰め再スケールによる固定〉に落ちていないこと)。
    // これが無いと、PLが縮約経路に落ちて「PLのフィットそのもの」を通らないまま
    // 「引数なし===PL明示」が成立してしまい、検出力の出所がすり替わる。
    const fit = fitPlackettLuceStrengths(
      horses.map((h) => ({ umaban: h.umaban, placeProb: h.placeProb })),
      placeCount,
    );
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.degenerateFixedCount).toBe(0);

    const oddsByKey = new Map<string, number | null>([
      [buildComboOddsKey([1, 2]), 50],
      [buildComboOddsKey([1, 3]), 50],
      [buildComboOddsKey([1, 4]), 50],
      [buildComboOddsKey([2, 3]), 50],
      [buildComboOddsKey([2, 4]), 50],
      [buildComboOddsKey([3, 4]), 50],
    ]);
    const withoutModel = buildComboCandidates(horses, placeCount, "wide", oddsByKey);
    const withExplicitPlModel = buildComboCandidates(horses, placeCount, "wide", oddsByKey, undefined, PLACKETT_LUCE_MODEL);
    const withExplicitCbModel = buildComboCandidates(horses, placeCount, "wide", oddsByKey, undefined, CONDITIONAL_BERNOULLI_MODEL);
    expect(withoutModel).toEqual(withExplicitPlModel);
    expect(withoutModel).not.toEqual(withExplicitCbModel);
    // 空振り防止: 候補が実際に1件以上あること(空配列同士のtoEqualという退化を避ける)。
    expect(withoutModel.candidates.length).toBeGreaterThan(0);
  });
});
