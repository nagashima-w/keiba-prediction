/**
 * plackett-luce-model — PLACKETT_LUCE_MODEL(PlaceJointModel の Plackett-Luce 実装。Issue #77・#20-A)。
 *
 * `fitPlackettLuceStrengths` で推定した θ から、複勝圏内の組合せ(部分集合)の同時分布を厳密に
 * 構築する。`PlaceJointModel` インタフェース自体は変更しない(既存の呼び出し元は無改変)。
 *
 * ## 既定は変えない(#20-A のスコープ)
 * `bet-allocation.ts`・`combo-bet-allocation.ts` の既定モデルは引き続き `CONDITIONAL_BERNOULLI_MODEL`
 * のまま。本モデルへの切替は #20-B(#78)のスコープであり、#20-A 時点で本モデルの production
 * 呼び出し元はゼロ件(`grep`で実測。完了報告参照)。
 *
 * ## θ→C(n,k)分布の厳密変換
 * 部分集合 S(|S|=k)が「上位k集合」になる確率は、S内のk!通りの並び順それぞれについて
 *   ∏_{t=1}^{k} θ_{σ(t)} / (Θ_total − Σ_{u<t} θ_{σ(u)})
 * を計算し総和を取ることで厳密に求まる(分母がSの中で既に選ばれたメンバーの累積θにしか依存せず、
 * 補集合の中身に依存しないという事実による。plackett-luce-strength.ts のJSDoc参照)。
 * k<=3の実運用値ではk!<=6通りの和で済み軽量。一般のkでは階乗的に増える
 * (現行 CONDITIONAL_BERNOULLI_MODEL の C(n,k) 列挙と同様、大きいkでの重さは本質的な制約であり
 * 本モデル固有の欠陥ではない)。
 *
 * ## フィット不能な入力への対応(第2回着手前ゲートの最重要裁定)
 * `fitPlackettLuceStrengths` が `ok:false` を返す入力に対しては、均等分布へ黙ってフォールバック
 * せず `PlackettLuceFitError` を例外として投げる。#20-A 時点では production 呼び出し元がゼロなので
 * 波及もゼロ(#20-Bでこの例外を捕捉し見送り経路に振り分ける設計になる想定)。
 *
 * ## 除外(θ=0)・固定(θ=Infinity)馬の扱い
 * `fitPlackettLuceStrengths` が返す θ は、除外された馬(θ=0)・固定された馬(θ=+Infinity)を
 * 含む出走全頭ぶんの配列である。本モデルは全 C(n,k) 通りの組合せを列挙し(現行モデルと同じ
 * outcome数の契約。受け入れ条件6)、各組合せSについて「固定馬が全てSに含まれ、かつ除外馬が
 * 1頭もSに含まれない」場合に限り、自由集合(有限正のθを持つ馬)だけの縮約問題の厳密分布から
 * 確率を引き当てる。それ以外の組合せは確率0(現行モデルと異なりゼロを明示的に持つ。均等分布への
 * フォールバックとは違う)。
 */

import type { JointModelHorse, PlaceJointModel, PlaceOutcome } from "./place-joint-model.js";
import { fitPlackettLuceStrengths, PlackettLuceFitError } from "./plackett-luce-strength.js";

/** items(添字配列)からk個を選ぶ組合せを列挙する(小さいkのみを想定)。 */
function combinationsOf(items: readonly number[], k: number): number[][] {
  const results: number[][] = [];
  const current: number[] = [];
  const backtrack = (start: number): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      backtrack(i + 1);
      current.pop();
    }
  };
  backtrack(0);
  return results;
}

/** 配列の順列を全列挙する(小さい配列のみを想定。k<=3の高速経路が無い一般のkのみで使う)。 */
function permutationsOf(items: readonly number[]): number[][] {
  if (items.length <= 1) return [items.slice()];
  const results: number[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutationsOf(rest)) {
      results.push([items[i]!, ...p]);
    }
  }
  return results;
}

/**
 * 組合せ combo(サイズk)が「上位k集合」になる確率を、k!通りの並び順の和として計算する。
 * production の placeCount(1/2/3)に対応する k<=3 は、配列を新規生成しない展開実装で計算する
 * (production 実測: 18頭・k=3・816組の分布生成が、汎用の permutationsOf 経由の実装では
 * 数msかかっていたのに対し、この展開実装では1ms未満に収まる。AC-9の5ms予算のため必須の最適化)。
 * k>=4は一般実装(permutationsOf)にフォールバックする(production では到達しない経路)。
 */
function comboProbability(combo: readonly number[], theta: readonly number[], Theta: number): number {
  const k = combo.length;
  if (k === 1) {
    const a = combo[0]!;
    return theta[a]! / Theta;
  }
  if (k === 2) {
    const [a, b] = combo as [number, number];
    const ta = theta[a]!;
    const tb = theta[b]!;
    return (ta / Theta) * (tb / (Theta - ta)) + (tb / Theta) * (ta / (Theta - tb));
  }
  if (k === 3) {
    const [a, b, c] = combo as [number, number, number];
    const ta = theta[a]!;
    const tb = theta[b]!;
    const tc = theta[c]!;
    // 3!=6通りの並び順を展開して合計する(配列を新規生成しない)。
    let total = 0;
    total += (ta / Theta) * (tb / (Theta - ta)) * (tc / (Theta - ta - tb));
    total += (ta / Theta) * (tc / (Theta - ta)) * (tb / (Theta - ta - tc));
    total += (tb / Theta) * (ta / (Theta - tb)) * (tc / (Theta - tb - ta));
    total += (tb / Theta) * (tc / (Theta - tb)) * (ta / (Theta - tb - tc));
    total += (tc / Theta) * (ta / (Theta - tc)) * (tb / (Theta - tc - ta));
    total += (tc / Theta) * (tb / (Theta - tc)) * (ta / (Theta - tc - tb));
    return total;
  }
  // 一般のk(production では到達しない): permutationsOf経由の素直な実装。
  let totalProb = 0;
  for (const perm of permutationsOf(combo)) {
    let denom = Theta;
    let prob = 1;
    for (const idx of perm) {
      prob *= theta[idx]! / denom;
      denom -= theta[idx]!;
    }
    totalProb += prob;
  }
  return totalProb;
}

/**
 * 自由集合(有限正のθのみ)の θ から、C(n',k') 通りの厳密な同時分布を構築する。
 * 戻り値の comboIndices は入力 theta 配列内の添字(呼び出し側で元の馬の添字へ写像する)。
 */
function exactDistributionFromTheta(
  theta: readonly number[],
  k: number,
): Array<{ comboIndices: number[]; probability: number }> {
  const n = theta.length;
  if (n === 0 || k === 0) {
    return [{ comboIndices: [], probability: 1 }];
  }
  const Theta = theta.reduce((a, b) => a + b, 0);
  const indices = theta.map((_, i) => i);
  const combos = combinationsOf(indices, k);
  return combos.map((combo) => ({
    comboIndices: combo,
    probability: comboProbability(combo, theta, Theta),
  }));
}

/** placeCount の基本検証(非有限/負/非整数)。 */
function validatePlaceCountOrThrow(placeCount: number): void {
  if (!Number.isFinite(placeCount) || placeCount < 0 || !Number.isInteger(placeCount)) {
    throw new PlackettLuceFitError(
      "invalid-place-count",
      `PLACKETT_LUCE_MODEL.buildDistribution: placeCount(${placeCount})は非有限/負/非整数です`,
    );
  }
}

/**
 * fitPlackettLuceStrengths が返す θ(出走全頭ぶん。除外=0・固定=Infinity・自由=有限正)から、
 * 全 C(n,k) 通りの組合せに確率を割り当てる(現行モデルと同じ outcome 数の契約を保つため、
 * 縮約後の少ない組合せ数ではなく全 C(n,k) を列挙し、無効な組合せには明示的に確率0を置く)。
 */
function buildOutcomesFromFullTheta(
  horses: readonly JointModelHorse[],
  theta: readonly number[],
  k: number,
): PlaceOutcome[] {
  const n = horses.length;
  const zeroSet = new Set<number>();
  const fixedSet = new Set<number>();
  const freeIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (theta[i] === 0) zeroSet.add(i);
    else if (theta[i] === Number.POSITIVE_INFINITY) fixedSet.add(i);
    else freeIndices.push(i);
  }
  const kPrime = k - fixedSet.size;
  const freeTheta = freeIndices.map((idx) => theta[idx]!);
  const freeDistribution = exactDistributionFromTheta(freeTheta, kPrime);

  // 高速経路: 除外・固定馬が1頭もいない(production の典型ケース)なら、全 C(n,k) の列挙は
  // exactDistributionFromTheta の結果そのものと一致する(無効な組合せが存在しないため)。
  // 二重列挙(自由集合ぶん+全体ぶん)を避けることで、AC-9の5ms予算を安定して満たす。
  if (zeroSet.size === 0 && fixedSet.size === 0) {
    return freeDistribution.map((d) => ({
      placed: d.comboIndices.map((idx) => horses[idx]!.umaban).sort((a, b) => a - b),
      probability: d.probability,
    }));
  }

  const probByComboKey = new Map<string, number>();
  for (const d of freeDistribution) {
    const originalCombo = d.comboIndices.map((localPos) => freeIndices[localPos]!);
    const key = [...originalCombo].sort((a, b) => a - b).join(",");
    probByComboKey.set(key, d.probability);
  }

  const allIndices = horses.map((_, i) => i);
  const allCombos = combinationsOf(allIndices, k);
  return allCombos.map((combo) => {
    const comboSet = new Set(combo);
    const containsAllFixed = [...fixedSet].every((idx) => comboSet.has(idx));
    const excludesAllZero = [...zeroSet].every((idx) => !comboSet.has(idx));
    // 【提案A・レビューで記録】この2条件のANDをテストで「常にtrue」に変異させても、
    // 実測では誤った非ゼロ確率は生じない(構造的にfail-safeになっている。対応しない判断)。
    // 理由(断定できる。code-reviewer指摘により「ことが多く」という弱い書き方から訂正):
    // containsAllFixed=trueへの変異が実際に効くのは「comboがfixedSetをf個(f>=1)含まない」
    // 場合だが、そのとき freePart(=combo−fixedSet)のサイズは必ず kPrime+f(>kPrime)になる
    // (|freePart|=|combo|-|combo∩fixedSet|=k-(|fixedSet|-f)=kPrime+f。f>=1なので常にkPrimeを
    // 超える)。probByComboKeyのキーは必ずkPrime個の添字の組であり、freePartのサイズがそれと
    // 異なる以上、Mapのキーとして一致することは構造的にあり得ない(「多くの場合」ではなく
    // 「常に」構造的に到達しない)ため確率は0のまま拾われる。
    // 逆にexcludesAllZero=trueへの変異でzeroSetを含むcomboを通しても、freePartにzeroの
    // 添字がそのまま残り、freeIndices由来のkeyと一致しないため同様に0のまま拾われる。
    // つまり「キー長・キーの中身の不一致」が二重の安全網になっており、この2フラグ自体は
    // 現状のテストでは変異検出力がない(対応しない判断。#77完了報告に記録)。
    let probability = 0;
    if (containsAllFixed && excludesAllZero) {
      const freePart = combo.filter((idx) => !fixedSet.has(idx));
      const key = [...freePart].sort((a, b) => a - b).join(",");
      probability = probByComboKey.get(key) ?? 0;
    }
    return {
      placed: combo.map((idx) => horses[idx]!.umaban).sort((a, b) => a - b),
      probability,
    };
  });
}

/**
 * Plackett-Luce モデル(PlaceJointModel の厳密実装)。
 * `approximate: false` ——「入力の周辺確率(placeProb)を厳密に再現する」という意味に限定する
 * (JSDoc冒頭「近似の意味の再定義」参照)。「1着確率が当たる」ことを意味しない。
 */
export const PLACKETT_LUCE_MODEL: PlaceJointModel = {
  id: "plackett-luce",
  /**
   * 近似の意味の再定義(#20-A): このフラグは「同時分布が入力の周辺確率(placeProb)を
   * 再現しないか」だけを表す。CONDITIONAL_BERNOULLI_MODEL は条件付け後の周辺確率が入力と
   * 厳密には一致しないため true(近似)。本モデルは入力の周辺確率を厳密に再現する
   * (フィットが収束する限り)ため false としている。
   *
   * **重要: false は「1着確率や3着内率の予測が当たる」ことを一切意味しない。**
   * 「同時分布が周辺確率をどれだけ忠実に再現するか」という数学的な性質のフラグであり、
   * 予測の的中率・実測妥当性は本フラグの対象外(#23の着手前ゲートはPLを真のモデルと
   * *仮定*して条件付きベルヌーイの誤差を測ったのであって、PL自体の妥当性を検証したのではない。
   * それが検証されるまで、false を「精度が高い」という意味で読んではならない)。
   */
  approximate: false,
  buildDistribution(horses, placeCount) {
    validatePlaceCountOrThrow(placeCount);
    const n = horses.length;
    const k = placeCount;

    // 縮退(現行モデルと同一契約)。AC-1: フィットに入る前に処理し、
    // fitPlackettLuceStrengths を呼ばない。
    if (n === 0 || k === 0) {
      return [{ placed: [], probability: 1 }];
    }
    if (k >= n) {
      const placed = horses.map((h) => h.umaban).sort((a, b) => a - b);
      return [{ placed, probability: 1 }];
    }

    const fit = fitPlackettLuceStrengths(horses, k);
    if (!fit.ok) {
      throw new PlackettLuceFitError(
        fit.reason,
        `PLACKETT_LUCE_MODEL.buildDistribution: θ推定に失敗しました(reason=${fit.reason}, ` +
          `頭数=${n}, placeCount=${k})`,
      );
    }
    return buildOutcomesFromFullTheta(horses, fit.theta, k);
  },
};
