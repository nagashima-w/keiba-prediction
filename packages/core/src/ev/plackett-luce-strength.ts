/**
 * plackett-luce-strength — Plackett-Luce の潜在強度 θ 推定器(Issue #77・#20-A)。
 *
 * ## 背景(なぜ θ が核か)
 * Plackett-Luce(以下 PL)は各馬の潜在強度 θ_i(正の実数)によって完全にパラメトライズされ、
 * 上位k集合分布・着順分布・1着確率はすべて同一の θ から導出できる。#23 の着手前ゲートが
 * 要求した「1着確率と3着内率を同一の θ から導出する」はこの形でしか満たせない。本モジュールは
 * 「複勝圏内確率(placeProb)の目標値から θ を逆算する」推定器を提供する。
 *
 * ## 数理モデル(指数レース表現。Yellott 1977 の Gumbel-max 表現と等価)
 * 各馬 i は独立な指数分布 T_i ~ Exp(θ_i) の「到達時刻」を持ち、T_i が小さい順に着順が決まる
 * (θ_i が大きいほど早く=上位に来やすい)。この表現から、馬 i が上位k集合に入る周辺確率は
 * 閉形式で計算できる(computePlackettLuceMarginals 参照)。
 *
 * ## 前処理: [0,1] 箱での厳密な水詰め(water-filling)射影
 * 入力の目標確率 p(placeProb)は、PL の構造上 Σ_i F_i(θ) = k が恒等的に成立するため、
 * Σp ≠ k の入力に対してそのまま θ を解くことはできない(存在しない解を探すことになる)。
 * そこで p を「Σ=k に最も近い、各成分が[0,1]に収まる」目標 q へ射影する:
 *
 *   q_i = min(1, λ·p_i)  を満たす λ ≥ 0 を、Σ_i q_i = k となるように選ぶ。
 *
 * S(λ) = Σ_i min(1, λ·p_i) は λ について連続・単調非減少・区分線形・凹関数なので、λ は
 * ソート + 累積和による O(n log n) の閉形式(水詰めアルゴリズム)で一意に(縮退時は代表値として)
 * 求まる。数値的な収束判定・反復打ち切りは一切不要(決定的)。
 *
 * この結果、各馬は3種類に分類される:
 *   - q_i = 0 (p_i = 0 の馬。λにかかわらず常に0): 上位k集合から厳密に除外(θ=0)
 *   - q_i = 1 (p_i = 1、または λ·p_i ≥ 1 に達した馬): 上位k枠に厳密に固定(θ=+Infinity)
 *   - 0 < q_i < 1: 残りの k' = k − (固定頭数) 枠を争う「自由集合」。この q を目標として
 *     反復フィットで θ を求める(reducedHorseCount = 自由集合の頭数 n'、reducedPlaceCount = k')。
 *
 * **p=0 / p=1 は production 到達可能な通常入力であり、異常値として ok:false にはしない**
 * (scorer/prior.ts の [minPrior, maxPrior] クランプと、analyzer/parse-response.ts の
 * ±maxAdjust クリップ〈clip-variants.ts の CLIP_VARIANTS。既定±0.10・wide15±0.15〉の組み合わせで
 * 到達する)。第2回の着手前ゲートで検討した EPS=1e-9 によるクランプ方式は撤回した——本番相当入力の
 * 96.5%が p=0/p=1 を含み、EPS クランプ経由で反復すると極端な重み(p/(1-p)→1e9)が生じて
 * 非収束・低速化を招く実測が得られたため(却下した案の節を参照)。上記の厳密な除外/固定に
 * 置き換えたことで EPS は本モジュールのフィット経路に一切登場しない
 * (現行 CONDITIONAL_BERNOULLI_MODEL の EPS=1e-9 は無改変で維持。あちらは反復を持たない閉形式の
 * 単発計算なので EPS クランプでも安価に済む。PL は反復を伴うため同じ方式が逆効果になる)。
 *
 * ## 自由集合(n'≥2, 1≤k'<n')の反復フィット
 * 乗法的固定点更新 θ_i ← θ_i · (q_i / F_i(θ)) を、残差 max_i|F_i(θ)−q_i| が FIT_TOLERANCE
 * 未満になるまで(上限 MAX_FIT_ITERATIONS 回まで)繰り返す。ただし k'=1 のときは
 * F_i(θ)=θ_i/Σθ かつ Σq_i=k'=1(水詰めの保存則)であるため、θ_i=q_i と置けば厳密に
 * F_i(θ)=q_i/1=q_i が成立し、反復は不要(iterations=0・residualMax=0 の閉形式解)。
 *
 * ## 却下した案(数値付き。CLAUDE.md「却下した案を記録する」)
 * - **オッズ比更新** θ←θ·[q/(1-q)]/[F/(1-F)]: 発散する。EPS を使わず q=0/1 が厳密境界のため
 *   (1-q)=0 でゼロ除算しNaN化する経路が生じ、EPSを足すと逆に残差が0.99付近で高止まりした
 *   (自分の実装で実測。q=1近傍で(1-F)がすぐ0に近づき更新比が暴走するため)。
 * - **冪過緩和** θ←θ·(q/F)^2 等: 飽和ケース(q が1に極めて近い残余ケース)の収束は速まるが、
 *   一般のランダム内点ケースで大きく発振し非収束が悪化した(自分の実装で400件中、通常更新の
 *   非収束27件→冪2乗更新で173件に悪化。実測)。
 * - **Gauss-Seidel(座標ごとに厳密解を都度代入)**: 飽和ケースで200掃引・1000ms超を要しても
 *   残差が高止まりした(自分の実装で実測。本番許容時間〈AC-9〉を大きく超過)。
 * - **SQUAREM(log θ 空間の加速)**: EPSなしの厳密境界(q=0/1)付近で対数が発散し非収束。
 *
 * ネットワーク・LLM・SQLite には一切依存しない(与えられた数値から決定的に算出するだけ)。
 */

import type { JointModelHorse } from "./place-joint-model.js";

/** θ推定に失敗した理由(判別共用体)。文字列直書きの多用を避けるため列挙値として公開する。 */
export type PlackettLuceFitFailureReason =
  /** いずれかの placeProb が非有限 / 0未満 / 1超。フィット前(入力検証)の判定。 */
  | "invalid-probability"
  /** placeCount が非有限 / 負 / 非整数。フィット前(入力検証)の判定。 */
  | "invalid-place-count"
  /** p>0 の馬が k 頭未満で、Σ=k を満たす目標 q が存在しない。前処理(水詰め射影)時点の判定。
   *  数少ない「実現不能」と断定してよいケース(反復にすら入っていない)。 */
  | "infeasible-support"
  /** 反復上限 MAX_FIT_ITERATIONS に達しても残差が FIT_TOLERANCE 未満に収束しなかった。
   *  「実現不能」とは断定しない(この上限では収束しなかった、という申告に留める)。 */
  | "not-converged"
  /** 反復中に自由集合の θ の合計が非有限または0になった。フィット中の判定。 */
  | "numerically-unstable";

/** フィット成功時の結果。「入力をそのまま使ったわけではないこと」をすべて値で申告する。 */
export interface PlackettLuceFitSuccess {
  readonly ok: true;
  /**
   * 出走全頭の潜在強度θ(horses と同じ順序・同じ長さ)。
   * - 0: 上位k集合から厳密に除外された馬(degenerateZeroCount に計上)
   * - +Infinity: 上位k枠に厳密に固定された馬(degenerateFixedCount に計上)
   * - 有限の正の値: 自由集合(reducedHorseCount 頭)の推定強度。スケール規約は
   *   「自由集合のΣθ = reducedHorseCount」(平均1)に正規化する(F(θ)はスケール不変なので
   *   この正規化はF自体には影響しない。決定性〈同じ入力→ビット一致〉のためだけの規約)。
   */
  readonly theta: readonly number[];
  /** 自由集合に対する反復フィットの反復回数。k'=1は閉形式解のため厳密に0。 */
  readonly iterations: number;
  /** 自由集合に対する反復フィットの最終残差 max_i|F_i(θ)-q_i|。k'=0のときは0。 */
  readonly residualMax: number;
  /** 前処理の水詰め射影でλ≠1だったか(Σp≠kで再スケールが働いたか)。 */
  readonly rescaleApplied: boolean;
  /** 水詰め射影のλの値(q_i=min(1,λ·p_i))。rescaleApplied=falseならほぼ1。 */
  readonly rescaleFactor: number;
  /** p_i=0(入力そのまま)としてθ=0で厳密に除外した頭数。 */
  readonly degenerateZeroCount: number;
  /** q_i=1(入力のp=1由来・再スケール由来の両方を含む)としてθ=Infinityで厳密に固定した頭数。 */
  readonly degenerateFixedCount: number;
  /** degenerateFixedCountのうち、入力のp_iが1未満だったのに再スケールでq=1に達した頭数
   *  (「LLMが1と言った」ケースと区別する。入力に境界値が無くても発生しうる)。 */
  readonly rescaleInducedFixedCount: number;
  /** 実際に反復で解いた自由集合の頭数 n'。 */
  readonly reducedHorseCount: number;
  /** 実際に反復で解いた自由集合の複勝人数 k'(= placeCount − degenerateFixedCount)。 */
  readonly reducedPlaceCount: number;
}

/** フィット失敗時の結果。 */
export interface PlackettLuceFitFailure {
  readonly ok: false;
  readonly reason: PlackettLuceFitFailureReason;
}

export type PlackettLuceFitResult = PlackettLuceFitSuccess | PlackettLuceFitFailure;

/**
 * 自由集合の反復フィットの上限回数。
 *
 * **AC-9(18頭・k=3のフィット+分布生成が5ms未満)は、本番相当分布に対しては未達である
 * (要修正Bで明記。「別物として明記する」という読み替えは差し戻された)。** AC-9 の5ms が
 * 実際に成立するのは `scripts/bench-joint-model.ts` の `runSingleShotPerformanceCheck`
 * (Σp=kちょうどの単発計測。実測1.3〜1.4ms)だけであり、production 到達可能域
 * (scorer/prior.ts の [minPrior=0.02, maxPrior=0.95] と clip-variants.ts の
 * CLIP_VARIANTS〈±0.10・±0.15〉、かつ LLM 応答が窓の外に答えてクリップされる現実的な分布)
 * では `scripts/bench-joint-model.ts` の実測で 95%点10.6ms・最悪36.7ms(default)/
 * 78.1ms(wide15)であり、5ms を大きく超える。
 *
 * ## `MAX_FIT_ITERATIONS`の値ごとのトレードオフ(Issue #80・#78-A・実測是正)
 *
 * 下表は `scripts/bench-joint-model.ts` の `runFitPerformanceSweep`(k=3固定・頭数を
 * 18/16/14/12/10/8/6/5と振り、各頭数400件=variantあたりN=3200)を、本定数の値だけを
 * 手で書き換えて8回実行した実測(2026-09-10、実装担当が自分の手元で再実測)。
 *
 * **旧版(#20-A申し送り。#78着手前ゲート第3回ではなく、前boss側が別実装で測った値)の
 * 「上限200では最悪3.56ms・非収束14.5%」は、HEADの実装では再現しない。** 実際に
 * `runModelLayer`(頭数18固定・N=200)を上限200で走らせた実測は
 * **not-converged 1.0%(default)/1.5%(wide15)** であり、14.5%とは1桁違う
 * (#78着手前ゲートで既に「HEADでは再現しない」と明記済みだった)。
 *
 * 本表の200行(non-converged 3.09%/3.00%)も、上記`runModelLayer`実測(1.0%/1.5%)とは
 * 一致しない。**これは「頭数18固定・N=200」対「頭数8段階・N=3200」という母集団の違いに
 * 加え、乱数の種と生成順が異なる別標本であることに由来する標本誤差であり(N=3200・
 * p≈0.03における標本比率の標準偏差はおよそ`sqrt(0.03×0.97/3200)≈0.30pp`)、
 * どちらか一方が「正しい」「間違っている」という話ではない。** 本表の数値を、
 * 生成方法の異なる他の計測(`runModelLayer`等)と直接比較しない。
 *
 * **本表の`not-converged`は無作為入力からの標本比率であり(variantあたりN=3200)、
 * 種を変えると±0.3〜0.7pp程度動く(実測: 種のみ変更でdefault 3.09%→2.72%・
 * wide15 2.63%→3.31%)。行間の大小(上限を下げると率が上がる)は頑健だが、
 * 隣接行の差やvariant間の差(例: 「200ではwide15の方がdefaultより良い」)に
 * 意味を読まないこと。**
 *
 * | `MAX_FIT_ITERATIONS` | not-converged (default / wide15) | fit 99%点 ms | fit 最悪 ms |
 * |---|---|---|---|
 * | 50 | 14.59% / 12.97% | 2.54 / 2.12 | 6.0 / 3.2 |
 * | 100 | 6.78% / 6.34% | 4.50 / 3.43 | 15.7 / 6.0 |
 * | 200 | 3.09% / 3.00% | 6.51 / 5.63 | 13.8 / 9.3 |
 * | 500 | 1.13% / 1.25% | 12.05 / 9.49 | 25.5 / 22.2 |
 * | 1000 | 0.69% / 0.69% | 13.79 / 11.57 | 45.6 / 41.9 |
 * | **2000(現行)** | **0.25% / 0.28%** | 17.81 / 12.24 | 83.0 / 68.6 |
 * | 5000 | 0.06% / 0.06% | 16.49 / 11.38 | 190.0 / 172.6 |
 * | 20000 | 0.03% / 0.00% | 17.12 / 10.94 | 540.5 / 711.7 |
 *
 * `MAX_FIT_ITERATIONS=2000` はこの上限を**5msの予算より`not-converged`率を優先して**
 * 選んだ値であり(反復回数実測分布に基づく)、上限を下げるほど`not-converged`率が上がり、
 * 上げるほど最悪msが単調に悪化するトレードオフである(上表参照)。
 * この未達は **#20-A では `PLACKETT_LUCE_MODEL` の production 呼び出し元がゼロのため
 * 実害が無く**、既定モデルの切替(#81)を検討する際、反復上限(ひいてはこのトレードオフ)を
 * 見直すかどうかの前提として引き継ぐ。
 *
 * **再現手順(本定数に上限を注入する省略可能な引数は追加しない。#80 Q6裁定
 * ——定数の定義箇所を2箇所に増やさないため)**: 本定数の値をここで一時的に書き換え、
 * `pnpm tsx scripts/bench-joint-model.ts` を実行して出力の
 * `Issue #80(#78-A)AC-A8`セクションを読み、書き換えを元に戻す。これを8つの値
 * (50/100/200/500/1000/2000/5000/20000)それぞれについて繰り返すと上表が再現できる。
 */
export const MAX_FIT_ITERATIONS = 2000;

/**
 * 自由集合の反復フィットの収束許容誤差(残差 max_i|F_i(θ)-q_i| がこれ未満で収束とみなす)。
 *
 * **要修正3で是正(誤った根拠の訂正)**: 当初「θ比1e9で閉形式の残差下限が2.2e-7になる」ことを
 * 根拠にしていたが、これは k=5(production では reducedPlaceCount<=placeCount<=3 のため
 * 到達不能)の場合の値であり、**k<=3(production が実際に使う唯一の範囲)では θ比1e9・1e12でも
 * 誤差は 1e-14 オーダーに留まる**(computePlackettLuceMarginals のブルートフォース照合テストで
 * 自分で測り直して確認。`k=1,2,3・ratio=1e3〜1e12` の全組み合わせで最大誤差 2.6e-15)。
 * つまり **k<=3 の範囲では閉形式の桁落ちは FIT_TOLERANCE を制約しない**。
 *
 * 実際に FIT_TOLERANCE を左右するのは、反復更新(θ←θ・q/F)の収束速度そのものである。
 * production 到達可能域(scorer/prior.ts の [minPrior=0.02, maxPrior=0.95] と
 * clip-variants.ts の CLIP_VARIANTS〈±0.10 / ±0.15〉)で自分の実装を測ったところ、
 * 目標が1に極めて近い残余ケース(例: 縮約後の1頭が q=0.995 近傍)ほど反復回数が急増し
 * (0.99で421回・0.995で841回。tol=1e-6 実測)、1e-9 のような過度に厳しい値にすると
 * AC-9 の性能予算(5ms未満)を大きく超える。1e-6 は「収束速度の実用的な上限」として選んだ値
 * であり、閉形式の精度限界とは無関係(scripts/bench-joint-model.ts で再現可能)。
 */
export const FIT_TOLERANCE = 1e-6;

/**
 * PLACKETT_LUCE_MODEL.buildDistribution がフィット不能な入力に対して投げる例外。
 * `reason` を構造化フィールドとして持つ(instanceof だけでなく `name` リテラルでも判別できる
 * ようにする。バンドル・realm を跨ぐと instanceof が壊れる場合があるため)。
 */
export class PlackettLuceFitError extends Error {
  readonly reason: PlackettLuceFitFailureReason;
  constructor(reason: PlackettLuceFitFailureReason, message: string) {
    super(message);
    this.name = "PlackettLuceFitError";
    this.reason = reason;
    Object.setPrototypeOf(this, PlackettLuceFitError.prototype);
  }
}

/** 非負整数nから非負整数r個を選ぶ組合せ数(0<=r<=n前提。ドメイン外は呼び出し側の契約違反)。 */
function binomial(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  let result = 1;
  const rr = Math.min(r, n - r);
  for (let i = 0; i < rr; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/** items(添字配列)からk個を選ぶ組合せを列挙する(小さいkのみを想定。バックトラック実装)。 */
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

/**
 * Plackett-Luce の潜在強度θから、各馬が「上位k集合」に入る周辺確率 F_i(θ) を閉形式で計算する。
 *
 * 導出(指数レース表現): T_i ~ Exp(θ_i) 独立、小さい順に着順。馬iの順位がr+1で、先着集合が
 * ちょうどAである確率を積分し、包除原理で整理すると次の閉形式が得られる(boss 2026-09-XX 導出・
 * n=2..8の全k・θ動的レンジ込みでブルートフォース照合済み。本ファイルのテストでも同じ照合を行う):
 *
 *   F_i(θ) = θ_i · Σ_{d=0}^{k-1} (-1)^{k-1-d}・C(n-2-d, k-1-d)・Σ_{|D|=d, i∉D} 1/(Θ-θ_D)
 *   Θ = Σ_j θ_j、θ_D = Σ_{j∈D} θ_j(Dはi以外のn-1頭からの部分集合)
 *
 * 前提(呼び出し側の契約): theta の全要素が有限の正の値であること、1<=k<=n-1(n=theta.length、
 * n>=2)であること。この前提はn-2-d>=k-1-d>=0(二項係数の定義域)を保証する
 * (0<=d<=k-1<=n-2 より n-2-d >= n-2-(k-1) = n-1-k >= 0)。
 *
 * 計算量: 各iについてd=0..k-1それぞれでC(n-1,d)通りの部分集合を数え上げるため、
 * 全体でO(n·C(n-1,k-1))(k=3ならO(n^3))。反復フィットのループ内で毎回呼ぶ前提のため、
 * 816通りの分布を毎回構築する素朴な実装より高速(要修正2で是正: `scripts/bench-joint-model.ts`
 * の `runNaiveVsClosedFormComparison` で実測・再現可能。18頭・k=3で実測した結果は
 * `pnpm tsx scripts/bench-joint-model.ts` の出力「要修正2」節を参照。実測値そのものは
 * 実行環境・JITの状態に依存するため本JSDocには固定値を転記しない)。
 *
 * **【提案B・レビューで記録】任意の k を許すと C(n-1,k-1) で組合せ爆発する**(code-reviewerの
 * 実測: n=40・k=20 付近で実行がハングする)。production は placeCount<=3(reducedPlaceCount も
 * それ以下)のみを使うため #77(#20-A)のスコープでは実害が無いが、**将来この関数を大きい k で
 * 呼ぶ呼び出し元ができた場合の懸念として記録する**。対応(上限のガード等)は現時点では行わない。
 */
export function computePlackettLuceMarginals(
  theta: readonly number[],
  k: number,
): number[] {
  const n = theta.length;
  const Theta = theta.reduce((a, b) => a + b, 0);
  const allIndices = theta.map((_, i) => i);
  const totals = new Array(n).fill(0);

  for (let d = 0; d <= k - 1; d++) {
    const sign = (k - 1 - d) % 2 === 0 ? 1 : -1;
    const coef = sign * binomial(n - 2 - d, k - 1 - d);

    // A_d = Σ_{|D|=d, D⊆全n頭} 1/(Θ-θ_D)。全馬で共有する項なので1回だけ計算する
    // (n頭ぶんループを回すループの外側で1回計算することが、素朴な「馬ごとにn-1頭からd個選ぶ」実装
    // 〈O(n·C(n-1,d))〉に対する高速化の核。ここはO(C(n,d))で済む)。
    let A_d = 0;
    for (const D of combinationsOf(allIndices, d)) {
      const thetaD = D.reduce((a, idx) => a + theta[idx]!, 0);
      A_d += 1 / (Theta - thetaD);
    }
    for (let i = 0; i < n; i++) totals[i] += coef * A_d;

    if (d === 0) continue; // B_0(i)=0(サイズ0の部分集合はiを含み得ない)なので補正不要。

    // B_d(i) = Σ_{|D|=d, i∈D} 1/(Θ-θ_D) = Σ_{|D'|=d-1, D'⊆others_i} 1/(Θ-θ_i-θ_D')。
    // 馬ごとに「他のn-1頭からd-1個選ぶ」だけで済む(O(n·C(n-1,d-1)))。
    for (let i = 0; i < n; i++) {
      const others = allIndices.filter((idx) => idx !== i);
      let B_d_i = 0;
      for (const Dp of combinationsOf(others, d - 1)) {
        const thetaDp = Dp.reduce((a, idx) => a + theta[idx]!, 0);
        B_d_i += 1 / (Theta - theta[i]! - thetaDp);
      }
      totals[i] -= coef * B_d_i;
    }
  }

  return allIndices.map((i) => theta[i]! * totals[i]!);
}

/** 水詰め射影の結果。 */
interface WaterFillingResult {
  /** 射影後の目標(min(1, λ·p_i))。p と同じ順序。 */
  readonly q: readonly number[];
  readonly lambda: number;
}

/**
 * [0,1]箱での水詰め射影: Σ_i min(1, λ·p_i) = k となる λ≥0 を、ソート+累積和のみで
 * 厳密に(反復・収束判定なしで)求める。前提: p は全要素 [0,1] の範囲内、
 * #{i: p_i>0} >= k(infeasible-supportではない)。
 */
function solveWaterFilling(p: readonly number[], k: number): WaterFillingResult {
  const positiveIndexed = p
    .map((v, i) => ({ v, i }))
    .filter((e) => e.v > 0)
    .sort((a, b) => b.v - a.v);
  const m = positiveIndexed.length;

  if (m === k) {
    // p>0の頭数がちょうどk: 全員を上位k枠に固定するしかない(他に候補がいないため)。
    // 代表値として「全員が確実に q=1 に達する最小のλ」を報告する(それ以上のλはすべて同じ結果)。
    const minPositive = positiveIndexed[m - 1]!.v;
    const lambda = 1 / minPositive;
    const q = p.map((v) => (v > 0 ? 1 : 0));
    return { q, lambda };
  }

  // m > k のケース(m<kは呼び出し前にinfeasible-supportとして弾かれている前提)。
  // 上位c頭(pの降順)を「固定」と仮定した候補λを小さいcから順に試し、
  // 残り(m-c)頭のうち最大のものがλ倍後も1を超えないcを採用する(標準的な水詰めアルゴリズム)。
  let cumulative = 0;
  for (let c = 0; c < k; c++) {
    const remainingSum = positiveIndexed.slice(c).reduce((a, e) => a + e.v, 0);
    const candidateLambda = (k - c) / remainingSum;
    const nextLargest = positiveIndexed[c]!.v;
    if (nextLargest * candidateLambda <= 1) {
      const q = p.map((v) => Math.min(1, candidateLambda * v));
      return { q, lambda: candidateLambda };
    }
    cumulative += positiveIndexed[c]!.v;
  }
  // 理論上到達しない(m>kならc=0..k-1の範囲で必ず解が見つかることを設計時に証明済み)。
  // 防御的フォールバック: 全頭固定に倒す(万一到達した場合もNaN等を伝播させない)。
  void cumulative;
  const lambda = m > 0 ? 1 / positiveIndexed[m - 1]!.v : 0;
  const q = p.map((v) => (v > 0 ? Math.min(1, lambda * v) : 0));
  return { q, lambda };
}

/** 自由集合(n'>=2, 1<=k'<n')の反復フィット結果。 */
interface FreeSetFitResult {
  readonly theta: number[];
  readonly iterations: number;
  readonly residualMax: number;
  readonly unstable: boolean;
  readonly notConverged: boolean;
}

/** 自由集合を反復フィットする(θ←θ·(q/F)の乗法的固定点更新)。 */
function fitFreeSet(q: readonly number[], k: number): FreeSetFitResult {
  const n = q.length;

  // k'=1: F_i(θ)=θ_i/Σθ かつ Σq_i=k'=1(水詰めの保存則)なので θ=q が厳密解(反復不要)。
  if (k === 1) {
    return { theta: [...q], iterations: 0, residualMax: 0, unstable: false, notConverged: false };
  }

  // 初期値: CBモデルと同じ発想の重み q/(1-q)(0<q<1が前提なので0除算は起きない)。
  let theta = q.map((v) => v / (1 - v));
  let residualMax = Number.POSITIVE_INFINITY;
  let iterations = 0;

  for (let iter = 1; iter <= MAX_FIT_ITERATIONS; iter++) {
    const F = computePlackettLuceMarginals(theta, k);
    residualMax = 0;
    for (let i = 0; i < n; i++) {
      residualMax = Math.max(residualMax, Math.abs(F[i]! - q[i]!));
    }
    iterations = iter;
    if (residualMax < FIT_TOLERANCE) {
      return { theta, iterations: iter - 1, residualMax, unstable: false, notConverged: false };
    }
    const next = theta.map((t, i) => t * (q[i]! / F[i]!));
    const total = next.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total) || total === 0) {
      return { theta: next, iterations: iter, residualMax, unstable: true, notConverged: false };
    }
    theta = next;
  }
  return { theta, iterations, residualMax, unstable: false, notConverged: true };
}

/**
 * Plackett-Luce の潜在強度θを、目標の複勝圏内確率(placeProb)から推定する。
 *
 * 前提として想定していない(呼び出し側で先に処理すべき)ケース: k=0, n=0, k>=n, n=1
 * (PLACKETT_LUCE_MODEL.buildDistribution・winProbabilitiesFromStrengths はこれらの縮退入力に
 * 対して本関数を呼ばない。ただし本関数自体もこれらに対して防御的に妥当な結果を返す
 * 〈直接呼び出すテスト・将来の呼び出し元のための頑健性〉)。
 */
export function fitPlackettLuceStrengths(
  horses: readonly JointModelHorse[],
  placeCount: number,
): PlackettLuceFitResult {
  const n = horses.length;
  const p = horses.map((h) => h.placeProb);

  // 1. 入力検証(placeProb)。
  for (const v of p) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, reason: "invalid-probability" };
    }
  }

  // 2. 入力検証(placeCount)。
  if (!Number.isFinite(placeCount) || placeCount < 0 || !Number.isInteger(placeCount)) {
    return { ok: false, reason: "invalid-place-count" };
  }
  const k = placeCount;

  // 3. 縮退(現行モデルの契約と同一。呼び出し元は通常ここへ到達する前に自前で処理する想定だが、
  //    本関数を直接呼んでも安全に妥当な結果を返す)。
  if (n === 0 || k === 0) {
    return {
      ok: true,
      theta: new Array(n).fill(0),
      iterations: 0,
      residualMax: 0,
      rescaleApplied: false,
      rescaleFactor: 1,
      degenerateZeroCount: n,
      degenerateFixedCount: 0,
      rescaleInducedFixedCount: 0,
      reducedHorseCount: 0,
      reducedPlaceCount: 0,
    };
  }
  if (k >= n) {
    return {
      ok: true,
      theta: new Array(n).fill(1), // 全頭固定。相対値に意味はない(全員必ず含まれる)ので便宜上1。
      iterations: 0,
      residualMax: 0,
      rescaleApplied: false,
      rescaleFactor: 1,
      degenerateZeroCount: 0,
      degenerateFixedCount: n,
      rescaleInducedFixedCount: 0,
      reducedHorseCount: 0,
      reducedPlaceCount: 0,
    };
  }

  // 4. infeasible-support: p>0の頭数がk未満なら、Σ=kを満たす目標が存在しない。
  const positiveCount = p.filter((v) => v > 0).length;
  if (positiveCount < k) {
    return { ok: false, reason: "infeasible-support" };
  }

  // 5. [0,1]箱での水詰め射影(決定的・収束判定不要)。
  // Σp=kちょうどなら水詰めのλは厳密に1になる(m>kの分岐ではc=0でcandidateLambda=(k-0)/k=1、
  // m=kの分岐ではΣp=kかつ各p<=1よりm項の和がmに等しくなるには全てp=1が必要でlambda=1/1=1)。
  // そのためλ!==1だけでΣp=kちょうどかどうかを厳密に判定できる。
  const { q, lambda } = solveWaterFilling(p, k);
  const rescaleApplied = lambda !== 1;

  // 6. 分類: 0=除外、1=固定、それ以外=自由集合。
  const zeroIndices: number[] = [];
  const fixedIndices: number[] = [];
  const freeIndices: number[] = [];
  let rescaleInducedFixedCount = 0;
  for (let i = 0; i < n; i++) {
    if (q[i] === 0) {
      zeroIndices.push(i);
    } else if (q[i] === 1) {
      fixedIndices.push(i);
      if (p[i]! < 1) rescaleInducedFixedCount++;
    } else {
      freeIndices.push(i);
    }
  }

  const reducedHorseCount = freeIndices.length;
  const reducedPlaceCount = k - fixedIndices.length;

  const theta = new Array(n).fill(0);
  for (const idx of fixedIndices) theta[idx] = Number.POSITIVE_INFINITY;

  if (reducedHorseCount === 0) {
    // reducedPlaceCount も 0 のはず(自由集合が空なら保存則よりk'=0)。
    return {
      ok: true,
      theta,
      iterations: 0,
      residualMax: 0,
      rescaleApplied,
      rescaleFactor: lambda,
      degenerateZeroCount: zeroIndices.length,
      degenerateFixedCount: fixedIndices.length,
      rescaleInducedFixedCount,
      reducedHorseCount: 0,
      reducedPlaceCount: 0,
    };
  }

  const freeTargets = freeIndices.map((idx) => q[idx]!);
  const fit = fitFreeSet(freeTargets, reducedPlaceCount);

  if (fit.unstable) {
    return { ok: false, reason: "numerically-unstable" };
  }
  if (fit.notConverged) {
    return { ok: false, reason: "not-converged" };
  }

  // スケール規約: 自由集合のΣθ = reducedHorseCount(平均1)に正規化する(F はスケール不変)。
  const rawSum = fit.theta.reduce((a, b) => a + b, 0);
  const scale = reducedHorseCount / rawSum;
  const normalizedFreeTheta = fit.theta.map((t) => t * scale);
  for (let j = 0; j < freeIndices.length; j++) {
    theta[freeIndices[j]!] = normalizedFreeTheta[j]!;
  }

  // 正規化後の残差を測り直す(スケール不変なので理論上は同一だが、実際に使う配列で検算する)。
  // θの動的レンジが大きい入力(target が1に極めて近い等)では、正規化のスケール乗算そのものが
  // 桁落ちを持ち込み、ループ内部の残差判定(収束と判断した時点の値)より実際に悪化しうる。
  // 「収束した」と申告する残差は、実際に返す theta を使って測り直したこの値を権威とする。
  // ループ内部の判定だけを信じて楽観的に ok:true を返すと、「収束していないのに収束したと
  // 申告する」欠陥になる(本タスクが最も戒めている類)。
  //
  // **この経路は実際に発火する(要修正Aで実測確認)**。片側だけを極端にする探索(near-boundary
  // の内点ターゲットを中心にした約1.2万件・boss の約19万件)では見つからなかったが、
  // **両極端(非常に小さいtinyと1に非常に近いrest)をほぼ同数混ぜる**と、自由集合のθの動的
  // レンジが極端(1e12オーダー)に達し、ΣθをreducedHorseCountへ正規化する乗算(t * scale)
  // 自体の相対丸め(浮動小数点1ULP、約1e-16)が、この極端な条件数の下で閉形式の計算を通じて
  // 増幅され、正規化前(ループ内)の残差がFIT_TOLERANCE未満でも正規化後の残差がFIT_TOLERANCE
  // 以上になる(自分の実測: n=14・placeCount=7〈production範囲外〉・7頭がp=1e-6・7頭が
  // p=0.999999で、ガードを外すと residualMax=1.0000e-6≥FIT_TOLERANCE のまま ok:true を
  // 返してしまうことを確認。この関数のテストで固定している)。k<=3(production到達可能な
  // 唯一の範囲)では同じ両極端構造で2295件探索して発火する入力は見つかっていない
  // (`numerically-unstable` と同じ流儀。断定はしない)。
  const finalF = computePlackettLuceMarginals(normalizedFreeTheta, reducedPlaceCount);
  let finalResidual = 0;
  for (let i = 0; i < freeTargets.length; i++) {
    finalResidual = Math.max(finalResidual, Math.abs(finalF[i]! - freeTargets[i]!));
  }
  if (finalResidual >= FIT_TOLERANCE) {
    return { ok: false, reason: "not-converged" };
  }

  return {
    ok: true,
    theta,
    iterations: fit.iterations,
    residualMax: finalResidual,
    rescaleApplied,
    rescaleFactor: lambda,
    degenerateZeroCount: zeroIndices.length,
    degenerateFixedCount: fixedIndices.length,
    rescaleInducedFixedCount,
    reducedHorseCount,
    reducedPlaceCount,
  };
}
