/**
 * probability-quality-metrics — 確率の質を測る指標群の低レベル実装(#40「#35-1a」)。
 *
 * `probability-quality.ts`(公開エントリポイント `buildProbabilityQualityReport`)の内部実装。
 * **意図的にこのファイルは `packages/core/package.json` の `exports` サブパスに載せない**
 * (受け入れ条件5'。code-reviewer指摘: 低レベル関数を `exports` サブパス経由で直接呼べてしまうと
 * `conditions` を伴わない裸の数値が取得できてしまう)。`packages/core` 内部(`probability-quality.ts`・
 * 自パッケージのテスト)からは通常の相対importで参照できるが、パッケージ境界の外
 * (`@keiba/core/ev/probability-quality` 経由の外部利用者)からは到達できない
 * (ファイル分割そのものが強制の実体であり、レビューで消せる「ソース走査ガード」ではない)。
 *
 * ネットワーク・LLM・SQLiteには一切依存しない純関数群。`prior.ts`・`place-joint-model.ts`・
 * `combo-bet-allocation.ts`・`expected-value.ts` の挙動は一切変更しない
 * (値として import して再利用するのみ)。
 *
 * ## AC9: 値インポート境界
 * `./place-joint-model.js`・`./combo-bet-allocation.js`(いずれも実測でrendererバンドル済み・
 * node:*非依存と確認済み)からは値として `CONDITIONAL_BERNOULLI_MODEL`・`resolveComboOdds` を
 * 再利用する(受け入れ条件7。二重定義しない)。`scraper/scrape-race.ts` 等の重い実行時依存を
 * 持つモジュールからの値インポートは0件。
 *
 * ## NaN・Infinity・負値の防御(code-reviewer指摘・boss実測で再現)
 * `modelProb`(prior・LLM補正後確率)・`placeProb` を受け取るすべての指標関数は、演算前に
 * `findInvalidProbabilityReason` で**有限かつ非負**であることを検証する。
 * `computeMarketImpliedPlaceProbabilities`(市場側・外部データ由来)が最初から
 * `Number.isFinite`/`>0` を検証していたのに対し、モデル側の確率にはこの検証が無く、
 * NaN が1つ混入するだけで Spearman ρ が `+0.8→-0.6` のように**符号すら反転した「もっともらしい
 * 数値」**として `reason: null`(=正常に測定できた)で返ってしまう欠陥があった(実測: boss・
 * code-reviewer双方で再現)。分散比でも `sdMarket===0` の分岐判定が NaN(`NaN===0`は常にfalse)を
 * すり抜け、`{value: NaN, reason: null}` が返っていた(`JSON.stringify`はNaNを`null`に変換して
 * 表示するため、ログ上は「value:null, reason:null」という一見無害な形に化けて発見を遅らせていた)。
 * 是正: 演算前に**入力側で**弾き、`null` を返す場合は必ず理由文字列を伴わせる
 * (`NullableMetric`・`MarketImpliedPlaceProbabilities`・`TrioAllPointEvOverPayoutRateResult`
 * を判別共用体にし、`{value:null, reason:null}` のような不整合な組み合わせを型で構築不能にした。
 * ただし判別共用体は「NaNというnumber型の値」を型では検出できない〈NaNもTS上はnumber〉ため、
 * 実際の防御は演算前のランタイム検証が本体で、判別共用体は「検証を素通りしたnullがreason無しで
 * 返る」という取り違えクラスの再発を防ぐ二重の安全網)。
 *
 * ## ワイドへの誤用を防ぐ(受け入れ条件6)
 * `computeTrioAllPointEvOverPayoutRate` は**三連複の組合せオッズ専用**の関数で、汎用の
 * `comboType` 引数を持たない(構造的に「ワイドを渡す」という呼び出し自体ができない)。
 * 三連複は1レース1組的中のため `Σ(1/odds) = 1/払戻率` が厳密に成立するが、ワイドは1レース3組が
 * 同時的中するため成立しない(実測・誤用の危険性は `probability-quality.test.ts`
 * 「ワイドへの誤用防止」参照)。
 */

import type { JointModelHorse } from "./place-joint-model.js";
import { CONDITIONAL_BERNOULLI_MODEL } from "./place-joint-model.js";
import { resolveComboOdds } from "./combo-bet-allocation.js";

// ---------------------------------------------------------------------------
// 共通の型
// ---------------------------------------------------------------------------

/**
 * null許容の指標値。判別共用体にすることで、`{value:null, reason:null}`
 * (=測れなかったのに理由が無い)という不整合な組み合わせをコンパイル時に構築不能にする
 * (code-reviewer指摘2)。生成は必ず `metricOk`/`metricNull` を経由すること。
 */
export type NullableMetric =
  | { readonly value: number; readonly reason: null }
  | { readonly value: null; readonly reason: string };

/** 算出できた指標値を返す。 */
function metricOk(value: number): NullableMetric {
  return { value, reason: null };
}

/** 算出できなかった指標値を、理由付きで返す。 */
function metricNull(reason: string): NullableMetric {
  return { value: null, reason };
}

// ---------------------------------------------------------------------------
// 基礎統計ヘルパ(内部利用)
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** 母集団標準偏差(出走全頭という「母集団」を扱うため、n-1補正はしない)。 */
function populationStdDev(values: readonly number[]): number {
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * 確率配列の値検証(有限かつ非負であること)。`computeMarketImpliedPlaceProbabilities`
 * (市場側)の `Number.isFinite`/`>0` 検証と同じ厳しさを、モデル側の確率配列にも揃える
 * (code-reviewer指摘: 市場側だけ検証がありモデル側に無いという非対称の解消)。
 *
 * 上限は設けない(Σ=3正規化後の市場含意確率は1を超えうる。個々の確率が1を超えても
 * それ自体は不正ではない)。NaN・±Infinity・負値のみを不正として扱う。
 *
 * @returns 不正な値が見つかった場合はその理由(呼び出し側での null 化に使う)。無ければ null。
 */
function findInvalidProbabilityReason(
  values: readonly number[],
  label: string,
): string | null {
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v) || v < 0) {
      return `${label}の${i + 1}番目の値が不正(NaN・Infinity・負値のいずれか。値=${String(v)})`;
    }
  }
  return null;
}

/**
 * 単一の確率配列に対するmax/min比。`computeVarianceRatioMetrics`内部で使う他、
 * 市場側が算出不能でモデル側だけを単独で評価したい呼び出し側(`buildProbabilityQualityReport`の
 * 市場不能分岐)向けに公開する。
 */
export function computeMaxMinRatio(values: readonly number[]): NullableMetric {
  if (values.length === 0) {
    return metricNull("対象馬が0頭");
  }
  const invalidReason = findInvalidProbabilityReason(values, "確率配列");
  if (invalidReason !== null) {
    return metricNull(invalidReason);
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!(min > 0)) {
    return metricNull("最小値が0以下(ゼロ除算、または非正の値を含む)");
  }
  return metricOk(max / min);
}

// ---------------------------------------------------------------------------
// (2) 市場含意複勝確率
// ---------------------------------------------------------------------------

/** computeMarketImpliedPlaceProbabilities の1頭分の入力。 */
export interface PlaceOddsInputHorse {
  readonly umaban: number;
  /** 複勝オッズ下限(未確定・非数値・yosoで複勝オッズ自体が無い場合は null)。 */
  readonly placeOddsMin: number | null;
}

/**
 * 市場含意複勝確率の算出結果。判別共用体にし、`{values:null, reason:null}` のような
 * 不整合な組み合わせを型で構築不能にする(`NullableMetric` と同じ理由。code-reviewer指摘2)。
 */
export type MarketImpliedPlaceProbabilities =
  | {
      /** 馬番→Σ=min(3,頭数)に正規化した市場含意確率。 */
      readonly values: ReadonlyMap<number, number>;
      readonly reason: null;
    }
  | {
      readonly values: null;
      /** 算出不能だった理由。 */
      readonly reason: string;
    };

/**
 * `1/placeOddsMin` から市場含意複勝確率を求め、Σ=min(3,頭数)に正規化する。
 *
 * `placeOddsMin` が欠損(null)・非有限・0以下の馬が**1頭でもいる**レースは、Σ=一定への
 * 正規化そのものが崩れるため、レース全体の市場系指標を算出不能(`values: null`)として扱う
 * (一部の馬だけ除外して正規化すると、残りの馬の値も歪むため)。
 *
 * `oddsStatus === "yoso"`(発売前)は `OddsSnapshot.place` が常に空オブジェクトになる
 * (複勝オッズ自体が未発売)。呼び出し側が生の `OddsSnapshot.place` から `placeOddsMin` を
 * 引く限り、この関数は必ずこの経路(全馬 `placeOddsMin: null` → 算出不能)に入る。
 *
 * **注意**: `AnalysisRow.placeOddsMin`(`packages/app` の分析結果行)は `yoso` のとき
 * 単勝オッズからの推定値に置き換わっており、生の市場データではない
 * (`computeEstimatedRaceEv`。`expected-value.ts` のJSDoc「本関数は odds.place を一切参照
 * しない」参照)。本関数には必ず `OddsSnapshot.place[umaban].oddsMin` 由来の値(生データ)を
 * 渡すこと。
 */
export function computeMarketImpliedPlaceProbabilities(
  horses: readonly PlaceOddsInputHorse[],
): MarketImpliedPlaceProbabilities {
  if (horses.length === 0) {
    return { values: null, reason: "出走馬が0頭" };
  }
  const inverses: { umaban: number; inv: number }[] = [];
  for (const h of horses) {
    const odds = h.placeOddsMin;
    if (odds === null || !Number.isFinite(odds) || odds <= 0) {
      return {
        values: null,
        reason: `馬番${h.umaban}の複勝オッズ下限が欠損または不正な値のため、レース全体のΣ=一定への正規化が崩れる(oddsStatus="yoso"では常にこの経路に入る)`,
      };
    }
    inverses.push({ umaban: h.umaban, inv: 1 / odds });
  }
  const sumInv = inverses.reduce((s, r) => s + r.inv, 0);
  if (!(sumInv > 0) || !Number.isFinite(sumInv)) {
    return { values: null, reason: "複勝オッズ下限の逆数合計が0以下または非有限" };
  }
  // 複勝は原則3着以内。頭数が3未満のレースはΣの目標を頭数に合わせる
  // (prior.ts の neutralProbFor と同じ min(3,頭数)の考え方に揃える)。
  const target = Math.min(3, horses.length);
  const values = new Map<number, number>();
  for (const r of inverses) {
    values.set(r.umaban, (r.inv / sumInv) * target);
  }
  return { values, reason: null };
}

// ---------------------------------------------------------------------------
// (2) Spearman順位相関
// ---------------------------------------------------------------------------

/** 平均順位法でタイを処理した順位配列を返す(1始まり)。 */
function rankWithTies(values: readonly number[]): number[] {
  const n = values.length;
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]!] === values[order[i]!]) {
      j++;
    }
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[order[k]!] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman順位相関係数(平均順位法によるタイ補正込み)。
 * 一方(または両方)の系列が全馬同一値の場合、順位の分散が0になり相関係数を定義できないため
 * `null` を返す(0を返すと「無相関」という積極的な主張になってしまい、
 * 「定義できない」とは意味が異なる)。
 */
export function spearmanRankCorrelation(
  a: readonly number[],
  b: readonly number[],
): NullableMetric {
  if (a.length !== b.length) {
    return metricNull("入力2系列の長さが一致しない");
  }
  const invalidA = findInvalidProbabilityReason(a, "系列a");
  if (invalidA !== null) {
    return metricNull(invalidA);
  }
  const invalidB = findInvalidProbabilityReason(b, "系列b");
  if (invalidB !== null) {
    return metricNull(invalidB);
  }
  const n = a.length;
  if (n < 2) {
    return metricNull("頭数が2未満(順位相関を定義できない)");
  }
  const rankA = rankWithTies(a);
  const rankB = rankWithTies(b);
  const meanA = mean(rankA);
  const meanB = mean(rankB);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = rankA[i]! - meanA;
    const db = rankB[i]! - meanB;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa === 0 || sbb === 0) {
    return metricNull("一方の系列が全馬同順位(順位の分散が0で相関係数を定義できない)");
  }
  return metricOk(sab / Math.sqrt(saa * sbb));
}

// ---------------------------------------------------------------------------
// (3) 分散比・max/min比
// ---------------------------------------------------------------------------

/** 分散比・max/min比の算出結果。 */
export interface VarianceRatioMetrics {
  /** sd(model)/sd(market)。1.0が市場と同等の散らばり。 */
  readonly sdRatio: NullableMetric;
  readonly maxMinRatioModel: NullableMetric;
  readonly maxMinRatioMarket: NullableMetric;
}

/**
 * モデル確率・市場含意確率それぞれの標準偏差比・max/min比を算出する。
 * `maxMinRatioModel`/`maxMinRatioMarket` は `maxMinRatio` 自体が有限性・非負性を検証するため
 * 片方だけ不正でももう片方は独立して算出できる(粒度を保つ)。`sdRatio` は両系列を同時に使うため、
 * いずれかが不正なら算出不能にする。
 */
export function computeVarianceRatioMetrics(
  model: readonly number[],
  market: readonly number[],
): VarianceRatioMetrics {
  if (model.length !== market.length) {
    const reason = "入力2系列の長さが一致しない";
    return {
      sdRatio: metricNull(reason),
      maxMinRatioModel: metricNull(reason),
      maxMinRatioMarket: metricNull(reason),
    };
  }
  const maxMinRatioModel = computeMaxMinRatio(model);
  const maxMinRatioMarket = computeMaxMinRatio(market);

  const invalidModel = findInvalidProbabilityReason(model, "model");
  const invalidMarket = findInvalidProbabilityReason(market, "market");
  if (invalidModel !== null || invalidMarket !== null) {
    return { sdRatio: metricNull(invalidModel ?? invalidMarket!), maxMinRatioModel, maxMinRatioMarket };
  }

  const sdModel = populationStdDev(model);
  const sdMarket = populationStdDev(market);
  const sdRatio =
    sdMarket === 0
      ? metricNull("市場側の標準偏差が0(全馬同一の市場含意確率でゼロ除算)")
      : metricOk(sdModel / sdMarket);
  return { sdRatio, maxMinRatioModel, maxMinRatioMarket };
}

// ---------------------------------------------------------------------------
// (4) 三連複同時分布の正規化KL
// ---------------------------------------------------------------------------

/**
 * 確率分布(合計1を想定)の一様分布からのKLダイバージェンスを `log(要素数)` で正規化する。
 * `KL(dist‖uniform) / log(m)`。生KLは組合せ数 m(=C(頭数,3))に依存しスケールしないため、
 * m が異なるレース間で比較可能にする(#35の看板「一様分布からの乖離」をスケール不変にしたもの)。
 *
 * - `m<=1` は `log(m)<=0` となり正規化できないため `null`。
 * - `p=0` の要素は `0·log(0/q) = 0`(標準的な情報理論の慣例)として扱い、寄与をスキップする
 *   (`Math.log(0)` による `-Infinity` や `0 * -Infinity = NaN` の伝播を避ける)。
 */
export function normalizedKlDivergenceFromUniform(
  probabilities: readonly number[],
): NullableMetric {
  const m = probabilities.length;
  if (m <= 1) {
    return metricNull("組合せ数が1以下(log(組数)<=0でスケール不変にできない)");
  }
  const invalidReason = findInvalidProbabilityReason(probabilities, "確率配列");
  if (invalidReason !== null) {
    return metricNull(invalidReason);
  }
  const uniform = 1 / m;
  let kl = 0;
  for (const p of probabilities) {
    if (p <= 0) {
      continue;
    }
    kl += p * Math.log(p / uniform);
  }
  return metricOk(kl / Math.log(m));
}

/**
 * 三連複(上位3着の組合せ)の同時分布を `CONDITIONAL_BERNOULLI_MODEL` で構築し、
 * 一様分布からの正規化KLを求める。モデルpriorと市場含意確率のどちらを渡すかは
 * 呼び出し側が選ぶ(同一関数を確率の出どころだけ差し替えて2回呼ぶことで、
 * モデル側・市場側を必ず同じ土俵で比較できる。受け入れ条件5「使ったオッズの種別」を
 * 明示する設計の一部)。
 *
 * 頭数が3未満は三連複の組を構成できないため `null`(3頭ちょうどは組が1通り=m=1となり、
 * 上の `normalizedKlDivergenceFromUniform` 側の `m<=1` 判定で別途 `null` になる。
 * 「頭数<3」と「m=1(3頭ちょうど)」はテスト観点上区別する)。
 *
 * **`placeProb` の事前検証(code-reviewer指摘)**: `CONDITIONAL_BERNOULLI_MODEL` 自体は
 * NaN等の病的入力を検出すると例外を投げず均等分布へフォールバックする設計(`place-joint-model.ts`
 * のJSDoc参照。この既存挙動は変更しない)。しかしこのフォールバックは「入力が壊れている」ことを
 * 一様分布(KL=0。もっともらしい正常値)に変換してしまい、`reason: null` のまま静かに漏れる
 * (このモジュール自身が犯していた欠陥と同じ形)。そのため `buildDistribution` を呼ぶ前に
 * このモジュール側で `placeProb` を検証し、不正なら理由付きで `null` を返す。
 */
export function normalizedTrioJointKlDivergence(
  horses: readonly JointModelHorse[],
): NullableMetric {
  if (horses.length < 3) {
    return metricNull("頭数が3未満(三連複の組を構成できない)");
  }
  const invalidReason = findInvalidProbabilityReason(
    horses.map((h) => h.placeProb),
    "複勝圏内確率",
  );
  if (invalidReason !== null) {
    return metricNull(invalidReason);
  }
  const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(horses, 3);
  return normalizedKlDivergenceFromUniform(distribution.map((o) => o.probability));
}

// ---------------------------------------------------------------------------
// (1) 全点等額購入時の平均EV÷払戻率(三連複専用)
// ---------------------------------------------------------------------------

/** computeTrioAllPointEvOverPayoutRate の判定内訳(判定不能を分母に混ぜない。受け入れ条件7)。 */
export interface TrioAllPointMetricDiagnostics {
  /** 列挙した組合せ総数(= C(頭数,3))。 */
  readonly enumeratedCount: number;
  /** オッズを取得でき、平均EV・払戻率推定の両方に使った組の数。 */
  readonly presentCount: number;
  readonly unfetchedCount: number;
  readonly missingCount: number;
  readonly malformedCount: number;
}

/**
 * computeTrioAllPointEvOverPayoutRate の算出結果。判別共用体にし、`ratio`等が null なのに
 * `reason` が null という不整合を型で構築不能にする(`NullableMetric` と同じ理由)。
 */
export type TrioAllPointEvOverPayoutRateResult =
  | {
      /** 平均EV ÷ 払戻率推定値(過大評価倍率)。 */
      readonly ratio: number;
      /** 全点等額購入時の平均EV(= mean(model_prob × odds)、present の組のみ)。 */
      readonly averageEv: number;
      /** 払戻率推定値(= 1/Σ(1/odds)、present の組のみ)。 */
      readonly estimatedPayoutRate: number;
      readonly diagnostics: TrioAllPointMetricDiagnostics;
      readonly reason: null;
    }
  | {
      readonly ratio: null;
      readonly averageEv: null;
      readonly estimatedPayoutRate: null;
      readonly diagnostics: TrioAllPointMetricDiagnostics;
      /** 算出不能だった理由。 */
      readonly reason: string;
    };

/**
 * 全点等額購入時の平均EV÷払戻率(三連複専用。受け入れ条件6「ワイドに適用しない」)。
 *
 * 三連複は1レース1組的中のため、市場が効率的なら `Σ(1/odds) = 1/払戻率` が厳密に成立し、
 * 全点等額購入の真の回収率は払戻率そのものになる。モデルpriorから作った同時分布確率 `p_i` と
 * 実際のオッズ `odds_i` から `平均(p_i × odds_i)`(平均EV)を求め、`1/Σ(1/odds_i)`
 * (払戻率推定値)で割ると、モデルが市場含意確率からどれだけ系統的にズレているか
 * (較正の悪さ)を、結果(着順)を待たずに測れる。
 *
 * **部分網羅(unfetched/missing/malformedの組がある)の影響 — バイアスの向きに注意**:
 * 平均EVも払戻率推定値も `present`(オッズ取得済み・数値として正常)の組だけで計算する。
 * 組が一部欠けると `Σ(1/odds)` が本来より小さくなり、その逆数である払戻率推定値は
 * **本来より大きく**出る。「平均EV ÷ 払戻率推定値」の分母が大きくなるため、
 * **過大評価倍率(ratio)は実際より小さく(=モデルが実際より良く見える方向に)出る**。
 * つまりこのバイアスは**モデルに有利な方向**であり、安全側(過小評価側)ではない。
 * `diagnostics` の `unfetchedCount`/`missingCount`/`malformedCount` が0でない場合、
 * `ratio` を額面通りの過大評価倍率として使わないこと。
 *
 * @param horses 出走全頭のモデル確率(複勝圏内確率。同時分布の構築に使う)。
 * @param trioComboOdds 三連複の組合せオッズMap(`buildComboOddsKey`形式のキー)。
 *   4状態判別は既存の `resolveComboOdds`(`combo-bet-allocation.ts`)を再利用し、二重定義しない。
 */
export function computeTrioAllPointEvOverPayoutRate(
  horses: readonly JointModelHorse[],
  trioComboOdds: ReadonlyMap<string, number | null>,
): TrioAllPointEvOverPayoutRateResult {
  const emptyDiagnostics: TrioAllPointMetricDiagnostics = {
    enumeratedCount: 0,
    presentCount: 0,
    unfetchedCount: 0,
    missingCount: 0,
    malformedCount: 0,
  };
  if (horses.length < 3) {
    return {
      ratio: null,
      averageEv: null,
      estimatedPayoutRate: null,
      diagnostics: emptyDiagnostics,
      reason: "頭数が3未満(三連複の組を構成できない)",
    };
  }

  // placeProbの事前検証(code-reviewer指摘。normalizedTrioJointKlDivergenceと同じ理由:
  // buildDistributionはNaN等を検出すると例外を投げず均等分布へフォールバックするため、
  // 呼び出し前にここで弾かないと「入力が壊れている」ことがもっともらしいratio値に化けて
  // reason:nullのまま漏れる)。
  const invalidReason = findInvalidProbabilityReason(
    horses.map((h) => h.placeProb),
    "複勝圏内確率",
  );
  if (invalidReason !== null) {
    return {
      ratio: null,
      averageEv: null,
      estimatedPayoutRate: null,
      diagnostics: emptyDiagnostics,
      reason: invalidReason,
    };
  }

  // comboSize(3) === topFinishCount(3) のため、buildDistribution が返す各 PlaceOutcome は
  // そのまま三連複の1組合せに1:1対応する(ワイドのような部分集合の和を取る必要が無い)。
  const distribution = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(horses, 3);

  let sumEv = 0;
  let sumInverseOdds = 0;
  let presentCount = 0;
  let unfetchedCount = 0;
  let missingCount = 0;
  let malformedCount = 0;

  for (const outcome of distribution) {
    const resolution = resolveComboOdds(trioComboOdds, outcome.placed);
    if (resolution.state === "unfetched") {
      unfetchedCount++;
      continue;
    }
    if (resolution.state === "missing") {
      missingCount++;
      continue;
    }
    if (resolution.state === "malformed") {
      malformedCount++;
      continue;
    }
    presentCount++;
    sumEv += outcome.probability * resolution.odds;
    sumInverseOdds += 1 / resolution.odds;
  }

  const diagnostics: TrioAllPointMetricDiagnostics = {
    enumeratedCount: distribution.length,
    presentCount,
    unfetchedCount,
    missingCount,
    malformedCount,
  };

  if (presentCount === 0) {
    return {
      ratio: null,
      averageEv: null,
      estimatedPayoutRate: null,
      diagnostics,
      reason: "オッズを取得できた組が0件",
    };
  }

  const averageEv = sumEv / presentCount;
  const estimatedPayoutRate = 1 / sumInverseOdds;
  return {
    ratio: averageEv / estimatedPayoutRate,
    averageEv,
    estimatedPayoutRate,
    diagnostics,
    reason: null,
  };
}
