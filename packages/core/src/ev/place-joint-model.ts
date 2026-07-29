/**
 * place-joint-model — 複勝の同時分布モデル(馬券配分「機能C-1」の中核・Phase 2の差し替え単位)。
 *
 * 背景と設計判断:
 *   馬券配分(bet-allocation.ts)はケリー基準で予算配分を最適化するが、複勝は「同時に複数頭が
 *   当たる」券種であるため、各馬の的中確率を独立に扱うと的中同士の相関(排反ではないが、頭数と
 *   複勝人数で強く制約される)を無視してしまい、過大なケリー配分(複数の的中を過度に見込む)に
 *   つながりうる。そこで「与えられた複勝確率から、複勝圏に入る馬の組合せ(部分集合)の同時分布」
 *   を明示的なモデルとして切り出し、bet-allocation.ts はこのモデルが返す分布だけを使って最適化を
 *   行う(独立性を一切仮定しない設計。§受け入れ条件6)。
 *
 *   本モデル(条件付きベルヌーイ)を「まず近似」として採用した理由:
 *   - 各馬の的中を独立ベルヌーイ試行とみなし、「複勝人数ちょうどk頭が当たる」という制約で
 *     条件付けする(= 頭数Nから重み付きで k 頭を選ぶ多変量超幾何分布に相当)。
 *     計算量は O(C(N,k)) で、N≤18・k≤3程度の実運用値では軽量(最大 C(18,3)=816 組)。
 *   - 正確な同時分布(例: Plackett-Luce モデルで着順分布を明示的に生成し、複勝圏内の組合せ確率を
 *     積分する等)は理論的により厳密だが実装・検証コストが高い。ユーザー要望「なる早で厳密に
 *     やりたい」を踏まえ、C-1では本モデルを PlaceJointModel インターフェースの1実装として
 *     切り出すことで、Phase 2 で本ファイルだけを差し替えれば済む設計にした(bet-allocation.ts は
 *     このモデルの実装詳細に一切依存しない)。
 *
 *   既知の不完全性(Phase 1として明記):
 *   - 条件付け後の周辺確率(各馬がいずれかの組に含まれる確率の合計)は、入力の placeProb と
 *     厳密には一致しない。IPF(反復比例フィッティング)のような周辺確率を入力に一致させる補正を
 *     行っていないため。呼び出し側(bet-allocation.ts)は marginalDeviationMax としてこの乖離の
 *     大きさを可視化する。
 *   - 入力 placeProb の合計が複勝人数(placeCount)と一致する保証はない(LLM補正後の確率はscorer
 *     で正規化されるが、必ずしも合計が揃わない)。本モデルは合計の乖離を許容し、常に「条件付け後
 *     の分布の合計は1」になることだけを保証する(受け入れテスト「合計が乖離するケース」)。
 *
 * 数値安定化(ゼロ除算・発散の回避):
 *   各馬の確率 p_i を [EPS, 1-EPS](EPS=1e-9)にクランプしてから重み w_i = p_i/(1-p_i) を計算する。
 *   p=0 の馬(w→0)・p=1 の馬(w→∞)を特別扱いする分岐は作らず、クランプ一本で吸収する
 *   (仕様「特別分岐を作らない」)。NaN 等の病的な入力はクランプをすり抜けて重み計算に伝播し、
 *   最終的に分母(全組の重み積の合計)が非有限になることで検出され、例外を投げず均等分布へ
 *   フォールバックする(下記 buildConditionalBernoulliDistribution 参照)。
 *
 * ネットワーク・LLM・SQLite には一切依存しない(与えられた数値から決定的に算出するだけ)。
 */

/** 同時分布モデルに渡す1頭分の情報(構造的最小型)。 */
export interface JointModelHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 複勝圏内確率(0〜1を想定。範囲外・非有限な値はモデル側で安全に処理する)。 */
  readonly placeProb: number;
}

/** 複勝圏内の組合せ(部分集合)とその同時確率。 */
export interface PlaceOutcome {
  /** 複勝圏内に入った馬番(昇順・決定的)。 */
  readonly placed: readonly number[];
  /** この組合せが実現する確率。全 PlaceOutcome の合計は常に1。 */
  readonly probability: number;
}

/**
 * 複勝の同時分布モデル。Phase 2 で厳密なモデル(Plackett-Luce 等)に差し替える際は、
 * この interface を満たす別実装を追加し、bet-allocation.ts の呼び出し側で model 引数を
 * 差し替えるだけで済むようにする。
 */
export interface PlaceJointModel {
  /** モデル識別子(結果に載せ、どのモデルで計算したかを追跡できるようにする)。 */
  readonly id: string;
  /**
   * 近似モデルか(true)厳密モデルか(false)。UIが「近似計算」表記を機械的に出し分けるための
   * フラグ(受け入れ条件10: modelApproximate が結果に載る)。
   */
  readonly approximate: boolean;
  /**
   * 出走全頭の複勝確率から、複勝圏内の組合せの同時分布を構築する。
   * @param horses 出走全頭(候補馬に限らない。同時分布は全頭の確率に依存するため)
   * @param placeCount 複勝の対象人数(何着まで複勝圏内か)
   */
  buildDistribution(
    horses: readonly JointModelHorse[],
    placeCount: number,
  ): readonly PlaceOutcome[];
}

/** クランプに使う微小値。p=0/p=1 の境界でゼロ除算・発散を起こさないための下駄。 */
const EPS = 1e-9;

/**
 * 条件付きベルヌーイモデル(Phase 1 既定実装)。
 * 各馬の的中を独立ベルヌーイとみなし、「複勝人数ちょうど k 頭が当たる」で条件付けた分布。
 * P(S) = Π_{i∈S} w_i / Σ_{|S'|=k} Π_{i∈S'} w_i 、w_i = p_i/(1-p_i)。
 */
export const CONDITIONAL_BERNOULLI_MODEL: PlaceJointModel = {
  id: "conditional-bernoulli",
  approximate: true,
  buildDistribution(horses, placeCount) {
    return buildConditionalBernoulliDistribution(horses, placeCount);
  },
};

function buildConditionalBernoulliDistribution(
  horses: readonly JointModelHorse[],
  placeCount: number,
): readonly PlaceOutcome[] {
  const n = horses.length;
  const k = Math.max(0, Math.floor(placeCount));

  // 頭数0 または 複勝人数0: 空集合が確率1の唯一の結果(合計1の不変条件を維持)。
  if (n === 0 || k === 0) {
    return [{ placed: [], probability: 1 }];
  }

  // 複勝人数が頭数以上: 全頭が複勝圏内になる組が1通り(確率1)。
  if (k >= n) {
    const placed = horses.map((h) => h.umaban).sort((a, b) => a - b);
    return [{ placed, probability: 1 }];
  }

  // 出力を馬番昇順で決定的にするため、内部のインデックス列も馬番昇順で並べる。
  const sortedIndices = horses
    .map((_, i) => i)
    .sort((a, b) => horses[a]!.umaban - horses[b]!.umaban);

  // 重み w_i = p_i/(1-p_i)。p は [EPS, 1-EPS] にクランプ(p=0/p=1 の特別分岐は作らない)。
  const weights = horses.map((h) => {
    const p = clamp(h.placeProb, EPS, 1 - EPS);
    return p / (1 - p);
  });

  const combos = kCombinations(sortedIndices, k);
  const rawProducts = combos.map((combo) =>
    combo.reduce((acc, idx) => acc * weights[idx]!, 1),
  );
  const denom = rawProducts.reduce((a, b) => a + b, 0);

  // 分母が0または非有限(NaN等の病的入力の伝播・オーバーフロー)なら、例外を投げず
  // 均等分布へフォールバックする。
  if (denom === 0 || !Number.isFinite(denom)) {
    const uniform = 1 / combos.length;
    return combos.map((combo) => ({
      placed: toSortedUmaban(horses, combo),
      probability: uniform,
    }));
  }

  return combos.map((combo, i) => ({
    placed: toSortedUmaban(horses, combo),
    probability: rawProducts[i]! / denom,
  }));
}

/** インデックスの組を馬番昇順の配列に変換する。 */
function toSortedUmaban(
  horses: readonly JointModelHorse[],
  combo: readonly number[],
): number[] {
  return combo.map((idx) => horses[idx]!.umaban).sort((a, b) => a - b);
}

/** items(昇順)から要素数kの組合せを列挙する(順序は決定的)。 */
function kCombinations(items: readonly number[], k: number): number[][] {
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

/** 値を [min, max] にクランプする。NaN はいずれの比較も false になるためクランプされず素通りする
 *  (意図的な挙動。病的入力を検出可能な非有限値として下流に伝播させるため)。 */
function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
