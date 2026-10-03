/**
 * plackett-luce-model — PLACKETT_LUCE_MODEL(PlaceJointModel の Plackett-Luce 実装。Issue #77・#20-A)。
 *
 * `fitPlackettLuceStrengths` で推定した θ から、複勝圏内の組合せ(部分集合)の同時分布を厳密に
 * 構築する。`PlaceJointModel` インタフェース自体は変更しない(既存の呼び出し元は無改変)。
 *
 * ## 既定モデルの切替(#78-B・#81)
 * `bet-allocation.ts`・`combo-bet-allocation.ts` の既定モデルは**現在は本モデル
 * (`PLACKETT_LUCE_MODEL`)である**(#81(#78-B)で `CONDITIONAL_BERNOULLI_MODEL` から切替済み)。
 * 履歴として: #20-A(#77)でこのファイルを新設した時点では、両ファイルの既定モデルはまだ
 * `CONDITIONAL_BERNOULLI_MODEL` のままで、本モデルの production 呼び出し元はゼロ件だった
 * (`grep`で実測。#77完了報告参照)。
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
 * せず `PlackettLuceFitError` を例外として投げる。#20-A(#77)時点では production 呼び出し元が
 * ゼロだったため波及もゼロだったが、#81(#78-B)で既定モデルが本モデルへ切り替わった現在は
 * production からも到達しうる。この例外は `mixed-race-allocation.ts`・
 * `mixed-allocation-view.ts` 側の外側 try/catch(#80・#78-A で新設。型を問わず汎用的に捕捉する)
 * が拾い、`route:"invalid"`/`kind:"invalid"` の見送り経路へ振り分ける(本例外専用の catch は
 * 設けていない)。
 *
 * ## 除外(θ=0)・固定(θ=Infinity)馬の扱い
 * `fitPlackettLuceStrengths` が返す θ は、除外された馬(θ=0)・固定された馬(θ=+Infinity)を
 * 含む出走全頭ぶんの配列である。本モデルは全 C(n,k) 通りの組合せを列挙し(現行モデルと同じ
 * outcome数の契約。受け入れ条件6)、各組合せSについて「固定馬が全てSに含まれ、かつ除外馬が
 * 1頭もSに含まれない」場合に限り、自由集合(有限正のθを持つ馬)だけの縮約問題の厳密分布から
 * 確率を引き当てる。それ以外の組合せは確率0(現行モデルと異なりゼロを明示的に持つ。均等分布への
 * フォールバックとは違う)。
 */

import type {
  JointModelHorse,
  OrderedOutcome,
  OrderedPlaceJointModel,
  PlaceOutcome,
} from "./place-joint-model.js";
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
 * items(添字配列)から重複なくk個を順序付きで選ぶ(P(n,k)=n·(n-1)·…·(n-k+1)通り。小さいkのみ想定)。
 * `combinationsOf`(順序を持たない組合せ)との違いは、選ぶ順序も区別する点のみ。
 */
function kPermutationsOf(items: readonly number[], k: number): number[][] {
  const results: number[][] = [];
  const used = new Array<boolean>(items.length).fill(false);
  const current: number[] = [];
  const backtrack = (): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(items[i]!);
      backtrack();
      current.pop();
      used[i] = false;
    }
  };
  backtrack();
  return results;
}

/**
 * 自由集合(全要素が有限正のθ)だけから、上位k'着の順序付き分布を厳密に列挙する
 * (P(n',k')通り)。各着順(σ(1),…,σ(k'))の確率は
 *   ∏_{t=1}^{k'} θ_{σ(t)} / (Θ_free − Σ_{u<t} θ_{σ(u)})
 * (`comboProbability`が集合確率を得るために内部で計算し合計している、まさにこの個別の値)。
 * `Θ_free` は自由集合だけの合計(呼び出し側で既に除外・固定馬を取り除いた添字だけを渡すため、
 * 除外馬θ=0は寄与せず、固定馬は呼び出し側が別途「1着固定」として扱うのでここには現れない)。
 */
function enumerateFreeSetOrderedDistribution(
  freeIndices: readonly number[],
  theta: readonly number[],
  kPrime: number,
): Array<{ orderIndices: number[]; probability: number }> {
  if (kPrime === 0) {
    return [{ orderIndices: [], probability: 1 }];
  }
  const thetaTotal = freeIndices.reduce((a, idx) => a + theta[idx]!, 0);
  const perms = kPermutationsOf(freeIndices, kPrime);
  return perms.map((order) => {
    let denom = thetaTotal;
    let probability = 1;
    for (const idx of order) {
      probability *= theta[idx]! / denom;
      denom -= theta[idx]!;
    }
    return { orderIndices: order, probability };
  });
}

/**
 * fitPlackettLuceStrengths が返す θ(出走全頭ぶん)から、順序付き outcome 空間(上位k着の
 * 着順分布)を構築する。`buildOutcomesFromFullTheta`(集合空間)と対になる関数だが、
 * **除外(θ=0)・固定(θ=Infinity)馬の扱いは集合空間と異なる**:
 *
 * - 除外馬(θ=0): 集合空間と同じく一切現れない(確率0の組合せにすら数えない。単に対象外)。
 * - 固定馬(θ=Infinity)が2頭以上: 呼び出し側(buildOrderedDistribution)がこの関数を呼ぶ前に
 *   判定不能(null)として弾く(この関数は「固定馬0頭または1頭」の前提でのみ呼ばれる)。
 * - 固定馬がちょうど1頭: **その馬は確率1で1着**(指数レース表現でθ→+Infinityの馬の到達時刻は
 *   T→0に退化し、他のどの有限θの馬よりも必ず先着するため。他の固定馬が存在しない=競合する
 *   「同じく確実な1着候補」がいないので、順序としては一意に定まる)。2着以下(k-1着ぶん)は
 *   自由集合だけのPL順序展開(k'=k-1)で決まる。この k'=k-1 は
 *   `fitPlackettLuceStrengths` が返す `reducedPlaceCount` と一致する値であり、
 *   固定馬を除いた「残り枠を自由集合で争う」という水詰め射影の意味そのものである。
 */
function buildOrderedOutcomesFromFullTheta(
  horses: readonly JointModelHorse[],
  theta: readonly number[],
  k: number,
): readonly OrderedOutcome[] | null {
  const n = theta.length;
  const fixedIndices: number[] = [];
  const freeIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (theta[i] === Number.POSITIVE_INFINITY) {
      fixedIndices.push(i);
    } else if (theta[i] !== 0) {
      freeIndices.push(i);
    }
    // theta[i]===0(除外馬)はどちらにも加えない(順序空間に一切現れない)。
  }

  if (fixedIndices.length >= 2) {
    // 複数の固定馬のうち誰が1着かは、水詰め射影+反復フィットの縮約過程で失われており
    // 構造的に不定(θ=Infinity同士に相対的な強さの情報が残っていない)。判定不能。
    return null;
  }

  if (fixedIndices.length === 1) {
    const fixedIdx = fixedIndices[0]!;
    const rest = enumerateFreeSetOrderedDistribution(freeIndices, theta, k - 1);
    return rest.map((d) => ({
      order: [fixedIdx, ...d.orderIndices].map((idx) => horses[idx]!.umaban),
      probability: d.probability,
    }));
  }

  const dist = enumerateFreeSetOrderedDistribution(freeIndices, theta, k);
  return dist.map((d) => ({
    order: d.orderIndices.map((idx) => horses[idx]!.umaban),
    probability: d.probability,
  }));
}

/**
 * Plackett-Luce モデル(PlaceJointModel の厳密実装)。
 * `approximate: false` ——「**Σp=kちょうどのとき**、入力の周辺確率(placeProb)を厳密に再現する」
 * という意味に限定する(JSDoc冒頭「近似の意味の再定義」参照。#81でΣp≠kの実際の挙動を追記)。
 * 「1着確率が当たる」ことを意味しない。
 *
 * **`OrderedPlaceJointModel`(Issue #92)。** `CONDITIONAL_BERNOULLI_MODEL`は定式化上、
 * 順序展開を持てないため`PlaceJointModel`のまま。型注釈を`OrderedPlaceJointModel`に
 * すること自体が「本モデルは順序展開を実装している」というコンパイラ検査になる
 * (`buildOrderedDistribution`を書き忘れるとこの型注釈でコンパイルエラーになる)。
 */
export const PLACKETT_LUCE_MODEL: OrderedPlaceJointModel = {
  id: "plackett-luce",
  /**
   * 近似の意味の再定義(#20-A): このフラグは「同時分布が入力の周辺確率(placeProb)を
   * 再現しないか」だけを表す。CONDITIONAL_BERNOULLI_MODEL は条件付け後の周辺確率が入力と
   * 厳密には一致しないため true(近似)。本モデルは **Σp=kちょうどの入力に対しては**
   * 周辺確率を厳密に再現する(フィットが収束する限り)ため false としている。
   *
   * **Σp≠kの入力(production の大半)に対する追記(#81): 再現されるのは入力の placeProb
   * そのものではなく、水詰め射影(water-filling)による再スケール後の目標 q である。**
   * `fitPlackettLuceStrengths`(`plackett-luce-strength.ts`)は Σp≠k の入力を
   * `q_i=min(1,λ・p_i)`(Σq=k)へ射影してから解く。`scripts/bench-joint-model.ts` の実測
   * (`pnpm tsx scripts/bench-joint-model.ts` で再現可能。clipVariant=default・N=200)では
   * p=0を含むレースが197/200(98.5%)に達し、再スケールがほぼ常時働く。つまり
   * production では「false」が指す“厳密な再現”の対象はほとんどの場合 placeProb 自体では
   * なく再スケール後の q であり、この q は placeProb と一致しない。
   *
   * **さらに、この false は CONDITIONAL_BERNOULLI_MODEL(true)より周辺確率の再現精度が
   * 高いことを意味しない。** 同じ実測(clipVariant=default・N=200)で `marginalDeviationMax`
   * (実際に構築した同時分布の周辺確率と入力placeProbとの最大絶対差)の中央値は
   * PL=0.061835・CB=0.046275 であり、**PLの方が悪化する**。PLがCBより悪化するレースの割合は
   * 117/199(58.8%。clipVariant=wide15・N=200では143/200=71.5%)に達する
   * (分母がclipVariantで199と200で異なるのは母数の取り方の違いではなく、`runModelLayer`が
   * `plWorseCount/successCount`〈フィット成功件数を分母にする〉を出力しているため:
   * clipVariant=defaultはN=200中`not-converged`が1件発生し成功件数が199件になるのに対し、
   * wide15は`not-converged`が0件でN=200のまま成功件数と一致する。
   * `pnpm tsx scripts/bench-joint-model.ts` 実行結果の
   * 「成功: 199/200」「not-converged: 1/200」〈default〉/「成功: 200/200」〈wide15〉で
   * 再現できる)。
   *
   * **重要: false は「1着確率や3着内率の予測が当たる」ことを一切意味しない。**
   * 「同時分布が周辺確率をどれだけ忠実に再現するか」という数学的な性質のフラグであり、
   * 予測の的中率・実測妥当性は本フラグの対象外(#23の着手前ゲートはPLを真のモデルと
   * *仮定*して条件付きベルヌーイの誤差を測ったのであって、PL自体の妥当性を検証したのではない。
   * それが検証されるまで、false を「精度が高い」という意味で読んではならない。#81でΣp≠kの
   * 実測により、精度が高いどころか中央値では悪化することが分かった)。
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
  /**
   * 順序付き outcome 空間(上位k着の着順分布)を構築する(Issue #92)。
   *
   * `buildDistribution`と**同じ`fitPlackettLuceStrengths`呼び出し規約**
   * (同じhorses・同じk→常に同じθ。関数が純粋・決定的なため、呼び出し回数によらず
   * 数学的に同一のθが得られる)を用いる。これにより、`buildDistribution`が返す集合空間と
   * 本メソッドが返す順序空間は常に同じθから導出され、集合周辺化の一致(AC-B1b-1(b))が成立する。
   *
   * 1着(以降)が構造的に一意に定まらない入力ではnullを返す(判定不能。throwしない)。
   * 対象: (1) 頭数2以上でtopFinishCount>=頭数(placeProbが全員「上位k内確率=1」に潰れ、
   * 順序を決める情報を一切運ばない。fitPlackettLuceStrengths自体を呼ばない縮退分岐なので
   * θが存在しない)。(2) 固定馬(θ=Infinity)が2頭以上(buildOrderedOutcomesFromFullTheta参照)。
   */
  buildOrderedDistribution(horses, topFinishCount) {
    validatePlaceCountOrThrow(topFinishCount);
    const n = horses.length;
    const k = topFinishCount;

    if (n === 0 || k === 0) {
      return [{ order: [], probability: 1 }];
    }
    if (k >= n) {
      if (n === 1) {
        // 1頭しかいないため、strengthの比較を要さず自明に1着(判定不能ではない)。
        return [{ order: [horses[0]!.umaban], probability: 1 }];
      }
      // n>=2: 全頭が上位k内であることは確実だが、placeProbは「上位k内確率」であり
      // n>=2かつk>=nでは全員1に潰れるため、1着以下の相対順序を一意に定める情報が無い
      // (buildDistributionのこの分岐もfitPlackettLuceStrengthsを呼ばず、θを推定しない)。
      return null;
    }

    const fit = fitPlackettLuceStrengths(horses, k);
    if (!fit.ok) {
      throw new PlackettLuceFitError(
        fit.reason,
        `PLACKETT_LUCE_MODEL.buildOrderedDistribution: θ推定に失敗しました(reason=${fit.reason}, ` +
          `頭数=${n}, topFinishCount=${k})`,
      );
    }
    return buildOrderedOutcomesFromFullTheta(horses, fit.theta, k);
  },
};
