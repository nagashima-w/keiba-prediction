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
import { isUsableOdds } from "./allocation-primitives.js";
import {
  binIndexFor,
  calibrationBinBounds,
  DEFAULT_QUALITY_BIN_COUNT,
} from "./calibration-bins.js";

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
 * `placeOddsMin` が欠損(null)・値域外(1.0未満・非有限。Issue #74。判定基準は
 * `allocation-primitives.ts` の `isUsableOdds` に委譲する)の馬が**1頭でもいる**レースは、
 * Σ=一定への正規化そのものが崩れるため、レース全体の市場系指標を算出不能(`values: null`)
 * として扱う(一部の馬だけ除外して正規化すると、残りの馬の値も歪むため)。
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
    // 判定基準は allocation-primitives.ts の isUsableOdds に委譲する(Issue #74。旧実装は
    // `!Number.isFinite(odds) || odds <= 0` を独立に再実装しており、isUsableOddsの基準
    // 〈#74で>0から>=1.0へ引き上げ〉と食い違うと片方だけ古いまま残る事故の温床になっていた)。
    if (odds === null || !isUsableOdds(odds)) {
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

// ---------------------------------------------------------------------------
// (5) 二値事象の Brier スコアと Murphy 分解(#41「#35-1b」。着順が必要な唯一の指標群)
// ---------------------------------------------------------------------------

/** 1頭分の観測: 予測確率と、その事象(3着以内)が実際に起きたか。 */
export interface BrierObservation {
  readonly probability: number;
  readonly occurred: boolean;
}

/**
 * Brier 系関数の入力検証。**範囲外の確率はクリップせず弾く**(`computeMarketImpliedPlaceProbabilities`
 * のΣ=3正規化後に1を超えうる市場含意確率を黙って1へ丸めると、分解の前提が崩れたデータが
 * もっともらしい数値に化ける。呼び出し側がレース単位で市場比較から除外する)。
 */
function findInvalidBrierObservationReason(
  observations: readonly BrierObservation[],
): string | null {
  if (observations.length === 0) {
    return "観測が0件";
  }
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i]!;
    if (!Number.isFinite(o.probability) || o.probability < 0 || o.probability > 1) {
      return `${i + 1}番目の確率が不正(NaN・Infinity・負値・1超のいずれか。値=${String(o.probability)})`;
    }
    if (typeof o.occurred !== "boolean") {
      return `${i + 1}番目の結果が真偽値でない`;
    }
  }
  return null;
}

/** Brier スコア(確率と結果{0,1}の二乗誤差の平均)。小さいほど良い。 */
export function computeBrierScore(observations: readonly BrierObservation[]): NullableMetric {
  const invalid = findInvalidBrierObservationReason(observations);
  if (invalid !== null) {
    return metricNull(invalid);
  }
  let sum = 0;
  for (const o of observations) {
    sum += (o.probability - (o.occurred ? 1 : 0)) ** 2;
  }
  return metricOk(sum / observations.length);
}

/**
 * Brier skill score `1 − BS_model / BS_reference`。0=基準と同等、正=基準より良い、負=基準より悪い。
 * 基準の Brier が0(ゼロ除算)・非有限・負のときは `null`。
 */
export function brierSkillScore(modelBrier: number, referenceBrier: number): NullableMetric {
  if (!Number.isFinite(modelBrier) || modelBrier < 0) {
    return metricNull("モデルの Brier が非有限または負");
  }
  if (!Number.isFinite(referenceBrier) || referenceBrier < 0) {
    return metricNull("基準の Brier が非有限または負");
  }
  if (referenceBrier === 0) {
    return metricNull("基準の Brier が0(ゼロ除算)");
  }
  return metricOk(1 - modelBrier / referenceBrier);
}

/** Murphy 分解の1帯分(検証画面のキャリブレーション帯と同じ境界)。 */
export interface BrierBinSummary {
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly count: number;
  /** 帯内の予測確率の平均。件数0なら null。 */
  readonly meanForecast: number | null;
  /** 帯内の実際の発生率。件数0なら null(0 と書いて「的中率0%」と誤読させない)。 */
  readonly observedRate: number | null;
}

/**
 * Murphy 分解の結果。**帯で丸めた分解は `BS = REL − RES + UNC` が近似でしか成り立たない**
 * (帯の中で予測確率が一様でないため)。厳密な恒等式は
 * `BS = REL − RES + UNC + withinBinResidual`、`withinBinResidual = withinBinVariance − 2×withinBinCovariance`。
 * 残差の2項は REL/RES/UNC とは独立に算出する(BS からの逆算にすると恒等式の検査が循環する)。
 * **`withinBinResidual` は「帯内分散」ではない**(帯内の予測と結果の共分散を含み、負にもなる)。
 */
export interface BrierDecomposition {
  readonly n: number;
  /** Brier スコア(直接平均。分解の各項からは作っていない)。 */
  readonly brier: number;
  /** 全体の発生率 ō。 */
  readonly baseRate: number;
  /** 信頼性(小さいほど良い): Σ n_k (p̄_k − ō_k)² / n。 */
  readonly reliability: number;
  /** 分離性・識別力(大きいほど良い): Σ n_k (ō_k − ō)² / n。 */
  readonly resolution: number;
  /** 不確実性: ō(1−ō)。予測に依らない。 */
  readonly uncertainty: number;
  /** 帯内の予測確率の分散(Σ_k Σ_i∈k (p_i − p̄_k)² / n)。 */
  readonly withinBinVariance: number;
  /** 帯内の予測と結果の共分散(Σ_k Σ_i∈k (p_i − p̄_k)(o_i − ō_k) / n)。 */
  readonly withinBinCovariance: number;
  /** 帯丸めの残差 = withinBinVariance − 2×withinBinCovariance。 */
  readonly withinBinResidual: number;
  readonly bins: readonly BrierBinSummary[];
}

/** 判別共用体(`{decomposition:null, reason:null}` を型で構築不能にする)。 */
export type BrierDecompositionResult =
  | { readonly decomposition: BrierDecomposition; readonly reason: null }
  | { readonly decomposition: null; readonly reason: string };

/**
 * 二値事象の Brier スコアを Murphy 分解する。帯は検証画面のキャリブレーションと同じ
 * (`calibration-bins.ts` の `binIndexFor` を共有する。**同じ帯数を渡せば**検証画面と同じ帯になる。
 * 既定は `DEFAULT_QUALITY_BIN_COUNT`=10帯で、検証画面の既定〈20帯〉とは別。#37)。
 */
export function computeBrierDecomposition(
  observations: readonly BrierObservation[],
  binCount: number = DEFAULT_QUALITY_BIN_COUNT,
): BrierDecompositionResult {
  if (!Number.isInteger(binCount) || binCount < 1) {
    return { decomposition: null, reason: `帯数が正の整数でない(値=${String(binCount)})` };
  }
  const invalid = findInvalidBrierObservationReason(observations);
  if (invalid !== null) {
    return { decomposition: null, reason: invalid };
  }
  const n = observations.length;

  const counts = new Array<number>(binCount).fill(0);
  const sumP = new Array<number>(binCount).fill(0);
  const sumO = new Array<number>(binCount).fill(0);
  let sumOutcome = 0;
  let sumSquaredError = 0;
  for (const o of observations) {
    const k = binIndexFor(o.probability, binCount);
    const outcome = o.occurred ? 1 : 0;
    counts[k]! += 1;
    sumP[k]! += o.probability;
    sumO[k]! += outcome;
    sumOutcome += outcome;
    sumSquaredError += (o.probability - outcome) ** 2;
  }
  const baseRate = sumOutcome / n;

  let reliability = 0;
  let resolution = 0;
  for (let k = 0; k < binCount; k++) {
    const nk = counts[k]!;
    if (nk === 0) {
      continue;
    }
    const meanP = sumP[k]! / nk;
    const rateK = sumO[k]! / nk;
    reliability += (nk * (meanP - rateK) ** 2) / n;
    resolution += (nk * (rateK - baseRate) ** 2) / n;
  }

  // 残差の2項(帯平均まわりの偏差から独立に集計する。REL/RES/BS を再利用しない)。
  let varianceSum = 0;
  let covarianceSum = 0;
  for (const o of observations) {
    const k = binIndexFor(o.probability, binCount);
    const meanP = sumP[k]! / counts[k]!;
    const rateK = sumO[k]! / counts[k]!;
    varianceSum += (o.probability - meanP) ** 2;
    covarianceSum += (o.probability - meanP) * ((o.occurred ? 1 : 0) - rateK);
  }
  const withinBinVariance = varianceSum / n;
  const withinBinCovariance = covarianceSum / n;

  const bins: BrierBinSummary[] = [];
  for (let k = 0; k < binCount; k++) {
    const nk = counts[k]!;
    bins.push({
      ...calibrationBinBounds(k, binCount),
      count: nk,
      meanForecast: nk === 0 ? null : sumP[k]! / nk,
      observedRate: nk === 0 ? null : sumO[k]! / nk,
    });
  }

  return {
    decomposition: {
      n,
      brier: sumSquaredError / n,
      baseRate,
      reliability,
      resolution,
      uncertainty: baseRate * (1 - baseRate),
      withinBinVariance,
      withinBinCovariance,
      withinBinResidual: withinBinVariance - 2 * withinBinCovariance,
      bins,
    },
    reason: null,
  };
}

/** 1レース分の二乗誤差の合計(モデルと市場)。レース単位ブートストラップの再標本単位。 */
export interface RaceSquaredErrorPair {
  /** そのレースの観測頭数。 */
  readonly count: number;
  /** Σ (モデル確率 − 結果)²。 */
  readonly modelSse: number;
  /** Σ (市場確率 − 結果)²。 */
  readonly marketSse: number;
}

export interface BootstrapOptions {
  readonly iterations: number;
  readonly seed: number;
}

/** ブートストラップ結果。点推定・区間・条件(反復回数・シード・レース数)を必ず同梱する。 */
export type BrierDifferenceBootstrapResult =
  | {
      /** 観測値: (Σmodel_sse − Σmarket_sse) / Σcount。正ならモデルの方が悪い。 */
      readonly value: number;
      /** 95%区間(パーセンタイル法 2.5% / 97.5%)。 */
      readonly lower: number;
      readonly upper: number;
      readonly iterations: number;
      readonly seed: number;
      readonly raceCount: number;
      readonly reason: null;
    }
  | {
      readonly value: null;
      readonly lower: null;
      readonly upper: null;
      readonly iterations: number;
      readonly seed: number;
      readonly raceCount: number;
      readonly reason: string;
    };

/** 決定論的な擬似乱数 mulberry32。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * モデルと市場の Brier 差(model − market)の95%区間を、**レース単位**の再標本化(復元抽出)で求める。
 * 同一レースの馬は Σ=3 の制約で互いに独立でないため、馬ではなくレースを再標本単位にする。
 * シードと反復回数は呼び出し側が固定する(取得前の分析計画に固定する)。
 */
export function bootstrapBrierDifferenceByRace(
  pairs: readonly RaceSquaredErrorPair[],
  options: BootstrapOptions,
): BrierDifferenceBootstrapResult {
  const { iterations, seed } = options;
  const raceCount = pairs.length;
  const fail = (reason: string): BrierDifferenceBootstrapResult => ({
    value: null,
    lower: null,
    upper: null,
    iterations,
    seed,
    raceCount,
    reason,
  });
  if (!Number.isInteger(iterations) || iterations < 1) {
    return fail(`反復回数が正の整数でない(値=${String(iterations)})`);
  }
  if (!Number.isFinite(seed)) {
    return fail("シードが非有限");
  }
  if (raceCount < 2) {
    return fail("レースが2件未満(再標本化しても区間が定義できない)");
  }
  for (let i = 0; i < raceCount; i++) {
    const p = pairs[i]!;
    if (!Number.isInteger(p.count) || p.count < 1) {
      return fail(`${i + 1}番目のレースの頭数が1以上の整数でない`);
    }
    if (!Number.isFinite(p.modelSse) || !Number.isFinite(p.marketSse) || p.modelSse < 0 || p.marketSse < 0) {
      return fail(`${i + 1}番目のレースの二乗誤差が非有限または負`);
    }
  }

  const totalCount = pairs.reduce((s, p) => s + p.count, 0);
  const observed = pairs.reduce((s, p) => s + (p.modelSse - p.marketSse), 0) / totalCount;

  const rand = mulberry32(seed);
  const stats = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) {
    let diffSum = 0;
    let countSum = 0;
    for (let j = 0; j < raceCount; j++) {
      const p = pairs[Math.floor(rand() * raceCount)]!;
      diffSum += p.modelSse - p.marketSse;
      countSum += p.count;
    }
    stats[it] = diffSum / countSum;
  }
  stats.sort((a, b) => a - b);
  const lower = stats[Math.floor(iterations * 0.025)]!;
  const upper = stats[Math.ceil(iterations * 0.975) - 1]!;
  return { value: observed, lower, upper, iterations, seed, raceCount, reason: null };
}

/** resolution の参照値(レース内ラベル並べ替え)の結果。 */
export type PermutationResolutionResult =
  | {
      /** 並べ替え後の resolution の平均。 */
      readonly mean: number;
      /** 並べ替え後の resolution の95パーセンタイル。 */
      readonly p95: number;
      readonly iterations: number;
      readonly seed: number;
      readonly raceCount: number;
      readonly reason: null;
    }
  | {
      readonly mean: null;
      readonly p95: null;
      readonly iterations: number;
      readonly seed: number;
      readonly raceCount: number;
      readonly reason: string;
    };

/**
 * resolution の参照値(null 分布)を、**各レース内で結果(3着以内か)の割り当てを並べ替える**ことで求める。
 * 各レースの的中頭数は保たれる。小標本では識別力が無くても resolution は正に偏るため、
 * 「resolution が0に近いか」を、この参照値と並べて読む。頭数による3着以内の確率の違い
 * (`3/頭数`)は並べ替えが保つので参照値に含まれる。したがって参照値を超える部分が
 * レース内の識別力に当たる。シードと反復回数は呼び出し側が固定する。
 */
export function withinRacePermutationResolution(
  races: readonly (readonly BrierObservation[])[],
  options: BootstrapOptions,
  binCount: number = DEFAULT_QUALITY_BIN_COUNT,
): PermutationResolutionResult {
  const { iterations, seed } = options;
  const raceCount = races.length;
  const fail = (reason: string): PermutationResolutionResult => ({
    mean: null,
    p95: null,
    iterations,
    seed,
    raceCount,
    reason,
  });
  if (!Number.isInteger(iterations) || iterations < 1) {
    return fail(`反復回数が正の整数でない(値=${String(iterations)})`);
  }
  if (!Number.isFinite(seed)) {
    return fail("シードが非有限");
  }
  if (raceCount === 0) {
    return fail("レースが0件");
  }
  for (let i = 0; i < raceCount; i++) {
    const invalid = findInvalidBrierObservationReason(races[i]!);
    if (invalid !== null) {
      return fail(`${i + 1}番目のレース: ${invalid}`);
    }
  }
  const baseline = computeBrierDecomposition(races.flat(), binCount);
  if (baseline.decomposition === null) {
    return fail(baseline.reason);
  }

  const rand = mulberry32(seed);
  const values = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) {
    const shuffled: BrierObservation[] = [];
    for (const race of races) {
      // Fisher-Yates でレース内の結果を並べ替える(予測確率は動かさない)。
      const outcomes = race.map((o) => o.occurred);
      for (let i = outcomes.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = outcomes[i]!;
        outcomes[i] = outcomes[j]!;
        outcomes[j] = tmp;
      }
      race.forEach((o, i) => {
        shuffled.push({ probability: o.probability, occurred: outcomes[i]! });
      });
    }
    values[it] = computeBrierDecomposition(shuffled, binCount).decomposition!.resolution;
  }
  const mean = values.reduce((s, v) => s + v, 0) / iterations;
  values.sort((a, b) => a - b);
  const p95 = values[Math.ceil(iterations * 0.95) - 1]!;
  return { mean, p95, iterations, seed, raceCount, reason: null };
}
